/*
 * js/pdf.js — window.BadgePdf
 *
 * The PDF export engine. Turns an attendee array into a print-ready Blob using
 * the vendored pdf-lib (window.PDFLib) + @pdf-lib/fontkit (window.fontkit).
 *
 * This module owns EXACTLY two things:
 *   1. the page/cell geometry and the top-left -> bottom-left coordinate flip,
 *   2. font embedding + the drawText calls.
 * It owns NO typography decisions. Every line's text, size, weight, style, x and
 * baselineY come verbatim from window.BadgeLayout.layout(); that is the single fit
 * engine shared with the on-screen preview, so preview and print cannot diverge.
 * Nothing in here wraps, shrinks, centers or measures text — including the vertical
 * centering, which is OPTICAL as of BADGE_SPEC.md Addendum 2B and lives entirely in
 * the engine. This file just draws the baselines it is handed.
 *
 * ---------------------------------------------------------------------------
 * LOGO RESERVE (BADGE_SPEC.md Addendum 2C)
 * ---------------------------------------------------------------------------
 * Pre-printed stock carries a logo in the bottom-right of every badge. The reserve
 * is a KEEP-OUT region, cell-relative from the raw cell edge:
 *     x from (288 - wPt) to 288,  y from (216 - hPt) to 216
 * Nothing is drawn for it here — no rectangle, no outline, no placeholder. The logo
 * is already physically on the paper, and the exported PDF stays text-only. (The
 * preview draws a screen-only guide; that is js/preview.js's business, not ours.)
 *
 * Our whole job is to THREAD the setting into every layout() call as the third
 * argument, so the engine narrows and re-centers the affected lines identically for
 * preview and print. Forgetting to pass it is the one failure mode this
 * architecture exists to prevent, and test/pdf.test.js asserts against it directly.
 * The setting comes from window.BadgeStore.getLogo() (INCHES -> x72 -> points), or
 * from an explicit `opts` argument when a caller supplies one.
 *
 * The same is true of `align` ('left' by default, 'center' optional): the engine
 * turns it into each line's `x`, and this file forwards the setting and draws the
 * result. Every sheet-wide setting travels in ONE object resolved once per export —
 * { logo, align } to layout(), and the preset key to cellOrigin() — so no two
 * badges on a sheet can be laid out against different settings.
 *
 * Classic script, no ES modules, no network. Fonts arrive as base64 in
 * window.InterFontData and are decoded in-browser with atob(); network loading is
 * banned by the spec and is blocked under file:// anyway.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE CONVERSION (the one thing most likely to go wrong here)
 * ---------------------------------------------------------------------------
 * BadgeSpec.cellOrigin(i) returns cell origins measured from the page TOP-left,
 * y growing DOWNWARD:   (0,0) (288,0) (0,216) (288,216) (0,432) (288,432)
 * BadgeLayout returns baselineY cell-relative, also measured DOWN from the cell top.
 * pdf-lib's origin is the page BOTTOM-left, y growing UPWARD. So:
 *
 *     pdfX          = cell.x + line.x
 *     pdfY_baseline = PAGE_H - (cell.y + line.baselineY)
 *                   = 792   - (cellTopY + baselineY)
 *
 * Sanity check baked into the tests, on the default sampleTopLeft preset: badge #1
 * (cell y=0) lands at the TOP of the sheet (pdfY near 792), badge #5 (cell y=432)
 * lands in the 432..648-from-top band, i.e. pdfY near 792-432=360 down to
 * 792-648=144 — the bottom of the PRINTED area, never inside the blank bottom band.
 *
 * cell.x / cell.y come from BadgeSpec.cellOrigin(), which is preset-aware, so the
 * one formula above covers both sheet presets. The unprinted area is therefore
 * preset-specific, and is a consequence of the origin rather than a rule of its own:
 *   sampleTopLeft  block at (0,0)    -> right 36 pt and bottom 144 pt are blank
 *   avery          block at (18,72)  -> 18 pt left/right and 72 pt top/bottom blank
 * Either way only 2 columns x 3 rows of 288x216 cells are ever drawn into.
 *
 * No borders, no crop marks, no cut lines, no background fills, no logo, no header.
 * Text only.
 */
