// Type declarations for the simpledatalogs package, written by hand to match src/index.js.

/** A prop value the ingest API accepts. */
export type PropValue = string | number | boolean

/** Props on an event, log line or exception; other value types are skipped with a warning. */
export type Props = Record<string, PropValue>

/** A log line's level. */
export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical'

/** Where the client runs; detected unless the `runtime` option names one. */
export type Runtime = 'browser' | 'worker' | 'react-native' | 'node'

/** A React Native app state, as `AppState` reports it. */
export type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown' | 'extension' | (string & {})

/** A synchronous Web Storage such as `localStorage`; one outbox per page load, so tabs never overwrite each other. */
export interface WebStorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** An async storage adapter such as React Native's AsyncStorage or `chromeStorageAdapter(chrome.storage.local)`. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null | undefined> | string | null | undefined
  setItem(key: string, value: string): Promise<unknown> | unknown
  removeItem(key: string): Promise<unknown> | unknown
}

/** An extension storage area, `chrome.storage.local` or `browser.storage.local`. */
export interface ExtensionStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<unknown>
  remove(key: string): Promise<unknown>
}

/** React Native's `AppState` module, or anything with the same change events. */
export interface AppStateLike {
  readonly currentState?: AppStateValue | null
  addEventListener(type: 'change', listener: (state: AppStateValue) => void): { remove(): void } | void
  removeEventListener?(type: 'change', listener: (state: AppStateValue) => void): void
}

/** The features `autocapture` turns on; `true` means the defaults. */
export interface AutocaptureFlags {
  /** `page_view` on load and on SPA route changes (browser). Default on. */
  pageViews?: boolean
  /** Tab sessions in a browser, app-state sessions in React Native. Default on. */
  sessions?: boolean
  /** Uncaught errors and rejections as `error` log lines (browser). Default on. */
  errors?: boolean
  /** `outbound_click` for links to other hosts (browser). Default off. */
  outboundLinks?: boolean
  /** Clicks on `data-track` elements (browser). Default on. */
  trackedClicks?: boolean
  /** Node uncaught exceptions as `critical` log lines. Default on. */
  uncaughtExceptions?: boolean
  /** Do Not Track or Global Privacy Control turns automatic capture off. Default on. */
  respectDoNotTrack?: boolean
}

/** Options for createClient; init() takes the same with `key` as a short form of `ingestKey`. */
export interface ClientOptions {
  /** Your `sdl_pub_…` or `sdl_sec_…` key; without one nothing is sent. */
  ingestKey?: string
  /** The ingest host; `/v1/ingest` is added. */
  endpoint?: string
  deviceId?: string | number | null
  userId?: string | number | null
  /** Props merged into every event, log line and exception; the event's own props win. */
  defaultProperties?: Props
  /** Your app's release, sent with exceptions. */
  release?: string | null
  /** `true` or flags; off by default. */
  autocapture?: boolean | AutocaptureFlags
  /** With `true`, Do Not Track or Global Privacy Control turns off every send, your own calls too. Default false. */
  respectDoNotTrack?: boolean
  /** Where unsent events wait: localStorage in a page, chrome.storage.local in an extension worker, else memory; `null` keeps them in memory. */
  storage?: WebStorageLike | AsyncStorageLike | null
  /** React Native's `AppState`: flushes on background and renews sessions. */
  appState?: AppStateLike
  /** `'auto'` (default) adds `app_state` and `engaged_ms` to events tracked now in pages and React Native apps; `'off'` sends neither. */
  activity?: 'auto' | 'off'
  /** Overrides runtime detection. */
  runtime?: Runtime
  /** Whether to send `simpledatalogs-js/<version>` as the User-Agent; default true in Node only. */
  sendUserAgent?: boolean
  /** Where warnings go; `null` silences them. */
  logger?: { warn?(message: string): void; error?(value: unknown): void } | null
  firstFlushDelayMs?: number
  /** Default 30000, or 10000 in a worker. */
  flushIntervalMs?: number
  maxBatchEvents?: number
  maxRequestBytes?: number
  maxKeepaliveBytes?: number
  maxOutboxEvents?: number
  maxOutboxBytes?: number
  requestTimeoutMs?: number
  /** Runtime hooks for tests and unusual hosts. */
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
  timers?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void }
  globalScope?: object
  pageTargets?: { window?: object; document?: object } | null
  processTarget?: object | null
  sessionStorage?: WebStorageLike | null
}

/** init() options: `key` is the short form of `ingestKey`. */
export interface InitOptions extends ClientOptions {
  key?: string
}

/** Per-event options for idempotent re-sends and past events. */
export interface EventOptions {
  /** A UUID you keep, so a re-send of the same event is counted once. */
  eventId?: string
  /** When it happened: a Date, epoch milliseconds or ISO 8601 text within the last 10 years. */
  ts?: Date | number | string
  /** The older name of `ts`. */
  timestamp?: Date | number | string
}

/** Options for captureException. */
export interface ExceptionOptions extends EventOptions {
  props?: Props
  /** False for a crash nobody caught; default true. */
  handled?: boolean
  /** Your own grouping key, up to 128 characters. */
  fingerprint?: string
}

/** One ingest key's pipeline: an outbox kept until a 202, batched sends and retries. No method throws. */
export declare class SimpleDataLogsClient {
  constructor(options?: ClientOptions)
  /** Where the client runs. */
  readonly runtime: Runtime
  /** Events not yet confirmed by a 202. */
  readonly pendingCount: number
  track(eventName: string, props?: Props | null, eventOptions?: EventOptions): void
  log(level: LogLevel | (string & {}), message: unknown, props?: Props | null, eventOptions?: EventOptions): void
  captureException(error: unknown, exceptionOptions?: ExceptionOptions | null): void
  /** Sends uncaught errors and unhandled rejections as unhandled exceptions; returns the uninstall function. */
  installGlobalHandlers(): () => void
  /** For React Native: `background` flushes and saves, `active` may start a new session. */
  handleAppStateChange(state: AppStateValue): void
  /** Replaces the props merged into every event. */
  setDefaultProperties(props: Props | null): void
  setDeviceId(deviceId: string | number | null): void
  setUserId(userId: string | number | null): void
  setSessionId(sessionId: string | number | null): void
  /** `false` is an opt-out: it deletes every unsent event. */
  setEnabled(isEnabled: boolean): void
  /** Sends everything now; resolves when the attempt ends, never rejects. */
  flush(): Promise<void>
  /** Flushes once more, then stops timers and listeners. */
  shutdown(): Promise<void>
}

/** This SDK's version. */
export declare const SDK_VERSION: string

/** The production ingest host. */
export declare const DEFAULT_ENDPOINT: string

/** Creates a client; call once per ingest key. */
export declare function createClient(options?: ClientOptions): SimpleDataLogsClient

/** Creates a client from `{ key, autocapture }`. */
export declare function init(options?: InitOptions): SimpleDataLogsClient

/** A storage adapter over `chrome.storage.local` or `browser.storage.local`; a key prefix keeps a popup's outbox apart from the worker's. */
export declare function chromeStorageAdapter(storageArea: ExtensionStorageArea, keyPrefix?: string): AsyncStorageLike

/** A random UUID (version 4). */
export declare function newEventId(): string

/** The wait before the next attempt, in milliseconds. */
export declare function retryDelayMs(failureCount: number, retryAfterMs: number | null, jitterFraction: number): number

/** Milliseconds from a Retry-After header, or null. */
export declare function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number): number | null
