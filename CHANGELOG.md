# Changelog

All notable changes to the `simpledatalogs` npm package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [0.5.0] - Unreleased

### Added

- Async storage for the outbox: `storage` accepts an adapter whose `getItem`, `setItem` and `removeItem` return Promises, such as React Native's AsyncStorage. The stored outbox loads in the background and is merged ahead of events tracked meanwhile; writes are debounced to once a second and happen at once on background, crash and shutdown. The retry pause is stored too, so a relaunch keeps backing off.
- `chromeStorageAdapter(chrome.storage.local)`, and an extension's service worker uses `chrome.storage.local` by default when it has the `storage` permission.
- Runtime detection: a page, a worker (an extension's service worker), React Native and Node each get their own defaults. The `runtime` getter says which one is in use; the `runtime` option overrides it.
- React Native mode: `appState: AppState` or `handleAppStateChange(state)` flushes and saves on `background`; with `autocapture`, a session starts at launch and a new one after 30 minutes in the background (`session_end` is stamped when the app left the foreground).
- `defaultProperties` option and `setDefaultProperties(props)`: props merged into every event, log line and exception; the event's own props win.
- `track(name, props, { eventId, ts })` and `log(level, message, props, { eventId, ts })`: a caller's UUID `event_id` for idempotent re-sends, and a past `ts` (Date, epoch ms or ISO text) within the last 10 years.
- `captureException(error, { props, handled, fingerprint })` sends the ingest API's `kind: "exception"` object with stack frames parsed from V8, JavaScriptCore, Firefox and Hermes stacks; the `release` option is sent with it.
- `installGlobalHandlers()`: uncaught errors and unhandled rejections as unhandled exceptions, on `window`, a worker scope, React Native's `ErrorUtils` (the previous handler is chained; a fatal error waits up to 1 s for the flush) or Node's process (exit code 1 after up to 2 s when nothing else listens).
- `respectDoNotTrack: true` makes Do Not Track and Global Privacy Control an opt-out for every send, manual calls included.
- TypeScript declarations (`index.d.ts`), referenced from `types` and the `exports` map; a `main` field for older bundlers.

### Changed

- A worker flushes every 10 seconds instead of 30, since an extension's service worker is stopped after 30 idle seconds.
- Workers and React Native send no `User-Agent` header, leaving it to the platform; only Node sends `simpledatalogs-js/<version>`.
- The secret key warning covers workers and React Native, not only web pages.
- `npx simpledatalogs init` for Expo wires `AppState` and autocapture sessions.

## [0.4.0] - Unreleased

### Added

- `data-track` clicks: an element with `data-track="signup"` sends that event when clicked, with its `data-track-*` attributes as props and the page path (autocapture flag `trackedClicks`, on by default).

### Changed

- The script tag runs in web mode: no cookies and no browser storage. Events wait in memory and go out on page hide; sessions are counted by the server, so no `session_start`, `session_end` or `session_id` is sent. `data-storage="true"` brings back the stored outbox and tab sessions.
- The script tag sends outbound clicks by default; `data-outbound-links="false"` turns them off.
- Without sessions, only the first page view of a page load carries the referrer and UTM tags.
- The first batch after the client starts goes out after 1 second instead of 30, so a new setup shows its first event at once; later batches keep the 30-second interval.

## [0.3.0] - 2026-10-19

The first public release.

### Added

- `createClient()` / `init()` for browsers and Node: `track()`, `log()`, `setDeviceId()`, `setSessionId()`, `setEnabled()`, `flush()` and `shutdown()`.
- A stored outbox (`localStorage` in browsers, memory in Node) with batching, retries with jittered backoff, `Retry-After`, 401 pauses, 413 splitting and 415 drops.
- A `keepalive` send on page hide.
- Opt-in autocapture of page views, sessions, errors, outbound clicks and Node uncaught exceptions, respecting Do Not Track and Global Privacy Control.
- A drop-in script tag build, `dist/simpledatalogs.min.js`, configured by `data-*` attributes.
- `npx simpledatalogs init`, which detects the framework, shows a diff, writes the snippet and sends a test event.
