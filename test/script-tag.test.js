// The drop-in script tag build: one minified IIFE that reads data-key from its tag and starts autocapture.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import vm from 'node:vm'

import { SDK_VERSION } from '../src/index.js'
import { memoryStorage, settle } from './harness.js'

// The committed build, as jsDelivr and unpkg will serve it.
const bundlePath = new URL('../dist/simpledatalogs.min.js', import.meta.url)

// Runs the bundle in a fresh fake page whose <script> tag carries the given attributes; returns the page and its requests.
async function runBundleInPage(attributes) {
  const requests = []
  const listeners = new Map()
  const location = new URL('https://shop.test/landing?utm_source=ads')

  // Records each request with its parsed events and answers 202.
  const fetch = async (url, requestInit) => {
    requests.push({ url, ...requestInit, events: JSON.parse(requestInit.body) })
    return new Response(JSON.stringify({ accepted: 'id' }), { status: 202 })
  }

  const documentTarget = {
    title: 'Landing',
    referrer: '',
    visibilityState: 'visible',
    currentScript: { getAttribute: (attributeName) => attributes[attributeName] ?? null },
    addEventListener: (type, listener) => listeners.set(`document:${type}`, listener),
    removeEventListener: () => {},
  }
  const page = {
    document: documentTarget,
    location,
    navigator: {},
    history: { pushState: () => {}, replaceState: () => {} },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
    removeEventListener: () => {},
    fetch,
    console: { warn: () => {}, error: () => {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    URL,
    URLSearchParams,
    Response,
    crypto: globalThis.crypto,
    AbortSignal,
  }
  page.window = page

  vm.runInNewContext(await readFile(bundlePath, 'utf8'), page)
  return { page, requests, listeners }
}

test('the bundle is one small minified file', async () => {
  const bundle = await readFile(bundlePath)

  assert.ok(gzipSync(bundle).length < 9_000, `gzipped size ${gzipSync(bundle).length} bytes`)
  assert.doesNotMatch(bundle.toString(), /^\s*(import|export) /m)
  assert.match(bundle.toString(), new RegExp(SDK_VERSION.replaceAll('.', '\\.')))
})

test('the tag reads data-key and data-endpoint, starts autocapture, and exposes window.simpledatalogs', async () => {
  const { page, requests } = await runBundleInPage({ 'data-key': ' sdl_pub_tag_key ', 'data-endpoint': 'http://localhost:4001' })

  page.simpledatalogs.track('signup')
  await page.simpledatalogs.flush()
  await settle()

  const events = requests.flatMap((request) => request.events)
  assert.equal(requests[0].url, 'http://localhost:4001/v1/ingest')
  assert.equal(requests[0].headers.Authorization, 'Bearer sdl_pub_tag_key')
  assert.deepEqual(events.map((event) => event.event), ['page_view', 'signup'])
  assert.equal(events[0].props.utm_source, 'ads')
  assert.equal(page.simpledatalogs.version, SDK_VERSION)
})

test('web mode: the tag stores nothing and sends no session id; data-storage="true" brings both back', async () => {
  const webMode = await runBundleInPage({ 'data-key': 'sdl_pub_tag_key' })
  webMode.page.simpledatalogs.track('signup')
  await webMode.page.simpledatalogs.flush()
  await settle()

  const webEvents = webMode.requests.flatMap((request) => request.events)
  assert.equal(webMode.page.localStorage.length, 0)
  assert.equal(webMode.page.sessionStorage.length, 0)
  assert.ok(webEvents.every((event) => event.session_id === undefined))

  const stored = await runBundleInPage({ 'data-key': 'sdl_pub_tag_key', 'data-storage': 'true' })
  await stored.page.simpledatalogs.flush()
  await settle()

  const storedEvents = stored.requests.flatMap((request) => request.events)
  assert.equal(storedEvents[0].event, 'session_start')
  assert.ok(storedEvents.every((event) => typeof event.session_id === 'string'))
})

test('data-autocapture="false" keeps only the manual calls', async () => {
  const quiet = await runBundleInPage({ 'data-key': 'sdl_pub_tag_key', 'data-autocapture': 'false' })
  await quiet.page.simpledatalogs.flush()
  assert.equal(quiet.requests.length, 0)

  const withClicks = await runBundleInPage({ 'data-key': 'sdl_pub_tag_key' })
  assert.equal(typeof withClicks.listeners.get('document:click'), 'function')
})
