// Opt-in autocapture: off by default, page views (SPA too), sessions, referrer and UTM, errors, outbound clicks, Do Not Track and Node crashes.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SESSION_TIMEOUT_MS, isDoNotTrackOn, resolveAutocaptureFlags } from '../src/autocapture.js'
import { init } from '../src/index.js'
import { makeHarness, memoryStorage, settle } from './harness.js'

// A fake browser page: a location, history methods that move it, sessionStorage, a navigator, and listener maps.
function fakePage({ href = 'https://shop.test/pricing?utm_source=news&utm_campaign=launch&secret=1', referrer = 'https://search.test/results?q=x', title = 'Pricing', navigator = {} } = {}) {
  const listeners = { window: new Map(), document: new Map() }

  // Adds and removes listeners by type, keeping one per type is enough for these tests.
  const listenerTarget = (name) => ({
    addEventListener: (type, listener) => listeners[name].set(type, listener),
    removeEventListener: (type) => listeners[name].delete(type),
  })

  const location = new URL(href)
  const windowTarget = {
    ...listenerTarget('window'),
    navigator,
    get location() {
      return location
    },
    history: {
      pushState(state, unused, url) {
        location.href = new URL(url, location.href).href
      },
      replaceState(state, unused, url) {
        location.href = new URL(url, location.href).href
      },
    },
  }
  const documentTarget = { ...listenerTarget('document'), referrer, title, visibilityState: 'visible' }

  return { windowTarget, documentTarget, listeners, location, fire: (name, type, payload) => listeners[name].get(type)?.(payload) }
}

// A harness whose client runs autocapture on a fake page.
function pageHarness({ autocapture = true, page = fakePage(), sessionStorage = memoryStorage() } = {}) {
  const harness = makeHarness({
    pageTargets: { window: page.windowTarget, document: page.documentTarget },
    clientOptions: { autocapture, sessionStorage },
  })

  return { ...harness, page, sessionStorage }
}

// Every event the client sent so far, after a flush.
async function sentEvents(harness) {
  await harness.client.flush()
  return harness.requests.flatMap((request) => request.events)
}

test('autocapture is off unless asked for', async () => {
  const page = fakePage()
  const harness = makeHarness({ pageTargets: { window: page.windowTarget, document: page.documentTarget }, clientOptions: { sessionStorage: memoryStorage() } })

  assert.equal(harness.client.pendingCount, 0)
  assert.equal(page.windowTarget.history.pushState.name, 'pushState')
  assert.equal(resolveAutocaptureFlags(undefined), null)
  assert.equal(resolveAutocaptureFlags(false), null)
  assert.equal(resolveAutocaptureFlags(true).outboundLinks, false)
})

test('autocapture: true sends session_start, then a page view with referrer and UTM, and a session id on every event', async () => {
  const harness = pageHarness()
  harness.client.track('signup')

  const [sessionStart, pageView, signup] = await sentEvents(harness)
  assert.equal(sessionStart.event, 'session_start')
  assert.equal(pageView.event, 'page_view')
  assert.deepEqual(pageView.props, {
    path: '/pricing',
    title: 'Pricing',
    referrer: 'https://search.test/results',
    referrer_host: 'search.test',
    utm_source: 'news',
    utm_campaign: 'launch',
  })
  assert.ok(sessionStart.session_id)
  assert.equal(pageView.session_id, sessionStart.session_id)
  assert.equal(signup.session_id, sessionStart.session_id)
})

test('SPA navigation sends a page view per new path, without referrer or query, and skips same-path replaceState', async () => {
  const harness = pageHarness()
  const { history } = harness.page.windowTarget

  history.pushState({}, '', '/docs?tab=2')
  await settle()
  history.replaceState({}, '', '/docs?tab=3')
  await settle()
  history.pushState({}, '', '/app#/settings')
  await settle()

  // Back button: the location moves first, then popstate fires.
  harness.page.location.href = 'https://shop.test/docs'
  harness.page.fire('window', 'popstate')
  await settle()

  const pageViews = (await sentEvents(harness)).filter((event) => event.event === 'page_view')
  assert.deepEqual(pageViews.map((event) => event.props.path), ['/pricing', '/docs', '/app#/settings', '/docs'])
  assert.equal(pageViews[1].props.referrer, undefined)
  assert.equal(pageViews[1].props.utm_source, undefined)
})

test('a reload in the same tab resumes the session; 30 idle minutes end it and the next activity starts another', async () => {
  const sessionStorage = memoryStorage()
  const firstLoad = pageHarness({ sessionStorage })
  const [firstStart] = await sentEvents(firstLoad)

  // A second page load in the same tab reuses the stored session: no session_start, no landing props.
  const secondLoad = pageHarness({ sessionStorage, page: fakePage({ href: 'https://shop.test/cart' }) })
  const secondEvents = await sentEvents(secondLoad)
  assert.deepEqual(secondEvents.map((event) => event.event), ['page_view'])
  assert.equal(secondEvents[0].session_id, firstStart.session_id)
  assert.equal(secondEvents[0].props.referrer, undefined)

  // Idle for the whole timeout: the timer sends session_end stamped at the last activity.
  await secondLoad.advance(SESSION_TIMEOUT_MS + 1_000)
  const sessionEnd = (await sentEvents(secondLoad)).find((event) => event.event === 'session_end')
  assert.equal(sessionEnd.session_id, firstStart.session_id)
  assert.equal(sessionEnd.props.page_views, 2)
  assert.equal(Date.parse(sessionEnd.ts), Date.parse(secondEvents[0].ts))
  assert.equal(sessionStorage.items.size, 0)

  // The visitor comes back: a new session with a new id.
  secondLoad.page.fire('document', 'pointerdown')
  const restartEvents = await sentEvents(secondLoad)
  const newStart = restartEvents.at(-1)
  assert.equal(newStart.event, 'session_start')
  assert.notEqual(newStart.session_id, firstStart.session_id)
})

