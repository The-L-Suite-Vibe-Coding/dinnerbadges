/*
 * js/preview.js — window.BadgePreview
 *
 * The live on-screen sheet: an 8.5 x 11 page with the 2 x 3 top-left grid of badges,
 * re-rendered whenever the data, an override, or the current page changes.
 *
 * ---------------------------------------------------------------------------
 * FIDELITY CONTRACT (the whole point of this module)
 * ---------------------------------------------------------------------------
 * Every badge is laid out by window.BadgeLayout.layout(attendee, override) and by
 * nothing else. This module does ZERO text fitting: no wrapping, no centering, no
 * shrinking, no measuring. It takes the engine's per-line {text, x, baselineY,
 * sizePt, weight, style} and paints exactly that. If it did any of its own layout,
 * the preview and the PDF would drift apart, which is the one defect this file
 * exists to prevent.
 *
 * The engine's numbers are turned into DOM attribute strings by ONE pure function,
 * renderModel() — no DOM, no globals beyond BadgeLayout, safely callable in node.
 * paintCell() then writes those strings and nothing else, so the rendered geometry
 * cannot drift from the engine without renderModel()'s node test failing.
 * See test/preview.test.js (node) and test/preview.browser.js (real browser).
 *
 * WHY SVG TEXT AND NOT ABSOLUTELY-POSITIONED DIVS
 * A <div> can only be positioned by its box, so a baseline has to be reached via
 * `top = baselineY - ascentPt(size)` with `line-height: 1`. Measured in Chrome
 * (127.0.0.1 http server, Inter 4.001, scale 1.25) that recipe is not exact:
 *
 *   size   want baseline   actual (line-height:1)   error
 *   36 pt      43.594 px          39.000 px        -4.594 px  (-3.68 pt)
 *   26 pt      31.484 px          27.000 px        -4.484 px  (-3.45 pt)
 *   21 pt      25.430 px          22.000 px        -3.430 px  (-2.74 pt)
 *   19 pt      23.008 px          20.000 px        -3.008 px  (-2.41 pt)
 *
 * Two separate causes: CSS half-leading (Inter's ascent+descent is 1.20996 em, so a
 * 1.0 line-height box shifts the baseline up by ~0.105 em) and the fact that Chrome
 * SNAPS an inline box's baseline to a whole CSS pixel — note every "actual" above is
 * an integer. Setting line-height to 1.20996 removes the leading error but the
 * pixel snap remains (~0.5 px, and it changes with zoom). test/preview.probe.html
 * reproduces the measurement.
 *
 * SVG has no line boxes: <text y> IS the alphabetic baseline, in user units, and
 * the viewBox scales it without rounding. Measured with the same probe, a baseline
 * at y = 50.5 pt landed at exactly 63.125 css px (= 50.5 * 1.25, fractional and
 * un-snapped), and a line's left edge landed within 0.000 px of x * SCALE. SVG text
 * also cannot wrap, so the browser physically cannot re-flow what the engine
 * decided. Hence: one <svg viewBox="0 0 288 216"> per badge cell, one <text> per
 * engine line, x/y straight off the engine. The div recipe was the suggested
 * mechanism; exact geometry was the requirement, so geometry won.
 *
 * KERNING IS TURNED OFF, DELIBERATELY.
 * InterMetrics.widthOf() is a plain sum of advance widths and pdf-lib's drawText()
 * does not kern either. Browsers kern (and apply ligatures) by default, which made
 * DOM text up to 1.33 px wider/narrower than the engine's measurement at 36 pt.
 * With font-kerning:none + font-variant-ligatures:none + font-feature-settings
 * "kern" 0,"liga" 0,"calt" 0, the rendered advance matched the engine to <= 0.02 pt.
 *
 * ---------------------------------------------------------------------------
 * Other notes
 * ---------------------------------------------------------------------------
 * - No network of any kind: no HTTP request of any sort, no socket, no beacon, no
 *   remote URL. (Worded without the API names on purpose, so a grep for them over
 *   this file comes back completely empty — see test/preview.test.js section 7.)
 * - Classic script, no ES modules; works from file://. Requirable in node (the
 *   DOM-touching half no-ops when `document` is absent) so the pure geometry can be
 *   tested without a browser.
 * - All user text reaches the DOM through textContent / setAttribute only. Never
 *   innerHTML. A name of "<img src=x onerror=alert(1)>" renders as those literal
 *   characters inside an SVG <text> node.
 * - The dashed cell outlines are a PREVIEW-ONLY screen guide, drawn with CSS
 *   `outline` from a <style> tag this file injects. They are not part of the badge
 *   DOM, they affect no geometry, and this module never touches the PDF path.
 * - Only the current page is built (6 badges), so typing stays cheap.
 *
 * LOGO RESERVE (ADDENDUM 2 section C)
 * Pre-printed stock carries a logo in each badge's bottom-right corner. The store
 * holds one global setting in INCHES; this module converts to points (x72) and
 * passes it to the engine on EVERY layout() call as the third argument:
 *     layout(attendee, override, { logo: { enabled, wPt, hPt } })
 * The engine owns all the narrowing and re-centering that follows — this file only
 * threads the setting through and draws the reserved rectangle as another
 * screen-only guide (a faint tint plus a dashed outline, in the same toggle as the
 * cell guides). The guide is an out-of-flow <div>, never an SVG <text>, so it
 * cannot contribute geometry and cannot reach the PDF.
 *
 * Affected lines (usually company/title) sit 28.8 pt left of the name lines with a
 * 1 in block, i.e. centre 115.2 instead of 144. That is Julia's deliberate choice
 * ("narrow and recentre only the affected lines"), not a bug to correct here.
 *
 * TEXT ALIGNMENT
 * Sheet-wide, 'left' (default) or 'center', read from BadgeStore.getAlign() and
 * carried in the SAME opts object as the logo reserve. Under 'left' every line's
 * x is BadgeSpec.INSET (14.4 pt) — the 0.2" inset is a printer safety margin on
 * the left edge just as much as the right, so lines are never flush to 0. This
 * module applies none of that itself; it reads the setting, passes it on, and
 * renders the x it is given.
 *
 * SHEET PRESET
 * The same 2x3 grid of 288x216 cells sits in one of two places on the same
 * 612x792 sheet: 'sampleTopLeft' at grid origin (0,0) (leftover 36 pt right,
 * 144 pt bottom) or 'avery' at (18,72) (0.25 in left/right, 1 in top/bottom,
 * symmetric). Read from BadgeStore.getSheetPreset() and passed to every
 * BadgeSpec.cellOrigin() call. It is a pure sheet-level translation: the cell
 * guides and the logo guide ride along with their cell because they are positioned
 * relative to it, and layout() is never told which preset is active.
 */
