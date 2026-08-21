/*
 * test/docx.test.js - js/docx.js, the Word export.
 *
 *     node test/docx.test.js       (run from inside site/)
 *
 * Three layers, in increasing cost:
 *
 *   1. MARKUP. buildDocumentXml() is asserted directly - page size, cell size, exact
 *      row heights, sizes in half-points, indents in twips, escaping. These are the
 *      assertions that name the broken field when something regresses.
 *   2. PACKAGE. The .docx is unzipped and every part is parsed as XML, because one
 *      malformed part makes the whole file unopenable with no clue which.
 *   3. RENDER. If LibreOffice and poppler are present, the .docx is converted to PDF
 *      and every word's position is measured and compared against OUR pdf of the same
 *      roster. That is the only layer that can catch "valid markup, wrong sheet".
 *
 * Layers 2 and 3 need `python3` / `soffice` / `pdftotext`. Missing tools SKIP with a
 * reason; they never silently pass.
 *
 * THE DELTAS IN LAYER 3 ARE NOT ZERO AND ARE NOT MEANT TO BE. The .docx is Arial by
 * deliberate choice (see the header of js/docx.js) while the PDF is Inter, and Word
 * centres the layout box where the engine centres visible ink. The bounds asserted
 * below are the measured behaviour; they exist to catch a REGRESSION, not to claim
 * the two outputs are identical. Every fixture name here is invented.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');

var SITE = path.resolve(__dirname, '..');

global.window = globalThis;
if (typeof atob === 'undefined') {
  global.atob = function (s) { return Buffer.from(s, 'base64').toString('binary'); };
}
global.Blob = function (parts, opts) {
  this._b = Buffer.concat(parts.map(function (p) { return Buffer.from(p); }));
  this.type = (opts || {}).type;
  this.size = this._b.length;
};
global.Blob.prototype.arrayBuffer = function () { return Promise.resolve(this._b); };

[
  'fonts/inter-metrics.js',
  'fonts/inter-fontdata.js',
  'vendor/pdf-lib.min.js',
  'vendor/pdf-lib-fontkit.min.js',
  'js/spec.js',
  'js/layout.js',
  'js/pdf.js',
  'js/zip.js',
  'js/docx.js'
].forEach(function (f) {
  new Function(fs.readFileSync(path.join(SITE, f), 'utf8')).call(globalThis);
});

var S = globalThis.BadgeSpec;
var L = globalThis.BadgeLayout;
var D = globalThis.BadgeDocx;

var passed = 0;
var failed = 0;
var skipped = 0;

function head(s) { console.log('\n=== ' + s + ' ==='); }
function assert(cond, label, detail) {
  if (cond) { passed++; console.log('  PASS   ' + label + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; console.log('  FAIL   ' + label + (detail ? '  [' + detail + ']' : '')); }
}
function skip(label, why) { skipped++; console.log('  SKIP   ' + label + '  (' + why + ')'); }
function have(cmd) {
  try { child.execSync('command -v ' + cmd, { stdio: 'ignore' }); return true; }
  catch (err) { return false; }
}
function count(hay, needle) {
  return (hay.split(needle).length - 1);
}

/* Invented names only - this repo is public. */
var ROSTER = [
  { id: '1', first: 'Margaret', last: 'Okonkwo-Whitfield', company: 'Brightline Therapeutics',
    title: 'Executive Vice President, General Counsel & Corporate Secretary' },
  { id: '2', first: 'Wei', last: 'Zhang', company: 'Northgate Capital Partners', title: 'General Counsel' },
  { id: '3', first: 'Bartholomew', last: 'Vandermolenaarsen',
    company: 'Intercontinental Pharmaceutical Holdings Incorporated',
    title: 'Deputy General Counsel, Litigation and Regulatory Affairs' },
  { id: '4', first: 'Ana', last: 'Ruiz', company: 'Cobalt Freight', title: 'Associate GC' },
  { id: '5', first: '', last: '', company: 'Solo Company Only', title: 'Chief Legal Officer' },
  { id: '6', first: 'Priya', last: 'Raghunathan', company: 'Vertex Grid Systems', title: 'VP Legal' },
  { id: '7', first: 'Seventh', last: 'Person', company: 'Page Two Co', title: 'Counsel' }
];
var OPTS = { align: 'left', logo: { enabled: true, wPt: 72, hPt: 72 }, sheetPreset: 'sampleTopLeft' };

