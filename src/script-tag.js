/** The drop-in script tag: reads data-key (and data-endpoint) from its own tag, starts a cookie-less, storage-free client with autocapture, and exposes it as window.simpledatalogs. */

import { SDK_VERSION, init } from './index.js'

// The <script> element running this file; null when it was loaded some other way.
const scriptElement = globalThis.document?.currentScript ?? null

// Reads one data-* attribute from the tag, trimmed, or '' when absent.
function readAttribute(attributeName) {
  const attributeValue = scriptElement?.getAttribute?.(attributeName)
  return typeof attributeValue === 'string' ? attributeValue.trim() : ''
}

// Starts one client per page; a second copy of the tag reuses the first client.
function startFromScriptTag() {
  if (globalThis.simpledatalogs?.version === SDK_VERSION && typeof globalThis.simpledatalogs.track === 'function') return

  // The tag is the opt-in, so autocapture is on unless data-autocapture="false"; outbound clicks unless data-outbound-links="false".
  const isAutocaptureOn = readAttribute('data-autocapture') !== 'false'
  const isOutboundLinksOn = readAttribute('data-outbound-links') !== 'false'
  const endpoint = readAttribute('data-endpoint')

  // Web mode by default: no cookies and no browser storage, so visits are counted by the server; data-storage="true" keeps a stored outbox and tab sessions.
  const isStorageOn = readAttribute('data-storage') === 'true'

  const client = init({
    key: readAttribute('data-key'),
    ...(endpoint === '' ? {} : { endpoint }),
    ...(isStorageOn ? {} : { storage: null }),
    autocapture: isAutocaptureOn ? { outboundLinks: isOutboundLinksOn, sessions: isStorageOn } : false,
  })

  // The page's handle for its own calls: simpledatalogs.track('signup').
  Object.defineProperty(client, 'version', { value: SDK_VERSION })
  globalThis.simpledatalogs = client
}

startFromScriptTag()
