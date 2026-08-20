/*
 * test/pdf.test.js — geometry, font and invariant verification for js/pdf.js.
 *
 * Plain node, no test framework, no dependencies. Exits non-zero on any failure.
 *   node test/pdf.test.js
 *
 * PDFs go to a scratch directory OUTSIDE site/ (override with BADGE_PDF_OUT=/dir).
 *
 * THREE INDEPENDENT WITNESSES, in decreasing order of trust:
 *   1. RASTER — pdftoppm at 200 dpi, then count dark pixels. This is what actually
 *      hits paper. It is the only witness that sees .notdef boxes (pdftotext reports
 *      zero words for them, so bbox-based tests are blind to exactly the case that
 *      broke the cell invariant), so every hard invariant is checked this way.
 *   2. TEXT BBOX — pdftotext -bbox. Poppler reports advance boxes in a page
 *      TOP-left frame with y growing down, the same frame BADGE_SPEC.md uses, so the
 *      expected cell origins below are literally the spec's numbers.
 *   3. DRAW CALLS — recorded from pdf-lib. Cheapest, least trusted; used to prove
 *      the PDF agrees with what BadgeLayout returned, and to catch a wrong
 *      coordinate flip that happens to land on another cell.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var child = require('child_process');

var SITE = path.resolve(__dirname, '..');
var OUT = process.env.BADGE_PDF_OUT || path.join(os.tmpdir(), 'badge-pdf-test');
var DPI = 200;

// ---------------------------------------------------------------- reporting

var failures = 0;
var checks = 0;

function head(s) {
  console.log('\n=== ' + s + ' ===');
}
function ok(label, detail) {
  checks++;
  console.log('  PASS   ' + label + (detail ? '  [' + detail + ']' : ''));
}
function bad(label, detail) {
  checks++;
  failures++;
  console.log('  FAIL   ' + label + (detail ? '  [' + detail + ']' : ''));
}
/**
 * A check this item cannot satisfy on its own because a module it only READS has
 * not shipped the feature yet. Counts as a failure (these are hard invariants and
 * the suite must stay red until they hold) but is labelled so it is never mistaken
 * for a defect in js/pdf.js.
 */
function blocked(label, detail) {
  checks++;
  failures++;
  console.log('  BLOCK  ' + label + (detail ? '  [' + detail + ']' : ''));
}
function assert(cond, label, detail) {
  if (cond) ok(label, detail);
  else bad(label, detail);
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}
function f(n) {
  return Number(n).toFixed(3);
}

// ------------------------------------------------- load the browser globals

/*
 * Every shipped file is a classic script that assigns to `window`, so the app loads
 * in node with three shims: window, atob and Blob (the last two are already global
 * in node >= 18). new Function(...) is used instead of require() so the vendored UMD
 * wrappers see no module/exports/define and take their browser-global branch,
 * exactly as they do from a <script> tag.
 */
global.window = globalThis;

var SCRIPTS = [
  'vendor/pdf-lib.min.js',
  'vendor/pdf-lib-fontkit.min.js',
  'fonts/inter-metrics.js',
  'fonts/inter-fontdata.js',
  'js/spec.js',
  'js/layout.js',
  'js/pdf.js'
];

SCRIPTS.forEach(function (rel) {
  var abs = path.join(SITE, rel);
  if (!fs.existsSync(abs)) {
    console.error('MISSING REQUIRED FILE: ' + rel);
    process.exit(1);
  }
  new Function(fs.readFileSync(abs, 'utf8')).call(globalThis);
});

['PDFLib', 'fontkit', 'InterMetrics', 'InterFontData', 'BadgeSpec', 'BadgeLayout', 'BadgePdf'].forEach(
  function (g) {
    if (!global[g]) {
      console.error('GLOBAL NOT DEFINED AFTER LOAD: window.' + g);
      process.exit(1);
    }
  }
);

var S = global.BadgeSpec;
var M = global.InterMetrics;
var BadgePdf = global.BadgePdf;

var BLOCK_W = S.COLS * S.CELL_W; // 576
var BLOCK_H = S.ROWS * S.CELL_H; // 648
var LOGO_1IN = { enabled: true, wPt: 72, hPt: 72 };

/*
 * Sheet presets differ ONLY in the grid origin, so everything below derives the six
 * cell origins from BadgeSpec.cellOrigin() and separately asserts those origins
 * against the literals in BADGE_SPEC.md. The unprinted area is a consequence of the
 * origin, not a rule of its own:
 *   sampleTopLeft (0,0)   -> right 36 pt + bottom 144 pt blank
 *   avery         (18,72) -> 18 pt left/right + 72 pt top/bottom blank
 */
var PRESET_LITERALS = {
  sampleTopLeft: [[0, 0], [288, 0], [0, 216], [288, 216], [0, 432], [288, 432]],
  avery: [[18, 72], [306, 72], [18, 288], [306, 288], [18, 504], [306, 504]]
};

function originsFor(preset) {
  var out = [];
  for (var i = 0; i < S.PER_PAGE; i++) {
    var o = S.cellOrigin(i, preset);
    out.push([o.x, o.y]);
  }
  return out;
}

/** Top-left of the printable 576 x 648 block for a preset. */
function blockOrigin(preset) {
  var o = S.cellOrigin(0, preset);
  return { x: o.x, y: o.y };
}

// -------------------------------------------- instrument pdf-lib + the engine

var recordedPages = []; // [{ size:[w,h], draws:[{text,x,y,size,keys}] }]
var layoutCalls = []; // [{ attendee, override, opts, argc, result }]

(function instrument() {
  var Doc = global.PDFLib.PDFDocument;
  var Page = global.PDFLib.PDFPage;
  var addPage = Doc.prototype.addPage;
  var drawText = Page.prototype.drawText;

  Doc.prototype.addPage = function (arg) {
    var p = addPage.apply(this, arguments);
    p.__rec = { size: Array.isArray(arg) ? arg.slice() : null, draws: [] };
    recordedPages.push(p.__rec);
    return p;
  };
  Page.prototype.drawText = function (text, opts) {
    var o = opts || {};
    if (this.__rec) {
      this.__rec.draws.push({ text: text, x: o.x, y: o.y, size: o.size, keys: Object.keys(o) });
    }
    return drawText.apply(this, arguments);
  };

  // Spy on the fit engine so we can prove pdf.js forwards the third argument and
  // draws exactly the lines it was handed.
  var realLayout = global.BadgeLayout.layout;
  global.BadgeLayout.layout = function (attendee, override, opts) {
    var result = realLayout.apply(this, arguments);
    layoutCalls.push({
      attendee: attendee,
      override: override,
      opts: opts,
      argc: arguments.length,
      result: result
    });
    return result;
  };
  global.BadgeLayout.__real = realLayout;
})();

// -------------------------------------------------------------- pdf helpers

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(SITE, 'test', 'fixtures', name), 'utf8'));
}

function build(attendees, outName, opts) {
  recordedPages.length = 0;
  layoutCalls.length = 0;
  var args = arguments.length >= 3 ? [attendees, {}, opts] : [attendees, {}];
  return BadgePdf.exportPdf.apply(null, args).then(function (blob) {
    return blob.arrayBuffer().then(function (ab) {
      var file = path.join(OUT, outName);
      fs.writeFileSync(file, Buffer.from(ab));
      return {
        file: file,
        pages: recordedPages.slice(),
        layouts: layoutCalls.slice(),
        bytes: ab.byteLength
      };
    });
  });
}

/** Parse `pdftotext -bbox` into [{ width, height, words:[{x0,y0,x1,y1,text}] }]. */
function extract(file) {
  var xml = child.execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  var pages = [];
  var pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  var wordRe = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([\s\S]*?)<\/word>/g;
  var m;
  while ((m = pageRe.exec(xml)) !== null) {
    var words = [];
    var w;
    wordRe.lastIndex = 0;
    while ((w = wordRe.exec(m[3])) !== null) {
      words.push({
        x0: parseFloat(w[1]),
        y0: parseFloat(w[2]),
        x1: parseFloat(w[3]),
        y1: parseFloat(w[4]),
        text: w[5]
      });
    }
    pages.push({ width: parseFloat(m[1]), height: parseFloat(m[2]), words: words });
  }
  return pages;
}

/**
 * Rasterise one page with pdftoppm and return an ink query object. Coordinates in
 * and out are POINTS in the page top-left frame, matching BADGE_SPEC.md.
 * A pixel counts as ink at < 250/255, which includes antialiased glyph edges
 * (1 px = 0.36 pt at 200 dpi, so edge fuzz cannot fake a 28.8 pt violation).
 */
