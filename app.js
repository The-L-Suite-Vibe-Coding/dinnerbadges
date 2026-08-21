/* app.js — wiring only.
 *
 * Owns three things and nothing else:
 *   1. window.BadgeBus  — the tiny pub/sub every module talks over.
 *   2. the DOMContentLoaded bootstrap that mounts the other modules, each guarded so a
 *      module that has not landed yet logs a warning instead of throwing.
 *   3. the side panel's two tabs ("Badges" / "Sheet settings"). Shell chrome, not a
 *      feature: it only shows and hides containers that already exist in index.html
 *      and never touches their contents, so no module needs to know it is there.
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
    { role: 'pdf',       method: 'mount', names: ['BadgePdf', 'PdfExport'] },
    { role: 'docx',      method: 'mount', names: ['BadgeDocx'] }
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

  /* ------------------------------------------------------------ panel tabs */

  /* [tab id, page id] — both must already exist in index.html. */
  var TABS = [
    ['tab-badges', 'page-badges'],
    ['tab-sheet', 'page-sheet']
  ];

  /**
   * Wire the side panel's tab strip. Deliberately tolerant: if either the tabs or
   * the pages are absent (a test harness, an older index.html), this does nothing
   * and the panel behaves exactly as it did before tabs existed — every page is
   * simply visible. It never creates, moves or empties a node, so a module that
   * mounts into #sheet-panel is unaffected by which tab is showing.
   */
  function initTabs() {
    var pairs = [];
    for (var i = 0; i < TABS.length; i++) {
      var tab = document.getElementById(TABS[i][0]);
      var page = document.getElementById(TABS[i][1]);
      if (!tab || !page) return; // all or nothing — a half-wired tab strip is worse
      pairs.push({ tab: tab, page: page });
    }

    var panel = document.getElementById('side-panel');

    function show(index, moveFocus) {
      for (var k = 0; k < pairs.length; k++) {
        var on = k === index;
        pairs[k].tab.setAttribute('aria-selected', on ? 'true' : 'false');
        // Roving tabindex: only the selected tab is in the tab order (ARIA tabs pattern).
        pairs[k].tab.tabIndex = on ? 0 : -1;
        pairs[k].page.hidden = !on;
      }
      if (moveFocus) pairs[index].tab.focus();
      // The two pages are very different heights; leaving the panel scrolled to where
      // the other page ended looks like a rendering fault.
      if (panel) panel.scrollTop = 0;
    }

    for (var j = 0; j < pairs.length; j++) {
      (function (index) {
        pairs[index].tab.addEventListener('click', function () { show(index, false); });
        pairs[index].tab.addEventListener('keydown', function (ev) {
          var key = ev && ev.key;
          var next = null;
          if (key === 'ArrowRight' || key === 'ArrowDown') next = (index + 1) % pairs.length;
          else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (index - 1 + pairs.length) % pairs.length;
          else if (key === 'Home') next = 0;
          else if (key === 'End') next = pairs.length - 1;
          if (next === null) return;
          ev.preventDefault();
          show(next, true);
        });
      })(j);
    }

    // Start from whatever index.html marked selected, so the markup stays the
    // single source of truth for the initial page.
    var start = 0;
    for (var m = 0; m < pairs.length; m++) {
      if (pairs[m].tab.getAttribute('aria-selected') === 'true') { start = m; break; }
    }
    show(start, false);
  }

  function boot() {
    for (var i = 0; i < MOUNTS.length; i++) mountOne(MOUNTS[i]);
    try {
      initTabs();
    } catch (err) {
      // A broken tab strip must not take the mounted app down with it.
      console.error('[app] initTabs() threw:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window, document);
