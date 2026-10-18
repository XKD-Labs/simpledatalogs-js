// The client against the ingest API: event shape, batching, answers, retries, the outbox and page hide.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SDK_VERSION, createClient, newEventId, parseRetryAfterMs, retryDelayMs } from '../src/index.js'
import { START_MS, answer, makeHarness, memoryStorage, settle } from './harness.js'

// A UUID of any version, as event_id must be.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('track sends an event with id, time, identity and scalar props after the 30 s interval', async () => {
  const harness = makeHarness({ clientOptions: { deviceId: ' device-1 ' } })
  harness.client.setUserId(42)

  harness.client.track('screenshot_taken', { format: 'png', size: 12, is_retina: true, nested: { a: 1 }, ratio: Infinity })
  await harness.advance(29_999)
  assert.equal(harness.requests.length, 0)

  await harness.advance(1)
  assert.equal(harness.requests.length, 1)

  const [request] = harness.requests
  assert.equal(request.url, 'http://ingest.test/v1/ingest')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer sdl_pub_test_key_0001')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.headers['User-Agent'], `simpledatalogs-js/${SDK_VERSION}`)
  assert.equal(request.keepalive, false)

  const [sentEvent] = request.events
  assert.match(sentEvent.event_id, UUID_PATTERN)
  assert.deepEqual({ ...sentEvent, event_id: 'x' }, {
    event: 'screenshot_taken',
    event_id: 'x',
    ts: new Date(START_MS).toISOString(),
    device_id: 'device-1',
    user_id: '42',
    props: { format: 'png', size: 12, is_retina: true },
  })
  assert.equal(harness.client.pendingCount, 0)
  assert.ok(harness.warnings.some((warning) => warning.includes('"nested"')))
})

test('log sends level, message and props without an event name', async () => {
  const harness = makeHarness()

  harness.client.log('ERROR', new TypeError('boom'), { order_id: 7 })
  harness.client.log(undefined, 'plain line')
  await harness.client.flush()

  const [errorLine, plainLine] = harness.requests[0].events
  assert.equal(errorLine.level, 'error')
  assert.equal(errorLine.message, 'TypeError: boom')
  assert.deepEqual(errorLine.props, { order_id: 7 })
  assert.equal(errorLine.event, undefined)
  assert.equal(plainLine.level, undefined)
  assert.equal(plainLine.message, 'plain line')
})

test('a full batch of 50 is sent at once, in batches of at most 50', async () => {
  const harness = makeHarness()

  for (let index = 0; index < 120; index++) harness.client.track('tick', { index })
  await harness.advance(0)

  assert.deepEqual(harness.requests.map((request) => request.events.length), [50, 50, 20])
  assert.equal(harness.client.pendingCount, 0)
})

test('requests stay under the byte limit', async () => {
  const harness = makeHarness({ clientOptions: { maxRequestBytes: 1_000 } })

  for (let index = 0; index < 10; index++) harness.client.track('big', { text: 'x'.repeat(200) })
  await harness.client.flush()

  assert.ok(harness.requests.length > 1)
  for (const request of harness.requests) assert.ok(Buffer.byteLength(request.body) <= 1_000)
  assert.equal(harness.requests.flatMap((request) => request.events).length, 10)
})

test('an event larger than any request is skipped with a warning', async () => {
  const harness = makeHarness({ clientOptions: { maxRequestBytes: 500 } })

  harness.client.track('huge', { text: 'x'.repeat(600) })

  assert.equal(harness.client.pendingCount, 0)
  assert.ok(harness.warnings.some((warning) => warning.includes('over the request limit')))
})

test('503 keeps the batch and waits at least Retry-After before the next try', async () => {
  const harness = makeHarness({ respond: () => answer(503, { 'Retry-After': '120' }, { error: 'busy' }) })

  harness.client.track('a')
  await harness.client.flush()
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.client.pendingCount, 1)

  await harness.advance(119_000)
  assert.equal(harness.requests.length, 1)

  harness.setResponder(() => answer(202))
  await harness.advance(1_000)
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.requests[1].events[0].event_id, harness.requests[0].events[0].event_id)
  assert.equal(harness.client.pendingCount, 0)
})

