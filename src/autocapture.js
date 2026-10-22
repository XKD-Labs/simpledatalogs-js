/** Opt-in automatic capture: page views (SPA too), sessions, referrer and UTM, unhandled errors, outbound and data-track clicks, React Native app sessions and Node crashes. */

import { watchProcessCrashes } from './exceptions.js'
import { describeValue, stripQuery, truncate } from './text.js'

/** The features `autocapture: true` turns on; outbound clicks and Do Not Track handling are set apart. */
export const AUTOCAPTURE_DEFAULTS = {
  pageViews: true,
  sessions: true,
  errors: true,
  outboundLinks: false,
  trackedClicks: true,
  uncaughtExceptions: true,
  respectDoNotTrack: true,
}

// A session ends after 30 minutes without activity, as in most web analytics.
export const SESSION_TIMEOUT_MS = 30 * 60_000

// The tab's session lives in sessionStorage under this key; no cookies, nothing shared across tabs.
const SESSION_STORAGE_KEY = 'simpledatalogs:session'

// Activity is recorded at most this often, so scrolling and typing never write storage on every event.
const ACTIVITY_THROTTLE_MS = 5_000

// The UTM parameters copied from the landing URL onto the session's first page view.
const UTM_PARAMETERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

// Bounds on error capture, so an error thrown in a loop can't flood the outbox.
const ERROR_LIMITS = { perPage: 50, perMessage: 5, stackChars: 4_000, textChars: 1_000 }

// Bounds on a data-track click's props, so markup can't grow an event without limit.
const TRACKED_CLICK_LIMITS = { props: 10, textChars: 200 }

/** Turns the `autocapture` option (false, true or an object of flags) into a full set of flags, or null when off. */
export function resolveAutocaptureFlags(option) {
  if (option === true) return { ...AUTOCAPTURE_DEFAULTS }
  if (option === null || typeof option !== 'object') return null

  return { ...AUTOCAPTURE_DEFAULTS, ...option }
}

/** True when the browser asks not to be tracked (Do Not Track or Global Privacy Control). */
export function isDoNotTrackOn(windowTarget) {
  const navigatorTarget = windowTarget?.navigator ?? {}

  return navigatorTarget.doNotTrack === '1' || navigatorTarget.doNotTrack === 'yes' || windowTarget?.doNotTrack === '1' || navigatorTarget.globalPrivacyControl === true
}

/** Starts the enabled features for one client and returns a function that stops them all. */
export function startAutocapture(client, flags, context) {
  const stopFunctions = []
  const windowTarget = context.pageTargets?.window
  const documentTarget = context.pageTargets?.document

  // A real page has a location; React Native gets app sessions; anything else (Node, a test double) gets the Node features only.
  const isBrowserPage = typeof windowTarget?.location?.href === 'string'

  if (context.runtime === 'react-native') {
    if (flags.sessions) stopFunctions.push(new AppSession(client, context).start(context.initialAppState, context.addAppStateListener))
  } else if (isBrowserPage) {
    // Do Not Track and Global Privacy Control turn every automatic event off; the app's own calls still go.
    if (flags.respectDoNotTrack && isDoNotTrackOn(windowTarget)) return () => {}

    const session = flags.sessions ? new TabSession(client, context, windowTarget) : null
    if (session) stopFunctions.push(session.start(documentTarget))

    if (flags.pageViews) stopFunctions.push(capturePageViews(client, windowTarget, documentTarget, session))
    if (flags.errors) stopFunctions.push(captureBrowserErrors(client, windowTarget))
    if (flags.outboundLinks) stopFunctions.push(captureOutboundClicks(client, windowTarget, documentTarget))
    if (flags.trackedClicks) stopFunctions.push(captureTrackedClicks(client, windowTarget, documentTarget))
  } else if (flags.uncaughtExceptions && context.processTarget) {
    stopFunctions.push(captureUncaughtExceptions(client, context))
  }

  return () => stopFunctions.forEach((stop) => stop())
}

/** One tab's session: an id in sessionStorage, session_start on the first activity, session_end after 30 idle minutes. */
export class TabSession {
  #client
  #now
  #timers
  #storage
  #state = null
  #endTimer = null
  #lastMarkMs = -Infinity

