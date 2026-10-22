// Event options: default properties on every event, a caller's event_id for idempotent re-sends, and past timestamps within the ingest API's range.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { START_MS, makeHarness } from './harness.js'

// Every event sent so far, after a flush.
async function sentEvents(harness) {
  await harness.client.flush()
  return harness.requests.flatMap((request) => request.events)
}

test('defaultProperties are merged into every event, log line and exception; the event props win', async () => {
  const harness = makeHarness({ clientOptions: { defaultProperties: { app_version: '1.1.0', channel: 'web', bad: { nested: true } } } })

  harness.client.track('signup', { channel: 'ios', plan: 'pro' })
  harness.client.log('info', 'opened')
  harness.client.captureException(new Error('boom'))

  const [signup, opened, exception] = await sentEvents(harness)
  assert.deepEqual(signup.props, { app_version: '1.1.0', channel: 'ios', plan: 'pro' })
  assert.deepEqual(opened.props, { app_version: '1.1.0', channel: 'web' })
  assert.deepEqual(exception.props, { app_version: '1.1.0', channel: 'web' })
  assert.ok(harness.warnings.some((warning) => warning.includes('"bad"')))
})

test('setDefaultProperties replaces the defaults for later events, and an empty object clears them', async () => {
  const harness = makeHarness({ clientOptions: { defaultProperties: { app_version: '1.0.0' } } })

  harness.client.setDefaultProperties({ distribution: 'store' })
  harness.client.track('first')
  harness.client.setDefaultProperties({})
  harness.client.track('second')

  const [first, second] = await sentEvents(harness)
  assert.deepEqual(first.props, { distribution: 'store' })
  assert.equal(second.props, undefined)
})

test('track takes a caller event_id (a UUID, lowercased) for idempotent re-sends', async () => {
  const harness = makeHarness()
  const callerEventId = '0192F0A1-7B3C-7D4E-8F90-A1B2C3D4E5F6'

  harness.client.track('purchase', { order_id: 7 }, { eventId: callerEventId })
  harness.client.log('info', 'purchase stored', {}, { eventId: '0192f0a1-7b3c-7d4e-8f90-000000000001' })
  harness.client.track('purchase', {}, { eventId: 'order-7' })

  const [purchase, logLine, badId] = await sentEvents(harness)
  assert.equal(purchase.event_id, callerEventId.toLowerCase())
  assert.equal(logLine.event_id, '0192f0a1-7b3c-7d4e-8f90-000000000001')
  assert.notEqual(badId.event_id, 'order-7')
  assert.match(badId.event_id, /^[0-9a-f-]{36}$/)
  assert.ok(harness.warnings.some((warning) => warning.includes('eventId must be a UUID')))
})

test('track takes a past ts as a Date, epoch ms or ISO text; the old timestamp option still works', async () => {
  const harness = makeHarness()

  harness.client.track('as_date', {}, { ts: new Date('2026-10-01T08:00:00Z') })
  harness.client.track('as_epoch_ms', {}, { ts: Date.parse('2026-10-02T08:00:00Z') })
  harness.client.track('as_iso_text', {}, { ts: '2026-10-03T08:00:00+02:00' })
  harness.client.track('as_timestamp', {}, { timestamp: Date.parse('2026-10-04T08:00:00Z') })

  const events = await sentEvents(harness)
  assert.deepEqual(events.map((event) => event.ts), ['2026-10-01T08:00:00.000Z', '2026-10-02T08:00:00.000Z', '2026-10-03T06:00:00.000Z', '2026-10-04T08:00:00.000Z'])
})

test('a ts outside the ingest API range (over 10 years old, after 2095, unreadable) becomes now, with one warning', async () => {
  const harness = makeHarness()
  const nowText = new Date(START_MS).toISOString()

  harness.client.track('too_old', {}, { ts: START_MS - 11 * 365 * 24 * 3_600_000 })
  harness.client.track('too_late', {}, { ts: '2096-01-01T00:00:00Z' })
  harness.client.track('unreadable', {}, { ts: 'yesterday' })

  const events = await sentEvents(harness)
  assert.deepEqual(events.map((event) => event.ts), [nowText, nowText, nowText])
  assert.equal(harness.warnings.filter((warning) => warning.includes('ts must be')).length, 1)
})
