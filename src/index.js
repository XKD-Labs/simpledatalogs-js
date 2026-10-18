/** simpledatalogs for browsers and Node: batches events and log lines to the ingest API and never blocks or breaks the host. */

import { resolveAutocaptureFlags, startAutocapture } from './autocapture.js'

/** This SDK's version, sent in the User-Agent where the runtime allows one. */
export const SDK_VERSION = '0.3.1'

/** The production ingest host. */
export const DEFAULT_ENDPOINT = 'https://edge.simpledatalogs.com'

// The ingest API sender defaults; the first batch goes after 1 s so a new setup shows data at once, then every 30 s or at 50 events, requests stay under 256 KB.
const DEFAULT_SETTINGS = {
  endpoint: DEFAULT_ENDPOINT,
  firstFlushDelayMs: 1_000,
  flushIntervalMs: 30_000,
  maxBatchEvents: 50,
  maxRequestBytes: 256_000,
  maxKeepaliveBytes: 60_000,
  maxOutboxEvents: 1_000,
  maxOutboxBytes: 2_000_000,
  requestTimeoutMs: 15_000,
}

// Backoff with full jitter from 1 s to 5 min, Retry-After as a floor, and slow re-probes after a 401.
const RETRY_POLICY = {
  initialMs: 1_000,
  maximumMs: 300_000,
  minimumMs: 250,
  maximumRetryAfterMs: 3_600_000,
  invalidKeyFirstProbeMs: 60_000,
  invalidKeyProbeMs: 600_000,
}

// Every outbox in browser storage starts with this, one per page load, so tabs never overwrite each other.
const STORAGE_PREFIX = 'simpledatalogs:outbox:'

// A stored outbox this old is deleted whatever key wrote it, so a rotated key's leftovers never fill the origin's quota.
const STALE_OUTBOX_MS = 30 * 24 * 3_600_000

