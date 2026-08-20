/*
 * test/preview.test.js — plain node, no framework. Exits non-zero on failure.
 *
 *   node site/test/preview.test.js
 *
 * Covers the half of js/preview.js that does not need a DOM:
 *
 *   1. THE ANTI-DIVERGENCE PROPERTY (the point of this item). BadgePreview.
 *      renderModel() is the single seam between the fit engine and the painted
 *      DOM: it turns each BadgeLayout line into the literal attribute strings
 *      that paintLine() writes and adds nothing of its own. So asserting
 *      renderModel(a, ov) === BadgeLayout.layout(a, ov), property by property,
 *      IS asserting that the rendered geometry equals the engine's — and the same
 *      engine feeds the PDF, so preview and print cannot drift.
 *      The same holds with the third argument (the logo reserve) threaded through,
 *      and a spy on the engine proves the argument is really passed rather than
 *      quietly dropped — without that, every equality check here could pass
 *      vacuously.
 *   2. Page-count maths: ceil(n / 6), minimum 1.
 *   3. Page-index clamping when the attendee count shrinks.
 *   4. Graceful degradation when BadgeLayout / BadgeSpec / BadgeStore are missing
 *      or throwing (including the store methods that arrive later: getLogo,
 *      getSheetPreset).
 *   5. The logo reserve (ADDENDUM 2 C): inches -> points, the reserved rectangle,
 *      the hard invariant that no glyph enters it, and the 144 / 115.2 centres.
 *   6. The sheet preset (ADDENDUM 3): where the 2x3 grid sits on the page, and the
 *      proof that the preset changes NOTHING cell-relative.
 *   7. A source scan for the hard rules (no network calls, no innerHTML, no ES
 *      modules), so a later edit cannot quietly reintroduce them.
 *
 * The DOM-measuring half — real rendered pixel positions, pagination clicks,
 * hostile-name escaping in the live document — lives in test/preview.browser.js
 * and must be run in a browser (test/preview.browser.html). It is deliberately
 * NOT named *.test.js so nobody runs it under node.
 *
 * This suite uses the REAL Inter metrics (fonts/inter-metrics.js is pure and has
 * no I/O), the real js/spec.js and the real js/layout.js — no stubs — because the
 * property under test is exact equality with the shipped engine.
 *
 * ALL FIXTURE NAMES ARE INVENTED. No real person's data appears in this file.
 */
'use strict';

var path = require('path');
var fs = require('fs');

// ---------------------------------------------------------------------------
// Browser-ish global so the classic scripts can assign to `window`.
// There is deliberately NO `global.document`: preview.js must be requirable
// without a DOM, and its DOM half must no-op instead of throwing.
// ---------------------------------------------------------------------------
global.window = global;

var SITE = path.resolve(__dirname, '..');
var FIX = path.join(__dirname, 'fixtures');

require(path.join(SITE, 'fonts', 'inter-metrics.js'));
require(path.join(SITE, 'js', 'spec.js'));
require(path.join(SITE, 'js', 'layout.js'));
require(path.join(SITE, 'js', 'preview.js'));

var S = window.BadgeSpec;
var L = window.BadgeLayout;
var P = window.BadgePreview;

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
var checks = 0;
var failures = [];

function check(name, cond, detail) {
  checks++;
  if (!cond) failures.push({ name: name, detail: detail });
}

function eq(name, got, want) {
  check(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

function throws(name, fn, re) {
  var threw = null;
  try { fn(); } catch (e) { threw = e; }
  check(name, threw !== null && (!re || re.test(threw.message)),
    threw ? 'threw: ' + threw.message : 'did not throw');
}

function noThrow(name, fn) {
  var threw = null;
  var out;
  try { out = fn(); } catch (e) { threw = e; }
  check(name, threw === null, threw ? 'threw: ' + threw.message : '');
  return out;
}

/* Run `fn` with console.warn/error captured, so the degradation tests below can
   assert that a missing neighbour produces a clear warning WITHOUT spraying
   scary-looking output over a passing run. Returns the captured messages. */
function captureLogs(fn) {
  var msgs = [];
  var realWarn = console.warn;
  var realError = console.error;
  console.warn = function () { msgs.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { msgs.push(Array.prototype.join.call(arguments, ' ')); };
  try {
    fn();
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  return msgs;
}

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
}

var six = readFixture('six.json');
var fourteen = readFixture('fourteen.json');
var stress = readFixture('stress.json');

// Extra edge cases, on top of the shipped fixtures. Invented names only.
var edges = [
  { id: 'e1', first: 'Ada', last: '', title: '', company: '' },
  { id: 'e2', first: '', last: 'Okereke', title: 'Counsel', company: '' },
  { id: 'e3', first: '', last: '', title: '', company: '' },
  { id: 'e4', first: 'Jean-Baptiste', last: 'de la Fontaine-Whitmore',
    title: 'Senior Vice President, Deputy General Counsel & Chief Compliance Officer',
    company: 'Kensington Ashworth Pemberton International Holdings Group' },
  { id: 'e5', first: '<img src=x onerror=alert(1)>', last: '</text><script>alert(2)<\/script>',
    title: '"><svg onload=alert(3)>', company: '&lt;b&gt;& Co.' },
  { id: 'e6', first: 'Zoë', last: 'Müller-Ødegård', title: 'Conseillère juridique',
    company: 'Ærø & Ødegård' },
  { id: 'e7', first: '   Padded   ', last: '  Spaces  ', title: '  Multi   space  title ',
    company: '  Trailing  ' }
];

/*
 * IS THIS LINE LEVEL WITH THE RESERVE?
 *
 * One helper, used by every expectation in this file that depends on the answer,
 * so the assertions FOLLOW the rule instead of restating numbers. It mirrors
 * BadgeLayout's intersectsBand():
 *
 *     inkBottom = max(lineTop + advance, baselineY + descenderDepthPt(sizePt))
 *     narrowed  = logo.enabled && inkBottom > bandTop && lineTop < CELL_H
 *
 * The descender term is the fix for the defect this suite surfaced: a line whose
 * ADVANCE box clears the band can still drop ~0.2 pt of descender ink into the
 * reserved corner, so a keep-out has to use the ink extent. Full depth, applied
 * regardless of whether the text happens to contain a descender, because a keep-out
 * wants the worst case. (Optical centring uses half the depth — the expected extent
 * rather than the worst case. Deliberately different numbers for different
 * questions.)
 *
 * If the engine's band test changes again, THIS is the one place to update, and the
 * disagreement will show up as a real failure rather than a stale literal.
 */
function isNarrowed(line, rect) {
  if (!rect) return false;
  var inkBottom = Math.max(
    line.lineTop + line.advance,
    line.baselineY + window.InterMetrics.descenderDepthPt(line.sizePt)
  );
  return inkBottom > rect.y0 + 1e-9 && line.lineTop < S.CELL_H - 1e-9;
}

/* The right edge one line is subject to, given the reserve. */
function spanHiFor(line, rect) {
  var fullHi = S.CELL_W - S.INSET;
  // min(), mirroring the engine: a reserve narrower than the inset must never
  // WIDEN the span past the right inset edge.
  return isNarrowed(line, rect) ? Math.min(S.CELL_W - rect.wPt, fullHi) : fullHi;
}

/*
 * Expected LEFT-alignment geometry, recomputed here from the measured line widths
 * so it is an independent check of the engine rather than an echo of it.
 *
 * ADDENDUM 5: 'left' no longer pins x to the inset. All lines share ONE left edge
 * and the resulting BLOCK is centred in the available span ("centred block,
 * left-aligned text"):
 *     blockWidth = widest emitted line WITH TEXT
 *     spanHi     = the TIGHTEST right edge any inked line is subject to
 *                  (narrowed to CELL_W - logoWpt for a line level with the
 *                   reserve, else CELL_W - INSET)
 *     x          = INSET + max(0, (spanHi - INSET - blockWidth) / 2)
 * It degenerates to x === INSET only when the widest line fills the span.
 *
 * Whether a line is narrowed comes from isNarrowed() above.
 */
function expectedLeftGeometry(lines, logo) {
  var rect = (logo && logo.enabled) ? P.reservedRect(logo) : null;
  var fullHi = S.CELL_W - S.INSET;
  var blockWidth = 0;
  var spanHi = fullHi;
  var anyInk = false;
  var narrowedAny = false;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l.text) continue;              // gap lines carry no ink
    anyInk = true;
    if (l.lineWidth > blockWidth) blockWidth = l.lineWidth;
    if (isNarrowed(l, rect)) narrowedAny = true;
    var hi = spanHiFor(l, rect);
    if (hi < spanHi) spanHi = hi;
  }
  if (!anyInk) return { x: S.INSET, blockWidth: 0, spanHi: fullHi, narrowedAny: false };
  return {
    x: S.INSET + Math.max(0, (spanHi - S.INSET - blockWidth) / 2),
    blockWidth: blockWidth,
    spanHi: spanHi,
    narrowedAny: narrowedAny
  };
}

/* The one x every left-aligned line must share, plus the supporting numbers. */
function assertSharedLeftEdge(tag, lines, logo) {
  var exp = expectedLeftGeometry(lines, logo);
  var xs = {};
  for (var i = 0; i < lines.length; i++) xs[String(lines[i].x)] = true;
  var distinct = Object.keys(xs);

  // THE real invariant: one shared left edge for every emitted line.
  eq(tag + ': all lines share ONE left edge', distinct.length, 1);
  if (distinct.length === 1) {
    check(tag + ': shared x is the centred-block position',
      Math.abs(Number(distinct[0]) - exp.x) < 1e-9,
      'x=' + distinct[0] + ' want ' + exp.x + ' (blockWidth=' + exp.blockWidth +
      ', spanHi=' + exp.spanHi + ')');
    check(tag + ': shared x is at or right of the inset',
      Number(distinct[0]) >= S.INSET - 1e-9, 'x=' + distinct[0]);

    /* Every line's right edge inside ITS OWN span. The block's left edge is placed
       against the TIGHTEST span (so a line level with the reserve cannot intrude),
       but a line that is NOT level with the reserve keeps the full text box and may
       legitimately extend past that tighter edge — which is why this is checked per
       line rather than against the block width. */
    var rect = (logo && logo.enabled) ? P.reservedRect(logo) : null;
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j];
      if (!l.text) continue;
      var narrowed = isNarrowed(l, rect);
      var hi = spanHiFor(l, rect);
      check(tag + ': ' + l.field + ' right edge inside its own span' +
        (narrowed ? ' (narrowed)' : ''),
        l.x + l.lineWidth <= hi + 1e-9,
        'right=' + (l.x + l.lineWidth) + ' must be <= ' + hi);
    }
  }
  return exp;
}

