// Seeded random checks against the ingest API: hostile input never throws or breaks a request, and random answers never lose or double-accept an event.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { answer, makeHarness, settle } from './harness.js'

// Rounds per property; each round is a fresh client, so failures name their seed.
const ROUND_COUNT = 40

// The ingest API request limit the client keeps every body under.
const MAX_REQUEST_BYTES = 256_000

// A UUID version 4, as every event_id must be.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Counts UTF-8 bytes, as ingest weighs a body.
const utf8Encoder = new TextEncoder()

// A small seeded generator (mulberry32), so a failing round can be replayed from its seed.
function seededRandom(seed) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

// One element of a list, picked by the generator.
function pick(random, items) {
  return items[Math.floor(random() * items.length)]
}

// A string of random characters: ASCII, accents, emoji, controls, quotes and lone surrogates.
function randomText(random, maxLength) {
  const pieces = ['a', 'Z', '0', ' ', '"', '\\', '\n', '\t', '\u0000', 'é', 'ß', '中', '😀', '👩‍👩‍👧', '\ud800', '\udfff', '</script>', '{', ']']
  const length = Math.floor(random() * maxLength)

  return Array.from({ length }, () => pick(random, pieces)).join('')
}

// A prop value of any JavaScript type, most of which the client must skip.
function randomPropValue(random) {
  const makers = [
    () => randomText(random, 40),
    () => Math.floor(random() * 1e12) - 5e11,
    () => random() * 1e6,
    () => random() < 0.5,
    () => NaN,
    () => Infinity,
    () => -Infinity,
    () => null,
    () => undefined,
    () => 10n,
    () => Symbol('prop'),
    () => () => 'function',
    () => new Date(0),
    () => ({ nested: randomText(random, 5) }),
    () => [1, 2, 3],
  ]

  return pick(random, makers)()
}

// Props of a random shape, or something that isn't an object at all.
function randomProps(random) {
  const shapeRoll = random()
  if (shapeRoll < 0.1) return pick(random, [null, undefined, 'text', 42, [1, 2], true])

  const props = {}
  const propCount = Math.floor(random() * 8)
  for (let propIndex = 0; propIndex < propCount; propIndex++) props[randomText(random, 12) || `p${propIndex}`] = randomPropValue(random)

  return props
}

// Calls track or log with random arguments, including non-strings and huge strings.
function callWithRandomInput(client, random) {
  const nameOrMessage = pick(random, [() => randomText(random, 30), () => '', () => '   ', () => 7, () => null, () => undefined, () => ({}), () => 'x'.repeat(300_000), () => new Error(randomText(random, 10))])()

  if (random() < 0.6) client.track(nameOrMessage, randomProps(random))
  else client.log(pick(random, ['info', 'ERROR', ' warning ', '', null, 3, randomText(random, 6)]), nameOrMessage, randomProps(random))
}

// Asserts a request body follows the ingest API: a JSON array within the limits, every event with an id, a time and scalar props.
function assertValidRequest(request) {
  assert.ok(utf8Encoder.encode(request.body).length <= MAX_REQUEST_BYTES)
  assert.ok(Array.isArray(request.events))
  assert.ok(request.events.length >= 1 && request.events.length <= 50)

  for (const sentEvent of request.events) {
    assert.match(sentEvent.event_id, UUID_PATTERN)
    assert.ok(!Number.isNaN(Date.parse(sentEvent.ts)))
    assert.ok(sentEvent.event !== undefined || sentEvent.message !== undefined)

    for (const propValue of Object.values(sentEvent.props ?? {})) {
      assert.ok(['string', 'boolean'].includes(typeof propValue) || Number.isFinite(propValue))
    }
  }
}

test('random input never throws, and every request it produces is a valid ingest API body', async () => {
  for (let round = 0; round < ROUND_COUNT; round++) {
    const random = seededRandom(1_000 + round)
    const harness = makeHarness()

    // Nothing the app passes may escape as an exception.
    for (let callIndex = 0; callIndex < 120; callIndex++) {
      assert.doesNotThrow(() => callWithRandomInput(harness.client, random), `seed ${1_000 + round}`)
    }

    await harness.client.flush()

    harness.requests.forEach(assertValidRequest)
    assert.equal(harness.client.pendingCount, 0, `seed ${1_000 + round}`)
  }
})

