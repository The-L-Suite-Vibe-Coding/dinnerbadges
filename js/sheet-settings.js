/*
 * js/sheet-settings.js - window.BadgeSheetSettings
 *
 * The SHEET-WIDE settings panel: text alignment, the corner logo reserve (on/off,
 * which corner, and its size), and which sheet layout (grid origin) the badges are
 * printed on. One setting each, for every badge on every page - nothing here is
 * ever per attendee.
 *
 * WHY THIS IS ITS OWN FILE. All of it used to live inside js/overrides.js, whose
 * header describes it as "per-badge font-size override UI". That file was two modules
 * sharing one name: about 700 of its 1,900 lines were this panel, so "where is the
 * logo reserve control?" had a misleading answer. index.html already declared
 * #override-panel and #sheet-panel as separate mount points on separate tabs - the
 * seam was drawn in the markup and simply never carried into the JavaScript.
 *
 * WHAT THIS MODULE DOES *NOT* DO - on purpose, inherited from the file it came out of:
 *   - It does not size, clamp or place any text. BadgeLayout.layout() owns every
 *     typographic decision; this file only resolves the OPTIONS object handed to it
 *     (see layoutOpts()). Re-deriving a size here is how the preview and the PDF come
 *     to disagree.
 *   - It does not touch localStorage. BadgeStore owns persistence.
 *   - It does not re-render the preview. Writing through the store emits the change
 *     event, and js/preview.js listens for it.
 *
 * THE ONE THING THE OVERRIDE PANEL NEEDS FROM HERE is layoutOpts() - the exact third
 * argument to BadgeLayout.layout(). js/overrides.js calls it rather than resolving the
 * logo reserve or the alignment itself, so both panels are provably laid out against
 * one set of sheet settings.
 *
 * BadgeSpec is the authority for the valid values and defaults of all three settings
 * and is read at CALL time; the *_FALLBACK constants below are only for a build where
 * js/spec.js failed to load.
 *
 * Classic script. No ES modules, no network, no innerHTML. Works under file://.
 */