// =========================================================================
head('1. page and grid geometry (the sample .docx numbers, x20 into twips)');
// =========================================================================
var xml = D.buildDocumentXml(ROSTER, {}, OPTS);

assert(xml.indexOf('<w:pgSz w:w="12240" w:h="15840"/>') !== -1,
  'page is 12240 x 15840 twips (612 x 792 pt, US Letter)');
assert(count(xml, '<w:trHeight w:hRule="exact" w:val="4320"/>') === 6,
  'six rows across two pages, every one an EXACT 4320 twips (216 pt)',
  count(xml, 'w:hRule="exact"') + ' exact heights');
assert(count(xml, '<w:tcW w:w="5760" w:type="dxa"/>') === 12,
  'twelve cells, each 5760 dxa (288 pt)');
assert(count(xml, '<w:gridCol w:w="5760"/>') === 4, 'two gridCols per table, two tables');
assert(xml.indexOf('<w:tblLayout w:type="fixed"/>') !== -1,
  'the table layout is fixed, so Word cannot resize a column to fit content');
assert(count(xml, '<w:tbl>') === 2 && count(xml, '</w:tbl>') === 2,
  'seven attendees produce exactly two tables (ceil(7/6))');
assert(count(xml, '<w:tr>') === 6, 'three rows per table');

/* Cell padding must be zero or every indent below is shifted by Word's default 108. */
assert(count(xml, '<w:left w:w="0" w:type="dxa"/>') >= 12 + 2,
  'left cell margin is forced to 0 on every cell and both tables',
  count(xml, '<w:left w:w="0" w:type="dxa"/>') + ' zeroed left margins');

// =========================================================================
head('2. the sheet preset becomes the page margin');
// =========================================================================
assert(xml.indexOf('w:top="0"') !== -1 && xml.indexOf('w:left="0"') !== -1,
  'sampleTopLeft pins the grid to the page corner (pgMar top/left 0)');
var averyXml = D.buildDocumentXml(ROSTER, {}, {
  align: 'left', logo: { enabled: true, wPt: 72, hPt: 72 }, sheetPreset: 'avery'
});
assert(averyXml.indexOf('w:top="1440"') !== -1,
  'avery offsets the grid 1 in down (pgMar top 1440 twips = 72 pt)');
assert(averyXml.indexOf('w:left="360"') !== -1,
  'avery offsets the grid 0.25 in right (pgMar left 360 twips = 18 pt)');
assert(averyXml.indexOf('<w:pgSz w:w="12240" w:h="15840"/>') !== -1,
  'the preset moves the grid, never the page size');

// =========================================================================
head('3. every line comes from BadgeLayout - sizes, indents, weights');
// =========================================================================
/*
 * The whole point of this file is that it makes no typographic decisions. So for each
 * attendee we re-run the engine here and require the markup to carry ITS numbers:
 * w:sz is the size in HALF-points, w:ind w:left is x in twips, w:line is the advance.
 */
var layoutOpts = { logo: OPTS.logo, align: OPTS.align };
var sizeMisses = 0;
var indentMisses = 0;
var spacingMisses = 0;
var totalLines = 0;
var boldSeen = 0;
var italicSeen = 0;

for (var r = 0; r < ROSTER.length; r++) {
  var res = L.layout(ROSTER[r], null, layoutOpts);
  for (var n = 0; n < res.lines.length; n++) {
    var line = res.lines[n];
    totalLines++;
    var halfPt = Math.round(line.sizePt * 2);
    var indentTw = Math.max(0, Math.round(line.x * 20));
    var lineTw = Math.round(S.ADVANCE_FACTOR * line.sizePt * 20);
    if (xml.indexOf('<w:sz w:val="' + halfPt + '"/>') === -1) sizeMisses++;
    if (xml.indexOf('w:left="' + indentTw + '"') === -1) indentMisses++;
    if (xml.indexOf('w:line="' + lineTw + '" w:lineRule="exact"') === -1) spacingMisses++;
    if (line.text && Number(line.weight) >= 700) boldSeen++;
    if (line.text && String(line.style) === 'italic') italicSeen++;
  }
}
assert(sizeMisses === 0, 'every engine size appears as w:sz in half-points',
  totalLines + ' lines checked');
