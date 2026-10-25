/** Whether someone is using the page or app (`app_state`) and for how long between events (`engaged_ms`), for active and passive sessions. */

// The longest engaged time one event reports: a day, as the server accepts.
const MAX_ENGAGED_MS = 86_400_000

/** A tracker of foreground time between events; feed it active and background moments, stamp each event tracked now. */
export function createActivityTracker(isActive, nowMs) {
  let isInFront = Boolean(isActive)
  let activeSinceMs = isInFront ? nowMs : null
  let finishedActiveMs = 0

  // The current foreground stretch up to now, never negative.
  const currentActiveMs = (atMs) => (activeSinceMs === null ? 0 : Math.max(atMs - activeSinceMs, 0))

  return {
    /** The page or app came to the front (true) or left it (false). */
    setActive(isNowActive, atMs) {
      if (Boolean(isNowActive) === isInFront) return

      // Leaving keeps the stretch for the next stamp; coming back starts a new one.
      if (isInFront) finishedActiveMs += currentActiveMs(atMs)
      isInFront = Boolean(isNowActive)
      activeSinceMs = isInFront ? atMs : null
    },

    /** The props for one event tracked now, counting afresh from it. */
    stamp(atMs) {
      const engagedMs = Math.min(Math.round(finishedActiveMs + currentActiveMs(atMs)), MAX_ENGAGED_MS)

      finishedActiveMs = 0
      activeSinceMs = isInFront ? atMs : null

      return isInFront ? { app_state: 'active', engaged_ms: engagedMs } : { app_state: 'background' }
    },
  }
}

/** Whether a page is in front now: visible, or a document without the Page Visibility API. */
export function isPageVisible(documentTarget) {
  return documentTarget?.visibilityState === undefined || documentTarget.visibilityState === 'visible'
}

/** Whether a React Native AppState value means the app is in front. */
export function isAppStateActive(appStateValue) {
  return appStateValue === 'active'
}
