// Runtime detection and modes: browser, extension service worker, React Native app state and sessions, Node, and Do Not Track for every send.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SESSION_TIMEOUT_MS } from '../src/autocapture.js'
import { detectRuntime } from '../src/runtime.js'
import { answer, makeHarness } from './harness.js'

// A global scope as React Native has it: no document, navigator.product names the platform.
const REACT_NATIVE_SCOPE = { navigator: { product: 'ReactNative' } }

// A global scope as an extension's service worker has it: no document, a ServiceWorkerGlobalScope class.
const SERVICE_WORKER_SCOPE = { ServiceWorkerGlobalScope: function ServiceWorkerGlobalScope() {}, navigator: {} }

// A fake React Native AppState: a current state, one change listener, and a subscription that removes it.
function fakeAppState(currentState = 'active') {
  const appState = {
    currentState,
    listener: null,
    addEventListener(type, listener) {
      appState.listener = listener
      return { remove: () => (appState.listener = null) }
    },
    change(nextState) {
      appState.currentState = nextState
      appState.listener?.(nextState)
    },
  }

  return appState
}

// Every event sent so far, after a flush.
async function sentEvents(harness) {
  await harness.client.flush()
  return harness.requests.flatMap((request) => request.events)
}

test('detectRuntime tells React Native, a page, a worker and Node apart', () => {
  assert.equal(detectRuntime({ navigator: { product: 'ReactNative' }, document: {} }), 'react-native')
  assert.equal(detectRuntime({ document: {}, navigator: {} }), 'browser')
  assert.equal(detectRuntime(SERVICE_WORKER_SCOPE), 'worker')
  assert.equal(detectRuntime({ importScripts() {} }), 'worker')
  assert.equal(detectRuntime({ process: { on() {} } }), 'node')
})

test('an extension service worker is not Node: no User-Agent, a 10 s interval and the secret key warning', async () => {
  const harness = makeHarness({ clientOptions: { globalScope: SERVICE_WORKER_SCOPE, ingestKey: 'sdl_sec_worker_key_01' } })

  harness.client.track('first')
  await harness.advance(1_000)
  harness.client.track('second')
  await harness.advance(10_000)

  assert.equal(harness.client.runtime, 'worker')
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.requests[0].headers['User-Agent'], undefined)
  assert.ok(harness.warnings.some((warning) => warning.includes('secret key')))
})

test('React Native: no browser autocapture, no User-Agent, and a session from launch', async () => {
  const harness = makeHarness({ clientOptions: { globalScope: REACT_NATIVE_SCOPE, autocapture: true } })

  harness.client.track('screen_view', { screen: 'Home' })
  const events = await sentEvents(harness)

  assert.equal(harness.client.runtime, 'react-native')
  assert.deepEqual(events.map((event) => event.event), ['session_start', 'screen_view'])
  assert.equal(events[1].session_id, events[0].session_id)
  assert.equal(harness.requests[0].headers['User-Agent'], undefined)
})

test('React Native: background flushes, and returning after 30 minutes ends the session and starts a new one', async () => {
  const appState = fakeAppState()
  const harness = makeHarness({ clientOptions: { runtime: 'react-native', autocapture: true, appState } })

  harness.client.track('tap')
  appState.change('background')
  await harness.advance(0)
  assert.equal(harness.requests.length, 1)

  // A short trip to the background keeps the session.
  const backgroundedAtMs = harness.nowMs
  await harness.advance(5 * 60_000)
  appState.change('active')
  appState.change('background')
  await harness.advance(SESSION_TIMEOUT_MS)
  appState.change('active')
  harness.client.track('tap_again')

  const events = await sentEvents(harness)
  const [firstStart, , sessionEnd, secondStart, tapAgain] = events

  assert.deepEqual(events.map((event) => event.event), ['session_start', 'tap', 'session_end', 'session_start', 'tap_again'])
  assert.equal(sessionEnd.session_id, firstStart.session_id)
  assert.equal(sessionEnd.ts, new Date(backgroundedAtMs + 5 * 60_000).toISOString())
  assert.equal(sessionEnd.props.duration_s, 5 * 60)
  assert.notEqual(secondStart.session_id, firstStart.session_id)
  assert.equal(tapAgain.session_id, secondStart.session_id)

  // shutdown removes the AppState subscription.
  await harness.client.shutdown()
  assert.equal(appState.listener, null)
})

test('React Native: a headless launch in the background starts no session until the app is active', async () => {
  const appState = fakeAppState('background')
  const harness = makeHarness({ clientOptions: { runtime: 'react-native', autocapture: true, appState } })

  harness.client.track('background_fetch')
  appState.change('active')

  const events = await sentEvents(harness)
  assert.deepEqual(events.map((event) => event.event), ['background_fetch', 'session_start'])
  assert.equal(events[0].session_id, undefined)
})

test('handleAppStateChange works without the appState option and without autocapture', async () => {
  const harness = makeHarness({ clientOptions: { runtime: 'react-native' } })

  harness.client.track('tap')
  harness.client.handleAppStateChange('inactive')
  await harness.advance(0)
  assert.equal(harness.requests.length, 0)

  harness.client.handleAppStateChange('background')
  await harness.advance(0)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].events[0].session_id, undefined)
})

test('respectDoNotTrack applies to every send; without it, manual calls go as before', async () => {
  const privateScope = { navigator: { globalPrivacyControl: true }, document: {} }

  const respectingHarness = makeHarness({ clientOptions: { globalScope: privateScope, respectDoNotTrack: true } })
  respectingHarness.client.track('signup')
  respectingHarness.client.captureException(new Error('boom'))
  assert.equal(respectingHarness.client.pendingCount, 0)
  assert.deepEqual(await sentEvents(respectingHarness), [])

  // The app's own consent switch still wins.
  respectingHarness.client.setEnabled(true)
  respectingHarness.client.track('consented')
  assert.equal(respectingHarness.client.pendingCount, 1)

  const defaultHarness = makeHarness({ clientOptions: { globalScope: privateScope } })
  defaultHarness.client.track('signup')
  assert.equal((await sentEvents(defaultHarness)).length, 1)
})

test('Node keeps sending its User-Agent and no secret key warning', async () => {
  const harness = makeHarness({ respond: () => answer(202), clientOptions: { ingestKey: 'sdl_sec_server_key_01' } })

  harness.client.track('job_done')
  await harness.client.flush()

  assert.equal(harness.client.runtime, 'node')
  assert.match(harness.requests[0].headers['User-Agent'], /^simpledatalogs-js\//)
  assert.equal(harness.warnings.length, 0)
})
