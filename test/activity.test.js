// Activity stamps: app_state and engaged_ms on events tracked now, from page visibility or React Native's AppState.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createActivityTracker } from '../src/activity.js'
import { makeHarness } from './harness.js'

// A document whose visibility the test flips, with real listeners.
function fakeDocument(visibilityState = 'visible') {
  const listeners = new Map()

  return {
    visibilityState,
    addEventListener: (eventName, listener) => listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]),
    removeEventListener: (eventName, listener) => listeners.set(eventName, (listeners.get(eventName) ?? []).filter((kept) => kept !== listener)),
    setVisibility(nextState) {
      this.visibilityState = nextState
      for (const listener of listeners.get('visibilitychange') ?? []) listener()
    },
  }
}

// A window target that only takes listeners.
const fakeWindow = { addEventListener() {}, removeEventListener() {} }

// The props of every event sent so far, in order.
function sentProps(harness) {
  return harness.requests.flatMap((request) => request.events).map((event) => event.props ?? {})
}

test('the tracker counts foreground time between stamps and leaves background time out', () => {
  const tracker = createActivityTracker(true, 0)

  assert.deepEqual(tracker.stamp(30_000), { app_state: 'active', engaged_ms: 30_000 })

  tracker.setActive(false, 40_000)
  assert.deepEqual(tracker.stamp(600_000), { app_state: 'background' })

  tracker.setActive(true, 3_600_000)
  tracker.setActive(true, 3_610_000)
  assert.deepEqual(tracker.stamp(3_620_000), { app_state: 'active', engaged_ms: 20_000 })
})

test('a stretch that ended still counts once, and an engaged time never passes a day', () => {
  const tracker = createActivityTracker(false, 0)

  tracker.setActive(true, 100)
  tracker.setActive(false, 145)
  tracker.setActive(true, 200)
  assert.deepEqual(tracker.stamp(210), { app_state: 'active', engaged_ms: 55 })
  assert.deepEqual(tracker.stamp(2 * 86_400_000), { app_state: 'active', engaged_ms: 86_400_000 })
})

test('a page stamps events by its visibility; the caller and back-dated events win', async () => {
  const documentTarget = fakeDocument('visible')
  const harness = makeHarness({ pageTargets: { window: fakeWindow, document: documentTarget }, clientOptions: { runtime: 'browser' } })

  await harness.advance(5_000)
  harness.client.track('opened')

  documentTarget.setVisibility('hidden')
  await harness.advance(60_000)
  harness.client.track('synced')
  harness.client.track('marked', { app_state: 'active' })
  harness.client.track('earlier', {}, { ts: harness.nowMs - 1_000 })
  await harness.client.flush()

  assert.deepEqual(sentProps(harness), [{ app_state: 'active', engaged_ms: 5_000 }, { app_state: 'background' }, { app_state: 'active' }, {}])
})

test('React Native follows AppState: only active is in front', async () => {
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) }
  const harness = makeHarness({ clientOptions: { runtime: 'react-native', appState } })

  await harness.advance(2_000)
  harness.client.track('jam_started')

  harness.client.handleAppStateChange('inactive')
  await harness.advance(10_000)
  harness.client.track('band_playing')
  await harness.client.flush()

  assert.deepEqual(sentProps(harness), [{ app_state: 'active', engaged_ms: 2_000 }, { app_state: 'background' }])
})

test("activity: 'off', Node and log lines send no activity", async () => {
  const pageHarness = makeHarness({ pageTargets: { window: fakeWindow, document: fakeDocument() }, clientOptions: { runtime: 'browser', activity: 'off' } })
  const nodeHarness = makeHarness({ clientOptions: { runtime: 'node' } })

  pageHarness.client.track('opened')
  nodeHarness.client.track('job_done')
  nodeHarness.client.log('info', 'started')
  await pageHarness.client.flush()
  await nodeHarness.client.flush()

  assert.deepEqual(sentProps(pageHarness), [{}])
  assert.deepEqual(sentProps(nodeHarness), [{}, {}])
})