assert(indentMisses === 0, 'every engine x appears as w:ind w:left in twips');
assert(spacingMisses === 0, 'every line advance appears as w:line with lineRule="exact"');
assert(boldSeen > 0 && count(xml, '<w:b/>') >= boldSeen,
  'the first-name lines are bold', boldSeen + ' bold lines expected');
assert(italicSeen > 0 && count(xml, '<w:i/>') >= italicSeen,
  'the company lines are italic', italicSeen + ' italic lines expected');

/* Alignment must travel as an indent, never as Word centring - see js/docx.js. */
assert(xml.indexOf('<w:jc w:val="center"/>') === -1,
  'no w:jc center anywhere: horizontal position is the engine x, not Word centring');
assert(count(xml, '<w:jc w:val="left"/>') === totalLines,
  'every paragraph is explicitly left-aligned', totalLines + ' paragraphs');

/* Same requirement under CENTRE alignment: still indents, still the engine's x. */
var centreXml = D.buildDocumentXml(ROSTER, {}, {
  align: 'center', logo: { enabled: true, wPt: 72, hPt: 72 }, sheetPreset: 'sampleTopLeft'
});
var centreRes = L.layout(ROSTER[0], null, { logo: OPTS.logo, align: 'center' });
var centreIndent = Math.round(centreRes.lines[0].x * 20);
assert(centreXml.indexOf('w:left="' + centreIndent + '"') !== -1,
  'under align:center the x is STILL an indent, taken from the engine',
  'expected w:left="' + centreIndent + '"');
assert(centreXml.indexOf('<w:jc w:val="center"/>') === -1,
  'align:center does not switch to Word centring either');

assert(D.FONT === 'Arial' && xml.indexOf('w:ascii="Arial"') !== -1,
  'the document names Arial (Julia\'s call - Word has no fallback list)');

// =========================================================================
head('3b. the things Word cares about and LibreOffice does not');
// =========================================================================
/*
 * REGRESSION GROUP. The first version of this exporter passed every local check -
 * LibreOffice rendered it at 612x792 with the right grid - and was still wrong in BOTH
 * Word and Google Docs: rows grew and badges spilled onto extra pages. Three causes,
 * none of which LibreOffice cares about, so nothing below can be verified by rendering.
 * It is asserted structurally instead.
 */

/* (a) No settings part => Word does not use current layout rules. It falls back to a
   LEGACY compatibility mode with different line-spacing and row-height behaviour. */
assert(xml.indexOf('<w:cantSplit/>') !== -1, 'rows carry w:cantSplit');
assert(count(xml, '<w:cantSplit/>') === 6,
  'EVERY row carries w:cantSplit, or Word may break a badge across a page boundary',
  count(xml, '<w:cantSplit/>') + ' of 6 rows');
assert(xml.indexOf('<w:cantSplit/><w:trHeight') !== -1,
  'w:cantSplit comes BEFORE w:trHeight, as the schema requires');

/* (b) WordprocessingML is schema-ORDERED. Word responds to a misordered child by
   dropping properties or offering to repair the file; LibreOffice silently accepts it.
   These orders match the sample .docx that Word itself wrote. */
function childOrder(src, parent) {
  var m = src.match(new RegExp('<' + parent + '>([\\s\\S]*?)</' + parent + '>'));
  if (!m) return null;
  var kids = m[1].match(/<(w:[A-Za-z]+)/g) || [];
  return kids.map(function (k) { return k.slice(1); });
}
var tblOrder = childOrder(xml, 'w:tblPr');
assert(tblOrder && tblOrder[0] === 'w:tblW' && tblOrder[1] === 'w:tblLayout' &&
       tblOrder.indexOf('w:tblCellMar') > tblOrder.indexOf('w:tblLayout') &&
       tblOrder[tblOrder.length - 1] === 'w:tblLook',
  'w:tblPr children are in schema order: tblW, tblLayout, tblCellMar, ..., tblLook',
  tblOrder && tblOrder.join(' '));
assert(xml.indexOf('<w:tblBorders>') === -1,
  'no w:tblBorders: an unstyled table has none, and it was in the wrong position');
