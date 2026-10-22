/** Where the SDK runs (a browser page, a worker such as an extension's service worker, React Native or Node) and each runtime's defaults. */

/** The runtimes the SDK tells apart. */
export const RUNTIMES = ['browser', 'worker', 'react-native', 'node']

/** The runtime of a global scope: React Native first (it may polyfill document), then a page, then a worker, else Node-like. */
export function detectRuntime(globalScope = globalThis) {
  if (globalScope.navigator?.product === 'ReactNative') return 'react-native'
  if (typeof globalScope.document !== 'undefined') return 'browser'
  if (isWorkerScope(globalScope)) return 'worker'

  return 'node'
}

/** The `runtime` option when it names a known runtime, else the detected one. */
export function resolveRuntime(runtimeOption, globalScope) {
  return RUNTIMES.includes(runtimeOption) ? runtimeOption : detectRuntime(globalScope)
}

/** A storage adapter over an extension storage area (`chrome.storage.local`, `browser.storage.local`); a key prefix keeps contexts apart. */
export function chromeStorageAdapter(storageArea, keyPrefix = '') {
  const areaKey = (storageKey) => `${keyPrefix}${storageKey}`

  return {
    getItem: async (storageKey) => (await storageArea.get(areaKey(storageKey)))?.[areaKey(storageKey)] ?? null,
    setItem: (storageKey, value) => storageArea.set({ [areaKey(storageKey)]: value }),
    removeItem: (storageKey) => storageArea.remove(areaKey(storageKey)),
  }
}

/** True for a Web Storage object (localStorage), which can list its keys; anything else is used as an async adapter. */
export function isWebStorage(storage) {
  return typeof storage?.key === 'function' && typeof storage.length === 'number'
}

/** True when an object has the three methods every storage needs. */
export function isUsableStorage(storage) {
  return ['getItem', 'setItem', 'removeItem'].every((methodName) => typeof storage?.[methodName] === 'function')
}

/** localStorage in a page, the extension's storage in a worker that has it, and none elsewhere. */
export function defaultStorage(runtime, globalScope = globalThis) {
  try {
    if (runtime === 'browser') return globalScope.localStorage ?? null

    // An extension's service worker has no localStorage; chrome.storage.local survives the worker being stopped.
    const extensionStorageArea = globalScope.chrome?.storage?.local ?? globalScope.browser?.storage?.local
    if (runtime === 'worker' && extensionStorageArea) return chromeStorageAdapter(extensionStorageArea)
  } catch {
    // Private modes may throw on access; the outbox then lives in memory.
  }

  return null
}

/** The Node process, for crash capture; none in other runtimes. */
export function defaultProcessTarget(runtime, globalScope = globalThis) {
  const processTarget = globalScope.process
  return runtime === 'node' && typeof processTarget?.on === 'function' ? processTarget : null
}

/** window and document in a page; none elsewhere. */
export function defaultPageTargets(runtime, globalScope = globalThis) {
  return runtime === 'browser' ? { window: globalScope, document: globalScope.document } : null
}

// True in a dedicated, shared or service worker, an extension's background worker among them.
function isWorkerScope(globalScope) {
  return typeof globalScope.ServiceWorkerGlobalScope === 'function' || typeof globalScope.WorkerGlobalScope === 'function' || typeof globalScope.importScripts === 'function'
}
