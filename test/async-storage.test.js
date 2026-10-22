// Async storage for the outbox: AsyncStorage and chrome.storage adapters, loaded in the background, merged, debounced and kept with the retry pause.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chromeStorageAdapter, createClient, newEventId } from '../src/index.js'
import { START_MS, answer, asyncMemoryStorage, makeHarness, settle } from './harness.js'

// The one storage key an async storage holds for the harness's ingest key.
const OUTBOX_KEY = `simpledatalogs:outbox:${'sdl_pub_test_key_0001'.slice(-12)}`

// Timings that keep the interval flush out of the way, so only the storage is under test.
const SLOW_FLUSH = { firstFlushDelayMs: 600_000, flushIntervalMs: 600_000 }

// One stored event line, as an earlier launch wrote it.
function storedLine(eventName, eventId = newEventId()) {
  return JSON.stringify({ event: eventName, event_id: eventId, ts: new Date(START_MS - 60_000).toISOString() })
}

test('an async storage outbox is loaded in the background and merged ahead of events tracked meanwhile', async () => {
  const sharedEventId = newEventId()
  const storage = asyncMemoryStorage({ [OUTBOX_KEY]: JSON.stringify({ savedAt: START_MS, lines: [storedLine('stored_first'), storedLine('stored_twice', sharedEventId), storedLine('stored_twice', sharedEventId)] }) })
  const harness = makeHarness({ storage })

  // Tracked before the Promise from getItem resolved.
  harness.client.track('tracked_meanwhile')
  await harness.client.flush()

  const sentNames = harness.requests.flatMap((request) => request.events.map((event) => event.event))
  assert.deepEqual(sentNames, ['stored_first', 'stored_twice', 'tracked_meanwhile'])
  assert.equal(harness.client.pendingCount, 0)
})

test('a stored outbox is sent soon after launch without any new event', async () => {
  const storage = asyncMemoryStorage({ [OUTBOX_KEY]: JSON.stringify({ savedAt: START_MS, lines: [storedLine('left_behind')] }) })
  const harness = makeHarness({ storage })

  // The load finishes first, then the flush it schedules runs.
  await settle()
  await harness.advance(0)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].events[0].event, 'left_behind')

  // After the 202 the stored outbox is removed, once the debounce passes.
  await harness.advance(1_000)
  assert.equal(storage.items.has(OUTBOX_KEY), false)
})

test('enqueues are persisted debounced, once a second, and the 202 clears the stored outbox', async () => {
  const storage = asyncMemoryStorage()
  const harness = makeHarness({ storage, clientOptions: SLOW_FLUSH })
  await settle()

  harness.client.track('one')
  await harness.advance(300)
  harness.client.track('two')
  harness.client.track('three')
  await harness.advance(699)
  assert.deepEqual(storage.writes, [])

  await harness.advance(1)
  assert.deepEqual(storage.writes, [`set:${OUTBOX_KEY}`])
  assert.equal(JSON.parse(storage.items.get(OUTBOX_KEY)).lines.length, 3)

  await harness.client.flush()
  await harness.advance(1_000)
  assert.equal(storage.items.has(OUTBOX_KEY), false)
})

test('the retry pause is stored, so the next launch keeps backing off', async () => {
  const storage = asyncMemoryStorage()
  const firstLaunch = makeHarness({ storage, respond: () => answer(503, { 'Retry-After': '120' }), clientOptions: SLOW_FLUSH })

  firstLaunch.client.track('waits')
  await firstLaunch.client.flush()
  await firstLaunch.advance(1_000)

  const storedRecord = JSON.parse(storage.items.get(OUTBOX_KEY))
  assert.equal(storedRecord.failureCount, 1)
  assert.ok(storedRecord.pausedUntilMs >= START_MS + 120_000)

  // The next launch adopts the pause: no request until it ends.
  const secondLaunch = makeHarness({ storage, clientOptions: SLOW_FLUSH })
  await secondLaunch.client.flush()
  assert.equal(secondLaunch.requests.length, 0)

  await secondLaunch.advance(121_000)
  assert.equal(secondLaunch.requests.length, 1)
  assert.equal(secondLaunch.requests[0].events[0].event, 'waits')
})

test('an opt-out while the stored outbox loads deletes it instead of sending it', async () => {
  const storage = asyncMemoryStorage({ [OUTBOX_KEY]: JSON.stringify({ savedAt: START_MS, lines: [storedLine('consented_before')] }) })
  const harness = makeHarness({ storage })

  harness.client.setEnabled(false)
  harness.client.setEnabled(true)
  await harness.client.flush()

  assert.equal(harness.requests.length, 0)
  assert.equal(storage.items.has(OUTBOX_KEY), false)
})

test('backgrounding the app writes the outbox at once, skipping the debounce', async () => {
  const storage = asyncMemoryStorage()
  const harness = makeHarness({ storage, respond: () => answer(503), clientOptions: SLOW_FLUSH })
  await settle()

  harness.client.track('before_background')
  harness.client.handleAppStateChange('background')
  await settle()

  assert.equal(JSON.parse(storage.items.get(OUTBOX_KEY)).lines.length, 1)
})

test('a failing async storage keeps events in memory with one warning', async () => {
  const brokenStorage = {
    getItem: async () => {
      throw new Error('disk gone')
    },
    setItem: async () => {
      throw new Error('disk gone')
    },
    removeItem: async () => {},
  }
  const harness = makeHarness({ storage: brokenStorage, clientOptions: SLOW_FLUSH })

  harness.client.track('kept')
  await harness.advance(1_000)

  assert.equal(harness.client.pendingCount, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('could not read stored events')))
  assert.ok(harness.warnings.some((warning) => warning.includes('could not store unsent events')))
})

test('chromeStorageAdapter wraps an extension storage area, and a worker uses chrome.storage.local by default', async () => {
  const areaItems = {}
  const storageArea = {
    get: async (storageKey) => (storageKey in areaItems ? { [storageKey]: areaItems[storageKey] } : {}),
    set: async (entries) => Object.assign(areaItems, entries),
    remove: async (storageKey) => delete areaItems[storageKey],
  }

  const adapter = chromeStorageAdapter(storageArea)
  await adapter.setItem('a', '1')
  assert.equal(await adapter.getItem('a'), '1')
  assert.equal(await adapter.getItem('missing'), null)
  await adapter.removeItem('a')
  assert.deepEqual(areaItems, {})

  // A prefix keeps a popup's outbox apart from the worker's.
  await chromeStorageAdapter(storageArea, 'popup:').setItem('a', '2')
  assert.deepEqual(areaItems, { 'popup:a': '2' })
  await chromeStorageAdapter(storageArea, 'popup:').removeItem('a')

  // A service worker scope with chrome.storage.local gets it without any storage option.
  const client = createClient({
    ingestKey: 'sdl_pub_test_key_0001',
    globalScope: { ServiceWorkerGlobalScope: function ServiceWorkerGlobalScope() {}, navigator: {}, chrome: { storage: { local: storageArea } } },
    fetch: async () => answer(503),
    logger: null,
    ...SLOW_FLUSH,
  })

  client.track('from_the_worker')
  await client.shutdown()

  assert.equal(client.runtime, 'worker')
  assert.equal(JSON.parse(areaItems[OUTBOX_KEY]).lines.length, 1)
})

test('a storage without getItem, setItem and removeItem is ignored with a warning', () => {
  const harness = makeHarness({ storage: { getItem() {} } })

  harness.client.track('in_memory')
  assert.ok(harness.warnings.some((warning) => warning.includes('storage needs getItem')))
  assert.equal(harness.client.pendingCount, 1)
})