function raster(file, pageNo) {
  var prefix = path.join(OUT, 'raster-' + process.pid + '-' + Math.random().toString(36).slice(2));
  child.execFileSync('pdftoppm', [
    '-r', String(DPI), '-gray', '-singlefile',
    '-f', String(pageNo), '-l', String(pageNo),
    file, prefix
  ]);
  var pgm = prefix + '.pgm';
  var buf = fs.readFileSync(pgm);
  fs.unlinkSync(pgm);

  // PGM "P5" header: magic, width, height, maxval — whitespace separated, # comments.
  var i = 0;
  var tokens = [];
  var cur = '';
  while (tokens.length < 4) {
    var ch = String.fromCharCode(buf[i++]);
    if (ch === '#') {
      while (buf[i] !== 10) i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  var w = parseInt(tokens[1], 10);
  var h = parseInt(tokens[2], 10);
  var base = i;
  var k = 72 / DPI; // points per pixel

  function pxAt(x, y) {
    return buf[base + y * w + x];
  }
  function scan(x0pt, y0pt, x1pt, y1pt) {
    var px0 = Math.max(0, Math.floor(x0pt / k));
    var py0 = Math.max(0, Math.floor(y0pt / k));
    var px1 = Math.min(w - 1, Math.ceil(x1pt / k) - 1);
    var py1 = Math.min(h - 1, Math.ceil(y1pt / k) - 1);
    var count = 0;
    var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (var y = py0; y <= py1; y++) {
      for (var x = px0; x <= px1; x++) {
        if (pxAt(x, y) < 250) {
          count++;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }
    return count
      ? { count: count, x0: bx0 * k, y0: by0 * k, x1: (bx1 + 1) * k, y1: (by1 + 1) * k }
      : { count: 0 };
  }

  return {
    widthPx: w,
    heightPx: h,
    ptPerPx: k,
    scan: scan,
    all: function () { return scan(0, 0, w * k, h * k); }
  };
}

/** Inflate every stream in a PDF that decompresses to text; used for dict scans. */
function inflatedTextStreams(file) {
  var s = fs.readFileSync(file).toString('latin1');
  var out = [];
  var re = /stream\r?\n/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    var start = m.index + m[0].length;
    var end = s.indexOf('endstream', start);
    if (end < 0) break;
    var raw = Buffer.from(s.slice(start, end), 'latin1');
    var dec = null;
    try {
      dec = zlib.inflateSync(raw);
    } catch (e) {
      dec = null;
    }
    if (dec) out.push(dec.toString('latin1'));
  }
  out.push(s); // plus the uncompressed skeleton, in case nothing is filtered
  return out;
}

/** Every /Subtype /CIDFontType2 dictionary in the file, brace-matched, as strings. */
function cidFontDicts(file) {
  var dicts = [];
  inflatedTextStreams(file).forEach(function (t) {
    var i = -1;
    while ((i = t.indexOf('/Subtype /CIDFontType2', i + 1)) !== -1) {
      var a = t.lastIndexOf('<<', i);
      if (a < 0) continue;
      var depth = 0;
      var b = t.length;
      for (var p = a; p < t.length - 1; p++) {
        if (t[p] === '<' && t[p + 1] === '<') { depth++; p++; }
        else if (t[p] === '>' && t[p + 1] === '>') {
          depth--; p++;
          if (depth === 0) { b = p + 1; break; }
        }
      }
      dicts.push(t.slice(a, b).replace(/\s+/g, ' '));
    }
  });
  return dicts;
}

/** Decoded page content streams, via pdf-lib itself (no hand-rolled PDF parsing). */
function contentStreams(file) {
  var L = global.PDFLib;
  return L.PDFDocument.load(fs.readFileSync(file)).then(function (doc) {
    var out = [];
    doc.getPages().forEach(function (page) {
      var contents = page.node.Contents();
      var refs = contents && typeof contents.asArray === 'function' ? contents.asArray() : [contents];
      refs.forEach(function (ref) {
        var st = doc.context.lookup(ref);
        if (!st) return;
        var bytes = L.decodePDFRawStream(st).decode();
        out.push(Buffer.from(bytes).toString('latin1'));
      });
    });
    return out;
  });
}

/*
 * Path-construction / painting / XObject operators. If any of these appear we drew
 * something that is not text — a rectangle for the logo reserve, a crop mark, a
 * border. The spec says the PDF is text-only, so the whole set is forbidden.
 */
var PATH_OPS = {
  m: 1, l: 1, c: 1, v: 1, y: 1, h: 1, re: 1,
  S: 1, s: 1, f: 1, F: 1, 'f*': 1, B: 1, 'B*': 1, b: 1, 'b*': 1, n: 1,
  W: 1, 'W*': 1, sh: 1, Do: 1, BI: 1
};

/** Operator tokens in a content stream, with strings and comments removed. */
function operatorsIn(stream) {
  var stripped = stream
    .replace(/<[0-9A-Fa-f\s]*>/g, ' ') // hex strings (all our text is Identity-H hex)
    .replace(/\((?:\\.|[^\\)])*\)/g, ' ') // literal strings
    .replace(/%[^\n\r]*/g, ' '); // comments
  return stripped.split(/\s+/).filter(Boolean);
}

// =========================================================================
// engine capability probe
// =========================================================================

/*
 * js/pdf.js is downstream of js/layout.js for two Addendum 2 features. Probe them
 * so a missing upstream feature reports as BLOCK with a pointer, instead of looking
 * like a geometry bug in this file.
 */
function engineCapabilities() {
  head('upstream engine capability probe (js/layout.js)');
  var real = global.BadgeLayout.__real;
  var a = fixture('six.json')[0];

  // 2B: optical centering. Compare the ink box the engine implies against 108.
  var r = real(a, null);
  var lines = r.lines.filter(function (l) { return l.text; });
  var first = lines[0];
  var last = lines[lines.length - 1];
  var inkTop = first.baselineY - M.capHeightPt(first.sizePt);
  var inkBottom = last.baselineY + M.descenderDepthPt(last.sizePt);
  var opticalCenter = (inkTop + inkBottom) / 2;
  var boxCenter = (r.lines[0].lineTop + r.lines[0].lineTop + r.blockHeight) / 2;
  var optical = near(opticalCenter, S.CELL_H / 2, 2);
  console.log(
    '  optical ink center ' + f(opticalCenter) + ' pt vs cell center 108.000 ' +
      '(layout-box center ' + f(boxCenter) + ')'
  );
  console.log('  Addendum 2B optical centering: ' + (optical ? 'LIVE' : 'NOT IMPLEMENTED YET'));

  /*
   * 2C: does layout() honour opts.logo? Probed with align:'center', because under
   * left alignment the reserve narrows the available SPAN without moving the left
   * edge — an x-based probe would read as "not implemented" when it is fine.
   * With centering, a line inside the reserved y-band must shift left.
   */
  var off = real(a, null, { logo: { enabled: false, wPt: 0, hPt: 0 }, align: 'center' });
  var on = real(a, null, { logo: LOGO_1IN, align: 'center' });
  var moved = off.lines.some(function (ln, i) {
    return on.lines[i] && Math.abs(on.lines[i].x - ln.x) > 0.01;
  });
  console.log('  Addendum 2C logo reserve in layout(): ' + (moved ? 'LIVE' : 'NOT IMPLEMENTED YET'));

  /*
   * align: does layout() honour opts.align? Under 'left' every line must start at
   * exactly INSET; under 'center' the lines sit at different x. Probe by asking for
   * 'left' and checking that every line shares one left edge — and that it is INSET.
   */
  var left = real(a, null, { logo: { enabled: false }, align: 'left' });
  var leftLines = left.lines.filter(function (l) { return l.text; });
  // 'left' = one shared edge, block centered in the span (NOT flush to the inset).
  var wantLeft = expectedLeftEdge(left, 0).left;
  var flush = leftLines.length > 0 &&
    leftLines.every(function (l) { return Math.abs(l.x - wantLeft) < 0.01; });
  var center = real(a, null, { logo: { enabled: false }, align: 'center' });
  var centerLines = center.lines.filter(function (l) { return l.text; });
  var centered = centerLines.every(function (l) {
    return Math.abs(l.x + l.lineWidth / 2 - S.CELL_W / 2) < 0.01;
  });
  console.log('  align:left  -> line left edges ' +
    JSON.stringify(leftLines.map(function (l) { return +l.x.toFixed(3); })) +
    ' (want all ' + f(wantLeft) + ': widest line ' +
    f(expectedLeftEdge(left, 0).blockWidth) + ' centered in the ' +
    f(expectedLeftEdge(left, 0).spanHi - S.INSET) + ' pt span)');
  console.log('  align:center -> line centers ' +
    JSON.stringify(centerLines.map(function (l) { return +(l.x + l.lineWidth / 2).toFixed(3); })) +
    ' (want all ' + S.CELL_W / 2 + ')');
  console.log('  align in layout(): ' + (flush && centered ? 'LIVE' : 'NOT IMPLEMENTED YET'));

  return { optical: optical, logo: moved, align: flush && centered };
}

// =========================================================================
// shared checks
// =========================================================================

function checkPageBox(label, pages, rec) {
  head(label + ' — 1. page box');
  pages.forEach(function (p, i) {
    assert(
      p.width === S.PAGE_W && p.height === S.PAGE_H,
      'page ' + (i + 1) + ' MediaBox',
      f(p.width) + ' x ' + f(p.height) + ' pt (want 612 x 792)'
    );
  });
  rec.forEach(function (r, i) {
    assert(
      r.size && r.size[0] === 612 && r.size[1] === 792,
      'page ' + (i + 1) + ' addPage() argument',
      r.size ? r.size.join(' x ') : 'default size used'
    );
  });
}

/**
 * 5. Nothing prints outside the 576 x 648 block. Stated as four bands around the
 * block so it reads correctly for both presets (36/144 asymmetric for
 * sampleTopLeft, 18/18/72/72 symmetric for avery).
 */
function checkUnprintedArea(label, res, pages, preset) {
  var o = blockOrigin(preset);
  var bands = [
    ['left ' + f(o.x) + ' pt', 0, 0, o.x, S.PAGE_H],
    ['right ' + f(S.PAGE_W - o.x - BLOCK_W) + ' pt', o.x + BLOCK_W, 0, S.PAGE_W, S.PAGE_H],
    ['top ' + f(o.y) + ' pt', 0, 0, S.PAGE_W, o.y],
    ['bottom ' + f(S.PAGE_H - o.y - BLOCK_H) + ' pt', 0, o.y + BLOCK_H, S.PAGE_W, S.PAGE_H]
  ];

  head(label + ' — 5. unprinted area (' + preset + ': ' +
    bands.map(function (b) { return b[0]; }).join(', ') + ')');

  var strays = 0;
  var box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  pages.forEach(function (p) {
    p.words.forEach(function (w) {
      box.x0 = Math.min(box.x0, w.x0);
      box.y0 = Math.min(box.y0, w.y0);
      box.x1 = Math.max(box.x1, w.x1);
      box.y1 = Math.max(box.y1, w.y1);
      if (w.x0 < o.x - 0.001 || w.x1 > o.x + BLOCK_W + 0.001 ||
          w.y0 < o.y - 0.001 || w.y1 > o.y + BLOCK_H + 0.001) strays++;
    });
  });
  assert(
    strays === 0,
    'no text box outside the printable block',
    'text spans x ' + f(box.x0) + '..' + f(box.x1) + ', y ' + f(box.y0) + '..' + f(box.y1) +
      ' (block x ' + o.x + '..' + (o.x + BLOCK_W) + ', y ' + o.y + '..' + (o.y + BLOCK_H) + ')'
  );

  // Raster witness: zero ink in each surrounding band, on every page.
  var totals = bands.map(function () { return 0; });
  for (var pg = 1; pg <= pages.length; pg++) {
    var R = raster(res.file, pg);
    bands.forEach(function (b, i) {
      if (b[3] - b[1] <= 0 || b[4] - b[2] <= 0) return;
      totals[i] += R.scan(b[1], b[2], b[3], b[4]).count;
    });
  }
  bands.forEach(function (b, i) {
    assert(totals[i] === 0, 'RASTER: zero ink in the ' + b[0] + ' band', totals[i] + ' px');
  });
}

function checkNoRewrapOptions(label, rec) {
  head(label + ' — drawText options (no re-wrap)');
  var offenders = [];
  var n = 0;
  rec.forEach(function (r, pi) {
    r.draws.forEach(function (d) {
      n++;
      d.keys.forEach(function (k) {
        if (k === 'maxWidth' || k === 'lineHeight') offenders.push('page' + pi + ':' + k);
      });
    });
  });
  assert(
    offenders.length === 0,
    'no maxWidth / lineHeight passed to drawText (pdf-lib cannot re-wrap)',
    offenders.length ? offenders.join(',') : 'checked ' + n + ' draw calls'
  );
}


/*
 * Expected cell-relative left edge under align:'left', reconstructed from the
 * ENGINE'S OWN returned line widths rather than hardcoded:
 *
 *   blockWidth = widest emitted line with text
 *   spanHi     = the tightest right edge any inked line is subject to
 *                (CELL_W - INSET normally; CELL_W - logoWpt for a line level with
 *                 the reserve — `narrowed` on the returned line says which)
 *   left       = INSET + max(0, (spanHi - INSET - blockWidth) / 2)
 *
 * "Centered block, left-aligned text": all lines share this one edge, and it
 * degenerates to INSET only when the widest line fills the span.
 */
function expectedLeftEdge(layoutResult, logoWpt) {
  var inked = layoutResult.lines.filter(function (l) { return l.text; });
  if (!inked.length) return { left: S.INSET, blockWidth: 0, spanHi: S.CELL_W - S.INSET };
  var blockWidth = 0;
  var spanHi = S.CELL_W - S.INSET;
  inked.forEach(function (l) {
    if (l.lineWidth > blockWidth) blockWidth = l.lineWidth;
    var hi = l.narrowed ? S.CELL_W - logoWpt : S.CELL_W - S.INSET;
    if (hi < spanHi) spanHi = hi;
  });
  return {
    left: S.INSET + Math.max(0, (spanHi - S.INSET - blockWidth) / 2),
    blockWidth: blockWidth,
    spanHi: spanHi
  };
}

/** Group one page's words into badges (by cell) then into lines (by shared yMin). */
function cellIndexOf(word, preset) {
  var o = blockOrigin(preset);
  var col = Math.floor(((word.x0 + word.x1) / 2 - o.x) / S.CELL_W);
  var row = Math.floor(((word.y0 + word.y1) / 2 - o.y) / S.CELL_H);
  if (col < 0 || col >= S.COLS || row < 0 || row >= S.ROWS) return -1;
  return row * S.COLS + col;
}

function badgesOf(page, preset) {
  var byCell = {};
  page.words.forEach(function (w) {
    var i = cellIndexOf(w, preset);
    (byCell[i] = byCell[i] || []).push(w);
  });
  return Object.keys(byCell)
    .map(Number)
    .sort(function (a, b) { return a - b; })
    .map(function (i) {
      var words = byCell[i];
      var lines = [];
      words
        .slice()
        .sort(function (a, b) { return a.y0 - b.y0 || a.x0 - b.x0; })
        .forEach(function (w) {
          var last = lines[lines.length - 1];
          if (last && Math.abs(last.y0 - w.y0) < 0.5) {
            last.x0 = Math.min(last.x0, w.x0);
            last.x1 = Math.max(last.x1, w.x1);
            last.y1 = Math.max(last.y1, w.y1);
            last.text += ' ' + w.text;
          } else {
            lines.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, text: w.text });
          }
        });
      return { cellIndex: i, words: words, lines: lines };
    });
}

