/** Small text helpers shared by autocapture and exception capture. */

/** Text cut to at most maxChars characters. */
export function truncate(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** A URL or file path without its query or fragment, which can carry tokens. */
export function stripQuery(urlText) {
  return urlText.split(/[?#]/)[0]
}

/** A short text for any thrown or rejected value. */
export function describeValue(value) {
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
