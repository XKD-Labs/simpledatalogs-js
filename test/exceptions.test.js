// Exception telemetry: stack parsing for V8, JavaScriptCore, Firefox and Hermes, captureException, and the global crash handlers.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseStackFrames } from '../src/exceptions.js'
import { START_MS, makeHarness, settle } from './harness.js'

// A Chrome stack with async, anonymous, native, eval and dependency frames.
const CHROME_STACK = `TypeError: bad email a@b.c
    at handleClick (https://app.test/assets/index-abc.js?v=3:12:34)
    at async submitForm (https://app.test/assets/index-abc.js:40:5)
    at https://app.test/assets/vendor.js:1:200
    at Array.map (<anonymous>)
    at eval (eval at compile (https://app.test/assets/index-abc.js:5:6), <anonymous>:1:1)
    at new Widget (webpack-internal:///./node_modules/widget/index.js:3:9)`

// A Safari stack, with a native frame and global code.
const SAFARI_STACK = `handleClick@https://app.test/assets/index.js:12:34
@https://app.test/assets/index.js:1:1
forEach@[native code]
global code@https://app.test/page.html:3:10`

// A Hermes stack from a React Native debug bundle and a release bundle.
const HERMES_STACK = `Error: boom
    at onPress (http://10.0.2.2:8081/index.bundle?platform=android&dev=true:1234:56)
    at anonymous (address at index.android.bundle:1:98765)
    at call (native)
    at loadModule (address at InternalBytecode.js:1:2345)`

// Every event sent so far, after a flush.
async function sentEvents(harness) {
  await harness.client.flush()
  return harness.requests.flatMap((request) => request.events)
}

// A fake event target that keeps its listeners by type.
function fakeEventTarget() {
  const listeners = new Map()

  return {
    listeners,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => listeners.get(type) === listener && listeners.delete(type),
    fire: (type, payload) => listeners.get(type)?.(payload),
  }
}

test('V8 stacks parse into frames, innermost first, with the query, async and eval wrappers removed', () => {
  assert.deepEqual(parseStackFrames(CHROME_STACK), [
    { file: 'https://app.test/assets/index-abc.js', line: 12, function: 'handleClick', in_app: true },
    { file: 'https://app.test/assets/index-abc.js', line: 40, function: 'submitForm', in_app: true },
    { file: 'https://app.test/assets/vendor.js', line: 1, function: '', in_app: true },
    { file: '<anonymous>', line: 0, function: 'Array.map', in_app: false },
    { file: 'https://app.test/assets/index-abc.js', line: 5, function: 'eval', in_app: true },
    { file: 'webpack-internal:///./node_modules/widget/index.js', line: 3, function: 'new Widget', in_app: false },
  ])

  const nodeFrames = parseStackFrames('Error: boom\n    at Object.<anonymous> (/app/src/server.js:10:15)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)\n    at /app/node_modules/express/lib/router.js:5:3')
  assert.deepEqual(nodeFrames.map((frame) => [frame.file, frame.in_app]), [['/app/src/server.js', true], ['node:internal/modules/cjs/loader', false], ['/app/node_modules/express/lib/router.js', false]])
})

test('JavaScriptCore, Firefox and Hermes stacks parse too', () => {
  assert.deepEqual(parseStackFrames(SAFARI_STACK), [
    { file: 'https://app.test/assets/index.js', line: 12, function: 'handleClick', in_app: true },
    { file: 'https://app.test/assets/index.js', line: 1, function: '', in_app: true },
    { file: '[native code]', line: 0, function: 'forEach', in_app: false },
    { file: 'https://app.test/page.html', line: 3, function: 'global code', in_app: true },
  ])

  assert.deepEqual(parseStackFrames('submit/<@https://cdn.test/npm/pkg@1.2.0/dist/x.js:7:9'), [{ file: 'https://cdn.test/npm/pkg@1.2.0/dist/x.js', line: 7, function: 'submit/<', in_app: true }])

  assert.deepEqual(parseStackFrames(HERMES_STACK), [
    { file: 'http://10.0.2.2:8081/index.bundle', line: 1234, function: 'onPress', in_app: true },
    { file: 'index.android.bundle', line: 1, function: 'anonymous', in_app: true },
    { file: 'native', line: 0, function: 'call', in_app: false },
    { file: 'InternalBytecode.js', line: 1, function: 'loadModule', in_app: false },
  ])
})

test('stack parsing is bounded to 50 frames and ignores anything that is not a frame', () => {
  const longStack = ['Error: deep', ...Array.from({ length: 80 }, (_, index) => `    at level${index} (/app/deep.js:${index + 1}:1)`)].join('\n')

  assert.equal(parseStackFrames(longStack).length, 50)
  assert.deepEqual(parseStackFrames('just a message\nanother line'), [])
  assert.deepEqual(parseStackFrames(undefined), [])
})

test('captureException sends the exception telemetry object with identity, release, fingerprint and props', async () => {
  const harness = makeHarness({ clientOptions: { deviceId: 'device-1', release: '2026.10.3' } })
  const error = new TypeError('card declined')
  error.stack = CHROME_STACK

  harness.client.captureException(error, { props: { order_id: 7 }, handled: false, fingerprint: 'payments-declined' })
  const [exception] = await sentEvents(harness)

  assert.deepEqual({ ...exception, event_id: 'x', frames: exception.frames.length }, {
    kind: 'exception',
    event_id: 'x',
    ts: new Date(START_MS).toISOString(),
    device_id: 'device-1',
    type: 'TypeError',
    message: 'card declined',
    handled: false,
    frames: 6,
    fingerprint: 'payments-declined',
    release: '2026.10.3',
    props: { order_id: 7 },
  })
  assert.equal(exception.frames[0].function, 'handleClick')
})