  /** Keeps the client, the clock and the tab's sessionStorage (memory when it is unusable). */
  constructor(client, context, windowTarget) {
    this.#client = client
    this.#now = context.now
    this.#timers = context.timers
    this.#storage = context.sessionStorage === undefined ? readSessionStorage(windowTarget) : context.sessionStorage
  }

  /** Resumes a live session or starts a new one, and marks activity on taps, keys and the tab coming back. */
  start(documentTarget) {
    this.#state = this.#readState()
    this.markActivity()

    // User input and a visible tab count as activity.
    const onActivity = () => this.markActivity()
    const onVisibilityChange = () => {
      if (documentTarget?.visibilityState === 'visible') this.markActivity()
    }

    documentTarget?.addEventListener?.('pointerdown', onActivity, { passive: true, capture: true })
    documentTarget?.addEventListener?.('keydown', onActivity, { passive: true, capture: true })
    documentTarget?.addEventListener?.('visibilitychange', onVisibilityChange)

    return () => {
      documentTarget?.removeEventListener?.('pointerdown', onActivity, { capture: true })
      documentTarget?.removeEventListener?.('keydown', onActivity, { capture: true })
      documentTarget?.removeEventListener?.('visibilitychange', onVisibilityChange)
      this.#cancelEndTimer()
    }
  }

  /** True when this activity began a new session, so the next page view carries referrer and UTM. */
  get isFirstPageView() {
    return this.#state !== null && this.#state.pageViews === 0
  }

  /** Counts one page view in the session. */
  countPageView() {
    if (this.#state === null) return

    this.#state.pageViews += 1
    this.#writeState()
  }

  /** Ends an idle session, starts one when there is none, and pushes the idle deadline out. */
  markActivity() {
    const nowMs = this.#now()

    // An idle session ends where its activity stopped, then a new one starts.
    if (this.#state !== null && nowMs - this.#state.lastActivityMs >= SESSION_TIMEOUT_MS) this.#endSession()

    if (this.#state === null) {
      this.#beginSession(nowMs)
      return
    }

    // Throttle the storage write and timer reset; the session stays current either way.
    if (nowMs - this.#lastMarkMs < ACTIVITY_THROTTLE_MS) return

    this.#lastMarkMs = nowMs
    this.#state.lastActivityMs = nowMs
    this.#writeState()
    this.#armEndTimer()
  }

  // Starts a session: a new id on every later event, then session_start.
  #beginSession(nowMs) {
    this.#state = { id: newSessionId(), startedAtMs: nowMs, lastActivityMs: nowMs, pageViews: 0 }
    this.#lastMarkMs = nowMs
    this.#client.setSessionId(this.#state.id)
    this.#client.track('session_start')
    this.#writeState()
    this.#armEndTimer()
  }

  // Sends session_end at the last activity, with the session's length and page views, then forgets it.
  #endSession() {
    const endedState = this.#state
    const durationSeconds = Math.max(0, Math.round((endedState.lastActivityMs - endedState.startedAtMs) / 1000))

    this.#client.setSessionId(endedState.id)
    this.#client.track('session_end', { duration_s: durationSeconds, page_views: endedState.pageViews }, { timestamp: endedState.lastActivityMs })
    this.#client.setSessionId(null)

    this.#state = null
    this.#cancelEndTimer()
    this.#removeState()
  }

  // Fires session_end once the tab has been idle for the whole timeout, even if no further activity comes.
  #armEndTimer() {
    this.#cancelEndTimer()

    const dueInMs = this.#state.lastActivityMs + SESSION_TIMEOUT_MS - this.#now()
    this.#endTimer = this.#timers.setTimeout(() => {
      this.#endTimer = null
      if (this.#state !== null && this.#now() - this.#state.lastActivityMs >= SESSION_TIMEOUT_MS) this.#endSession()
    }, Math.max(0, dueInMs))