test('a network error keeps the batch and backs off with jitter', async () => {
  const harness = makeHarness({ jitter: 1, respond: () => Promise.reject(new TypeError('fetch failed')) })

  harness.client.track('a')
  await harness.client.flush()
  await harness.advance(999)
  assert.equal(harness.requests.length, 1)

  await harness.advance(1)
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.client.pendingCount, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('will retry')))
})

test('401 keeps the outbox and re-probes after a minute, then every ten minutes', async () => {
  const harness = makeHarness({ respond: () => answer(401, {}, { error: 'invalid_key' }) })

  harness.client.track('a')
  await harness.client.flush()
  await harness.advance(59_999)
  assert.equal(harness.requests.length, 1)

  await harness.advance(1)
  assert.equal(harness.requests.length, 2)

  await harness.advance(599_999)
  assert.equal(harness.requests.length, 2)

  await harness.advance(1)
  assert.equal(harness.requests.length, 3)
  assert.equal(harness.client.pendingCount, 1)
  assert.equal(harness.warnings.filter((warning) => warning.includes('401')).length, 1)
})

test('413 halves the batch, and a lone refused event is dropped', async () => {
  const harness = makeHarness({ respond: (request) => answer(request.events.length > 2 ? 413 : 202) })

  for (let index = 0; index < 5; index++) harness.client.track('a', { index })
  await harness.client.flush()

  // Each 202 doubles the batch back toward 50, so a refused 3 halves again before the rest go.
  assert.deepEqual(harness.requests.map((request) => request.events.length), [5, 2, 3, 1, 2])
  assert.equal(harness.client.pendingCount, 0)

  harness.setResponder(() => answer(413))
  harness.client.track('refused')
  await harness.client.flush()
  assert.equal(harness.client.pendingCount, 0)
  assert.ok(harness.warnings.some((warning) => warning.includes('dropped')))
})

test('other statuses are retried, never dropped', async () => {
  const harness = makeHarness({ respond: () => answer(400) })

  harness.client.track('a')
  await harness.client.flush()

  assert.equal(harness.client.pendingCount, 1)
})

test('the outbox drops its oldest events past the cap', async () => {
  const harness = makeHarness({ respond: () => answer(503), clientOptions: { maxOutboxEvents: 3, maxBatchEvents: 100 } })

  for (let index = 0; index < 5; index++) harness.client.track('a', { index })
  assert.equal(harness.client.pendingCount, 3)

  harness.setResponder(() => answer(202))
  await harness.client.flush()
  assert.deepEqual(harness.requests.at(-1).events.map((event) => event.props.index), [2, 3, 4])
  assert.ok(harness.warnings.some((warning) => warning.includes('dropped the oldest')))
})

test('unsent events are stored, and a new page load sends them once from every stored outbox', async () => {
  const storage = memoryStorage()
  const firstPage = makeHarness({ storage, respond: () => answer(503) })

  firstPage.client.track('kept')
  await firstPage.client.flush()
  const [storedKey] = [...storage.items.keys()]
  assert.match(storedKey, /^simpledatalogs:outbox:est_key_0001:/)

  // A second tab's stored outbox holds a copy of the same event plus one more.
  const storedLines = JSON.parse(storage.getItem(storedKey)).lines
  storage.setItem('simpledatalogs:outbox:est_key_0001:other-tab', JSON.stringify([...storedLines, JSON.stringify({ event: 'other', event_id: newEventId(), ts: '2026-10-15T11:00:00Z' })]))
  storage.setItem('simpledatalogs:outbox:another_key1:x', JSON.stringify(['{}']))

  const nextPage = makeHarness({ storage })
  await nextPage.advance(0)

  assert.deepEqual(nextPage.requests[0].events.map((event) => event.event), ['kept', 'other'])
  assert.deepEqual([...storage.items.keys()], ['simpledatalogs:outbox:another_key1:x'])
})

test('unreadable or failing storage never breaks tracking', async () => {
  const brokenStorage = {
    length: 1,
    key: () => 'simpledatalogs:outbox:est_key_0001:x',
    getItem: () => 'not json',
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {},
  }
  const harness = makeHarness({ storage: brokenStorage })

  harness.client.track('a')
  await harness.client.flush()

  assert.equal(harness.requests.length, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('could not')))
})