// ===========================================================================
// 1. THE ANTI-DIVERGENCE PROPERTY
// ===========================================================================
/*
 * For each attendee (and each override case), renderModel() must reproduce the
 * engine's line list exactly: same count, same order, and per line the same
 * text / x / baselineY / sizePt / weight / style / lineTop / advance / field.
 * The `attr` map is checked too, because those strings are what the SVG <text>
 * nodes actually receive — checking only the numbers would let a formatting bug
 * (rounding, toFixed, unit suffix) slip into the DOM unnoticed.
 */
var LINE_PROPS = ['text', 'x', 'baselineY', 'sizePt', 'weight', 'style', 'lineTop',
                  'advance', 'field'];
var ATTR_OF = {
  x: 'x', baselineY: 'y', sizePt: 'font-size', weight: 'font-weight',
  style: 'font-style', field: 'data-field'
};

function assertMatchesEngine(label, attendee, override) {
  var engine = L.layout(attendee, override || null);
  var model = P.renderModel(attendee, override || null);

  eq(label + ': ok', model.ok, true);
  eq(label + ': line count', model.lines.length, engine.lines.length);
  eq(label + ': blockHeight', model.blockHeight, engine.blockHeight);
  eq(label + ': fits', model.fits, engine.fits);
  eq(label + ': viewBox is the cell in points', model.viewBox,
     '0 0 ' + S.CELL_W + ' ' + S.CELL_H);
  if (model.lines.length !== engine.lines.length) return;

  for (var i = 0; i < engine.lines.length; i++) {
    var e = engine.lines[i];
    var m = model.lines[i];
    for (var p = 0; p < LINE_PROPS.length; p++) {
      var prop = LINE_PROPS[p];
      var want = prop === 'text'
        ? (e.text === null || e.text === undefined ? '' : String(e.text))
        : e[prop];
      eq(label + ' line ' + i + ' (' + e.field + '): ' + prop, m[prop], want);
    }
    // the literal strings the DOM receives
    var keys = Object.keys(ATTR_OF);
    for (var k = 0; k < keys.length; k++) {
      eq(label + ' line ' + i + ' attr ' + ATTR_OF[keys[k]],
         m.attr[ATTR_OF[keys[k]]], String(e[keys[k]]));
    }
    eq(label + ' line ' + i + ' attr data-x mirrors x', m.attr['data-x'], String(e.x));
    eq(label + ' line ' + i + ' attr data-baseline-y', m.attr['data-baseline-y'],
       String(e.baselineY));
    eq(label + ' line ' + i + ' attr data-line-top', m.attr['data-line-top'],
       String(e.lineTop));
    eq(label + ' line ' + i + ' attr data-advance', m.attr['data-advance'],
       String(e.advance));
    eq(label + ' line ' + i + ' attr data-line-index', m.attr['data-line-index'], String(i));
    // no rounding crept in anywhere
    check(label + ' line ' + i + ': attr x round-trips to the exact number',
      Number(m.attr.x) === e.x, m.attr.x + ' vs ' + e.x);
    check(label + ' line ' + i + ': attr y round-trips to the exact number',
      Number(m.attr.y) === e.baselineY, m.attr.y + ' vs ' + e.baselineY);
    // the gap line is the only empty one, and it is flagged so the DOM can skip it
    eq(label + ' line ' + i + ': empty flag matches the text',
       m.empty, String(e.text === null || e.text === undefined ? '' : e.text) === '');
  }
}

var ALL = six.concat(fourteen.slice(6), stress, edges);
for (var i = 0; i < ALL.length; i++) {
  assertMatchesEngine('1.' + ALL[i].id, ALL[i], null);
}

// with overrides — the delta must be threaded through untouched
var OVERRIDE_CASES = [
  { first: -8 }, { first: 4 }, { last: -6 }, { company: -10, title: -8 },
  { first: 99, last: -99 },      // clamped by the engine, not by the preview
  { first: 0, last: 0, company: 0, title: 0 },
  { bogus: 3 }, { first: NaN }, { first: 'nope' }
];
for (var o = 0; o < OVERRIDE_CASES.length; o++) {
  assertMatchesEngine('1.ov' + o + '.' + six[0].id, six[0], OVERRIDE_CASES[o]);
  assertMatchesEngine('1.ov' + o + '.stress', stress[0], OVERRIDE_CASES[o]);
}

// The preview must never reorder or drop a line, and must never invent one.
(function () {
  /* ADDENDUM 5: a second 8 pt gap line now sits between company and title,
     emitted only when both of those lines exist. */
  var m = P.renderModel(six[0], null);
  var fields = m.lines.map(function (l) { return l.field; });
  eq('1.order: first, last, gap, company, gap, title', fields.join(','),
     'first,last,gap,company,gap,title');
  eq('1.order: exactly two empty (gap) lines',
     m.lines.filter(function (l) { return l.empty; }).length, 2);
  eq('1.order: four VISIBLE lines', m.lines.filter(function (l) { return l.text; }).length, 4);
  /* Gap SIZES are read from BadgeSpec, never hardcoded: Julia is still tuning
     GAP_TITLE_SIZE (it has already gone 8 -> 4), and every expectation below is
     derived from the constants and the emitted lines so that retuning it is a
     no-op for this suite. */
  var gaps = m.lines.filter(function (l) { return l.field === 'gap'; });
  eq('1.order: two gap lines emitted', gaps.length, 2);
  eq('1.order: the name gap is BadgeSpec.GAP_SIZE', gaps[0].sizePt, S.GAP_SIZE);
  eq('1.order: the company->title gap is BadgeSpec.GAP_TITLE_SIZE',
     gaps[1].sizePt, S.GAP_TITLE_SIZE);
  gaps.forEach(function (g, i) {
    check('1.order: gap ' + i + ' advance is ADVANCE_FACTOR x its own size',
      Math.abs(g.advance - S.ADVANCE_FACTOR * g.sizePt) < 1e-9,
      'advance=' + g.advance + ' size=' + g.sizePt);
    eq('1.order: gap ' + i + ' has no text', g.text, '');
  });

  /* Stacking: title sits below company by company's advance plus the title gap.
     Asserted on lineTop, where the gap is unambiguous — the baselines are offset
     by different ascents because the two lines are different sizes. */
  var company = m.lines.filter(function (l) { return l.field === 'company'; }).pop();
  var title = m.lines.filter(function (l) { return l.field === 'title'; })[0];
  var sep = title.baselineY - company.baselineY;
  var titleGap = S.ADVANCE_FACTOR * S.GAP_TITLE_SIZE;
  check('1.order: title stacks below company PLUS the title gap',
    Math.abs((title.lineTop - company.lineTop) - (company.advance + titleGap)) < 1e-9,
    'lineTop delta=' + (title.lineTop - company.lineTop) +
    ' want ' + (company.advance + titleGap));
  check('1.order: baseline separation = advances + the ascent difference',
    Math.abs(sep - (company.advance + titleGap +
      window.InterMetrics.ascentPt(title.sizePt) -
      window.InterMetrics.ascentPt(company.sizePt))) < 1e-9,
    'separation=' + sep);

  /* blockHeight must be exactly the sum of the emitted advances — which is what
     makes it follow any gap retuning automatically. */
  var advSum = m.lines.reduce(function (acc, l) { return acc + l.advance; }, 0);
  check('1.order: blockHeight is the sum of every emitted advance',
    Math.abs(m.blockHeight - advSum) < 1e-9,
    'blockHeight=' + m.blockHeight + ' sum=' + advSum);

  /* And the block is still optically centred in the cell (taller block, same rule). */
  check('1.order: the taller block is still inside the cell',
    m.lines[0].lineTop >= 0 &&
    m.lines[m.lines.length - 1].lineTop + m.lines[m.lines.length - 1].advance <= S.CELL_H,
    'top=' + m.lines[0].lineTop + ' bottom=' +
    (m.lines[m.lines.length - 1].lineTop + m.lines[m.lines.length - 1].advance));

  console.log('  gaps: name ' + S.GAP_SIZE + ' pt, company->title ' +
    S.GAP_TITLE_SIZE + ' pt -> separation ' + (Math.round(sep * 1000) / 1000) +
    ' pt, blockHeight ' + (Math.round(m.blockHeight * 1000) / 1000) + ' pt');

  /* A company with no title (and vice versa) must NOT emit the second gap. */
  var noTitle = P.renderModel({ id: 'nt', first: 'Ada', last: 'Okereke',
                                company: 'Northwind Analytics', title: '' }, null);
  eq('1.order: no title -> only the name gap',
     noTitle.lines.map(function (l) { return l.field; }).join(','),
     'first,last,gap,company');
  var noCompany = P.renderModel({ id: 'nc', first: 'Ada', last: 'Okereke',
                                  company: '', title: 'General Counsel' }, null);
  eq('1.order: no company -> only the name gap',
     noCompany.lines.map(function (l) { return l.field; }).join(','),
     'first,last,gap,title');
})();

