// Runs in the PAGE's MAIN world at document_start.
// Intercepts Google Find My Device's own fetch/XHR requests and Google Maps
// API calls, then relays the captured data to the isolated content script
// via a CustomEvent on document.
//
// WHY THIS MUST BE MAIN WORLD:
//   Chrome MV3 separates the content script's JavaScript execution into an
//   "isolated world".  Overriding window.fetch or window.XMLHttpRequest in
//   the isolated world only replaces them for the content script itself —
//   the page's code (Google FMD) keeps using the originals and its responses
//   are never seen by the extension.  Running this script in the MAIN world
//   (same context as the page) is the only way to truly intercept the page's
//   network traffic.
(function () {
  'use strict';

  // Custom event name used for MAIN → ISOLATED communication.
  const EVENT_NAME = 'dtNetData';

  // ── URL filter ──────────────────────────────────────────────────────────
  function shouldIntercept(url) {
    if (!url) return false;
    try {
      const u = new URL(url.toString(), window.location.href);
      const host = u.hostname;
      const path = u.pathname;
      return (
        (host === 'www.google.com' &&
          (path.includes('/android/find') || path.includes('/_/FindDevice'))) ||
        host === 'findmydevice.google.com' ||
        (host === 'android.google.com' && path.startsWith('/find')) ||
        (host === 'www.googleapis.com' &&
          (path.includes('/devicemanagement') || path.includes('/android'))) ||
        host === 'androiddevicemanager.googleapis.com'
      );
    } catch {
      return false;
    }
  }

  // ── Emit captured data to the isolated content script ───────────────────
  function emitNetworkData(rawJson) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, { detail: { type: 'network', data: rawJson } })
      );
    } catch (e) {
      // Ignore dispatch errors
    }
  }

  function emitMapMarker(lat, lng, title) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: { type: 'marker', lat: lat, lng: lng, title: title || null },
        })
      );
    } catch (e) {
      // Ignore
    }
  }

  // ── Parse a Google response body (strips anti-XSSI prefix) ──────────────
  function parseGoogleResponse(text) {
    try {
      let t = text;
      // Google APIs often prefix JSON with )]}'\n to prevent XSSI
      if (t && t.startsWith(')]}')) {
        t = t.slice(t.indexOf('\n') + 1);
      }
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  // ── Override fetch ───────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (url, options) {
    const result = _origFetch.apply(this, arguments);
    if (!shouldIntercept(url)) return result;

    result.then(function (response) {
      response.clone().text().then(function (text) {
        const data = parseGoogleResponse(text);
        if (data) emitNetworkData(data);
      }).catch(function () {});
    }).catch(function () {});

    return result;
  };

  // ── Override XMLHttpRequest ──────────────────────────────────────────────
  const _origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new _origXHR();
    const _origOpen = xhr.open.bind(xhr);
    let _interceptUrl = null;

    xhr.open = function (method, url) {
      _interceptUrl = url;
      return _origOpen.apply(xhr, arguments);
    };

    xhr.addEventListener('load', function () {
      if (!shouldIntercept(_interceptUrl)) return;
      const data = parseGoogleResponse(xhr.responseText);
      if (data) emitNetworkData(data);
    });

    return xhr;
  };
  // Copy static properties (e.g. DONE, LOADING …) from the original XHR
  Object.setPrototypeOf(window.XMLHttpRequest, _origXHR);

  // ── Hook Google Maps API to capture marker coordinates ───────────────────
  // The Maps API loads asynchronously after the page script runs, so we poll
  // until it is available.
  var _mapsHookAttempts = 0;
  function tryHookMaps() {
    _mapsHookAttempts++;
    var gm = window.google && window.google.maps;
    if (!gm) {
      if (_mapsHookAttempts < 60) setTimeout(tryHookMaps, 500);
      return;
    }

    // Hook classic Marker
    if (gm.Marker && !gm.Marker.__dtHooked) {
      var _OrigMarker = gm.Marker;
      function _HookedMarker(opts) {
        var inst = new _OrigMarker(opts);
        if (opts && opts.position) {
          try {
            var pos = opts.position;
            var lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
            var lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
            if (lat != null && lng != null) {
              emitMapMarker(lat, lng, opts.title || opts.label || null);
            }
          } catch (e) {}
        }
        return inst;
      }
      _HookedMarker.prototype = _OrigMarker.prototype;
      Object.setPrototypeOf(_HookedMarker, _OrigMarker);
      _HookedMarker.__dtHooked = true;
      try { gm.Marker = _HookedMarker; } catch (e) {}
    }

    // Hook AdvancedMarkerElement (new Maps API)
    var _markerNS = gm.marker;
    if (_markerNS && _markerNS.AdvancedMarkerElement && !_markerNS.AdvancedMarkerElement.__dtHooked) {
      var _OrigAME = _markerNS.AdvancedMarkerElement;
      class _HookedAME extends _OrigAME {
        constructor(opts) {
          super(opts);
          if (opts && opts.position) {
            try {
              var pos = opts.position;
              var lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
              var lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
              if (lat != null && lng != null) {
                emitMapMarker(lat, lng, opts.title || null);
              }
            } catch (e) {}
          }
        }
      }
      _HookedAME.__dtHooked = true;
      try { _markerNS.AdvancedMarkerElement = _HookedAME; } catch (e) {}
    }
  }

  tryHookMaps();

})();
