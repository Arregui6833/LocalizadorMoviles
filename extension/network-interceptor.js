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
  // rawJson  — the parsed JavaScript object/array from the API response.
  // rawText  — the original response text (before JSON.parse) so the
  //            isolated-world side can scan it for coordinate pairs using
  //            regex even when the parsed structure doesn't match known field names.
  function emitNetworkData(rawJson, rawText) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: { type: 'network', data: rawJson, rawText: rawText || null },
        })
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

  // Emit when the map is panned/centered to a location (fired by FMD's click handler
  // synchronously when a device with a known location is selected — works even in
  // background tabs where requestAnimationFrame is throttled and Marker never fires).
  function emitMapCenter(lat, lng, method) {
    try {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: { type: 'center', lat: lat, lng: lng, method: method || null },
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
        if (!text) return;
        const data = parseGoogleResponse(text);
        // Emit even when JSON parsing fails so the isolated world can still
        // run extractCoordsFromRawJson on the raw text (coordinates are present
        // in FMD's protobuf-JSON arrays regardless of whether the outer wrapper
        // can be parsed as a JS object).
        emitNetworkData(data || null, text);
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
      const text = xhr.responseText;
      if (!text) return;
      const data = parseGoogleResponse(text);
      emitNetworkData(data || null, text);
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

    // ── Hook Map.prototype pan/center methods ────────────────────────────────
    // When FMD selects a device with a known location, it calls map.panTo() or
    // map.setCenter() synchronously in its click handler — BEFORE any rendering
    // via requestAnimationFrame. This means these methods fire reliably even in
    // background tabs where rAF is throttled and Marker constructors never run.
    if (gm.Map && gm.Map.prototype && !gm.Map.prototype.__dtPanHooked) {
      gm.Map.prototype.__dtPanHooked = true;

      // Helper to extract lat/lng from a Maps LatLng / LatLngLiteral
      function _extractLatLng(latLng) {
        if (!latLng) return null;
        var lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat;
        var lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng;
        if (lat == null || lng == null) return null;
        lat = parseFloat(lat); lng = parseFloat(lng);
        if (isNaN(lat) || isNaN(lng)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null; // null-island
        return { lat: lat, lng: lng };
      }

      // panTo(latLng)
      var _origPanTo = gm.Map.prototype.panTo;
      if (_origPanTo) {
        gm.Map.prototype.panTo = function(latLng) {
          try {
            var c = _extractLatLng(latLng);
            if (c) emitMapCenter(c.lat, c.lng, 'panTo');
          } catch (e) {}
          return _origPanTo.apply(this, arguments);
        };
      }

      // setCenter(latLng)
      var _origSetCenter = gm.Map.prototype.setCenter;
      if (_origSetCenter) {
        gm.Map.prototype.setCenter = function(latLng) {
          try {
            var c = _extractLatLng(latLng);
            if (c) emitMapCenter(c.lat, c.lng, 'setCenter');
          } catch (e) {}
          return _origSetCenter.apply(this, arguments);
        };
      }

      // fitBounds(bounds[, padding]) — derive center from the bounds
      var _origFitBounds = gm.Map.prototype.fitBounds;
      if (_origFitBounds) {
        gm.Map.prototype.fitBounds = function(bounds) {
          try {
            var c = null;
            if (bounds && typeof bounds.getCenter === 'function') {
              c = _extractLatLng(bounds.getCenter());
            } else if (bounds && bounds.north != null && bounds.south != null &&
                       bounds.east != null && bounds.west != null) {
              // LatLngBoundsLiteral
              var lat = (bounds.north + bounds.south) / 2;
              var lng = (bounds.east + bounds.west) / 2;
              c = _extractLatLng({ lat: lat, lng: lng });
            }
            if (c) emitMapCenter(c.lat, c.lng, 'fitBounds');
          } catch (e) {}
          return _origFitBounds.apply(this, arguments);
        };
      }
    }
  }

  tryHookMaps();

})();
