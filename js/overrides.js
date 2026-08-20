/*
 * js/overrides.js — window.BadgeOverrides
 *
 * Per-badge font-size override UI. One attendee at a time: nudge that badge's
 * computed sizes up or down in 0.5 pt steps, or reset it back to automatic.
 *
 * WHAT THIS MODULE DOES *NOT* DO — on purpose:
 *   - It does not size or clamp anything. `BadgeLayout.layout(attendee, override)`
 *     owns the whole overflow algorithm AND the max/floor clamp. This file only
 *     hands it a step count and reads `appliedSizes` back out. Re-deriving sizes
 *     here is exactly how the preview and the PDF would come to disagree.
 *   - It does not touch localStorage. `BadgeStore` owns persistence.
 *   - It does not re-render the preview. Writing through the store emits
 *     `override:changed`, and the preview listens for that.
 *
 * OVERRIDE SHAPE (fixed by the contract): { first:n, last:n, company:n, title:n }
 * where each n is a signed integer count of 0.5 pt STEPs.
 *
 * DEAD-BUTTON PROBLEM. A nudge can legitimately have zero visible effect, for
 * THREE different reasons the engine owns:
 *   1. the per-field ceiling / floor clamp;
 *   2. the vertical-fit pass clawing a size back down so the block fits the cell;
 *   3. clip avoidance — an upward nudge that would push a word past the box is
 *      capped at the largest size that still renders every character, so a +0.5 pt
 *      click cannot silently delete the tail of a company name.
 * Rather than let the user hammer a button that does nothing, every control is
 * PROBED before it is drawn: we run layout() with the prospective override and
 * enable the button only if the applied size actually moves. Never infer a size
 * from the step count — a requested nudge is not necessarily a granted one.
 * The reason a field will not move is shown next to it (max / floor / capped /
 * held), and layout()'s own warnings are printed under the controls, because the
 * remaining truncation case (one unbreakable word wider than the box even at the
 * floor) must be seen BEFORE the sheet goes on the printer, not after.
 *
 * Classic script. No ES modules, no network, no innerHTML. Works under file://.
 */