/**
 * Recover the drawn size and baseline of a measured line. Poppler's word box is the
 * font's ascent..descent box, so height = (ascent+descent)/upem * size, which
 * inverts exactly. Everything here comes out of the PDF, not out of our code.
 */
function lineMetrics(line) {
  var factor = (M.ascent + M.descent) / M.unitsPerEm;
  var size = (line.y1 - line.y0) / factor;
  return { size: size, baseline: line.y0 + M.ascentPt(size) };
}

// =========================================================================
// per-fixture checks
// =========================================================================

function checkSix(res, caps, preset, align, logoWpt) {
  var pages = extract(res.file);
  var label = 'six.json/' + preset + '/' + align;
  logoWpt = logoWpt || 0;
  var EXPECTED_ORIGINS = originsFor(preset);

  checkPageBox(label, pages, res.pages);
  checkNoRewrapOptions(label, res.pages);
  assert(pages.length === 1, label + ' page count', pages.length + ' page(s)');

  head(label + ' — cellOrigin() matches the spec literals');
  var literals = PRESET_LITERALS[preset];
  assert(
    JSON.stringify(EXPECTED_ORIGINS) === JSON.stringify(literals),
    'BadgeSpec.cellOrigin() origins for ' + preset,
    EXPECTED_ORIGINS.map(function (o) { return '(' + o[0] + ',' + o[1] + ')'; }).join(' ')
  );
  var bo = blockOrigin(preset);
  assert(
    bo.x + BLOCK_W + bo.x === S.PAGE_W || preset === 'sampleTopLeft',
    'avery block is centered horizontally: ' + bo.x + ' + ' + BLOCK_W + ' + ' + bo.x + ' = ' + S.PAGE_W,
    String(bo.x + BLOCK_W + bo.x)
  );
  assert(
    bo.y + BLOCK_H + bo.y === S.PAGE_H || preset === 'sampleTopLeft',
    'avery block is centered vertically: ' + bo.y + ' + ' + BLOCK_H + ' + ' + bo.y + ' = ' + S.PAGE_H,
    String(bo.y + BLOCK_H + bo.y)
  );
  assert(
    bo.x + BLOCK_W <= S.PAGE_W && bo.y + BLOCK_H <= S.PAGE_H,
    'the whole 576 x 648 block fits on the 612 x 792 page',
    'block ends at x ' + (bo.x + BLOCK_W) + ', y ' + (bo.y + BLOCK_H)
  );

  var allBadges = badgesOf(pages[0], preset);

  head(label + ' — 2. cell origins + containment');
  assert(allBadges.length === S.PER_PAGE, 'badge groups found on page 1',
    allBadges.length + ' of ' + S.PER_PAGE);

  var offGrid = allBadges.filter(function (b) { return !EXPECTED_ORIGINS[b.cellIndex]; });
  assert(
    offGrid.length === 0,
    'no text outside the 2x3 grid of cells',
    offGrid.length
      ? offGrid.map(function (b) {
          return JSON.stringify(b.words[0].text) + ' @ y=' + f(b.words[0].y0);
        }).join('; ')
      : 'clean'
  );
  var badges = allBadges.filter(function (b) { return !!EXPECTED_ORIGINS[b.cellIndex]; });

  var bx = blockOrigin(preset);
  badges.forEach(function (b) {
    var minX = Math.min.apply(null, b.words.map(function (w) { return w.x0; }));
    var minY = Math.min.apply(null, b.words.map(function (w) { return w.y0; }));
    var maxX = Math.max.apply(null, b.words.map(function (w) { return w.x1; }));
    var maxY = Math.max.apply(null, b.words.map(function (w) { return w.y1; }));
    // Origin inferred from the measured ink, not read back out of the code.
    var ox = bx.x + Math.floor((minX - bx.x) / S.CELL_W) * S.CELL_W;
    var oy = bx.y + Math.floor((minY - bx.y) / S.CELL_H) * S.CELL_H;
    var exp = EXPECTED_ORIGINS[b.cellIndex];

    assert(
      near(ox, exp[0], 1) && near(oy, exp[1], 1),
      'badge ' + (b.cellIndex + 1) + ' cell origin (from top-left)',
      'measured (' + ox + ',' + oy + ') want (' + exp[0] + ',' + exp[1] + ')'
    );
    assert(
      minX >= exp[0] - 0.001 && maxX <= exp[0] + S.CELL_W + 0.001 &&
        minY >= exp[1] - 0.001 && maxY <= exp[1] + S.CELL_H + 0.001,
      'badge ' + (b.cellIndex + 1) + ' text bbox inside its own 288x216 cell',
      'x ' + f(minX) + '..' + f(maxX) + '  y ' + f(minY) + '..' + f(maxY)
    );
  });

  head(label + ' — 2b. recorded draw calls (independent witness)');
  var seen = {};
  res.pages[0].draws.forEach(function (d) {
    // undo pdfY = 792 - (cellTop + baselineY), then bucket into the preset's grid
    var col = Math.floor((d.x - bx.x) / S.CELL_W);
    var row = Math.floor((S.PAGE_H - d.y - bx.y) / S.CELL_H);
    seen[row * S.COLS + col] = [bx.x + col * S.CELL_W, bx.y + row * S.CELL_H];
  });
  var keys = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  assert(
    keys.length === S.PER_PAGE && keys.every(function (k, i) {
      return k === i && seen[k][0] === EXPECTED_ORIGINS[i][0] && seen[k][1] === EXPECTED_ORIGINS[i][1];
    }),
    'drawn cell origins, top-left frame',
    keys.map(function (k) { return '(' + seen[k][0] + ',' + seen[k][1] + ')'; }).join(' ')
  );

  /*
   * 3. Horizontal placement. Two different promises, so two different assertions —
   * asserting "centered" under align:'left' would be false BY DESIGN.
   *   center : every line's center sits on the cell center, +/- 1 pt.
   *   left   : every line STARTS at exactly cellOriginX + 14.4 and ends at or
   *            before cellOriginX + 273.6 (the text box's right edge).
   * Measured from the real PDF via pdftotext -bbox, which reports advance boxes, so
   * the left edge is the drawn pen position and compares exactly.
   */
  if (align === 'center') {
    head(label + ' — 3. horizontal CENTERING (tol 1 pt)');
    badges.forEach(function (b) {
      var want = EXPECTED_ORIGINS[b.cellIndex][0] + S.CELL_W / 2;
      b.lines.forEach(function (ln, i) {
        var c = (ln.x0 + ln.x1) / 2;
        assert(
          near(c, want, 1),
          'badge ' + (b.cellIndex + 1) + ' line ' + (i + 1) + ' center',
          'measured ' + f(c) + ' want ' + f(want) + ' delta ' + f(c - want)
        );
      });
    });
  } else {
    head(label + " — 3. horizontal LEFT ALIGNMENT (one shared edge, block centered)");
    var worstLeft = 0;
    var edges = [];
    badges.forEach(function (b) {
      var ox = EXPECTED_ORIGINS[b.cellIndex][0];
      var minLeft = ox + S.INSET;
      var maxRight = ox + S.CELL_W - S.INSET;
      // The engine's own numbers for THIS attendee (badges are in slot order).
      var exp = expectedLeftEdge(res.layouts[b.cellIndex].result, logoWpt);
      var wantLeft = ox + exp.left;

      // a) one shared left edge for the whole badge
      var distinct = Array.from(new Set(b.lines.map(function (ln) {
        return ln.x0.toFixed(3);
      })));
      assert(
        distinct.length === 1,
        'badge ' + (b.cellIndex + 1) + ': all ' + b.lines.length + ' lines share one left edge',
        distinct.length + ' distinct edge(s): ' + distinct.join(', ')
      );

      // b) that edge is the block-centered position derived from the engine's widths
      var measured = b.lines[0].x0;
      worstLeft = Math.max(worstLeft, Math.abs(measured - wantLeft));
      edges.push(+(measured - ox).toFixed(3));
      var detail =
        'measured ' + f(measured - ox) + ' cell-relative, want ' + f(exp.left) +
        ' = 14.4 + (' + f(exp.spanHi - S.INSET) + ' - ' + f(exp.blockWidth) + ')/2' +
        '  [delta ' + f(measured - wantLeft) + ']';
      if (caps.align) {
        assert(near(measured, wantLeft, 0.01),
          'badge ' + (b.cellIndex + 1) + ': shared edge = span.lo + (spanWidth - blockWidth)/2', detail);
      } else {
        blocked('badge ' + (b.cellIndex + 1) +
          ': shared edge — js/layout.js does not honour opts.align yet', detail);
      }

      // c) the inset and the text box still bound it
      b.lines.forEach(function (ln, i) {
        assert(
          ln.x0 >= minLeft - 0.001,
          'badge ' + (b.cellIndex + 1) + ' line ' + (i + 1) + ' starts at or after the 14.4 inset',
          'measured left ' + f(ln.x0) + ' (inset edge ' + minLeft + ')'
        );
        assert(
          ln.x1 <= maxRight + 0.001,
          'badge ' + (b.cellIndex + 1) + ' line ' + (i + 1) + ' ends at or before ' + maxRight,
          'measured right ' + f(ln.x1)
        );
      });
    });
    console.log('  distinct cell-relative left edges: ' +
      JSON.stringify(Array.from(new Set(edges)).sort(function (x, y) { return x - y; })));
    console.log('  worst deviation from the engine-derived block-left: ' +
      worstLeft.toExponential(2) + ' pt');
  }

  /*
   * 4. Vertical centering is OPTICAL as of Addendum 2B: the visible ink box is what
   * gets centered, not the layout box. Ink box is reconstructed from the measured
   * word boxes: cap height above the first baseline, real lowercase descender depth
   * below the last, content-independently (the engine reserves both whether or not
   * the glyphs use them, so all six badges sit at the same height).
   */
  head(label + ' — 4. OPTICAL vertical centering (tol 2 pt)');
  badges.forEach(function (b) {
    var cellY = EXPECTED_ORIGINS[b.cellIndex][1];
    var want = cellY + S.CELL_H / 2;
    var firstM = lineMetrics(b.lines[0]);
    var lastM = lineMetrics(b.lines[b.lines.length - 1]);
    var inkTop = firstM.baseline - M.capHeightPt(firstM.size);
    var inkBottom = lastM.baseline + M.descenderDepthPt(lastM.size);
    var optical = (inkTop + inkBottom) / 2;
    var legacy = (b.lines[0].y0 + b.lines[b.lines.length - 1].y1) / 2;
    var detail =
      'optical center ' + f(optical) + ' want ' + f(want) + ' delta ' + f(optical - want) +
      ' (ink ' + f(inkTop) + '..' + f(inkBottom) + '; legacy metric-box center ' + f(legacy) + ')';
    if (caps.optical) assert(near(optical, want, 2), 'badge ' + (b.cellIndex + 1) + ' optical block center', detail);
    else blocked('badge ' + (b.cellIndex + 1) + ' optical block center — js/layout.js has not shipped Addendum 2B', detail);
  });

  checkUnprintedArea(label, res, pages, preset);

  head(label + ' — RASTER: all ink inside the 576 x 648 block');
  var R = raster(res.file, 1);
  var all = R.all();
  assert(
    all.count > 0 &&
      all.x0 >= bx.x - 0.001 && all.x1 <= bx.x + BLOCK_W + 0.001 &&
      all.y0 >= bx.y - 0.001 && all.y1 <= bx.y + BLOCK_H + 0.001,
    'page ink bounds',
    'x ' + f(all.x0) + '..' + f(all.x1) + '  y ' + f(all.y0) + '..' + f(all.y1) +
      '  (' + all.count + ' ink px)'
  );

  head(label + ' — RASTER: per-cell containment');
  var cellInk = [];
  EXPECTED_ORIGINS.forEach(function (o, i) {
    var cell = R.scan(o[0], o[1], o[0] + S.CELL_W, o[1] + S.CELL_H);
    cellInk.push(cell);
    var inside =
      cell.count > 0 &&
      cell.x0 >= o[0] - 0.001 && cell.x1 <= o[0] + S.CELL_W + 0.001 &&
      cell.y0 >= o[1] - 0.001 && cell.y1 <= o[1] + S.CELL_H + 0.001;
    assert(inside, 'cell ' + (i + 1) + ' ink inside its own cell',
      'x ' + f(cell.x0) + '..' + f(cell.x1) + '  y ' + f(cell.y0) + '..' + f(cell.y1));
  });
  console.log('  cell 0 ink: x ' + f(cellInk[0].x0) + '..' + f(cellInk[0].x1) +
    '  y ' + f(cellInk[0].y0) + '..' + f(cellInk[0].y1));
  console.log('  cell 5 ink: x ' + f(cellInk[5].x0) + '..' + f(cellInk[5].x1) +
    '  y ' + f(cellInk[5].y0) + '..' + f(cellInk[5].y1));

  return { badges: badges, cellInk: cellInk };
}