// Hostile text must arrive at the DOM byte-for-byte as the engine produced it —
// no escaping, no entity encoding, no stripping (escaping is textContent's job).
(function () {
  var hostile = edges[4];
  var eng = L.layout(hostile, null);
  var mod = P.renderModel(hostile, null);
  var engText = eng.lines.map(function (l) { return String(l.text); }).join(' ');
  var modText = mod.lines.map(function (l) { return l.text; }).join(' ');
  eq('1.hostile: text passed through byte-for-byte', modText, engText);
  check('1.hostile: the un-clipped hostile string survives whole',
    modText.indexOf('</text><script>alert(2)<\/script>') !== -1, modText);
})();

// ===========================================================================
// 2. GEOMETRY INVARIANTS the renderer relies on
// ===========================================================================
/*
 * Split by alignment (ADDENDUM 4). "Inside its own cell" holds under both modes.
 * Centring is asserted ONLY under align:'center'; under the new 'left' default the
 * assertion is instead x === INSET exactly, with the right edge inside the box.
 */
['left', 'center'].forEach(function (align) {
  var worstRight = -Infinity, worstBottom = -Infinity, worstLeft = Infinity;
  var opts = { align: align };
  for (var n = 0; n < ALL.length; n++) {
    var m = P.renderModel(ALL[n], null, opts);
    eq('2.' + align + ': model reports the alignment it was given', m.align, align);
    if (align === 'left' && m.lines.length) {
      assertSharedLeftEdge('2.left.' + ALL[n].id, m.lines, null);
    }
    for (var j = 0; j < m.lines.length; j++) {
      var l = m.lines[j];
      if (l.empty) continue;
      var right = l.x + l.lineWidth;
      if (l.x < worstLeft) worstLeft = l.x;
      if (right > worstRight) worstRight = right;
      if (l.baselineY > worstBottom) worstBottom = l.baselineY;
      check('2.' + align + ': line stays inside its own cell (' +
        ALL[n].id + '/' + l.field + ')',
        l.x >= -1e-9 && right <= S.CELL_W + 1e-9 &&
        l.baselineY >= 0 && l.baselineY <= S.CELL_H,
        'x=' + l.x + ' right=' + right + ' baselineY=' + l.baselineY);

      if (align === 'center') {
        check('2.center: line is horizontally centred (' +
          ALL[n].id + '/' + l.field + ')',
          Math.abs((l.x + l.lineWidth / 2) - S.CELL_W / 2) < 1e-6,
          'centre=' + (l.x + l.lineWidth / 2));
      } else {
        check('2.left: line stays inside the text box (' +
          ALL[n].id + '/' + l.field + ')',
          right <= S.CELL_W - S.INSET + 1e-9,
          'right=' + right + ' must be <= ' + (S.CELL_W - S.INSET));
      }
    }
  }
  check('2.' + align + ': measured extents are sane',
    worstLeft >= 0 && worstRight <= S.CELL_W,
    'left=' + worstLeft + ' right=' + worstRight + ' bottom=' + worstBottom);
  if (align === 'left') {
    check('2.left: no line starts left of the inset', worstLeft >= S.INSET - 1e-9,
      'leftmost x=' + worstLeft);
  }
});

// ===========================================================================
// 3. PAGE COUNT — ceil(n / 6), minimum 1
// ===========================================================================
[[0, 1], [1, 1], [5, 1], [6, 1], [7, 2], [11, 2], [12, 2], [13, 3], [14, 3],
 [18, 3], [19, 4], [600, 100]].forEach(function (pair) {
  eq('3.pageCount(' + pair[0] + ')', P.pageCount(pair[0]), pair[1]);
});
eq('3.pageCount uses BadgeSpec.PER_PAGE', P.pageCount(S.PER_PAGE), 1);
eq('3.pageCount(PER_PAGE + 1)', P.pageCount(S.PER_PAGE + 1), 2);
// garbage still yields a renderable sheet count
[[-3, 1], [NaN, 1], [null, 1], [undefined, 1], ['nope', 1], [Infinity, 1], [2.5, 1]]
  .forEach(function (pair) {
    eq('3.pageCount(' + String(pair[0]) + ') degrades to 1', P.pageCount(pair[0]), pair[1]);
  });
eq('3.pageCount("13") coerces', P.pageCount('13'), 3);

// ===========================================================================
// 4. PAGE-INDEX CLAMPING — never render a blank page from a stale index
// ===========================================================================
// (index, attendeeCount) -> clamped
[[0, 14, 0], [1, 14, 1], [2, 14, 2],
 [2, 13, 2],                 // 13 attendees still has a page 3
 [2, 12, 1],                 // ...12 does not: clamp down one
 [2, 8, 1],                  // the "deleted six rows" case
 [2, 6, 0],
 [2, 1, 0],
 [2, 0, 0],                  // roster emptied entirely
 [5, 6, 0],
 [99, 14, 2],
 [0, 0, 0],
 [-1, 14, 0], [-99, 0, 0],   // negatives
 [1.9, 14, 1], [2.99, 14, 2] // fractional indices floor, then clamp
].forEach(function (t) {
  eq('4.clamp(' + t[0] + ', ' + t[1] + ')', P.clampPageIndex(t[0], t[1]), t[2]);
});
[[NaN, 14], [null, 14], [undefined, 14], ['nope', 14]].forEach(function (t) {
  eq('4.clamp(' + String(t[0]) + ') degrades to 0', P.clampPageIndex(t[0], t[1]), 0);
});
eq('4.clamp("2", 14) coerces', P.clampPageIndex('2', 14), 2);
// the clamp is idempotent and always in range
(function () {
  for (var count = 0; count <= 20; count++) {
    for (var idx = 0; idx <= 8; idx++) {
      var c = P.clampPageIndex(idx, count);
      check('4.clamp in range for count=' + count + ' idx=' + idx,
        c >= 0 && c <= P.pageCount(count) - 1, 'got ' + c);
      eq('4.clamp idempotent for count=' + count + ' idx=' + idx,
        P.clampPageIndex(c, count), c);
    }
  }
})();

// ===========================================================================
// 5. SCALE / pt -> px
// ===========================================================================
eq('5.SCALE is a single number', typeof P.SCALE, 'number');
eq('5.ptToPx(0)', P.ptToPx(0), 0);
eq('5.ptToPx(288)', P.ptToPx(288), 288 * P.SCALE);
eq('5.sheet width px', P.sheetSizePx().w, S.PAGE_W * P.SCALE);
eq('5.sheet height px', P.sheetSizePx().h, S.PAGE_H * P.SCALE);
check('5.sheet aspect ratio is exactly 612:792',
  Math.abs((P.sheetSizePx().w / P.sheetSizePx().h) - (612 / 792)) < 1e-12,
  String(P.sheetSizePx().w / P.sheetSizePx().h));
check('5.sheet is a comfortable on-screen size (600-900 px wide)',
  P.sheetSizePx().w >= 600 && P.sheetSizePx().w <= 900, String(P.sheetSizePx().w));

// ===========================================================================
// 6. GRACEFUL DEGRADATION — a missing neighbour warns, never throws
// ===========================================================================
eq('6.null attendee -> empty cell, not an error', P.renderModel(null, null).reason, 'empty-cell');
eq('6.null attendee -> ok:false', P.renderModel(null, null).ok, false);
eq('6.null attendee -> no lines', P.renderModel(null, null).lines.length, 0);

