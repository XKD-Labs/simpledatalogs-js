// Test doubles for the client: a manual clock and timers, a scripted fetch, and an in-memory Web Storage.

import { createClient } from '../src/index.js'

// The fixed start time of every test clock.
export const START_MS = Date.parse('2026-10-15T12:00:00Z')

// A client wired to fakes; responses come from `respond(request)`, 202 by default.
export function makeHarness(options = {}) {
  let nowMs = START_MS
  let nextTimerId = 1
  const pendingTimers = new Map()
  const requests = []
  const warnings = []
  let respond = options.respond ?? (() => answer(202))

  // Timers that fire only when the test advances the clock.
  const timers = {
    setTimeout(callback, delayMs) {
      const timerId = nextTimerId++
      pendingTimers.set(timerId, { dueAtMs: nowMs + delayMs, callback })
      return timerId
    },
    clearTimeout(timerId) {
      pendingTimers.delete(timerId)
    },
  }

  // Records each request with its parsed events, then answers it.
  const fetch = async (url, requestInit) => {
    const request = { url, ...requestInit, events: JSON.parse(requestInit.body) }
    requests.push(request)
    return respond(request)
  }

  const storage = options.storage === undefined ? memoryStorage() : options.storage

  const client = createClient({
    ingestKey: 'sdl_pub_test_key_0001',
    endpoint: 'http://ingest.test/',
    fetch,
    now: () => nowMs,
    random: () => options.jitter ?? 0.5,
    timers,
    storage,
    logger: { warn: (message) => warnings.push(message) },
    pageTargets: options.pageTargets ?? null,
    ...options.clientOptions,
  })

  return {
    client,
    requests,
    warnings,
    storage,
    timers: pendingTimers,
    get nowMs() {
      return nowMs
    },
    setResponder(nextRespond) {
      respond = nextRespond
    },
    // Moves the clock forward, firing due timers in order and letting their flushes settle.
    async advance(milliseconds) {
      const targetMs = nowMs + milliseconds

      for (;;) {
        const dueTimers = [...pendingTimers.entries()].filter(([, timer]) => timer.dueAtMs <= targetMs).sort((a, b) => a[1].dueAtMs - b[1].dueAtMs)
        if (dueTimers.length === 0) break

        const [timerId, timer] = dueTimers[0]
        pendingTimers.delete(timerId)
        nowMs = Math.max(nowMs, timer.dueAtMs)
        timer.callback()
        await settle()
      }

      nowMs = targetMs
      await settle()
    },
  }
}

// A fetch Response with a status, optional headers and a JSON body.
export function answer(status, headers = {}, body = {}) {
  return new Response(status === 202 ? JSON.stringify({ accepted: 'id' }) : JSON.stringify(body), { status, headers })
}

// Lets queued promise callbacks run.
export async function settle() {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve))
}

// An in-memory Web Storage with key(), length, getItem, setItem and removeItem.
export function memoryStorage(initialItems = {}) {
  const items = new Map(Object.entries(initialItems))

  return {
    get length() {
      return items.size
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (storageKey) => (items.has(storageKey) ? items.get(storageKey) : null),
    setItem: (storageKey, value) => items.set(storageKey, String(value)),
    removeItem: (storageKey) => items.delete(storageKey),
    items,
  }
}