    // Never keep a Node process alive for a session timer.
    this.#endTimer?.unref?.()
  }

  // Clears the idle timer, if any.
  #cancelEndTimer() {
    if (this.#endTimer !== null) this.#timers.clearTimeout(this.#endTimer)
    this.#endTimer = null
  }

  // The stored session of this tab, or null when there is none or it is unreadable; a live one is adopted.
  #readState() {
    try {
      const storedState = JSON.parse(this.#storage?.getItem(SESSION_STORAGE_KEY) ?? 'null')
      const isReadable = typeof storedState?.id === 'string' && Number.isFinite(storedState.startedAtMs) && Number.isFinite(storedState.lastActivityMs)
      if (!isReadable) return null

      // A stored session is resumed with its id; an expired one is ended by the first markActivity.
      const state = { id: storedState.id, startedAtMs: storedState.startedAtMs, lastActivityMs: storedState.lastActivityMs, pageViews: Number(storedState.pageViews) || 0 }
      this.#client.setSessionId(state.id)
      return state
    } catch {
      return null
    }
  }

  // Saves the session for the next page load in this tab.
  #writeState() {
    try {
      this.#storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.#state))
    } catch {
      // A full or blocked sessionStorage keeps the session in memory only.
    }
  }

  // Deletes the stored session.
  #removeState() {
    try {
      this.#storage?.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // Nothing to clean up when storage is blocked.
    }
  }
}

/** One app session for React Native: session_start at launch, and a new session when the app returns after 30 minutes in the background. */
export class AppSession {
  #client
  #now
  #state = null
  #backgroundedAtMs = null

  /** Keeps the client and the clock. */
  constructor(client, context) {
    this.#client = client
    this.#now = context.now
  }

  /** Starts a session unless the app launched in the background, and follows app state changes; returns the stop function. */
  start(initialAppState, addAppStateListener) {
    // A headless launch (a background task) starts no session until the app comes to the foreground.
    if (initialAppState === undefined || initialAppState === null || initialAppState === 'active') this.#beginSession(this.#now())
    else this.#backgroundedAtMs = this.#now()

    return addAppStateListener?.((appStateValue) => this.handleAppStateChange(appStateValue)) ?? (() => {})
  }