(function (window) {
  'use strict';

  var PANEL_ID = 'override-panel';
  var SHEET_PANEL_ID = 'sheet-panel';   // sheet-wide group: text alignment + logo reserve + sheet layout
  var SELECT_ID = 'override-attendee';
  var FIELDS = ['first', 'last', 'company', 'title'];
  var LABELS = { first: 'First name', last: 'Last name', company: 'Company', title: 'Title' };
  var EPS = 1e-9;

  /* ------------------------------------------------------------------ state */

  var els = null;          // built DOM references, or null before mount()
  var selectedId = null;   // attendee id currently being adjusted
  var rosterSig = null;    // signature of the <select> contents, to avoid rebuilding it
  var busy = false;        // re-entrancy guard: our writes come back as store events
  var unsubscribe = null;

  /* -------------------------------------------------------------- utilities */

  function doc() {
    return window.document || null;
  }

  /* Dependencies are resolved on every use, never cached: script order and test
     harnesses both swap these globals out from under us. */
  function deps() {
    var missing = [];
    if (!window.BadgeStore) missing.push('BadgeStore');
    if (!window.BadgeLayout || typeof window.BadgeLayout.layout !== 'function') {
      missing.push('BadgeLayout');
    }
    if (!window.BadgeSpec) missing.push('BadgeSpec');
    if (missing.length) {
      console.warn(
        '[BadgeOverrides] not starting — missing ' + missing.join(', ') +
          '. Font-size overrides are unavailable; the rest of the app is unaffected.'
      );
      return null;
    }
    return { store: window.BadgeStore, layout: window.BadgeLayout, spec: window.BadgeSpec };
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  /* The sheet-wide settings (text alignment, logo reserve, sheet layout) live in
     js/sheet-settings.js. This module does NOT resolve them itself: it asks for the
     single options object that module hands to BadgeLayout.layout(), so the per-badge
     readout here and the sheet panel there cannot be laid out against different
     settings. A missing module degrades to null, which layout() reads as "spec
     defaults" - the same shape of degradation as a missing store. */
  var warnedNoSheet = false;
  function sheetSettings() {
    var SS = window.BadgeSheetSettings;
    if (!SS) {
      if (!warnedNoSheet) {
        warnedNoSheet = true;
        console.warn('[BadgeOverrides] window.BadgeSheetSettings is missing - load ' +
          'js/sheet-settings.js. Sizes shown here will assume the spec defaults, which ' +
          'may not match the sheet.');
      }
      return null;
    }
    return SS;
  }
  function sheetLayoutOpts() {
    var SS = sheetSettings();
    if (!SS || typeof SS.layoutOpts !== 'function') return null;
    try { return SS.layoutOpts(); } catch (err) { return null; }
  }

  /**
   * A step count is a WHOLE number of 0.5 pt steps. A fractional one (hand-edited
   * storage, or another writer) makes the engine produce an off-grid size like
   * 35.65 pt, which no readout can round without lying about what prints. Round
   * on every read so the number shown is always the number printed; render() also
   * heals the stored value so the engine itself stops seeing fractions.
   */
  function steps(v) {
    return Math.round(num(v));
  }

  /**
   * The override for `id`, or null — read from the OWN-KEYS map, never by
   * truthiness of getOverride(). An id like `__proto__`, `constructor`,
   * `toString` or `valueOf` makes a plain-object lookup return an INHERITED
   * value, which reads as "this badge has an override" forever: Reset lights up,
   * clearOverride() reports false, and the panel shows sizes the printer never
   * gets. getOverrides() is built from own keys only, so this cannot happen.
   */
  function ownOverride(d, id) {
    var map;
    try {
      map = d.store.getOverrides() || {};
    } catch (err) {
      return null;
    }
    var key = String(id);
    if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
    var o = map[key];
    return o && typeof o === 'object' ? o : null;
  }

  /* Ids whose override the store demonstrably cannot persist (see nudge()). */
  var unpersistable = Object.create(null);

  function fmt(pt) {
    return (Math.round(pt * 10) / 10).toFixed(1);
  }

  function signed(n) {
    return n > 0 ? '+' + n : String(n);
  }

  function attendeeLabel(a) {
    var name = [a.first, a.last].join(' ').replace(/\s+/g, ' ').trim();
    if (!name) name = '(unnamed)';
    var org = String(a.company || '').replace(/\s+/g, ' ').trim();
    return org ? name + ' — ' + org : name;
  }

  /* layout() throws when InterMetrics is absent (by design — it refuses to guess
     widths). Never let that take the panel down.

     `opts` carries the logo reserve. It MUST be passed on every call, including the
     probes: a readout computed without it would advertise sizes that differ from
     what actually prints, which is worse than showing nothing. */
  function safeLayout(d, attendee, override, opts) {
    try {
      return d.layout.layout(attendee, override, opts);
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeLayout.layout() failed:', err && err.message);
      return null;
    }
  }

  function hasLine(res, field) {
    for (var i = 0; i < res.lines.length; i++) {
      if (res.lines[i].field === field) return true;
    }
    return false;
  }

  /**
   * The "visible skeleton" of a string: every character that normalization on
   * EITHER side might legitimately add, drop, or rewrite, removed.
   *
   * WHY NOT MIRROR layout.js's clean(): a second copy of its character classes
   * drifts the moment either side changes, and a drifted copy produces a FALSE
   * "text cut off" on text that prints perfectly — which is far worse than
   * missing a real one. (A non-breaking space pasted from a spreadsheet is the
   * likeliest invisible character in this data, and layout.js deliberately KEEPS
   * U+00A0 while stripping U+200B, so a naive `\s+` collapse disagrees with it on
   * text that looks identical on screen.)
   *
   * Instead this removes a deliberate SUPERSET — all whitespace, all zero-width
   * and formatting characters, the soft hyphen, the BOM, and the ellipsis — from
   * BOTH sides before comparing. Any character whose handling either side might
   * change is therefore ignored on both sides, so the comparison cannot drift.
   * Truncation always removes ordinary letters, never only invisibles, so it is
   * still detected exactly.
   */
  /* Written as explicit escapes so the class is auditable and cannot be mangled
     by an editor or a copy/paste that eats invisible characters. */
  var SKELETON_RE = new RegExp(
    '[' +
      '\\s' +                    // every Unicode whitespace (incl. U+00A0, U+2007, U+202F)
      '\\u00AD' +                // soft hyphen
      '\\u034F' +                // combining grapheme joiner
      '\\u061C' +                // Arabic letter mark
      '\\u180E' +                // Mongolian vowel separator
      '\\u200B-\\u200F' +        // zero-width space/joiners, LRM, RLM
      '\\u202A-\\u202E' +        // bidi embeddings and overrides
      '\\u2060-\\u2064' +        // word joiner, invisible operators
      '\\u2066-\\u2069' +        // bidi isolates
      '\\uFEFF' +                // BOM / zero-width no-break space
      '\\u2026' +                // the ellipsis the engine appends when it clips
    ']',
    'g'
  );

  function visibleSkeleton(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(SKELETON_RE, '');
  }

  /** The text the engine actually emitted for one field, rejoined. */
  function emittedText(res, field) {
    var parts = [];
    for (var i = 0; i < res.lines.length; i++) {
      if (res.lines[i].field === field) parts.push(res.lines[i].text);
    }
    return parts.length ? parts.join(' ') : null;
  }

  /** How many real (visible) characters this field prints. */
  function printedCharCount(res, field) {
    var t = emittedText(res, field);
    return t === null ? 0 : visibleSkeleton(t).length;
  }

  /**
   * Did this field actually lose characters on the badge? Observation, not prose.
   */
  function fieldTruncated(res, field, sourceText) {
    var t = emittedText(res, field);
    if (t === null) return false;
    return visibleSkeleton(t) !== visibleSkeleton(sourceText);
  }

  /** How many visible characters were dropped (0 when nothing was lost). */
  function lostCharCount(res, field, sourceText) {
    var t = emittedText(res, field);
    if (t === null) return 0;
    var lost = visibleSkeleton(sourceText).length - visibleSkeleton(t).length;
    return lost > 0 ? lost : 0;
  }

  /* Warnings layout() raised about one field, matched on the field name it puts in
     its own messages. Used only to CHOOSE WORDING for a state already established
     by measurement, so a reworded warning downgrades the copy, never the state. */
  function warningsFor(res, field) {
    var out = [];
    for (var i = 0; i < (res.warnings || []).length; i++) {
      var w = String(res.warnings[i]);
      if (w.indexOf(field) !== -1) out.push(w);
    }
    return out;
  }

  function mentionsCap(res, field) {
    var w = warningsFor(res, field);
    for (var i = 0; i < w.length; i++) {
      if (/capped/i.test(w[i])) return true;
    }
    return false;
  }

  /* -------------------------------------------------------- override algebra */

  /* Clamp a step count to the range that can actually reach a different size for
     this field, given its automatic size. Outside this range the count is stored
     but inert, which is what makes reverse nudges feel broken. */
  function clampSteps(d, autoSizes, field, n) {
    var lo = (d.spec.FLOORS[field] - autoSizes[field]) / d.spec.STEP;
    var hi = (d.spec.SIZES[field] - autoSizes[field]) / d.spec.STEP;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return Math.round(n);
  }

  /* A full four-field override with `delta` steps added to each of `fields`. */
  function withDelta(d, autoSizes, override, fields, delta) {
    var out = {};
    var i;
    // steps(), not num(): a fractional stored count would otherwise survive into
    // the probe and produce an off-grid size the readout cannot state honestly.
    for (i = 0; i < FIELDS.length; i++) out[FIELDS[i]] = steps(override[FIELDS[i]]);
    for (i = 0; i < fields.length; i++) {
      out[fields[i]] = clampSteps(d, autoSizes, fields[i], out[fields[i]] + delta);
    }
    return out;
  }

  function allZero(override) {
    for (var i = 0; i < FIELDS.length; i++) {
      if (num(override[FIELDS[i]]) !== 0) return false;
    }
    return true;
  }

  /* Does nudging `fields` by `delta` change any of THEIR applied sizes? */
  function moves(d, attendee, autoSizes, override, current, fields, delta, opts) {
    var probe = withDelta(d, autoSizes, override, fields, delta);
    var res = safeLayout(d, attendee, probe, opts);
    if (!res) return false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (Math.abs(res.appliedSizes[f] - current.appliedSizes[f]) > EPS) return true;
    }
    return false;
  }

  /* Everything the view needs for one attendee, all of it read out of layout(). */
  function buildModel(d, attendee) {
    var override = ownOverride(d, attendee.id) || {};
    /* The logo reserve narrows the lines level with it, so it changes the applied
       sizes, and the alignment travels with it for the same reason: the panel must
       describe the sheet that is actually going to print. Both come from
       js/sheet-settings.js as ONE object, and every call below — auto, current, and
       every probe — gets that same object, or the readout would describe a sheet
       nobody is printing. */
    var opts = sheetLayoutOpts();
    var SS = sheetSettings();
    var sheetLogo = SS ? SS.logo() : null;
    var alignState = (SS && typeof SS.alignState === 'function')
      ? SS.alignState()
      : { value: null, unavailable: true };
    var auto = safeLayout(d, attendee, null, opts);
    var current = safeLayout(d, attendee, override, opts);
    if (!auto || !current) return null;

    var rows = [];
    var canGrowAny = false;
    var canShrinkAny = false;
    var truncatedAny = false;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var printed = hasLine(current, f);
      var size = current.appliedSizes[f];
      var atMax = size >= d.spec.SIZES[f] - EPS;
      var atFloor = size <= d.spec.FLOORS[f] + EPS;
      var sizeMoves = printed && moves(d, attendee, auto.appliedSizes, override, current, [f], 1, opts);
      var canShrink = printed && moves(d, attendee, auto.appliedSizes, override, current, [f], -1, opts);

      /* Would ONE more step up cost characters? Distinguishes "capped to keep your
         text" from "held so the badge fits". */
      var upProbe = safeLayout(d, attendee, withDelta(d, auto.appliedSizes, override, [f], 1), opts);
      var growWouldClip = printed && !sizeMoves && mentionsCap(upProbe || current, f);

      /* A field that ALREADY clips at its auto size is exempt from the engine's
         clip guard, so growing it is permitted — and every step up drops MORE
         characters (one long pasted word goes 13 pt/38 chars -> 21 pt/22 chars).
         The user has no reason to want fewer characters, so refuse the increase
         here. This is the one case where "the size would move" is not enough. */
      var printedNow = printedCharCount(current, f);
      var growDropsChars = printed && sizeMoves && !!upProbe && printedCharCount(upProbe, f) < printedNow;
      var canGrow = sizeMoves && !growDropsChars;

      /* What the stored step count ASKED for, clamped the way the engine clamps.
         If the applied size came out below this, the engine held the nudge back —
         either to keep every character or to keep the block inside the cell. */
      var stepCount = steps(override[f]);
      var requested = Math.min(
        d.spec.SIZES[f],
        Math.max(d.spec.FLOORS[f], auto.appliedSizes[f] + stepCount * d.spec.STEP)
      );
      var heldBack = printed && size < requested - EPS;
      var truncated = printed && fieldTruncated(current, f, attendee[f]);
      var lost = truncated ? lostCharCount(current, f, attendee[f]) : 0;

      var state = 'ok';
      if (!printed) state = 'blank';
      else if (truncated) state = 'truncated';   // the loud one: characters are gone
      else if (atMax) state = 'max';
      else if (atFloor) state = 'floor';
      else if (heldBack) state = mentionsCap(current, f) ? 'capped' : 'held';
      else if (growWouldClip || growDropsChars) state = 'capped';
      else if (!canGrow || !canShrink) state = 'held';

      if (canGrow) canGrowAny = true;
      if (canShrink) canShrinkAny = true;
      if (truncated) truncatedAny = true;

      rows.push({
        field: f,
        steps: stepCount,
        size: size,
        autoSize: auto.appliedSizes[f],
        requested: requested,
        printed: printed,
        atMax: atMax,
        atFloor: atFloor,
        heldBack: heldBack,
        truncated: truncated,
        lostChars: lost,
        printedChars: printedNow,
        canGrow: canGrow,
        canShrink: canShrink,
        growWouldClip: growWouldClip,
        growDropsChars: growDropsChars,
        state: state
      });
    }

    return {
      attendee: attendee,
      override: override,
      hasOverride: !!ownOverride(d, attendee.id),
      /* True once a write for this id has been observed not to stick. */
      unpersistable: !!unpersistable[String(attendee.id)],
      autoSizes: auto.appliedSizes,
      rows: rows,
      fits: current.fits,
      warnings: current.warnings || [],
      truncatedAny: truncatedAny,
      logo: sheetLogo,
      align: alignState.value,
      alignUnavailable: !!alignState.unavailable,
      logoOpts: opts,
      /* Per-line horizontal geometry. `center` shows which lines the reserve
         actually narrowed (they recenter left of the unaffected ones); `x` is the
         left edge, which under left alignment is the same INSET for every line. */
      lineCenters: current.lines.map(function (l) {
        return {
          field: l.field,
          x: l.x,
          center: l.x + (l.lineWidth || 0) / 2,
          width: l.lineWidth || 0
        };
      }),
      /* Enabled iff the click changes something: the whole-badge nudge only moves
         the fields that can actually move (see nudge()). */
      canGrowAll: canGrowAny,
      canShrinkAll: canShrinkAny
    };
  }

  /* ------------------------------------------------------------ DOM plumbing */

  /* Shared with js/input.js via js/dom.js (window.BadgeDom) — see the note there.
     Thin wrappers, so no call site in this file changes. */
  function dom() {
    var D = window.BadgeDom;
    if (!D) throw new Error('BadgeOverrides: window.BadgeDom is missing - load js/dom.js first.');
    return D;
  }
  function el(tag, opts) { return dom().el(tag, opts, doc()); }

  /* Never innerHTML — not even for clearing. */
  function empty(node) { dom().empty(node); }

  function button(label, aria, onClick) { return dom().button(label, aria, onClick, doc()); }

  /* Insert our own container into the side panel, immediately after the attendee
     list. We never write into #attendee-list itself — another item owns its rows. */
  function containerParent(document) {
    return document.getElementById('side-panel') || document.body || null;
  }

  function createPanel(document) {
    var existing = document.getElementById(PANEL_ID);
    if (existing) {
      empty(existing);
      return existing;
    }
    var panel = el('div', { id: PANEL_ID });
    var parent = containerParent(document);
    if (!parent) return null;
    var list = document.getElementById('attendee-list');
    if (list && list.parentNode === parent) {
      parent.insertBefore(panel, list.nextSibling);
    } else {
      parent.appendChild(panel);
    }
    return panel;
  }

  /**
   * Empty a previously built panel and detach it, unless it IS the node we are
   * about to reuse. Ids in this module are unique by contract, so two live copies
   * of the same panel must never coexist.
   */
  function retirePanel(oldNode, newNode) {
    if (!oldNode || oldNode === newNode) return;
    empty(oldNode);
    if (oldNode.parentNode && typeof oldNode.parentNode.removeChild === 'function') {
      oldNode.parentNode.removeChild(oldNode);
    }
  }

  /* ------------------------------------------------------------------- build */

  var WHOLE_HINT_DEFAULT = 'Moves all four lines of this badge together, 0.5 pt per click.';
  /* Auto-size is by construction the largest non-clipping size, and the ceilings
     are hard, so for most badges the control is legitimately shrink-only. Say so
     rather than leaving a permanently disabled button looking broken. */
  var WHOLE_HINT_SHRINK_ONLY =
    'Auto is already the largest size that fits — you can only reduce. 0.5 pt per click.';

  /* Presentation for this panel lives in styles.css (the "override panel" section).
     Only genuinely dynamic styling stays in JS - see show(). */
  var ROW_CLASS = 'ov-row';

  function buildSkeleton(panel) {
    var refs = { panel: panel, fieldRows: {} };

    panel.appendChild(el('h2', { text: 'Font size override' }));

    // ---- attendee picker ----------------------------------------------
    var pickWrap = el('div', { className: 'ov-pick' });
    pickWrap.appendChild(
      el('label', { text: 'Adjust which badge', attrs: { for: SELECT_ID } })
    );
    refs.select = el('select', { id: SELECT_ID, attrs: { 'aria-label': 'Attendee to adjust' } });
    refs.select.addEventListener('change', function () {
      selectedId = refs.select.value || null;
      render();
    });
    pickWrap.appendChild(refs.select);
    panel.appendChild(pickWrap);

    // ---- empty-state note ---------------------------------------------
    refs.emptyNote = el('p', {
      text: 'Add an attendee to adjust their badge type sizes.',
      className: 'ov-empty-note'
    });
    panel.appendChild(refs.emptyNote);

    // ---- body (hidden when there is nobody to adjust) -----------------
    refs.body = el('div');

    // whole-badge nudge: the primary control
    var whole = el('div', { className: 'ov-whole' });
    refs.smallerAll = button('− Smaller', 'Make the whole badge smaller by 0.5 pt', function () {
      nudge(FIELDS, -1);
    });
    refs.biggerAll = button('+ Bigger', 'Make the whole badge bigger by 0.5 pt', function () {
      nudge(FIELDS, 1);
    });
    whole.appendChild(refs.smallerAll);
    whole.appendChild(refs.biggerAll);
    refs.body.appendChild(whole);

    refs.wholeHint = el('p', {
      text: WHOLE_HINT_DEFAULT,
      attrs: { 'data-role': 'whole-hint' },
      className: 'ov-hint'
    });
    refs.body.appendChild(refs.wholeHint);

    // per-field rows: applied size + pinned state + fine control
    var head = el('div', { className: ROW_CLASS });
    head.appendChild(
      el('span', {
        text: 'Applied sizes',
        className: 'ov-row-head'
      })
    );
    refs.body.appendChild(head);

    for (var i = 0; i < FIELDS.length; i++) {
      refs.fieldRows[FIELDS[i]] = buildFieldRow(refs.body, FIELDS[i]);
    }

    // layout() warnings, verbatim. Grey + rule rather than a colour, to stay with
    // the shell's deliberately colourless palette; weight and position carry it.
    refs.warnings = el('div', {
      attrs: { role: 'alert', 'data-role': 'layout-warnings' },
      className: 'ov-warnings',
      /* display ONLY - the appearance is in styles.css. show() toggles this inline
         value, so styles.css must not set `display` for .ov-warnings or the inline ''
         show() writes would lose to it. */
      style: { display: 'none' }
    });
    refs.body.appendChild(refs.warnings);

    // status + reset
    refs.status = el('p', {
      className: 'ov-status',
      attrs: { role: 'status', 'aria-live': 'polite' }
    });
    refs.body.appendChild(refs.status);

    refs.reset = button('Reset to auto', 'Reset this badge to automatic sizes', function () {
      resetSelected();
    });
    refs.reset.className = 'ov-reset';
    refs.body.appendChild(refs.reset);

    panel.appendChild(refs.body);
    return refs;
  }

  function buildFieldRow(parent, field) {
    var row = el('div', { className: ROW_CLASS, attrs: { 'data-field': field } });

    var name = el('span', {
      text: LABELS[field],
      className: 'ov-row-name'
    });
    var size = el('span', { className: 'ov-row-size' });
    /* Not uppercased: these labels are sentences ("capped to keep text"), and
       uppercase micro-type wraps them onto a second line in a 360 px panel. */
    var badge = el('span', { className: 'ov-row-badge' });
    var minus = button('−', 'Make ' + LABELS[field].toLowerCase() + ' smaller', function () {
      nudge([field], -1);
    });
    var plus = button('+', 'Make ' + LABELS[field].toLowerCase() + ' bigger', function () {
      nudge([field], 1);
    });

    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(badge);
    row.appendChild(minus);
    row.appendChild(plus);
    parent.appendChild(row);

    return { row: row, size: size, badge: badge, minus: minus, plus: plus };
  }

  /* ------------------------------------------------------------------ render */

  function rosterSignature(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      parts.push(list[i].id + '' + attendeeLabel(list[i]));
    }
    return parts.join('');
  }

  function syncSelect(list) {
    var sig = rosterSignature(list);
    if (sig === rosterSig) {
      if (selectedId) els.select.value = selectedId;
      return;
    }
    rosterSig = sig;
    empty(els.select);
    for (var i = 0; i < list.length; i++) {
      // textContent, never innerHTML: a name containing markup must render literally.
      var opt = el('option', { text: attendeeLabel(list[i]) });
      opt.value = list[i].id;
      if (list[i].id === selectedId) opt.selected = true;
      els.select.appendChild(opt);
    }
    els.select.value = selectedId || '';
  }

  /* Badge text + tooltip for why a field is where it is, and why it will not move.
     The wording is deliberately about consequences ("would cut characters off"),
     not mechanism — this is read by someone about to print an Avery sheet. */
  function stateText(row) {
    var name = LABELS[row.field].toLowerCase();
    if (row.state === 'blank') {
      return { text: 'not printed', tip: 'This field is empty, so it has no line on the badge.' };
    }
    if (row.state === 'truncated') {
      var n = row.lostChars;
      var howMany = n > 0 ? n + ' character' + (n === 1 ? '' : 's') : 'some characters';
      /* Say WHICH pinned state also applies, so a real "at max" is not masked. */
      var also = row.atMax ? ' at max' : row.atFloor ? ' at floor' : '';
      return {
        text: 'text cut off' + (n > 0 ? ' (−' + n + ')' : '') + also,
        tip:
          'The ' + name + ' does not fit the badge at ' + fmt(row.size) + ' pt, so ' +
          howMany + ' are not printed' +
          (row.growDropsChars ? '. Making it larger would cut off even more' : '') +
          '. Shortening the text is the only real fix.'
      };
    }
    if (row.state === 'max') {
      return { text: 'at max', tip: 'Pinned at the ' + fmt(row.size) + ' pt ceiling — it cannot go larger.' };
    }
    if (row.state === 'floor') {
      return { text: 'at floor', tip: 'Pinned at the ' + fmt(row.size) + ' pt floor — it cannot go smaller.' };
    }
    if (row.state === 'capped') {
      if (row.growDropsChars) {
        return {
          text: 'capped — larger loses text',
          tip:
            'Held at ' + fmt(row.size) + ' pt: this ' + name + ' already does not fit, and ' +
            'every step larger removes more characters.'
        };
      }
      return {
        text: 'capped to keep text',
        tip:
          'Held at ' + fmt(row.size) + ' pt' +
          (row.heldBack ? ' rather than the ' + fmt(row.requested) + ' pt asked for' : '') +
          ': anything larger would cut characters off the ' + name + '.'
      };
    }
    if (row.state === 'held') {
      return {
        text: 'held to fit badge',
        tip:
          'Held at ' + fmt(row.size) + ' pt' +
          (row.heldBack ? ' rather than the ' + fmt(row.requested) + ' pt asked for' : '') +
          ' so the whole block still fits inside the badge.'
      };
    }
    if (row.steps !== 0) {
      return {
        text: signed(row.steps) + ' step' + (Math.abs(row.steps) === 1 ? '' : 's') + ' from auto ' + fmt(row.autoSize),
        tip: 'Automatic size is ' + fmt(row.autoSize) + ' pt; you set ' + fmt(row.size) + ' pt.'
      };
    }
    return { text: 'auto', tip: 'Automatically sized by the fit engine.' };
  }

  /* A disabled button must say why IT is disabled, which is not always the same as
     the row's headline state (a truncated field can still be resizable). */
  function buttonTip(row, up) {
    var name = LABELS[row.field].toLowerCase();
    if (up) {
      if (row.canGrow) return 'Bigger by 0.5 pt';
      if (!row.printed) return 'This field is empty, so there is nothing to resize.';
      if (row.growDropsChars) {
        return 'Cannot go larger: the ' + name + ' already does not fit, and a bigger size ' +
          'would drop even more characters.';
      }
      if (row.growWouldClip) return 'Cannot go larger: it would cut characters off the ' + name + '.';
      if (row.atMax) return 'Already at the ' + fmt(row.size) + ' pt ceiling for the ' + name + '.';
      return 'Cannot go larger: the block would no longer fit inside the badge.';
    }
    if (row.canShrink) return 'Smaller by 0.5 pt';
    if (!row.printed) return 'This field is empty, so there is nothing to resize.';
    if (row.atFloor) return 'Already at the ' + fmt(row.size) + ' pt floor for the ' + name + '.';
    return 'Cannot go smaller.';
  }

  function renderRows(model) {
    for (var i = 0; i < model.rows.length; i++) {
      var r = model.rows[i];
      var ui = els.fieldRows[r.field];
      var st = stateText(r);
      ui.size.textContent = r.printed ? fmt(r.size) + ' pt' : '—';
      ui.badge.textContent = st.text;
      ui.badge.setAttribute('title', st.tip);
      ui.row.setAttribute('data-state', r.state);
      ui.minus.disabled = !r.canShrink;
      ui.plus.disabled = !r.canGrow;
      // The disabled button still has to say why, for anyone hovering it.
      ui.minus.setAttribute('title', buttonTip(r, false));
      ui.plus.setAttribute('title', buttonTip(r, true));
    }
  }

  /**
   * Print layout()'s own warnings verbatim under the controls.
   *
   * The engine now prevents the silent case (an upward nudge that would cost
   * characters is capped instead of granted), but one truncation case survives by
   * necessity: a single unbreakable word wider than the box even at the floor size.
   * That badge prints with an ellipsis, and the only place the user can find out
   * before the sheet is on the printer is right here.
   */
  function renderWarnings(model) {
    var box = els.warnings;
    empty(box);
    var list = model.warnings || [];
    /* Show the box whenever text is being lost, even if the engine had nothing to
       say — a frightening row label with no explanation anywhere is worse than
       either one alone. */
    if (!list.length && !model.truncatedAny) {
      show(box, false);
      return;
    }
    show(box, true);
    box.appendChild(
      el('strong', {
        text: model.truncatedAny ? 'Text is being cut off on this badge' : 'Sizing notes for this badge',
        className: 'ov-warn-title'
      })
    );
    var ul = el('ul', { className: 'ov-warn-list' });
    for (var i = 0; i < list.length; i++) {
      // textContent: warnings quote attendee text, which may contain markup.
      ul.appendChild(el('li', { text: String(list[i]) }));
    }
    box.appendChild(ul);
    if (model.truncatedAny) {
      box.appendChild(
        el('span', {
          text: 'Shorten the text — no font size will fit it.',
          className: 'ov-warn-more'
        })
      );
    }
  }

  /**
   * One short line. Deliberately a SUMMARY, not a roll-call: listing all four
   * fields produced "Pinned: first name capped to keep text, last name capped to
   * keep text, company capped to keep text, title capped to keep text." on a
   * perfectly ordinary badge, which buried the messages that matter. The per-row
   * labels already carry the detail; this says only what the rows cannot.
   */
  function statusLine(model) {
    var printed = 0;
    var atCeiling = 0;   // max, or capped/held at the largest size that fits
    var i;
    for (i = 0; i < model.rows.length; i++) {
      var r = model.rows[i];
      if (!r.printed) continue;
      printed++;
      if (r.state === 'max' || r.state === 'capped' || (r.state === 'held' && !r.canGrow)) atCeiling++;
    }

    var bits = [];
    bits.push(model.unpersistable
      ? 'Sizes cannot be saved for this attendee.'
      : model.hasOverride ? 'Manual size override in effect.' : 'Sizes are automatic.');

    if (printed > 0 && atCeiling === printed && !model.hasOverride) {
      // The resting state for most badges: auto IS the largest size that fits.
      bits.push('Auto is already the largest size that fits — you can only reduce.');
    } else if (atCeiling > 0 && atCeiling < printed) {
      bits.push(atCeiling + ' of ' + printed + ' lines are already as large as they fit.');
    }

    // Truncation is called out by renderWarnings(); don't say "does not fit" twice.
    if (!model.fits && !model.warnings.length && !model.truncatedAny) {
      bits.push('This badge does not fit cleanly — see the preview.');
    }
    return bits.join(' ');
  }

  function show(node, visible) {
    node.style.display = visible ? '' : 'none';
  }

  function render() {
    if (!els) return;
    var d = deps();
    if (!d) return;

    var list = [];
    try {
      list = d.store.getAttendees() || [];
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.getAttendees() failed:', err && err.message);
      list = [];
    }

    // A stale override for a deleted attendee is dead weight. Drop it here — this is
    // the one place that reliably sees roster changes — and re-enter safely.
    if (!busy) {
      busy = true;
      try {
        pruneStaleOverrides(d, list);
        healFractionalOverrides(d, list);
      } finally {
        busy = false;
      }
    }

    // Keep the selection valid across deletions and reorders.
    var found = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === selectedId) found = list[i];
    }
    if (!found) {
      selectedId = list.length ? list[0].id : null;
      found = list.length ? list[0] : null;
    }

    syncSelect(list);

    if (!found) {
      show(els.emptyNote, true);
      show(els.body, false);
      return;
    }
    show(els.emptyNote, false);
    show(els.body, true);

    var model = buildModel(d, found);
    if (!model) {
      // Metrics missing: say so instead of showing numbers we cannot compute.
      els.status.textContent = 'Type metrics are unavailable, so sizes cannot be shown.';
      show(els.warnings, false); // never leave the previous badge's warnings standing
      els.smallerAll.disabled = true;
      els.biggerAll.disabled = true;
      els.reset.disabled = true;
      for (var f = 0; f < FIELDS.length; f++) {
        var ui = els.fieldRows[FIELDS[f]];
        ui.size.textContent = '—';
        ui.badge.textContent = '';
        ui.minus.disabled = true;
        ui.plus.disabled = true;
      }
      return;
    }

    renderRows(model);
    renderWarnings(model);
    els.wholeHint.textContent = model.canGrowAll ? WHOLE_HINT_DEFAULT : WHOLE_HINT_SHRINK_ONLY;
    els.smallerAll.disabled = !model.canShrinkAll;
    els.biggerAll.disabled = !model.canGrowAll;
    els.reset.disabled = !model.hasOverride;
    els.status.textContent = statusLine(model);
  }

  /**
   * Rewrite any stored override that carries a fractional step count, so the
   * ENGINE stops producing off-grid sizes (a stored -0.7 yields 35.65 pt, which
   * the panel could only display by rounding — i.e. by lying about what prints).
   * Reads round defensively too; this heals the stored value once and for all.
   * Returns the ids rewritten.
   */
  function healFractionalOverrides(d, list) {
    var fixed = [];
    for (var i = 0; i < list.length; i++) {
      var id = String(list[i].id);
      var o = ownOverride(d, id);
      if (!o) continue;
      var next = {};
      var dirty = false;
      for (var k = 0; k < FIELDS.length; k++) {
        var f = FIELDS[k];
        var raw = o[f];
        next[f] = steps(raw);
        if (typeof raw === 'number' && isFinite(raw) && raw !== next[f]) dirty = true;
      }
      if (!dirty) continue;
      try {
        if (allZero(next)) d.store.clearOverride(id);
        else d.store.setOverride(id, next);
        fixed.push(id);
      } catch (err) {
        console.warn('[BadgeOverrides] could not normalize a fractional override:', err && err.message);
      }
    }
    if (fixed.length) {
      console.warn(
        '[BadgeOverrides] rounded off-grid font-size override(s) to whole 0.5 pt steps for: ' +
          fixed.join(', ') + '.'
      );
    }
    return fixed;
  }

  /* Remove overrides whose attendee no longer exists. Returns the ids dropped. */
  function pruneStaleOverrides(d, list) {
    var live = Object.create(null);
    var i;
    for (i = 0; i < list.length; i++) live[list[i].id] = true;
    var map;
    try {
      map = d.store.getOverrides() || {};
    } catch (err) {
      return [];
    }
    var ids = Object.keys(map);
    var dropped = [];
    for (i = 0; i < ids.length; i++) {
      if (!live[ids[i]]) {
        try {
          d.store.clearOverride(ids[i]);
          dropped.push(ids[i]);
        } catch (err) {
          console.warn('[BadgeOverrides] could not clear stale override:', err && err.message);
        }
      }
    }
    return dropped;
  }

  /* ------------------------------------------------------------------ actions */

  function selectedAttendee(d) {
    var list = d.store.getAttendees() || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === selectedId) return list[i];
    }
    return null;
  }

  function nudge(fields, delta) {
    var d = deps();
    if (!d) return false;
    var attendee = selectedAttendee(d);
    if (!attendee) return false;
    var opts = sheetLayoutOpts(); // same opts the readout used
    var auto = safeLayout(d, attendee, null, opts);
    if (!auto) return false;
    var override = ownOverride(d, attendee.id) || {};
    var current = safeLayout(d, attendee, override, opts);
    if (!current) return false;
    var id = String(attendee.id);
    if (unpersistable[id]) return false; // already proven unwritable; don't pretend

    /* Only move the fields that CAN move. The engine may refuse an increase to
       avoid cutting characters (or to keep the block in the cell), and a step
       count stored for a field that ignores it is a trap: the reverse nudge then
       needs N dead clicks before anything happens. Filtering here keeps every
       stored count inside the range that actually does something — which is what
       lets the buttons stay honest about being live. */
    var movable = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!moves(d, attendee, auto.appliedSizes, override, current, [f], delta, opts)) continue;
      /* An increase that would drop characters is refused even though the size
         moves — see buildModel(). Growing an already-clipping field only deletes
         more of the name. */
      if (delta > 0) {
        var probe = safeLayout(d, attendee, withDelta(d, auto.appliedSizes, override, [f], delta), opts);
        if (probe && printedCharCount(probe, f) < printedCharCount(current, f)) continue;
      }
      movable.push(f);
    }
    if (!movable.length) return false;

    var next = withDelta(d, auto.appliedSizes, override, movable, delta);
    // Writing through the store persists it AND emits override:changed, which is
    // what makes the preview and the PDF pick the change up.
    var wantCleared = allZero(next);
    if (wantCleared) d.store.clearOverride(id);
    else d.store.setOverride(id, next);

    /* Verify the write actually landed. A store backed by a plain object silently
       drops ids that collide with Object.prototype members, which would leave the
       buttons looking live while nothing ever changes. One failed write is enough
       to mark the id and explain it in the panel instead. */
    var after = ownOverride(d, id);
    var landed = wantCleared ? after === null : !!after && sameSteps(after, next);
    if (!landed) {
      unpersistable[id] = true;
      console.warn(
        '[BadgeOverrides] BadgeStore could not save an override for id "' + id +
          '" (it collides with a built-in object property). Per-badge sizes are ' +
          'disabled for this attendee; re-adding them will give a usable id.'
      );
      render();
      return false;
    }
    return true;
  }

  /** Do two override objects carry the same step counts on all four fields? */
  function sameSteps(a, b) {
    for (var i = 0; i < FIELDS.length; i++) {
      if (steps(a[FIELDS[i]]) !== steps(b[FIELDS[i]])) return false;
    }
    return true;
  }

  function resetSelected() {
    var d = deps();
    if (!d || !selectedId) return false;
    // Only claim success if there was really an own override to clear.
    if (!ownOverride(d, selectedId)) return false;
    d.store.clearOverride(selectedId);
    return ownOverride(d, selectedId) === null;
  }

  /* --------------------------------------------------------------- lifecycle */

  /* Deliberately NOT an allow-list. Sheet-wide settings arrive under event names
     other items choose, and a missed name means a panel showing stale numbers.
     Re-rendering on an unrelated notification costs a few microseconds. */
  function onStoreChange(change) {
    if (!els) return;
    if (busy) return; // our own prune/heal; render() is already in flight
    /* Any event re-renders: a sheet-wide change moves the applied sizes shown here, and
       js/sheet-settings.js re-renders its own controls off the same notification. */
    render();
  }

  /**
   * mount(opts) — build the panel and start listening. Idempotent.
   * opts.container (optional) lets a test mount into its own node.
   */
  function mount(opts) {
    var document = doc();
    if (!document || typeof document.createElement !== 'function') {
      console.warn('[BadgeOverrides] no document — nothing to mount.');
      return null;
    }
    var d = deps();
    if (!d) return null;

    var panel = (opts && opts.container) || createPanel(document);
    if (!panel) {
      console.warn('[BadgeOverrides] found no place to mount the override panel.');
      return null;
    }
    /* Retire whatever we built last time if it is not the node we are about to
       build into. Without this, mount({container:x}) abandoned the old panel in
       the document: two elements answering to id="override-attendee", both wired
       to this module's state, so a click in the stale one moved the live one. */
    retirePanel(els && els.panel, panel);
    empty(panel);
    els = buildSkeleton(panel);
    // The <select> we just built is empty, so the cached roster signature is a lie.
    // Forget it, or syncSelect() will skip the rebuild and leave the picker blank.
    rosterSig = null;

    /* The sheet-wide settings panel is a separate module with its own container,
       subscription and lifecycle (js/sheet-settings.js). Mounting it from here keeps
       every existing caller of BadgeOverrides.mount() - app.js and the test suite -
       working unchanged, and keeps the two panels' insertion order fixed in one place. */
    var SS = sheetSettings();
    if (SS && typeof SS.mount === 'function') {
      SS.mount({ container: opts && opts.logoContainer, after: panel });
    }

    if (unsubscribe) {
      try { unsubscribe(); } catch (err) { /* already detached */ }
      unsubscribe = null;
    }
    if (typeof d.store.subscribe === 'function') {
      unsubscribe = d.store.subscribe(onStoreChange);
    } else if (window.BadgeBus && typeof window.BadgeBus.on === 'function') {
      // Fallback path if a future store drops subscribe(): the bus carries the
      // same events.
      var offA = window.BadgeBus.on('data:changed', function () { onStoreChange({ type: 'data:changed' }); });
      var offB = window.BadgeBus.on('override:changed', function () { onStoreChange({ type: 'override:changed' }); });
      var offC = window.BadgeBus.on('logo:changed', function () { onStoreChange({ type: 'logo:changed' }); });
      var offD = window.BadgeBus.on('sheet:changed', function () { onStoreChange({ type: 'sheet:changed' }); });
      var offE = window.BadgeBus.on('preset:changed', function () { onStoreChange({ type: 'preset:changed' }); });
      var offF = window.BadgeBus.on('align:changed', function () { onStoreChange({ type: 'align:changed' }); });
      unsubscribe = function () { offA(); offB(); offC(); offD(); offE(); offF(); };
    }

    render();
    return panel;
  }

  function unmount() {
    if (unsubscribe) {
      try { unsubscribe(); } catch (err) { /* ignore */ }
      unsubscribe = null;
    }
    if (els && els.panel) empty(els.panel);
    var SS = window.BadgeSheetSettings;
    if (SS && typeof SS.unmount === 'function') SS.unmount();
    els = null;
    rosterSig = null;
  }

  window.BadgeOverrides = {
    mount: mount,
    unmount: unmount,
    // --- exposed for tests and for other items that need the same semantics ---
    select: function (id) {
      selectedId = id === null || id === undefined ? null : String(id);
      render();
      return selectedId;
    },
    selected: function () { return selectedId; },
    nudge: nudge,
    reset: resetSelected,
    /** The numbers currently on screen for one attendee, straight out of layout(). */
    inspect: function (attendee) {
      var d = deps();
      if (!d || !attendee) return null;
      return buildModel(d, attendee);
    },
    /** Drop overrides belonging to attendees that no longer exist. */
    pruneStale: function () {
      var d = deps();
      if (!d) return [];
      var list = [];
      try { list = d.store.getAttendees() || []; } catch (err) { list = []; }
      return pruneStaleOverrides(d, list);
    },
    /* Re-render this panel. Called by js/sheet-settings.js after a sheet-wide change,
       because the applied sizes shown here are computed WITH the alignment and reserve. */
    refresh: render,

    /* ---------------------------------------------------------------------------
     * SHEET-WIDE SETTINGS - delegated to window.BadgeSheetSettings.
     *
     * These moved to js/sheet-settings.js. They stay published here as thin pass-throughs
     * so existing callers (and test/overrides.test.js) keep working against one name
     * while the implementation lives in the right file. New code should call
     * window.BadgeSheetSettings directly; this surface is compatibility, not design.
     * Each returns null / [] / false when that module is absent, matching what the
     * inline versions did when their dependencies were missing.
     * ------------------------------------------------------------------------- */
    logo: function () {
      var SS = sheetSettings();
      return SS ? SS.logo() : null;
    },
    logoOpts: sheetLayoutOpts,
    setLogo: function (patch) {
      var SS = sheetSettings();
      return SS ? SS.setLogo(patch) : false;
    },
    clampInches: function (v, fallback) {
      var SS = sheetSettings();
      return SS ? SS.clampInches(v, fallback) : fallback;
    },
    align: function () {
      var SS = sheetSettings();
      return SS ? SS.align() : null;
    },
    aligns: function () {
      var SS = sheetSettings();
      return SS ? SS.aligns() : [];
    },
    setAlign: function (value) {
      var SS = sheetSettings();
      return SS ? SS.setAlign(value) : false;
    },
    sheetPreset: function () {
      var SS = sheetSettings();
      return SS ? SS.sheetPreset() : null;
    },
    sheetPresets: function () {
      var SS = sheetSettings();
      return SS ? SS.sheetPresets() : [];
    },
    setSheetPreset: function (key) {
      var SS = sheetSettings();
      return SS ? SS.setSheetPreset(key) : false;
    },
    FIELDS: FIELDS,
    PANEL_ID: PANEL_ID,
    SHEET_PANEL_ID: SHEET_PANEL_ID,
    LOGO_PANEL_ID: SHEET_PANEL_ID, // the logo controls live in the sheet-wide group
    /* Republished from js/sheet-settings.js, which owns the clamp range. */
    LOGO_LIMITS: (window.BadgeSheetSettings && window.BadgeSheetSettings.LOGO_LIMITS) ||
      { minIn: 0, maxIn: 4, stepIn: 0.25, ptPerIn: 72 }
  };
})(typeof window !== 'undefined' ? window : globalThis);