(function () {
  var logs = captureLogs(function () {
    noThrow('6.mount() without a document does not throw', function () { P.mount(); });
    noThrow('6.render() without a document does not throw', function () { P.render(); });
    noThrow('6.schedule() without rAF does not throw', function () { P.schedule(); });
    noThrow('6.getState() without a store does not throw', function () { return P.getState(); });
  });
  eq('6.getState() with no store reports an empty roster', P.getState().attendeeCount, 0);
  eq('6.getState() with no store reports one page', P.getState().pages, 1);
  check('6.mount() with no document warns clearly',
    logs.some(function (m) { return /no document/.test(m); }), logs.join(' | '));
  check('6.missing store warns clearly and names the file',
    logs.some(function (m) { return /BadgeStore is missing/.test(m) && /store\.js/.test(m); }),
    logs.join(' | '));
  /* getState() asks for the logo setting, so this is where the "no getLogo()"
     warning first fires. warnOnce dedupes it for the rest of the process, which is
     why the assertion lives here and not in section 7b. */
  check('6.missing getLogo() warns clearly and says the reserve is OFF',
    logs.some(function (m) { return /getLogo/.test(m) && /OFF/.test(m); }), logs.join(' | '));
  check('6.missing getAlign() warns clearly and names the fallback',
    logs.some(function (m) { return /getAlign/.test(m) && /left/.test(m); }), logs.join(' | '));
})();

(function () {
  var realLayout = window.BadgeLayout;
  var m1, m2, m3;

  var logs = captureLogs(function () {
    window.BadgeLayout = undefined;
    m1 = noThrow('6.no engine: renderModel does not throw', function () {
      return P.renderModel(six[0], null);
    });

    window.BadgeLayout = { layout: function () { throw new Error('boom'); } };
    m2 = noThrow('6.throwing engine: renderModel does not throw', function () {
      return P.renderModel(six[0], null);
    });

    window.BadgeLayout = { layout: function () { return {}; } };
    m3 = noThrow('6.engine returning junk: renderModel does not throw', function () {
      return P.renderModel(six[0], null);
    });
  });

  eq('6.no engine: ok is false', m1.ok, false);
  eq('6.no engine: reason', m1.reason, 'no-engine');
  eq('6.no engine: no guessed text', m1.lines.length, 0);
  eq('6.throwing engine: reason', m2.reason, 'layout-error');
  eq('6.throwing engine: no lines', m2.lines.length, 0);
  eq('6.engine returning junk: no lines invented', m3.lines.length, 0);
  check('6.missing engine warns clearly and names the file',
    logs.some(function (m) { return /BadgeLayout is missing/.test(m) && /layout\.js/.test(m); }),
    logs.join(' | '));
  check('6.missing engine warning promises no guessed text',
    logs.some(function (m) { return /No text is guessed/.test(m); }), logs.join(' | '));
  check('6.throwing engine warning carries the underlying message',
    logs.some(function (m) { return /boom/.test(m); }), logs.join(' | '));

  window.BadgeLayout = realLayout;
  eq('6.engine restored', P.renderModel(six[0], null).ok, true);
})();

// A missing BadgeSpec must fall back to the spec constants, not to nothing.
(function () {
  var realSpec = window.BadgeSpec;
  window.BadgeSpec = undefined;
  eq('6.no spec: pageCount still uses 6 per page', P.pageCount(7), 2);
  eq('6.no spec: clamp still works', P.clampPageIndex(5, 6), 0);
  eq('6.no spec: sheet size falls back to 612x792 pt',
     P.sheetSizePx().w + 'x' + P.sheetSizePx().h,
     (612 * P.SCALE) + 'x' + (792 * P.SCALE));
  window.BadgeSpec = realSpec;
  eq('6.spec restored', P.pageCount(7), 2);
})();

// The engine itself must still be the one refusing to guess widths.
throws('6.engine without metrics throws rather than guessing', function () {
  var realMetrics = window.InterMetrics;
  try {
    window.InterMetrics = undefined;
    L.layout(six[0], null);
  } finally {
    window.InterMetrics = realMetrics;
  }
}, /InterMetrics/);

// ===========================================================================
// 7. LOGO RESERVE (ADDENDUM 2 section C)
// ===========================================================================
/*
 * The preview's job here is narrow: read the global setting (inches, from the
 * store), convert to points, pass it to the engine as the third argument on every
 * call, and draw the reserved rectangle as a screen-only guide. All the narrowing
 * and re-centering belongs to the engine.
 *
 * Two kinds of assertion below:
 *   - MINE, always run: opts is normalised correctly, reaches layout() untouched,
 *     and renderModel still reproduces the engine's output exactly with it.
 *   - THE ENGINE'S, auto-gated: the hard invariant (no glyph inside the reserve)
 *     and the 144 / 115.2 centres. Those can only hold once the engine honours the
 *     third argument. The gate below detects that at runtime, so this file reports
 *     PENDING instead of a false pass while the engine item is still in flight,
 *     and starts enforcing them the moment it lands. Nothing to edit here.
 */
var IN = 72;

/* Does the shipped engine honour opts.logo yet? Probe with a reserve tall enough
   (1.5 in => band y >= 108) that the lower lines must be affected if it does. */
function engineHonoursLogo() {
  var probe = { id: 'probe', first: 'Annelise', last: 'Vandermolen',
                company: 'Northwind Analytics Group', title: 'Deputy General Counsel' };
  var off = L.layout(probe, null);
  var on = L.layout(probe, null, { logo: { enabled: true, wPt: 1.5 * IN, hPt: 1.5 * IN } });
  if (!off.lines.length || off.lines.length !== on.lines.length) return true;
  for (var i = 0; i < on.lines.length; i++) {
    if (on.lines[i].x !== off.lines[i].x) return true;
  }
  return false;
}
var LOGO_ENGINE = engineHonoursLogo();
var pending = [];
function gated(name, cond, detail) {
  if (LOGO_ENGINE) return check(name, cond, detail);
  pending.push(name);
  return true;
}

// ---- 7a. layoutOpts(): inches already converted, always finite -------------
(function () {
  var o = P.layoutOpts({ enabled: true, wPt: 72, hPt: 72 });
  eq('7a.layoutOpts wraps in a logo key', typeof o.logo, 'object');
  eq('7a.layoutOpts enabled', o.logo.enabled, true);
  eq('7a.layoutOpts wPt', o.logo.wPt, 72);
  eq('7a.layoutOpts hPt', o.logo.hPt, 72);
  eq('7a.layoutOpts enabled is strict boolean true',
     P.layoutOpts({ enabled: 'yes', wPt: 72, hPt: 72 }).logo.enabled, false);
  eq('7a.layoutOpts enabled=1 is not true',
     P.layoutOpts({ enabled: 1, wPt: 72, hPt: 72 }).logo.enabled, false);
  // the engine must never receive undefined/NaN sizes
  [undefined, null, NaN, -5, 'wide', Infinity].forEach(function (bad) {
    var got = P.layoutOpts({ enabled: true, wPt: bad, hPt: bad }).logo;
    check('7a.layoutOpts sanitises wPt=' + String(bad),
      isFinite(got.wPt) && got.wPt >= 0, String(got.wPt));
    check('7a.layoutOpts sanitises hPt=' + String(bad),
      isFinite(got.hPt) && got.hPt >= 0, String(got.hPt));
  });
})();

// ---- 7b. logoPt(): reads the store's INCHES, hands back POINTS -------------
(function () {
  var realStore = window.BadgeStore;

  /* (The "no getLogo()" warning itself is asserted in section 6, where it first
     fires — warnOnce deliberately does not repeat it here.) */
  captureLogs(function () {
    window.BadgeStore = undefined;
    eq('7b.no store at all -> reserve is OFF', P.logoPt().enabled, false);
    window.BadgeStore = { getAttendees: function () { return []; } }; // no getLogo
    eq('7b.store without getLogo() -> OFF', P.logoPt().enabled, false);
  });

  function withLogo(cfg) {
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getLogo: function () { return cfg; }
    };
    return P.logoPt();
  }

  eq('7b.1 in x 1 in -> 72 x 72 pt', withLogo({ enabled: true, wIn: 1, hIn: 1 }).wPt, 72);
  eq('7b.1 in height -> 72 pt', withLogo({ enabled: true, wIn: 1, hIn: 1 }).hPt, 72);
  eq('7b.enabled passes through', withLogo({ enabled: true, wIn: 1, hIn: 1 }).enabled, true);
  eq('7b.disabled passes through', withLogo({ enabled: false, wIn: 1, hIn: 1 }).enabled, false);
  eq('7b.0.5 in -> 36 pt', withLogo({ enabled: true, wIn: 0.5, hIn: 0.5 }).wPt, 36);
  eq('7b.1.5 in -> 108 pt', withLogo({ enabled: true, wIn: 1.5, hIn: 1.5 }).hPt, 108);
  eq('7b.2.75 in -> 198 pt', withLogo({ enabled: true, wIn: 2.75, hIn: 1 }).wPt, 198);
  // defensive re-validation: the store clamps, but so do we
  eq('7b.9 in clamps to 4 in (288 pt)', withLogo({ enabled: true, wIn: 9, hIn: 9 }).wPt, 288);
  eq('7b.negative falls back to the 1 in default',
     withLogo({ enabled: true, wIn: -3, hIn: -3 }).wPt, 72);
  eq('7b.NaN falls back to the 1 in default',
     withLogo({ enabled: true, wIn: NaN, hIn: NaN }).hPt, 72);
  eq('7b.string falls back to the 1 in default',
     withLogo({ enabled: true, wIn: 'big', hIn: 'big' }).wPt, 72);
  eq('7b."1.5" coerces', withLogo({ enabled: true, wIn: '1.5', hIn: '1.5' }).wPt, 108);
  eq('7b.enabled must be strictly true',
     withLogo({ enabled: 'yes', wIn: 1, hIn: 1 }).enabled, false);
  eq('7b.junk config -> OFF', withLogo(null).enabled, false);
  eq('7b.non-object config -> OFF', withLogo('nope').enabled, false);
  captureLogs(function () {
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getLogo: function () { throw new Error('storage exploded'); }
    };
    eq('7b.throwing getLogo() -> OFF, no crash', P.logoPt().enabled, false);
  });

  window.BadgeStore = realStore;
})();

