/*
 * js/layout.js — window.BadgeLayout
 *
 * THE fit engine. Both the on-screen preview and the PDF exporter call this and
 * nothing else, so preview and print cannot diverge. Pure and synchronous:
 * no DOM, no canvas, no I/O, no network, no randomness, no Date, no mutable
 * globals — every input arrives as an argument.
 *
 * All text measurement goes through
 *     window.InterMetrics.widthOf(text, sizePt, weight, style)
 * and all vertical ink through capHeightPt()/descenderDepthPt()/ascentPt().
 * If those globals are missing we throw instead of guessing, because a guessed
 * width would silently produce a sheet that overflows on paper.
 *
 * Coordinate system of everything returned: CELL-RELATIVE, y measured DOWN from
 * the cell TOP, x measured right from the cell LEFT edge. `x` is the left edge of
 * the line and is already horizontally centered in whatever span it belongs to.
 *
 * ---------------------------------------------------------------------------
 * A. HORIZONTAL FIT (BADGE_SPEC.md "OVERFLOW ALGORITHM", in this exact order)
 *   1. Auto-size each field independently, starting at its ceiling:
 *      - first / last  : single line, never wrap. While width > available and
 *                        size - STEP >= floor: size -= STEP.
 *      - company/title : WRAP FIRST, THEN SHRINK. At the current size try a greedy
 *                        word wrap into at most MAX_LINES lines (2 for company,
 *                        3 for title); if no such wrap has every line inside the
 *                        available width, size -= STEP and retry, down to the floor.
 *   2. Apply the caller's override delta (in STEP units, may be negative), then
 *      CLAMP hard to [floor, ceiling].
 *   2b. An override INCREASE is additionally capped at the largest step that does
 *      not start clipping, so a nudge can never cost characters.
 *   3. Re-wrap at the final size. A line that still cannot fit (a single unbroken
 *      word wider than the space) is CLIPPED with an ellipsis and warned about.
 *      Clipping is the last resort; the containment invariants always win.
 *   4. Vertical fit: while blockHeight > BOX_H, shrink the fields still above
 *      their floor in the order title, company, last, first.
 *
 * B. VERTICAL PLACEMENT — OPTICAL centering (ADDENDUM 2 section B)
 *   advance(size) = BadgeSpec.ADVANCE_FACTOR * size
 *   blockHeight   = sum of advance() over EVERY emitted line, incl. the 8 pt gap
 *   provisional     firstLineTop = (CELL_H - blockHeight) / 2
 *   baselineY       = lineTop + InterMetrics.ascentPt(size)
 *   then the whole block is SHIFTED so the visible INK box is centered:
 *     inkTop    = firstBaseline - capHeightPt(size of first inked line)
 *     inkBottom = lastBaseline  + descenderDepthPt(size of last inked line) / 2
 *     shift     = -((inkTop + inkBottom - CELL_H) / 2)
 *   (the /2 is deliberate and explained at the line itself: it makes the residual
 *   symmetric, +/-1.02 pt, whether or not the last line happens to have a descender)
 *   Centering the layout box instead left the ink 2.0-4.7 pt low, because the
 *   layout box reserves Inter's hhea ascent (0.96875 em) above the first baseline
 *   while cap height is only 0.7275 em, and reserves just 0.181 em below the last.
 *   Deliberately CONTENT-INDEPENDENT: cap height is always reserved above and
 *   descender depth always below, whether or not the text has a cap or a
 *   descender, so every badge on a sheet sits at the same height. Worst-case
 *   residual ~2 pt (a descender-less last line reads slightly high).
 *
 * C. HORIZONTAL ALIGNMENT — sheet-wide, opts.align, DEFAULT 'left'
 *   'left'   all lines share ONE left edge and the block is CENTERED in the
 *            available span ("centered block, left-aligned text"):
 *              blockWidth = widest emitted line with text
 *              blockLeft  = spanLo + (spanWidth - blockWidth) / 2, min INSET
 *            Never below INSET (14.4 pt) — the 0.2 in inset is the printer safety
 *            margin and applies to the left edge too. Available width is still
 *            BOX_W, so wrapping and shrinking are unchanged.
 *   'center' each line individually centered: x = (CELL_W - lineWidth) / 2.
 *   Anything unrecognized falls back to BadgeSpec.ALIGN_DEFAULT without throwing.
 *   Alignment decides x and NOTHING else — not sizes, not wrap points, not the
 *   vertical model. The acceptance criterion "each line's horizontal center matches
 *   the cell center" therefore holds only under 'center', by design.
 *
 * D. BOTTOM-RIGHT LOGO RESERVE (ADDENDUM 2 section C)
 *   opts.logo = { enabled, wPt, hPt }; omitted => disabled, and when disabled every
 *   number this module returns is identical to the pre-feature behavior.
 *   Reserved rectangle, cell-relative, from the RAW cell edge (the logo is printed
 *   at the stock's real corner, not inside our inset):
 *     x in [CELL_W - wPt, CELL_W],  y in [CELL_H - hPt, CELL_H]
 *   A line whose INK extent (down to baseline + full descenderDepth, NOT the
 *   advance box) intersects that y-band
 *   is laid out in the span [INSET, CELL_W - wPt] — narrower width AND a different
 *   center ((INSET + CELL_W - wPt)/2, i.e. 115.2 pt for a 1 in block instead of
 *   144). Lines that miss the band keep the full 259.2 pt span and center 144, so
 *   affected lines sit 28.8 pt left of unaffected ones. That is intended.
 *   The reserve narrows WIDTH ONLY: it never changes available height and never
 *   changes the vertical centering math.
 *
 *   Which lines intersect depends on the block's vertical position, which depends
 *   on the sizes, which depend on the available width — so the solve ITERATES TO A
 *   FIXED POINT. The narrowed set only ever grows (monotone), which both guarantees
 *   termination in at most one pass per field and makes every intermediate state
 *   conservative. If it somehow failed to settle, the final pass uses the narrowest
 *   assumption. On top of that, emitting each line re-checks the band and clips to
 *   the reserved span as a hard backstop, so the invariant holds even if the
 *   iteration were wrong.
 *
 * Field order top to bottom: first, last, 8 pt gap, company (italic), title.
 * Company sits ABOVE title. An empty field omits only its own line; the gap line
 * is emitted only when at least one of company/title is present.
 */
