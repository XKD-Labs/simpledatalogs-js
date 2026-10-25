/** simpledatalogs for browsers, workers, React Native and Node: batches events, log lines and exceptions to the ingest API and never blocks or breaks the host. */

import { createActivityTracker, isAppStateActive, isPageVisible } from './activity.js'
import { isDoNotTrackOn, resolveAutocaptureFlags, startAutocapture } from './autocapture.js'
import { exceptionFields, installCrashHandlers } from './exceptions.js'
import { defaultPageTargets, defaultProcessTarget, defaultStorage, isDevelopmentBuild, isUsableStorage, isWebStorage, resolveRuntime } from './runtime.js'

export { chromeStorageAdapter } from './runtime.js'

/** This SDK's version, sent in the User-Agent where the runtime allows one. */
export const SDK_VERSION = '0.5.0'

/** The production ingest host. */
export const DEFAULT_ENDPOINT = 'https://edge.simpledatalogs.com'

// The ingest API sender defaults; the first batch goes after 1 s so a new setup shows data at once, then every 10 s or at 50 events, requests stay under 256 KB.
const DEFAULT_SETTINGS = {
  endpoint: DEFAULT_ENDPOINT,
  firstFlushDelayMs: 1_000,
  flushIntervalMs: 10_000,
  maxBatchEvents: 50,
  maxRequestBytes: 256_000,
  maxKeepaliveBytes: 60_000,
  maxOutboxEvents: 1_000,
  maxOutboxBytes: 2_000_000,
  requestTimeoutMs: 15_000,
}

// While the app is being developed, batches go every 5 s so new events show within seconds.
const DEVELOPMENT_SETTINGS = { flushIntervalMs: 5_000 }

// An async storage (AsyncStorage, chrome.storage) is written at most once a second while events arrive.
const ASYNC_PERSIST_DELAY_MS = 1_000

// Backoff with full jitter from 1 s to 5 min, Retry-After as a floor, and slow re-probes after a 401.
const RETRY_POLICY = {
  initialMs: 1_000,
  maximumMs: 300_000,
  minimumMs: 250,
  maximumRetryAfterMs: 3_600_000,
  invalidKeyFirstProbeMs: 60_000,
  invalidKeyProbeMs: 600_000,
}

// Every stored outbox starts with this; Web Storage gets one per page load, so tabs never overwrite each other, and an async storage one per key.
const STORAGE_PREFIX = 'simpledatalogs:outbox:'

// A stored outbox this old is deleted whatever key wrote it, so a rotated key's leftovers never fill the origin's quota.
const STALE_OUTBOX_MS = 30 * 24 * 3_600_000

// Prop values the ingest API accepts.
const PROP_VALUE_TYPES = new Set(['string', 'number', 'boolean'])

// A caller's event_id must be a UUID, any version.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The ingest API refuses a ts more than 10 years old or after 2095; 3,650 days stays safely inside.
const TS_LIMITS = { maxAgeMs: 3_650 * 24 * 3_600_000, latestMs: Date.UTC(2095, 0, 1) }

// Encodes strings to count their UTF-8 bytes.
const utf8Encoder = new TextEncoder()

/** Creates a client; call once per ingest key, then track from anywhere. */
export function createClient(options) {
  return new SimpleDataLogsClient(options)
}

/** Creates a client from `{ key, autocapture }`; the short form of createClient for one-line setups. */
export function init(options = {}) {
  return new SimpleDataLogsClient({ ...options, ingestKey: options.ingestKey ?? options.key })
}

/** One ingest key's pipeline: an outbox kept until a 202, batched sends, retries and a page-hide flush. */
export class SimpleDataLogsClient {
  #settings
  #ingestUrl
  #fetch
  #now
  #random
  #timers
  #logger
  #runtime
  #globalScope
  #storage
  #storageKey
  #isAsyncStorage = false
  #isStorageLoaded = true
  #storageLoad = null
  #shouldDiscardStoredOutbox = false
  #persistTimer = null
  #isWriteRunning = false
  #isWriteAgainNeeded = false
  #runningWrite = null
  #shouldSendUserAgent
  #pageTargets
  #processTarget
  #defaultProps = {}
  #release = null
  #appStateListeners = []
  #outbox = []
  #outboxBytes = 0
  #inFlightEventIds = new Set()
  #isPersistQueued = false
  #failedPersistBytes = Infinity
  #isKeepaliveInFlight = false
  #deviceId = null
  #userId = null
  #sessionId = null
  #isEnabled = true
  #isShutDown = false
  #failureCount = 0
  #invalidKeyProbeCount = 0
  #pausedUntilMs = 0
  #currentMaxBatchEvents
  #flushTimer = null
  #flushTimerDueAtMs = Infinity
  #runningFlush = null
  #hasFlushed = false
  #warnedKinds = new Set()
  #removePageListeners = () => {}
  #removeAppStateListener = () => {}
  #activity = null
  #stopAutocapture = () => {}
  #uninstallCrashHandlers = null