assert(xml.indexOf('<w:tblLook') !== -1, 'w:tblLook is present, as Word writes it');

var pOrder = childOrder(xml, 'w:pPr');
var iSpacing = pOrder.indexOf('w:spacing');
var iInd = pOrder.indexOf('w:ind');
var iJc = pOrder.indexOf('w:jc');
var iRPr = pOrder.indexOf('w:rPr');
assert(iSpacing === 0 && iInd === 1 && iJc === 2 && iRPr === 3,
  'w:pPr children are in schema order: spacing, ind, jc, rPr', pOrder.slice(0, 4).join(' '));
assert(xml.indexOf('<w:contextualSpacing/>') === -1,
  'no w:contextualSpacing: it is a list feature, and it sat AFTER w:jc in schema-invalid order');

var tcOrder = childOrder(xml, 'w:tcPr');
assert(tcOrder.indexOf('w:tcW') < tcOrder.indexOf('w:tcMar') &&
       tcOrder.indexOf('w:tcMar') < tcOrder.indexOf('w:vAlign'),
  'w:tcPr children are in schema order: tcW, tcMar, vAlign', tcOrder.join(' '));

// =========================================================================
head('4. escaping and hostile field values');
// =========================================================================
var nasty = [{
  id: 'x', first: 'A&B', last: '<script>', company: 'He said "hi"', title: "O'Brien & Sons <Ltd>"
}];
var nastyXml = D.buildDocumentXml(nasty, {}, OPTS);
assert(nastyXml.indexOf('<script>') === -1, 'a literal <script> tag never reaches the markup');
assert(nastyXml.indexOf('&lt;script&gt;') !== -1, 'it is escaped instead');
assert(nastyXml.indexOf('A&amp;B') !== -1, 'a bare ampersand is escaped');
assert(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(nastyXml),
  'no unescaped ampersand survives anywhere in the document');

var ctrl = [{ id: 'c', first: 'Anne', last: 'B ell', company: 'Co', title: 'D' }];
var ctrlXml = D.buildDocumentXml(ctrl, {}, OPTS);
assert(!/[ -]/.test(ctrlXml.replace(/[\r\n]/g, '')),
  'C0 control characters are dropped, not escaped (they are illegal in XML 1.0)');

var unicode = [{ id: 'u', first: 'Zoë', last: '北京', company: 'Café Ünïcode', title: 'GC' }];
var uniXml = D.buildDocumentXml(unicode, {}, OPTS);
assert(uniXml.indexOf('Zo') !== -1 && uniXml.indexOf('GC') !== -1,
  'non-ASCII names pass through as text');

var emptyXml = D.buildDocumentXml([], {}, OPTS);
assert(count(emptyXml, '<w:tbl>') === 1 && count(emptyXml, '<w:tr>') === 3,
  'an empty roster still produces one full blank sheet');
assert(count(emptyXml, '<w:p>') >= 6, 'every empty cell still contains a paragraph (Word requires one)');

// =========================================================================
head('5. pagination');
// =========================================================================
assert(count(xml, 'w:type="page"') === 1,
  'two pages means exactly ONE page break - never a trailing one');
var onePage = D.buildDocumentXml(ROSTER.slice(0, 6), {}, OPTS);
assert(count(onePage, 'w:type="page"') === 0, 'a single full sheet has no page break');
var thirteen = [];
for (var t = 0; t < 13; t++) thirteen.push({ id: 't' + t, first: 'A' + t, last: 'B' + t, company: 'C', title: 'D' });
var threePages = D.buildDocumentXml(thirteen, {}, OPTS);
assert(count(threePages, '<w:tbl>') === 3 && count(threePages, 'w:type="page"') === 2,
  '13 attendees produce 3 tables and 2 breaks');

// =========================================================================
head('6. the package itself');
// =========================================================================
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'badgedocx-'));
var docxPath = path.join(tmp, 'badges.docx');
var pdfPath = path.join(tmp, 'ours.pdf');
var built = false;