function checkFourteen(res, preset) {
  var pages = extract(res.file);
  var label = 'fourteen.json/' + preset;

  checkPageBox(label, pages, res.pages);
  checkNoRewrapOptions(label, res.pages);

  head(label + ' — 6. pagination');
  assert(pages.length === 3, 'page count', pages.length + ' page(s), want 3');
  var counts = pages.map(function (p) { return badgesOf(p, preset).length; });
  assert(counts.join('/') === '6/6/2', 'badges per page', counts.join(' / ') + ' (want 6 / 6 / 2)');

  var strays = 0;
  pages.forEach(function (p) {
    badgesOf(p, preset).forEach(function (b) {
      var o = S.cellOrigin(b.cellIndex, preset);
      b.words.forEach(function (w) {
        if (w.x0 < o.x - 0.001 || w.x1 > o.x + S.CELL_W + 0.001 ||
            w.y0 < o.y - 0.001 || w.y1 > o.y + S.CELL_H + 0.001) strays++;
      });
    });
  });
  assert(strays === 0, 'every word on all 3 pages inside its own cell', strays + ' stray word(s)');

  checkUnprintedArea(label, res, pages, preset);
}

function checkStress(res, preset) {
  var pages = extract(res.file);
  var label = 'stress.json/' + preset;
  var stress = fixture('stress.json');

  checkPageBox(label, pages, res.pages);
  checkNoRewrapOptions(label, res.pages);

  head(label + ' — 7. worst-case badge stays in cell 1');
  var badges = badgesOf(pages[0], preset);
  assert(badges.length === 1 && badges[0].cellIndex === 0, 'single badge in cell index 0', 'groups: ' + badges.length);

  var b = badges[0];
  var minX = Math.min.apply(null, b.words.map(function (w) { return w.x0; }));
  var maxX = Math.max.apply(null, b.words.map(function (w) { return w.x1; }));
  var minY = Math.min.apply(null, b.words.map(function (w) { return w.y0; }));
  var maxY = Math.max.apply(null, b.words.map(function (w) { return w.y1; }));
  var c0 = S.cellOrigin(0, preset);
  assert(
    minX >= c0.x - 0.001 && maxX <= c0.x + S.CELL_W + 0.001 &&
      minY >= c0.y - 0.001 && maxY <= c0.y + S.CELL_H + 0.001,
    'stress text bbox inside cell 1 (' + c0.x + '..' + (c0.x + S.CELL_W) + ' x ' +
      c0.y + '..' + (c0.y + S.CELL_H) + ')',
    'x ' + f(minX) + '..' + f(maxX) + '  y ' + f(minY) + '..' + f(maxY)
  );
  assert(
    minX >= c0.x + S.INSET - 0.5 && maxX <= c0.x + S.CELL_W - S.INSET + 0.5,
    'stress bbox inside the 14.4 pt inset text box horizontally',
    'x ' + f(minX) + '..' + f(maxX) + ' (box ' + (c0.x + S.INSET) + '..' + (c0.x + S.CELL_W - S.INSET) + ')'
  );

  var R = raster(res.file, 1);
  var ink = R.all();
  assert(
    ink.count > 0 && ink.x0 >= c0.x - 0.001 && ink.x1 <= c0.x + S.CELL_W + 0.001 &&
      ink.y0 >= c0.y - 0.001 && ink.y1 <= c0.y + S.CELL_H + 0.001,
    'RASTER: stress ink inside its cell',
    'x ' + f(ink.x0) + '..' + f(ink.x1) + '  y ' + f(ink.y0) + '..' + f(ink.y1)
  );

  head(label + ' — 7. left edge on a worst-case (span-filling) badge');
  var exp = expectedLeftEdge(res.layouts[0].result, 0);
  var measuredLeft = Math.min.apply(null, badges[0].lines.map(function (ln) { return ln.x0; }));
  console.log('  widest line ' + f(exp.blockWidth) + ' pt in a ' +
    f(exp.spanHi - S.INSET) + ' pt span -> block-left ' + f(exp.left) +
    (Math.abs(exp.left - S.INSET) < 0.01 ? ' (degenerates to the inset)' : ''));
  assert(
    near(measuredLeft - c0.x, exp.left, 0.01),
    'stress shared left edge matches the engine-derived block-left',
    'measured ' + f(measuredLeft - c0.x) + ' cell-relative, want ' + f(exp.left)
  );
  assert(measuredLeft >= c0.x + S.INSET - 0.001,
    'stress left edge never crosses the 14.4 pt inset', f(measuredLeft - c0.x));

  head(label + ' — 7. applied sizes within ceilings and floors');
  var lay = res.layouts[0].result;
  var a = lay.appliedSizes;
  console.log('  applied: first=' + a.first + '  last=' + a.last + '  company=' + a.company + '  title=' + a.title);
  console.log('  ceilings: 36 / 26 / 21 / 19   floors: 22 / 16 / 13 / 12');
  ['first', 'last', 'company', 'title'].forEach(function (k) {
    assert(a[k] <= S.SIZES[k] + 1e-9, k + ' <= ceiling ' + S.SIZES[k], a[k] + ' pt');
    assert(a[k] >= S.FLOORS[k] - 1e-9, k + ' >= floor ' + S.FLOORS[k], a[k] + ' pt');
  });

  var drawn = res.pages[0].draws.map(function (d) { return d.size; });
  assert(Math.max.apply(null, drawn) <= 36 + 1e-9, 'largest size sent to drawText <= 36', Math.max.apply(null, drawn) + ' pt');
  assert(Math.min.apply(null, drawn) >= 12 - 1e-9, 'smallest size sent to drawText >= 12', Math.min.apply(null, drawn) + ' pt');

  checkUnprintedArea(label, res, pages, preset);
  void stress;
}

// =========================================================================
// fonts, content streams, /DW
// =========================================================================

function checkFonts(file) {
  head('8. embedded font table (pdffonts)');
  var out = child.execFileSync('pdffonts', [file], { encoding: 'utf8' });
  out.trimEnd().split('\n').forEach(function (l) { console.log('  | ' + l); });

  var names = out.split('\n').slice(2)
    .map(function (l) { return l.trim().split(/\s+/)[0]; })
    .filter(Boolean);
  console.log('  font names found: ' + JSON.stringify(names));

  function has(re) { return names.some(function (n) { return re.test(n); }); }
  assert(has(/Inter-Regular/i), 'Inter Regular embedded', names.join(', '));
  assert(has(/Inter-Bold/i), 'Inter Bold embedded', names.join(', '));
  assert(has(/Inter-Italic/i), 'Inter Italic embedded', names.join(', '));
  assert(names.length === 3, 'exactly 3 faces in the font table', String(names.length));
  assert(!has(/Helvetica/i), 'no Helvetica anywhere in the font table');
  assert(!has(/Arial/i), 'no Arial anywhere in the font table');
}

/*
 * D1 regression. pdf-lib omits glyph 0 from the subset, so without an explicit /DW
 * every unmapped character advances at the PDF default 1000/1000 em while the engine
 * measured Inter's real 1344/2048 = 656.25/1000 em — a 1.5238x expansion that walked
 * text out of the cell. js/pdf.js writes /DW 656 on each CID font.
 */
function checkDefaultWidths(file, tag) {
  head('/DW on every CID font — ' + tag);
  var dicts = cidFontDicts(file);
  assert(dicts.length === 3, 'three CIDFontType2 dictionaries found', String(dicts.length));
  var expected = Math.round((M.widthOf('￿', 1000, 400, 'normal')));
  console.log('  Inter .notdef advance: 1344/2048 em = ' + f(1344 / 2048 * 1000) + '/1000 em -> /DW 656 (rounded down; 0.25/1000 em = 0.009 pt at 36 pt, errs narrow)');
  console.log('  InterMetrics.widthOf(unmapped char, 1000 pt) = ' + expected + ' /1000 em');
  dicts.forEach(function (d) {
    var bf = (/\/BaseFont \/(\S+)/.exec(d) || [, '?'])[1];
    var dw = (/\/DW (\d+(?:\.\d+)?)/.exec(d) || [, null])[1];
    assert(dw !== null && Math.abs(Number(dw) - 656) <= 1, bf + ' has /DW', '/DW ' + dw);
    assert(
      Math.abs(Number(dw) - expected) <= 1,
      bf + ' /DW matches the metrics module .notdef advance',
      '/DW ' + dw + ' vs metrics ' + expected
    );
  });
}

function checkNotdefGeometry() {
  head('D1 regression — unmapped codepoints stay inside the cell');
  // Invented name; the company string is deliberately outside Inter's coverage.
  var attendee = {
    id: 'cjk1',
    first: 'Kenji',
    last: 'Watanabe',
    company: '字'.repeat(11),
    title: 'Legal Counsel'
  };
  return build([attendee], 'notdef.pdf', { logo: { enabled: false } }).then(function (res) {
    var lay = res.layouts[0].result;
    var co = lay.lines.filter(function (l) { return l.field === 'company'; })[0];
    var predictedRight = co ? co.x + co.lineWidth : 0;
    var R = raster(res.file, 1);
    var ink = R.all();

    console.log('  engine predicted company right edge: ' + f(predictedRight) + ' pt');
    console.log('  RASTER ink: x ' + f(ink.x0) + '..' + f(ink.x1) + '  y ' + f(ink.y0) + '..' + f(ink.y1) +
      '  (' + ink.count + ' px @ ' + DPI + ' dpi)');
    console.log('  pdftotext sees ' + extract(res.file)[0].words.length +
      ' words here — .notdef glyphs are invisible to bbox extraction, which is why this check rasterises');

    assert(ink.x1 <= S.CELL_W + 0.001, 'RASTER: ink right edge inside the 288 pt cell', f(ink.x1) + ' pt');
    assert(ink.y1 <= S.CELL_H + 0.001, 'RASTER: ink bottom edge inside the 216 pt cell', f(ink.y1) + ' pt');
    assert(
      near(ink.x1, predictedRight, 2),
      'RASTER: drawn width agrees with the width the engine measured',
      'ink ' + f(ink.x1) + ' vs predicted ' + f(predictedRight) + ' (delta ' + f(ink.x1 - predictedRight) + ')'
    );
    checkDefaultWidths(res.file, 'notdef.pdf');
  });
}

function checkTextOnly(file, tag) {
  head('text-only content streams — ' + tag);
  return contentStreams(file).then(function (streams) {
    assert(streams.length > 0, 'content streams decoded', streams.length + ' stream(s)');
    var found = {};
    var total = 0;
    streams.forEach(function (s) {
      operatorsIn(s).forEach(function (t) {
        total++;
        if (PATH_OPS[t]) found[t] = (found[t] || 0) + 1;
      });
    });
    var names = Object.keys(found);
    assert(
      names.length === 0,
      'zero path / XObject operators (no rectangle drawn for the logo reserve, no borders, no crop marks)',
      names.length ? JSON.stringify(found) : total + ' operator tokens scanned, none of ' +
        Object.keys(PATH_OPS).length + ' forbidden ops present'
    );
  });
}

