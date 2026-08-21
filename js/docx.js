/*
 * js/docx.js - window.BadgeDocx
 *
 * The .docx export. Produces a Word document that opens in Word, Google Docs and
 * LibreOffice, reproducing the badge sheet as a real table so it can still be edited.
 *
 * Like js/pdf.js, this file owns EXACTLY two things:
 *   1. the OOXML (WordprocessingML) markup and the points -> twips conversion,
 *   2. the ZIP packaging, via window.BadgeZip.
 * It owns NO typography decisions. Every line's text, size, weight, style and x comes
 * verbatim from window.BadgeLayout.layout() - the same single fit engine the preview
 * and the PDF use - so a badge cannot be laid out three different ways.
 *
 * ---------------------------------------------------------------------------
 * ARIAL, NOT INTER (Julia's call, 2026-08-20)
 * ---------------------------------------------------------------------------
 * The .docx names Arial. The app measures, previews and prints in Inter, so this is
 * the one place where the output is deliberately NOT metric-identical to the PDF.
 * The reasoning: Word has no fallback-font list like CSS. If the file named Inter and
 * the machine opening it did not have Inter installed, Word would silently substitute
 * something else and every badge would shift - a failure with no warning. Arial is
 * present everywhere and is what the original sample .docx used.
 *
 * The practical error is small and bounded, because we do NOT ask Word to lay text
 * out: every line break is already decided by the engine and emitted as its own
 * paragraph, so Arial's slightly different glyph widths change how wide a line looks,
 * never where it breaks. BadgeSpec.ADVANCE_FACTOR is itself Arial's hhea metric
 * (see js/spec.js), so the vertical rhythm is Arial-correct by construction.
 *
 * PRINT FROM THE PDF. That is the exact-by-construction output. This file exists so a
 * sheet can be shared, edited, or opened by someone who only has Google Docs.
 *
 * ---------------------------------------------------------------------------
 * HOW THE ENGINE'S GEOMETRY BECOMES WORD MARKUP
 * ---------------------------------------------------------------------------
 * Word measures in twips: 1 pt = 20 twips, so the sample's numbers are ours x20.
 *
 *   page          612 x 792 pt          -> w:pgSz 12240 x 15840
 *   sheet preset  grid origin           -> w:pgMar left/top (see sectionProps)
 *   cell          288 x 216 pt          -> w:tcW 5760 dxa, w:trHeight exact 4320
 *   line advance  ADVANCE_FACTOR * size -> SINGLE spacing (they are the same number:
 *                                          1.1499 is Arial's own line height)
 *   line x        engine's line.x       -> w:ind w:left
 *   size          engine's sizePt       -> w:sz (HALF-points, so x2)
 *
 * One paragraph per engine line, including the blank gap lines - those carry real
 * height in the engine's model, and an empty paragraph at the gap's font size
 * reproduces it.
 *
 * ALIGNMENT is expressed as an INDENT, never as w:jc center, under both alignment
 * modes. The engine has already put horizontal position into line.x, and that x is
 * what encodes both the "centred block, one shared left edge" default AND the
 * narrower position of any line sitting level with the logo reserve. Centring in Word
 * would recompute a position from Arial's widths and throw both away.
 *
 * Cell margins are forced to zero (w:tblCellMar / w:tcMar). Word's default is 108
 * twips of left padding, which would shift every indent by 5.4 pt.
 *
 * KNOWN LIMIT, and the numbers are measured, not estimated. Vertical placement uses
 * w:vAlign center, which centres the block of paragraphs in the CELL. The engine's own
 * centring is OPTICAL - it centres visible ink (js/layout.js section B) - which sits a
 * little higher. Rendered through LibreOffice and compared word-by-word against our own
 * PDF of the same roster, text lands +3.9 to +6.7 pt lower (mean +4.3).
 *
 * The obvious fix - anchor the cell to the top and give the first paragraph the
 * engine's own lineTop as spacing-before - was built and MEASURED, and it is worse:
 * the spread went to -38.6..+0.5 pt, because w:contextualSpacing and Word's
 * suppress-space-at-top-of-cell rule swallow that offset unevenly. A uniform few
 * points low beats an erratic error on a printed sheet, so vAlign center stays.
 * Horizontal error is -9.9..+0.1 pt (mean -2.1): each line STARTS exactly where the
 * engine put it, and Arial's narrower glyphs pull later words in the same line left.
 *
 * Settings (logo reserve, alignment, sheet preset) are resolved through
 * window.BadgePdf's resolvers, deliberately: reusing the PDF's resolution path is what
 * guarantees the two exports agree about the sheet they are describing.
 *
 * Classic script, no ES modules, no network. Works under file://.
 */