  /** Notes when the app went to the background; on return after 30 minutes or more, ends the old session and starts a new one. */
  handleAppStateChange(appStateValue) {
    const nowMs = this.#now()

    if (appStateValue === 'background') {
      this.#backgroundedAtMs ??= nowMs
      return
    }

    if (appStateValue !== 'active') return

    // A long stay in the background ends the session where the app left the foreground.
    const wasAwayLong = this.#backgroundedAtMs !== null && nowMs - this.#backgroundedAtMs >= SESSION_TIMEOUT_MS
    if (this.#state !== null && wasAwayLong) this.#endSession(this.#backgroundedAtMs)

    this.#backgroundedAtMs = null
    if (this.#state === null) this.#beginSession(nowMs)
  }

  // Starts a session: a new id on every later event, then session_start.
  #beginSession(nowMs) {
    this.#state = { id: newSessionId(), startedAtMs: nowMs }
    this.#client.setSessionId(this.#state.id)
    this.#client.track('session_start')
  }

  // Sends session_end stamped when the app left the foreground, with the session's length, then forgets it.
  #endSession(endedAtMs) {
    const durationSeconds = Math.max(0, Math.round((endedAtMs - this.#state.startedAtMs) / 1000))

    this.#client.track('session_end', { duration_s: durationSeconds }, { timestamp: endedAtMs })
    this.#client.setSessionId(null)
    this.#state = null
  }
}

// Sends page_view on load and on every SPA route change (pushState, replaceState, popstate, hashchange) that changes the path.
function capturePageViews(client, windowTarget, documentTarget, session) {
  const historyTarget = windowTarget.history
  let lastPath = null

  // Sends one page_view when the path differs from the last one sent.
  const capture = () => {
    const location = windowTarget.location
    const path = pagePath(location)
    if (path === lastPath) return

    // Without sessions, the first page view of this page load is the landing one.
    const isFirstOfLoad = lastPath === null
    lastPath = path
    session?.markActivity()

    // The session's first page view says where the visitor came from; without sessions, this page load's first one does.
    const isFirstPageView = session ? session.isFirstPageView : isFirstOfLoad
    const props = { path, ...titleProp(documentTarget), ...(isFirstPageView ? landingProps(location, documentTarget) : {}) }

    client.track('page_view', props)
    session?.countPageView()
  }

  // Route changes are read a microtask later, once the router has swapped the URL (and usually the title).
  const captureSoon = () => queueMicrotask(capture)
  const originalPushState = historyTarget?.pushState
  const originalReplaceState = historyTarget?.replaceState

  // Wraps a history method so the app's call runs first, untouched, and a page view follows.
  const wrapHistoryMethod = (originalMethod) =>
    function (...historyArguments) {
      const result = originalMethod.apply(this, historyArguments)
      captureSoon()
      return result
    }

  const wrappedPushState = typeof originalPushState === 'function' ? wrapHistoryMethod(originalPushState) : null
  const wrappedReplaceState = typeof originalReplaceState === 'function' ? wrapHistoryMethod(originalReplaceState) : null

  if (wrappedPushState) historyTarget.pushState = wrappedPushState
  if (wrappedReplaceState) historyTarget.replaceState = wrappedReplaceState
  windowTarget.addEventListener?.('popstate', captureSoon)
  windowTarget.addEventListener?.('hashchange', captureSoon)

  // The page the visitor landed on.
  capture()

  return () => {
    // Restore the history methods only if nobody wrapped them after us.
    if (wrappedPushState && historyTarget.pushState === wrappedPushState) historyTarget.pushState = originalPushState
    if (wrappedReplaceState && historyTarget.replaceState === wrappedReplaceState) historyTarget.replaceState = originalReplaceState
    windowTarget.removeEventListener?.('popstate', captureSoon)
    windowTarget.removeEventListener?.('hashchange', captureSoon)
  }
}

// Logs uncaught errors and unhandled promise rejections as error-level log lines, bounded per page.
function captureBrowserErrors(client, windowTarget) {
  const countsByMessage = new Map()
  let loggedCount = 0

  // Logs one error unless this page already logged too many, or this message too often.
  const logError = (message, props) => {
    const repeatCount = (countsByMessage.get(message) ?? 0) + 1
    countsByMessage.set(message, repeatCount)
    if (loggedCount >= ERROR_LIMITS.perPage || repeatCount > ERROR_LIMITS.perMessage) return

    loggedCount += 1
    client.log('error', message, { ...props, path: pagePath(windowTarget.location) })
  }

  // An uncaught exception; resource load errors don't bubble to window, so only script errors arrive here.
  const onError = (errorEvent) => {
    const error = errorEvent?.error
    const message = error instanceof Error ? errorText(error) : truncate(String(errorEvent?.message ?? 'Unknown error'), ERROR_LIMITS.textChars)

    logError(message, {
      source: 'window.onerror',
      ...(errorEvent?.filename ? { file: stripQuery(String(errorEvent.filename)) } : {}),
      ...(Number.isFinite(errorEvent?.lineno) ? { line: errorEvent.lineno } : {}),
      ...(Number.isFinite(errorEvent?.colno) ? { column: errorEvent.colno } : {}),
      ...stackProp(error),
    })
  }

  // A promise rejected with nobody to catch it.
  const onUnhandledRejection = (rejectionEvent) => {
    const reason = rejectionEvent?.reason
    const message = reason instanceof Error ? errorText(reason) : `Unhandled rejection: ${truncate(describeValue(reason), ERROR_LIMITS.textChars)}`

    logError(message, { source: 'unhandledrejection', ...stackProp(reason) })
  }

  windowTarget.addEventListener?.('error', onError)
  windowTarget.addEventListener?.('unhandledrejection', onUnhandledRejection)

  return () => {
    windowTarget.removeEventListener?.('error', onError)
    windowTarget.removeEventListener?.('unhandledrejection', onUnhandledRejection)
  }
}

// Sends outbound_click when a link to another host is clicked; the page-hide flush delivers it as the page unloads.
function captureOutboundClicks(client, windowTarget, documentTarget) {
  const onClick = (clickEvent) => {
    try {
      const link = clickEvent?.target?.closest?.('a[href]')
      if (!link) return

      // Only http(s) links to another host count; mailto:, tel: and same-site links don't.
      const targetUrl = new URL(link.getAttribute('href'), windowTarget.location.href)
      const isWebLink = targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:'
      if (!isWebLink || targetUrl.host === windowTarget.location.host) return

      client.track('outbound_click', { url: `${targetUrl.origin}${targetUrl.pathname}`, host: targetUrl.host, path: pagePath(windowTarget.location) })
    } catch {
      // A malformed href is not worth a warning.
    }
  }

  documentTarget?.addEventListener?.('click', onClick, { capture: true, passive: true })

  return () => documentTarget?.removeEventListener?.('click', onClick, { capture: true })
}

// Sends the event a clicked element names in data-track, with its data-track-* attributes as props: <button data-track="signup" data-track-plan="pro">.
function captureTrackedClicks(client, windowTarget, documentTarget) {
  const onClick = (clickEvent) => {
    try {
      const trackedElement = clickEvent?.target?.closest?.('[data-track]')
      const eventName = truncate(String(trackedElement?.getAttribute?.('data-track') ?? '').trim(), TRACKED_CLICK_LIMITS.textChars)
      if (eventName === '') return

      client.track(eventName, { ...trackedProps(trackedElement), path: pagePath(windowTarget.location) })
    } catch {
      // A malformed element is not worth a warning.
    }
  }

  documentTarget?.addEventListener?.('click', onClick, { capture: true, passive: true })

  return () => documentTarget?.removeEventListener?.('click', onClick, { capture: true })
}

// The data-track-* attributes of an element as props (data-track-plan → plan), bounded.
function trackedProps(trackedElement) {
  const props = {}
  const attributeNames = typeof trackedElement?.getAttributeNames === 'function' ? trackedElement.getAttributeNames() : []

  for (const attributeName of attributeNames) {
    if (!attributeName.startsWith('data-track-')) continue
    if (Object.keys(props).length >= TRACKED_CLICK_LIMITS.props) break

    const propName = attributeName.slice('data-track-'.length).replaceAll('-', '_')
    if (propName !== '') props[propName] = truncate(String(trackedElement.getAttribute(attributeName) ?? ''), TRACKED_CLICK_LIMITS.textChars)
  }

  return props
}

// Logs an uncaught exception as critical, flushes for up to 2 s, then exits with code 1 as Node would have.
function captureUncaughtExceptions(client, context) {
  return watchProcessCrashes(context, (error) => {
    client.log('critical', error instanceof Error ? errorText(error) : `Uncaught: ${describeValue(error)}`, { source: 'uncaughtException', ...stackProp(error) })
  })
}

// The path a page view reports: the pathname, plus the hash for hash routers (#/…); never the query string.
function pagePath(location) {
  const hash = typeof location?.hash === 'string' && location.hash.startsWith('#/') ? location.hash : ''
  return `${location?.pathname ?? '/'}${hash}`
}

// The document title as a prop, when there is one.
function titleProp(documentTarget) {
  const title = typeof documentTarget?.title === 'string' ? documentTarget.title.trim() : ''
  return title === '' ? {} : { title: truncate(title, 200) }
}

// The external referrer (origin and path, no query) and the landing URL's UTM parameters.
function landingProps(location, documentTarget) {
  const props = {}

  try {
    const referrerText = typeof documentTarget?.referrer === 'string' ? documentTarget.referrer : ''
    const referrerUrl = referrerText === '' ? null : new URL(referrerText)

    // A referrer from this same site is navigation, not a source.
    if (referrerUrl && referrerUrl.host !== location.host) {
      props.referrer = `${referrerUrl.origin}${referrerUrl.pathname}`
      props.referrer_host = referrerUrl.host
    }
  } catch {
    // An unreadable referrer is left out.
  }

  try {
    const searchParams = new URLSearchParams(location.search ?? '')

    for (const parameterName of UTM_PARAMETERS) {
      const parameterValue = searchParams.get(parameterName)
      if (parameterValue) props[parameterName] = truncate(parameterValue, 200)
    }
  } catch {
    // An unreadable query string carries no UTM.
  }

  return props
}

// An error as "Name: message", bounded.
function errorText(error) {
  return truncate(`${error.name || 'Error'}: ${error.message ?? ''}`, ERROR_LIMITS.textChars)
}

// The stack trace as a prop, bounded, when the value has one.
function stackProp(value) {
  return typeof value?.stack === 'string' && value.stack !== '' ? { stack: truncate(value.stack, ERROR_LIMITS.stackChars) } : {}
}

// sessionStorage when the page allows it; null when blocked (the session then lives in memory).
function readSessionStorage(windowTarget) {
  try {
    return windowTarget?.sessionStorage ?? null
  } catch {
    return null
  }
}

// A random session id; a UUID where the platform has one.
function newSessionId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