// =========================================================================
// logo reserve (Addendum 2C)
// =========================================================================

function drawListOf(res) {
  var out = [];
  res.pages.forEach(function (p, pi) {
    p.draws.forEach(function (d) {
      out.push(pi + '|' + d.text + '|' + d.x.toFixed(6) + '|' + d.y.toFixed(6) + '|' + d.size);
    });
  });
  return out;
}

/**
 * Every layout() call must have received the resolved sheet-wide settings as arg 3.
 * `wantAlign` is optional so older call sites keep working.
 */
function checkLogoThreading(res, want, tag, wantAlign) {
  head('sheet settings — opts threaded into every layout() call (' + tag + ')');
  assert(res.layouts.length > 0, 'layout() was called', res.layouts.length + ' call(s)');

  var missing = res.layouts.filter(function (c) { return c.argc < 3 || !c.opts || !c.opts.logo; });
  assert(
    missing.length === 0,
    'every layout() call received opts.logo (a caller that forgot would show up here)',
    missing.length ? missing.length + ' of ' + res.layouts.length + ' call(s) had no opts' : res.layouts.length + ' call(s)'
  );

  var noAlign = res.layouts.filter(function (c) { return !c.opts || !c.opts.align; });
  assert(
    noAlign.length === 0,
    'every layout() call received opts.align',
    noAlign.length ? noAlign.length + ' of ' + res.layouts.length + ' call(s) had no align'
      : res.layouts.length + ' call(s)'
  );
  if (wantAlign) {
    var wrongAlign = res.layouts.filter(function (c) {
      return !c.opts || c.opts.align !== wantAlign;
    });
    assert(
      wrongAlign.length === 0,
      'the align forwarded is "' + wantAlign + '"',
      wrongAlign.length ? wrongAlign.length + ' mismatch(es), first: ' +
        JSON.stringify(wrongAlign[0].opts && wrongAlign[0].opts.align) : 'all ' + res.layouts.length + ' call(s)'
    );
  }

  var wrong = res.layouts.filter(function (c) {
    var l = c.opts && c.opts.logo;
    return !l || !!l.enabled !== !!want.enabled ||
      (want.enabled && (Math.abs(l.wPt - want.wPt) > 1e-9 || Math.abs(l.hPt - want.hPt) > 1e-9));
  });
  assert(
    wrong.length === 0,
    'the config forwarded matches the resolved setting',
    'want ' + JSON.stringify(want) + ', mismatches: ' + wrong.length
  );

  var same = res.layouts.every(function (c) { return c.opts === res.layouts[0].opts; });
  assert(same, 'one shared config object for the whole sheet (no per-badge drift)');
}

/** The PDF must draw exactly the lines layout() returned — no divergence. */
function checkDrawMatchesLayout(res, tag, preset) {
  head('preview/print parity — drawn runs == layout() lines (' + tag + ')');
  var expected = [];
  res.layouts.forEach(function (call, i) {
    var cell = S.cellOrigin(i % S.PER_PAGE, preset);
    var page = Math.floor(i / S.PER_PAGE);
    call.result.lines.forEach(function (ln) {
      if (!ln.text) return;
      expected.push(
        page + '|' + ln.text + '|' + (cell.x + ln.x).toFixed(6) + '|' +
          (S.PAGE_H - (cell.y + ln.baselineY)).toFixed(6) + '|' + ln.sizePt
      );
    });
  });
  var actual = drawListOf(res);
  var firstDiff = -1;
  for (var i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) { firstDiff = i; break; }
  }
  assert(
    firstDiff === -1,
    'all ' + expected.length + ' text runs match layout() exactly (text, x, y, size)',
    firstDiff === -1
      ? 'byte-equal draw list'
      : 'first divergence at run ' + firstDiff + ': expected ' + expected[firstDiff] + ' got ' + actual[firstDiff]
  );
}

function checkLogoReserve(caps) {
  var attendees = fixture('six.json');
  var want = { enabled: true, wPt: 72, hPt: 72 };
  var preset = S.SHEET_PRESET_DEFAULT;
  var EXPECTED_ORIGINS = originsFor(preset);

  return build(attendees, 'logo-on.pdf', { logo: LOGO_1IN }).then(function (res) {
    checkLogoThreading(res, want, 'logo ON 1x1 in');
    checkDrawMatchesLayout(res, 'logo ON 1x1 in', preset);

    head('logo reserve — HARD INVARIANT: no ink in the reserved rectangle');
    console.log('  reserve per cell: x ' + (S.CELL_W - want.wPt) + '..' + S.CELL_W +
      ', y ' + (S.CELL_H - want.hPt) + '..' + S.CELL_H + ' (cell-relative, from the raw cell edge)');

    var R = raster(res.file, 1);
    var worstGap = Infinity;
    var worstWhere = '';
    var violations = 0;

    EXPECTED_ORIGINS.forEach(function (o, i) {
      var rx0 = o[0] + S.CELL_W - want.wPt;
      var ry0 = o[1] + S.CELL_H - want.hPt;
      var hit = R.scan(rx0, ry0, o[0] + S.CELL_W, o[1] + S.CELL_H);
      // Clearance: how far the nearest ink in the reserve's y-band stays left of it.
      var band = R.scan(o[0], ry0, o[0] + S.CELL_W, o[1] + S.CELL_H);
      var gap = band.count ? rx0 - band.x1 : Infinity;
      if (gap < worstGap) { worstGap = gap; worstWhere = 'cell ' + (i + 1); }
      if (hit.count) violations++;

      var detail = hit.count
        ? hit.count + ' ink px INSIDE the reserve (x ' + f(hit.x0) + '..' + f(hit.x1) + ')'
        : 'clear; nearest ink in the reserve y-band ends ' +
          (band.count ? f(gap) + ' pt to its left' : 'n/a (no ink in that band)');

      if (caps.logo) assert(hit.count === 0, 'RASTER: cell ' + (i + 1) + ' reserve is empty', detail);
      else blocked('RASTER: cell ' + (i + 1) + ' reserve is empty — js/layout.js has not shipped Addendum 2C', detail);
    });

    console.log('  worst-case gap between ink and the reserved rectangle: ' +
      (isFinite(worstGap) ? f(worstGap) + ' pt (' + worstWhere + ')' : 'n/a') +
      (violations ? '  [' + violations + ' cell(s) violating]' : ''));

    // Nothing may be DRAWN for the reserve, enabled or not.
    return checkTextOnly(res.file, 'logo ON').then(function () {
      head('logo reserve — disabled case is unchanged');
      // Three ways of saying "off" must produce identical geometry.
      return build(attendees, 'logo-off-explicit.pdf', { logo: { enabled: false, wPt: 72, hPt: 72 } })
        .then(function (offA) {
          checkLogoThreading(offA, { enabled: false }, 'explicit disabled');
          return build(attendees, 'logo-off-empty.pdf', {}).then(function (offB) {
            checkLogoThreading(offB, { enabled: false }, 'opts = {} (no logo key)');
            return build(attendees, 'logo-off-nostore.pdf').then(function (offC) {
              checkLogoThreading(offC, { enabled: false }, 'opts omitted, no BadgeStore');
              var a = drawListOf(offA).join('\n');
              var b = drawListOf(offB).join('\n');
              var c = drawListOf(offC).join('\n');
              assert(a === b && b === c, 'all three "disabled" spellings draw identical geometry',
                a.split('\n').length + ' runs each');
              return { disabledDraws: a, onDraws: drawListOf(res).join('\n') };
            });
          });
        });
    });
  });
}

function checkResolveLogo() {
  head('resolveLogo() — inches to points, store fallback, clamps');
  var saved = global.BadgeStore;
  var r;

  try {
    // explicit opts win
    r = BadgePdf.resolveLogo({ logo: { enabled: true, wPt: 36, hPt: 108 } });
    assert(r.enabled && r.wPt === 36 && r.hPt === 108, 'explicit opts pass through', JSON.stringify(r));

    r = BadgePdf.resolveLogo({});
    assert(!r.enabled, 'opts with no logo key => disabled', JSON.stringify(r));

    r = BadgePdf.resolveLogo({ logo: { enabled: true, wPt: 0, hPt: 72 } });
    assert(!r.enabled, 'zero width => disabled (never a half-configured reserve)', JSON.stringify(r));

    r = BadgePdf.resolveLogo({ logo: { enabled: true, wPt: NaN, hPt: NaN } });
    assert(r.enabled && r.wPt === 72 && r.hPt === 72, 'non-finite size falls back to the 1 in default', JSON.stringify(r));

    r = BadgePdf.resolveLogo({ logo: { enabled: true, wPt: 9999, hPt: 9999 } });
    assert(r.wPt === S.CELL_W && r.hPt === S.CELL_H, 'oversize is clamped to the cell', JSON.stringify(r));

    // store fallback, INCHES -> points
    delete global.BadgeStore;
    r = BadgePdf.resolveLogo();
    assert(!r.enabled, 'no BadgeStore => disabled', JSON.stringify(r));

    global.BadgeStore = { getAttendees: function () { return []; } };
    r = BadgePdf.resolveLogo();
    assert(!r.enabled, 'store without getLogo() => disabled (pre-Addendum-2C store)', JSON.stringify(r));

    global.BadgeStore = { getLogo: function () { return { enabled: true, wIn: 1.5, hIn: 0.75 }; } };
    r = BadgePdf.resolveLogo();
    assert(r.enabled && r.wPt === 108 && r.hPt === 54, 'store inches converted x72', JSON.stringify(r));

    global.BadgeStore = { getLogo: function () { return { enabled: false, wIn: 1, hIn: 1 }; } };
    r = BadgePdf.resolveLogo();
    assert(!r.enabled, 'store says off => disabled', JSON.stringify(r));

    var warns = 0;
    var realWarn = console.warn;
    console.warn = function () { warns++; };
    global.BadgeStore = { getLogo: function () { throw new Error('logo boom'); } };
    r = BadgePdf.resolveLogo();
    console.warn = realWarn;
    assert(!r.enabled && warns === 1, 'a throwing getLogo() warns and disables', JSON.stringify(r));
  } finally {
    if (saved === undefined) delete global.BadgeStore;
    else global.BadgeStore = saved;
  }
}

// =========================================================================
// error handling + mount
// =========================================================================

function checkFontDataErrors() {
  head('D5 — corrupt font data gives an actionable error, never a fallback face');
  var saved = global.InterFontData;
  var good = saved.regularTtfBase64;

  function restore() { global.InterFontData = saved; }

  global.InterFontData = { regularTtfBase64: '!!!!not base64!!!!', boldTtfBase64: good, italicTtfBase64: good };
  return BadgePdf.exportPdf(fixture('six.json').slice(0, 1), {}, { logo: { enabled: false } })
    .then(function () {
      bad('non-base64 font data rejects');
    }, function (err) {
      assert(
        err.name === 'BadgePdfFontDataError' && /not valid base64/.test(err.message) && /Regular/.test(err.message),
        'non-base64 font data => named error naming the face and the cause',
        err.name + ': ' + err.message.slice(0, 90) + '...'
      );
    })
    .then(function () {
      // Valid base64, but not a font: truncate to a multiple of 4 chars.
      var truncated = good.replace(/\s/g, '').slice(0, 400);
      global.InterFontData = { regularTtfBase64: truncated, boldTtfBase64: good, italicTtfBase64: good };
      return BadgePdf.exportPdf(fixture('six.json').slice(0, 1), {}, { logo: { enabled: false } });
    })
    .then(function () {
      bad('truncated TTF rejects');
    }, function (err) {
      assert(
        err.name === 'BadgePdfFontDataError' && /corrupt|not a TrueType/.test(err.message),
        'truncated TTF => named error, no silent substitution',
        err.name + ': ' + err.message.slice(0, 90) + '...'
      );
    })
    .then(restore, restore);
}

