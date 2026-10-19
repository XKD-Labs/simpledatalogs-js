# Changelog

All notable changes to the `simpledatalogs` npm package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

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