test('uncaught errors and unhandled rejections become error-level logs, bounded per message', async () => {
  const harness = pageHarness({ autocapture: { pageViews: false, sessions: false } })
  const thrownError = new TypeError('x is undefined')

  for (let repeat = 0; repeat < 8; repeat++) {
    harness.page.fire('window', 'error', { error: thrownError, message: 'x is undefined', filename: 'https://shop.test/app.js?token=abc', lineno: 4, colno: 2 })
  }
  harness.page.fire('window', 'unhandledrejection', { reason: 'timeout' })

  const logs = await sentEvents(harness)
  assert.equal(logs.length, 6)
  assert.equal(logs[0].level, 'error')
  assert.equal(logs[0].message, 'TypeError: x is undefined')
  assert.equal(logs[0].props.file, 'https://shop.test/app.js')
  assert.equal(logs[0].props.line, 4)
  assert.equal(logs[0].props.path, '/pricing')
  assert.match(logs[0].props.stack, /TypeError/)
  assert.equal(logs[5].message, 'Unhandled rejection: timeout')
  assert.equal(logs[5].props.source, 'unhandledrejection')
})

test('outbound link clicks are tracked only when turned on, and only for other hosts', async () => {
  const harness = pageHarness({ autocapture: { pageViews: false, sessions: false, outboundLinks: true } })
  const linkTo = (href) => ({ target: { closest: () => ({ getAttribute: () => href }) } })

  harness.page.fire('document', 'click', linkTo('https://partner.test/offer?ref=me'))
  harness.page.fire('document', 'click', linkTo('/same-site'))
  harness.page.fire('document', 'click', linkTo('mailto:hi@shop.test'))

  const clicks = await sentEvents(harness)
  assert.equal(clicks.length, 1)
  assert.deepEqual(clicks[0].props, { url: 'https://partner.test/offer', host: 'partner.test', path: '/pricing' })
})

test('Do Not Track and Global Privacy Control turn autocapture off; manual calls still go', async () => {
  const harness = pageHarness({ page: fakePage({ navigator: { doNotTrack: '1' } }) })
  harness.client.track('signup')

  const events = await sentEvents(harness)
  assert.deepEqual(events.map((event) => event.event), ['signup'])
  assert.equal(isDoNotTrackOn({ navigator: { globalPrivacyControl: true } }), true)
  assert.equal(isDoNotTrackOn({ navigator: {} }), false)
})

test('shutdown restores the history methods and removes the listeners', async () => {
  const harness = pageHarness({ autocapture: { pageViews: true, sessions: false, errors: true } })
  const { history } = harness.page.windowTarget

  assert.notEqual(history.pushState.name, 'pushState')
  await harness.client.shutdown()

  assert.equal(history.pushState.name, 'pushState')
  assert.equal(harness.page.listeners.window.size, 0)
})

test('Node: an opted-in uncaught exception is logged as critical, flushed, then the process exits with 1', async () => {
  const processListeners = new Map()
  const exitCodes = []
  const processTarget = {
    on: (type, listener) => processListeners.set(type, listener),
    removeListener: (type) => processListeners.delete(type),
    listenerCount: (type) => (processListeners.has(type) ? 1 : 0),
    exit: (code) => exitCodes.push(code),
  }
  const harness = makeHarness({ clientOptions: { autocapture: true, processTarget, logger: { warn() {}, error() {} } } })

  processListeners.get('uncaughtException')(new RangeError('bad index'))
  await settle()

  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].events[0].level, 'critical')
  assert.equal(harness.requests[0].events[0].message, 'RangeError: bad index')
  assert.deepEqual(exitCodes, [1])
})

test('Node: no crash listener without the opt-in, and init() takes the short key option', () => {
  const processListeners = new Map()
  const processTarget = { on: (type, listener) => processListeners.set(type, listener) }

  const client = init({ key: ' sdl_sec_short_form ', processTarget, pageTargets: null, storage: null, logger: null })
  assert.equal(processListeners.size, 0)
  assert.equal(client.pendingCount, 0)
})

test('track() takes an explicit timestamp for when the event happened', async () => {
  const harness = makeHarness()

  harness.client.track('imported', {}, { timestamp: Date.parse('2026-10-01T08:00:00Z') })
  const [imported] = await sentEvents(harness)

  assert.equal(imported.ts, '2026-10-01T08:00:00.000Z')
})