/**
 * mount() against a hand-rolled minimal DOM. Not a rendering test — it proves the
 * guards hold: no mount point, no store, a THROWING store (D3), zero attendees, and
 * a click() that throws must not leak the anchor or the object URL (D6).
 */
function checkMount() {
  head('mount() guards (minimal DOM stub)');

  function El(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.handlers = {};
    this.textContent = '';
    this.parentNode = null;
  }
  El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  El.prototype.removeChild = function (c) {
    this.children = this.children.filter(function (x) { return x !== c; });
    c.parentNode = null;
  };
  El.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
  El.prototype.addEventListener = function (t, fn) { this.handlers[t] = fn; };
  El.prototype.querySelector = function (sel) {
    var key = /^\[([^\]]+)\]$/.exec(sel);
    if (!key) return null;
    var found = null;
    (function walk(node) {
      node.children.forEach(function (c) {
        if (!found && Object.prototype.hasOwnProperty.call(c.attrs, key[1])) found = c;
        if (!found) walk(c);
      });
    })(this);
    return found;
  };
  El.prototype.find = function (pred) {
    var found = null;
    (function walk(node) {
      node.children.forEach(function (c) {
        if (!found && pred(c)) found = c;
        if (!found) walk(c);
      });
    })(this);
    return found;
  };

  var warns = [];
  var realWarn = console.warn;
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };

  var host = null;
  var savedStore = global.BadgeStore;
  var createdAnchors = [];
  var body = new El('body');
  global.document = {
    body: body,
    createElement: function (t) {
      var e = new El(t);
      if (t === 'a') createdAnchors.push(e);
      return e;
    },
    getElementById: function (id) { return id === 'data-controls' ? host : null; }
  };

  var urls = { created: 0, revoked: 0 };
  var savedURL = global.URL;
  global.URL = {
    createObjectURL: function () { urls.created++; return 'blob:stub/' + urls.created; },
    revokeObjectURL: function () { urls.revoked++; }
  };

  var finish = function () {
    console.warn = realWarn;
    delete global.document;
    global.URL = savedURL;
    if (savedStore === undefined) delete global.BadgeStore;
    else global.BadgeStore = savedStore;
  };

  try {
    host = null;
    BadgePdf.mount();
    assert(warns.length === 1, 'missing #data-controls warns instead of throwing', warns[0] || '(no warning)');

    host = new El('div');
    BadgePdf.mount();
    var btn = host.querySelector('[data-badge-pdf-export]');
    assert(!!btn && btn.textContent === 'Export PDF', 'Export PDF button added to #data-controls',
      btn ? btn.textContent : 'not found');
    BadgePdf.mount();
    assert(host.children.length === 1, 'mount() twice adds only one button', host.children.length + ' child block(s)');

    var note = host.find(function (c) { return String(c.tagName).toLowerCase() === 'p'; });
    if (!note) { bad('mount() creates an inline status element'); finish(); return Promise.resolve(); }

    delete global.BadgeStore;
    warns.length = 0;
    btn.handlers.click();
    assert(warns.length === 1 && !note.hidden, 'missing BadgeStore warns + shows a message', note.textContent);

    // D3: a store whose getAttendees() throws must be caught.
    global.BadgeStore = {
      getAttendees: function () { throw new Error('store boom'); },
      getOverrides: function () { return {}; }
    };
    warns.length = 0;
    note.textContent = '';
    var threw = null;
    try {
      btn.handlers.click();
    } catch (err) {
      threw = err;
    }
    assert(threw === null, 'D3: a throwing BadgeStore.getAttendees() does not escape the click handler',
      threw ? 'threw ' + threw.message : 'handled');
    assert(
      warns.length === 1 && /store boom/.test(note.textContent) && btn.disabled !== true,
      'D3: the failure is surfaced in the status note and the button stays usable',
      JSON.stringify(note.textContent)
    );

    // Same for a throwing getOverrides().
    global.BadgeStore = {
      getAttendees: function () { return fixture('six.json'); },
      getOverrides: function () { throw new Error('overrides boom'); }
    };
    warns.length = 0;
    threw = null;
    try { btn.handlers.click(); } catch (err) { threw = err; }
    assert(threw === null && /overrides boom/.test(note.textContent),
      'D3: a throwing getOverrides() is handled the same way', JSON.stringify(note.textContent));

    global.BadgeStore = { getAttendees: function () { return []; }, getOverrides: function () { return {}; } };
    warns.length = 0;
    btn.handlers.click();
    assert(
      warns.length === 0 && !note.hidden && /attendee/i.test(note.textContent) && btn.disabled !== true,
      'zero attendees shows an inline message and does nothing else',
      note.textContent
    );

    // D6: click() throwing must still remove the anchor and revoke the URL.
    global.BadgeStore = {
      getAttendees: function () { return fixture('six.json').slice(0, 1); },
      getOverrides: function () { return {}; },
      getLogo: function () { return { enabled: false, wIn: 1, hIn: 1 }; }
    };
    createdAnchors.length = 0;
    urls.created = 0;
    urls.revoked = 0;
    warns.length = 0;
    El.prototype.click = function () { throw new Error('click boom'); };
    btn.handlers.click();

    return new Promise(function (resolve) {
      // let the export promise and the revoke timeout run
      setTimeout(function () {
        var anchor = createdAnchors[0];
        assert(!!anchor, 'D6: a download anchor was created', createdAnchors.length + ' anchor(s)');
        assert(anchor && anchor.parentNode === null, 'D6: the anchor is removed from the DOM even though click() threw',
          anchor ? 'parentNode=' + anchor.parentNode : 'n/a');
        assert(body.children.indexOf(anchor) === -1, 'D6: document.body no longer contains the anchor',
          body.children.length + ' body child(ren)');
        assert(urls.created === 1 && urls.revoked === 1, 'D6: the object URL is revoked even though click() threw',
          'created ' + urls.created + ', revoked ' + urls.revoked);
        assert(warns.length >= 1, 'D6: the failure is logged', warns[0] ? warns[0].slice(0, 60) : '(none)');
        delete El.prototype.click;
        finish();
        resolve();
      }, 250);
    });
  } catch (err) {
    finish();
    throw err;
  }
}

