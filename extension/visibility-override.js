// Runs in the PAGE's MAIN world at document_start (before any page JavaScript).
// Overrides the Page Visibility API so that Google Find My Device never pauses
// its own location-refresh cycle when the tab is in the background.
// Without this, Google FMD stops polling its servers as soon as the tab is hidden,
// which means no DOM updates and therefore no location data for us to extract.
(function () {
  'use strict';

  try {
    // Always report the page as visible.
    // Google FMD (and most SPAs) check document.hidden / document.visibilityState
    // at read-time to decide whether to pause their polling loops.
    // By overriding these getters we ensure those checks always return "visible"
    // without needing to intercept or stop event propagation.
    Object.defineProperty(document, 'hidden', {
      get: function () { return false; },
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: function () { return 'visible'; },
      configurable: true,
    });

    // Dispatch a synthetic visibilitychange event so any listeners that have
    // already registered (unlikely at document_start, but defensive) also update.
    // We do NOT intercept or wrap existing addEventListener calls; we simply let
    // all events fire naturally — when FMD's handler then reads document.hidden
    // it will get false (visible) thanks to the getter override above.
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true, cancelable: false }));

  } catch (e) {
    // Silently fail — non-critical, regular monitoring still works
    console.warn('[DeviceTracker] visibility-override failed:', e);
  }
})();