(function () {
  'use strict';

  var EPS = 1e-9; // float slack for width/height comparisons
  var ELLIPSIS = '…';

  // Vertical shrink priority when the block is too tall (algorithm step 4).
  var HEIGHT_SHRINK_ORDER = ['title', 'company', 'last', 'first'];
  // Emission order, top to bottom.
  var FIELD_ORDER = ['first', 'last', 'company', 'title'];
  // Solve passes for the logo fixed point. The narrowed set grows monotonically and
  // there are only 4 fields, so 5 passes always suffice; 6 is belt and braces.
  var MAX_LOGO_PASSES = 6;

  function requireDeps() {
    var S = window.BadgeSpec;
    if (!S) {
      throw new Error('BadgeLayout: window.BadgeSpec is missing — load js/spec.js first.');
    }
    var M = window.InterMetrics;
    var needed = ['widthOf', 'ascentPt', 'capHeightPt', 'descenderDepthPt'];
    for (var i = 0; i < needed.length; i++) {
      if (!M || typeof M[needed[i]] !== 'function') {
        throw new Error(
          'BadgeLayout: window.InterMetrics is missing or incomplete (needs ' +
            needed.join('(), ') +
            '()). Layout refuses to guess text widths or ink heights.'
        );
      }
    }
    return { S: S, M: M };
  }

  // ---- text normalization -------------------------------------------------
  // Character classes are BUILT FROM CODE POINTS on purpose. This source file
  // therefore contains no invisible characters of its own (which would be
  // unreviewable in a diff) and no literal U+2028/U+2029, which are line
  // terminators in JS source and would break the parser.
  function cpClass(cps) {
    var out = '';
    for (var i = 0; i < cps.length; i++) {
      var h = cps[i].toString(16).toUpperCase();
      while (h.length < 4) h = '0' + h;
      out += '\\u' + h;
    }
    return out;
  }

  // Zero-width / invisible characters that spreadsheets and web copy-paste
  // sprinkle into names. They show no ink but DO carry an advance width: an
  // unmapped code point falls back to Inter's .notdef (1344 units), so ONE
  // pasted U+200B shifts a "centered" line by ~7 pt at 21 pt. Strip them before
  // anything is measured.
  //   200B ZWSP   200C ZWNJ   200D ZWJ    FEFF BOM     00AD soft hyphen
  //   200E LRM    200F RLM    2060 WJ     061C ALM     180E Mongolian vowel sep
  var INVISIBLE_RE = new RegExp(
    '[' + cpClass([0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad, 0x200e, 0x200f, 0x2060, 0x061c, 0x180e]) + ']',
    'g'
  );

  // Whitespace the word wrapper MAY break at. Deliberately EXCLUDES the
  // non-breaking spaces 00A0 NBSP, 2007 figure space and 202F narrow NBSP:
  // those keep their advance width but must never become a wrap opportunity,
  // which is the entire point of a non-breaking space. They pass through
  // normalization untouched, and since the wrapper splits on U+0020 only, a
  // name joined by an NBSP stays on one line.
  var BREAKING_WS_RE = new RegExp(
    '[' +
      cpClass([
        0x0020, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0085, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
        0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000
      ]) +
      ']+',
    'g'
  );

  // Edge trim: ordinary whitespace plus the non-breaking spaces, which carry no
  // meaning at the start or end of a field.
  var EDGE_WS_RE = new RegExp(
    '^[\\s' + cpClass([0x00a0, 0x2007, 0x202f]) + ']+|[\\s' + cpClass([0x00a0, 0x2007, 0x202f]) + ']+$',
    'g'
  );

  // A badge field longer than this is meaningless (malformed CSV cell, pasted
  // paragraph). Truncate before measuring so clipToWidth can never be handed a
  // 20k-character string and stall the preview.
  var MAX_FIELD_CHARS = 300;

  /**
   * Normalize a field value: drop invisibles, collapse breaking whitespace, trim,
   * hard-cap the length. Non-strings tolerated. Never throws.
   */
  function clean(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(INVISIBLE_RE, '').replace(BREAKING_WS_RE, ' ').replace(EDGE_WS_RE, '');
    if (s.length > MAX_FIELD_CHARS) {
      s = s.slice(0, MAX_FIELD_CHARS).replace(EDGE_WS_RE, '');
    }
    return s;
  }

  /**
   * Per-field measuring closure. Every width in this module comes from one of
   * these, so a field can never be measured with the wrong weight/style.
   */
  function measurer(M, weight, style) {
    return function (str, sizePt) {
      return M.widthOf(str, sizePt, weight, style);
    };
  }

  /**
   * Greedy word wrap that must succeed strictly: every produced line <= maxW and
   * at most maxLines lines. Returns an array of lines, or null if impossible.
   */
  function wrapStrict(wordList, sizePt, maxW, maxLines, width) {
    var lines = [];
    var i = 0;
    while (i < wordList.length) {
      if (lines.length >= maxLines) return null; // would need another line
      var cur = wordList[i];
      if (width(cur, sizePt) > maxW + EPS) return null; // unbreakable word
      i++;
      while (i < wordList.length) {
        var cand = cur + ' ' + wordList[i];
        if (width(cand, sizePt) > maxW + EPS) break;
        cur = cand;
        i++;
      }
      lines.push(cur);
    }
    return lines.length ? lines : null;
  }

  /**
   * Last-resort wrap: same greedy packing, but never fails. Fills the first
   * maxLines-1 lines greedily and dumps whatever is left on the final line.
   * Any over-wide line is clipped afterwards by clipToWidth().
   */
  function wrapForced(wordList, sizePt, maxW, maxLines, width) {
    var lines = [];
    var i = 0;
    while (i < wordList.length && lines.length < maxLines - 1) {
      var cur = wordList[i];
      i++;
      while (i < wordList.length && width(cur + ' ' + wordList[i], sizePt) <= maxW + EPS) {
        cur = cur + ' ' + wordList[i];
        i++;
      }
      lines.push(cur);
    }
    if (i < wordList.length) lines.push(wordList.slice(i).join(' '));
    return lines;
  }

  /**
   * Build the candidate "first n characters + ellipsis", never splitting a
   * surrogate pair and never leaving a dangling space before the ellipsis.
   */
  function clipCandidate(text, n) {
    var cut = n;
    if (cut > 0) {
      var c = text.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1; // don't split an astral pair
    }
    return text.slice(0, cut).replace(EDGE_WS_RE, '') + ELLIPSIS;
  }

  /**
   * Force `text` to measure <= maxW by truncating and appending an ellipsis.
   * Returns { text, clipped }. Guarantees the returned width <= maxW (or empty).
   *
   * BINARY SEARCH on the cut point, not a linear walk: candidate width is
   * non-decreasing in n (advances are never negative), so the largest fitting n
   * is found in O(log n) measurements instead of O(n).
   */
  function clipToWidth(text, sizePt, maxW, width) {
    if (!text) return { text: '', clipped: false };
    if (width(text, sizePt) <= maxW + EPS) return { text: text, clipped: false };
    var lo = 1;
    var hi = text.length - 1;
    var best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (width(clipCandidate(text, mid), sizePt) <= maxW + EPS) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 1) return { text: clipCandidate(text, best), clipped: true };
    // Even one character + ellipsis is too wide (a reserve that eats the cell):
    // emit nothing rather than emit something that lands where it must not.
    if (width(ELLIPSIS, sizePt) <= maxW + EPS) return { text: ELLIPSIS, clipped: true };
    return { text: '', clipped: true };
  }

  /** Auto-size one no-wrap field (first/last): shrink only. */
  function autoSizeSingleLine(text, max, floor, step, maxW, width) {
    var size = max;
    while (width(text, size) > maxW + EPS && size - step >= floor - EPS) size -= step;
    return size;
  }

  /** Auto-size one wrappable field (company/title): wrap first, then shrink. */
  function autoSizeWrapped(wordList, max, floor, step, maxW, maxLines, width) {
    var size = max;
    while (wrapStrict(wordList, size, maxW, maxLines, width) === null && size - step >= floor - EPS) {
      size -= step;
    }
    return size;
  }

  function clampSize(size, floor, max) {
    if (size < floor) return floor;
    if (size > max) return max;
    return size;
  }

  /** override values are counts of STEP (0.5 pt) nudges, positive or negative. */
  function overrideDelta(override, field, step) {
    if (!override) return 0;
    var n = override[field];
    if (typeof n !== 'number' || !isFinite(n)) return 0;
    return n * step;
  }

  /**
   * Read the logo reserve out of `opts` — the ONLY source of this config, so
   * layout() stays pure. Never mutates `opts`. The clamping itself belongs to
   * BadgeSpec.logoPt(), which js/pdf.js calls too, so the engine and the PDF
   * writer cannot resolve the same reserve differently.
   */
  function readLogo(opts, S) {
    return S.logoPt(opts && opts.logo);
  }

  /**
   * Read the horizontal alignment out of `opts`. Sheet-wide setting, read only
   * from the argument so layout() stays pure. Anything that is not exactly one of
   * BadgeSpec.ALIGNS falls back to ALIGN_DEFAULT rather than throwing — a stale or
   * mistyped value in storage should print a correct sheet, not break the app.
   * Deliberately NOT case-normalized: 'LEFT' is simply unrecognized, and since the
   * default is 'left' it lands there anyway.
   */
  function readAlign(opts, S) {
    return S.alignKey(opts && opts.align);
  }

  /**
   * layout(attendee, override, opts) — see the contract in BADGE_SPEC.md.
   * attendee: { first, last, company, title } (id ignored)
   * override: { first, last, company, title } in 0.5 pt STEP units, or null
   * opts:     { logo: { enabled, wPt, hPt }, align: 'left'|'center' } or null
   */
  function layout(attendee, override, opts) {
    var deps = requireDeps();
    var S = deps.S;
    var M = deps.M;
    var a = attendee || {};
    var warnings = [];
    var i, f;

    var logo = readLogo(opts, S);
    var align = readAlign(opts, S);
    // Span available to a line: the full text box, or the narrowed span left of
    // the reserve. Both are expressed as [lo, hi] so the centering formula is one
    // formula — when the logo is off, center is (14.4 + 273.6)/2 = 144 exactly as
    // before, which is why disabling the feature reproduces the old numbers bit
    // for bit.
    var FULL_SPAN = { lo: S.INSET, hi: S.CELL_W - S.INSET };
    var NARROW_SPAN = { lo: S.INSET, hi: S.CELL_W - logo.wPt };
    var BAND_TOP = S.CELL_H - logo.hPt; // top edge of the reserved y-band
    function spanWidth(sp) {
      return Math.max(0, sp.hi - sp.lo);
    }
    function spanCenter(sp) {
      return (sp.lo + sp.hi) / 2;
    }

    var text = {
      first: clean(a.first),
      last: clean(a.last),
      company: clean(a.company),
      title: clean(a.title)
    };

    // One measurer per field, locked to that field's weight AND style.
    var width = {};
    for (i = 0; i < FIELD_ORDER.length; i++) {
      f = FIELD_ORDER[i];
      width[f] = measurer(M, S.WEIGHTS[f], S.STYLES[f]);
    }

    var words = {
      company: text.company ? text.company.split(' ') : [],
      title: text.title ? text.title.split(' ') : []
    };

    /** Final text lines for one field at one size and width, clipping as a last resort. */
    function linesFor(field, sizePt, availW) {
      var str = text[field];
      if (!str) return { lines: [], clipped: false };
      var maxLines = S.MAX_LINES[field] || 1;
      var raw;
      if (maxLines <= 1) {
        raw = [str];
      } else {
        raw = wrapStrict(words[field], sizePt, availW, maxLines, width[field]);
        if (raw === null) raw = wrapForced(words[field], sizePt, availW, maxLines, width[field]);
      }
      var out = [];
      var clipped = false;
      for (var k = 0; k < raw.length; k++) {
        var r = clipToWidth(raw[k], sizePt, availW, width[field]);
        if (r.clipped) clipped = true;
        out.push(r.text);
      }
      return { lines: out, clipped: clipped };
    }

    /**
     * Solve the horizontal fit for one assumption about which fields must be laid
     * out in the narrowed span. Pure function of `narrowed`; called once per pass
     * of the logo fixed point (exactly once when the logo is off).
     */
    function solve(narrowed) {
      function availOf(field) {
        return spanWidth(narrowed[field] ? NARROW_SPAN : FULL_SPAN);
      }

      // ---- 1. auto-size --------------------------------------------------
      var sizes = {};
      sizes.first = text.first
        ? autoSizeSingleLine(text.first, S.SIZES.first, S.FLOORS.first, S.STEP, availOf('first'), width.first)
        : S.SIZES.first;
      sizes.last = text.last
        ? autoSizeSingleLine(text.last, S.SIZES.last, S.FLOORS.last, S.STEP, availOf('last'), width.last)
        : S.SIZES.last;
      sizes.company = text.company
        ? autoSizeWrapped(words.company, S.SIZES.company, S.FLOORS.company, S.STEP, availOf('company'), S.MAX_LINES.company, width.company)
        : S.SIZES.company;
      sizes.title = text.title
        ? autoSizeWrapped(words.title, S.SIZES.title, S.FLOORS.title, S.STEP, availOf('title'), S.MAX_LINES.title, width.title)
        : S.SIZES.title;

      // The auto-sized result is the reference for override capping: it is the
      // largest size at or below the ceiling that does not clip (unless even the
      // floor clips, in which case clipping is unavoidable).
      var autoSizes = { first: sizes.first, last: sizes.last, company: sizes.company, title: sizes.title };
      var autoClipped = {};
      var k, fld;
      for (k = 0; k < FIELD_ORDER.length; k++) {
        fld = FIELD_ORDER[k];
        autoClipped[fld] = linesFor(fld, autoSizes[fld], availOf(fld)).clipped;
      }

      // ---- 2. override, then hard clamp ----------------------------------
      for (k = 0; k < FIELD_ORDER.length; k++) {
        fld = FIELD_ORDER[k];
        sizes[fld] = clampSize(sizes[fld] + overrideDelta(override, fld, S.STEP), S.FLOORS[fld], S.SIZES[fld]);
      }

      // ---- 2b. an UPWARD nudge must never cost characters ----------------
      // Bumping a field up re-wraps it at the bigger size, which can push a word
      // past the available width and trigger clipping — i.e. a +0.5 pt nudge could
      // silently delete the tail of a company name on a printed badge. Never an
      // acceptable outcome for a nudge, so an increase is capped at the largest
      // step that still renders every character. Downward nudges are honored
      // exactly (shrinking can only reduce clipping), and a field that ALREADY
      // clips at its auto size is left alone — clipping there is unavoidable.
      var capped = {};
      for (k = 0; k < FIELD_ORDER.length; k++) {
        fld = FIELD_ORDER[k];
        if (sizes[fld] <= autoSizes[fld] + EPS || autoClipped[fld]) continue;
        var requested = sizes[fld];
        while (sizes[fld] > autoSizes[fld] + EPS && linesFor(fld, sizes[fld], availOf(fld)).clipped) {
          sizes[fld] -= S.STEP;
        }
        if (sizes[fld] < requested - EPS) capped[fld] = requested;
      }

      // ---- 3. final wrap / clip ------------------------------------------
      var lineSets = {};
      for (k = 0; k < FIELD_ORDER.length; k++) {
        fld = FIELD_ORDER[k];
        lineSets[fld] = linesFor(fld, sizes[fld], availOf(fld));
      }

      // Gap line between LAST and COMPANY: emitted when there is anything below it.
      var gapEmitted = !!(text.company || text.title);
      // Gap line between COMPANY and TITLE: only when BOTH sides exist, so a
      // missing company or title can never leave a dangling blank line.
      var gapTitleEmitted = !!(lineSets.company.lines.length && lineSets.title.lines.length);

      function blockHeightOf() {
        var h = 0;
        for (var j = 0; j < FIELD_ORDER.length; j++) {
          h += lineSets[FIELD_ORDER[j]].lines.length * S.ADVANCE_FACTOR * sizes[FIELD_ORDER[j]];
        }
        if (gapEmitted) h += S.ADVANCE_FACTOR * S.GAP_SIZE;
        if (gapTitleEmitted) h += S.ADVANCE_FACTOR * S.GAP_TITLE_SIZE;
        return h;
      }

      // ---- 4. vertical fit ------------------------------------------------
      // REACHABLE since MAX_LINES.title went 2 -> 3 (2026-08-20). The tallest
      // possible block is now 1.1499 * (36 + 26 + 8 + 2*21 + 4 + 3*19) = 198.93 pt
      // against a BOX_H of 187.2 — an 11.73 pt overshoot — so a badge that fills
      // both company lines AND all three title lines lands here and pays for the
      // extra line by shrinking, in the order title, company, last, first. (With
      // MAX_LINES.title = 2 the worst case was 177.085 pt and this loop never ran.)
      // The same headroom is also consumed by the company-to-title gap: above
      // GAP_TITLE_SIZE ~12.8 pt the loop went live even at two title lines. Both
      // paths are exercised by the test suite (sections 5 and 20).
      // The logo reserve does NOT affect available height — it narrows width only —
      // so it cannot make the loop run, though by forcing extra wrapping it can
      // change how many lines there are to be too tall in the first place.
      var tooTall = false;
      var blockHeight = blockHeightOf();
      while (blockHeight > S.BOX_H + EPS) {
        var victim = null;
        for (k = 0; k < HEIGHT_SHRINK_ORDER.length; k++) {
          var cand = HEIGHT_SHRINK_ORDER[k];
          if (lineSets[cand].lines.length && sizes[cand] - S.STEP >= S.FLOORS[cand] - EPS) {
            victim = cand;
            break;
          }
        }
        if (!victim) {
          tooTall = true;
          break;
        }
        sizes[victim] -= S.STEP;
        lineSets[victim] = linesFor(victim, sizes[victim], availOf(victim));
        blockHeight = blockHeightOf();
      }

      return {
        sizes: sizes,
        lineSets: lineSets,
        gapEmitted: gapEmitted,
        gapTitleEmitted: gapTitleEmitted,
        blockHeight: blockHeight,
        capped: capped,
        tooTall: tooTall
      };
    }

    /**
     * Turn a solved fit into positioned rows: stack by advance, then shift the
     * whole block so the visible INK box is vertically centered in the cell.
     * Vertical placement is completely independent of the logo reserve.
     */
    function place(sol) {
      var rows = [];
      function add(field, str, sizePt, weight, style, measure) {
        rows.push({
          field: field,
          text: str,
          sizePt: sizePt,
          weight: weight,
          style: style,
          measure: measure,
          advance: S.ADVANCE_FACTOR * sizePt
        });
      }
      function addField(field) {
        var set = sol.lineSets[field];
        for (var n = 0; n < set.lines.length; n++) {
          add(field, set.lines[n], sol.sizes[field], S.WEIGHTS[field], S.STYLES[field], width[field]);
        }
      }
      addField('first');
      addField('last');
      if (sol.gapEmitted) add('gap', '', S.GAP_SIZE, 400, 'normal', width.title);
      addField('company');
      if (sol.gapTitleEmitted) add('gap', '', S.GAP_TITLE_SIZE, 400, 'normal', width.title);
      addField('title');

      var top = (S.CELL_H - sol.blockHeight) / 2;
      var r;
      for (var n = 0; n < rows.length; n++) {
        r = rows[n];
        r.lineTop = top;
        r.baselineY = top + M.ascentPt(r.sizePt);
        top += r.advance;
      }

      // Optical shift. The ink box is measured from the first and last rows that
      // actually carry text: neither gap row has ink, and on a degenerate
      // attendee with no name it would otherwise be the first row and would drag
      // the whole block down. Cap height and descender depth are reserved
      // unconditionally (content-independent), so every badge shifts the same way
      // for the same sizes.
      var firstInk = null;
      var lastInk = null;
      for (n = 0; n < rows.length; n++) {
        if (rows[n].text) {
          if (firstInk === null) firstInk = rows[n];
          lastInk = rows[n];
        }
      }
      var shift = 0;
      if (firstInk) {
        var inkTop = firstInk.baselineY - M.capHeightPt(firstInk.sizePt);
        // HALF the descender depth, and the /2 is NOT a typo. Whether the last
        // line actually has a descender is content, and we refuse to look at
        // content here (content-aware centering makes badges on one sheet sit up
        // to 2.7 pt apart, which is visible in a row of six). Reserving the FULL
        // depth is correct only when a descender is present and leaves a
        // descender-less line reading 2.05 pt high — just outside the +/-2 pt
        // criterion. Reserving HALF centers on the expected ink extent and makes
        // the error symmetric: +1.02 pt with a descender, -1.02 pt without. It is
        // a minimax choice between the two shapes we cannot distinguish.
        var inkBottom = lastInk.baselineY + M.descenderDepthPt(lastInk.sizePt) / 2;
        shift = -((inkTop + inkBottom - S.CELL_H) / 2);
        for (n = 0; n < rows.length; n++) {
          rows[n].lineTop += shift;
          rows[n].baselineY += shift;
        }
      }
      return { rows: rows, shift: shift };
    }

    /**
     * Does a row's INK intersect the reserved band?
     *
     * Deliberately NOT the advance box. Descender ink hangs below it: the box
     * bottom is baseline + (ADVANCE_FACTOR - ascent/upem) * size = baseline +
     * 0.18115 em, while real lowercase ink reaches baseline + descenderDepth =
     * 0.21582 em. So a line whose box clears the band by a hair can still drop
     * ~0.2 pt of descender ink into the reserved corner — measured at 0.179 pt on a
     * 1 in reserve. A keep-out must use the WORST case, so this takes the full
     * descender depth and applies it to every line regardless of whether its text
     * happens to contain a descender. (Optical centring, by contrast, uses HALF the
     * depth: there we want the expected extent, not the worst case. Different
     * questions, deliberately different numbers.)
     */
    function intersectsBand(row) {
      if (!logo.enabled) return false;
      var inkBottom = Math.max(
        row.lineTop + row.advance,
        row.baselineY + M.descenderDepthPt(row.sizePt)
      );
      return inkBottom > BAND_TOP + EPS && row.lineTop < S.CELL_H - EPS;
    }

    // ---- the logo fixed point ---------------------------------------------
    // `narrowed` only ever gains fields, which guarantees termination (at most one
    // gain per field, then a confirming pass) and keeps every step conservative:
    // an over-narrowed field can never intrude into the reserve, it can only be
    // smaller than strictly necessary.
    var narrowed = { first: false, last: false, company: false, title: false };
    var sol = null;
    var placed = null;
    var passes = 0;
    var converged = false;
    while (passes < MAX_LOGO_PASSES) {
      passes++;
      sol = solve(narrowed);
      placed = place(sol);
      if (!logo.enabled) {
        converged = true;
        break;
      }
      var changed = false;
      for (i = 0; i < placed.rows.length; i++) {
        var row = placed.rows[i];
        if (!row.text || row.field === 'gap') continue;
        if (intersectsBand(row) && !narrowed[row.field]) {
          narrowed[row.field] = true;
          changed = true;
        }
      }
      if (!changed) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      // Cannot happen with a monotone narrowed set, but if it ever did we take the
      // narrowest assumption reached and say so, rather than shipping a layout
      // built on a stale assumption.
      sol = solve(narrowed);
      placed = place(sol);
      warnings.push(
        'The logo reserve fit did not settle in ' +
          MAX_LOGO_PASSES +
          ' passes; the narrowest safe layout was used.'
      );
    }

    // ---- emit -------------------------------------------------------------
    // Every line is re-checked against the band here. This is the backstop that
    // makes the reserve invariant unconditional: even if the iteration above had
    // chosen wrongly, a line overlapping the band is laid out in — and if need be
    // clipped to — the narrowed span, so no glyph can land in the reserve.
    //
    // Two passes, because 'left' needs to know the widest line before it can place
    // any of them: pass 1 fixes each line's text, width and span; pass 2 assigns x.
    var clippedFields = {};
    var reserveClipped = false;
    var lines = [];
    for (i = 0; i < placed.rows.length; i++) {
      var rw = placed.rows[i];
      var hit = intersectsBand(rw);
      var span = hit ? NARROW_SPAN : FULL_SPAN;
      var availW = spanWidth(span);
      var str = rw.text;
      if (str) {
        var res = clipToWidth(str, rw.sizePt, availW, rw.measure);
        if (res.clipped) {
          clippedFields[rw.field] = rw.sizePt;
          if (hit) reserveClipped = true;
          str = res.text;
        }
      }
      var w = str ? rw.measure(str, rw.sizePt) : 0;
      lines.push({
        text: str,
        field: rw.field,
        sizePt: rw.sizePt,
        weight: rw.weight,
        style: rw.style,
        align: align,
        xCenterOffset: 0,
        lineWidth: w,
        x: 0, // assigned in pass 2
        lineTop: rw.lineTop,
        advance: rw.advance,
        baselineY: rw.baselineY,
        narrowed: hit,
        spanLo: span.lo,
        spanHi: span.hi
      });
    }

    // ALIGNMENT — horizontal only, and the ONLY thing it decides is x. Note that
    // each line's span (hence availW above, hence every wrap and shrink decision)
    // is identical under both alignments: the logo reserve narrows the available
    // width the same way whether the text is flush left or centered. That is why
    // appliedSizes, wrap points and line counts are provably alignment-invariant.
    //
    //   center -> each line centered in its OWN span: 144 normally, 115.2 for a
    //             line level with a 1 in reserve.
    //   left   -> all lines share ONE left edge, and the resulting block is
    //             CENTERED in the available span (the standard "centered block,
    //             left-aligned text" layout):
    //                 blockWidth = widest emitted line with text
    //                 blockLeft  = spanLo + (spanWidth - blockWidth) / 2
    //             clamped so blockLeft never goes below the inset. When the widest
    //             line fills the span exactly, blockLeft lands on the inset and the
    //             result is flush-left against the safety margin.
    //
    // The span used for the BLOCK is the tightest one any inked line is subject to:
    // spanLo is always INSET, and the right edge is the minimum spanHi across the
    // inked lines. That keeps the block inside the reserve's remaining space when
    // any line is level with the logo, and — because a reserve narrower than the
    // inset would otherwise widen the span — never lets a line past the right
    // inset edge either.
    var blockWidth = 0;
    var blockHi = FULL_SPAN.hi;
    var anyInk = false;
    for (i = 0; i < lines.length; i++) {
      if (!lines[i].text) continue;
      anyInk = true;
      if (lines[i].lineWidth > blockWidth) blockWidth = lines[i].lineWidth;
      if (lines[i].spanHi < blockHi) blockHi = lines[i].spanHi;
    }
    var blockLeft = S.INSET;
    if (anyInk) {
      var blockSpanW = Math.max(0, blockHi - S.INSET);
      blockLeft = S.INSET + Math.max(0, (blockSpanW - blockWidth) / 2);
    }
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      ln.x = align === 'center' ? (ln.spanLo + ln.spanHi) / 2 - ln.lineWidth / 2 : blockLeft;
      delete ln.spanLo;
      delete ln.spanHi;
    }

    // Fields clipped during the solve (not just at emit time) count too.
    for (i = 0; i < FIELD_ORDER.length; i++) {
      f = FIELD_ORDER[i];
      if (sol.lineSets[f].clipped && clippedFields[f] === undefined) {
        clippedFields[f] = sol.sizes[f];
      }
    }

    // ---- warnings ---------------------------------------------------------
    var fits = true;
    if (sol.tooTall) {
      fits = false;
      warnings.push(
        'Block is ' +
          sol.blockHeight.toFixed(2) +
          ' pt tall; every field is already at its floor, so it cannot fit the ' +
          S.BOX_H +
          ' pt text box.'
      );
    }
    for (i = 0; i < FIELD_ORDER.length; i++) {
      f = FIELD_ORDER[i];
      if (sol.capped[f] !== undefined) {
        warnings.push(
          'The ' +
            f +
            ' nudge was capped at ' +
            sol.sizes[f] +
            ' pt (requested ' +
            sol.capped[f] +
            ' pt): anything larger would have cut characters off the ' +
            f +
            '.'
        );
      }
    }
    for (i = 0; i < FIELD_ORDER.length; i++) {
      f = FIELD_ORDER[i];
      if (clippedFields[f] === undefined) continue;
      fits = false;
      // Report the size ACTUALLY used, and the width it actually had to fit.
      var usedSize = clippedFields[f];
      var atFloor = usedSize <= S.FLOORS[f] + EPS;
      var narrowedHere = narrowed[f] || reserveClipped;
      warnings.push(
        f +
          ' does not fit ' +
          (narrowedHere ? spanWidth(NARROW_SPAN).toFixed(1) + ' pt (narrowed by the logo reserve)' : S.BOX_W + ' pt') +
          ' at the ' +
          usedSize +
          ' pt size used' +
          (atFloor ? ' (its floor)' : ' (floor is ' + S.FLOORS[f] + ' pt)') +
          ', so it was clipped to stay inside the badge.'
      );
    }
    if (!lines.length) warnings.push('Attendee has no printable fields.');

    return {
      lines: lines,
      blockHeight: sol.blockHeight,
      appliedSizes: {
        first: sol.sizes.first,
        last: sol.sizes.last,
        company: sol.sizes.company,
        title: sol.sizes.title
      },
      fits: fits,
      warnings: warnings,
      // Diagnostics — not part of the fixed contract, but the preview and the
      // verification doc both want them and recomputing them would risk drift.
      opticalShift: placed.shift,
      align: align,
      blockWidth: blockWidth,
      blockLeft: blockLeft,
      logo: logo.enabled
        ? {
            enabled: true,
            wPt: logo.wPt,
            hPt: logo.hPt,
            reserve: { x0: S.CELL_W - logo.wPt, y0: BAND_TOP, x1: S.CELL_W, y1: S.CELL_H },
            narrowedFields: narrowed,
            passes: passes,
            converged: converged
          }
        : { enabled: false }
    };
  }

  window.BadgeLayout = { layout: layout };
})();