// An answer the server might give: every ingest API status, odd successes, network errors and Retry-After in any form.
function randomAnswer(random, nowMs) {
  const retryAfter = pick(random, [undefined, '0', '1', '30', '3600', '999999', 'soon', new Date(nowMs + 90_000).toUTCString(), new Date(nowMs - 5_000).toUTCString()])
  const headers = retryAfter === undefined ? {} : { 'Retry-After': retryAfter }
  const status = pick(random, [202, 202, 202, 200, 201, 400, 401, 403, 404, 408, 413, 415, 429, 500, 502, 503, 'network'])

  return { status, headers, retryAfter }
}

// The least time the client must wait after a refused answer, from the ingest API.
function minimumWaitMs(givenAnswer, nowMs, invalidKeyStreak) {
  if (givenAnswer.status === 401) return invalidKeyStreak === 1 ? 60_000 : 600_000

  // A network error carries no headers.
  const retryAfter = givenAnswer.status === 'network' ? undefined : givenAnswer.retryAfter
  if (retryAfter === undefined) return 250
  if (/^\d+$/.test(retryAfter)) return Math.max(250, Math.min(Number(retryAfter) * 1000, 3_600_000))

  const retryAtMs = Date.parse(retryAfter)
  return Number.isNaN(retryAtMs) ? 250 : Math.max(250, retryAtMs - nowMs)
}

test('random server answers lose nothing, accept nothing twice, and always wait as the ingest API asks', async () => {
  for (let round = 0; round < ROUND_COUNT; round++) {
    const seed = 2_000 + round
    const random = seededRandom(seed)
    const answersGiven = []

    // Each request gets a random answer, remembered with the time it was given.
    const harness = makeHarness({
      jitter: random(),
      respond: (request) => {
        const givenAnswer = randomAnswer(random, harness.nowMs)
        answersGiven.push({ ...givenAnswer, atMs: harness.nowMs, eventIds: request.events.map((sentEvent) => sentEvent.event_id) })

        if (givenAnswer.status === 'network') return Promise.reject(new TypeError('fetch failed'))
        return answer(givenAnswer.status, givenAnswer.headers)
      },
    })

    // Track events at random moments while the answers play out.
    const trackedCount = 30 + Math.floor(random() * 120)
    for (let eventIndex = 0; eventIndex < trackedCount; eventIndex++) {
      harness.client.track('tap', { index: eventIndex })
      await harness.advance(Math.floor(random() * 20_000))
    }

    // Then let every pause run out against a server that only accepts.
    const randomAnswers = answersGiven.length
    harness.setResponder((request) => {
      answersGiven.push({ status: 202, headers: {}, atMs: harness.nowMs, eventIds: request.events.map((sentEvent) => sentEvent.event_id) })
      return answer(202)
    })
    await harness.advance(3 * 3_600_000)

    // A drain of many one-event batches can outlast the fake clock's settling, so wait for it to end.
    await harness.client.flush()

    // Every event was accepted exactly once, except a lone event refused as too large and a batch refused as unsupported (415).
    const acceptedIds = answersGiven.filter((givenAnswer) => givenAnswer.status === 202).flatMap((givenAnswer) => givenAnswer.eventIds)
    const droppedIds = answersGiven
      .filter((givenAnswer) => (givenAnswer.status === 413 && givenAnswer.eventIds.length === 1) || givenAnswer.status === 415)
      .flatMap((givenAnswer) => givenAnswer.eventIds)
    const sentIds = new Set(answersGiven.flatMap((givenAnswer) => givenAnswer.eventIds))

    assert.equal(new Set(acceptedIds).size, acceptedIds.length, `seed ${seed}: an event was accepted twice`)
    assert.equal(acceptedIds.length + droppedIds.length, sentIds.size, `seed ${seed}: an event was lost`)
    assert.equal(sentIds.size, trackedCount, `seed ${seed}: an event was never sent`)
    assert.equal(harness.client.pendingCount, 0, `seed ${seed}`)

    // After every refused random answer, the next request waited at least what the ingest API asks.
    let invalidKeyStreak = 0
    for (let answerIndex = 0; answerIndex < randomAnswers; answerIndex++) {
      const givenAnswer = answersGiven[answerIndex]
      const nextAnswer = answersGiven[answerIndex + 1]
      invalidKeyStreak = givenAnswer.status === 401 ? invalidKeyStreak + 1 : 0

      const isRefused = givenAnswer.status !== 202 && givenAnswer.status !== 413 && givenAnswer.status !== 415
      if (!isRefused || nextAnswer === undefined) continue

      const waitedMs = nextAnswer.atMs - givenAnswer.atMs
      assert.ok(waitedMs >= minimumWaitMs(givenAnswer, givenAnswer.atMs, invalidKeyStreak), `seed ${seed}: retried ${waitedMs} ms after ${givenAnswer.status}`)
    }
  }
})

