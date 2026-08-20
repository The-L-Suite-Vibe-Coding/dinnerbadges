/* app.js — wiring only.
 *
 * Owns two things and nothing else:
 *   1. window.BadgeBus  — the tiny pub/sub every module talks over.
 *   2. the DOMContentLoaded bootstrap that mounts the other modules, each guarded so a
 *      module that has not landed yet logs a warning instead of throwing.
 *
 * No layout math, no DOM building, no network. Classic script, no modules.
 */
(function (window, document) {
  'use strict';

  /* ---------------------------------------------------------------- BadgeBus */
  /* Events in use: 'data:changed', 'page:changed', 'override:changed'. */
  var BadgeBus = (function () {
    var listeners = Object.create(null);

    function on(evt, fn) {
      if (typeof evt !== 'string' || typeof fn !== 'function') return function () {};
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
      // returns an unsubscribe so callers can detach without reaching into internals
      return function off() {
        var arr = listeners[evt];
        if (!arr) return;
        var i = arr.indexOf(fn);
        if (i !== -1) arr.splice(i, 1);
      };
    }

    function emit(evt, payload) {
      var arr = listeners[evt];
      if (!arr || !arr.length) return;
      // copy first: a handler may subscribe/unsubscribe during dispatch
      var snapshot = arr.slice();
      for (var i = 0; i < snapshot.length; i++) {
        try {
          snapshot[i](payload);
        } catch (err) {
          // one bad handler must not stop the rest, or the emitting caller
          console.error('[BadgeBus] handler for "' + evt + '" threw:', err);
        }
      }
    }

    return { on: on, emit: emit };
  })();

  window.BadgeBus = BadgeBus;

  /* -------------------------------------------------------------- bootstrap */

  /* Each role lists the global names it may ship under (the spec fixes some names and
     leaves others to the owning item), plus the method to call. First match wins. */
  var MOUNTS = [
    { role: 'store',     method: 'init',  names: ['BadgeStore'] },
    { role: 'input',     method: 'mount', names: ['BadgeInput', 'Input'] },
    { role: 'preview',   method: 'mount', names: ['BadgePreview', 'Preview'] },
    { role: 'overrides', method: 'mount', names: ['BadgeOverrides', 'Overrides'] },
    { role: 'pdf',       method: 'mount', names: ['BadgePdf', 'PdfExport'] }
  ];

  function mountOne(entry) {
    var mod = null;
    var found = null;
    for (var i = 0; i < entry.names.length; i++) {
      if (window[entry.names[i]]) {
        mod = window[entry.names[i]];
        found = entry.names[i];
        break;
      }
    }

    if (!mod) {
      console.warn('[app] no module for "' + entry.role + '" (looked for ' +
        entry.names.join(', ') + ') — skipping.');
      return;
    }

    if (typeof mod[entry.method] !== 'function') {
      // Module is present but exposes no entry point of its own; nothing to do.
      console.warn('[app] ' + found + '.' + entry.method + '() is not a function — skipping.');
      return;
    }

    try {
      mod[entry.method]();
    } catch (err) {
      console.error('[app] ' + found + '.' + entry.method + '() threw:', err);
    }
  }

  function boot() {
    for (var i = 0; i < MOUNTS.length; i++) mountOne(MOUNTS[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window, document);