(function () {
  'use strict';

  var DEFAULT_FILENAME = 'badges.pdf';
  // Generic on purpose: PDF metadata must never carry a real person's name.
  var PDF_TITLE = 'Name Badges';

  var PT_PER_IN = 72;
  var LOGO_DEFAULT_PT = 72; // 1 in x 1 in, per Addendum 2C
  var DISABLED_LOGO = { enabled: false, wPt: 0, hPt: 0 };

  /*
   * Inter's .notdef (glyph 0) advance is 1344/2048 em. In PDF /W units (1/1000 em)
   * that is 1344/2048*1000 = 656.25, written as the integer 656 — see
   * patchCidFontDefaultWidths() for why this constant has to exist at all.
   * Rounding 656.25 DOWN to 656 errs by 0.25/1000 em = 0.009 pt at 36 pt, and errs
   * NARROW, so measured ink can only come in tighter than the layout predicted.
   * That is the safe direction for a keep-inside-the-cell invariant.
   */
  var NOTDEF_DW = 656;

  /** Errors from font decoding/embedding, so callers can tell them apart. */
  function FontDataError(message, cause) {
    var e = new Error(message);
    e.name = 'BadgePdfFontDataError';
    if (cause) e.cause = cause;
    return e;
  }

  /* ------------------------------------------------------------------ deps */

  function requireDeps() {
    var L = window.PDFLib;
    if (!L || typeof L.PDFDocument === 'undefined') {
      throw new Error('BadgePdf: window.PDFLib is missing — load vendor/pdf-lib.min.js first.');
    }
    var fk = window.fontkit;
    if (!fk) {
      throw new Error(
        'BadgePdf: window.fontkit is missing — load vendor/pdf-lib-fontkit.min.js first. ' +
          'Subsetting an embedded TTF requires registerFontkit().'
      );
    }
    var S = window.BadgeSpec;
    if (!S) throw new Error('BadgePdf: window.BadgeSpec is missing — load js/spec.js first.');
    var LY = window.BadgeLayout;
    if (!LY || typeof LY.layout !== 'function') {
      throw new Error('BadgePdf: window.BadgeLayout is missing — load js/layout.js first.');
    }
    var FD = window.InterFontData;
    if (!FD || !FD.regularTtfBase64 || !FD.boldTtfBase64 || !FD.italicTtfBase64) {
      throw new Error(
        'BadgePdf: window.InterFontData is missing one of ' +
          'regularTtfBase64 / boldTtfBase64 / italicTtfBase64 — load fonts/inter-fontdata.js. ' +
          'There is no fallback face: substituting Helvetica would silently reflow the sheet.'
      );
    }
    return { PDFLib: L, fontkit: fk, S: S, LY: LY, FD: FD };
  }

  /**
   * base64 -> Uint8Array, using atob only. No network, no Buffer, no data: URL.
   * Whitespace in the literal is tolerated so the font data file can wrap lines.
   * A decode failure is re-thrown as a named error naming the likely cause; the raw
   * atob DOMException says nothing useful about which asset is broken.
   */
  function base64ToBytes(b64, faceLabel) {
    var clean = String(b64).replace(/[\s]/g, '');
    var bin;
    try {
      bin = atob(clean);
    } catch (err) {
      throw FontDataError(
        'Inter ' +
          faceLabel +
          ' font data is not valid base64 (' +
          clean.length +
          ' chars after whitespace was stripped). fonts/inter-fontdata.js is probably ' +
          'truncated or corrupted; re-generate it from the TTFs.',
        err
      );
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * WHY THIS FUNCTION EXISTS (a pdf-lib limitation, not a choice)
   *
   * pdf-lib builds a CID font's /W array from the glyphs it put in the subset, and
   * glyph 0 (.notdef) is never in the subset. With no /W entry and no /DW, every
   * .notdef CID advances at the PDF default DW = 1000 (1.000 em), while both
   * InterMetrics.widthOf and pdf-lib's own widthOfTextAtSize report Inter's real
   * hmtx .notdef advance of 1344/2048 = 0.65625 em. The layout engine therefore
   * measures a line 1.5238x narrower than the viewer draws it, and any text with
   * characters outside Inter's coverage (CJK, for instance) walks straight out of
   * its cell and into the neighbouring badge — breaking the one hard invariant this
   * whole item is built around. Measured before this fix: 11 CJK characters put ink
   * at x = 290.5 pt, 2.5 pt past the 288 pt cell edge.
   *
   * Fix: write an explicit /DW equal to Inter's real .notdef advance, so an unmapped
   * character advances by exactly what the engine measured.
   *
   * It has to happen between flush() and save(): the CIDFontType2 dictionary does
   * not exist until the fonts are embedded into the context, and save() would
   * otherwise be the first thing to create it. save() re-flushing afterwards leaves
   * the patch intact (fonts are only embedded once), verified in test/pdf.test.js by
   * decompressing the font dictionary out of the finished file.
   */
  function patchCidFontDefaultWidths(pdfDoc, PDFLib) {
    var SUBTYPE = PDFLib.PDFName.of('Subtype');
    var CIDFONT = PDFLib.PDFName.of('CIDFontType2');
    var DW = PDFLib.PDFName.of('DW');
    var objects = pdfDoc.context.enumerateIndirectObjects();
    var patched = 0;

    for (var i = 0; i < objects.length; i++) {
      var obj = objects[i][1];
      if (!obj || typeof obj.get !== 'function' || typeof obj.set !== 'function') continue;
      // PDFName.of() interns, so identity comparison is the idiomatic check.
      if (obj.get(SUBTYPE) !== CIDFONT) continue;
      if (obj.get(DW) === undefined) {
        obj.set(DW, PDFLib.PDFNumber.of(NOTDEF_DW));
        patched++;
      }
    }
    return patched;
  }

  /**
   * Pick the embedded face for a line. 700 -> Bold, italic -> Italic, else Regular.
   * Exactly the same mapping BadgeSpec.WEIGHTS / BadgeSpec.STYLES feed the metrics
   * module, so the widths that drove the layout are the widths that get drawn.
   */
  function faceFor(fonts, weight, style) {
    if (String(style) === 'italic') return fonts.italic;
    if (Number(weight) >= 700) return fonts.bold;
    return fonts.regular;
  }

  /* ------------------------------------------------------------- logo reserve */

  function finiteOr(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /**
   * Normalize a points-based logo config into exactly the shape layout() expects.
   * A disabled, zero-sized or non-finite config all collapse to "disabled", so the
   * engine never sees a half-configured reserve.
   */
  function normalizeLogoPt(cfg) {
    if (!cfg || !cfg.enabled) return DISABLED_LOGO;
    var S = window.BadgeSpec;
    var maxW = S ? S.CELL_W : 288;
    var maxH = S ? S.CELL_H : 216;
    var w = Math.min(Math.max(finiteOr(cfg.wPt, LOGO_DEFAULT_PT), 0), maxW);
    var h = Math.min(Math.max(finiteOr(cfg.hPt, LOGO_DEFAULT_PT), 0), maxH);
    if (w <= 0 || h <= 0) return DISABLED_LOGO;
    return { enabled: true, wPt: w, hPt: h };
  }

  /**
   * Read the reserve from the store, which keeps INCHES. Converting to points is
   * the caller's job (Addendum 2C), i.e. ours. A store without getLogo() — the
   * state before that method shipped — is treated as disabled rather than an error.
   */
  function logoFromStore() {
    var store = window.BadgeStore;
    if (!store || typeof store.getLogo !== 'function') return DISABLED_LOGO;
    var cfg;
    try {
      cfg = store.getLogo();
    } catch (err) {
      console.warn('BadgePdf: BadgeStore.getLogo() threw; treating the logo reserve as off.', err);
      return DISABLED_LOGO;
    }
    if (!cfg) return DISABLED_LOGO;
    return normalizeLogoPt({
      enabled: cfg.enabled,
      wPt: finiteOr(cfg.wIn, 1) * PT_PER_IN,
      hPt: finiteOr(cfg.hIn, 1) * PT_PER_IN
    });
  }

  /**
   * An explicit `opts` wins (keeps exportPdf testable with no store at all);
   * otherwise the live store setting is used. `{}` means "no logo key" => disabled.
   */
  function resolveLogo(opts) {
    if (opts && typeof opts === 'object') return normalizeLogoPt(opts.logo);
    return logoFromStore();
  }

  /* ------------------------------------------------------------ sheet preset */

  /*
   * The two sheet presets differ ONLY in where the 2x3 block of cells starts:
   *   sampleTopLeft  origin (0,0)   — the sample .docx, block pinned to the corner
   *   avery          origin (18,72) — the real die-cut geometry, block centered
   * Cell size, the inset, wrapping and the logo reserve are all cell-relative, so
   * the preset never reaches BadgeLayout. All this file has to do is ask
   * BadgeSpec.cellOrigin() for the origin and keep using the value it returns.
   *
   * Which is also the trap: a row index multiplied by CELL_H would silently ignore
   * the preset and misalign every badge on real stock. There is deliberately no
   * arithmetic on row/column indices anywhere in this file — cellOrigin() is the
   * only source of a cell position, and test/pdf.test.js greps for the pattern.
   */
  function validPresetKey(key) {
    var S = window.BadgeSpec;
    if (!S) return key;
    return key && S.SHEET_PRESETS && S.SHEET_PRESETS[key] ? key : S.SHEET_PRESET_DEFAULT;
  }

  function presetFromStore() {
    var S = window.BadgeSpec;
    var fallback = S ? S.SHEET_PRESET_DEFAULT : 'sampleTopLeft';
    var store = window.BadgeStore;
    if (!store || typeof store.getSheetPreset !== 'function') return fallback;
    try {
      return validPresetKey(store.getSheetPreset());
    } catch (err) {
      console.warn(
        'BadgePdf: BadgeStore.getSheetPreset() threw; falling back to ' + fallback + '.',
        err
      );
      return fallback;
    }
  }

  /** Explicit opts win; otherwise the live store setting. */
  function resolveSheetPreset(opts) {
    if (opts && typeof opts === 'object') return validPresetKey(opts.sheetPreset);
    return presetFromStore();
  }

  /* ------------------------------------------------------------- alignment */

  /*
   * Horizontal alignment of all four lines, sheet-wide. 'left' flushes every line
   * to the common left edge of the text box (cell x + 14.4 pt); 'center' centers
   * each line in the cell. LEFT IS THE DEFAULT (Julia's choice), so an omitted or
   * unrecognized value resolves to 'left' rather than to the old behaviour.
   *
   * Like the logo reserve, this is the engine's decision to implement — it comes
   * back to us as `line.x` and we draw it. Our only job is to resolve it once and
   * forward it on EVERY layout() call: a missed call site would lay the sheet out
   * against a different alignment than the preview showed.
   */
  var ALIGN_DEFAULT = 'left';
  var ALIGNMENTS = { left: 1, center: 1 };

  function validAlign(value) {
    return value && ALIGNMENTS[value] ? value : ALIGN_DEFAULT;
  }

  function alignFromStore() {
    var store = window.BadgeStore;
    if (!store || typeof store.getAlign !== 'function') return ALIGN_DEFAULT;
    try {
      return validAlign(store.getAlign());
    } catch (err) {
      console.warn(
        'BadgePdf: BadgeStore.getAlign() threw; falling back to ' + ALIGN_DEFAULT + '.',
        err
      );
      return ALIGN_DEFAULT;
    }
  }

  /** Explicit opts win; otherwise the live store setting. */
  function resolveAlign(opts) {
    if (opts && typeof opts === 'object') return validAlign(opts.align);
    return alignFromStore();
  }

  /* ------------------------------------------------------------------ build */

  /**
   * exportPdf(attendees, overrides, opts) -> Promise<Blob>
   * `overrides` is a map keyed by attendee id: { id: {first,last,company,title} }.
   * `opts`      is { logo: { enabled, wPt, hPt }, sheetPreset: 'sampleTopLeft'|'avery',
   *             align: 'left'|'center' }; omit it to use BadgeStore's current
   *             settings. Whatever is resolved goes to EVERY layout() / cellOrigin()
   *             call.
   */
  function exportPdf(attendees, overrides, opts) {
    var d;
    try {
      d = requireDeps();
    } catch (err) {
      return Promise.reject(err);
    }

    var S = d.S;
    var PDFDocument = d.PDFLib.PDFDocument;
    var list = Array.isArray(attendees) ? attendees : [];
    var ov = overrides || {};
    // Resolved ONCE, then handed to every badge: one global setting for the sheet,
    // so no two badges can be laid out against different reserves, and no two rows
    // can land on different grid origins.
    var layoutOpts = { logo: resolveLogo(opts), align: resolveAlign(opts) };
    var presetKey = resolveSheetPreset(opts);

    return PDFDocument.create().then(function (pdfDoc) {
      // Subsetting an arbitrary TTF requires fontkit.
      pdfDoc.registerFontkit(d.fontkit);

      pdfDoc.setTitle(PDF_TITLE);
      pdfDoc.setSubject('Printable name badges, 6 per US Letter sheet');
      pdfDoc.setCreator('Badge Sheet Builder');
      pdfDoc.setProducer('Badge Sheet Builder');

      var embed = function (b64, faceLabel) {
        var bytes = base64ToBytes(b64, faceLabel);
        return Promise.resolve()
          .then(function () {
            return pdfDoc.embedFont(bytes, { subset: true });
          })
          .catch(function (err) {
            // Most often a truncated/again-corrupted TTF: fontkit fails deep inside
            // its table parser with a message that names no file and no face.
            throw FontDataError(
              'Could not embed the Inter ' +
                faceLabel +
                ' face (' +
                bytes.length +
                ' bytes decoded). The TTF data in fonts/inter-fontdata.js looks ' +
                'corrupt or is not a TrueType font. There is deliberately no ' +
                'fallback face: substituting one would silently reflow every badge. ' +
                'Underlying error: ' +
                (err && err.message ? err.message : String(err)),
              err
            );
          });
      };

      return Promise.all([
        embed(d.FD.regularTtfBase64, 'Regular'),
        embed(d.FD.boldTtfBase64, 'Bold'),
        embed(d.FD.italicTtfBase64, 'Italic')
      ]).then(function (embedded) {
        var fonts = { regular: embedded[0], bold: embedded[1], italic: embedded[2] };

        var pageCount = Math.max(1, Math.ceil(list.length / S.PER_PAGE));
        for (var p = 0; p < pageCount; p++) {
          var page = pdfDoc.addPage([S.PAGE_W, S.PAGE_H]);

          for (var slot = 0; slot < S.PER_PAGE; slot++) {
            var idx = p * S.PER_PAGE + slot;
            if (idx >= list.length) break; // partial last page is fine

            var attendee = list[idx] || {};
            // The ONLY source of a cell position in this file. Preset-aware, so the
            // flip below is correct for both grid origins without any change.
            var cell = S.cellOrigin(slot, presetKey); // y from the page TOP
            // Third argument is NOT optional here: dropping it would lay the sheet
            // out against a different reserve than the preview showed.
            var res = d.LY.layout(attendee, ov[attendee.id] || null, layoutOpts);

            for (var n = 0; n < res.lines.length; n++) {
              var line = res.lines[n];
              if (!line.text) continue; // the 8 pt gap line draws nothing

              // THE FLIP: cell-relative y-from-top -> pdf-lib y-from-page-bottom.
              page.drawText(line.text, {
                x: cell.x + line.x,
                y: S.PAGE_H - (cell.y + line.baselineY),
                size: line.sizePt,
                font: faceFor(fonts, line.weight, line.style)
                // No lineHeight and no maxWidth on purpose: either one would let
                // pdf-lib re-wrap or re-space text the fit engine already decided.
              });
            }
          }
        }

        // flush() embeds the fonts (creating the CID font dicts), then the /DW patch
        // lands, then save() serializes. See patchCidFontDefaultWidths().
        return pdfDoc
          .flush()
          .then(function () {
            patchCidFontDefaultWidths(pdfDoc, d.PDFLib);
            return pdfDoc.save();
          })
          .then(function (bytes) {
            return new Blob([bytes], { type: 'application/pdf' });
          });
      });
    });
  }

  /* ------------------------------------------------------------------ mount */

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      // finally, not straight-line code: if click() throws we must still take the
      // anchor back out of the DOM and release the blob URL, or a failed export
      // leaks a hidden download link and its object URL for the life of the page.
      if (a.parentNode) document.body.removeChild(a);
      // Revoke on the next turn: Safari needs the URL to survive the click.
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 0);
    }
  }

  /**
   * mount() — adds an "Export PDF" button to #data-controls. Idempotent.
   * Every dependency is guarded: a missing module logs a warning and leaves the
   * rest of the app usable rather than throwing out of a click handler.
   */
  function mount() {
    if (typeof document === 'undefined') return;

    var host = document.getElementById('data-controls');
    if (!host) {
      console.warn('BadgePdf.mount: #data-controls not found; Export button not added.');
      return;
    }
    if (host.querySelector('[data-badge-pdf-export]')) return; // already mounted

    var wrap = document.createElement('div');
    wrap.className = 'pdf-export';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = 'Export PDF';
    btn.setAttribute('data-badge-pdf-export', '1');

    var note = document.createElement('p');
    note.className = 'pdf-export-note';
    note.setAttribute('role', 'status');
    note.hidden = true;

    function say(msg) {
      note.textContent = msg;
      note.hidden = !msg;
    }

    btn.addEventListener('click', function () {
      var store = window.BadgeStore;
      if (!store || typeof store.getAttendees !== 'function') {
        console.warn('BadgePdf: window.BadgeStore is missing; nothing to export.');
        say('Attendee storage is unavailable.');
        return;
      }

      // Reading the store is itself guarded: a store that throws must not escape as
      // an uncaught error with a dead-looking button and an empty status line.
      var attendees;
      var overrides;
      try {
        attendees = store.getAttendees() || [];
        overrides = typeof store.getOverrides === 'function' ? store.getOverrides() : {};
      } catch (err) {
        console.warn('BadgePdf: reading attendees from BadgeStore failed.', err);
        say(
          'Could not read the attendee list: ' +
            (err && err.message ? err.message : 'unknown error')
        );
        return;
      }

      if (!attendees.length) {
        say('Add at least one attendee before exporting.');
        return;
      }

      say('');
      btn.disabled = true;
      var restore = function () {
        btn.disabled = false;
      };

      var work;
      try {
        // No opts: the live BadgeStore.getLogo() setting is authoritative for the
        // button, which is what the user is looking at in the preview.
        work = exportPdf(attendees, overrides);
      } catch (err) {
        restore();
        console.warn('BadgePdf: export failed.', err);
        say('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
        return;
      }

      work.then(
        function (blob) {
          restore();
          try {
            download(blob, DEFAULT_FILENAME);
          } catch (err) {
            console.warn('BadgePdf: download failed.', err);
            say('Could not start the download.');
          }
        },
        function (err) {
          restore();
          console.warn('BadgePdf: export failed.', err);
          say('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
        }
      );
    });

    wrap.appendChild(btn);
    wrap.appendChild(note);
    host.appendChild(wrap);
  }

  window.BadgePdf = {
    exportPdf: exportPdf,
    mount: mount,
    // Exposed so the inches->points conversion and the store fallback are testable
    // without a DOM or a store. Pure; returns { enabled, wPt, hPt }.
    resolveLogo: resolveLogo,
    resolveSheetPreset: resolveSheetPreset,
    resolveAlign: resolveAlign,
    FILENAME: DEFAULT_FILENAME
  };
})();
