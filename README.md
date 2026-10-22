# simpledatalogs (JavaScript)

Sends events, log lines and exceptions to [simpledatalogs](https://simpledatalogs.com) from browsers, browser extensions, React Native and Node, following the [sender rules](https://simpledatalogs.com/docs/api/sender-rules).
One ES module, no dependencies, TypeScript types included. Full guide: [simpledatalogs.com/docs/sdks/javascript](https://simpledatalogs.com/docs/sdks/javascript).

## Install

```sh
npm install simpledatalogs
```

```js
import { createClient } from 'simpledatalogs'

const sdl = createClient({ ingestKey: 'sdl_pub_…' }) // endpoint defaults to https://edge.simpledatalogs.com; init({ key }) is the short form

sdl.track('signup', { plan: 'pro' })
sdl.log('error', 'Payment failed', { order_id: 7 })
sdl.captureException(error) // exception telemetry with stack frames
sdl.setDeviceId(anonymousId) // optional; unlocks "active devices"
```

## Event options

```js
const sdl = createClient({ ingestKey: 'sdl_pub_…', defaultProperties: { app_version: '1.4.0' } })

sdl.setDefaultProperties({ app_version: '1.4.0', distribution: 'store' }) // replaces the defaults
sdl.track('purchase', { order_id: 7 }, { eventId: storedUuid, ts: purchasedAt })
```

- **Default properties** are merged into every event, log line and exception; the event's own props win on a clash.
- **`eventId`** is a UUID you keep, so re-sending the same event (after an app restart, say) is counted once. Anything else is replaced with a new id and one warning.
- **`ts`** is when it happened: a `Date`, epoch milliseconds or ISO 8601 text within the last 10 years. Out of range, it becomes now with one warning. `{ timestamp }` still works.
- `log(level, message, props, { eventId, ts })` takes the same options.

## Exceptions

```js
try {
  await pay()
} catch (error) {
  sdl.captureException(error, { props: { order_id: 7 } }) // handled: true by default
}

sdl.installGlobalHandlers() // uncaught errors and rejections, as handled: false
```

- Sends the ingest API's `kind: "exception"` object: `type`, `message`, `handled`, `frames` (`file`, `line`, `function`, `in_app`), `fingerprint` when you pass one, `release` from the client option, identity and props.
- Stack strings from V8 (Chrome, Node), JavaScriptCore (Safari), Firefox and Hermes (React Native) are parsed into at most 50 frames, innermost first; query strings are dropped from files, and `node_modules`, `node:` and native frames are not `in_app`.
- `installGlobalHandlers()` listens on `window` or the worker scope, chains React Native's `ErrorUtils` handler (a fatal error waits up to 1 s for the flush, then goes to the previous handler), or watches Node's `uncaughtException` (exit code 1 after up to 2 s when nothing else listens). At most 5 copies of one message and 50 in all. It returns an uninstall function.
- Autocapture's `errors` flag sends browser errors as `error` log lines instead; use one of the two.

## React Native

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { init } from 'simpledatalogs'

export const sdl = init({ key: process.env.EXPO_PUBLIC_SIMPLEDATALOGS_KEY, storage: AsyncStorage, appState: AppState, autocapture: true })
sdl.installGlobalHandlers()
```

- Detected from `navigator.product === 'ReactNative'`: no browser autocapture, and no `User-Agent` header, so the platform's own is kept.
- `storage: AsyncStorage` keeps unsent events across launches (any adapter whose `getItem`, `setItem` and `removeItem` return Promises works). Without it the outbox is in memory.
- `appState: AppState` (or calling `sdl.handleAppStateChange(state)` yourself) flushes and saves on `background`. With `autocapture`, a session starts at launch and a new one when the app returns after 30 minutes in the background; a launch in the background starts none until the app is active.
- Use one public key per platform (an iOS and an Android deployment), picked with `Platform.OS`.
- Only JavaScript errors are visible; native crashes (Swift, Kotlin, C++, out-of-memory kills) never reach a JS-only sender.

## Browser extensions (Manifest V3)

- A service worker is detected as a worker, not Node: no `User-Agent` header, and a 10-second flush interval, since Chrome stops an idle worker after 30 seconds.
- With the `storage` permission, the outbox lives in `chrome.storage.local`, so events survive the worker being stopped. Popups and content scripts can opt in with `storage: chromeStorageAdapter(chrome.storage.local, 'popup:')`; the prefix keeps each context's outbox apart from the worker's.
- Use a public key (`sdl_pub_…`); the SDK warns about a secret key outside servers.

## Set up with one command

```sh
npx simpledatalogs init
```

It detects Next.js, Nuxt, SvelteKit, React or Vue on Vite, React Native/Expo, plain HTML, Node and Laravel, asks for the key (or takes `--key`), shows a diff of the few lines it adds, writes them only after you say yes, sends a `setup_test` event and prints the dashboard link.
Browser frameworks get the one-line autocapture; flags: `--framework`, `--endpoint`, `--app-url`, `--dashboard-url`, `--yes`, `--no-test`.

## Autocapture (opt-in, 0.3.0)

One option sends page views, sessions and errors without any `track()` call:

```js
import { init } from 'simpledatalogs'

const sdl = init({ key: 'sdl_pub_…', autocapture: true })
```

| Flag | `autocapture: true` | What it sends |
|---|---|---|
| `pageViews` | on | `page_view` on load and on every SPA route change (`pushState`, `replaceState`, `popstate`, `hashchange`) that changes the path; props `path` (no query), `title`, and on a session's first page view `referrer`, `referrer_host` and `utm_*` |
| `sessions` | on | `session_start`, a `session_id` on every event, and `session_end` (props `duration_s`, `page_views`, stamped at the last activity) after 30 idle minutes |
| `errors` | on | Uncaught errors and unhandled rejections as `error` log lines with `stack`, `file`, `line`, `path`; at most 5 per message and 50 per page |
| `outboundLinks` | off | `outbound_click` with `url` (no query) and `host` for links to other hosts |
| `trackedClicks` | on | A click on an element with `data-track="name"` sends that event, with its `data-track-*` attributes as props and `path` |
| `uncaughtExceptions` | on (Node) | A `critical` log line, a flush of up to 2 s, then exit code 1 as Node would; with other listeners it only sends |
| `respectDoNotTrack` | on | With Do Not Track or Global Privacy Control on, nothing is captured automatically; your own calls still go |

Pass an object for finer control: `autocapture: { errors: false, outboundLinks: true }`.
- **No cookies.** The session id lives in the tab's `sessionStorage` (memory when blocked), so each tab has its own session and a closed tab's session has no `session_end`; its last event marks the end. Device and user ids stay yours to set.
- `setSessionId(id)` sets the session id yourself.
- **Do Not Track:** only automatic capture honours Do Not Track and Global Privacy Control by default; your own `track()`, `log()` and `captureException()` calls still go. Pass `respectDoNotTrack: true` to the client to make it an opt-out for every send (unsent events are deleted, as with `setEnabled(false)`; `setEnabled(true)` overrides it).

## Script tag

One minified file (`dist/simpledatalogs.min.js`, ~9 KB gzipped) for sites without a bundler. The tag is the opt-in, so autocapture is on, in **web mode**: no cookies and no browser storage, so no consent banner is needed for it.

```html
<script src="https://cdn.jsdelivr.net/npm/simpledatalogs@0.5.0/dist/simpledatalogs.min.js" data-key="sdl_pub_…" defer></script>
```

- unpkg works too: `https://unpkg.com/simpledatalogs@0.5.0/dist/simpledatalogs.min.js`.
- Attributes: `data-key` (required), `data-endpoint`, `data-autocapture="false"` (manual calls only), `data-outbound-links="false"`, `data-storage="true"` (a stored outbox and tab sessions, as in the npm package).
- Visitors and visits are counted by the server from a daily-rotating hash, so the page sends only page views, clicks and errors; events wait in memory and go out on page hide.
- Clicks: `<button data-track="signup" data-track-plan="pro">` sends `signup` with `plan` and the page path.
- Your own calls: `simpledatalogs.track('signup')`, `simpledatalogs.log('error', 'boom')`.
- Build it with `npm ci && npm run build`; `dist/` is committed so tests and the CDN see the same file.

## Rules it follows

- **Ids and times:** every event gets a UUID `event_id` and a `ts` when it happens, so retries never count twice.
- **Batching:** a request goes out every 30 s, or at once at 50 events; each stays under 256 KB.
- **Outbox:** an event leaves only after a `202`. In browsers it is kept in `localStorage`, so a reload or a closed tab sends it on the next page load; an extension's worker uses `chrome.storage.local`, React Native the async storage you pass, and Node keeps it in memory.
- **Bounded on purpose:** browser storage is small and shared with your page, so the outbox holds at most 1,000 events or 2 MB (`maxOutboxEvents`, `maxOutboxBytes`). Only when that fills (for example a revoked key for hours) are the oldest unsent events dropped, with a warning. A single event over 256 KB can never be accepted and is dropped on `413`.
- **Answers:** other statuses and network errors back off with full jitter from 1 s to 5 min, never sooner than `Retry-After`; `401` keeps the outbox and re-checks the key after 1 min, then every 10 min; `413` halves the batch and each `202` doubles it back to 50; `415` drops the batch with one warning (never resent unchanged).
- **Light on the page (0.2.0):** `track()` never writes storage itself; the outbox is saved once per turn of the event loop, and after a quota error it is not written again until it shrinks. Page hide sends one `keepalive` request at a time. A stored outbox older than 30 days is deleted whatever key wrote it, so a rotated key's leftovers never fill the origin's storage.
- **Page hide:** on `pagehide` or a hidden tab, one `fetch` with `keepalive` sends up to 60 KB. Anything unconfirmed stays stored and is resent later; `event_id` dedupes it.
- **Light:** one file (~9 KB gzipped), no dependencies; `track()` only queues. In Node, batches of a flush go one at a time over one reused keep-alive connection (tested against a real server).
- **Fails open:** no call throws; problems are logged once each with `console.warn`.
- **Opt-out:** `sdl.setEnabled(false)` deletes every unsent event and ignores new ones until `setEnabled(true)`.
- **Node:** `await sdl.shutdown()` before the process exits. Use a secret key (`sdl_sec_…`) on servers, never in a web page.

Props must be strings, finite numbers or booleans; other values are skipped with a warning.

## TypeScript

Types ship in `index.d.ts` (`ClientOptions`, `EventOptions`, `ExceptionOptions`, `AsyncStorageLike` and the client's methods); nothing to install.

## Development

```sh
npm ci
npm test
```

## Links

- Docs: https://simpledatalogs.com/docs
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Security: [SECURITY.md](SECURITY.md)
- License: [MIT](LICENSE)
