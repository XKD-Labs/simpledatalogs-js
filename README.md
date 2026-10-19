# simpledatalogs (JavaScript)

Sends events and log lines to [simpledatalogs](https://simpledatalogs.com) from browsers and Node, following the [sender rules](https://simpledatalogs.com/docs/api/sender-rules).
One ES module, no dependencies. Full guide: [simpledatalogs.com/docs/sdks/javascript](https://simpledatalogs.com/docs/sdks/javascript).

## Install

```sh
npm install simpledatalogs
```

```js
import { createClient } from 'simpledatalogs'

const sdl = createClient({ ingestKey: 'sdl_pub_…' }) // endpoint defaults to https://edge.simpledatalogs.com; init({ key }) is the short form

sdl.track('signup', { plan: 'pro' })
sdl.log('error', 'Payment failed', { order_id: 7 })
sdl.setDeviceId(anonymousId) // optional; unlocks "active devices"
```

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
- `track(name, props, { timestamp })` records an event at an earlier time; `setSessionId(id)` sets the session id yourself.

## Script tag

One minified file (`dist/simpledatalogs.min.js`, ~8 KB gzipped) for sites without a bundler. The tag is the opt-in, so autocapture is on, in **web mode**: no cookies and no browser storage, so no consent banner is needed for it.

```html
<script src="https://cdn.jsdelivr.net/npm/simpledatalogs@0.4.0/dist/simpledatalogs.min.js" data-key="sdl_pub_…" defer></script>
```

- unpkg works too: `https://unpkg.com/simpledatalogs@0.4.0/dist/simpledatalogs.min.js`.
- Attributes: `data-key` (required), `data-endpoint`, `data-autocapture="false"` (manual calls only), `data-outbound-links="false"`, `data-storage="true"` (a stored outbox and tab sessions, as in the npm package).
- Visitors and visits are counted by the server from a daily-rotating hash, so the page sends only page views, clicks and errors; events wait in memory and go out on page hide.
- Clicks: `<button data-track="signup" data-track-plan="pro">` sends `signup` with `plan` and the page path.
- Your own calls: `simpledatalogs.track('signup')`, `simpledatalogs.log('error', 'boom')`.
- Build it with `npm ci && npm run build`; `dist/` is committed so tests and the CDN see the same file.

## Rules it follows

- **Ids and times:** every event gets a UUID `event_id` and a `ts` when it happens, so retries never count twice.
- **Batching:** a request goes out every 30 s, or at once at 50 events; each stays under 256 KB.
- **Outbox:** an event leaves only after a `202`. In browsers it is kept in `localStorage`, so a reload or a closed tab sends it on the next page load; Node keeps it in memory.
- **Bounded on purpose:** browser storage is small and shared with your page, so the outbox holds at most 1,000 events or 2 MB (`maxOutboxEvents`, `maxOutboxBytes`). Only when that fills (for example a revoked key for hours) are the oldest unsent events dropped, with a warning. A single event over 256 KB can never be accepted and is dropped on `413`.
- **Answers:** other statuses and network errors back off with full jitter from 1 s to 5 min, never sooner than `Retry-After`; `401` keeps the outbox and re-checks the key after 1 min, then every 10 min; `413` halves the batch and each `202` doubles it back to 50; `415` drops the batch with one warning (never resent unchanged).
- **Light on the page (0.2.0):** `track()` never writes storage itself; the outbox is saved once per turn of the event loop, and after a quota error it is not written again until it shrinks. Page hide sends one `keepalive` request at a time. A stored outbox older than 30 days is deleted whatever key wrote it, so a rotated key's leftovers never fill the origin's storage.
- **Page hide:** on `pagehide` or a hidden tab, one `fetch` with `keepalive` sends up to 60 KB. Anything unconfirmed stays stored and is resent later; `event_id` dedupes it.
- **Light:** one file (~8 KB gzipped), no dependencies; `track()` only queues. In Node, batches of a flush go one at a time over one reused keep-alive connection (tested against a real server).
- **Fails open:** no call throws; problems are logged once each with `console.warn`.
- **Opt-out:** `sdl.setEnabled(false)` deletes every unsent event and ignores new ones until `setEnabled(true)`.
- **Node:** `await sdl.shutdown()` before the process exits. Use a secret key (`sdl_sec_…`) on servers, never in a web page.

Props must be strings, finite numbers or booleans; other values are skipped with a warning.

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