// Prop values the ingest API accepts.
const PROP_VALUE_TYPES = new Set(['string', 'number', 'boolean'])

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
  #storage
  #storageKey
  #shouldSendUserAgent
  #pageTargets
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
  #stopAutocapture = () => {}

  /** Reads the options, adopts any outbox a closed page left behind, and listens for page hide. */
  constructor(options = {}) {
    // Trim copy-paste whitespace from the key; without one, nothing is ever sent.
    this.#settings = { ...DEFAULT_SETTINGS, ...pickDefined(options, Object.keys(DEFAULT_SETTINGS)) }
    this.#settings.ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey.trim() : ''
    this.#currentMaxBatchEvents = this.#settings.maxBatchEvents
    this.#ingestUrl = `${String(this.#settings.endpoint).replace(/\/+$/, '')}/v1/ingest`

    // Runtime hooks, injectable for tests and unusual hosts.
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
    this.#now = options.now ?? (() => Date.now())
    this.#random = options.random ?? Math.random
    this.#timers = options.timers ?? { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }
    this.#logger = options.logger === undefined ? globalThis.console : options.logger
    this.#shouldSendUserAgent = options.sendUserAgent ?? typeof globalThis.document === 'undefined'
    this.#deviceId = cleanIdentity(options.deviceId)
    this.#userId = cleanIdentity(options.userId)

    // Warn about keys that can't work, but keep running so the host never breaks.
    this.#warnAboutKey()

    // Browser storage keeps unsent events across reloads; Node keeps them in memory.
    this.#storage = options.storage === undefined ? defaultStorage() : options.storage
    this.#storageKey = `${STORAGE_PREFIX}${this.#settings.ingestKey.slice(-12)}:${newEventId()}`
    this.#adoptStoredOutboxes()

    // Flush on page hide in browsers, unless the host opts out.
    this.#pageTargets = options.pageTargets === undefined ? defaultPageTargets() : options.pageTargets
    this.#listenForPageHide()

    // Send whatever a previous page load left behind.
    if (this.#outbox.length > 0) this.#scheduleFlush(0)

    // Automatic capture is opt-in: `autocapture: true` or an object of flags.
    this.#startAutocapture(options)
  }

  /** Records an event with optional props, and an optional `{ timestamp }` for when it happened; never throws. */
  track(eventName, props, trackOptions) {
    this.#guard(() => {
      if (typeof eventName !== 'string' || eventName.trim() === '') {
        this.#warnOnce('event_name', 'track() needs a non-empty event name; the event was skipped')
        return
      }

      this.#enqueue({ event: eventName.trim(), ...this.#baseFields(trackOptions?.timestamp), ...this.#propsField(props) })
    })
  }

  /** Records a log line with a level (debug, info, notice, warning, error, critical) and optional props; never throws. */
  log(level, message, props) {
    this.#guard(() => {
      const levelText = typeof level === 'string' ? level.trim().toLowerCase() : ''

      this.#enqueue({
        ...this.#baseFields(),
        ...(levelText === '' ? {} : { level: levelText }),
        message: message instanceof Error ? `${message.name}: ${message.message}` : String(message ?? ''),
        ...this.#propsField(props),
      })
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

      // Stop the timer and forget everything not yet delivered.
      this.#cancelFlushTimer()
      this.#outbox = []
      this.#outboxBytes = 0
      this.#persist()
    })
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

  /** Flushes once more, then stops timers and listeners; events tracked later are ignored. */
  async shutdown() {
    await this.flush()
    this.#isShutDown = true
    this.#cancelFlushTimer()
    this.#removePageListeners()
    this.#stopAutocapture()
    this.#persist()
  }

  // Starts the opt-in autocapture features; a failure there never breaks the client.
  #startAutocapture(options) {
    const flags = resolveAutocaptureFlags(options.autocapture)
    if (flags === null) return

    try {
      this.#stopAutocapture = startAutocapture(this, flags, {
        pageTargets: this.#pageTargets,
        processTarget: options.processTarget === undefined ? defaultProcessTarget() : options.processTarget,
        sessionStorage: options.sessionStorage,
        now: this.#now,
        timers: this.#timers,
        logger: this.#logger,
      })
    } catch (error) {
      this.#warnOnce('autocapture', `autocapture could not start: ${error}`)
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

  // The id, time and identity fields every event carries, set when it happens (or at the given timestamp).
  #baseFields(timestamp) {
    const happenedAt = timestamp instanceof Date || Number.isFinite(timestamp) ? new Date(timestamp) : new Date(this.#now())
    const happenedAtMs = Number.isNaN(happenedAt.getTime()) ? this.#now() : happenedAt.getTime()

    return {
      event_id: newEventId(),
      ts: new Date(happenedAtMs).toISOString(),
      ...(this.#deviceId === null ? {} : { device_id: this.#deviceId }),
      ...(this.#userId === null ? {} : { user_id: this.#userId }),
      ...(this.#sessionId === null ? {} : { session_id: this.#sessionId }),
    }
  }

  // Keeps only string, finite number and boolean props, warning once about the rest.
  #propsField(props) {
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

    return Object.keys(keptProps).length === 0 ? {} : { props: keptProps }
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

  // Sends batches until nothing unsent is left, a send fails, or sending is paused.
  async #flushUntilEmpty() {
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
      return 'failed'
    }

    // Anything else (408, 429, 503, other statuses) wasn't stored: back off and retry.
    this.#backOff(retryAfterMs)
    return 'failed'
  }

  // Pauses sending for a full-jitter backoff that is never shorter than Retry-After.
  #backOff(retryAfterMs) {
    this.#failureCount += 1
    this.#pausedUntilMs = this.#now() + retryDelayMs(this.#failureCount, retryAfterMs, this.#random())
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
      if (documentTarget?.visibilityState === 'hidden') this.#flushOnPageHide()
    }

    windowTarget?.addEventListener?.('pagehide', onPageHide)
    documentTarget?.addEventListener?.('visibilitychange', onVisibilityChange)

    this.#removePageListeners = () => {
      windowTarget?.removeEventListener?.('pagehide', onPageHide)
      documentTarget?.removeEventListener?.('visibilitychange', onVisibilityChange)
    }
  }

  // Merges every stored outbox of this key (earlier page loads, closed tabs) into this one and deletes them; any key's outbox older than 30 days goes too.
  #adoptStoredOutboxes() {
    if (!this.#storage) return

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

      // The same event can sit in two stored outboxes; keep one copy.
      const seenEventIds = new Set()
      this.#outbox = this.#outbox.filter((entry) => !seenEventIds.has(entry.eventId) && seenEventIds.add(entry.eventId))
      this.#outboxBytes = this.#outbox.reduce((sum, entry) => sum + entry.bytes, 0)
      this.#trimOutbox()
      this.#persist()
    } catch (error) {
      this.#warnOnce('storage_read', `could not read stored events: ${error}`)
    }
  }

  // Persists once after the current turn's calls, so 10,000 track() calls write storage once, not 10,000 times.
  #schedulePersist() {
    if (!this.#storage || this.#isPersistQueued) return

    this.#isPersistQueued = true
    queueMicrotask(() => {
      this.#isPersistQueued = false
      this.#persist()
    })
  }

  // Writes the outbox with its save time, or removes it when empty; a write over the quota is skipped until the outbox shrinks.
  #persist() {
    if (!this.#storage) return

    try {
      if (this.#outbox.length === 0) this.#storage.removeItem(this.#storageKey)
      else if (this.#outboxBytes < this.#failedPersistBytes) this.#storage.setItem(this.#storageKey, JSON.stringify({ savedAt: this.#now(), lines: this.#outbox.map((entry) => entry.line) }))
    } catch (error) {
      this.#failedPersistBytes = this.#outboxBytes
      this.#warnOnce('storage_write', `could not store unsent events, keeping them in memory: ${error}`)
    }
  }

  // Warns about a missing key, or a secret key in a browser.
  #warnAboutKey() {
    if (this.#settings.ingestKey === '') this.#warnOnce('missing_key', 'no ingestKey was given; nothing will be sent')

    if (this.#settings.ingestKey.startsWith('sdl_sec_') && typeof globalThis.document !== 'undefined') {
      this.#warnOnce('secret_key', 'a secret key (sdl_sec_) is in a web page; use a public key (sdl_pub_) in browsers')
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

// A stored outbox's save time and lines; the older bare-array form reads as saved now, and anything unreadable as empty.
function readStoredOutbox(storedText) {
  try {
    const storedValue = JSON.parse(storedText ?? '[]')
    const isBareArray = Array.isArray(storedValue)
    const lines = isBareArray ? storedValue : Array.isArray(storedValue?.lines) ? storedValue.lines : []
    const savedAt = isBareArray || typeof storedValue?.savedAt !== 'number' ? Date.now() : storedValue.savedAt

    return { savedAt, lines: lines.filter((line) => typeof line === 'string') }
  } catch {
    return { savedAt: Date.now(), lines: [] }
  }
}

// Every key in a Web Storage object.
function storageKeys(storage) {
  return Array.from({ length: storage.length ?? 0 }, (_, index) => storage.key(index)).filter((storageKey) => typeof storageKey === 'string')
}

// localStorage in browsers, when it is usable (private modes may throw); none in Node.
function defaultStorage() {
  if (typeof globalThis.document === 'undefined') return null

  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// The Node process, for opt-in crash capture; none in browsers.
function defaultProcessTarget() {
  const processTarget = globalThis.process
  return typeof globalThis.document === 'undefined' && typeof processTarget?.on === 'function' ? processTarget : null
}

// window and document in browsers; none in Node.
function defaultPageTargets() {
  return typeof globalThis.document === 'undefined' ? null : { window: globalThis, document: globalThis.document }
}
