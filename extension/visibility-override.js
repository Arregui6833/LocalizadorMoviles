// Runs in the PAGE's MAIN world at document_start (before any page JavaScript).
// Overrides the Page Visibility API so that Google Find My Device never pauses
// its own location-refresh cycle when the tab is in the background.
// Without this, Google FMD stops polling its servers as soon as the tab is hidden,
// which means no DOM updates and therefore no location data for us to extract.
(function () {
  'use strict';

  try {
    // ── 1. Override getter properties ────────────────────────────────────────
    // Always report the page as visible.
    // Google FMD (and most SPAs) check document.hidden / document.visibilityState
    // at read-time to decide whether to pause their polling loops.
    Object.defineProperty(document, 'hidden', {
      get: function () { return false; },
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: function () { return 'visible'; },
      configurable: true,
    });

    // Override document.hasFocus() so FMD/Maps code that checks focus
    // before starting its polling loop always sees a focused document.
    document.hasFocus = function () { return true; };

    // ── 2. Intercept native visibilitychange events ───────────────────────────
    // Chrome fires a native visibilitychange event when a tab starts as active:false
    // or when the window loses focus. If we let those events propagate, FMD's
    // handler fires, reads document.hidden, gets false (our getter), and is happy.
    // But some versions of FMD / Google Maps check the event's own context (e.g.
    // check if the event was dispatched during a "visible" state transition).
    // To be safe we intercept native events in the capture phase, stop them, and
    // re-dispatch a clean synthetic event so FMD always reacts to "visible" state.
    var _reDispatching = false;
    document.addEventListener('visibilitychange', function (e) {
      if (_reDispatching) return; // guard against re-entrancy
      e.stopImmediatePropagation();
      _reDispatching = true;
      try {
        // Re-fire a fresh event; FMD's handler will run and read document.hidden → false
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true, cancelable: false }));
      } finally {
        _reDispatching = false;
      }
    }, true /* capture phase — runs before any page listener */);

    // ── 3. Send visibility signals after the page has loaded ─────────────────
    // The event dispatched at document_start fires before FMD has registered its
    // event listeners, so it needs to be re-fired once FMD's JS is running.
    // We dispatch right after load and again at 1s / 3s / 6s to catch SPA code
    // that registers handlers asynchronously after the initial page load.
    function sendVisibleSignals() {
      try {
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true, cancelable: false }));
        window.dispatchEvent(new Event('focus', { bubbles: false, cancelable: false }));
        document.dispatchEvent(new Event('focus', { bubbles: true, cancelable: false }));
      } catch (err) { /* ignore */ }
    }

    window.addEventListener('load', function () {
      sendVisibleSignals();
      setTimeout(sendVisibleSignals, 1000);
      setTimeout(sendVisibleSignals, 3000);
      setTimeout(sendVisibleSignals, 6000);
    });

  } catch (e) {
    // Silently fail — non-critical, regular monitoring still works
    console.warn('[DeviceTracker] visibility-override failed:', e);
  }
})();
