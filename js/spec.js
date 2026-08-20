/*
 * js/spec.js — window.BadgeSpec
 *
 * The single source of truth for every geometric and typographic constant in the
 * badge sheet. Numbers come from BADGE_SPEC.md (measured from the sample document):
 * 612x792 pt page, 2x3 grid of 288x216 pt cells, zero margins, zero gutters.
 * Nothing here is computed at runtime and nothing here may be re-derived elsewhere.
 *
 * Classic script. No ES modules, no network, no DOM.
 */
(function () {
  'use strict';

  var COLS = 2;
  var ROWS = 3;
  var CELL_W = 288; // 4"  landscape width  of one badge cell
  var CELL_H = 216; // 3"  landscape height of one badge cell
  var INSET = 14.4; // 0.2" text-box inset on all four sides

  var BadgeSpec = {
    // ---- sheet ----------------------------------------------------------
    PAGE_W: 612, // US Letter portrait, points
    PAGE_H: 792,
    COLS: COLS,
    ROWS: ROWS,
    CELL_W: CELL_W,
    CELL_H: CELL_H,
    INSET: INSET,
    BOX_W: 259.2, // CELL_W - 2*INSET  (usable text width)
    BOX_H: 187.2, // CELL_H - 2*INSET  (usable text height)
    PER_PAGE: COLS * ROWS, // 6

    // ---- vertical rhythm -------------------------------------------------
    // advance(size) = ADVANCE_FACTOR * size. Arial hhea (1854+434+67)/2048;
    // kept with Inter glyphs so the vertical rhythm matches the sample sheet.
    ADVANCE_FACTOR: 1.1499,

    // ---- type ------------------------------------------------------------
    SIZES: { first: 36, last: 26, company: 21, title: 19 }, // ceilings, pt
    GAP_SIZE: 8, // blank line between the LAST NAME and the COMPANY
    // Blank line between COMPANY and TITLE. Tuned on a rendered sheet: 8 pt read too
    // wide, 4 pt is the halfway point between no gap at all (22.2102 pt baseline
    // separation) and 8 pt (31.4094) -> 26.8098 pt. This is the ONE number to change
    // if that judgement changes. It behaves exactly like GAP_SIZE: emitted only when
    // there is a line on both sides of it, and it contributes 1.1499 * size to
    // blockHeight. Above ~12.8 pt the vertical shrink guard in layout.js goes live
    // and starts paying for the gap by shrinking the title.
    GAP_TITLE_SIZE: 4,
    FLOORS: { first: 22, last: 16, company: 13, title: 12 }, // hard floors, pt
    WEIGHTS: { first: 700, last: 400, company: 400, title: 400 },
    // Company is 400 ITALIC in the sample (w:i on the run; sample PDF embeds an
    // italic face). Weight stays 400 — only the style changes.
    STYLES: { first: 'normal', last: 'normal', company: 'italic', title: 'normal' },
    STEP: 0.5, // shrink step, pt
    // Company wraps to at most 2 lines; TITLE to at most 3. The third title line is
    // deliberate (Julia, 2026-08-20): in-house legal titles routinely run to three
    // lines ("Executive Vice President, General Counsel & Corporate Secretary").
    // CONSEQUENCE, stated plainly: the tallest possible block becomes
    // 1.1499 * (36 + 26 + 8 + 2*21 + 4 + 3*19) = 198.93 pt against a BOX_H of
    // 187.2, so the vertical shrink guard in layout.js is now REACHABLE in normal
    // use and will shrink the title (then company, last, first) to pay for the
    // extra line. That is the intended behaviour, not an overflow.
    MAX_LINES: { company: 2, title: 3 }, // first/last never wrap

    // ---- bottom-right logo reserve (pre-printed stock) -------------------
    // One global setting for every badge; ON by default (Julia, 2026-08-20) because
    // the stock she prints on carries a pre-printed logo in every badge's
    // bottom-right corner, so reserving that corner is the normal case, not the
    // exception. Turning it OFF restores the pre-feature geometry exactly. Sizes are kept in INCHES here (and in
    // BadgeStore); converting to points is the caller's job — BadgeLayout takes
    // wPt/hPt. The reserved rectangle is measured from the RAW cell edge, not
    // from inside the 14.4 pt inset, because the logo is printed at the stock's
    // real corner: x from (CELL_W - wPt) to CELL_W, y from (CELL_H - hPt) to CELL_H.
    LOGO_DEFAULT: { enabled: true, wIn: 1, hIn: 1 },
    LOGO_MIN_IN: 0,
    LOGO_MAX_IN: 4,

    // ---- horizontal alignment -------------------------------------------
    // Sheet-wide, not per badge. LEFT is the default: all four lines flush to a
    // common left edge at INSET (14.4 pt), never to 0 — the 0.2" inset is the
    // printer safety margin and applies to the left edge as much as the right.
    // 'center' reproduces the earlier behavior exactly. Alignment is HORIZONTAL
    // ONLY: it never touches sizing, wrapping or the vertical model.
    ALIGNS: ['left', 'center'],
    ALIGN_DEFAULT: 'left',

    // ---- sheet presets ---------------------------------------------------
    // The two layouts differ ONLY in where the 2x3 block of cells starts on the
    // page. Cell size, the 14.4 pt inset, wrapping, shrinking, the logo reserve
    // and the optical centering are all cell-relative, so nothing below the sheet
    // level is affected by this choice — BadgeLayout.layout() never sees it.
    //
    //   sampleTopLeft  the sample .docx: all four page margins zero, so the block
    //                  is pinned to the page corner and prints 18 pt left and
    //                  72 pt high of the real die-cut positions. Leftover: 36 pt
    //                  right, 144 pt bottom.
    //   avery          the real Avery die-cut geometry, left 0.25 in / top 1 in,
    //                  which centers the block: 18 + 576 + 18 = 612 across and
    //                  72 + 648 + 72 = 792 down. One template covers 5392 /
    //                  74536 / 5384 / 5393 / 74459 / 74540 / 74541 / 78617 / 78619.
    SHEET_PRESETS: {
      sampleTopLeft: {
        key: 'sampleTopLeft',
        originX: 0,
        originY: 0,
        label: 'Sample layout (top-left, zero margin)'
      },
      avery: {
        key: 'avery',
        originX: 18, // 0.25 in
        originY: 72, // 1.00 in
        label: 'Avery standard (5392 / 74536 / 5384 / 74540 / 74541)'
      }
    },
    SHEET_PRESET_DEFAULT: 'sampleTopLeft',

    /**
     * Resolve a preset key to its definition. An unknown or missing key falls back
     * to the default rather than throwing: a stale value in storage should print a
     * correct sheet, not break the app.
     */
    sheetPreset: function (presetKey) {
      return BadgeSpec.SHEET_PRESETS[BadgeSpec.sheetPresetKey(presetKey)];
    },

    /**
     * Resolve a preset KEY to a valid key string (rather than to its definition).
     * Unknown, missing or non-string keys fall back to the default.
     *
     * hasOwnProperty, NOT `SHEET_PRESETS[key]`: every object inherits members from
     * Object.prototype, so a truthiness test accepts 'constructor', 'toString',
     * 'valueOf' and friends as valid preset names. Those then resolve to a function
     * with no originX/originY, and cellOrigin() returns NaN coordinates — which
     * pdf-lib rejects mid-export. Own keys only.
     */
    sheetPresetKey: function (presetKey) {
      if (typeof presetKey === 'string' &&
          Object.prototype.hasOwnProperty.call(BadgeSpec.SHEET_PRESETS, presetKey)) {
        return presetKey;
      }
      return BadgeSpec.SHEET_PRESET_DEFAULT;
    },

    /**
     * Resolve a sheet-wide alignment to a valid value, falling back to
     * ALIGN_DEFAULT. Exact match against ALIGNS — deliberately not case-normalized,
     * so 'LEFT' is simply unrecognized and lands on the default.
     */
    alignKey: function (align) {
      for (var i = 0; i < BadgeSpec.ALIGNS.length; i++) {
        if (align === BadgeSpec.ALIGNS[i]) return align;
      }
      return BadgeSpec.ALIGN_DEFAULT;
    },

    /**
     * Origin of a badge cell on its page, measured from the TOP-LEFT of the page,
     * including the sheet preset's offset. y increases DOWNWARD (PDF writers must
     * flip it themselves).
     *   sampleTopLeft: (0,0) (288,0) (0,216) (288,216) (0,432) (288,432)
     *   avery:         (18,72) (306,72) (18,288) (306,288) (18,504) (306,504)
     */
    cellOrigin: function (indexOnPage, presetKey) {
      var i = Number(indexOnPage);
      if (!isFinite(i) || i < 0 || i >= COLS * ROWS || i !== Math.floor(i)) {
        throw new Error(
          'BadgeSpec.cellOrigin: indexOnPage must be an integer 0..' +
            (COLS * ROWS - 1) +
            ', got ' +
            indexOnPage
        );
      }
      var preset = BadgeSpec.sheetPreset(presetKey);
      return {
        x: preset.originX + (i % COLS) * CELL_W,
        y: preset.originY + Math.floor(i / COLS) * CELL_H
      };
    },

    /**
     * Normalize a POINTS-based logo reserve into the exact shape the layout engine
     * and the PDF writer both consume: { enabled, wPt, hPt }.
     *
     * THE single owner of this arithmetic. js/layout.js and js/pdf.js each used to
     * carry their own copy, and the copies disagreed on negative input (one read it
     * as "you meant the default", the other as "no reserve at all") — untested in
     * both, so the preview and the print could have reserved different corners.
     *
     * Rules, in order:
     *   disabled / absent   -> off
     *   non-finite OR negative -> that dimension falls back to the 1 in default.
     *       Nonsense input resolves TOWARDS a reserve, not away from one: a missing
     *       keep-out prints text over pre-printed logo stock and wastes the sheet,
     *       which is the worse failure.
     *   oversize            -> clamped to LOGO_MAX_IN and to the cell
     *   zero                -> off (a zero-area reserve reserves nothing)
     */
    logoPt: function (cfg) {
      var off = { enabled: false, wPt: 0, hPt: 0 };
      if (!cfg || !cfg.enabled) return off;
      var maxPt = BadgeSpec.LOGO_MAX_IN * 72;
      var w = Number(cfg.wPt);
      var h = Number(cfg.hPt);
      if (!isFinite(w) || w < 0) w = BadgeSpec.LOGO_DEFAULT.wIn * 72;
      if (!isFinite(h) || h < 0) h = BadgeSpec.LOGO_DEFAULT.hIn * 72;
      w = Math.min(w, maxPt, CELL_W);
      h = Math.min(h, maxPt, CELL_H);
      if (w <= 0 || h <= 0) return off;
      return { enabled: true, wPt: w, hPt: h };
    },

    /** advance height of one line at `sizePt`, in points. */
    advance: function (sizePt) {
      return BadgeSpec.ADVANCE_FACTOR * sizePt;
    }
  };

  // Constants are constant: freeze so no other module can drift them.
  Object.freeze(BadgeSpec.SIZES);
  Object.freeze(BadgeSpec.FLOORS);
  Object.freeze(BadgeSpec.WEIGHTS);
  Object.freeze(BadgeSpec.STYLES);
  Object.freeze(BadgeSpec.MAX_LINES);
  Object.freeze(BadgeSpec.LOGO_DEFAULT);
  Object.freeze(BadgeSpec.ALIGNS);
  Object.freeze(BadgeSpec.SHEET_PRESETS.sampleTopLeft);
  Object.freeze(BadgeSpec.SHEET_PRESETS.avery);
  Object.freeze(BadgeSpec.SHEET_PRESETS);
  Object.freeze(BadgeSpec);

  window.BadgeSpec = BadgeSpec;
})();