(function (window) {
  'use strict';

  var DEFAULT_FILENAME = 'badges.docx';
  var TWIPS_PER_PT = 20;
  var FONT = 'Arial';

  /* Generic on purpose, exactly as js/pdf.js does it: document metadata must never
     carry a real person's name. */
  var DOC_TITLE = 'Name Badges';

  var XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  /* ------------------------------------------------------------------ deps */

  function requireDeps() {
    var S = window.BadgeSpec;
    if (!S) throw new Error('BadgeDocx: window.BadgeSpec is missing - load js/spec.js first.');
    var LY = window.BadgeLayout;
    if (!LY || typeof LY.layout !== 'function') {
      throw new Error('BadgeDocx: window.BadgeLayout is missing - load js/layout.js first.');
    }
    var Z = window.BadgeZip;
    if (!Z || typeof Z.write !== 'function') {
      throw new Error('BadgeDocx: window.BadgeZip is missing - load js/zip.js first.');
    }
    return { S: S, LY: LY, Z: Z };
  }

  /* -------------------------------------------------------------- helpers */

  function twips(pt) {
    return Math.round(pt * TWIPS_PER_PT);
  }

  /*
   * XML text escaping. Also drops the C0 control characters, which are illegal in
   * XML 1.0 even escaped: one of them anywhere in the package makes the whole .docx
   * unopenable, and a pasted cell can contain them. BadgeLayout.clean() already
   * collapses real whitespace, so nothing legitimate is lost here.
   */
  function esc(s) {
    var out = '';
    var str = String(s === null || s === undefined ? '' : s);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) continue;
      var ch = str.charAt(i);
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (ch === '"') out += '&quot;';
      else if (ch === "'") out += '&apos;';
      else out += ch;
    }
    return out;
  }

  function rFonts() {
    return '<w:rFonts w:ascii="' + FONT + '" w:hAnsi="' + FONT +
           '" w:cs="' + FONT + '" w:eastAsia="' + FONT + '"/>';
  }

  /** Run properties for one engine line: font, size (half-points), bold, italic. */
  function runProps(line) {
    var half = Math.round(line.sizePt * 2);
    var s = '<w:rPr>' + rFonts();
    if (Number(line.weight) >= 700) s += '<w:b/><w:bCs/>';
    if (String(line.style) === 'italic') s += '<w:i/><w:iCs/>';
    s += '<w:sz w:val="' + half + '"/><w:szCs w:val="' + half + '"/>';
    s += '<w:color w:val="000000"/>';
    s += '</w:rPr>';
    return s;
  }

  /**
   * One engine line -> one paragraph.
   *
   * `w:ind w:left` carries the engine's x. A gap line has no text, so it emits no run at
   * all - the paragraph mark's size (set in the pPr's rPr) is what gives it its height.
   * Line spacing is SINGLE, for the reason spelled out below.
   */
  function paragraph(line, S) {
    var indent = Math.max(0, twips(line.x));
    var p = '<w:p><w:pPr>';
    /*
     * SINGLE spacing (240 = 1.0 line, lineRule auto), NOT a locked exact height.
     *
     * This looks like the weaker choice and is the stronger one. BadgeSpec.ADVANCE_FACTOR
     * is 1.1499, which is Arial's own hhea line height ((1854+434+67)/2048) - so single
     * spacing in Arial ALREADY produces exactly the advance the engine computed, and the
     * rhythm comes out right without asking the word processor to honour anything unusual.
     *
     * The previous version pinned w:line to ADVANCE_FACTOR * size with lineRule="exact".
     * Word honoured it; Google Docs did not, and substituted its own larger line height -
     * which made every badge's block taller than the cell, grew the rows (Docs treats a
     * row height as a MINIMUM, not a maximum) and pushed badges into extra rows. Depending
     * on a feature one of the two target readers mishandles was the mistake; single spacing
     * is understood identically by Word, Google Docs and LibreOffice.
     */
    p += '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>';
    p += '<w:ind w:left="' + indent + '" w:right="0" w:firstLine="0"/>';
    p += '<w:jc w:val="left"/>';
    p += runProps(line);   // sizes the paragraph mark, which is what an empty line uses
    p += '</w:pPr>';
    if (line.text) {
      p += '<w:r>' + runProps(line) +
           '<w:t xml:space="preserve">' + esc(line.text) + '</w:t></w:r>';
    }
    p += '</w:p>';
    return p;
  }

  /* An empty cell still needs one paragraph - Word rejects a <w:tc> without one. */
  function emptyParagraph() {
    return '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
           '<w:rPr>' + rFonts() + '<w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';
  }

  function cell(paragraphsXml, S) {
    var w = twips(S.CELL_W);
    return '<w:tc><w:tcPr>' +
           '<w:tcW w:w="' + w + '" w:type="dxa"/>' +
           '<w:tcMar>' +
             '<w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
             '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>' +
           '</w:tcMar>' +
           '<w:vAlign w:val="center"/>' +
           '</w:tcPr>' + paragraphsXml + '</w:tc>';
  }

  /*
   * The element ORDER here is not cosmetic. WordprocessingML is schema-ordered, and
   * Word reacts to a misordered child by dropping properties or offering to "repair"
   * the file - LibreOffice, by contrast, quietly accepts it, which is how a first
   * version of this file passed every local check and still came out wrong in Word.
   * The order below matches the sample .docx that Word itself wrote:
   *     tblW, tblLayout, tblCellMar, tblLook
   * No w:tblBorders: the sample has none, an unstyled table has no borders anyway, and
   * placing it wrongly (it must precede tblLayout) was one of the ordering faults.
   * w:tblW is 0/auto exactly as the sample has it - with a fixed layout the widths come
   * from w:tblGrid, and this is the combination known to print correctly.
   */
  function tableOpen(S) {
    var colW = twips(S.CELL_W);
    var grid = '';
    for (var c = 0; c < S.COLS; c++) grid += '<w:gridCol w:w="' + colW + '"/>';
    return '<w:tbl><w:tblPr>' +
             '<w:tblW w:w="0" w:type="auto"/>' +
             '<w:tblLayout w:type="fixed"/>' +
             '<w:tblCellMar>' +
               '<w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
               '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>' +
             '</w:tblCellMar>' +
             '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0"' +
                       ' w:lastColumn="0" w:noHBand="0" w:noVBand="0"/>' +
           '</w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>';
  }

  /*
   * Page break between sheets. A paragraph between two tables is REQUIRED anyway -
   * Word merges adjacent tables that have nothing between them - so this does two
   * jobs. Sized 1 pt with an exact 1 pt line so it costs almost no height in the
   * band below the grid.
   */
  function pageBreak() {
    return '<w:p><w:pPr>' +
           '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
           '<w:rPr>' + rFonts() + '<w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>' +
           '</w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  /*
   * The sheet preset is a grid ORIGIN in the app, and page margins in Word - the same
   * offset expressed the only way a Word table can express it. sampleTopLeft is a zero
   * margin (grid pinned to the page corner); avery is 18 pt left / 72 pt top.
   * Everything below the sheet level is cell-relative and so is untouched by this,
   * exactly as BadgeSpec.SHEET_PRESETS documents.
   */
  function sectionProps(S, presetKey) {
    var preset = S.sheetPreset(presetKey);
    return '<w:sectPr>' +
             '<w:pgSz w:w="' + twips(S.PAGE_W) + '" w:h="' + twips(S.PAGE_H) + '"/>' +
             '<w:pgMar w:top="' + twips(preset.originY) + '"' +
                     ' w:right="0"' +
                     ' w:bottom="0"' +
                     ' w:left="' + twips(preset.originX) + '"' +
                     ' w:header="720" w:footer="720" w:gutter="0"/>' +
             '<w:cols w:space="0"/>' +
             '<w:docGrid w:linePitch="360"/>' +
           '</w:sectPr>';
  }

  /* ------------------------------------------------------------ the parts */

  var CONTENT_TYPES = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  var ROOT_RELS = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  var DOC_RELS = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '</Relationships>';

  /*
   * Minimal styles.xml, and it is not optional. Word's built-in Normal style carries
   * 8 pt of space-after and 1.15 line spacing; inheriting that would add height to
   * every paragraph and break the exact vertical rhythm. Every paragraph we emit sets
   * its own spacing too - this zeroes the defaults as a second line of defence, and
   * sets Arial as the document default so an edit the user types matches the badges.
   */
  var STYLES = XML_DECL +
    '<w:styles xmlns:w="' + W_NS + '">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' + rFonts() +
        '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr>' +
        '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '</w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
        '<w:name w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' +
        '<w:rPr>' + rFonts() + '</w:rPr>' +
      '</w:style>' +
    '</w:styles>';

  /*
   * word/settings.xml, and it is the difference between a sheet that lays out and one
   * that does not. Omitting this file was the bug: with no settings part, Word does not
   * assume the current layout rules - it falls back to a LEGACY compatibility mode whose
   * line-spacing and table row-height behaviour differ, which is what made rows grow and
   * badges spill onto extra pages. LibreOffice ignores the difference entirely, which is
   * why every local check passed while Word and Google Docs both came out wrong.
   *
   * w:val="15" is what the sample .docx carries (Word 2013+ layout). Child order follows
   * the schema: defaultTabStop, characterSpacingControl, compat.
   */
  var SETTINGS = XML_DECL +
    '<w:settings xmlns:w="' + W_NS + '">' +
      '<w:defaultTabStop w:val="720"/>' +
      '<w:characterSpacingControl w:val="doNotCompress"/>' +
      '<w:compat>' +
        '<w:compatSetting w:name="compatibilityMode"' +
          ' w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
        '<w:compatSetting w:name="overrideTableStyleFontSizeAndJustification"' +
          ' w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
        '<w:compatSetting w:name="enableOpenTypeFeatures"' +
          ' w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
        '<w:compatSetting w:name="doNotFlipMirrorIndents"' +
          ' w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>' +
      '</w:compat>' +
    '</w:settings>';

  var CORE = XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:title>' + DOC_TITLE + '</dc:title>' +
      '<dc:subject>Printable name badges, 6 per US Letter sheet</dc:subject>' +
      '<dc:creator>Badge Sheet Builder</dc:creator>' +
      '<cp:lastModifiedBy>Badge Sheet Builder</cp:lastModifiedBy>' +
    '</cp:coreProperties>';

  var APP = XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
      '<Application>Badge Sheet Builder</Application>' +
    '</Properties>';

  /* ------------------------------------------------------------------ build */

  /** Resolve the sheet-wide settings through js/pdf.js, so both exports agree. */
  function resolveSettings(opts) {
    var P = window.BadgePdf;
    if (P && typeof P.resolveLogo === 'function') {
      return {
        logo: P.resolveLogo(opts),
        align: P.resolveAlign(opts),
        preset: P.resolveSheetPreset(opts)
      };
    }
    /* No js/pdf.js: fall back to the spec's own resolvers rather than guessing. */
    var S = window.BadgeSpec;
    console.warn('[BadgeDocx] window.BadgePdf is unavailable; resolving sheet settings ' +
      'from BadgeSpec defaults, which may not match the current sheet.');
    return {
      logo: S.logoPt(opts && opts.logo),
      align: S.alignKey(opts && opts.align),
      preset: S.sheetPresetKey(opts && opts.sheetPreset)
    };
  }

  /**
   * buildDocumentXml(attendees, overrides, opts) -> string
   * Exposed for the tests: the markup is worth asserting on directly, without
   * unzipping anything.
   */
  function buildDocumentXml(attendees, overrides, opts) {
    var d = requireDeps();
    var S = d.S;
    var list = Array.isArray(attendees) ? attendees : [];
    var ov = overrides || {};
    var set = resolveSettings(opts);
    /* Resolved ONCE and handed to every badge, exactly as js/pdf.js does it, so no two
       badges on a sheet can be laid out against different settings. */
    var layoutOpts = { logo: set.logo, align: set.align };

    var pageCount = Math.max(1, Math.ceil(list.length / S.PER_PAGE));
    var xml = XML_DECL + '<w:document xmlns:w="' + W_NS + '"><w:body>';

    for (var p = 0; p < pageCount; p++) {
      xml += tableOpen(S);
      for (var row = 0; row < S.ROWS; row++) {
        /* w:cantSplit is what stops Word breaking a badge row across a page boundary.
           The sample has it; omitting it is what made rows spill onto extra pages. */
        xml += '<w:tr><w:trPr><w:cantSplit/>' +
               '<w:trHeight w:hRule="exact" w:val="' + twips(S.CELL_H) + '"/></w:trPr>';
        for (var col = 0; col < S.COLS; col++) {
          var slot = row * S.COLS + col;
          var idx = p * S.PER_PAGE + slot;
          var body = '';
          if (idx < list.length) {
            var attendee = list[idx] || {};
            var res = d.LY.layout(attendee, ov[attendee.id] || null, layoutOpts);
            for (var n = 0; n < res.lines.length; n++) {
              body += paragraph(res.lines[n], S);
            }
          }
          xml += cell(body || emptyParagraph(), S);
        }
        xml += '</w:tr>';
      }
      xml += '</w:tbl>';
      if (p < pageCount - 1) xml += pageBreak();
    }

    xml += sectionProps(S, set.preset);
    xml += '</w:body></w:document>';
    return xml;
  }

  /**
   * exportDocx(attendees, overrides, opts) -> Promise<Blob>
   * Promise-returning to match BadgePdf.exportPdf's contract, so the two buttons are
   * wired identically, even though building a .docx is synchronous.
   */
  function exportDocx(attendees, overrides, opts) {
    try {
      var d = requireDeps();
      var doc = buildDocumentXml(attendees, overrides, opts);
      var bytes = d.Z.write([
        { name: '[Content_Types].xml', text: CONTENT_TYPES },
        { name: '_rels/.rels', text: ROOT_RELS },
        { name: 'word/document.xml', text: doc },
        { name: 'word/_rels/document.xml.rels', text: DOC_RELS },
        { name: 'word/styles.xml', text: STYLES },
        { name: 'word/settings.xml', text: SETTINGS },
        { name: 'docProps/core.xml', text: CORE },
        { name: 'docProps/app.xml', text: APP }
      ]);
      var type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      return Promise.resolve(new Blob([bytes], { type: type }));
    } catch (err) {
      return Promise.reject(err);
    }
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
      /* finally, not straight-line code: a throwing click() must still release the
         anchor and the object URL. Same reasoning as js/pdf.js. */
      if (a.parentNode) document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0); // Safari needs the turn
    }
  }

  /**
   * mount() - adds a "Export Word (.docx)" button next to the PDF one. Idempotent.
   * Every dependency is guarded: a missing module logs a warning and leaves the rest
   * of the app usable rather than throwing out of a click handler.
   */
  function mount() {
    if (typeof document === 'undefined') return;

    var host = document.getElementById('data-controls');
    if (!host) {
      console.warn('BadgeDocx.mount: #data-controls not found; Word button not added.');
      return;
    }
    if (host.querySelector('[data-badge-docx-export]')) return; // already mounted

    /* Sit inside the PDF button's wrapper when it exists, so the two exports read as
       one pair of controls rather than two unrelated blocks. */
    var wrap = host.querySelector('.pdf-export') || host;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Export Word (.docx)';
    btn.setAttribute('data-badge-docx-export', '1');

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
        console.warn('BadgeDocx: window.BadgeStore is missing; nothing to export.');
        say('Attendee storage is unavailable.');
        return;
      }

      var attendees;
      var overrides;
      try {
        attendees = store.getAttendees() || [];
        overrides = typeof store.getOverrides === 'function' ? store.getOverrides() : {};
      } catch (err) {
        console.warn('BadgeDocx: reading attendees from BadgeStore failed.', err);
        say('Could not read the attendee list: ' +
            (err && err.message ? err.message : 'unknown error'));
        return;
      }

      if (!attendees.length) {
        say('Add at least one attendee before exporting.');
        return;
      }

      say('');
      btn.disabled = true;
      var restore = function () { btn.disabled = false; };

      exportDocx(attendees, overrides).then(
        function (blob) {
          restore();
          try {
            download(blob, DEFAULT_FILENAME);
          } catch (err) {
            console.warn('BadgeDocx: download failed.', err);
            say('Could not start the download.');
          }
        },
        function (err) {
          restore();
          console.warn('BadgeDocx: export failed.', err);
          say('Export failed: ' + (err && err.message ? err.message : 'unknown error'));
        }
      );
    });

    wrap.appendChild(btn);
    wrap.appendChild(note);
  }

  window.BadgeDocx = {
    exportDocx: exportDocx,
    buildDocumentXml: buildDocumentXml,
    mount: mount,
    FILENAME: DEFAULT_FILENAME,
    FONT: FONT
  };
})(typeof window !== 'undefined' ? window : globalThis);