function build() {
  return D.exportDocx(ROSTER, {}, OPTS).then(function (blob) {
    return blob.arrayBuffer().then(function (buf) {
      fs.writeFileSync(docxPath, Buffer.from(buf));
      built = true;
      assert(blob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'the Blob carries the Word MIME type');
      assert(fs.statSync(docxPath).size > 2000, 'the file is a plausible size',
        fs.statSync(docxPath).size + ' bytes');
    });
  }).then(function () {
    return globalThis.BadgePdf.exportPdf(ROSTER, {}, OPTS).then(function (b) {
      return b.arrayBuffer().then(function (buf) { fs.writeFileSync(pdfPath, Buffer.from(buf)); });
    });
  });
}

function checkPackage() {
  if (!have('python3')) { skip('package XML validation', 'python3 not on PATH'); return; }
  var py = [
    'import zipfile,sys,xml.dom.minidom as m',
    'z=zipfile.ZipFile(sys.argv[1])',
    'print("BAD" if z.testzip() else "OK")',
    'names=z.namelist(); print(",".join(names))',
    'bad=[]',
    'for n in names:',
    '    try: m.parseString(z.read(n))',
    '    except Exception as e: bad.append(n)',
    'print("XMLBAD:"+",".join(bad) if bad else "XMLOK")'
  ].join('\n');
  var pyPath = path.join(tmp, 'chk.py');
  fs.writeFileSync(pyPath, py);
  var out = child.execSync('python3 ' + JSON.stringify(pyPath) + ' ' + JSON.stringify(docxPath),
    { encoding: 'utf8' }).split('\n');
  assert(out[0] === 'OK', 'the archive passes an independent CRC check');
  var names = out[1].split(',');
  ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
   'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml',
   'docProps/core.xml', 'docProps/app.xml'].forEach(function (need) {
    assert(names.indexOf(need) !== -1, 'the package contains ' + need);
  });
  assert(out[2] === 'XMLOK', 'every part parses as well-formed XML', out[2]);

  /* The compat flag is the whole reason word/settings.xml exists here. Read it back out
     of the package rather than trusting the string constant. */
  var py2 = [
    'import zipfile,sys,re',
    'z=zipfile.ZipFile(sys.argv[1])',
    's=z.read("word/settings.xml").decode("utf-8")',
    'm=re.search(r\'compatibilityMode"[^>]*w:val="(\\d+)"\', s)',
    'print(m.group(1) if m else "NONE")',
    'ct=z.read("[Content_Types].xml").decode("utf-8")',
    'print("settings" if "word/settings.xml" in ct else "NOTDECLARED")',
    'r=z.read("word/_rels/document.xml.rels").decode("utf-8")',
    'print("related" if "settings.xml" in r else "NOTRELATED")'
  ].join('\n');
  var py2Path = path.join(tmp, 'chk2.py');
  fs.writeFileSync(py2Path, py2);
  var o2 = child.execSync('python3 ' + JSON.stringify(py2Path) + ' ' + JSON.stringify(docxPath),
    { encoding: 'utf8' }).split('\n');
  assert(o2[0] === '15',
    'word/settings.xml pins compatibilityMode 15 - without it Word uses LEGACY layout rules',
    'got ' + o2[0]);
  assert(o2[1] === 'settings', 'settings.xml is declared in [Content_Types].xml');
  assert(o2[2] === 'related', 'settings.xml is related from document.xml');
}

