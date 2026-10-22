/** Exception telemetry: any thrown value as the ingest API's `kind: "exception"` fields, stack strings parsed into frames, and crash handlers. */

import { describeValue, stripQuery, truncate } from './text.js'

// Bounds on one exception, inside the ingest API's caps (50 frames, 128-byte fingerprints).
const EXCEPTION_LIMITS = { frames: 50, frameTextChars: 256, typeChars: 200, messageChars: 1_000, fingerprintChars: 128 }

// Bounds on crash handlers, so an error thrown in a loop can't flood the outbox.
const CRASH_LIMITS = { total: 50, perMessage: 5 }

// How long a crashing app waits for its last flush: Node exits after it, React Native hands the error on.
const CRASH_FLUSH_MS = { node: 2_000, reactNative: 1_000 }

// Marks the SDK's own process listeners, so two of them never wait for each other to exit.
const OWN_LISTENER = Symbol.for('simpledatalogs.crashListener')

// A V8 or Hermes frame: "at fn (file:1:2)", "at file:1:2", "at fn (address at file:1:2)".
const V8_FRAME_PATTERN = /^\s*at (?:(.+?) \((.+)\)|(.+))$/

// A JavaScriptCore or Firefox frame: "fn@file:1:2", "@file:1:2", "fn@[native code]".
const JSC_FRAME_PATTERN = /^\s*(.*?)@(.+?(?::\d+){1,2}|\[native code\])\s*$/

// A frame location's file, then an optional line and column, read from the end.
const LOCATION_PATTERN = /^(.*?)(?::(\d+))?(?::(\d+))?$/

// Files that belong to the runtime or a dependency, never to the app.
const NOT_IN_APP_PATTERN = /node_modules|^node:|^internal\/|^native$|\[native code\]|^<anonymous>$|InternalBytecode/

/** The frames of a V8, JavaScriptCore, Firefox or Hermes stack string, innermost first, best effort. */
export function parseStackFrames(stackText) {
  if (typeof stackText !== 'string') return []

  const frames = []

  for (const stackLine of stackText.split('\n')) {
    if (frames.length >= EXCEPTION_LIMITS.frames) break

    // V8 and Hermes lines start with "at"; JavaScriptCore and Firefox lines put the function before "@".
    const v8Match = V8_FRAME_PATTERN.exec(stackLine)
    const jscMatch = v8Match ? null : JSC_FRAME_PATTERN.exec(stackLine)

    if (v8Match) frames.push(stackFrame(v8Match[1] ?? '', v8Match[2] ?? v8Match[3]))
    else if (jscMatch) frames.push(stackFrame(jscMatch[1], jscMatch[2]))
  }

  return frames
}

/** The ingest API's exception fields for any thrown value: type, message, handled, frames, and a fingerprint when given. */
export function exceptionFields(thrownValue, { handled = true, fingerprint } = {}) {
  const isErrorLike = typeof thrownValue === 'object' && thrownValue !== null && typeof thrownValue.message === 'string'
  const typeText = isErrorLike ? String(thrownValue.name || thrownValue.constructor?.name || 'Error') : 'Error'
  const messageText = isErrorLike ? thrownValue.message : describeValue(thrownValue)
  const fingerprintText = typeof fingerprint === 'string' ? fingerprint.trim() : ''

  return {
    type: truncate(typeText, EXCEPTION_LIMITS.typeChars),
    message: truncate(messageText, EXCEPTION_LIMITS.messageChars),
    handled: handled !== false,
    frames: parseStackFrames(isErrorLike ? thrownValue.stack : undefined),
    ...(fingerprintText === '' ? {} : { fingerprint: fingerprintText.slice(0, EXCEPTION_LIMITS.fingerprintChars) }),
  }
}

/** Sends uncaught errors and unhandled rejections as unhandled exceptions for the runtime; returns a function that removes the handlers. */
export function installCrashHandlers(client, context) {
  const reportCrash = boundedCrashReporter((thrownValue, props) => client.captureException(thrownValue, { handled: false, props }))

  if (context.runtime === 'react-native') return watchReactNativeErrors(context, reportCrash)
  if (context.runtime === 'node') return context.processTarget ? watchProcessCrashes(context, (error, origin) => reportCrash(error, { source: origin ?? 'uncaughtException' })) : () => {}

  return watchScopeErrors(context, reportCrash)
}

/** Reports Node's uncaught exceptions; when only the SDK listens, it keeps Node's default (print, exit 1) after a bounded flush. */
export function watchProcessCrashes(context, reportCrash) {
  const processTarget = context.processTarget

  const onUncaughtException = (error, origin) => {
    reportCrash(error, origin)

    // With the app's own listeners, the app decides what happens next; the SDK only sends.
    if (!isOnlySdkListening(processTarget)) {
      context.flushBeforeExit()
      return
    }

    // Alone, keep Node's default: print the error and exit with code 1, after a bounded flush.
    context.logger?.error?.(error)
    withDeadline(context.flushBeforeExit(), CRASH_FLUSH_MS.node, context.timers).finally(() => processTarget.exit(1))
  }

  onUncaughtException[OWN_LISTENER] = true
  processTarget.on('uncaughtException', onUncaughtException)

  return () => processTarget.removeListener?.('uncaughtException', onUncaughtException)
}