(function (window, document) {
  'use strict';

  /* ------------------------------------------------------------------ scale */
  /* The single pt -> css px conversion for the whole preview. 612 x 792 pt at 1.25
     gives a 765 x 990 px sheet: comfortably readable, and still narrower than the
     preview column at 1280 wide (1280 - 360 panel - 48 padding = 872). Defined
     once here; every coordinate in this file is `pt * SCALE`, nothing else. */
  var SCALE = 1.25;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STYLE_ID = 'badge-preview-style';

  var PT_PER_IN = 72;         // BadgeStore keeps inches; the engine wants points
  var FALLBACK_ALIGNS = ['left', 'center'];
  var FALLBACK_ALIGN_DEFAULT = 'left';
  var LOGO_MAX_IN = 4;        // same sane ceiling the store clamps to
  var LOGO_DEFAULT_IN = 1;    // 1 in x 1 in = 72 x 72 pt, per ADDENDUM 2 C

  /* Fallbacks used only if BadgeSpec is missing, so a missing module degrades to a
     blank-but-correct sheet instead of a thrown error. */
  var FALLBACK_SPEC = {
    PAGE_W: 612, PAGE_H: 792, CELL_W: 288, CELL_H: 216, COLS: 2, ROWS: 3, PER_PAGE: 6
  };

  var mounted = false;
  var rafId = null;
  var showGuides = true;      // preview-only cell outlines, default on
  var localPage = 0;          // page index when BadgeStore is absent
  var warned = Object.create(null);
  var els = null;             // cached nav elements, so focus survives a re-render
  var rendering = false;

  /* --------------------------------------------------------------- utilities */

  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn('[BadgePreview] ' + msg);
  }

  function spec() {
    var S = window.BadgeSpec;
    if (S && typeof S.cellOrigin === 'function') return S;
    warnOnce('spec', 'window.BadgeSpec is missing (js/spec.js not loaded) — ' +
      'falling back to the built-in 612x792 / 288x216 constants.');
    return null;
  }

  function specNum(name) {
    var S = window.BadgeSpec;
    if (S && typeof S[name] === 'number') return S[name];
    return FALLBACK_SPEC[name];
  }

  /* --------------------------------------------------------- sheet preset */
  /*
   * Two placements of the same 2x3 grid of 288x216 cells on the same 612x792 sheet
   * (ADDENDUM 3): 'sampleTopLeft' pins the block at (0,0), 'avery' centres it at
   * (18,72). It is a SHEET-LEVEL TRANSLATION and nothing else — cell size, the
   * 14.4 pt inset, the logo reserve, wrapping, shrinking and the optical centering
   * are all cell-relative and completely untouched by it. BadgeLayout.layout()
   * never learns which preset is active; only cellOrigin() moves.
   */
  var FALLBACK_PRESETS = {
    sampleTopLeft: { originX: 0, originY: 0 },
    avery: { originX: 18, originY: 72 }
  };
  var FALLBACK_PRESET_DEFAULT = 'sampleTopLeft';

  /** The default preset key, from BadgeSpec when it is loaded. */
  function defaultPresetKey() {
    var S = window.BadgeSpec;
    if (S && typeof S.SHEET_PRESET_DEFAULT === 'string') return S.SHEET_PRESET_DEFAULT;
    return FALLBACK_PRESET_DEFAULT;
  }

  /** Is `key` a preset this build knows about? */
  function knownPreset(key) {
    if (typeof key !== 'string' || !key) return false;
    var S = window.BadgeSpec;
    var table = (S && S.SHEET_PRESETS) ? S.SHEET_PRESETS : FALLBACK_PRESETS;
    return Object.prototype.hasOwnProperty.call(table, key);
  }

  /**
   * The active preset key, read from the store. BadgeStore.getSheetPreset() is
   * being added by the store item, so its absence falls back to the default rather
   * than breaking the page. An unrecognised key also falls back — a typo in
   * localStorage must not silently move every badge to a wrong place on the sheet.
   */
  function sheetPresetKey() {
    var S = window.BadgeStore;
    if (!S || typeof S.getSheetPreset !== 'function') {
      warnOnce('preset', 'BadgeStore.getSheetPreset() is not available — using the ' +
        'default sheet preset "' + defaultPresetKey() + '".');
      return defaultPresetKey();
    }
    var key;
    try {
      key = S.getSheetPreset();
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getSheetPreset() threw:', err);
      return defaultPresetKey();
    }
    if (!knownPreset(key)) {
      if (key !== undefined && key !== null && key !== '') {
        warnOnce('presetUnknown', 'unknown sheet preset ' + JSON.stringify(key) +
          ' — falling back to "' + defaultPresetKey() + '".');
      }
      return defaultPresetKey();
    }
    return key;
  }

  /**
   * Origin of one cell on the sheet, in points from the page's top-left, for the
   * given preset. Delegates to BadgeSpec so there is one source of truth; the local
   * arithmetic is only a fallback for a missing spec.js.
   */
  function cellOrigin(i, presetKey) {
    var key = knownPreset(presetKey) ? presetKey : defaultPresetKey();
    var S = spec();
    if (S) {
      try {
        return S.cellOrigin(i, key);
      } catch (err) {
        /* fall through to the local computation below */
      }
    }
    var cols = specNum('COLS');
    var p = FALLBACK_PRESETS[key] || FALLBACK_PRESETS[FALLBACK_PRESET_DEFAULT];
    return {
      x: p.originX + (i % cols) * specNum('CELL_W'),
      y: p.originY + Math.floor(i / cols) * specNum('CELL_H')
    };
  }

  function perPage() {
    var n = specNum('PER_PAGE');
    return n > 0 ? n : 6;
  }

  /* px string for a value given in points. One place, one formula. */
  function px(pt) {
    return (pt * SCALE) + 'px';
  }

  /* ------------------------------------------------- pure page-index maths */

  /** Pages needed for `attendeeCount`. An empty roster still gets one blank sheet. */
  function pageCount(attendeeCount) {
    var n = Number(attendeeCount);
    if (!isFinite(n) || n <= 0) return 1;
    var pages = Math.ceil(n / perPage());
    return pages > 0 ? pages : 1;
  }

  /**
   * Clamp a (possibly stale) page index into range for `attendeeCount`. This is what
   * stops a blank sheet from being shown after rows are deleted while the user was
   * on a later page. Garbage in (NaN, negative, fractional) also lands in range.
   */
  function clampPageIndex(pageIndex, attendeeCount) {
    var last = pageCount(attendeeCount) - 1;
    var n = Number(pageIndex);
    if (!isFinite(n)) return 0;
    n = Math.floor(n);
    if (n < 0) return 0;
    if (n > last) return last;
    return n;
  }

  /* ------------------------------------------------------------ store access */

  function store() {
    var S = window.BadgeStore;
    if (S && typeof S.getAttendees === 'function') return S;
    warnOnce('store', 'window.BadgeStore is missing (js/store.js not loaded) — ' +
      'rendering an empty sheet and keeping the page index in memory only.');
    return null;
  }

  function getAttendees() {
    var S = store();
    if (!S) return [];
    try {
      var list = S.getAttendees();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getAttendees() threw:', err);
      return [];
    }
  }

  function getOverrides() {
    var S = store();
    if (!S || typeof S.getOverrides !== 'function') return {};
    try {
      var o = S.getOverrides();
      return o && typeof o === 'object' ? o : {};
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getOverrides() threw:', err);
      return {};
    }
  }

  function readPageIndex() {
    var S = store();
    if (!S || typeof S.getPageIndex !== 'function') return localPage;
    try {
      var n = S.getPageIndex();
      return typeof n === 'number' && isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getPageIndex() threw:', err);
      return 0;
    }
  }

  /* ------------------------------------------------------ logo reserve config */

  /**
   * Read the global logo setting and convert it to POINTS for the engine.
   *
   * BadgeStore.getLogo() returns inches: { enabled, wIn, hIn }. That method is
   * being added by the store item, so its absence is treated as "disabled" rather
   * than as an error — the preview must not break on load order. Values are
   * re-validated here too: this module refuses to hand the engine a NaN or a
   * negative reserve even if a hand-edited localStorage got past the store.
   */
  function logoPt() {
    var off = { enabled: false, wPt: LOGO_DEFAULT_IN * PT_PER_IN,
                hPt: LOGO_DEFAULT_IN * PT_PER_IN };
    var S = window.BadgeStore;
    if (!S || typeof S.getLogo !== 'function') {
      warnOnce('logo', 'BadgeStore.getLogo() is not available — treating the ' +
        'bottom-right logo reserve as OFF.');
      return off;
    }
    var cfg;
    try {
      cfg = S.getLogo();
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getLogo() threw:', err);
      return off;
    }
    if (!cfg || typeof cfg !== 'object') return off;

    function inchesToPt(v) {
      var n = Number(v);
      if (!isFinite(n) || n < 0) return LOGO_DEFAULT_IN * PT_PER_IN;
      if (n > LOGO_MAX_IN) n = LOGO_MAX_IN;
      return n * PT_PER_IN;
    }
    return {
      enabled: cfg.enabled === true,
      wPt: inchesToPt(cfg.wIn),
      hPt: inchesToPt(cfg.hIn)
    };
  }

  /**
   * The single opts object handed to BadgeLayout.layout(): the logo reserve AND the
   * alignment, together, because the engine takes exactly three parameters. Pure
   * when given both arguments; falls back to the store only for an argument that is
   * omitted, which is what makes layoutOpts() with no arguments a convenient
   * "current settings" accessor. Sizes are always finite numbers and align is
   * always a known value, so the engine never has to defend against junk.
   */
  function layoutOpts(logo, align) {
    var l = logo || logoPt();
    function size(v) {
      var n = Number(v);
      return isFinite(n) && n >= 0 ? n : LOGO_DEFAULT_IN * PT_PER_IN;
    }
    return {
      logo: { enabled: l.enabled === true, wPt: size(l.wPt), hPt: size(l.hPt) },
      align: align === undefined ? alignMode() : normalizeAlign(align)
    };
  }

  /**
   * The reserved rectangle in CELL-RELATIVE points, measured from the RAW cell
   * edge (the logo is printed at the stock's real corner, not inside the 14.4 pt
   * safety inset). Returns null when disabled or degenerate. Pure — used by the
   * guide and by the tests that assert no glyph lands inside it.
   */
  function reservedRect(logo) {
    var l = logo || logoPt();
    if (!l.enabled) return null;
    var cellW = specNum('CELL_W');
    var cellH = specNum('CELL_H');
    var w = Math.min(Math.max(Number(l.wPt) || 0, 0), cellW);
    var h = Math.min(Math.max(Number(l.hPt) || 0, 0), cellH);
    if (w <= 0 || h <= 0) return null;
    return { x0: cellW - w, y0: cellH - h, x1: cellW, y1: cellH, wPt: w, hPt: h };
  }

  /* ------------------------------------------------------- text alignment */
  /*
   * Sheet-wide horizontal alignment (ADDENDUM 4): 'left' (the default) puts every
   * line's left edge on the 14.4 pt inset; 'center' is the earlier centred
   * behaviour. It travels in the SAME options object as the logo reserve — there is
   * no fourth layout() parameter — and like the logo it is purely the engine's to
   * apply. This module reads the setting and passes it on; it computes no x of its
   * own under either mode.
   */

  /** The default alignment, from BadgeSpec when it is loaded. */
  function defaultAlign() {
    var S = window.BadgeSpec;
    if (S && typeof S.ALIGN_DEFAULT === 'string') return S.ALIGN_DEFAULT;
    return FALLBACK_ALIGN_DEFAULT;
  }

  /** Coerce anything into a known alignment, falling back to the default. */
  function normalizeAlign(value) {
    var S = window.BadgeSpec;
    var list = (S && S.ALIGNS && S.ALIGNS.length) ? S.ALIGNS : FALLBACK_ALIGNS;
    for (var i = 0; i < list.length; i++) {
      if (value === list[i]) return value;
    }
    if (value !== undefined && value !== null && value !== '') {
      warnOnce('alignUnknown', 'unknown alignment ' + JSON.stringify(value) +
        ' — falling back to "' + defaultAlign() + '".');
    }
    return defaultAlign();
  }

  /**
   * The active alignment, read from the store. BadgeStore.getAlign() is being added
   * by the store item, so its absence falls back to the default rather than
   * breaking the page.
   */
  function alignMode() {
    var S = window.BadgeStore;
    if (!S || typeof S.getAlign !== 'function') {
      warnOnce('align', 'BadgeStore.getAlign() is not available — using the default ' +
        'text alignment "' + defaultAlign() + '".');
      return defaultAlign();
    }
    try {
      return normalizeAlign(S.getAlign());
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.getAlign() threw:', err);
      return defaultAlign();
    }
  }

  function writePageIndex(n) {
    localPage = n;
    var S = store();
    if (!S || typeof S.setPageIndex !== 'function') {
      // No store: nothing persists, but the nav still works this session.
      schedule();
      return;
    }
    try {
      S.setPageIndex(n); // emits page:changed, which schedules the re-render
    } catch (err) {
      console.error('[BadgePreview] BadgeStore.setPageIndex() threw:', err);
      schedule();
    }
  }

  /* ====================================================================== */
  /* ================  PURE RENDER MODEL — the anti-divergence seam  ====== */
  /* ====================================================================== */

  /**
   * One engine line -> the exact payload the DOM will receive. `attr` holds the
   * literal attribute strings written by paintLine(), so a node test that checks
   * `attr` against BadgeLayout.layout() is checking the real rendered geometry.
   * Nothing here is rounded, re-measured or re-centered.
   */
  function lineModel(ln, i) {
    var text = (ln.text === null || ln.text === undefined) ? '' : String(ln.text);
    var attr = {
      'x': String(ln.x),                    // engine's centered left edge
      'y': String(ln.baselineY),            // engine's baseline, verbatim
      'font-size': String(ln.sizePt),
      'font-weight': String(ln.weight),
      'font-style': String(ln.style),
      /* Mirror of the engine's numbers, for the anti-divergence assertions. */
      'data-field': String(ln.field),
      'data-line-index': String(i),
      'data-x': String(ln.x),
      'data-baseline-y': String(ln.baselineY),
      'data-line-top': String(ln.lineTop),
      'data-advance': String(ln.advance)
    };
    if (typeof ln.lineWidth === 'number') attr['data-line-width'] = String(ln.lineWidth);
    return {
      field: ln.field,
      text: text,
      empty: text === '',
      x: ln.x,
      baselineY: ln.baselineY,
      sizePt: ln.sizePt,
      weight: ln.weight,
      style: ln.style,
      lineTop: ln.lineTop,
      advance: ln.advance,
      lineWidth: ln.lineWidth,
      attr: attr
    };
  }

  /**
   * renderModel(attendee, override, opts) — everything the preview needs to paint
   * one badge, and nothing it computes itself. Pure: no DOM, no store, no side
   * effects. `opts` is the engine's third argument —
   * { logo: { enabled, wPt, hPt }, align: 'left'|'center' } — and every part of it
   * is passed straight through, so the node suite exercises the same logo and
   * alignment paths the browser does. Callers that omit a part get the documented
   * default for it (logo disabled, align from BadgeSpec.ALIGN_DEFAULT).
   *
   * Returns { ok, lines, blockHeight, fits, viewBox, cellW, cellH, reserve, reason }.
   * ok:false (with a `reason`) means "paint an empty cell" — a missing or throwing
   * engine must never take the page down and must never be papered over with
   * guessed text.
   */
  function renderModel(attendee, override, opts) {
    var cellW = specNum('CELL_W');
    var cellH = specNum('CELL_H');
    var logo = (opts && opts.logo) ? opts.logo : { enabled: false };
    /* An explicitly supplied align wins; anything else resolves to the default.
       renderModel never reads the store, so `opts.align === undefined` means the
       default and NOT "whatever is persisted". */
    var align = (opts && opts.align !== undefined)
      ? normalizeAlign(opts.align) : defaultAlign();
    var base = {
      ok: false, lines: [], blockHeight: 0, fits: true,
      cellW: cellW, cellH: cellH, viewBox: '0 0 ' + cellW + ' ' + cellH,
      reserve: reservedRect(logo), align: align, reason: null
    };

    if (!attendee) {
      base.reason = 'empty-cell';
      return base;
    }

    var engine = window.BadgeLayout;
    if (!engine || typeof engine.layout !== 'function') {
      warnOnce('layout', 'window.BadgeLayout is missing (js/layout.js not loaded) — ' +
        'badges cannot be laid out, so cells are left blank. No text is guessed.');
      base.reason = 'no-engine';
      return base;
    }

    var result;
    try {
      /* Third argument carries BOTH the logo reserve and the alignment. Always
         passed in full, so the engine never has to consult a global and never has
         to infer a default from an omission. */
      result = engine.layout(attendee, override || null, layoutOpts(logo, align));
    } catch (err) {
      // A throwing engine (e.g. missing InterMetrics) must not take the page down.
      warnOnce('layoutThrew', 'BadgeLayout.layout() threw — leaving that badge blank: ' +
        (err && err.message ? err.message : err));
      base.reason = 'layout-error';
      return base;
    }

    var engineLines = result && Array.isArray(result.lines) ? result.lines : [];
    var lines = [];
    for (var i = 0; i < engineLines.length; i++) lines.push(lineModel(engineLines[i], i));

    base.ok = true;
    base.lines = lines;
    base.blockHeight = result ? result.blockHeight : 0;
    base.fits = !(result && result.fits === false);
    base.warnings = (result && result.warnings) || [];
    return base;
  }

  /* ====================================================================== */
  /* ==========================  DOM half  ================================ */
  /* Everything below needs a document; it all no-ops without one so this file
     can be required in node for the pure tests above.                       */
  /* ====================================================================== */

  function haveDom() {
    return !!(document && typeof document.createElement === 'function');
  }

  /* -------------------------------------------------------- injected CSS */
  /* Preview-only. Deliberately no border/outline on anything that represents ink;
     the dashed cell outline is drawn with `outline`, which occupies no space and
     exists only on screen. */
  /*
   * WHY THIS BLOCK STAYS IN JAVASCRIPT (and js/input.js's did not)
   *
   * The `.bp-line` rules below are not presentation — they are part of the
   * preview/print fidelity contract. `font-kerning: none`, `font-variant-ligatures:
   * none` and `font-feature-settings: "kern" 0, "liga" 0, "calt" 0` are what force the
   * browser to advance text by the same plain widths InterMetrics measured and pdf-lib
   * draws. Without them the browser applies kerning and ligatures, and the preview
   * silently stops matching the PDF — the one failure this whole module is built to
   * prevent.
   *
   * A rule that correctness depends on must not be able to go missing independently of
   * the code that depends on it. In styles.css it could be edited, overridden or simply
   * not loaded (a harness that forgets the <link>) and the only symptom would be badges
   * that print differently from what was on screen. So this block ships with the module
   * that needs it, and the purely cosmetic panel CSS lives in styles.css. That split is
   * deliberate: one home for appearance, and correctness-critical rules kept next to the
   * measurement they protect.
   */
  function ensureStyle() {
    if (!haveDom() || document.getElementById(STYLE_ID)) return;
    var css = [
      '.bp-sheet { position: relative; }',
      '.bp-cell { position: absolute; overflow: visible; }',
      /* Screen guide only — obviously a UI hairline, never ink, never in the PDF. */
      '.bp-guides-on .bp-cell { outline: 1px dashed rgba(120,120,140,0.45);',
      '  outline-offset: -1px; }',
      /* Logo reserve: same screen-guide treatment. position:absolute + a zero
         contribution to flow means it can never move a glyph; pointer-events:none
         means it can never intercept a click. Hidden unless guides are on. */
      '.bp-logo-guide { position: absolute; right: 0; bottom: 0;',
      '  display: none; pointer-events: none; box-sizing: border-box;',
      '  background: rgba(120,120,140,0.09);',
      '  border: 1px dashed rgba(120,120,140,0.55); }',
      '.bp-guides-on .bp-logo-guide { display: block; }',
      '.bp-line {',
      '  font-family: Inter;',
      /* Match InterMetrics/pdf-lib exactly: plain advance widths, no kerning,
         no ligatures, no contextual alternates, no letter-spacing. */
      '  font-kerning: none;',
      '  font-variant-ligatures: none;',
      '  font-feature-settings: "kern" 0, "liga" 0, "calt" 0;',
      '  letter-spacing: 0;',
      '  white-space: pre;',
      '  text-anchor: start;',
      '  dominant-baseline: auto;',
      '  text-rendering: geometricPrecision;',
      '  fill: #000;',
      '}',
      '.bp-nav { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;',
      '  justify-content: center; }',
      '.bp-nav-label { min-width: 96px; text-align: center; }',
      '.bp-nav-meta { color: #83838d; font-size: 12px; }',
      '.bp-nav-guides { display: inline-flex; align-items: center; gap: 5px;',
      '  font-size: 12px; color: #55555e; cursor: pointer; }',
      '.bp-nav-guides input { margin: 0; }'
    ].join('\n');
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------- badge cells */

  /** One model line -> one <text>. Writes model.attr verbatim, adds no geometry. */
  function paintLine(model) {
    var t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('class', 'bp-line');
    var keys = Object.keys(model.attr);
    for (var i = 0; i < keys.length; i++) t.setAttribute(keys[i], model.attr[keys[i]]);
    t.setAttribute('xml:space', 'preserve');
    if (model.empty) t.setAttribute('data-empty', '1'); // the 8 pt gap line
    t.textContent = model.text;                          // ESCAPED BY CONSTRUCTION
    return t;
  }

  /**
   * The logo reserve, drawn as a screen-only guide: an out-of-flow <div> pinned to
   * the cell's bottom-right corner, a faint tint with a dashed edge. It is not an
   * SVG <text>, it is not inside the <svg> at all, and it is position:absolute, so
   * it contributes exactly zero to the geometry of anything. Visibility rides the
   * same `.bp-guides-on` toggle as the cell outlines. It lives only in this
   * module's DOM and CSS, so it cannot reach the exported PDF.
   */
  function paintLogoGuide(reserve) {
    var g = document.createElement('div');
    g.className = 'bp-logo-guide';
    g.style.width = px(reserve.wPt);
    g.style.height = px(reserve.hPt);
    g.setAttribute('data-logo-guide', '1');
    g.setAttribute('data-logo-w-pt', String(reserve.wPt));
    g.setAttribute('data-logo-h-pt', String(reserve.hPt));
    g.setAttribute('data-reserve-x0', String(reserve.x0));
    g.setAttribute('data-reserve-y0', String(reserve.y0));
    g.setAttribute('aria-hidden', 'true');
    g.title = 'Reserved for the pre-printed logo — screen guide only, never printed';
    return g;
  }

  /** Paint one badge into one absolutely-positioned cell. */
  function paintCell(indexOnPage, attendee, overrides, opts, presetKey) {
    var origin = cellOrigin(indexOnPage, presetKey);
    var override = (overrides && attendee && attendee.id !== undefined)
      ? (overrides[attendee.id] || null) : null;
    var model = renderModel(attendee, override, opts);

    var cell = document.createElement('div');
    cell.className = 'bp-cell';
    cell.style.left = px(origin.x);
    cell.style.top = px(origin.y);
    cell.style.width = px(model.cellW);
    cell.style.height = px(model.cellH);
    cell.setAttribute('data-cell-index', String(indexOnPage));
    cell.setAttribute('data-cell-x', String(origin.x));
    cell.setAttribute('data-cell-y', String(origin.y));

    /* Drawn on every cell, occupied or not: the pre-printed stock carries the logo
       on all six badges, so the reserve is a property of the sheet, not of a row. */
    if (model.reserve) {
      cell.setAttribute('data-logo-reserved', '1');
      cell.appendChild(paintLogoGuide(model.reserve));
    }

    if (!model.ok) {
      cell.setAttribute('data-' + (model.reason === 'empty-cell' ? 'empty' : model.reason), '1');
      return cell;
    }
    cell.setAttribute('data-attendee-id', String(attendee.id === undefined ? '' : attendee.id));
    if (!model.fits) cell.setAttribute('data-fits', 'false');

    /* The cell's own coordinate system, in POINTS. viewBox does the pt -> px
       conversion, so every number handed to the DOM is the engine's own number,
       unscaled and unrounded. */
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(model.cellW * SCALE));
    svg.setAttribute('height', String(model.cellH * SCALE));
    svg.setAttribute('viewBox', model.viewBox);
    svg.setAttribute('overflow', 'visible'); // never hide an overflow bug from me
    svg.style.overflow = 'visible';
    svg.style.display = 'block';
    svg.setAttribute('aria-hidden', 'true');

    for (var i = 0; i < model.lines.length; i++) svg.appendChild(paintLine(model.lines[i]));
    cell.appendChild(svg);
    return cell;
  }

  function buildSheet(attendees, overrides, pageIndex, opts, presetKey) {
    var sheet = document.createElement('div');
    sheet.className = 'sheet bp-sheet';
    /* The sheet outline is always the full 612 x 792 pt page; only the grid inside
       it moves between presets. */
    sheet.style.width = px(specNum('PAGE_W'));
    sheet.style.height = px(specNum('PAGE_H'));
    sheet.setAttribute('data-page-index', String(pageIndex));
    sheet.setAttribute('data-sheet-preset', String(presetKey));
    if (opts && opts.align) sheet.setAttribute('data-align', String(opts.align));
    if (opts && opts.logo && opts.logo.enabled) {
      sheet.setAttribute('data-logo-enabled', '1');
      sheet.setAttribute('data-logo-w-pt', String(opts.logo.wPt));
      sheet.setAttribute('data-logo-h-pt', String(opts.logo.hPt));
    }

    var per = perPage();
    var start = pageIndex * per;
    for (var i = 0; i < per; i++) {
      sheet.appendChild(paintCell(i, attendees[start + i] || null, overrides, opts, presetKey));
    }
    return sheet;
  }

  /* ------------------------------------------------------------------- nav */

  function buildNav(navRoot) {
    var wrap = document.createElement('div');
    wrap.className = 'bp-nav';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'bp-prev';
    prev.textContent = '‹ Previous';

    var label = document.createElement('span');
    label.className = 'bp-nav-label';

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'bp-next';
    next.textContent = 'Next ›';

    var meta = document.createElement('span');
    meta.className = 'bp-nav-meta';

    var guideLabel = document.createElement('label');
    guideLabel.className = 'bp-nav-guides';
    var guideBox = document.createElement('input');
    guideBox.type = 'checkbox';
    guideBox.className = 'bp-guide-toggle';
    guideBox.checked = showGuides;
    guideLabel.appendChild(guideBox);
    guideLabel.appendChild(document.createTextNode('Cell guides (screen only)'));

    prev.addEventListener('click', function () {
      var idx = clampPageIndex(readPageIndex(), getAttendees().length);
      if (idx > 0) writePageIndex(idx - 1);
    });
    next.addEventListener('click', function () {
      var count = getAttendees().length;
      var idx = clampPageIndex(readPageIndex(), count);
      if (idx < pageCount(count) - 1) writePageIndex(idx + 1);
    });
    guideBox.addEventListener('change', function () {
      showGuides = !!guideBox.checked;
      applyGuides();
    });

    wrap.appendChild(prev);
    wrap.appendChild(label);
    wrap.appendChild(next);
    wrap.appendChild(meta);
    wrap.appendChild(guideLabel);

    navRoot.textContent = '';
    navRoot.appendChild(wrap);

    return { prev: prev, next: next, label: label, meta: meta, guideBox: guideBox };
  }

  function applyGuides() {
    if (!haveDom()) return;
    var root = document.getElementById('preview-root');
    if (!root) return;
    if (showGuides) root.classList.add('bp-guides-on');
    else root.classList.remove('bp-guides-on');
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    if (!haveDom()) return;
    var root = document.getElementById('preview-root');
    var navRoot = document.getElementById('page-nav');
    if (!root) {
      warnOnce('root', '#preview-root is not in the document — nothing to render into.');
      return;
    }
    if (rendering) return; // belt and braces against a re-entrant render
    rendering = true;

    try {
      ensureStyle();

      var attendees = getAttendees();
      var overrides = getOverrides();
      /* Read the logo setting ONCE per paint and hand the same object to all six
         badges, so no two cells on a sheet can be laid out against different
         reserves. */
      var opts = layoutOpts(logoPt(), alignMode());
      /* Same for the sheet preset: read once, so all six cells of a sheet are
         placed against the same grid origin. */
      var presetKey = sheetPresetKey();
      var pages = pageCount(attendees.length);

      /* Clamp a stale index (rows deleted while on a later page) and push the
         clamped value back so it persists. Only when it actually changed, so this
         cannot ping-pong with the page:changed listener. */
      var idx = readPageIndex();
      var clamped = clampPageIndex(idx, attendees.length);
      var needsClamp = clamped !== idx;

      var onPage = Math.max(0, Math.min(perPage(), attendees.length - clamped * perPage()));

      root.textContent = '';
      root.appendChild(buildSheet(attendees, overrides, clamped, opts, presetKey));
      applyGuides();

      if (navRoot) {
        if (!els || !navRoot.contains(els.prev)) els = buildNav(navRoot);
        els.label.textContent = 'Page ' + (clamped + 1) + ' of ' + pages;
        els.prev.disabled = clamped <= 0;
        els.next.disabled = clamped >= pages - 1;
        els.meta.textContent = attendees.length === 0
          ? 'No attendees yet'
          : (attendees.length + (attendees.length === 1 ? ' attendee' : ' attendees') +
             ' · ' + onPage + ' on this page');
        if (els.guideBox.checked !== showGuides) els.guideBox.checked = showGuides;
      }

      if (needsClamp) writePageIndex(clamped); // schedules exactly one more render
    } catch (err) {
      console.error('[BadgePreview] render failed:', err);
    } finally {
      rendering = false;
    }
  }

  /* Coalesce the burst of notifications a single edit produces (BadgeStore both
     notifies subscribers and emits on BadgeBus) into one paint per frame.

     An animation frame is the right moment to paint, but a HIDDEN or BACKGROUND
     tab never fires requestAnimationFrame at all — the preview would then sit
     stale indefinitely, and anything reading the DOM (a test, a print) would read
     the old sheet. So a timer runs alongside as a guard and whichever fires first
     does the single paint. */
  var timerId = null;
  var pending = false;
  var FLUSH_MS = 100;

  function flush() {
    if (!pending) return;
    pending = false;
    if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
      try { window.cancelAnimationFrame(rafId); } catch (err) { /* ignore */ }
    }
    if (timerId !== null && typeof window.clearTimeout === 'function') {
      try { window.clearTimeout(timerId); } catch (err) { /* ignore */ }
    }
    rafId = null;
    timerId = null;
    render();
  }

  function schedule() {
    if (pending) return; // already queued: one paint per burst
    pending = true;
    var raf = window.requestAnimationFrame;
    if (typeof raf === 'function') rafId = raf(flush);
    if (typeof window.setTimeout === 'function') timerId = window.setTimeout(flush, FLUSH_MS);
    if (rafId === null && timerId === null) flush(); // no scheduler at all: paint now
  }

  /* ----------------------------------------------------------------- mount */

  function subscribeAll() {
    var S = window.BadgeStore;
    if (S && typeof S.subscribe === 'function') {
      try {
        S.subscribe(schedule);
      } catch (err) {
        console.error('[BadgePreview] BadgeStore.subscribe() threw:', err);
      }
    }
    var bus = window.BadgeBus;
    if (bus && typeof bus.on === 'function') {
      bus.on('data:changed', schedule);
      bus.on('override:changed', schedule);
      bus.on('page:changed', schedule);
      bus.on('logo:changed', schedule);  // bottom-right logo reserve toggled/resized
      bus.on('sheet:changed', schedule); // sample-top-left <-> Avery grid placement
      bus.on('align:changed', schedule);  // left <-> center text alignment
    } else {
      warnOnce('bus', 'window.BadgeBus is missing — relying on BadgeStore.subscribe alone.');
    }
  }

  /* The three Inter faces are declared with data: URIs in fonts/inter-face.css and
     are therefore already in the document; they are just lazily instantiated. Ask
     for them up front and repaint once they are in, so the first paint is not the
     invisible font-display:block period. No network is involved. */
  function primeFonts() {
    if (!haveDom() || !document.fonts || typeof document.fonts.load !== 'function') return;
    var faces = ['400 36px Inter', '700 36px Inter', 'italic 400 21px Inter'];
    for (var i = 0; i < faces.length; i++) {
      try {
        document.fonts.load(faces[i]);
      } catch (err) {
        /* a browser without the CSS Font Loading API just paints when it paints */
      }
    }
    if (document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(schedule, function () {});
    }
  }

  function mount() {
    if (!haveDom()) {
      warnOnce('nodom', 'mount() called with no document — nothing to render into.');
      return;
    }
    if (mounted) {
      schedule();
      return;
    }
    mounted = true;
    ensureStyle();
    subscribeAll();
    primeFonts();
    render();
  }

  window.BadgePreview = {
    mount: mount,
    render: render,          // synchronous repaint, used by the browser tests
    schedule: schedule,

    /* ---- pure, node-testable geometry (see test/preview.test.js) ---- */
    renderModel: renderModel,
    pageCount: pageCount,
    clampPageIndex: clampPageIndex,
    layoutOpts: layoutOpts,   // the exact opts object handed to the engine
    reservedRect: reservedRect,
    logoPt: logoPt,           // the store's inches, converted to points
    sheetPresetKey: sheetPresetKey,
    alignMode: alignMode,
    normalizeAlign: normalizeAlign,
    cellOrigin: cellOrigin,   // (indexOnPage, presetKey) -> sheet coords in points
    SCALE: SCALE,
    ptToPx: function (pt) { return pt * SCALE; },
    sheetSizePx: function () {
      return { w: specNum('PAGE_W') * SCALE, h: specNum('PAGE_H') * SCALE };
    },

    /* ---- UI odds and ends ---- */
    setGuides: function (on) {
      showGuides = !!on;
      if (els && els.guideBox) els.guideBox.checked = showGuides;
      applyGuides();
    },
    getGuides: function () { return showGuides; },
    getState: function () {
      var attendees = getAttendees();
      var logo = logoPt();
      return {
        attendeeCount: attendees.length,
        pages: pageCount(attendees.length),
        pageIndex: clampPageIndex(readPageIndex(), attendees.length),
        perPage: perPage(),
        scale: SCALE,
        logo: logo,
        reserve: reservedRect(logo),
        sheetPreset: sheetPresetKey(),
        align: alignMode()
      };
    }
  };

/* `document` is absent under node; the DOM half above no-ops, the pure half works. */
})(typeof window !== 'undefined' ? window : globalThis,
   typeof document !== 'undefined' ? document : null);