function checkRender() {
  if (!have('soffice') && !fs.existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice')) {
    skip('rendered-geometry comparison', 'LibreOffice not found');
    return;
  }
  if (!have('pdftotext')) { skip('rendered-geometry comparison', 'poppler pdftotext not on PATH'); return; }
  var soffice = have('soffice') ? 'soffice' : '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  var outDir = path.join(tmp, 'render');
  try {
    child.execSync(JSON.stringify(soffice) + ' --headless --convert-to pdf --outdir ' +
      JSON.stringify(outDir) + ' ' + JSON.stringify(docxPath), { stdio: 'ignore' });
  } catch (err) {
    assert(false, 'LibreOffice converted the .docx without error', String(err.message).slice(0, 120));
    return;
  }
  var rendered = path.join(outDir, 'badges.pdf');
  if (!fs.existsSync(rendered)) {
    assert(false, 'LibreOffice produced a PDF from the .docx');
    return;
  }
  assert(true, 'LibreOffice opens the .docx and renders it');

  function boxes(pdf) {
    var xmlOut = child.execSync('pdftotext -bbox ' + JSON.stringify(pdf) + ' -', { encoding: 'utf8' });
    var pages = xmlOut.split('<page').slice(1);
    var out = [];
    pages.forEach(function (pg, pi) {
      var re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
      var m;
      while ((m = re.exec(pg))) {
        out.push({ page: pi, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] });
      }
    });
    return out;
  }

  var mine = boxes(rendered);
  var ours = boxes(pdfPath);
  assert(mine.length === ours.length,
    'the .docx renders the SAME number of words as our PDF (nothing re-wrapped)',
    mine.length + ' vs ' + ours.length);

  /* HARD invariant, same as the PDF's: no ink outside its cell, and none in the
     reserved logo corner. This must hold exactly, font differences or not. */
  var CW = S.CELL_W, CH = S.CELL_H, INSET = S.INSET, LG = 72;
  var violations = [];
  mine.forEach(function (w) {
    var col = Math.floor(w.x0 / CW), row = Math.floor(w.y0 / CH);
    var rx = w.x0 - col * CW, ry = w.y0 - row * CH;
    var rx1 = w.x1 - col * CW, ry1 = w.y1 - row * CH;
    if (rx1 > CW + 0.5) violations.push('crosses right cell edge: ' + w.t);
    if (ry1 > CH + 0.5) violations.push('crosses bottom cell edge: ' + w.t);
    if (rx < INSET - 0.5) violations.push('breaks the left inset: ' + w.t);
    if (rx1 > CW - LG + 0.5 && ry1 > CH - LG + 0.5) violations.push('ink in the logo reserve: ' + w.t);
  });
  assert(violations.length === 0,
    'no rendered word leaves its cell, breaks the inset, or enters the logo reserve',
    violations.slice(0, 3).join(' | '));

  /* Positional agreement. Bounds are the MEASURED behaviour (see this file's header):
     Arial vs Inter pulls later words in a line left; Word centres the box where the
     engine centres ink, which sits a few points lower. Generous enough not to be
     brittle across LibreOffice versions, tight enough to catch a real regression. */
  var index = {};
  ours.forEach(function (w) {
    var k = w.page + ' ' + w.t;
    (index[k] = index[k] || []).push(w);
  });
  var dxs = [], dys = [];
  mine.forEach(function (w) {
    var k = w.page + ' ' + w.t;
    if (index[k] && index[k].length === 1) {
      dxs.push(w.x0 - index[k][0].x0);
      dys.push(w.y0 - index[k][0].y0);
    }
  });
  if (!dxs.length) { assert(false, 'some words matched between the two renders'); return; }
  var maxAbs = function (a) { return a.reduce(function (m, v) { return Math.max(m, Math.abs(v)); }, 0); };
  var mean = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
  console.log('         measured: dx mean ' + mean(dxs).toFixed(2) + ' worst ' + maxAbs(dxs).toFixed(2) +
              ' pt | dy mean ' + mean(dys).toFixed(2) + ' worst ' + maxAbs(dys).toFixed(2) + ' pt' +
              '  (' + dxs.length + ' words)');
  assert(maxAbs(dxs) < 16, 'horizontal drift stays under 16 pt (Arial vs Inter within a line)',
    'worst ' + maxAbs(dxs).toFixed(2) + ' pt');
  assert(maxAbs(dys) < 12, 'vertical offset stays under 12 pt (box-centred vs ink-centred)',
    'worst ' + maxAbs(dys).toFixed(2) + ' pt');
  assert(Math.abs(mean(dys)) < 8, 'the vertical offset is a small UNIFORM shift, not a scatter',
    'mean ' + mean(dys).toFixed(2) + ' pt');
}

build().then(function () {
  checkPackage();
  head('7. rendered geometry vs our own PDF of the same roster');
  checkRender();
}).catch(function (err) {
  assert(false, 'building the .docx and the PDF succeeded', String(err && err.message).slice(0, 200));
}).then(function () {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  console.log('\n=== summary ===');
  console.log('  ' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed' +
    (skipped ? ', ' + skipped + ' group(s) skipped' : ''));
  console.log(failed ? '  ' + failed + ' FAILURE(S)' : '  ALL GREEN');
  process.exit(failed ? 1 : 0);
});
