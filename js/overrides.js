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

  /* ---- logo reserve (BADGE_SPEC.md addendum 2C) ---------------------------
     SHEET-WIDE, not per badge: one setting reserves the bottom-right corner of
     EVERY cell so text never prints over pre-printed logo stock. The store keeps
     inches; converting to points is the caller's job, so it is done here. */
  var PT_PER_IN = 72;
  var LOGO_MIN_IN = 0;
  var LOGO_MAX_IN = 4;
  var LOGO_STEP_IN = 0.25;
  var LOGO_DEFAULT = { enabled: false, wIn: 1, hIn: 1 };

  /* ---- text alignment (sheet-wide) ---------------------------------------
     LEFT by default (Julia's choice): all four lines share ONE left edge, and the
     resulting block is centred in the badge — "centred block, left-aligned text",
     not flush against the safety margin. The engine owns that arithmetic
     (blockLeft = spanLo + (spanWidth - widestLine)/2, clamped to the inset), so
     nothing here re-derives an x. 'center' is the old per-line centring. Like the
     logo reserve and the sheet layout this is ONE setting for every badge, never
     per attendee. BadgeSpec.ALIGNS / ALIGN_DEFAULT are the authority; the values
     below are only the fallback for a build where spec.js has not loaded. */
  var ALIGN_FALLBACK = ['left', 'center'];
  var ALIGN_FALLBACK_DEFAULT = 'left';
  var ALIGN_LABELS = {
    left: 'Left — all four lines share one left edge',
    center: 'Centred — each line centred on its own'
  };

  /* ------------------------------------------------------------------ state */

  var els = null;          // built DOM references, or null before mount()
  var logoEls = null;      // logo-reserve section refs (its own container)
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

  /* --------------------------------------------------------- logo reserve --- */

  var warnedNoLogoStore = false;

  /**
   * Coerce one dimension to inches. Strict on purpose: only real numbers and
   * numeric strings are accepted, so null / {} / [] / '' / 'abc' / NaN / Infinity
   * all fall back to `fallback` rather than being silently stored as 0.
   * In-range values are clamped to [0, 4] per the spec.
   */
  function clampInches(v, fallback) {
    var n;
    if (typeof v === 'number') {
      n = v;
    } else if (typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v.trim())) {
      n = Number(v.trim());
    } else {
      return fallback; // booleans, null, undefined, objects, arrays, junk strings
    }
    if (!isFinite(n)) return fallback; // NaN, +/-Infinity
    if (n < LOGO_MIN_IN) return LOGO_MIN_IN;
    if (n > LOGO_MAX_IN) return LOGO_MAX_IN;
    return n;
  }

  function normalizeLogo(raw, base) {
    var b = base || LOGO_DEFAULT;
    var o = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: o.enabled === true,
      wIn: clampInches(o.wIn, b.wIn),
      hIn: clampInches(o.hIn, b.hIn)
    };
  }

  /* The store owns this setting; getLogo() may not exist yet on older builds, in
     which case the feature reads as OFF rather than breaking the panel. */
  function logoConfig(d) {
    if (!d.store || typeof d.store.getLogo !== 'function') {
      if (!warnedNoLogoStore) {
        warnedNoLogoStore = true;
        console.warn(
          '[BadgeOverrides] BadgeStore.getLogo() is unavailable — treating the logo ' +
            'reserve as OFF. Badge sizes shown are for stock with no pre-printed logo.'
        );
      }
      return { enabled: false, wIn: LOGO_DEFAULT.wIn, hIn: LOGO_DEFAULT.hIn, unavailable: true };
    }
    try {
      return normalizeLogo(d.store.getLogo());
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.getLogo() threw:', err && err.message);
      return { enabled: false, wIn: LOGO_DEFAULT.wIn, hIn: LOGO_DEFAULT.hIn, unavailable: true };
    }
  }

  /* ---------------------------------------------------- sheet layout preset ---
     Where the whole 2x3 grid sits on the page. Sheet-wide, like the logo reserve,
     and nothing to do with badge CONTENT. BadgeSpec.SHEET_PRESETS is the authority;
     it is read tolerantly (map or array, several plausible key names) because this
     module must not hard-code a copy of data that lives in the spec. */
  var SHEET_DEFAULT_KEY = 'sampleTopLeft';
  var warnedNoPresets = false;
  var warnedNoPresetStore = false;

  /** [{key, label, originX, originY}] in declaration order, or [] when absent. */
  function sheetPresets(d) {
    var raw = d.spec && d.spec.SHEET_PRESETS;
    if (!raw || typeof raw !== 'object') {
      if (!warnedNoPresets) {
        warnedNoPresets = true;
        console.warn(
          '[BadgeOverrides] BadgeSpec.SHEET_PRESETS is unavailable — the sheet layout ' +
            'selector is disabled and the default top-left layout is assumed.'
        );
      }
      return [];
    }
    var keys = Array.isArray(raw) ? raw.map(function (_, i) { return i; }) : Object.keys(raw);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = raw[keys[i]];
      if (!v || typeof v !== 'object') continue;
      var key = typeof v.key === 'string' ? v.key : String(keys[i]);
      var origin = v.origin && typeof v.origin === 'object' ? v.origin : v;
      var ox = num(origin.x !== undefined ? origin.x : origin.originX);
      var oy = num(origin.y !== undefined ? origin.y : origin.originY);
      out.push({
        key: key,
        label: typeof v.label === 'string' ? v.label : typeof v.name === 'string' ? v.name : key,
        originX: ox,
        originY: oy
      });
    }
    return out;
  }

  /** The stored key, guarded, falling back to the documented default. */
  function sheetPresetKey(d) {
    if (!d.store || typeof d.store.getSheetPreset !== 'function') {
      if (!warnedNoPresetStore) {
        warnedNoPresetStore = true;
        console.warn(
          '[BadgeOverrides] BadgeStore.getSheetPreset() is unavailable — the sheet ' +
            'layout selector is disabled and the default layout is assumed.'
        );
      }
      return { key: SHEET_DEFAULT_KEY, unavailable: true };
    }
    var k;
    try {
      k = d.store.getSheetPreset();
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.getSheetPreset() threw:', err && err.message);
      return { key: SHEET_DEFAULT_KEY, unavailable: true };
    }
    return { key: typeof k === 'string' && k ? k : SHEET_DEFAULT_KEY, unavailable: false };
  }

  function commitSheetPreset(key) {
    var d = deps();
    if (!d) return false;
    if (typeof d.store.setSheetPreset !== 'function') {
      console.warn('[BadgeOverrides] BadgeStore.setSheetPreset() is unavailable — cannot save the sheet layout.');
      renderSheet();
      return false;
    }
    var list = sheetPresets(d);
    var known = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) known = true;
    }
    if (!known) {
      console.warn('[BadgeOverrides] ignoring unknown sheet preset "' + key + '".');
      renderSheet();
      return false;
    }
    try {
      d.store.setSheetPreset(key);
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.setSheetPreset() threw:', err && err.message);
    }
    renderSheet();
    return true;
  }

  /* -------------------------------------------------------- text alignment ---
     Sheet-wide horizontal alignment of the badge text: 'left' (default) or
     'center'. The valid set and the default come from BadgeSpec, never from a
     local copy — this module only holds a fallback for the case where spec.js
     is not loaded at all. */
  var warnedNoAligns = false;
  var warnedNoAlignStore = false;

  /** The valid alignment keys, in declaration order. */
  function alignList(d) {
    var raw = d.spec && d.spec.ALIGNS;
    var out = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        if (typeof raw[i] === 'string' && raw[i] && out.indexOf(raw[i]) === -1) out.push(raw[i]);
      }
    }
    if (!out.length) {
      if (!warnedNoAligns) {
        warnedNoAligns = true;
        console.warn(
          '[BadgeOverrides] BadgeSpec.ALIGNS is unavailable — falling back to ' +
            ALIGN_FALLBACK.join(' / ') + ' with "' + ALIGN_FALLBACK_DEFAULT + '" as the default.'
        );
      }
      return ALIGN_FALLBACK.slice();
    }
    return out;
  }

  /** The default alignment: the spec's, if it is one of the spec's own keys. */
  function alignDefault(d) {
    var list = alignList(d);
    var def = d.spec && d.spec.ALIGN_DEFAULT;
    if (typeof def === 'string' && list.indexOf(def) !== -1) return def;
    return list.indexOf(ALIGN_FALLBACK_DEFAULT) !== -1 ? ALIGN_FALLBACK_DEFAULT : list[0];
  }

  /**
   * The alignment in force, guarded. `BadgeStore.getAlign()` may be missing on an
   * older build or under a surprising script order; that must leave the panel
   * working (and honest about it), not throw. LEFT is the documented default, so
   * falling back to it also happens to be what the engine does with no opts.
   */
  function alignConfig(d) {
    var def = alignDefault(d);
    if (!d.store || typeof d.store.getAlign !== 'function') {
      if (!warnedNoAlignStore) {
        warnedNoAlignStore = true;
        console.warn(
          '[BadgeOverrides] BadgeStore.getAlign() is unavailable — assuming "' + def +
            '" alignment. The alignment selector is disabled because there is nowhere ' +
            'to save a change.'
        );
      }
      return { value: def, unavailable: true };
    }
    var v;
    try {
      v = d.store.getAlign();
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.getAlign() threw:', err && err.message);
      return { value: def, unavailable: true };
    }
    var list = alignList(d);
    return {
      value: typeof v === 'string' && list.indexOf(v) !== -1 ? v : def,
      unavailable: false
    };
  }

  /**
   * Write the alignment. The store owns persistence and emits `align:changed`,
   * which is what repaints the preview — this module never touches the preview
   * or localStorage itself.
   */
  function commitAlign(value) {
    var d = deps();
    if (!d) return false;
    if (alignList(d).indexOf(value) === -1) {
      console.warn('[BadgeOverrides] ignoring unknown text alignment "' + value + '".');
      renderAlign();
      return false;
    }
    if (typeof d.store.setAlign !== 'function') {
      console.warn('[BadgeOverrides] BadgeStore.setAlign() is unavailable — cannot save the text alignment.');
      renderAlign(); // snap the control back to the truth
      return false;
    }
    try {
      d.store.setAlign(value);
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.setAlign() threw:', err && err.message);
    }
    renderAlign();
    render(); // the applied-size readout is computed WITH the alignment
    return true;
  }

  /**
   * The third argument to BadgeLayout.layout(). Points, as the engine wants, and
   * the alignment alongside the reserve: a readout computed under one alignment
   * while the sheet prints under another is exactly the divergence this module
   * exists to prevent.
   */
  function layoutOpts(cfg, align) {
    return {
      logo: {
        enabled: !!cfg.enabled,
        wPt: cfg.wIn * PT_PER_IN,
        hPt: cfg.hIn * PT_PER_IN
      },
      align: align
    };
  }

  /* Geometry the reserve imposes on the lines level with it, straight from the
     spec: span [INSET, 288 - wPt], centered in THAT span. Shown in the panel so a
     physical measurement against real stock can be checked without a calculator. */
  function logoGeometry(d, cfg) {
    var wPt = cfg.wIn * PT_PER_IN;
    var hPt = cfg.hIn * PT_PER_IN;
    return {
      wPt: wPt,
      hPt: hPt,
      availW: d.spec.CELL_W - wPt - d.spec.INSET,
      center: (d.spec.INSET + (d.spec.CELL_W - wPt)) / 2,
      fullW: d.spec.BOX_W,
      fullCenter: d.spec.CELL_W / 2,
      reserveX: d.spec.CELL_W - wPt,
      reserveY: d.spec.CELL_H - hPt
    };
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
       sizes. Every call below — auto, current, and every probe — gets the same
       opts, or the readout would describe a sheet nobody is printing. */
    var logo = logoConfig(d);
    /* Alignment travels with the reserve for the same reason: the panel must
       describe the sheet that is actually going to print. */
    var align = alignConfig(d);
    var opts = layoutOpts(logo, align.value);
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
      logo: logo,
      align: align.value,
      alignUnavailable: !!align.unavailable,
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

  function el(tag, opts) {
    var node = doc().createElement(tag);
    if (opts) {
      if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
      if (opts.className) node.className = opts.className;
      if (opts.id) node.id = opts.id;
      if (opts.style) {
        for (var k in opts.style) {
          if (Object.prototype.hasOwnProperty.call(opts.style, k)) node.style[k] = opts.style[k];
        }
      }
      if (opts.attrs) {
        for (var a in opts.attrs) {
          if (Object.prototype.hasOwnProperty.call(opts.attrs, a)) {
            node.setAttribute(a, String(opts.attrs[a]));
          }
        }
      }
    }
    return node;
  }

  /* Never innerHTML — not even for clearing. */
  function empty(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function button(label, aria, onClick) {
    var b = el('button', { text: label, attrs: { type: 'button', 'aria-label': aria } });
    b.addEventListener('click', onClick);
    return b;
  }

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

  /* The logo reserve gets its OWN side-panel child, so the shell's hairline rule
     separates it from the per-badge controls: different scope, different block. */
  function createLogoPanel(document, afterNode) {
    var existing = document.getElementById(SHEET_PANEL_ID);
    if (existing) {
      empty(existing);
      return existing;
    }
    var panel = el('div', { id: SHEET_PANEL_ID });
    var parent = (afterNode && afterNode.parentNode) || containerParent(document);
    if (!parent) return null;
    if (afterNode && afterNode.parentNode === parent) {
      parent.insertBefore(panel, afterNode.nextSibling);
    } else {
      parent.appendChild(panel);
    }
    return panel;
  }

  /* --------------------------------------------------- build: logo section --- */

  /**
   * The sheet-wide settings panel: text alignment, logo reserve, sheet layout.
   * Deliberately a SEPARATE container from the per-badge controls (the shell puts
   * a hairline between side-panel children), with its own heading and copy that
   * says "every badge on every sheet" — none of it may read as one more
   * per-attendee nudge.
   */
  function buildLogoSection(panel) {
    var refs = { panel: panel };

    panel.appendChild(el('h2', { text: 'Sheet settings · all badges' }));
    panel.appendChild(
      el('p', {
        text:
          'These apply to every badge on every sheet, not just the selected one.',
        style: { margin: '0 0 12px', fontSize: '11px', color: 'var(--ink-3)' }
      })
    );

    // ---- text alignment ------------------------------------------------
    // Same control idiom as the sheet layout below (a two-option <select>), so
    // the sheet-wide group reads as one block of settings rather than a pile of
    // unrelated widgets.
    panel.appendChild(subLabel('Text alignment'));
    panel.appendChild(
      el('p', {
        text:
          'How every badge’s four lines sit horizontally — the selected attendee ' +
          'is not treated differently.',
        style: { margin: '0 0 6px', fontSize: '11px', color: 'var(--ink-3)' }
      })
    );
    refs.alignSelect = el('select', {
      id: 'text-align',
      attrs: { 'aria-label': 'Text alignment for every badge' }
    });
    refs.alignSelect.addEventListener('change', function () {
      commitAlign(refs.alignSelect.value);
    });
    panel.appendChild(refs.alignSelect);
    refs.alignNote = el('p', {
      attrs: { 'data-role': 'align-note' },
      style: { margin: '6px 0 0', fontSize: '11px', color: 'var(--ink-3)' }
    });
    panel.appendChild(refs.alignNote);

    panel.appendChild(subLabel('Logo reserve', { marginTop: '16px' }));
    panel.appendChild(
      el('p', {
        text: 'For pre-printed stock with a logo in each badge’s bottom-right corner.',
        style: { margin: '0 0 8px', fontSize: '11px', color: 'var(--ink-3)' }
      })
    );

    // ---- toggle -------------------------------------------------------
    var toggleRow = el('label', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 10px', fontSize: '13px', color: 'var(--ink)' }
    });
    refs.toggle = el('input', {
      id: 'logo-enabled',
      attrs: { type: 'checkbox', 'aria-label': 'Reserve logo space on every badge' }
    });
    refs.toggle.type = 'checkbox';
    refs.toggle.addEventListener('change', function () {
      commitLogo({ enabled: refs.toggle.checked === true });
    });
    toggleRow.appendChild(refs.toggle);
    toggleRow.appendChild(el('span', { text: 'Reserve space for the pre-printed logo' }));
    panel.appendChild(toggleRow);

    // ---- dimensions ---------------------------------------------------
    refs.dims = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } });
    refs.width = buildDimField(refs.dims, 'logo-width', 'Width', function (v) {
      commitLogo({ wIn: v });
    });
    refs.height = buildDimField(refs.dims, 'logo-height', 'Height', function (v) {
      commitLogo({ hIn: v });
    });
    panel.appendChild(refs.dims);

    refs.note = el('p', {
      attrs: { 'data-role': 'logo-note' },
      style: { margin: '8px 0 0', fontSize: '11px', color: 'var(--ink-3)' }
    });
    panel.appendChild(refs.note);

    // ---- sheet layout preset ------------------------------------------
    panel.appendChild(subLabel('Sheet layout', { marginTop: '16px' }));
    panel.appendChild(
      el('p', {
        text:
          'Where the whole 2 × 3 grid sits on the page. This moves the grid, not the ' +
          'badge contents.',
        style: { margin: '0 0 6px', fontSize: '11px', color: 'var(--ink-3)' }
      })
    );
    refs.presetSelect = el('select', {
      id: 'sheet-preset',
      attrs: { 'aria-label': 'Sheet layout preset for every page' }
    });
    refs.presetSelect.addEventListener('change', function () {
      commitSheetPreset(refs.presetSelect.value);
    });
    panel.appendChild(refs.presetSelect);
    refs.presetNote = el('p', {
      attrs: { 'data-role': 'sheet-note' },
      style: { margin: '6px 0 0', fontSize: '11px', color: 'var(--ink-3)' }
    });
    panel.appendChild(refs.presetNote);

    return refs;
  }

  /* Small uppercase divider label for a subsection inside the sheet-wide group. */
  function subLabel(text, extraStyle) {
    var st = {
      display: 'block',
      margin: '0 0 6px',
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: 'var(--ink-2)'
    };
    if (extraStyle) {
      for (var k in extraStyle) {
        if (Object.prototype.hasOwnProperty.call(extraStyle, k)) st[k] = extraStyle[k];
      }
    }
    return el('span', { text: text, style: st });
  }

  /**
   * Render the sheet layout selector. Options come from BadgeSpec.SHEET_PRESETS so
   * this module never holds its own copy of the geometry.
   */
  function renderSheet() {
    if (!logoEls || !logoEls.presetSelect) return;
    var d = deps();
    if (!d) return;
    var list = sheetPresets(d);
    var stored = sheetPresetKey(d);
    var sel = logoEls.presetSelect;
    var note = logoEls.presetNote;

    empty(sel);
    if (!list.length) {
      var only = el('option', { text: 'Sample layout (top-left, zero margin)' });
      only.value = SHEET_DEFAULT_KEY;
      sel.appendChild(only);
      sel.value = SHEET_DEFAULT_KEY;
      sel.disabled = true;
      note.textContent =
        'Sheet layout presets are unavailable in this build, so the grid is pinned to ' +
        'the top-left corner of the page.';
      return;
    }

    var active = null;
    for (var i = 0; i < list.length; i++) {
      var opt = el('option', { text: list[i].label }); // textContent, never markup
      opt.value = list[i].key;
      if (list[i].key === stored.key) {
        opt.selected = true;
        active = list[i];
      }
      sel.appendChild(opt);
    }
    if (!active) active = list[0];
    sel.value = active.key;
    sel.disabled = !!stored.unavailable;

    var hint =
      active.originX === 0 && active.originY === 0
        ? 'Pins the grid to the top-left corner of the page, matching the sample sheet.'
        : 'Centres the grid for real Avery stock: the grid starts ' +
          fmt(active.originX) + ' pt in from the left and ' + fmt(active.originY) +
          ' pt down from the top.';
    note.textContent =
      hint +
      (stored.unavailable
        ? ' (Cannot be changed in this build — the store has nowhere to save it.)'
        : '');
  }

  /**
   * Render the alignment selector. Options come from BadgeSpec.ALIGNS, so a third
   * alignment added to the spec appears here without touching this file; only the
   * human-readable labels live locally (the spec carries no copy for them).
   */
  function renderAlign() {
    if (!logoEls || !logoEls.alignSelect) return;
    var d = deps();
    if (!d) return;
    var list = alignList(d);
    var cfg = alignConfig(d);
    var sel = logoEls.alignSelect;

    empty(sel);
    for (var i = 0; i < list.length; i++) {
      var key = list[i];
      var label = Object.prototype.hasOwnProperty.call(ALIGN_LABELS, key)
        ? ALIGN_LABELS[key]
        : key.charAt(0).toUpperCase() + key.slice(1);
      var opt = el('option', { text: label }); // textContent, never markup
      opt.value = key;
      if (key === cfg.value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.value = cfg.value;
    sel.disabled = !!cfg.unavailable;

    var note = logoEls.alignNote;
    if (!note) return;
    var hint;
    if (cfg.value === 'center') {
      hint =
        'Each line is centred on its own, so the four lines start at four different ' +
        'places — normally on ' + fmt(d.spec.CELL_W / 2) +
        ' pt. Lines level with the logo reserve centre further left, as described below.';
    } else if (cfg.value === 'left') {
      hint =
        'All four lines share one left edge, and the block of text as a whole is ' +
        'centred in the badge — the widest line decides where that edge falls, so the ' +
        'text never runs to the badge edge. It reaches the ' + fmt(d.spec.INSET) +
        ' pt print safety margin only when the widest line fills the full width.';
    } else {
      hint = 'Alignment “' + cfg.value + '” is applied to every badge.';
    }
    note.textContent =
      hint +
      (cfg.unavailable
        ? ' (Cannot be changed in this build — the store has nowhere to save it.)'
        : '');
  }

  function buildDimField(parent, id, labelText, onCommit) {
    var wrap = el('div', { style: { flex: '1 1 0', minWidth: '0' } });
    wrap.appendChild(el('label', { text: labelText + ' (in)', attrs: { for: id } }));
    var input = el('input', {
      id: id,
      attrs: {
        type: 'number',
        min: String(LOGO_MIN_IN),
        max: String(LOGO_MAX_IN),
        step: String(LOGO_STEP_IN),
        inputmode: 'decimal',
        'aria-label': labelText + ' of the reserved logo block, in inches'
      },
      style: {
        width: '100%',
        fontFamily: 'inherit',
        fontSize: '13px',
        padding: '7px 9px',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        background: 'var(--field-bg)',
        color: 'var(--ink)'
      }
    });
    input.type = 'number';
    input.addEventListener('change', function () {
      onCommit(input.value);
    });
    wrap.appendChild(input);
    var pts = el('span', {
      attrs: { 'data-role': id + '-pt' },
      style: { display: 'block', marginTop: '3px', fontSize: '10.5px', color: 'var(--ink-3)' }
    });
    wrap.appendChild(pts);
    parent.appendChild(wrap);
    return { input: input, pts: pts };
  }

  /**
   * Write one field of the logo config. Garbage is REJECTED (the previous value is
   * kept and the input snaps back to it) rather than stored; in-range numbers are
   * clamped to 0–4 in. The store owns persistence and emits `logo:changed`, which
   * is what repaints the preview.
   */
  function commitLogo(patch) {
    var d = deps();
    if (!d) return false;
    if (typeof d.store.setLogo !== 'function') {
      console.warn('[BadgeOverrides] BadgeStore.setLogo() is unavailable — cannot save the logo reserve.');
      renderLogo(); // snap the controls back to the truth
      return false;
    }
    var cur = logoConfig(d);
    var next = {
      enabled: Object.prototype.hasOwnProperty.call(patch, 'enabled') ? patch.enabled === true : cur.enabled,
      wIn: Object.prototype.hasOwnProperty.call(patch, 'wIn') ? clampInches(patch.wIn, cur.wIn) : cur.wIn,
      hIn: Object.prototype.hasOwnProperty.call(patch, 'hIn') ? clampInches(patch.hIn, cur.hIn) : cur.hIn
    };
    try {
      d.store.setLogo(next);
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.setLogo() threw:', err && err.message);
    }
    renderLogo();
    render(); // the per-badge sizes depend on the reserve
    return true;
  }

  function fmtIn(n) {
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function renderLogo() {
    if (!logoEls) return;
    var d = deps();
    if (!d) return;
    var cfg = logoConfig(d);
    var g = logoGeometry(d, cfg);

    logoEls.toggle.checked = cfg.enabled === true;
    logoEls.toggle.disabled = !!cfg.unavailable;
    logoEls.width.input.value = fmtIn(cfg.wIn);
    logoEls.height.input.value = fmtIn(cfg.hIn);
    logoEls.width.input.disabled = !!cfg.unavailable || !cfg.enabled;
    logoEls.height.input.disabled = !!cfg.unavailable || !cfg.enabled;
    logoEls.width.pts.textContent = fmt(g.wPt) + ' pt';
    logoEls.height.pts.textContent = fmt(g.hPt) + ' pt';

    var note = logoEls.note;
    empty(note);
    if (cfg.unavailable) {
      note.textContent =
        'Unavailable in this build: the store cannot save a logo reserve yet, so badges ' +
        'are laid out for stock with no pre-printed logo.';
      return;
    }
    if (!cfg.enabled) {
      note.textContent = 'Off — every badge uses the full ' + fmt(g.fullW) + ' pt text width.';
      return;
    }
    if (g.wPt <= 0 || g.hPt <= 0) {
      note.textContent =
        'On, but ' + (g.wPt <= 0 ? 'width' : 'height') + ' is 0 in, so nothing is actually ' +
        'reserved. Set both dimensions above 0 for the reserve to have any effect.';
      return;
    }
    note.textContent =
      'Reserving ' + fmt(g.wPt) + ' × ' + fmt(g.hPt) + ' pt in each badge’s ' +
      'bottom-right corner (x ' + fmt(g.reserveX) + '–' + d.spec.CELL_W +
      ', y ' + fmt(g.reserveY) + '–' + d.spec.CELL_H + '). Lines level with it get ' +
      fmt(g.availW) + ' pt of width instead of ' + fmt(g.fullW) + ' pt and centre on ' +
      fmt(g.center) + ' instead of ' + fmt(g.fullCenter) + ' — so they sit ' +
      fmt(g.fullCenter - g.center) + ' pt left of the name lines, by design.';
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

  var ROW_STYLE = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 0'
  };

  function buildSkeleton(panel) {
    var refs = { panel: panel, fieldRows: {} };

    panel.appendChild(el('h2', { text: 'Font size override' }));

    // ---- attendee picker ----------------------------------------------
    var pickWrap = el('div', { style: { marginBottom: '10px' } });
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
      style: { margin: '0', fontSize: '12px', color: 'var(--ink-3)' }
    });
    panel.appendChild(refs.emptyNote);

    // ---- body (hidden when there is nobody to adjust) -----------------
    refs.body = el('div');

    // whole-badge nudge: the primary control
    var whole = el('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        margin: '2px 0 4px'
      }
    });
    refs.smallerAll = button('− Smaller', 'Make the whole badge smaller by 0.5 pt', function () {
      nudge(FIELDS, -1);
    });
    refs.biggerAll = button('+ Bigger', 'Make the whole badge bigger by 0.5 pt', function () {
      nudge(FIELDS, 1);
    });
    refs.smallerAll.style.flex = '1 1 0';
    refs.biggerAll.style.flex = '1 1 0';
    whole.appendChild(refs.smallerAll);
    whole.appendChild(refs.biggerAll);
    refs.body.appendChild(whole);

    refs.wholeHint = el('p', {
      text: WHOLE_HINT_DEFAULT,
      attrs: { 'data-role': 'whole-hint' },
      style: { margin: '0 0 12px', fontSize: '11px', color: 'var(--ink-3)' }
    });
    refs.body.appendChild(refs.wholeHint);

    // per-field rows: applied size + pinned state + fine control
    var head = el('div', { style: ROW_STYLE });
    head.appendChild(
      el('span', {
        text: 'Applied sizes',
        style: {
          flex: '1 1 auto',
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--ink-3)'
        }
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
      style: {
        display: 'none',
        margin: '10px 0 0',
        padding: '7px 9px',
        fontSize: '11px',
        lineHeight: '1.35',
        color: 'var(--ink-2)',
        background: '#f4f4f6',
        borderLeft: '3px solid var(--ink-3)',
        borderRadius: '2px'
      }
    });
    refs.body.appendChild(refs.warnings);

    // status + reset
    refs.status = el('p', {
      style: { margin: '10px 0 0', fontSize: '11px', color: 'var(--ink-3)' },
      attrs: { role: 'status', 'aria-live': 'polite' }
    });
    refs.body.appendChild(refs.status);

    refs.reset = button('Reset to auto', 'Reset this badge to automatic sizes', function () {
      resetSelected();
    });
    refs.reset.style.marginTop = '10px';
    refs.reset.style.width = '100%';
    refs.body.appendChild(refs.reset);

    panel.appendChild(refs.body);
    return refs;
  }

  function buildFieldRow(parent, field) {
    var row = el('div', { style: ROW_STYLE, attrs: { 'data-field': field } });

    var name = el('span', {
      text: LABELS[field],
      style: { flex: '0 0 78px', fontSize: '12px', color: 'var(--ink-2)' }
    });
    var size = el('span', {
      style: {
        flex: '0 0 46px',
        fontSize: '12px',
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right'
      }
    });
    /* Not uppercased: these labels are sentences ("capped to keep text"), and
       uppercase micro-type wraps them onto a second line in a 360 px panel. */
    var badge = el('span', {
      style: {
        flex: '1 1 auto',
        minWidth: '0',
        fontSize: '10.5px',
        lineHeight: '1.25',
        color: 'var(--ink-3)'
      }
    });
    var minus = button('−', 'Make ' + LABELS[field].toLowerCase() + ' smaller', function () {
      nudge([field], -1);
    });
    var plus = button('+', 'Make ' + LABELS[field].toLowerCase() + ' bigger', function () {
      nudge([field], 1);
    });
    minus.style.padding = '2px 8px';
    plus.style.padding = '2px 8px';

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
        style: { display: 'block', fontSize: '11px', color: 'var(--ink)' }
      })
    );
    var ul = el('ul', { style: { margin: '4px 0 0', padding: '0 0 0 16px' } });
    for (var i = 0; i < list.length; i++) {
      // textContent: warnings quote attendee text, which may contain markup.
      ul.appendChild(el('li', { text: String(list[i]), style: { marginBottom: '2px' } }));
    }
    box.appendChild(ul);
    if (model.truncatedAny) {
      box.appendChild(
        el('span', {
          text: 'Shorten the text — no font size will fit it.',
          style: { display: 'block', marginTop: '4px' }
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
    var opts = layoutOpts(logoConfig(d), alignConfig(d).value); // same opts the readout used
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
    var type = (change && change.type) || '';
    if (type.indexOf('logo') !== -1 || type === '') renderLogo();
    if (type.indexOf('align') !== -1 || type === '') renderAlign();
    if (type.indexOf('sheet') !== -1 || type.indexOf('preset') !== -1 || type === '') renderSheet();
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

    // Sheet-wide logo reserve, in its own container right after the per-badge block.
    var logoPanel = (opts && opts.logoContainer) || createLogoPanel(document, panel);
    retirePanel(logoEls && logoEls.panel, logoPanel);
    logoEls = logoPanel ? buildLogoSection(logoPanel) : null;

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

    renderLogo();
    renderAlign();
    renderSheet();
    render();
    return panel;
  }

  function unmount() {
    if (unsubscribe) {
      try { unsubscribe(); } catch (err) { /* ignore */ }
      unsubscribe = null;
    }
    if (els && els.panel) empty(els.panel);
    if (logoEls && logoEls.panel) empty(logoEls.panel);
    els = null;
    logoEls = null;
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
    // --- sheet-wide logo reserve ---------------------------------------------
    /** Current setting as the store holds it (inches), guarded. */
    logo: function () {
      var d = deps();
      return d ? logoConfig(d) : null;
    },
    /** The exact third argument this module passes to BadgeLayout.layout(). */
    logoOpts: function () {
      var d = deps();
      return d ? layoutOpts(logoConfig(d), alignConfig(d).value) : null;
    },
    /** Patch the setting: {enabled} / {wIn} / {hIn}, clamped and validated. */
    setLogo: function (patch) {
      return commitLogo(patch && typeof patch === 'object' ? patch : {});
    },
    clampInches: clampInches,
    // --- sheet-wide text alignment -------------------------------------------
    /** The alignment in force ('left' by default), guarded. */
    align: function () {
      var d = deps();
      return d ? alignConfig(d).value : null;
    },
    /** The valid alignments, straight from BadgeSpec.ALIGNS. */
    aligns: function () {
      var d = deps();
      return d ? alignList(d) : [];
    },
    /** Write the alignment through the store (which emits `align:changed`). */
    setAlign: commitAlign,
    /** Sheet layout preset: the stored key, and the list offered. */
    sheetPreset: function () {
      var d = deps();
      return d ? sheetPresetKey(d).key : null;
    },
    sheetPresets: function () {
      var d = deps();
      return d ? sheetPresets(d) : [];
    },
    setSheetPreset: commitSheetPreset,
    FIELDS: FIELDS,
    PANEL_ID: PANEL_ID,
    SHEET_PANEL_ID: SHEET_PANEL_ID,
    LOGO_PANEL_ID: SHEET_PANEL_ID, // the logo controls live in the sheet-wide group
    LOGO_LIMITS: { minIn: LOGO_MIN_IN, maxIn: LOGO_MAX_IN, stepIn: LOGO_STEP_IN, ptPerIn: PT_PER_IN }
  };
})(typeof window !== 'undefined' ? window : globalThis);