test('setEnabled(false) deletes unsent events and ignores later ones until re-enabled', async () => {
  const harness = makeHarness({ respond: () => answer(503) })

  harness.client.track('a')
  await harness.client.flush()
  harness.client.setEnabled(false)
  harness.client.track('b')

  assert.equal(harness.client.pendingCount, 0)
  assert.equal(harness.storage.items.size, 0)
  assert.equal(harness.timers.size, 0)

  harness.client.setEnabled(true)
  harness.client.track('c')
  assert.equal(harness.client.pendingCount, 1)
})

test('page hide sends one keepalive request of at most 60 KB', async () => {
  const listeners = { window: {}, document: {} }
  const fakeTarget = (name) => ({
    addEventListener: (type, listener) => (listeners[name][type] = listener),
    removeEventListener: (type) => delete listeners[name][type],
  })
  const documentTarget = { ...fakeTarget('document'), visibilityState: 'visible' }
  const harness = makeHarness({ pageTargets: { window: fakeTarget('window'), document: documentTarget }, clientOptions: { maxBatchEvents: 1_000, maxOutboxEvents: 1_000 } })

  for (let index = 0; index < 300; index++) harness.client.track('a', { text: 'x'.repeat(300) })

  listeners.document.visibilitychange()
  assert.equal(harness.requests.length, 0)

  documentTarget.visibilityState = 'hidden'
  listeners.document.visibilitychange()
  await settle()

  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].keepalive, true)
  assert.ok(Buffer.byteLength(harness.requests[0].body) <= 60_000)
  assert.equal(harness.client.pendingCount, 300 - harness.requests[0].events.length)

  listeners.window.pagehide()
  await settle()
  assert.equal(harness.requests.length, 2)

  await harness.client.shutdown()
  assert.deepEqual(listeners, { window: {}, document: {} })
})

test('shutdown flushes, then ignores later events', async () => {
  const harness = makeHarness()

  harness.client.track('a')
  await harness.client.shutdown()
  harness.client.track('b')

  assert.equal(harness.requests.length, 1)
  assert.equal(harness.client.pendingCount, 0)
  assert.equal(harness.timers.size, 0)
})

test('bad input, a missing key or no fetch never throw', async () => {
  const warnings = []
  const client = createClient({ fetch: undefined, storage: null, pageTargets: null, logger: { warn: (message) => warnings.push(message) } })

  assert.doesNotThrow(() => {
    client.track()
    client.track('  ')
    client.track('a', 'not props')
    client.log('info', undefined, [1])
  })
  await client.flush()
  await client.shutdown()

  assert.ok(warnings.some((warning) => warning.includes('no ingestKey')))
  assert.ok(warnings.some((warning) => warning.includes('non-empty event name')))
})

test('a browser runtime sends no User-Agent header', async () => {
  const harness = makeHarness({ clientOptions: { sendUserAgent: false } })

  harness.client.track('a')
  await harness.client.flush()

  assert.equal(harness.requests[0].headers['User-Agent'], undefined)
})

test('retryDelayMs doubles from 1 s to 5 min with full jitter and honors Retry-After', () => {
  assert.equal(retryDelayMs(1, null, 1), 1_000)
  assert.equal(retryDelayMs(3, null, 1), 4_000)
  assert.equal(retryDelayMs(40, null, 1), 300_000)
  assert.equal(retryDelayMs(3, null, 0), 250)
  assert.equal(retryDelayMs(1, 90_000, 0.5), 90_000)
  assert.equal(retryDelayMs(1, 99_000_000, 0.5), 3_600_000)
})

test('parseRetryAfterMs reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('120', START_MS), 120_000)
  assert.equal(parseRetryAfterMs(new Date(START_MS + 30_000).toUTCString(), START_MS), 30_000)
  assert.equal(parseRetryAfterMs(new Date(START_MS - 30_000).toUTCString(), START_MS), 0)
  assert.equal(parseRetryAfterMs('soon', START_MS), null)
  assert.equal(parseRetryAfterMs(null, START_MS), null)
})

test('newEventId makes distinct version 4 UUIDs', () => {
  const eventIds = new Set(Array.from({ length: 1_000 }, newEventId))

  assert.equal(eventIds.size, 1_000)
  for (const eventId of eventIds) assert.match(eventId, UUID_PATTERN)
})