function checkSourceHygiene() {
  head('source hygiene');
  var src = fs.readFileSync(path.join(SITE, 'js', 'pdf.js'), 'utf8');
  [
    [/\bfetch\s*\(/, 'js/pdf.js: no fetch('],
    [/XMLHttpRequest/, 'js/pdf.js: no XMLHttpRequest'],
    [/WebSocket/, 'js/pdf.js: no WebSocket'],
    [/sendBeacon/, 'js/pdf.js: no sendBeacon'],
    [/https?:\/\//, 'js/pdf.js: no http(s):// URL'],
    [/^\s*import\s/m, 'js/pdf.js: no import statement'],
    [/^\s*export\s/m, 'js/pdf.js: no export statement']
  ].forEach(function (pair) { assert(!pair[0].test(src), pair[1]); });
  assert(/window\.BadgePdf\s*=/.test(src), 'js/pdf.js assigns window.BadgePdf');

  /*
   * The sheet-preset trap: any arithmetic that derives a cell position from a row or
   * column index would ignore the preset offset and misalign every badge on real
   * die-cut stock. cellOrigin() must be the only source of a cell position.
   */
  var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  [
    [/\*\s*(?:S\.)?CELL_H/, 'no multiplication by CELL_H'],
    [/(?:S\.)?CELL_H\s*\*/, 'no CELL_H multiplied by anything'],
    [/\*\s*(?:S\.)?CELL_W/, 'no multiplication by CELL_W'],
    [/(?:S\.)?CELL_W\s*\*/, 'no CELL_W multiplied by anything'],
    [/\*\s*216\b/, 'no literal 216 row arithmetic'],
    [/\*\s*288\b/, 'no literal 288 column arithmetic']
  ].forEach(function (pair) {
    assert(!pair[0].test(code), 'js/pdf.js: ' + pair[1] + ' (cellOrigin() is the only cell position)');
  });
  var originCalls = (code.match(/cellOrigin\s*\(/g) || []).length;
  assert(originCalls >= 1, 'js/pdf.js calls BadgeSpec.cellOrigin()', originCalls + ' call site(s)');
  assert(
    /cellOrigin\s*\(\s*slot\s*,\s*presetKey\s*\)/.test(code),
    'js/pdf.js passes the resolved preset key to cellOrigin()'
  );
  assert(typeof BadgePdf.exportPdf === 'function', 'BadgePdf.exportPdf is a function');
  assert(typeof BadgePdf.mount === 'function', 'BadgePdf.mount is a function');
  assert(typeof BadgePdf.resolveLogo === 'function', 'BadgePdf.resolveLogo is a function');

  // D7: a sourceMappingURL comment makes devtools fetch a .map we do not ship.
  ['pdf-lib.min.js', 'pdf-lib-fontkit.min.js'].forEach(function (name) {
    var v = fs.readFileSync(path.join(SITE, 'vendor', name), 'utf8');
    assert(!/sourceMappingURL/.test(v), 'D7: vendor/' + name + ' has no sourceMappingURL comment',
      (fs.statSync(path.join(SITE, 'vendor', name)).size) + ' bytes');
  });
}

function checkMetadata(file) {
  head('metadata carries no attendee name');
  var info = child.execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  var title = (/^Title:\s*(.*)$/m.exec(info) || [, ''])[1].trim();
  console.log('  Title: ' + JSON.stringify(title));
  assert(title === 'Name Badges', 'title is the generic "Name Badges"', title);
  var names = fixture('six.json').reduce(function (acc, a) {
    return acc.concat([a.first, a.last, a.company]);
  }, []);
  var leaked = names.filter(function (n) { return info.indexOf(n) !== -1; });
  assert(leaked.length === 0, 'no fixture name appears in PDF metadata', leaked.join(', ') || 'clean');
}


function checkResolveSheetPreset() {
  head('resolveSheetPreset() — explicit opts, store fallback, bad input');
  var saved = global.BadgeStore;
  var DEF = S.SHEET_PRESET_DEFAULT;
  var r;
  try {
    assert(BadgePdf.resolveSheetPreset({ sheetPreset: 'avery' }) === 'avery',
      'explicit "avery" passes through');
    assert(BadgePdf.resolveSheetPreset({ sheetPreset: 'sampleTopLeft' }) === 'sampleTopLeft',
      'explicit "sampleTopLeft" passes through');
    assert(BadgePdf.resolveSheetPreset({ sheetPreset: 'nonsense' }) === DEF,
      'unknown key falls back to the default', DEF);
    assert(BadgePdf.resolveSheetPreset({}) === DEF, 'opts with no sheetPreset key => default', DEF);

    delete global.BadgeStore;
    assert(BadgePdf.resolveSheetPreset() === DEF, 'no BadgeStore => default', DEF);

    global.BadgeStore = { getAttendees: function () { return []; } };
    assert(BadgePdf.resolveSheetPreset() === DEF,
      'store without getSheetPreset() => default (pre-preset store)', DEF);

    global.BadgeStore = { getSheetPreset: function () { return 'avery'; } };
    assert(BadgePdf.resolveSheetPreset() === 'avery', 'store setting is used when opts is omitted');

    global.BadgeStore = { getSheetPreset: function () { return 'garbage'; } };
    assert(BadgePdf.resolveSheetPreset() === DEF, 'a stale/garbage stored key falls back', DEF);

    var warns = 0;
    var realWarn = console.warn;
    console.warn = function () { warns++; };
    global.BadgeStore = { getSheetPreset: function () { throw new Error('preset boom'); } };
    r = BadgePdf.resolveSheetPreset();
    console.warn = realWarn;
    assert(r === DEF && warns === 1, 'a throwing getSheetPreset() warns and falls back', r);
  } finally {
    if (saved === undefined) delete global.BadgeStore;
    else global.BadgeStore = saved;
  }
}


/*
 * GAP LINES — structure and vertical rhythm, all DERIVED.
 *
 * The engine emits: first, last, [gap], company, [gapTitle], title — the first gap
 * when either company or title exists, the second only when BOTH do. Their sizes are
 * BadgeSpec.GAP_SIZE and BadgeSpec.GAP_TITLE_SIZE.
 *
 * Nothing below pins a measured number. Julia has already retuned GAP_TITLE_SIZE
 * twice (8 -> 4 at the halfway point), so every expectation here is computed from
 * the constants and from the sizes the engine actually emitted. If she tunes it
 * again this function should stay green without an edit; if it goes red, that is a
 * real disagreement rather than a stale literal.
 */
function checkGapLines(res) {
  head('gap lines — derived structure and rhythm');
  var call = res.layouts[0];
  var lay = call.result;
  var attendee = call.attendee;
  var inked = lay.lines.filter(function (l) { return l.text; });
  var blanks = lay.lines.filter(function (l) { return !l.text; });

  function has(field) {
    return !!(attendee[field] && String(attendee[field]).trim());
  }

  // ---- a) gap COUNT, from the emission rule and this attendee's fields --------
  var wantGaps = (has('company') || has('title') ? 1 : 0) + (has('company') && has('title') ? 1 : 0);
  assert(blanks.length === wantGaps,
    'gap-line count matches the emission rule for these fields',
    blanks.length + ' gap(s), rule wants ' + wantGaps +
      ' (company=' + has('company') + ', title=' + has('title') + ')');
  assert(blanks.every(function (l) { return l.field === 'gap' && !l.text; }),
    'every gap line is field "gap" with empty text');

  // ---- b) gap SIZES, read from BadgeSpec rather than written down -------------
  var wantSizes = [];
  if (has('company') || has('title')) wantSizes.push(S.GAP_SIZE);
  if (has('company') && has('title')) wantSizes.push(S.GAP_TITLE_SIZE);
  var gotSizes = blanks.map(function (l) { return l.sizePt; });
  assert(
    gotSizes.length === wantSizes.length &&
      gotSizes.every(function (v, i) { return Math.abs(v - wantSizes[i]) < 1e-9; }),
    'gap sizes are BadgeSpec.GAP_SIZE then BadgeSpec.GAP_TITLE_SIZE',
    '[' + gotSizes.join(', ') + '] vs BadgeSpec [' + wantSizes.join(', ') + ']'
  );

  // ---- c) ORDER: fields in order, gaps in the right slots --------------------
  var seq = lay.lines.map(function (l) { return l.field; });
  var fieldsOnly = seq.filter(function (fl) { return fl !== 'gap'; });
  var expectOrder = ['first', 'last', 'company', 'title'].filter(has);
  var grouped = fieldsOnly.filter(function (fl, i) { return fl !== fieldsOnly[i - 1]; });
  assert(grouped.join(',') === expectOrder.join(','),
    'text lines appear in field order first, last, company, title',
    grouped.join(',') + ' (wrapped lines collapsed)');
  if (wantGaps === 2) {
    assert(
      seq[seq.indexOf('company') - 1] === 'gap' && seq[seq.indexOf('title') - 1] === 'gap',
      'a gap sits immediately above the first company line and the first title line',
      seq.join(',')
    );
  }

  // ---- d) BASELINE SEPARATION, derived ---------------------------------------
  var company = inked.filter(function (l) { return l.field === 'company'; }).pop();
  var title = inked.filter(function (l) { return l.field === 'title'; })[0];
  if (company && title) {
    var sep = title.baselineY - company.baselineY;
    /*
     * Baselines, not line tops: baseline = lineTop + ascentPt(size). The two line
     * tops are advance(company) + advance(gapTitle) apart, and each baseline sits
     * its own ascent below its own top — so the ascent DIFFERENCE between the two
     * sizes belongs in the sum. (Title at 19 pt sits ~1.94 pt less far below its
     * top than company at 21 pt.)
     */
    var expectedSep =
      S.ADVANCE_FACTOR * (company.sizePt + S.GAP_TITLE_SIZE) +
      M.ascentPt(title.sizePt) - M.ascentPt(company.sizePt);
    console.log('  GAP_SIZE=' + S.GAP_SIZE + ', GAP_TITLE_SIZE=' + S.GAP_TITLE_SIZE +
      ' (read from BadgeSpec)');
    console.log('  company -> title baseline separation: measured ' + f(sep) +
      ' pt, derived ' + f(expectedSep) + ' pt');
    assert(Math.abs(sep - expectedSep) < 0.01,
      'separation = advance(company) + advance(gapTitle) + ascent(title) - ascent(company)',
      f(sep) + ' vs ' + f(expectedSep) +
        '  [advances ' + f(S.ADVANCE_FACTOR * (company.sizePt + S.GAP_TITLE_SIZE)) +
        ', ascent delta ' + f(M.ascentPt(title.sizePt) - M.ascentPt(company.sizePt)) + ']');

    // Cross-check against the no-second-gap case: the separation must exceed it by
    // exactly advance(GAP_TITLE_SIZE), which is what the new gap line buys.
    var withoutGap =
      S.ADVANCE_FACTOR * company.sizePt + M.ascentPt(title.sizePt) - M.ascentPt(company.sizePt);
    assert(Math.abs(sep - withoutGap - S.ADVANCE_FACTOR * S.GAP_TITLE_SIZE) < 0.01,
      'the second gap adds exactly advance(GAP_TITLE_SIZE) to the separation',
      f(withoutGap) + ' + ' + f(S.ADVANCE_FACTOR * S.GAP_TITLE_SIZE) + ' = ' + f(sep));
  }

  // ---- e) blockHeight, summed from the emitted line sizes ---------------------
  var derivedHeight = lay.lines.reduce(function (acc, l) {
    return acc + S.ADVANCE_FACTOR * l.sizePt;
  }, 0);
  console.log('  blockHeight: reported ' + f(lay.blockHeight) + ' pt, derived from ' +
    lay.lines.length + ' emitted line sizes [' +
    lay.lines.map(function (l) { return l.sizePt; }).join(', ') + '] = ' + f(derivedHeight) + ' pt');
  assert(Math.abs(lay.blockHeight - derivedHeight) < 0.01,
    'blockHeight = sum of ADVANCE_FACTOR * size over every emitted line (gaps included)',
    f(lay.blockHeight) + ' vs ' + f(derivedHeight));
  assert(lay.blockHeight <= S.BOX_H + 1e-9,
    'blockHeight fits the ' + S.BOX_H + ' pt text box', f(lay.blockHeight) + ' pt');

  // ---- f) gap lines must not reach the PDF -----------------------------------
  var wantRuns = res.layouts.reduce(function (acc, c, i) {
    return i < S.PER_PAGE
      ? acc + c.result.lines.filter(function (l) { return l.text; }).length
      : acc;
  }, 0);
  assert(res.pages[0].draws.length === wantRuns,
    'page 1 run count equals the inked lines layout() returned',
    res.pages[0].draws.length + ' runs vs ' + wantRuns + ' inked lines (' +
      blanks.length + ' gap line(s) per badge drew nothing)');
  assert(res.pages[0].draws.every(function (d) { return !!d.text; }),
    'no empty-text run was ever sent to drawText', res.pages[0].draws.length + ' runs checked');
}

function checkResolveAlign() {
  head('resolveAlign() — explicit opts, store fallback, bad input (default LEFT)');
  var saved = global.BadgeStore;
  var r;
  try {
    assert(BadgePdf.resolveAlign({ align: 'left' }) === 'left', 'explicit "left" passes through');
    assert(BadgePdf.resolveAlign({ align: 'center' }) === 'center', 'explicit "center" passes through');
    assert(BadgePdf.resolveAlign({ align: 'justify' }) === 'left', 'unknown value falls back to left');
    assert(BadgePdf.resolveAlign({}) === 'left', 'opts with no align key => left (the new default)');

    delete global.BadgeStore;
    assert(BadgePdf.resolveAlign() === 'left', 'no BadgeStore => left');

    global.BadgeStore = { getAttendees: function () { return []; } };
    assert(BadgePdf.resolveAlign() === 'left', 'store without getAlign() => left (pre-align store)');

    global.BadgeStore = { getAlign: function () { return 'center'; } };
    assert(BadgePdf.resolveAlign() === 'center', 'store setting is used when opts is omitted');

    global.BadgeStore = { getAlign: function () { return 'CENTER'; } };
    assert(BadgePdf.resolveAlign() === 'left', 'a stale/garbage stored value falls back to left');

    var warns = 0;
    var realWarn = console.warn;
    console.warn = function () { warns++; };
    global.BadgeStore = { getAlign: function () { throw new Error('align boom'); } };
    r = BadgePdf.resolveAlign();
    console.warn = realWarn;
    assert(r === 'left' && warns === 1, 'a throwing getAlign() warns and falls back to left', r);
  } finally {
    if (saved === undefined) delete global.BadgeStore;
    else global.BadgeStore = saved;
  }
}

/*
 * The full matrix the coordinator asked for: both alignments x both sheet presets,
 * logo reserve ON. Only the hard invariants — inside its own cell, out of the
 * reserve, out of the unprinted bands — so the matrix stays cheap.
 */
function checkInvariantMatrix(caps) {
  var combos = [];
  ['left', 'center'].forEach(function (align) {
    ['sampleTopLeft', 'avery'].forEach(function (preset) {
      combos.push({ align: align, preset: preset });
    });
  });

  return combos.reduce(function (chain, combo) {
    return chain.then(function () {
      var tag = combo.align + '/' + combo.preset + '/logo-on';
      return build(fixture('six.json'), 'matrix-' + combo.align + '-' + combo.preset + '.pdf', {
        logo: LOGO_1IN,
        sheetPreset: combo.preset,
        align: combo.align
      }).then(function (res) {
        head('invariant matrix — ' + tag);
        checkDrawMatchesLayout(res, tag, combo.preset);

        var origins = originsFor(combo.preset);
        var pages = extract(res.file);
        var R = raster(res.file, 1);
        var bx = blockOrigin(combo.preset);

        // a) every word inside its own cell
        var strays = 0;
        badgesOf(pages[0], combo.preset).forEach(function (b) {
          var o = origins[b.cellIndex];
          if (!o) { strays++; return; }
          b.words.forEach(function (w) {
            if (w.x0 < o[0] - 0.001 || w.x1 > o[0] + S.CELL_W + 0.001 ||
                w.y0 < o[1] - 0.001 || w.y1 > o[1] + S.CELL_H + 0.001) strays++;
          });
        });
        assert(strays === 0, tag + ': every word inside its own cell', strays + ' stray(s)');

        // b) reserve empty in all six cells (raster: sees .notdef ink too)
        var reserveInk = 0;
        var worstGap = Infinity;
        origins.forEach(function (o) {
          var rx0 = o[0] + S.CELL_W - LOGO_1IN.wPt;
          var ry0 = o[1] + S.CELL_H - LOGO_1IN.hPt;
          reserveInk += R.scan(rx0, ry0, o[0] + S.CELL_W, o[1] + S.CELL_H).count;
          var band = R.scan(o[0], ry0, o[0] + S.CELL_W, o[1] + S.CELL_H);
          if (band.count) worstGap = Math.min(worstGap, rx0 - band.x1);
        });
        var gapText = isFinite(worstGap) ? 'worst gap ' + f(worstGap) + ' pt' : 'no ink in the reserve band';
        if (caps.logo && (caps.align || combo.align === 'center')) {
          assert(reserveInk === 0, tag + ': RASTER zero ink in all six reserves',
            reserveInk ? reserveInk + ' px inside' : gapText);
        } else {
          blocked(tag + ': RASTER zero ink in all six reserves — upstream engine gap',
            reserveInk ? reserveInk + ' px inside' : gapText);
        }

        // c) nothing in the unprinted bands
        var outside =
          R.scan(0, 0, bx.x, S.PAGE_H).count +
          R.scan(bx.x + BLOCK_W, 0, S.PAGE_W, S.PAGE_H).count +
          R.scan(0, 0, S.PAGE_W, bx.y).count +
          R.scan(0, bx.y + BLOCK_H, S.PAGE_W, S.PAGE_H).count;
        assert(outside === 0, tag + ': RASTER zero ink outside the 576 x 648 block', outside + ' px');
      });
    });
  }, Promise.resolve());
}

/*
 * The presets are a pure translation of the grid: the same six badges, shifted by
 * (18,72). Every drawn run must move by exactly that and nothing else.
 */
function checkPresetTranslation(sampleRes, averyRes) {
  head('sheet presets — avery is a pure (+18,+72) translation of sampleTopLeft');
  var a = sampleRes.pages[0].draws;
  var b = averyRes.pages[0].draws;
  assert(a.length === b.length, 'same number of text runs', a.length + ' vs ' + b.length);

  var worstDx = 0;
  var worstDy = 0;
  var mismatched = 0;
  for (var i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].text !== b[i].text || a[i].size !== b[i].size) { mismatched++; continue; }
    var dx = b[i].x - a[i].x;
    // pdf y grows UP, so a +72 pt shift DOWN the page is -72 in pdf space.
    var dy = b[i].y - a[i].y;
    worstDx = Math.max(worstDx, Math.abs(dx - 18));
    worstDy = Math.max(worstDy, Math.abs(dy + 72));
  }
  assert(mismatched === 0, 'same text and sizes in the same order', mismatched + ' mismatch(es)');
  assert(worstDx < 1e-9, 'every run moved exactly +18 pt in x', 'worst error ' + worstDx.toExponential(2) + ' pt');
  assert(worstDy < 1e-9, 'every run moved exactly -72 pt in pdf y (= +72 pt down the page)',
    'worst error ' + worstDy.toExponential(2) + ' pt');
}

// =========================================================================
// three-line title (MAX_LINES.title 2 -> 3, 2026-08-20)
// =========================================================================

/**
 * The third title line is a change to the ENGINE, but it is the exporter that has
 * to survive it: one more run per badge, drawn lower in the cell, with the logo
 * reserve ON (the default since the same day) narrowing the lines that sit level
 * with it. Verified all the way through to raster ink, not just to the draw list —
 * a title line that overflowed the cell or intruded on the reserve would be
 * invisible in the layout numbers the exporter was handed.
 *
 * Fixture names are invented, as everywhere else in this suite.
 */
function checkThreeLineTitle(caps) {
  var attendees = [
    { id: 'tl1', first: 'Ana', last: 'Rios',
      company: 'Whitfield Cordovan Analytics Group',
      title: 'Deputy General Counsel and Chief Privacy Officer for the Americas Region' },
    { id: 'tl2', first: 'Bartholomew', last: 'Vandergriff-Castellanos',
      company: 'Bristol-Myers Squibb Holdings International',
      title: 'Executive Vice President, General Counsel & Corporate Secretary' }
  ];
  var preset = S.SHEET_PRESET_DEFAULT;
  var ORIGINS = originsFor(preset);

  return build(attendees, 'three-line-title.pdf', { logo: LOGO_1IN, align: 'left' }).then(function (res) {
    head('three-line title — the engine really produced three lines');
    assert(S.MAX_LINES.title === 3, 'BadgeSpec.MAX_LINES.title is 3', String(S.MAX_LINES.title));

    var perBadge = res.layouts.map(function (c) {
      return c.result.lines.filter(function (l) { return l.field === 'title' && l.text; }).length;
    });
    assert(perBadge[0] === 3, 'badge 1 title occupies three lines', 'lines = ' + perBadge[0]);
    assert(perBadge[1] === 3, 'badge 2 title occupies three lines', 'lines = ' + perBadge[1]);
    assert(
      res.layouts.every(function (c) { return c.result.fits && !c.result.warnings.length; }),
      'neither badge was clipped or warned about',
      JSON.stringify(res.layouts.map(function (c) { return c.result.warnings.length; }))
    );

    checkLogoThreading(res, { enabled: true, wPt: 72, hPt: 72 }, 'three-line title, reserve ON', 'left');
    checkDrawMatchesLayout(res, 'three-line title / reserve ON / left', preset);

    head('three-line title — every word survives into the PDF text layer');
    var pageWords = extract(res.file)[0].words.map(function (w) { return w.text; }).join(' ');
    var missingWords = [];
    attendees.forEach(function (a) {
      a.title.split(' ').forEach(function (w) {
        // pdftotext splits on its own word boundaries; compare on the alphanumeric core.
        var core = w.replace(/[^A-Za-z0-9]/g, '');
        if (core && pageWords.replace(/[^A-Za-z0-9 ]/g, '').indexOf(core) === -1) missingWords.push(w);
      });
    });
    assert(missingWords.length === 0,
      'no word of either three-line title was lost to wrapping or clipping',
      missingWords.length ? 'missing: ' + missingWords.join(', ') : 'all words present');

    head('three-line title — RASTER: ink stays in the cell and out of the reserve');
    var R = raster(res.file, 1);
    var inReserve = 0;
    var outsideCell = 0;
    [0, 1].forEach(function (i) {
      var o = ORIGINS[i];
      var rx0 = o[0] + S.CELL_W - 72;
      var ry0 = o[1] + S.CELL_H - 72;
      var hit = R.scan(rx0, ry0, o[0] + S.CELL_W, o[1] + S.CELL_H);
      if (hit.count) inReserve++;
      if (caps.logo) {
        assert(hit.count === 0, 'cell ' + (i + 1) + ': the reserved corner is empty even with a third title line',
          hit.count ? hit.count + ' ink px inside' : 'clear');
      } else {
        blocked('cell ' + (i + 1) + ': reserve empty — js/layout.js has not shipped Addendum 2C');
      }
      /* The third line is the LOWEST ink on the badge, so the bottom edge is the
         one that would give way first. Scanned one point past the cell on every
         side: any ink there belongs to a neighbour, or to nobody. */
      var below = R.scan(o[0], o[1] + S.CELL_H, o[0] + S.CELL_W, o[1] + S.CELL_H + 1);
      var right = R.scan(o[0] + S.CELL_W, o[1], o[0] + S.CELL_W + 1, o[1] + S.CELL_H);
      if (below.count || right.count) outsideCell++;
      assert(below.count === 0, 'cell ' + (i + 1) + ': no ink below the cell — the third line did not overflow',
        below.count ? below.count + ' px' : 'clear');
    });
    console.log('  ' + inReserve + ' reserve violation(s), ' + outsideCell + ' cell-overflow(s) across 2 badges');

    return checkTextOnly(res.file, 'three-line title');
  });
}

// =========================================================================
// run
// =========================================================================

fs.mkdirSync(OUT, { recursive: true });
console.log('output dir: ' + OUT);
console.log('raster: pdftoppm -gray @ ' + DPI + ' dpi (1 px = ' + f(72 / DPI) + ' pt)');

var caps = engineCapabilities();
var sixSample = null;

build(fixture('six.json'), 'six.pdf', { logo: { enabled: false }, sheetPreset: 'sampleTopLeft', align: 'left' })
  .then(function (res) {
    console.log('\nwrote six.pdf (' + res.bytes + ' bytes)  [sampleTopLeft, align:left]');
    sixSample = res;
    checkLogoThreading(res, { enabled: false }, 'six.json default export', 'left');
    checkSix(res, caps, 'sampleTopLeft', 'left', 0);
    checkGapLines(res);
    checkDrawMatchesLayout(res, 'six.json/sampleTopLeft/left', 'sampleTopLeft');
    checkFonts(res.file);
    checkDefaultWidths(res.file, 'six.pdf');
    checkMetadata(res.file);
    return checkTextOnly(res.file, 'six.pdf');
  })
  .then(function () {
    return build(fixture('six.json'), 'six-avery.pdf',
      { logo: { enabled: false }, sheetPreset: 'avery', align: 'left' });
  })
  .then(function (res) {
    console.log('\nwrote six-avery.pdf (' + res.bytes + ' bytes)  [avery, align:left]');
    checkSix(res, caps, 'avery', 'left', 0);
    checkDrawMatchesLayout(res, 'six.json/avery/left', 'avery');
    checkPresetTranslation(sixSample, res);
    return checkTextOnly(res.file, 'six-avery.pdf');
  })
  .then(function () {
    return build(fixture('six.json'), 'six-center.pdf',
      { logo: { enabled: false }, sheetPreset: 'sampleTopLeft', align: 'center' });
  })
  .then(function (res) {
    console.log('\nwrote six-center.pdf (' + res.bytes + ' bytes)  [sampleTopLeft, align:center]');
    checkLogoThreading(res, { enabled: false }, 'align:center', 'center');
    checkSix(res, caps, 'sampleTopLeft', 'center', 0);
    checkDrawMatchesLayout(res, 'six.json/sampleTopLeft/center', 'sampleTopLeft');
    return checkTextOnly(res.file, 'six-center.pdf');
  })
  .then(function () {
    return build(fixture('six.json'), 'six-center-avery.pdf',
      { logo: { enabled: false }, sheetPreset: 'avery', align: 'center' });
  })
  .then(function (res) {
    console.log('\nwrote six-center-avery.pdf (' + res.bytes + ' bytes)  [avery, align:center]');
    checkSix(res, caps, 'avery', 'center', 0);
    checkDrawMatchesLayout(res, 'six.json/avery/center', 'avery');
    return checkTextOnly(res.file, 'six-center-avery.pdf');
  })
  .then(function () {
    return build(fixture('fourteen.json'), 'fourteen.pdf', { logo: { enabled: false }, sheetPreset: 'sampleTopLeft' });
  })
  .then(function (res) {
    console.log('\nwrote fourteen.pdf (' + res.bytes + ' bytes)');
    checkFourteen(res, 'sampleTopLeft');
    return build(fixture('fourteen.json'), 'fourteen-avery.pdf', { logo: { enabled: false }, sheetPreset: 'avery' });
  })
  .then(function (res) {
    console.log('\nwrote fourteen-avery.pdf (' + res.bytes + ' bytes)');
    checkFourteen(res, 'avery');
    return build(fixture('stress.json'), 'stress.pdf', { logo: { enabled: false } });
  })
  .then(function (res) {
    console.log('\nwrote stress.pdf (' + res.bytes + ' bytes)');
    checkStress(res, 'sampleTopLeft');
    return build(fixture('stress.json'), 'stress-avery.pdf', { logo: { enabled: false }, sheetPreset: 'avery' });
  })
  .then(function (res) {
    console.log('\nwrote stress-avery.pdf (' + res.bytes + ' bytes)');
    checkStress(res, 'avery');
    return checkNotdefGeometry();
  })
  .then(function () { return checkLogoReserve(caps); })
  .then(function () { return checkThreeLineTitle(caps); })
  .then(function () { return checkInvariantMatrix(caps); })
  .then(function () {
    checkResolveLogo();
    checkResolveSheetPreset();
    checkResolveAlign();
    return checkFontDataErrors();
  })
  .then(function () { return checkMount(); })
  .then(function () {
    checkSourceHygiene();
    head('summary');
    console.log('  ' + (checks - failures) + ' / ' + checks + ' checks passed');
    if (failures) {
      console.log('  ' + failures + ' FAILURE(S)');
      if (!caps.optical || !caps.logo || !caps.align) {
        console.log('  NOTE: BLOCK results above are upstream gaps in js/layout.js');
        console.log('        (Addendum 2B optical centering: ' + (caps.optical ? 'live' : 'MISSING') +
          ', 2C logo reserve: ' + (caps.logo ? 'live' : 'MISSING') +
          ', align: ' + (caps.align ? 'live' : 'MISSING') + ').');
        console.log('        js/pdf.js already forwards opts and draws whatever the engine returns.');
      }
      process.exit(1);
    }
    console.log('  ALL GREEN');
  })
  .catch(function (err) {
    console.error('\nUNCAUGHT ERROR');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