test('captureException is handled by default and takes any thrown value, never throwing', async () => {
  const harness = makeHarness()

  harness.client.captureException('plain string thrown')
  harness.client.captureException({ code: 42 }, null)
  harness.client.captureException(new RangeError('bad index'), { eventId: '0192f0a1-7b3c-7d4e-8f90-a1b2c3d4e5f6' })

  const [stringThrown, objectThrown, rangeError] = await sentEvents(harness)
  assert.deepEqual([stringThrown.type, stringThrown.message, stringThrown.handled, stringThrown.frames], ['Error', 'plain string thrown', true, []])
  assert.equal(objectThrown.message, '{"code":42}')
  assert.equal(rangeError.type, 'RangeError')
  assert.equal(rangeError.event_id, '0192f0a1-7b3c-7d4e-8f90-a1b2c3d4e5f6')
  assert.ok(rangeError.frames.length > 0)
})

test('installGlobalHandlers in a page: uncaught errors and rejections become unhandled exceptions, bounded, and uninstall cleanly', async () => {
  const windowTarget = { ...fakeEventTarget(), location: { href: 'https://app.test/' } }
  const harness = makeHarness({ pageTargets: { window: windowTarget, document: fakeEventTarget() }, clientOptions: { runtime: 'browser' } })

  const uninstall = harness.client.installGlobalHandlers()
  assert.equal(harness.client.installGlobalHandlers(), uninstall)

  windowTarget.fire('error', { error: new TypeError('x is undefined') })
  windowTarget.fire('error', { message: 'Script error.', filename: 'https://cdn.test/lib.js?token=1', lineno: 9, colno: 2 })
  windowTarget.fire('unhandledrejection', { reason: new Error('fetch failed') })
  for (let repeat = 0; repeat < 10; repeat++) windowTarget.fire('error', { error: new Error('in a loop') })

  const events = await sentEvents(harness)
  assert.deepEqual(events.map((event) => [event.kind, event.handled, event.props.source]).slice(0, 3), [['exception', false, 'onerror'], ['exception', false, 'onerror'], ['exception', false, 'unhandledrejection']])
  assert.deepEqual(events[1].frames, [{ file: 'https://cdn.test/lib.js', line: 9, function: '', in_app: true }])
  assert.equal(events.filter((event) => event.message === 'in a loop').length, 5)

  // Only the client's own page-hide listener stays.
  uninstall()
  assert.deepEqual([...windowTarget.listeners.keys()], ['pagehide'])
})

test('installGlobalHandlers in a worker listens on the worker scope', async () => {
  const workerScope = { ...fakeEventTarget(), ServiceWorkerGlobalScope: function ServiceWorkerGlobalScope() {}, navigator: {} }
  const harness = makeHarness({ clientOptions: { globalScope: workerScope } })

  harness.client.installGlobalHandlers()
  workerScope.fire('unhandledrejection', { reason: 'no tab found' })

  const [exception] = await sentEvents(harness)
  assert.equal(exception.message, 'no tab found')
  assert.equal(exception.handled, false)
})

test('installGlobalHandlers in React Native chains ErrorUtils and flushes before a fatal error goes on', async () => {
  const handedOn = []
  const previousHandler = (error, isFatal) => handedOn.push({ message: error.message, isFatal, requestsSoFar: harness.requests.length })
  let globalHandler = previousHandler
  const errorUtils = { getGlobalHandler: () => globalHandler, setGlobalHandler: (handler) => (globalHandler = handler) }
  const harness = makeHarness({ clientOptions: { globalScope: { navigator: { product: 'ReactNative' }, ErrorUtils: errorUtils } } })

  const uninstall = harness.client.installGlobalHandlers()

  // A non-fatal error goes on at once; a fatal one after the flush.
  globalHandler(new Error('soft'), false)
  assert.deepEqual(handedOn.map((entry) => entry.message), ['soft'])
  await settle()

  globalHandler(new Error('hard'), true)
  assert.equal(handedOn.length, 1)
  await settle()

  assert.deepEqual(handedOn[1], { message: 'hard', isFatal: true, requestsSoFar: 2 })
  const events = harness.requests.flatMap((request) => request.events)
  assert.deepEqual(events.map((event) => [event.message, event.props.is_fatal]), [['soft', false], ['hard', true]])

  uninstall()
  assert.equal(globalHandler, previousHandler)
})

test('installGlobalHandlers in Node sends the crash as an exception, then exits with 1 when alone', async () => {
  const processListeners = new Map()
  const exitCodes = []
  const processTarget = {
    on: (type, listener) => processListeners.set(type, listener),
    removeListener: (type) => processListeners.delete(type),
    listenerCount: (type) => (processListeners.has(type) ? 1 : 0),
    exit: (code) => exitCodes.push(code),
  }
  const harness = makeHarness({ clientOptions: { processTarget, logger: { warn() {}, error() {} } } })

  harness.client.installGlobalHandlers()
  processListeners.get('uncaughtException')(new RangeError('bad index'), 'uncaughtException')
  await settle()

  const [exception] = harness.requests[0].events
  assert.deepEqual([exception.kind, exception.type, exception.handled, exception.props.source], ['exception', 'RangeError', false, 'uncaughtException'])
  assert.deepEqual(exitCodes, [1])
})