// ---- 7c. reservedRect(): cell-relative, from the RAW cell edge -------------
(function () {
  eq('7c.disabled -> null', P.reservedRect({ enabled: false, wPt: 72, hPt: 72 }), null);
  var r = P.reservedRect({ enabled: true, wPt: 72, hPt: 72 });
  eq('7c.1 in x0 = 288 - 72', r.x0, 216);
  eq('7c.1 in y0 = 216 - 72', r.y0, 144);
  eq('7c.1 in x1 is the raw cell edge', r.x1, 288);
  eq('7c.1 in y1 is the raw cell edge', r.y1, 216);
  eq('7c.1 in width', r.wPt, 72);
  eq('7c.1 in height', r.hPt, 72);
  var r2 = P.reservedRect({ enabled: true, wPt: 0.5 * IN, hPt: 1.5 * IN });
  eq('7c.0.5 x 1.5 in x0', r2.x0, 288 - 36);
  eq('7c.0.5 x 1.5 in y0', r2.y0, 216 - 108);
  eq('7c.zero size -> null (nothing reserved)',
     P.reservedRect({ enabled: true, wPt: 0, hPt: 0 }), null);
  var big = P.reservedRect({ enabled: true, wPt: 999, hPt: 999 });
  check('7c.oversized reserve clamps to the cell',
    big.x0 === 0 && big.y0 === 0 && big.x1 === 288 && big.y1 === 216,
    JSON.stringify(big));
})();

// ---- 7d. opts REALLY reaches layout() (spy on the engine) ------------------
/* Without this, every equality assertion here would pass vacuously if
   renderModel silently dropped its third argument. */
(function () {
  var realLayout = window.BadgeLayout;
  var seen = [];
  window.BadgeLayout = {
    layout: function (a, ov, opts) {
      seen.push({ a: a, ov: ov, opts: opts, argc: arguments.length });
      return realLayout.layout(a, ov, opts);
    }
  };

  P.renderModel(six[0], null, { logo: { enabled: true, wPt: 72, hPt: 72 } });
  eq('7d.layout() called once', seen.length, 1);
  eq('7d.layout() got three arguments', seen[0].argc, 3);
  check('7d.third argument is present', !!seen[0].opts, JSON.stringify(seen[0].opts));
  eq('7d.opts.logo.enabled threaded', seen[0].opts.logo.enabled, true);
  eq('7d.opts.logo.wPt threaded', seen[0].opts.logo.wPt, 72);
  eq('7d.opts.logo.hPt threaded', seen[0].opts.logo.hPt, 72);

  seen.length = 0;
  P.renderModel(six[0], { first: -2 }, { logo: { enabled: true, wPt: 108, hPt: 36 } });
  eq('7d.override still threaded alongside opts', seen[0].ov.first, -2);
  eq('7d.custom wPt threaded', seen[0].opts.logo.wPt, 108);
  eq('7d.custom hPt threaded', seen[0].opts.logo.hPt, 36);

  seen.length = 0;
  P.renderModel(six[0], null, null);
  eq('7d.opts omitted still passes an explicit disabled reserve',
     seen[0].opts.logo.enabled, false);
  check('7d.disabled reserve still carries finite sizes',
    isFinite(seen[0].opts.logo.wPt) && isFinite(seen[0].opts.logo.hPt),
    JSON.stringify(seen[0].opts));

  /* renderModel must stay PURE: it must never consult the store for the setting. */
  seen.length = 0;
  var realStore = window.BadgeStore;
  window.BadgeStore = {
    getAttendees: function () { return []; },
    getLogo: function () { return { enabled: true, wIn: 4, hIn: 4 }; }
  };
  P.renderModel(six[0], null, { logo: { enabled: false, wPt: 72, hPt: 72 } });
  eq('7d.renderModel ignores the store and obeys its argument',
     seen[0].opts.logo.enabled, false);
  window.BadgeStore = realStore;

  window.BadgeLayout = realLayout;
})();

// ---- 7e. the anti-divergence property, WITH the reserve on ----------------
var LOGO_CASES = [
  { label: 'off', logo: { enabled: false, wPt: 1 * IN, hPt: 1 * IN } },
  { label: '1x1in', logo: { enabled: true, wPt: 1 * IN, hPt: 1 * IN } },
  { label: '0.5x0.5in', logo: { enabled: true, wPt: 0.5 * IN, hPt: 0.5 * IN } },
  { label: '1.5x1.5in', logo: { enabled: true, wPt: 1.5 * IN, hPt: 1.5 * IN } },
  { label: '2x0.75in', logo: { enabled: true, wPt: 2 * IN, hPt: 0.75 * IN } },
  { label: '1x3in-tall', logo: { enabled: true, wPt: 1 * IN, hPt: 3 * IN } }
];

function assertMatchesEngineWithOpts(label, attendee, override, opts) {
  var engine = L.layout(attendee, override || null, opts);
  var model = P.renderModel(attendee, override || null, opts);
  eq(label + ': line count', model.lines.length, engine.lines.length);
  if (model.lines.length !== engine.lines.length) return;
  for (var i = 0; i < engine.lines.length; i++) {
    var e = engine.lines[i];
    var m = model.lines[i];
    for (var p = 0; p < LINE_PROPS.length; p++) {
      var prop = LINE_PROPS[p];
      var want = prop === 'text'
        ? (e.text === null || e.text === undefined ? '' : String(e.text))
        : e[prop];
      eq(label + ' line ' + i + ' (' + e.field + '): ' + prop, m[prop], want);
    }
    eq(label + ' line ' + i + ': attr x', m.attr.x, String(e.x));
    eq(label + ' line ' + i + ': attr y', m.attr.y, String(e.baselineY));
    eq(label + ' line ' + i + ': attr font-size', m.attr['font-size'], String(e.sizePt));
    check(label + ' line ' + i + ': attr x round-trips exactly',
      Number(m.attr.x) === e.x, m.attr.x + ' vs ' + e.x);
  }
}

/* Every logo case x every alignment: the engine-equality property must hold for
   all of them, and must be alignment-agnostic. */
LOGO_CASES.forEach(function (c) {
  ['left', 'center'].forEach(function (align) {
    var opts = { logo: c.logo, align: align };
    var tag = '7e.' + c.label + '.' + align;
    six.concat(stress, edges.slice(3, 5)).forEach(function (a) {
      assertMatchesEngineWithOpts(tag + '.' + a.id, a, null, opts);
    });
    assertMatchesEngineWithOpts(tag + '.ov', six[0], { company: -4 }, opts);
  });
});

// ---- 7f. the model exposes the reserve for the guide ----------------------
(function () {
  var m = P.renderModel(six[0], null, { logo: { enabled: true, wPt: 72, hPt: 72 } });
  check('7f.model carries the reserve rect for the guide', !!m.reserve, JSON.stringify(m.reserve));
  eq('7f.reserve x0', m.reserve.x0, 216);
  eq('7f.reserve y0', m.reserve.y0, 144);
  eq('7f.no reserve when disabled',
     P.renderModel(six[0], null, { logo: { enabled: false, wPt: 72, hPt: 72 } }).reserve, null);
  eq('7f.no reserve when opts omitted', P.renderModel(six[0], null).reserve, null);
  /* An empty cell still reports the reserve, because the pre-printed logo is on
     every badge of the stock whether we put a name on it or not. */
  check('7f.empty cell still reports the reserve',
    !!P.renderModel(null, null, { logo: { enabled: true, wPt: 72, hPt: 72 } }).reserve, '');
})();