  /** Reads the options, adopts any outbox a closed page or app left behind, and listens for page hide or app state. */
  constructor(options = {}) {
    // The runtime decides the defaults: storage, page listeners, crash capture and the User-Agent.
    this.#globalScope = options.globalScope ?? globalThis
    this.#runtime = resolveRuntime(options.runtime, this.#globalScope)

    // Trim copy-paste whitespace from the key; without one, nothing is ever sent.
    const developmentSettings = isDevelopmentBuild(this.#runtime, this.#globalScope) ? DEVELOPMENT_SETTINGS : {}
    this.#settings = { ...DEFAULT_SETTINGS, ...developmentSettings, ...pickDefined(options, Object.keys(DEFAULT_SETTINGS)) }
    this.#settings.ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey.trim() : ''
    this.#currentMaxBatchEvents = this.#settings.maxBatchEvents
    this.#ingestUrl = `${String(this.#settings.endpoint).replace(/\/+$/, '')}/v1/ingest`

    // Runtime hooks, injectable for tests and unusual hosts.
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
    this.#now = options.now ?? (() => Date.now())
    this.#random = options.random ?? Math.random
    this.#timers = options.timers ?? { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }
    this.#logger = options.logger === undefined ? globalThis.console : options.logger
    this.#shouldSendUserAgent = options.sendUserAgent ?? this.#runtime === 'node'
    this.#deviceId = cleanIdentity(options.deviceId)
    this.#userId = cleanIdentity(options.userId)
    this.#release = cleanIdentity(options.release)
    this.#defaultProps = this.#scalarProps(options.defaultProperties)

    // Warn about keys that can't work, but keep running so the host never breaks.
    this.#warnAboutKey()

    // Storage keeps unsent events across reloads and launches: localStorage, an async adapter, or memory.
    this.#setUpStorage(options.storage === undefined ? defaultStorage(this.#runtime, this.#globalScope) : options.storage)

    // Flush on page hide in browsers, unless the host opts out.
    this.#pageTargets = options.pageTargets === undefined ? defaultPageTargets(this.#runtime, this.#globalScope) : options.pageTargets
    this.#processTarget = options.processTarget === undefined ? defaultProcessTarget(this.#runtime, this.#globalScope) : options.processTarget
    this.#listenForPageHide()

    // Send whatever a previous page load left behind.
    if (this.#outbox.length > 0) this.#scheduleFlush(0)

    // With respectDoNotTrack, Do Not Track or Global Privacy Control is an opt-out for every send.
    if (options.respectDoNotTrack === true && isDoNotTrackOn(this.#globalScope)) this.setEnabled(false)

    // Automatic capture is opt-in: `autocapture: true` or an object of flags.
    this.#startAutocapture(options)

    // React Native's AppState: flush on background and, with autocapture, renew sessions.
    this.#watchAppState(options.appState)

    // Events say whether someone was using the page or app, unless `activity: 'off'`.
    this.#watchActivity(options)
  }

  /** Records an event with optional props, and optional `{ eventId, ts }` for idempotent re-sends and past events; never throws. */
  track(eventName, props, trackOptions) {
    this.#guard(() => {
      if (typeof eventName !== 'string' || eventName.trim() === '') {
        this.#warnOnce('event_name', 'track() needs a non-empty event name; the event was skipped')
        return
      }

      // An event happening now carries app_state and engaged_ms; the caller's own props win.
      const isHappeningNow = (trackOptions?.ts ?? trackOptions?.timestamp) === undefined
      const activityProps = isHappeningNow && this.#activity !== null ? this.#activity.stamp(this.#now()) : {}

      this.#enqueue({ event: eventName.trim(), ...this.#baseFields(trackOptions), ...this.#propsField(props, activityProps) })
    })
  }

  /** Records a log line with a level (debug, info, notice, warning, error, critical), optional props and `{ eventId, ts }`; never throws. */
  log(level, message, props, logOptions) {
    this.#guard(() => {
      const levelText = typeof level === 'string' ? level.trim().toLowerCase() : ''

      this.#enqueue({
        ...this.#baseFields(logOptions),
        ...(levelText === '' ? {} : { level: levelText }),
        message: message instanceof Error ? `${message.name}: ${message.message}` : String(message ?? ''),
        ...this.#propsField(props),
      })
    })
  }

  /** Records an error as exception telemetry (type, message, stack frames), handled unless `{ handled: false }`; never throws. */
  captureException(error, exceptionOptions) {
    this.#guard(() => {
      const options = exceptionOptions ?? {}

      this.#enqueue({
        kind: 'exception',
        ...this.#baseFields(options),
        ...exceptionFields(error, options),
        ...(this.#release === null ? {} : { release: this.#release }),
        ...this.#propsField(options.props),
      })
    })
  }

  /** Sends uncaught errors and unhandled rejections as unhandled exceptions (window, worker, React Native ErrorUtils or Node); returns the uninstall function. */
  installGlobalHandlers() {
    // A second call keeps the handlers already in place.
    if (this.#uninstallCrashHandlers !== null) return this.#uninstallCrashHandlers

    try {
      const removeHandlers = installCrashHandlers(this, this.#crashContext())

      this.#uninstallCrashHandlers = () => {
        removeHandlers()
        this.#uninstallCrashHandlers = null
      }
    } catch (error) {
      this.#warnOnce('crash_handlers', `crash handlers could not be installed: ${error}`)
      return () => {}
    }

    return this.#uninstallCrashHandlers
  }

  /** Tells the client about a React Native app state change: `background` flushes and saves, `active` may start a new session. */
  handleAppStateChange(appStateValue) {
    this.#guard(() => {
      // Going to the background may be the last chance to send before the app is stopped.
      if (appStateValue === 'background') {
        this.#persistNow()
        this.flush()
      }

      // Only `active` is in front; `inactive` and `background` are not.
      if (this.#runtime === 'react-native') this.#activity?.setActive(isAppStateActive(appStateValue), this.#now())

      this.#appStateListeners.forEach((listener) => listener(appStateValue))
    })
  }

  /** Replaces the props merged into every event, log line and exception; the event's own props win on a clash. */
  setDefaultProperties(props) {
    this.#guard(() => {
      this.#defaultProps = this.#scalarProps(props)
    })
  }

  /** Sets the anonymous device id sent with every later event, or clears it with null. */
  setDeviceId(deviceId) {
    this.#deviceId = cleanIdentity(deviceId)
  }

  /** Sets the user id sent with every later event, or clears it with null. */
  setUserId(userId) {
    this.#userId = cleanIdentity(userId)
  }

  /** Sets the session id sent with every later event, or clears it with null; autocapture manages it when sessions are on. */
  setSessionId(sessionId) {
    this.#sessionId = cleanIdentity(sessionId)
  }

  /** Turns collection on or off; turning it off is an opt-out and deletes every unsent event. */
  setEnabled(isEnabled) {
    this.#guard(() => {
      this.#isEnabled = Boolean(isEnabled)
      if (this.#isEnabled) return

      // Stop the timer and forget everything not yet delivered, including a stored outbox still loading.
      this.#cancelFlushTimer()
      this.#outbox = []
      this.#outboxBytes = 0
      if (!this.#isStorageLoaded) this.#shouldDiscardStoredOutbox = true
      this.#persistNow()
    })
  }

  /** Where the client runs: browser, worker, react-native or node. */
  get runtime() {
    return this.#runtime
  }

  /** The number of events not yet confirmed by a 202. */
  get pendingCount() {
    return this.#outbox.length
  }

  /** Sends everything tracked so far; resolves when that attempt ends, keeping anything undelivered. Never rejects. */
  flush() {
    // Join a flush that is already running, so one request is in flight at a time.
    if (this.#runningFlush) return this.#runningFlush

    this.#hasFlushed = true
    this.#runningFlush = this.#flushUntilEmpty()
      .catch((error) => this.#warnOnce('flush_crash', `flush failed unexpectedly: ${error}`))
      .finally(() => {
        this.#runningFlush = null
        this.#scheduleAfterFlush()
      })

    return this.#runningFlush
  }

  /** Flushes once more, then stops timers and listeners and saves what is left; events tracked later are ignored. */
  async shutdown() {
    await this.flush()
    this.#isShutDown = true
    this.#cancelFlushTimer()
    this.#removePageListeners()
    this.#removeAppStateListener()
    this.#stopAutocapture()
    this.#uninstallCrashHandlers?.()
    await this.#persistNow()
  }

  // Starts the opt-in autocapture features; a failure there never breaks the client.
  #startAutocapture(options) {
    const flags = resolveAutocaptureFlags(options.autocapture)
    if (flags === null) return

    try {
      this.#stopAutocapture = startAutocapture(this, flags, {
        ...this.#crashContext(),
        pageTargets: this.#pageTargets,
        sessionStorage: options.sessionStorage,
        now: this.#now,
        initialAppState: options.appState?.currentState,
        addAppStateListener: (listener) => this.#addAppStateListener(listener),
      })
    } catch (error) {
      this.#warnOnce('autocapture', `autocapture could not start: ${error}`)
    }
  }

  // What crash capture needs: the runtime, its scope and process, timers, the logger and a flush that saves first.
  #crashContext() {
    return {
      runtime: this.#runtime,
      scope: this.#pageTargets?.window ?? this.#globalScope,
      processTarget: this.#processTarget,
      timers: this.#timers,
      logger: this.#logger,
      flushBeforeExit: () => Promise.all([this.#persistNow(), this.flush()]),
    }
  }

  // Subscribes to React Native's AppState (`appState: AppState`), so app state changes reach handleAppStateChange.
  #watchAppState(appState) {
    if (typeof appState?.addEventListener !== 'function') return

    try {
      const onAppStateChange = (appStateValue) => this.handleAppStateChange(appStateValue)
      const subscription = appState.addEventListener('change', onAppStateChange)

      // Newer React Native returns a subscription; older versions remove by listener.
      this.#removeAppStateListener = () => (typeof subscription?.remove === 'function' ? subscription.remove() : appState.removeEventListener?.('change', onAppStateChange))
    } catch (error) {
      this.#warnOnce('app_state', `could not follow the app state: ${error}`)
    }
  }

  // Tracks the page's visibility in browsers, or React Native's AppState; Node and workers send no activity.
  #watchActivity(options) {
    if (options.activity === 'off') return

    const documentTarget = this.#pageTargets?.document

    if (this.#runtime === 'react-native' && options.appState) {
      this.#activity = createActivityTracker(isAppStateActive(options.appState.currentState), this.#now())
      return
    }

    // The page-hide listener already follows visibility and updates the tracker.
    if (documentTarget) this.#activity = createActivityTracker(isPageVisible(documentTarget), this.#now())
  }

  // Adds an app state listener for autocapture and returns its remover.
  #addAppStateListener(listener) {
    this.#appStateListeners.push(listener)

    return () => {
      this.#appStateListeners = this.#appStateListeners.filter((kept) => kept !== listener)
    }
  }

  // Runs a public call's body so no exception ever reaches the host app.
  #guard(body) {
    try {
      if (!this.#isShutDown) body()
    } catch (error) {
      this.#warnOnce('internal', `internal error, nothing was thrown to the app: ${error}`)
    }
  }

  // The id, time and identity fields every event carries: a new id and now, or the caller's eventId and ts.
  #baseFields(eventOptions) {
    return {
      event_id: this.#eventIdField(eventOptions?.eventId),
      ts: new Date(this.#happenedAtMs(eventOptions?.ts ?? eventOptions?.timestamp)).toISOString(),
      ...(this.#deviceId === null ? {} : { device_id: this.#deviceId }),
      ...(this.#userId === null ? {} : { user_id: this.#userId }),
      ...(this.#sessionId === null ? {} : { session_id: this.#sessionId }),
    }
  }

  // The caller's UUID event_id (lowercased) for an idempotent re-send, or a new one; anything else is replaced with a warning.
  #eventIdField(eventId) {
    if (eventId === undefined || eventId === null) return newEventId()
    if (typeof eventId === 'string' && UUID_PATTERN.test(eventId.trim())) return eventId.trim().toLowerCase()

    this.#warnOnce('event_id', 'eventId must be a UUID string; a new event_id was used')
    return newEventId()
  }

  // When the event happened in epoch ms: the caller's Date, epoch ms or ISO text within the ingest API's range, else now.
  #happenedAtMs(happenedAt) {
    const nowMs = this.#now()
    if (happenedAt === undefined || happenedAt === null) return nowMs

    const happenedAtMs = happenedAt instanceof Date ? happenedAt.getTime() : typeof happenedAt === 'string' ? Date.parse(happenedAt) : Number.isFinite(happenedAt) ? happenedAt : NaN
    const isInRange = Number.isFinite(happenedAtMs) && nowMs - happenedAtMs <= TS_LIMITS.maxAgeMs && happenedAtMs < TS_LIMITS.latestMs
    if (isInRange) return happenedAtMs

    this.#warnOnce('ts', 'ts must be a Date, epoch milliseconds or ISO 8601 text within the last 10 years; the current time was used')
    return nowMs
  }

  // The default props, then any stamped props, with the event's own on top, as the props field, or nothing when all are empty.
  #propsField(props, stampedProps = {}) {
    const mergedProps = { ...this.#defaultProps, ...stampedProps, ...this.#scalarProps(props) }

    return Object.keys(mergedProps).length === 0 ? {} : { props: mergedProps }
  }

  // Keeps only string, finite number and boolean props, warning once about the rest.
  #scalarProps(props) {
    if (props === undefined || props === null) return {}

    if (typeof props !== 'object' || Array.isArray(props)) {
      this.#warnOnce('props_shape', 'props must be a plain object; they were skipped')
      return {}
    }

    const keptProps = {}

    for (const [propName, propValue] of Object.entries(props)) {
      const isKept = PROP_VALUE_TYPES.has(typeof propValue) && (typeof propValue !== 'number' || Number.isFinite(propValue))

      if (isKept) keptProps[propName] = propValue
      else this.#warnOnce('prop_value', `prop "${propName}" is not a string, finite number or boolean; it was skipped`)
    }

    return keptProps
  }

  // Adds one event to the outbox, then flushes at a full batch or schedules the interval flush.
  #enqueue(eventObject) {
    if (!this.#isEnabled) return

    // An event that can't fit in any request could never be accepted.
    const entry = outboxEntry(JSON.stringify(eventObject))

    if (entry.bytes + 2 > this.#settings.maxRequestBytes) {
      this.#warnOnce('event_too_large', `an event of ${entry.bytes} bytes is over the request limit and was skipped`)
      return
    }

    // Keep the outbox bounded, oldest first out, and persist it once this turn's calls are done.
    this.#outbox.push(entry)
    this.#outboxBytes += entry.bytes
    this.#trimOutbox()
    this.#schedulePersist()

    // A full batch goes now; the client's first batch goes soon; otherwise the interval timer picks it up.
    const unsentCount = this.#outbox.length - this.#inFlightEventIds.size
    this.#scheduleFlush(unsentCount >= this.#settings.maxBatchEvents ? 0 : this.#nextFlushDelayMs())
  }

  // Drops the oldest events while the outbox is over its event or byte cap.
  #trimOutbox() {
    let droppedCount = 0

    while (this.#outbox.length > 0 && (this.#outbox.length > this.#settings.maxOutboxEvents || this.#outboxBytes > this.#settings.maxOutboxBytes)) {
      this.#outboxBytes -= this.#outbox.shift().bytes
      droppedCount += 1
    }

    if (droppedCount > 0) this.#warnOnce('outbox_full', `outbox over its cap; dropped the oldest ${droppedCount} unsent events`)
  }

  // Sends batches until nothing unsent is left, a send fails, or sending is paused; a stored outbox still loading is waited for.
  async #flushUntilEmpty() {
    await this.#storageLoad

    while (this.#canSend() && this.#nextBatch(this.#settings.maxRequestBytes).length > 0) {
      const outcome = await this.#sendBatch({ isKeepalive: false })
      if (outcome === 'failed') return

      // Node pools the finished socket a tick later; waiting one turn lets the next batch reuse it instead of opening another.
      await yieldToEventLoop()
    }
  }

  // True when a request may go out now.
  #canSend() {
    return this.#isEnabled && !this.#isShutDown && this.#now() >= this.#pausedUntilMs && this.#settings.ingestKey !== '' && typeof this.#fetch === 'function'
  }

  // The oldest unsent entries that fit one request.
  #nextBatch(maxBodyBytes) {
    const batchEntries = []
    let bodyBytes = 2

    for (const entry of this.#outbox) {
      if (batchEntries.length >= this.#currentMaxBatchEvents) break
      if (this.#inFlightEventIds.has(entry.eventId)) continue

      // Each entry after the first adds a comma.
      const addedBytes = entry.bytes + (batchEntries.length > 0 ? 1 : 0)
      if (bodyBytes + addedBytes > maxBodyBytes) break

      batchEntries.push(entry)
      bodyBytes += addedBytes
    }

    return batchEntries
  }

  // POSTs one batch as a JSON array and applies the ingest API answer; returns sent, split, dropped or failed.
  async #sendBatch({ isKeepalive }) {
    const batchEntries = this.#nextBatch(isKeepalive ? this.#settings.maxKeepaliveBytes : this.#settings.maxRequestBytes)
    if (batchEntries.length === 0) return 'sent'

    // Mark the batch in flight so a page-hide send never duplicates it.
    const batchEventIds = batchEntries.map((entry) => entry.eventId)
    batchEventIds.forEach((eventId) => this.#inFlightEventIds.add(eventId))

    try {
      const response = await this.#post(`[${batchEntries.map((entry) => entry.line).join(',')}]`, isKeepalive)

      // Read the small answer body, so Node returns the socket to its pool and the next batch reuses the connection.
      await drainBody(response)
      return this.#applyResponse(response, batchEventIds)
    } catch (error) {
      // A network error or timeout: unknown whether it was stored, so keep it and retry; a refused keepalive says nothing about the network.
      this.#warnOnce('network', `send failed, will retry: ${error}`)
      if (!isKeepalive) this.#backOff(null)
      return 'failed'
    } finally {
      batchEventIds.forEach((eventId) => this.#inFlightEventIds.delete(eventId))
    }
  }

  // One fetch with the key, the JSON body, and a timeout outside page hide.
  #post(body, isKeepalive) {
    const headers = { Authorization: `Bearer ${this.#settings.ingestKey}`, 'Content-Type': 'application/json' }
    if (this.#shouldSendUserAgent) headers['User-Agent'] = `simpledatalogs-js/${SDK_VERSION}`

    const requestInit = { method: 'POST', headers, body, keepalive: isKeepalive }
    if (!isKeepalive && typeof AbortSignal?.timeout === 'function') requestInit.signal = AbortSignal.timeout(this.#settings.requestTimeoutMs)

    return this.#fetch(this.#ingestUrl, requestInit)
  }

  // Applies one answer: 202 removes the batch, 413 splits, 401 pauses, anything else backs off.
  #applyResponse(response, batchEventIds) {
    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), this.#now())

    // Only a 202 means stored; the batch leaves the outbox, the failure counters reset, and the batch size doubles back after a 413.
    if (response.status === 202) {
      this.#removeFromOutbox(new Set(batchEventIds))
      this.#failureCount = 0
      this.#invalidKeyProbeCount = 0
      this.#currentMaxBatchEvents = Math.min(this.#settings.maxBatchEvents, this.#currentMaxBatchEvents * 2)
      return 'sent'
    }

    // Unsupported as sent: resending unchanged can never work, so the batch is dropped and the next one goes.
    if (response.status === 415) {
      this.#warnOnce('event_rejected_415', 'the ingest API refused a batch as unsupported (415); it was dropped')
      this.#removeFromOutbox(new Set(batchEventIds))
      return 'dropped'
    }

    // Too large: halve the batch size, or drop a lone event that can never be accepted.
    if (response.status === 413) {
      if (batchEventIds.length > 1) {
        this.#currentMaxBatchEvents = Math.max(1, Math.floor(batchEventIds.length / 2))
        return 'split'
      }

      this.#warnOnce('event_rejected_413', 'the ingest API refused an event as too large; it was dropped')
      this.#removeFromOutbox(new Set(batchEventIds))
      return 'dropped'
    }

    // Unknown or revoked key: keep the outbox, re-probe after 1 min and then every 10 min.
    if (response.status === 401) {
      this.#warnOnce('invalid_key', 'the ingest key was refused (401); events are kept and the key is re-checked every 10 minutes')
      const probeDelayMs = this.#invalidKeyProbeCount === 0 ? RETRY_POLICY.invalidKeyFirstProbeMs : RETRY_POLICY.invalidKeyProbeMs
      this.#invalidKeyProbeCount += 1
      this.#pausedUntilMs = this.#now() + honorRetryAfter(probeDelayMs, retryAfterMs)
      this.#schedulePersist()
      return 'failed'
    }

    // Anything else (408, 429, 503, other statuses) wasn't stored: back off and retry.
    this.#backOff(retryAfterMs)
    return 'failed'
  }

  // Pauses sending for a full-jitter backoff that is never shorter than Retry-After; an async storage keeps the pause across launches.
  #backOff(retryAfterMs) {
    this.#failureCount += 1
    this.#pausedUntilMs = this.#now() + retryDelayMs(this.#failureCount, retryAfterMs, this.#random())
    this.#schedulePersist()
  }

  // Removes the given events from the outbox and persists it.
  #removeFromOutbox(eventIds) {
    this.#outbox = this.#outbox.filter((entry) => !eventIds.has(entry.eventId) || ((this.#outboxBytes -= entry.bytes), false))
    this.#schedulePersist()
  }

  // Arms the timer for the next flush after a flush ends: at the pause's end, or the interval while events wait.
  #scheduleAfterFlush() {
    if (this.#isShutDown || !this.#isEnabled || this.#outbox.length === 0) return

    const pauseLeftMs = this.#pausedUntilMs - this.#now()
    this.#scheduleFlush(pauseLeftMs > 0 ? pauseLeftMs : this.#settings.flushIntervalMs)
  }

  // The wait before the next batch: short until the first batch was sent, then the interval.
  #nextFlushDelayMs() {
    if (this.#hasFlushed) return this.#settings.flushIntervalMs
    return Math.min(this.#settings.firstFlushDelayMs, this.#settings.flushIntervalMs)
  }

  // Runs flush after delayMs, unless a timer is already due sooner.
  #scheduleFlush(delayMs) {
    if (this.#isShutDown || !this.#isEnabled) return

    // While paused, an earlier flush would only find nothing to do.
    delayMs = Math.max(delayMs, this.#pausedUntilMs - this.#now())
    const dueAtMs = this.#now() + delayMs
    if (this.#flushTimer !== null && this.#flushTimerDueAtMs <= dueAtMs) return

    this.#cancelFlushTimer()
    this.#flushTimerDueAtMs = dueAtMs
    this.#flushTimer = this.#timers.setTimeout(() => {
      this.#flushTimer = null
      this.#flushTimerDueAtMs = Infinity
      this.flush()
    }, delayMs)

    // A Node process may exit while a flush timer waits.
    this.#flushTimer?.unref?.()
  }

  // Clears the pending flush timer, if any.
  #cancelFlushTimer() {
    if (this.#flushTimer !== null) this.#timers.clearTimeout(this.#flushTimer)
    this.#flushTimer = null
    this.#flushTimerDueAtMs = Infinity
  }

  // Sends what fits in one keepalive request as the page hides; anything unconfirmed stays stored for the next load.
  #flushOnPageHide() {
    this.#guard(() => {
      this.#persist()

      // Browsers cap keepalive bodies in flight per origin, so one at a time; a refused one never backs off healthy sending.
      if (!this.#canSend() || this.#isKeepaliveInFlight) return

      this.#isKeepaliveInFlight = true
      this.#sendBatch({ isKeepalive: true })
        .catch(() => {})
        .finally(() => (this.#isKeepaliveInFlight = false))
    })
  }

  // Listens for pagehide and a hidden visibility state on the page targets.
  #listenForPageHide() {
    const { window: windowTarget, document: documentTarget } = this.#pageTargets ?? {}
    const onPageHide = () => this.#flushOnPageHide()
    const onVisibilityChange = () => {
      // The page's visibility is also whether someone is using it (app_state).
      this.#activity?.setActive(isPageVisible(documentTarget), this.#now())
      if (documentTarget?.visibilityState === 'hidden') this.#flushOnPageHide()
    }

    windowTarget?.addEventListener?.('pagehide', onPageHide)
    documentTarget?.addEventListener?.('visibilitychange', onVisibilityChange)

    this.#removePageListeners = () => {
      windowTarget?.removeEventListener?.('pagehide', onPageHide)
      documentTarget?.removeEventListener?.('visibilitychange', onVisibilityChange)
    }
  }

  // Picks the storage path: Web Storage is read now, an async adapter in the background, and anything unusable means memory.
  #setUpStorage(storage) {
    const keyTail = this.#settings.ingestKey.slice(-12)

    if (storage && !isUsableStorage(storage)) this.#warnOnce('storage_shape', 'storage needs getItem, setItem and removeItem; unsent events stay in memory')
    this.#storage = isUsableStorage(storage) ? storage : null

    if (isWebStorage(this.#storage)) {
      this.#storageKey = `${STORAGE_PREFIX}${keyTail}:${newEventId()}`
      this.#adoptStoredOutboxes()
    } else if (this.#storage) {
      this.#isAsyncStorage = true
      this.#isStorageLoaded = false
      this.#storageKey = `${STORAGE_PREFIX}${keyTail}`
      this.#storageLoad = this.#loadAsyncOutbox()
    }
  }

  // Merges every stored outbox of this key (earlier page loads, closed tabs) into this one and deletes them; any key's outbox older than 30 days goes too.
  #adoptStoredOutboxes() {
    try {
      const keyPrefix = `${STORAGE_PREFIX}${this.#settings.ingestKey.slice(-12)}:`
      const storedKeys = storageKeys(this.#storage).filter((storageKey) => storageKey.startsWith(STORAGE_PREFIX))

      // Read each stored outbox, skipping anything unreadable; this key's are adopted, stale ones of any key deleted.
      for (const storedKey of storedKeys) {
        const { savedAt, lines } = readStoredOutbox(this.#storage.getItem(storedKey))
        const isOwn = storedKey.startsWith(keyPrefix)

        if (isOwn) lines.forEach((line) => this.#outbox.push(outboxEntry(line)))
        if (isOwn || this.#now() - savedAt > STALE_OUTBOX_MS) this.#storage.removeItem(storedKey)
      }

      this.#settleOutbox()
      this.#persist()
    } catch (error) {
      this.#warnOnce('storage_read', `could not read stored events: ${error}`)
    }
  }

  // Reads the async storage's outbox and retry pause, puts the stored events ahead of anything tracked meanwhile, and saves the merge.
  async #loadAsyncOutbox() {
    let storedLineCount = 0

    try {
      const { lines, pausedUntilMs, failureCount } = readStoredOutbox(await this.#storage.getItem(this.#storageKey))
      storedLineCount = lines.length

      // An opt-out while loading deletes the stored events instead of adopting them.
      if (this.#shouldDiscardStoredOutbox || !this.#isEnabled) {
        this.#isStorageLoaded = true
        await this.#storage.removeItem(this.#storageKey)
        return
      }

      // Stored events are older, so they go first.
      this.#outbox = [...lines.map((line) => outboxEntry(line)), ...this.#outbox]
      this.#settleOutbox()

      // A backoff or 401 pause from the last launch still holds, within the longest Retry-After.
      const nowMs = this.#now()
      this.#pausedUntilMs = Math.max(this.#pausedUntilMs, Math.min(pausedUntilMs, nowMs + RETRY_POLICY.maximumRetryAfterMs))
      this.#failureCount = Math.max(this.#failureCount, failureCount)
    } catch (error) {
      this.#warnOnce('storage_read', `could not read stored events: ${error}`)
    }

    // Save the merged outbox, and send what the last launch left behind.
    this.#isStorageLoaded = true
    if (storedLineCount > 0 || this.#outbox.length > 0) this.#persist()
    if (storedLineCount > 0) this.#scheduleFlush(0)
  }

  // Keeps one copy of each event (it can sit in two stored outboxes), recounts the bytes and applies the caps.
  #settleOutbox() {
    const seenEventIds = new Set()

    this.#outbox = this.#outbox.filter((entry) => !seenEventIds.has(entry.eventId) && seenEventIds.add(entry.eventId))
    this.#outboxBytes = this.#outbox.reduce((sum, entry) => sum + entry.bytes, 0)
    this.#trimOutbox()
  }

  // Persists soon: Web Storage after the current turn's calls, an async storage at most once a second.
  #schedulePersist() {
    if (!this.#storage) return

    // 10,000 track() calls in one turn write Web Storage once, not 10,000 times.
    if (!this.#isAsyncStorage) {
      if (this.#isPersistQueued) return

      this.#isPersistQueued = true
      queueMicrotask(() => {
        this.#isPersistQueued = false
        this.#persist()
      })
      return
    }

    // An async storage write is slower, so arrivals within a second share one write.
    if (this.#persistTimer !== null) return

    this.#persistTimer = this.#timers.setTimeout(() => {
      this.#persistTimer = null
      this.#persist()
    }, ASYNC_PERSIST_DELAY_MS)
    this.#persistTimer?.unref?.()
  }

  // Persists at once, skipping any pending debounce; resolves when an async write is done.
  #persistNow() {
    if (this.#persistTimer !== null) this.#timers.clearTimeout(this.#persistTimer)
    this.#persistTimer = null

    return this.#persist()
  }

  // Writes the outbox with its save time, or removes it when empty; a write over the quota is skipped until the outbox shrinks.
  #persist() {
    if (!this.#storage) return undefined
    if (this.#isAsyncStorage) return this.#writeAsyncOutbox()

    try {
      if (this.#outbox.length === 0) this.#storage.removeItem(this.#storageKey)
      else if (this.#outboxBytes < this.#failedPersistBytes) this.#storage.setItem(this.#storageKey, JSON.stringify({ savedAt: this.#now(), lines: this.#outbox.map((entry) => entry.line) }))
    } catch (error) {
      this.#failedPersistBytes = this.#outboxBytes
      this.#warnOnce('storage_write', `could not store unsent events, keeping them in memory: ${error}`)
    }

    return undefined
  }

  // Writes the outbox and retry pause to an async storage, one write at a time, each with the latest state.
  #writeAsyncOutbox() {
    // Before the stored outbox is merged, a write would overwrite it; the load saves the merge itself.
    if (!this.#isStorageLoaded) return this.#storageLoad

    // A write already running writes again when it ends, so the last state always lands last.
    if (this.#isWriteRunning) {
      this.#isWriteAgainNeeded = true
      return this.#runningWrite
    }

    this.#isWriteRunning = true
    this.#runningWrite = (async () => {
      try {
        do {
          this.#isWriteAgainNeeded = false
          await this.#writeAsyncOutboxOnce()
        } while (this.#isWriteAgainNeeded)
      } catch (error) {
        this.#failedPersistBytes = this.#outboxBytes
        this.#warnOnce('storage_write', `could not store unsent events, keeping them in memory: ${error}`)
      } finally {
        this.#isWriteRunning = false
      }
    })()

    return this.#runningWrite
  }

  // One async write: the record with its save time, retry pause and lines, or a removal when nothing waits.
  async #writeAsyncOutboxOnce() {
    if (this.#outbox.length === 0) {
      await this.#storage.removeItem(this.#storageKey)
      return
    }

    if (this.#outboxBytes >= this.#failedPersistBytes) return

    const storedRecord = { savedAt: this.#now(), pausedUntilMs: this.#pausedUntilMs, failureCount: this.#failureCount, lines: this.#outbox.map((entry) => entry.line) }
    await this.#storage.setItem(this.#storageKey, JSON.stringify(storedRecord))
  }

  // Warns about a missing key, or a secret key anywhere but a server.
  #warnAboutKey() {
    if (this.#settings.ingestKey === '') this.#warnOnce('missing_key', 'no ingestKey was given; nothing will be sent')

    if (this.#settings.ingestKey.startsWith('sdl_sec_') && this.#runtime !== 'node') {
      this.#warnOnce('secret_key', 'a secret key (sdl_sec_) is in a page or app; use a public key (sdl_pub_) outside servers')
    }
  }

  // Logs one warning per kind, so a broken setup never floods the console.
  #warnOnce(kind, message) {
    if (this.#warnedKinds.has(kind)) return

    this.#warnedKinds.add(kind)
    this.#logger?.warn?.(`[simpledatalogs] ${message}`)
  }
}

/** The wait before the next attempt: full jitter under 1 s · 2^(n-1), capped at 5 min, at least 250 ms and never under Retry-After. */
export function retryDelayMs(failureCount, retryAfterMs, jitterFraction) {
  // Cap the exponent so the doubling can never overflow.
  const doublingCount = Math.min(Math.max(failureCount - 1, 0), 30)
  const ceilingMs = Math.min(RETRY_POLICY.maximumMs, RETRY_POLICY.initialMs * 2 ** doublingCount)

  // Full jitter picks uniformly under the ceiling, then the floor and Retry-After apply.
  const clampedFraction = Math.min(Math.max(jitterFraction, 0), 1)
  return honorRetryAfter(Math.max(RETRY_POLICY.minimumMs, ceilingMs * clampedFraction), retryAfterMs)
}

/** Milliseconds from a Retry-After header (delay-seconds or an HTTP-date), or null when absent or unreadable. */
export function parseRetryAfterMs(headerValue, nowMs) {
  const trimmedValue = typeof headerValue === 'string' ? headerValue.trim() : ''
  if (trimmedValue === '') return null

  // delay-seconds is a bare non-negative integer.
  if (/^\d+$/.test(trimmedValue)) return Number(trimmedValue) * 1000

  // An HTTP-date in the past means retry now.
  const retryAtMs = Date.parse(trimmedValue)
  return Number.isNaN(retryAtMs) ? null : Math.max(0, retryAtMs - nowMs)
}

// Treats Retry-After as a floor over the delay, within a sane bound.
function honorRetryAfter(delayMs, retryAfterMs) {
  return retryAfterMs === null ? delayMs : Math.max(delayMs, Math.min(retryAfterMs, RETRY_POLICY.maximumRetryAfterMs))
}

// Resolves after the current event-loop turn in Node; browsers pool connections themselves, so there it resolves at once.
function yieldToEventLoop() {
  return new Promise((resolve) => (typeof globalThis.setImmediate === 'function' ? globalThis.setImmediate(resolve) : resolve()))
}

// Reads and discards an answer body; a failure here never changes the outcome, which the status decides.
async function drainBody(response) {
  try {
    if (typeof response?.arrayBuffer === 'function') await response.arrayBuffer()
  } catch {
    // The status already arrived; an unreadable body is ignored.
  }
}

// One outbox entry: the encoded event, its UTF-8 size and its id.
function outboxEntry(line) {
  let eventId = null

  try {
    eventId = JSON.parse(line).event_id ?? null
  } catch {
    eventId = null
  }

  return { line, bytes: utf8Encoder.encode(line).length, eventId: eventId ?? newEventId() }
}

/** A random UUID (version 4) for event_id; works outside secure contexts too. */
export function newEventId() {
  const randomBytes = new Uint8Array(16)

  // Prefer the platform's CSPRNG; fall back to Math.random only where there is none.
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(randomBytes)
  else randomBytes.forEach((_, index) => (randomBytes[index] = Math.floor(Math.random() * 256)))

  // Set the version (4) and variant (10xx) bits.
  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80

  const hexText = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hexText.slice(0, 8)}-${hexText.slice(8, 12)}-${hexText.slice(12, 16)}-${hexText.slice(16, 20)}-${hexText.slice(20)}`
}

// A trimmed identity string, or null for anything empty or not a string or number.
function cleanIdentity(identity) {
  if (typeof identity !== 'string' && typeof identity !== 'number') return null

  const identityText = String(identity).trim()
  return identityText === '' ? null : identityText
}

// The options among allowedNames that are set.
function pickDefined(options, allowedNames) {
  return Object.fromEntries(allowedNames.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]))
}

// A stored outbox's save time, lines and retry pause; the older bare-array form reads as saved now, and anything unreadable as empty.
function readStoredOutbox(storedText) {
  try {
    const storedValue = typeof storedText === 'string' ? JSON.parse(storedText) : (storedText ?? [])
    const isBareArray = Array.isArray(storedValue)
    const lines = isBareArray ? storedValue : Array.isArray(storedValue?.lines) ? storedValue.lines : []
    const savedAt = isBareArray || typeof storedValue?.savedAt !== 'number' ? Date.now() : storedValue.savedAt

    return {
      savedAt,
      lines: lines.filter((line) => typeof line === 'string'),
      pausedUntilMs: Number.isFinite(storedValue?.pausedUntilMs) ? storedValue.pausedUntilMs : 0,
      failureCount: Number.isInteger(storedValue?.failureCount) && storedValue.failureCount > 0 ? storedValue.failureCount : 0,
    }
  } catch {
    return { savedAt: Date.now(), lines: [], pausedUntilMs: 0, failureCount: 0 }
  }
}

// Every key in a Web Storage object.
function storageKeys(storage) {
  return Array.from({ length: storage.length ?? 0 }, (_, index) => storage.key(index)).filter((storageKey) => typeof storageKey === 'string')
}