test('a 413 always halves the next request until a lone event is dropped', async () => {
  for (let round = 0; round < ROUND_COUNT; round++) {
    const random = seededRandom(3_000 + round)
    const refusedAbove = Math.floor(random() * 10)
    const harness = makeHarness({ respond: (request) => answer(request.events.length > refusedAbove ? 413 : 202) })

    const trackedCount = 1 + Math.floor(random() * 50)
    for (let eventIndex = 0; eventIndex < trackedCount; eventIndex++) harness.client.track('tap', { index: eventIndex })
    await harness.client.flush()

    // Each refused batch is followed by one at most half its size.
    harness.requests.forEach((request, requestIndex) => {
      const nextRequest = harness.requests[requestIndex + 1]
      if (request.events.length > refusedAbove && request.events.length > 1 && nextRequest) {
        assert.ok(nextRequest.events.length <= Math.floor(request.events.length / 2))
      }
    })

    // With every event refused alone, all are dropped; otherwise all arrive.
    assert.equal(harness.client.pendingCount, 0)
  }
})

test('events tracked while a request is in flight are kept and sent once in the next batch', async () => {
  let releaseFirstAnswer
  const harness = makeHarness({ respond: () => new Promise((resolve) => (releaseFirstAnswer = () => resolve(answer(202)))) })

  harness.client.track('first')
  const firstFlush = harness.client.flush()
  await settle()

  // A second flush joins the running one instead of sending a parallel request.
  assert.equal(harness.client.flush(), firstFlush)
  harness.client.track('second')
  harness.client.track('third')
  assert.equal(harness.requests.length, 1)

  harness.setResponder(() => answer(202))
  releaseFirstAnswer()
  await firstFlush

  // The flush keeps going until the outbox is empty; nothing is sent twice.
  await harness.client.flush()
  const sentNames = harness.requests.flatMap((request) => request.events.map((sentEvent) => sentEvent.event))
  assert.deepEqual(sentNames, ['first', 'second', 'third'])
  assert.equal(harness.client.pendingCount, 0)
})

test('shutdown during a failing send keeps unsent events counted and stops every timer', async () => {
  const harness = makeHarness({ respond: () => answer(503, { 'Retry-After': '5' }) })

  for (let eventIndex = 0; eventIndex < 5; eventIndex++) harness.client.track('tap')
  await harness.client.shutdown()

  // The failed batch stays pending, no timer is left, and later calls are ignored.
  assert.equal(harness.client.pendingCount, 5)
  assert.equal(harness.timers.size, 0)

  harness.client.track('late')
  await harness.advance(600_000)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.client.pendingCount, 5)
})

test('over quota waits the hour Retry-After asks before trying again', async () => {
  const harness = makeHarness({ respond: () => answer(429, { 'Retry-After': '3600' }, { error: 'over_quota' }) })

  harness.client.track('tap')
  await harness.client.flush()

  await harness.advance(3_599_000)
  assert.equal(harness.requests.length, 1)

  harness.setResponder(() => answer(202))
  await harness.advance(1_000)
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.client.pendingCount, 0)
})