// ---- 7g. THE HARD INVARIANT + the expected centres (engine-gated) ---------
(function () {
  /* The 144 / 115.2 centres are a CENTRED-alignment property, so ask for that
     mode explicitly rather than inheriting whatever the default happens to be. */
  var opts = { logo: { enabled: true, wPt: 1 * IN, hPt: 1 * IN }, align: 'center' };
  var rect = P.reservedRect(opts.logo);
  var narrowCentre = (S.INSET + (S.CELL_W - opts.logo.wPt)) / 2; // 115.2 for 1 in
  var fullCentre = S.CELL_W / 2;                                  // 144
  var observed = [];
  var intersections = 0;

  six.concat(stress, edges.slice(3, 5)).forEach(function (a) {
    var m = P.renderModel(a, null, opts);
    m.lines.forEach(function (l) {
      if (l.empty) return;
      /* Derived from isNarrowed(), the same ink-extent rule the engine uses — so
         this expectation tracks the rule rather than pinning a number. A line whose
         advance box clears the band but whose descender ink does not IS narrowed,
         and therefore recentres to 115.2. */
      var affected = isNarrowed(l, rect);
      var inkBottom = Math.max(l.lineTop + l.advance,
        l.baselineY + window.InterMetrics.descenderDepthPt(l.sizePt));
      var right = l.x + l.lineWidth;
      var centre = l.x + l.lineWidth / 2;

      // HARD INVARIANT: no glyph inside the reserved rectangle.
      if (right > rect.x0 + 1e-9 && affected) intersections++;
      gated('7g.no glyph inside the reserve (' + a.id + '/' + l.field + ')',
        !(affected && right > rect.x0 + 1e-9),
        'right=' + right + ' must be <= ' + rect.x0 + ' (ink bottom ' +
        inkBottom.toFixed(3) + ' vs band top ' + rect.y0 + ')');

      // and the centre rule that produces it
      var wantCentre = affected ? narrowCentre : fullCentre;
      gated('7g.centre follows the band rule (' + a.id + '/' + l.field +
            (affected ? ', level with the reserve' : ', clear') + ')',
        Math.abs(centre - wantCentre) < 1e-6,
        'centre=' + centre + ' want=' + wantCentre + ' (ink bottom ' +
        inkBottom.toFixed(3) + ' vs band top ' + rect.y0 + ')');

      if (a.id === 'f1' || a.id === 'f6' || a.id === 'f5') {
        observed.push({ id: a.id, field: l.field, centre: Math.round(centre * 1000) / 1000,
                        affected: affected, right: Math.round(right * 1000) / 1000,
                        inkBottom: Math.round(inkBottom * 1000) / 1000,
                        advBottom: Math.round((l.lineTop + l.advance) * 1000) / 1000 });
      }
    });
  });

  // Always reported, gated or not — these are the numbers the coordinator asked for.
  console.log('  logo 1x1in observed centres (144 = full width, ' + narrowCentre +
    ' = narrowed):');
  observed.forEach(function (o) {
    console.log('    ' + o.id + '/' + o.field + ': centre=' + o.centre +
      ' right=' + o.right + ' advBottom=' + o.advBottom + ' inkBottom=' + o.inkBottom +
      (o.affected ? '  [level with the reserve]' : ''));
  });
  if (!LOGO_ENGINE) {
    console.log('    (engine does not honour opts.logo yet — ' + intersections +
      ' line(s) currently overlap the reserve)');
  }
})();

/* The same hard invariant under LEFT alignment: a left-flush line still may not
   run into the reserve, so its right edge must clear x0 whenever its box meets the
   reserved band. x itself stays on the inset. */
(function () {
  var opts = { logo: { enabled: true, wPt: 1 * IN, hPt: 1 * IN }, align: 'left' };
  var rect = P.reservedRect(opts.logo);
  var sample = null;
  six.concat(stress, edges.slice(3, 5)).forEach(function (a) {
    var m = P.renderModel(a, null, opts);
    /* One shared left edge, at the centred-block position for the span the
       reserve leaves. Not the inset — see ADDENDUM 5. */
    var exp = assertSharedLeftEdge('7g.left.' + a.id, m.lines, opts.logo);
    if (a.id === 'f1') sample = exp;
    m.lines.forEach(function (l) {
      if (l.empty) return;
      var affected = isNarrowed(l, rect);
      gated('7g.left: no glyph inside the reserve (' + a.id + '/' + l.field + ')',
        !(affected && (l.x + l.lineWidth) > rect.x0 + 1e-9),
        'right=' + (l.x + l.lineWidth) + ' must be <= ' + rect.x0);
    });
  });
  if (sample) {
    console.log('  align:left + 1x1in reserve -> shared x ' +
      (Math.round(sample.x * 1000) / 1000) + ' pt (blockWidth ' +
      (Math.round(sample.blockWidth * 1000) / 1000) + ', spanHi ' + sample.spanHi + ')');
  }
})();

// ===========================================================================
// 8. SHEET PRESET (ADDENDUM 3) — where the 2x3 grid sits on the page
// ===========================================================================
/*
 * A sheet-level TRANSLATION and nothing else. Two things must hold:
 *   - the six cells land on the right sheet coordinates for each preset, and the
 *     Avery block fits the page exactly (18 + 576 + 18 = 612, 72 + 648 + 72 = 792);
 *   - NOTHING cell-relative changes. renderModel() output must be byte-identical
 *     under both presets, because layout() is never told which one is active. That
 *     second property is the one that would catch the preset leaking into the fit.
 */
var EXPECTED_ORIGINS = {
  sampleTopLeft: [[0, 0], [288, 0], [0, 216], [288, 216], [0, 432], [288, 432]],
  avery:         [[18, 72], [306, 72], [18, 288], [306, 288], [18, 504], [306, 504]]
};

Object.keys(EXPECTED_ORIGINS).forEach(function (key) {
  EXPECTED_ORIGINS[key].forEach(function (want, i) {
    var got = P.cellOrigin(i, key);
    eq('8.' + key + ' cell ' + i + ' x', got.x, want[0]);
    eq('8.' + key + ' cell ' + i + ' y', got.y, want[1]);
  });
});

// The block must fit the page exactly — an off-by-one here misaligns every badge.
(function () {
  Object.keys(EXPECTED_ORIGINS).forEach(function (key) {
    var first = P.cellOrigin(0, key);
    var last = P.cellOrigin(5, key);
    var right = last.x + S.CELL_W;
    var bottom = last.y + S.CELL_H;
    var marginR = S.PAGE_W - right;
    var marginB = S.PAGE_H - bottom;
    check('8.' + key + ': block stays on the page',
      first.x >= 0 && first.y >= 0 && right <= S.PAGE_W && bottom <= S.PAGE_H,
      'x0=' + first.x + ' y0=' + first.y + ' right=' + right + ' bottom=' + bottom);
    if (key === 'avery') {
      eq('8.avery: 18 + 576 + 18 = 612 across', first.x + 2 * S.CELL_W + marginR, S.PAGE_W);
      eq('8.avery: 72 + 648 + 72 = 792 down', first.y + 3 * S.CELL_H + marginB, S.PAGE_H);
      eq('8.avery: left margin', first.x, 18);
      eq('8.avery: right margin equals the left', marginR, 18);
      eq('8.avery: top margin', first.y, 72);
      eq('8.avery: bottom margin equals the top', marginB, 72);
      check('8.avery: margins are symmetric', marginR === first.x && marginB === first.y,
        'L=' + first.x + ' R=' + marginR + ' T=' + first.y + ' B=' + marginB);
    } else {
      eq('8.sampleTopLeft: leftover right column is 36 pt', marginR, 36);
      eq('8.sampleTopLeft: leftover bottom band is 144 pt', marginB, 144);
    }
  });
})();

// The Avery grid is exactly the sample grid translated by (18, 72).
(function () {
  for (var i = 0; i < 6; i++) {
    var a = P.cellOrigin(i, 'sampleTopLeft');
    var b = P.cellOrigin(i, 'avery');
    eq('8.cell ' + i + ' shifts by exactly 18 pt in x', b.x - a.x, 18);
    eq('8.cell ' + i + ' shifts by exactly 72 pt in y', b.y - a.y, 72);
  }
  eq('8.at SCALE the shift is 22.5 px across', P.ptToPx(18), 22.5);
  eq('8.at SCALE the shift is 90 px down', P.ptToPx(72), 90);
})();

// Cell SIZE never changes with the preset.
(function () {
  ['sampleTopLeft', 'avery'].forEach(function (key) {
    var c0 = P.cellOrigin(0, key), c1 = P.cellOrigin(1, key), c2 = P.cellOrigin(2, key);
    eq('8.' + key + ': column pitch is still 288', c1.x - c0.x, S.CELL_W);
    eq('8.' + key + ': row pitch is still 216', c2.y - c0.y, S.CELL_H);
  });
})();

// Unknown / missing keys fall back to the default rather than moving every badge.
(function () {
  var def = EXPECTED_ORIGINS[S.SHEET_PRESET_DEFAULT || 'sampleTopLeft'];
  [undefined, null, '', 'AVERY', 'avery ', 'letter', 42, {}, []].forEach(function (bad) {
    var got = P.cellOrigin(0, bad);
    check('8.cellOrigin falls back for preset ' + JSON.stringify(bad),
      got.x === def[0][0] && got.y === def[0][1], JSON.stringify(got));
  });
  eq('8.default preset key', S.SHEET_PRESET_DEFAULT, 'sampleTopLeft');
})();

// sheetPresetKey(): read from the store, guarded.
(function () {
  var realStore = window.BadgeStore;
  captureLogs(function () {
    window.BadgeStore = undefined;
    eq('8.no store -> default preset', P.sheetPresetKey(), 'sampleTopLeft');
    window.BadgeStore = { getAttendees: function () { return []; } };
    eq('8.store without getSheetPreset() -> default', P.sheetPresetKey(), 'sampleTopLeft');

    function withPreset(v) {
      window.BadgeStore = {
        getAttendees: function () { return []; },
        getSheetPreset: function () { return v; }
      };
      return P.sheetPresetKey();
    }
    eq('8.store says avery', withPreset('avery'), 'avery');
    eq('8.store says sampleTopLeft', withPreset('sampleTopLeft'), 'sampleTopLeft');
    eq('8.store says nonsense -> default', withPreset('a4-labels'), 'sampleTopLeft');
    eq('8.store says a number -> default', withPreset(7), 'sampleTopLeft');
    eq('8.store says null -> default', withPreset(null), 'sampleTopLeft');
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getSheetPreset: function () { throw new Error('nope'); }
    };
    eq('8.throwing getSheetPreset() -> default, no crash', P.sheetPresetKey(), 'sampleTopLeft');
  });
  window.BadgeStore = realStore;
})();

