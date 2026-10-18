// The client's bounds: coalesced storage writes, stale outboxes, batch regrowth, one keepalive at a time, quiet pauses and 415.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { START_MS, answer, makeHarness, memoryStorage, settle } from './harness.js'

// A memory storage that counts its writes and can refuse them like a full quota.
function countingStorage({ shouldRefuse = false } = {}) {
  const storage = memoryStorage()
  const counts = { setItem: 0 }
  const plainSetItem = storage.setItem

  storage.setItem = (storageKey, value) => {
    counts.setItem += 1
    if (shouldRefuse) throw new Error('QuotaExceededError')
    plainSetItem(storageKey, value)
  }

  return { storage, counts }
}

test('10,000 offline track() calls write storage a few times, not 10,000, and keep the newest 1,000', async () => {
  const { storage, counts } = countingStorage()
  const harness = makeHarness({ storage, respond: () => answer(503), clientOptions: { flushIntervalMs: 3_600_000, maxBatchEvents: 1_000_000 } })

  const startedAt = performance.now()
  for (let index = 0; index < 10_000; index++) harness.client.track('tap', { index })
  const elapsedMs = performance.now() - startedAt
  await settle()

  assert.ok(elapsedMs < 1_000, `10,000 track() calls took ${elapsedMs.toFixed(1)} ms`)
  assert.ok(counts.setItem <= 3, `${counts.setItem} storage writes`)

  const [storedText] = [...storage.items.values()]
  const storedIndexes = JSON.parse(storedText).lines.map((line) => JSON.parse(line).props.index)
  assert.equal(storedIndexes.length, 1_000)
  assert.equal(storedIndexes.at(-1), 9_999)
})

test('an outbox stored by any key more than 30 days ago is deleted; a younger one of another key stays', async () => {
  const storage = memoryStorage()
  const oldSavedAt = START_MS - 31 * 24 * 3_600_000

  storage.setItem('simpledatalogs:outbox:rotated_key1:old', JSON.stringify({ savedAt: oldSavedAt, lines: ['{}'] }))
  storage.setItem('simpledatalogs:outbox:other_key_01:young', JSON.stringify({ savedAt: START_MS, lines: ['{}'] }))

  makeHarness({ storage })

  assert.deepEqual([...storage.items.keys()], ['simpledatalogs:outbox:other_key_01:young'])
})

test('after a 413 the batch size grows back to 50 on later 202s while events keep coming', async () => {
  let answerCount = 0
  const harness = makeHarness({ respond: () => answer(answerCount++ === 0 ? 413 : 202), clientOptions: { flushIntervalMs: 1_000 } })

  for (let round = 0; round < 8; round++) {
    for (let index = 0; index < 60; index++) harness.client.track('tap', { round, index })
    await harness.advance(1_000)
  }

  assert.equal(harness.requests[0].events.length, 50)
  assert.equal(harness.requests[1].events.length, 25)
  assert.equal(Math.max(...harness.requests.slice(-3).map((request) => request.events.length)), 50)
})

test('rapid page hides send one keepalive request at a time, and a refused keepalive never pauses sending', async () => {
  const listeners = { window: {}, document: {} }
  const fakeTarget = (name) => ({
    addEventListener: (type, listener) => (listeners[name][type] = listener),
    removeEventListener: (type) => delete listeners[name][type],
  })
  const documentTarget = { ...fakeTarget('document'), visibilityState: 'hidden' }
  let isKeepaliveRefused = true
  let releaseKeepalive = () => {}

  const harness = makeHarness({
    pageTargets: { window: fakeTarget('window'), document: documentTarget },
    clientOptions: { maxBatchEvents: 1_000 },
    respond: (request) => {
      if (!request.keepalive) return answer(202)

      // The keepalive hangs until the test lets it fail, as a browser over its keepalive quota would.
      return new Promise((resolve, reject) => (releaseKeepalive = () => (isKeepaliveRefused ? reject(new TypeError('keepalive quota')) : resolve(answer(202)))))
    },
  })

  for (let index = 0; index < 300; index++) harness.client.track('tap', { text: 'x'.repeat(100) })

  listeners.document.visibilitychange()
  listeners.document.visibilitychange()
  listeners.window.pagehide()
  await settle()
  assert.equal(harness.requests.filter((request) => request.keepalive).length, 1)

  releaseKeepalive()
  await settle()

  // The page came back: the next flush goes at once, with no backoff from the refused keepalive.
  await harness.client.flush()
  assert.ok(harness.requests.some((request) => !request.keepalive))
  assert.equal(harness.client.pendingCount, 0)
})

test('while paused, more track() calls arm no earlier flush: one request, then one timer at the probe time', async () => {
  const harness = makeHarness({ respond: () => answer(401) })

  for (let index = 0; index < 60; index++) harness.client.track('tap', { index })
  await harness.advance(0)
  assert.equal(harness.requests.length, 1)

  for (let index = 0; index < 100; index++) harness.client.track('tap', { index })
  await harness.advance(30_000)

  assert.equal(harness.requests.length, 1)
  assert.equal(harness.timers.size, 1)
  assert.ok([...harness.timers.values()][0].dueAtMs >= START_MS + 60_000)
})

test('a storage over its quota is tried once, then skipped until the outbox shrinks', async () => {
  const { storage, counts } = countingStorage({ shouldRefuse: true })
  const harness = makeHarness({ storage, respond: () => answer(503), clientOptions: { flushIntervalMs: 3_600_000 } })

  for (let round = 0; round < 5; round++) {
    harness.client.track('tap', { round })
    await settle()
  }

  assert.equal(counts.setItem, 1)
  assert.equal(harness.warnings.filter((warning) => warning.includes('could not store')).length, 1)
})

test('a 415 drops its batch with one warning and the next batch goes', async () => {
  let answerCount = 0
  const harness = makeHarness({ respond: () => answer(answerCount++ === 0 ? 415 : 202), clientOptions: { maxBatchEvents: 5 } })

  for (let index = 0; index < 10; index++) harness.client.track('tap', { index })
  await harness.client.flush()

  assert.deepEqual(harness.requests.map((request) => request.events.length), [5, 5])
  assert.equal(harness.client.pendingCount, 0)
  assert.equal(harness.warnings.filter((warning) => warning.includes('415')).length, 1)
})