// One frame from a function name and a location; eval and Hermes wrappers point at the real file.
function stackFrame(functionName, locationText) {
  let location = locationText.trim().replace(/^address at /, '')
  if (location.startsWith('eval at ')) location = /\(([^()]+:\d+:\d+)\)/.exec(location)?.[1] ?? location

  // The line comes off the end first, so a URL's port stays in the file.
  const [, fileText, lineText] = LOCATION_PATTERN.exec(location)
  const file = stripQuery(fileText)

  return {
    file: truncate(file, EXCEPTION_LIMITS.frameTextChars),
    line: Number(lineText ?? 0),
    function: truncate(functionName.trim().replace(/^async /, ''), EXCEPTION_LIMITS.frameTextChars),
    in_app: file !== '' && !NOT_IN_APP_PATTERN.test(file),
  }
}

// Wraps a report function so one page or app sends at most 5 copies of a message and 50 crashes in all.
function boundedCrashReporter(report) {
  const countsByMessage = new Map()
  let reportedCount = 0

  return (thrownValue, props) => {
    if (reportedCount >= CRASH_LIMITS.total) return

    // Count repeats by message, so one error thrown in a loop is sent a few times only.
    const messageKey = describeValue(thrownValue?.message ?? thrownValue)
    const repeatCount = (countsByMessage.get(messageKey) ?? 0) + 1
    countsByMessage.set(messageKey, repeatCount)
    if (repeatCount > CRASH_LIMITS.perMessage) return

    reportedCount += 1
    report(thrownValue, props)
  }
}

// Listens for error and unhandledrejection on a page or worker scope; addEventListener leaves the app's own handlers in place.
function watchScopeErrors(context, reportCrash) {
  const scope = context.scope

  // An error event without an error object (a cross-origin script) still names its file and line.
  const onError = (errorEvent) => {
    const fallbackStack = errorEvent?.filename ? `    at ${errorEvent.filename}:${errorEvent.lineno ?? 0}:${errorEvent.colno ?? 0}` : ''
    const thrownValue = errorEvent?.error ?? { name: 'Error', message: String(errorEvent?.message ?? 'Unknown error'), stack: fallbackStack }

    reportCrash(thrownValue, { source: 'onerror' })
    context.flushBeforeExit()
  }

  // A promise rejected with nobody to catch it.
  const onUnhandledRejection = (rejectionEvent) => {
    reportCrash(rejectionEvent?.reason, { source: 'unhandledrejection' })
    context.flushBeforeExit()
  }

  scope?.addEventListener?.('error', onError)
  scope?.addEventListener?.('unhandledrejection', onUnhandledRejection)

  return () => {
    scope?.removeEventListener?.('error', onError)
    scope?.removeEventListener?.('unhandledrejection', onUnhandledRejection)
  }
}

// Chains React Native's ErrorUtils global handler: report, then hand the error to the previous handler (after a short flush when fatal).
function watchReactNativeErrors(context, reportCrash) {
  const errorUtils = context.scope?.ErrorUtils
  if (typeof errorUtils?.setGlobalHandler !== 'function') return () => {}

  const previousHandler = errorUtils.getGlobalHandler?.()

  const onGlobalError = (error, isFatal) => {
    reportCrash(error, { source: 'ErrorUtils', is_fatal: Boolean(isFatal) })
    const handOn = () => previousHandler?.(error, isFatal)

    // A non-fatal error goes on at once; a fatal one waits up to 1 s, since the app is about to stop.
    if (!isFatal) {
      handOn()
      context.flushBeforeExit()
      return
    }

    withDeadline(context.flushBeforeExit(), CRASH_FLUSH_MS.reactNative, context.timers).finally(handOn)
  }

  errorUtils.setGlobalHandler(onGlobalError)

  // Put the previous handler back, unless someone chained theirs after ours.
  return () => {
    if (errorUtils.getGlobalHandler?.() === onGlobalError) errorUtils.setGlobalHandler(previousHandler)
  }
}

// True when every uncaughtException listener of the process is the SDK's own.
function isOnlySdkListening(processTarget) {
  const listeners = processTarget.listeners?.('uncaughtException')
  if (Array.isArray(listeners)) return listeners.every((listener) => listener[OWN_LISTENER] === true)

  return (processTarget.listenerCount?.('uncaughtException') ?? 1) <= 1
}

// Resolves when the promise settles or the deadline passes, whichever comes first; never rejects.
function withDeadline(promise, deadlineMs, timers) {
  const deadline = new Promise((resolve) => timers.setTimeout(resolve, deadlineMs))

  return Promise.race([Promise.resolve(promise).catch(() => {}), deadline])
}