// THE IMPORTANT ONE: the preset must not touch anything cell-relative.
(function () {
  var opts = { logo: { enabled: true, wPt: 72, hPt: 72 } };
  var realStore = window.BadgeStore;
  function modelUnder(presetKey, attendee, o) {
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getSheetPreset: function () { return presetKey; }
    };
    return JSON.stringify(P.renderModel(attendee, null, o));
  }
  captureLogs(function () {
    six.concat(stress).forEach(function (a) {
      [null, opts].forEach(function (o, oi) {
        eq('8.renderModel is preset-independent (' + a.id + ', logo ' + (oi ? 'on' : 'off') + ')',
           modelUnder('avery', a, o), modelUnder('sampleTopLeft', a, o));
      });
    });
  });
  window.BadgeStore = realStore;
})();

// ===========================================================================
// 9. TEXT ALIGNMENT (ADDENDUM 4) — sheet-wide 'left' (default) or 'center'
// ===========================================================================
/*
 * Alignment rides in the SAME opts object as the logo reserve. The preview reads
 * it, normalises it, and passes it on; the engine applies it. So the checks here
 * are: the reader guards correctly, the value really reaches layout(), the
 * engine-equality property holds under BOTH modes, and — the important one —
 * switching alignment changes ONLY x. If anything else moves, alignment has leaked
 * into the fit loop.
 */
var ALIGN_ENGINE = (function () {
  var probe = { id: 'ap', first: 'Annelise', last: 'Vandermolen',
                company: 'Northwind Analytics', title: 'Deputy General Counsel' };
  var l = L.layout(probe, null, { align: 'left' });
  var c = L.layout(probe, null, { align: 'center' });
  for (var i = 0; i < l.lines.length; i++) {
    if (l.lines[i].x !== c.lines[i].x) return true;
  }
  return false;
})();
var alignPending = [];
function alignGated(name, cond, detail) {
  if (ALIGN_ENGINE) return check(name, cond, detail);
  alignPending.push(name);
  return true;
}

// ---- 9a. the constants live in the spec ------------------------------------
eq('9a.BadgeSpec.ALIGN_DEFAULT is left', S.ALIGN_DEFAULT, 'left');
check('9a.BadgeSpec.ALIGNS lists exactly left and center',
  S.ALIGNS.length === 2 && S.ALIGNS.indexOf('left') !== -1 &&
  S.ALIGNS.indexOf('center') !== -1, JSON.stringify(S.ALIGNS));

// ---- 9b. normalizeAlign(): known values pass, everything else defaults -----
eq('9b.left passes', P.normalizeAlign('left'), 'left');
eq('9b.center passes', P.normalizeAlign('center'), 'center');
captureLogs(function () {
  [undefined, null, '', 'LEFT', 'Center', 'centre', 'right', 'justify', 0, 1, {}, []]
    .forEach(function (bad) {
      eq('9b.' + JSON.stringify(bad) + ' falls back to left',
         P.normalizeAlign(bad), 'left');
    });
});

// ---- 9c. alignMode(): read from the store, guarded ------------------------
(function () {
  var realStore = window.BadgeStore;
  captureLogs(function () {
    window.BadgeStore = undefined;
    eq('9c.no store -> left', P.alignMode(), 'left');
    window.BadgeStore = { getAttendees: function () { return []; } };
    eq('9c.store without getAlign() -> left', P.alignMode(), 'left');

    function withAlign(v) {
      window.BadgeStore = {
        getAttendees: function () { return []; },
        getAlign: function () { return v; }
      };
      return P.alignMode();
    }
    eq('9c.store says center', withAlign('center'), 'center');
    eq('9c.store says left', withAlign('left'), 'left');
    eq('9c.store says nonsense -> left', withAlign('middle'), 'left');
    eq('9c.store says a number -> left', withAlign(2), 'left');
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getAlign: function () { throw new Error('nope'); }
    };
    eq('9c.throwing getAlign() -> left, no crash', P.alignMode(), 'left');
  });
  /* (The "no getAlign()" warning itself is asserted in section 6, where it first
     fires — warnOnce deliberately does not repeat it here.) */
  window.BadgeStore = realStore;
})();

// ---- 9d. layoutOpts() carries align alongside logo -----------------------
(function () {
  var o = P.layoutOpts({ enabled: true, wPt: 72, hPt: 72 }, 'center');
  eq('9d.align sits in the same object as logo', o.align, 'center');
  check('9d.logo is still there too', o.logo.enabled === true && o.logo.wPt === 72,
    JSON.stringify(o));
  eq('9d.there is no fourth parameter — one opts object',
     Object.keys(o).sort().join(','), 'align,logo');
  eq('9d.junk align normalises', P.layoutOpts({ enabled: false }, 'sideways').align, 'left');
  captureLogs(function () {
    var realStore = window.BadgeStore;
    window.BadgeStore = {
      getAttendees: function () { return []; },
      getAlign: function () { return 'center'; },
      getLogo: function () { return { enabled: false, wIn: 1, hIn: 1 }; }
    };
    eq('9d.omitted align reads the store', P.layoutOpts().align, 'center');
    window.BadgeStore = realStore;
  });
})();

// ---- 9e. align REALLY reaches layout() (spy) ------------------------------
(function () {
  var realLayout = window.BadgeLayout;
  var seen = [];
  window.BadgeLayout = {
    layout: function (a, ov, opts) {
      seen.push(opts);
      return realLayout.layout(a, ov, opts);
    }
  };
  P.renderModel(six[0], null, { align: 'center' });
  eq('9e.align threaded to layout()', seen[0].align, 'center');
  check('9e.logo still travels with it', !!seen[0].logo, JSON.stringify(seen[0]));

  seen.length = 0;
  P.renderModel(six[0], null, { align: 'left', logo: { enabled: true, wPt: 72, hPt: 72 } });
  eq('9e.both settings in one object, align', seen[0].align, 'left');
  eq('9e.both settings in one object, logo', seen[0].logo.enabled, true);

  seen.length = 0;
  P.renderModel(six[0], null, null);
  eq('9e.omitted opts still passes an explicit align', seen[0].align, 'left');

  /* Purity: renderModel must not consult the store for alignment. */
  seen.length = 0;
  var realStore = window.BadgeStore;
  window.BadgeStore = {
    getAttendees: function () { return []; },
    getAlign: function () { return 'center'; }
  };
  P.renderModel(six[0], null, { align: 'left' });
  eq('9e.renderModel obeys its argument, not the store', seen[0].align, 'left');
  P.renderModel(six[0], null, {});
  eq('9e.opts without align resolves to the DEFAULT, not the store', seen[1].align, 'left');
  window.BadgeStore = realStore;

  window.BadgeLayout = realLayout;
})();

// ---- 9f. engine equality under BOTH alignments ---------------------------
['left', 'center'].forEach(function (align) {
  ALL.forEach(function (a) {
    assertMatchesEngineWithOpts('9f.' + align + '.' + a.id, a, null, { align: align });
  });
  OVERRIDE_CASES.slice(0, 4).forEach(function (ov, i) {
    assertMatchesEngineWithOpts('9f.' + align + '.ov' + i, six[0], ov, { align: align });
  });
});

