/*
 * js/dom.js — window.BadgeDom
 *
 * The element builders the side-panel modules share. js/input.js and js/overrides.js
 * each carried their own near-identical `el()` and `button()`; this is the single copy.
 *
 * SCOPE: this file builds nodes and nothing else. No state, no store, no layout, no
 * geometry, no event wiring beyond the one click handler `button()` exists to attach.
 * It is deliberately the dumbest file in the project.
 *
 * NEVER innerHTML — not for building, not for clearing. Every string that reaches the
 * DOM here goes through textContent or setAttribute, so an attendee named
 * `<img src=x onerror=alert(1)>` renders as those literal characters. That is the whole
 * reason this is one file instead of two: an XSS-safety rule is only as good as its
 * least careful copy.
 *
 * `el()` is the UNION of the two signatures it replaces, so no existing call site had
 * to change:
 *   el(tag, { className, text, id, style, attrs, children }, doc)
 * Every option is optional. `text` of 0 or '' is honoured; only null/undefined skip.
 *
 * Classic script. No ES modules, no network. Works under file://.
 */
(function (window) {
  'use strict';

  /* The document is resolved per call, never cached: js/input.js passes an explicit one
     from its test harness, js/overrides.js relies on window.document, and the global may
     be absent entirely under node. Callers keep their own two-line doc() where their
     contract differs (one wants a throw, the other a null) — only the builders below
     were worth sharing. */
  function doc(d) {
    if (d) return d;
    if (window && window.document) return window.document;
    if (typeof document !== 'undefined' && document) return document;
    return null;
  }

  function el(tag, opts, d) {
    var node = doc(d).createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.id) node.id = opts.id;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.style) {
      for (var s in opts.style) {
        if (Object.prototype.hasOwnProperty.call(opts.style, s)) node.style[s] = opts.style[s];
      }
    }
    if (opts.attrs) {
      for (var k in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, k)) {
          node.setAttribute(k, String(opts.attrs[k]));
        }
      }
    }
    if (opts.children) {
      for (var i = 0; i < opts.children.length; i++) {
        if (opts.children[i]) node.appendChild(opts.children[i]);
      }
    }
    return node;
  }

  /* button(label, ariaLabel, onClick, doc) — the signature both callers already used.
   *
   * type="button" is not a detail: a bare <button> inside a form defaults to submit,
   * which reloads the page and silently drops the attendee list.
   *
   * A missing handler DISABLES the button rather than shipping a live control that does
   * nothing (js/input.js's behaviour, kept). The addEventListener guard is for the test
   * harnesses' element stubs, which do not all implement it.
   */
  function button(label, ariaLabel, onClick, d) {
    var b = el('button', {
      text: label,
      attrs: { type: 'button', 'aria-label': ariaLabel }
    }, d);
    if (typeof onClick === 'function') {
      if (typeof b.addEventListener === 'function') b.addEventListener('click', onClick);
    } else if ('disabled' in b) {
      b.disabled = true;
    }
    return b;
  }

  /* Remove every child. Loop + removeChild rather than textContent = '' so the
     intent is unmistakable at the call site and no innerHTML-shaped line exists to
     be "simplified" into one later. */
  function empty(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  window.BadgeDom = { el: el, button: button, empty: empty, doc: doc };
})(typeof window !== 'undefined' ? window : globalThis);