(function (window) {
  'use strict';

  var SHEET_PANEL_ID = 'sheet-panel';

  /* ---------------------------------------------------------------- utilities */
  /* doc/deps/num/fmt/containerParent/retirePanel are small and appear in exactly two
     files (here and js/overrides.js). Two copies of a three-line helper is cheaper
     than a third module to hold them; the element builders, which were bigger and
     carried the never-innerHTML rule, did get extracted (js/dom.js). */

  function doc() {
    return window.document || null;
  }

  function deps() {
    var missing = [];
    if (!window.BadgeStore) missing.push('BadgeStore');
    if (!window.BadgeLayout || typeof window.BadgeLayout.layout !== 'function') {
      missing.push('BadgeLayout');
    }
    if (!window.BadgeSpec) missing.push('BadgeSpec');
    if (missing.length) {
      console.warn(
        '[BadgeSheetSettings] not starting - missing ' + missing.join(', ') +
          '. Sheet-wide settings are unavailable; the rest of the app is unaffected.'
      );
      return null;
    }
    return { store: window.BadgeStore, layout: window.BadgeLayout, spec: window.BadgeSpec };
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function fmt(pt) {
    return (Math.round(pt * 10) / 10).toFixed(1);
  }

  function dom() {
    var D = window.BadgeDom;
    if (!D) throw new Error('BadgeSheetSettings: window.BadgeDom is missing - load js/dom.js first.');
    return D;
  }
  function el(tag, opts) { return dom().el(tag, opts, doc()); }
  function empty(node) { dom().empty(node); }
  function button(label, aria, onClick) { return dom().button(label, aria, onClick, doc()); }

  function containerParent(document) {
    return document.getElementById('side-panel') || document.body || null;
  }

  function retirePanel(oldNode, newNode) {
    if (!oldNode || oldNode === newNode) return;
    empty(oldNode);
    if (oldNode.parentNode && typeof oldNode.parentNode.removeChild === 'function') {
      oldNode.parentNode.removeChild(oldNode);
    }
  }

  /* Re-render the per-badge panel after a sheet setting changes: its applied-size
     readout is computed WITH the alignment and the reserve, so it goes stale otherwise.
     Guarded - the override panel is optional and may not be mounted. */
  function refreshOverridePanel() {
    var OV = window.BadgeOverrides;
    if (OV && typeof OV.refresh === 'function') {
      try { OV.refresh(); } catch (err) { /* the override panel's problem, not ours */ }
    }
  }

  /* -------------------------------------------------------------------- state */

  var logoEls = null;      // built DOM references for this panel, or null before mount()
  var busy = false;        // re-entrancy guard: our writes come back to us as store events
  var unsubscribe = null;

  /* ---- logo reserve (BADGE_SPEC.md addendum 2C) ---------------------------
     SHEET-WIDE, not per badge: one setting reserves a corner (`pos`) of EVERY
     cell so text never prints over pre-printed logo stock. The store keeps
     inches; converting to points is the caller's job, so it is done here. */
  var PT_PER_IN = 72;
  var LOGO_STEP_IN = 0.25; // UI-only: the number input's arrow increment, no spec counterpart
  /* Fallbacks for a build where spec.js has not loaded. BadgeSpec.LOGO_MIN_IN /
     LOGO_MAX_IN / LOGO_DEFAULT are the authority and are read at call time by the three
     accessors below, so the panel's clamp can no longer drift from the engine's. */
  var LOGO_MIN_IN_FALLBACK = 0;
  var LOGO_MAX_IN_FALLBACK = 4;
  var LOGO_FALLBACK = { enabled: true, wIn: 1, hIn: 1, pos: 'bottomRight' }; // ON by default
  /* Which corner the reserve occupies. BadgeSpec.LOGO_POSITIONS / LOGO_POSITION_DEFAULT
     are the authority, read at call time; only the human-readable labels live here
     (the spec carries no copy for them), exactly like ALIGN_LABELS below. */
  var LOGO_POS_FALLBACK = ['bottomRight', 'topRight', 'topLeft'];
  var LOGO_POS_DEFAULT_FALLBACK = 'bottomRight';
  var LOGO_POS_LABELS = {
    bottomRight: 'Bottom right',
    topRight: 'Top right',
    topLeft: 'Top left'
  };

  function logoPositions() {
    var S = window.BadgeSpec;
    var raw = S && S.LOGO_POSITIONS;
    var out = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        if (typeof raw[i] === 'string' && raw[i] && out.indexOf(raw[i]) === -1) out.push(raw[i]);
      }
    }
    return out.length ? out : LOGO_POS_FALLBACK.slice();
  }

  function logoPosDefault() {
    var S = window.BadgeSpec;
    var def = S && S.LOGO_POSITION_DEFAULT;
    if (typeof def === 'string' && logoPositions().indexOf(def) !== -1) return def;
    return LOGO_POS_DEFAULT_FALLBACK;
  }

  /* Junk keeps the fallback (the current position when patching), never a guess. */
  function normalizeLogoPos(v, fallback) {
    return typeof v === 'string' && logoPositions().indexOf(v) !== -1 ? v : fallback;
  }

  function logoMinIn() {
    var S = window.BadgeSpec;
    return (S && typeof S.LOGO_MIN_IN === 'number' && isFinite(S.LOGO_MIN_IN))
      ? S.LOGO_MIN_IN : LOGO_MIN_IN_FALLBACK;
  }
  function logoMaxIn() {
    var S = window.BadgeSpec;
    return (S && typeof S.LOGO_MAX_IN === 'number' && isFinite(S.LOGO_MAX_IN))
      ? S.LOGO_MAX_IN : LOGO_MAX_IN_FALLBACK;
  }
  function logoDefaults() {
    var S = window.BadgeSpec;
    var d = S && S.LOGO_DEFAULT;
    if (d && typeof d.wIn === 'number' && typeof d.hIn === 'number') {
      return {
        enabled: d.enabled === true,
        wIn: d.wIn,
        hIn: d.hIn,
        pos: normalizeLogoPos(d.pos, logoPosDefault())
      };
    }
    return {
      enabled: LOGO_FALLBACK.enabled,
      wIn: LOGO_FALLBACK.wIn,
      hIn: LOGO_FALLBACK.hIn,
      pos: LOGO_FALLBACK.pos
    };
  }

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
    var lo = logoMinIn();
    var hi = logoMaxIn();
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function normalizeLogo(raw, base) {
    var b = base || logoDefaults();
    var o = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: o.enabled === true,
      wIn: clampInches(o.wIn, b.wIn),
      hIn: clampInches(o.hIn, b.hIn),
      pos: normalizeLogoPos(o.pos, normalizeLogoPos(b.pos, logoPosDefault()))
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
      return { enabled: false, wIn: logoDefaults().wIn, hIn: logoDefaults().hIn, pos: logoDefaults().pos, unavailable: true };
    }
    try {
      return normalizeLogo(d.store.getLogo());
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.getLogo() threw:', err && err.message);
      return { enabled: false, wIn: logoDefaults().wIn, hIn: logoDefaults().hIn, pos: logoDefaults().pos, unavailable: true };
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
    refreshOverridePanel(); // its readout is computed WITH the alignment
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
        hPt: cfg.hIn * PT_PER_IN,
        pos: normalizeLogoPos(cfg.pos, logoPosDefault())
      },
      align: align
    };
  }

  /* Geometry the reserve imposes on the lines level with it, straight from the
     spec: the narrowed span keeps the inset on its far side and runs to the
     reserve's near edge — [INSET, 288 - wPt] for a right-side corner, mirrored
     to [wPt, 288 - INSET] for the top-left one — and affected lines centre in
     THAT span. Shown in the panel so a physical measurement against real stock
     can be checked without a calculator. */
  function logoGeometry(d, cfg) {
    var wPt = cfg.wIn * PT_PER_IN;
    var hPt = cfg.hIn * PT_PER_IN;
    var pos = normalizeLogoPos(cfg.pos, logoPosDefault());
    var right = pos !== 'topLeft';
    var bottom = pos === 'bottomRight';
    return {
      pos: pos,
      wPt: wPt,
      hPt: hPt,
      availW: d.spec.CELL_W - wPt - d.spec.INSET, // same width either side
      center: right
        ? (d.spec.INSET + (d.spec.CELL_W - wPt)) / 2
        : (wPt + (d.spec.CELL_W - d.spec.INSET)) / 2,
      fullW: d.spec.BOX_W,
      fullCenter: d.spec.CELL_W / 2,
      reserveX0: right ? d.spec.CELL_W - wPt : 0,
      reserveX1: right ? d.spec.CELL_W : wPt,
      reserveY0: bottom ? d.spec.CELL_H - hPt : 0,
      reserveY1: bottom ? d.spec.CELL_H : hPt
    };
  }

  /* The logo reserve gets its OWN side-panel child, so the shell's hairline rule
     separates it from the per-badge controls: different scope, different block. */
  function createSheetPanel(document, afterNode) {
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
        className: 'ss-note'
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
        className: 'ss-note-tight'
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
      className: 'ss-note-after'
    });
    panel.appendChild(refs.alignNote);

    panel.appendChild(subLabel('Logo reserve', true));
    panel.appendChild(
      el('p', {
        text: 'For pre-printed stock with a logo printed in a corner of each badge.',
        className: 'ss-note-gap'
      })
    );

    // ---- toggle -------------------------------------------------------
    // Untick for stock with no pre-printed logo — that is the "not there at all"
    // option; the corner selector below covers the three printed positions.
    var toggleRow = el('label', {
      className: 'ss-toggle'
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

    // ---- corner -------------------------------------------------------
    // Which corner of every badge the logo occupies. Same control idiom as the
    // alignment and sheet layout selects; options come from BadgeSpec.LOGO_POSITIONS
    // so a fourth corner added to the spec appears here without touching this file.
    refs.posWrap = el('div', { className: 'ss-dim' });
    refs.posWrap.appendChild(el('label', { text: 'Corner', attrs: { for: 'logo-pos' } }));
    refs.posSelect = el('select', {
      id: 'logo-pos',
      attrs: { 'aria-label': 'Corner of every badge the pre-printed logo occupies' }
    });
    refs.posSelect.addEventListener('change', function () {
      commitLogo({ pos: refs.posSelect.value });
    });
    refs.posWrap.appendChild(refs.posSelect);
    panel.appendChild(refs.posWrap);

    // ---- dimensions ---------------------------------------------------
    refs.dims = el('div', { className: 'ss-dims' });
    refs.width = buildDimField(refs.dims, 'logo-width', 'Width', function (v) {
      commitLogo({ wIn: v });
    });
    refs.height = buildDimField(refs.dims, 'logo-height', 'Height', function (v) {
      commitLogo({ hIn: v });
    });
    panel.appendChild(refs.dims);

    refs.note = el('p', {
      attrs: { 'data-role': 'logo-note' },
      className: 'ss-note-loose'
    });
    panel.appendChild(refs.note);

    // ---- sheet layout preset ------------------------------------------
    panel.appendChild(subLabel('Sheet layout', true));
    panel.appendChild(
      el('p', {
        text:
          'Where the whole 2 × 3 grid sits on the page. This moves the grid, not the ' +
          'badge contents.',
        className: 'ss-note-tight'
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
      className: 'ss-note-after'
    });
    panel.appendChild(refs.presetNote);

    return refs;
  }

  /* Small uppercase divider label for a subsection inside the sheet-wide group. */
  /* `spaced` adds the extra top margin the second and third groups need; both live
     in styles.css as .ss-sublabel / .ss-sublabel-spaced. */
  function subLabel(text, spaced) {
    return el('span', {
      text: text,
      className: spaced ? 'ss-sublabel ss-sublabel-spaced' : 'ss-sublabel'
    });
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
    var wrap = el('div', { className: 'ss-dim' });
    wrap.appendChild(el('label', { text: labelText + ' (in)', attrs: { for: id } }));
    var input = el('input', {
      id: id,
      attrs: {
        type: 'number',
        min: String(logoMinIn()),
        max: String(logoMaxIn()),
        step: String(LOGO_STEP_IN),
        inputmode: 'decimal',
        'aria-label': labelText + ' of the reserved logo block, in inches'
      }
    });
    input.type = 'number';
    input.addEventListener('change', function () {
      onCommit(input.value);
    });
    wrap.appendChild(input);
    var pts = el('span', {
      attrs: { 'data-role': id + '-pt' },
      className: 'ss-dim-sub'
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
      hIn: Object.prototype.hasOwnProperty.call(patch, 'hIn') ? clampInches(patch.hIn, cur.hIn) : cur.hIn,
      pos: Object.prototype.hasOwnProperty.call(patch, 'pos')
        ? normalizeLogoPos(patch.pos, normalizeLogoPos(cur.pos, logoPosDefault()))
        : cur.pos
    };
    try {
      d.store.setLogo(next);
    } catch (err) {
      console.warn('[BadgeOverrides] BadgeStore.setLogo() threw:', err && err.message);
    }
    renderLogo();
    refreshOverridePanel(); // the per-badge sizes depend on the reserve
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

    // Corner selector: options from the spec, current value from the store.
    if (logoEls.posSelect) {
      var sel = logoEls.posSelect;
      empty(sel);
      var positions = logoPositions();
      for (var pi = 0; pi < positions.length; pi++) {
        var key = positions[pi];
        var label = Object.prototype.hasOwnProperty.call(LOGO_POS_LABELS, key)
          ? LOGO_POS_LABELS[key]
          : key;
        var opt = el('option', { text: label }); // textContent, never markup
        opt.value = key;
        if (key === g.pos) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.value = g.pos;
      sel.disabled = !!cfg.unavailable || !cfg.enabled;
    }

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
    var cornerName = (Object.prototype.hasOwnProperty.call(LOGO_POS_LABELS, g.pos)
      ? LOGO_POS_LABELS[g.pos]
      : g.pos).toLowerCase();
    note.textContent =
      'Reserving ' + fmt(g.wPt) + ' × ' + fmt(g.hPt) + ' pt in each badge’s ' +
      cornerName + ' corner (x ' + fmt(g.reserveX0) + '–' + fmt(g.reserveX1) +
      ', y ' + fmt(g.reserveY0) + '–' + fmt(g.reserveY1) + '). Lines level with it get ' +
      fmt(g.availW) + ' pt of width instead of ' + fmt(g.fullW) + ' pt and centre on ' +
      fmt(g.center) + ' instead of ' + fmt(g.fullCenter) + ' — so they sit ' +
      fmt(Math.abs(g.fullCenter - g.center)) + ' pt ' +
      (g.center < g.fullCenter ? 'left' : 'right') + ' of the unaffected lines, by design.';
  }

  /* ------------------------------------------------------------------ lifecycle */

  /* Deliberately NOT an allow-list: sheet-wide settings arrive under event names other
     modules choose, and a missed name means a panel showing stale numbers. Re-rendering
     on an unrelated notification costs a few microseconds. */
  function onStoreChange(change) {
    if (!logoEls) return;
    if (busy) return;
    var type = (change && change.type) || '';
    if (type.indexOf('logo') !== -1 || type === '') renderLogo();
    if (type.indexOf('align') !== -1 || type === '') renderAlign();
    if (type.indexOf('sheet') !== -1 || type.indexOf('preset') !== -1 || type === '') renderSheet();
  }

  /**
   * mount(opts) - build the panel and start listening. Idempotent.
   * opts.container (optional) lets a caller or a test mount into its own node.
   * `opts.after` is the node to insert after when the container has to be created.
   */
  function mount(opts) {
    var document = doc();
    if (!document || typeof document.createElement !== 'function') {
      console.warn('[BadgeSheetSettings] no document - nothing to mount.');
      return null;
    }
    if (!deps()) return null;

    var panel = (opts && opts.container) ||
                createSheetPanel(document, opts && opts.after);
    if (!panel) {
      console.warn('[BadgeSheetSettings] found no place to mount the sheet settings panel.');
      return null;
    }
    retirePanel(logoEls && logoEls.panel, panel);
    logoEls = buildLogoSection(panel);

    if (unsubscribe) {
      try { unsubscribe(); } catch (err) { /* already detached */ }
      unsubscribe = null;
    }
    var store = window.BadgeStore;
    if (store && typeof store.subscribe === 'function') {
      unsubscribe = store.subscribe(onStoreChange);
    } else if (window.BadgeBus && typeof window.BadgeBus.on === 'function') {
      /* Fallback if a future store drops subscribe(): the bus carries the same events. */
      var offs = ['logo:changed', 'sheet:changed', 'preset:changed', 'align:changed']
        .map(function (name) {
          return window.BadgeBus.on(name, function () { onStoreChange({ type: name }); });
        });
      unsubscribe = function () { offs.forEach(function (off) { off(); }); };
    }

    renderLogo();
    renderAlign();
    renderSheet();
    return panel;
  }

  function unmount() {
    if (unsubscribe) {
      try { unsubscribe(); } catch (err) { /* ignore */ }
      unsubscribe = null;
    }
    if (logoEls && logoEls.panel) empty(logoEls.panel);
    logoEls = null;
  }

  window.BadgeSheetSettings = {
    mount: mount,
    unmount: unmount,

    /* The exact third argument this app passes to BadgeLayout.layout(). js/overrides.js
       and anything else needing the sheet settings must go through here rather than
       resolving the reserve or the alignment for itself. */
    layoutOpts: function () {
      var d = deps();
      return d ? layoutOpts(logoConfig(d), alignConfig(d).value) : null;
    },

    /* --- logo reserve (inches, as the store holds it) --- */
    logo: function () {
      var d = deps();
      return d ? logoConfig(d) : null;
    },
    setLogo: function (patch) {
      return commitLogo(patch && typeof patch === 'object' ? patch : {});
    },
    clampInches: clampInches,

    /* --- text alignment --- */
    align: function () {
      var d = deps();
      return d ? alignConfig(d).value : null;
    },
    aligns: function () {
      var d = deps();
      return d ? alignList(d) : [];
    },
    /* Alignment plus whether it could actually be READ from the store. The override
       panel reports both in its model, so it can say "assuming left" rather than
       claiming a setting it never saw. */
    alignState: function () {
      var d = deps();
      return d ? alignConfig(d) : { value: null, unavailable: true };
    },
    setAlign: commitAlign,

    /* --- sheet layout preset --- */
    sheetPreset: function () {
      var d = deps();
      return d ? sheetPresetKey(d).key : null;
    },
    sheetPresets: function () {
      var d = deps();
      return d ? sheetPresets(d) : [];
    },
    setSheetPreset: commitSheetPreset,

    PANEL_ID: SHEET_PANEL_ID,
    LOGO_LIMITS: { minIn: logoMinIn(), maxIn: logoMaxIn(), stepIn: LOGO_STEP_IN, ptPerIn: PT_PER_IN }
  };
})(typeof window !== 'undefined' ? window : globalThis);