// ---- 9g. left alignment: x is exactly the inset --------------------------
(function () {
  var worstRight = -Infinity;
  var edgesPerBadge = {};
  var flushCount = 0;
  ALL.forEach(function (a) {
    var m = P.renderModel(a, null, { align: 'left' });
    if (!m.lines.length) return;
    /* Per badge: one shared left edge, at the centred-block position. Different
       badges legitimately get DIFFERENT shared edges, because each block is
       centred on its own widest line — so this is per-attendee, not global. */
    var exp = assertSharedLeftEdge('9g.' + a.id, m.lines, null);
    edgesPerBadge[a.id] = Math.round(exp.x * 1000) / 1000;
    if (Math.abs(exp.x - S.INSET) < 1e-9) flushCount++;
    m.lines.forEach(function (l) {
      if (l.empty) return;
      var right = l.x + l.lineWidth;
      if (right > worstRight) worstRight = right;
      alignGated('9g.right edge inside the text box (' + a.id + '/' + l.field + ')',
        right <= S.CELL_W - S.INSET + 1e-9,
        'right=' + right + ' must be <= ' + (S.CELL_W - S.INSET));
    });
  });
  eq('9g.INSET is 14.4', S.INSET, 14.4);
  eq('9g.the text box right edge is 273.6', S.CELL_W - S.INSET, 273.6);

  /* The degenerate case is real and worth pinning: when the widest line fills the
     span, the centred block lands exactly on the inset. */
  (function () {
     /* Degenerate case, evaluated on the rule directly: a block as wide as the span
        must land exactly on the inset, and a zero-width block dead centre. */
     /* Tolerance, not equality: CELL_W - 2*INSET is 259.20000000000005 in binary
        floating point, not BOX_W's 259.2, so these differ in the last bits. */
     function near(name, got, want) {
       check(name, Math.abs(got - want) < 1e-9, 'got ' + got + ', want ' + want);
     }
     var full = expectedLeftGeometry(
       [{ text: 'x', lineWidth: S.BOX_W, lineTop: 0, advance: 10 }], null);
     near('9g.a block that fills the span sits ON the inset', full.x, S.INSET);
     var none = expectedLeftGeometry(
       [{ text: 'x', lineWidth: 0, lineTop: 0, advance: 10 }], null);
     near('9g.a zero-width block sits at the centre of the span', none.x, S.CELL_W / 2);
     var half = expectedLeftGeometry(
       [{ text: 'x', lineWidth: S.BOX_W / 2, lineTop: 0, advance: 10 }], null);
     near('9g.a half-width block sits a quarter-span in', half.x, S.INSET + S.BOX_W / 4);
     /* And the widest real fixture should come close to flush-left. */
     var m = P.renderModel(stress[0], null, { align: 'left' });
     var exp = expectedLeftGeometry(m.lines, null);
     check('9g.the widest fixture sits within 6 pt of the inset',
       exp.x - S.INSET < 6, 'x=' + exp.x + ' blockWidth=' + exp.blockWidth);
  })();

  console.log('  align:left -> shared x per badge (each block centred on its own ' +
    'widest line):');
  console.log('    ' + JSON.stringify(edgesPerBadge).slice(0, 300));
  console.log('    ' + flushCount + ' of ' + ALL.length +
    ' land exactly on the 14.4 inset; worst right edge ' +
    (Math.round(worstRight * 1000) / 1000) + ' pt (limit 273.6)');
})();

// ---- 9h. THE LEAK TEST: left vs center differ ONLY in x -------------------
/* A copy of a line model with every x-carrying field removed, so two alignments
   can be compared on everything else. */
function withoutX(line) {
  var out = {};
  Object.keys(line).forEach(function (k) {
    if (k === 'x') return;
    if (k === 'attr') {
      var a = {};
      Object.keys(line.attr).forEach(function (ak) {
        if (ak === 'x' || ak === 'data-x') return;
        a[ak] = line.attr[ak];
      });
      out.attr = a;
      return;
    }
    out[k] = line[k];
  });
  return out;
}

(function () {
  var OTHER = ['text', 'baselineY', 'sizePt', 'weight', 'style', 'lineTop', 'advance',
               'field', 'empty', 'lineWidth'];
  var differed = 0;
  ALL.concat(fourteen.slice(6)).forEach(function (a) {
    [null, { logo: { enabled: true, wPt: 72, hPt: 72 } }].forEach(function (extra, ei) {
      var base = extra || {};
      var left = P.renderModel(a, null, { align: 'left', logo: base.logo });
      var centre = P.renderModel(a, null, { align: 'center', logo: base.logo });
      var tag = a.id + (ei ? ' +logo' : '');

      eq('9h.line count is alignment-independent (' + tag + ')',
         left.lines.length, centre.lines.length);
      eq('9h.blockHeight is alignment-independent (' + tag + ')',
         left.blockHeight, centre.blockHeight);
      eq('9h.fits is alignment-independent (' + tag + ')', left.fits, centre.fits);
      if (left.lines.length !== centre.lines.length) return;

      for (var i = 0; i < left.lines.length; i++) {
        for (var k = 0; k < OTHER.length; k++) {
          eq('9h.' + OTHER[k] + ' unchanged by alignment (' + tag + ' line ' + i + ')',
             left.lines[i][OTHER[k]], centre.lines[i][OTHER[k]]);
        }
        /* Everything except x must be byte-identical; x is allowed to move (and
           for a non-full-width line it must). Compared by explicitly deleting the
           three x-carrying fields from a copy — not by regexing the JSON, which
           silently missed the quoted copies inside `attr`. */
        eq('9h.only x differs, whole line object (' + tag + ' line ' + i + ')',
           JSON.stringify(withoutX(left.lines[i])),
           JSON.stringify(withoutX(centre.lines[i])));
        /* And prove the deletion is not hiding a real difference: the x fields
           themselves must agree with each other within the line. */
        eq('9h.attr x mirrors the numeric x, left (' + tag + ' line ' + i + ')',
           left.lines[i].attr.x, String(left.lines[i].x));
        eq('9h.attr x mirrors the numeric x, centre (' + tag + ' line ' + i + ')',
           centre.lines[i].attr.x, String(centre.lines[i].x));
        eq('9h.data-x mirrors x, left (' + tag + ' line ' + i + ')',
           left.lines[i].attr['data-x'], String(left.lines[i].x));
        if (left.lines[i].x !== centre.lines[i].x) differed++;
      }
    });
  });
  alignGated('9h.alignment actually moves x for at least some lines', differed > 0,
    'x never differed across ' + ALL.length + ' attendees');
  console.log('  align leak test: x differed on ' + differed +
    ' line(s); every other property byte-identical');
})();

// ---- 9i. sample x values, for the record ---------------------------------
(function () {
  var rows = [];
  var cases = [
    { align: 'left',   logo: null, tag: 'left' },
    { align: 'left',   logo: { enabled: true, wPt: IN, hPt: IN }, tag: 'left+logo' },
    { align: 'center', logo: null, tag: 'center' }
  ];
  cases.forEach(function (c) {
    var m = P.renderModel(six[0], null, { align: c.align, logo: c.logo });
    var exp = expectedLeftGeometry(m.lines, c.logo);
    m.lines.forEach(function (l) {
      if (l.empty) return;
      rows.push({ tag: c.tag, field: l.field,
                  x: Math.round(l.x * 1000) / 1000,
                  width: Math.round(l.lineWidth * 1000) / 1000,
                  right: Math.round((l.x + l.lineWidth) * 1000) / 1000 });
    });
    if (c.align === 'left') {
      rows.push({ tag: c.tag, field: '(block)', x: Math.round(exp.x * 1000) / 1000,
                  width: Math.round(exp.blockWidth * 1000) / 1000, right: exp.spanHi });
    }
  });
  console.log('  per-line x for ' + six[0].first + ' ' + six[0].last + ':');
  rows.forEach(function (r) {
    console.log('    ' + r.tag.padEnd(10) + ' ' + r.field.padEnd(9) +
      ' x=' + String(r.x).padEnd(9) + ' w=' + String(r.width).padEnd(9) +
      ' right=' + r.right);
  });
})();

// ===========================================================================
// 10. SOURCE SCAN — the hard rules, enforced against the shipped file
// ===========================================================================
(function () {
  var src = fs.readFileSync(path.join(SITE, 'js', 'preview.js'), 'utf8');
  var banned = [
    ['fetch(', /\bfetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['WebSocket', /WebSocket/],
    ['sendBeacon', /sendBeacon/],
    ['innerHTML assignment', /innerHTML\s*=/],
    ['outerHTML assignment', /outerHTML\s*=/],
    ['document.write', /document\s*\.\s*write/],
    ['eval', /\beval\s*\(/],
    ['import statement', /^\s*import\s/m],
    ['export statement', /^\s*export\s/m],
    ['http(s) URL', /https?:\/\/(?!www\.w3\.org\/2000\/svg)/]
  ];
  banned.forEach(function (b) {
    check('10.js/preview.js contains no ' + b[0], !b[1].test(src),
      'matched: ' + (src.match(b[1]) || [''])[0]);
  });
  check('10.js/preview.js builds DOM with textContent', /textContent\s*=/.test(src), '');
  check('10.js/preview.js is a classic script assigning to window',
    /window\.BadgePreview\s*=/.test(src), '');
  check('10.js/preview.js calls BadgeLayout.layout', /BadgeLayout/.test(src) &&
    /\.layout\(/.test(src), '');
  check('10.the only external URL is the SVG namespace',
    (src.match(/https?:\/\/[^'"\s]+/g) || []).every(function (u) {
      return u === 'http://www.w3.org/2000/svg';
    }), JSON.stringify(src.match(/https?:\/\/[^'"\s]+/g)));
  // and the browser-only suite must not be mistaken for a node suite
  check('10.test/preview.browser.js is not named *.test.js',
    fs.existsSync(path.join(__dirname, 'preview.browser.js')), 'missing browser suite');
})();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('\npreview.test.js: ' + failures.length + ' of ' + checks + ' checks FAILED\n');
  failures.slice(0, 40).forEach(function (f, n) {
    console.error('  ' + (n + 1) + ') ' + f.name + '\n       ' + f.detail);
  });
  if (failures.length > 40) console.error('  ... and ' + (failures.length - 40) + ' more');
  process.exit(1);
}
console.log('preview.test.js: all ' + checks + ' checks passed ' +
  '(renderModel == BadgeLayout for ' + ALL.length + ' attendees x ' +
  (OVERRIDE_CASES.length + 1) + ' override cases, page maths, clamping, ' +
  'degradation, source rules)');
console.log('  note: rendered-pixel verification lives in test/preview.browser.js ' +
  '(open test/preview.browser.html in a browser — it does not run under node)');
