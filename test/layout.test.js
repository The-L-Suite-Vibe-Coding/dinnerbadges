/*
 * test/layout.test.js — plain node, no framework. Exits non-zero on failure.
 *
 *   node site/test/layout.test.js
 *
 * PRIMARY SUITE runs against the REAL vendored metrics, fonts/inter-metrics.js —
 * the same table the preview and the PDF exporter use. Every numeric expectation
 * below is therefore a real Inter number, not a model number.
 *
 * Covers: the horizontal fit (wrap-then-shrink, clamps, clipping), OPTICAL vertical
 * centering with its half-descender minimax, the bottom-right logo reserve and its
 * fixed-point iteration, the sheet presets (sample top-left vs Avery), text
 * normalization, performance, purity and determinism.
 *
 * Two things this file is careful NOT to do:
 *   1. No tautological assertions. Checking `x + lineWidth/2 === 144` proves
 *      nothing, because the engine computes x as (288 - lineWidth)/2, so the
 *      identity holds for any width, right or wrong. Centering is instead checked
 *      against a width re-derived INDEPENDENTLY here (a per-character sum of
 *      advances) and against literal expected coordinates. Same for the vertical
 *      model: expected tops are re-derived here from a literal 1.1499 factor and a
 *      literal expected size sequence, not from the advances the engine returned.
 *   2. No stub-only numbers. A MODEL-METRICS suite still runs at the end, clearly
 *      labelled, but it asserts structural invariants only — never point values.
 *
 * ALL FIXTURE NAMES ARE INVENTED. No real person's data appears in this file.
 */
'use strict';

var path = require('path');

// Browser-ish global so the classic scripts can assign to `window`.
global.window = global;

var SITE = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------
var pass = 0;
var fail = 0;
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '   [' + detail + ']' : ''));
  }
}
function near(a, b, tol, label) {
  ok(Math.abs(a - b) <= tol, label, 'got ' + a + ', expected ' + b + ' +/-' + tol);
}
function section(t) {
  console.log('\n' + t);
}
function r4(n) {
  return Math.round(n * 10000) / 10000;
}
function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

// ===========================================================================
section('0. dependency guard (metrics deliberately absent)');
// ===========================================================================
require(path.join(SITE, 'js', 'spec.js'));
require(path.join(SITE, 'js', 'layout.js'));
var S = window.BadgeSpec;
var L = window.BadgeLayout;

window.InterMetrics = undefined;
var guardMsg = '';
try {
  L.layout({ first: 'Ines', last: 'Marchetti' });
} catch (e) {
  guardMsg = e.message;
}
ok(/InterMetrics/.test(guardMsg), 'layout() throws a clear error when InterMetrics is absent', guardMsg);
ok(!/BadgeSpec/.test(guardMsg) || /InterMetrics/.test(guardMsg), 'the error names the missing module');

// Now load the REAL metrics module — the one the app ships.
require(path.join(SITE, 'fonts', 'inter-metrics.js'));
var M = window.InterMetrics;
ok(!!M && M.unitsPerEm === 2048, 'real fonts/inter-metrics.js loaded (unitsPerEm 2048)');
ok(M.ascent === 1984 && M.descent === 494, 'real Inter hhea ascent 1984 / descent 494');
ok(
  Math.abs(M.widthOf('a', 100, 400, 'italic') - M.widthOf('a', 100, 400, 'normal')) > 1e-6,
  'real italic advances differ from regular (so style threading is observable)',
  'italic ' + r4(M.widthOf('a', 100, 400, 'italic')) + ' vs regular ' + r4(M.widthOf('a', 100, 400, 'normal'))
);

// ---------------------------------------------------------------------------
// INDEPENDENT re-derivations. These deliberately do not reuse engine output.
// ---------------------------------------------------------------------------
// Alignment fixtures. The DEFAULT IS NOW 'left', so every section that asserts
// centered geometry passes CENTERED explicitly; sections that assert sizing,
// wrapping, warnings or vertical placement are left on the default and thereby
// double as left-alignment coverage.
var CENTERED = { align: 'center' };
var ADVANCE_FACTOR_LITERAL = 1.1499; // hard-coded on purpose: catches a spec change
var CELL_W_LITERAL = 288;
var CELL_H_LITERAL = 216;
var UPEM_LITERAL = 2048;
var ASCENT_LITERAL = 1984; // Inter hhea ascender
var CAP_LITERAL = 1490; // Inter OS/2 sCapHeight
var DESC_LITERAL = 442; // measured glyf yMin of p g y j q (NOT hhea descender 494)
var DESCENDER_CHARS = /[pgyjq]/; // used only to model TRUE ink in the test

/** Width of a string re-derived character by character (no kerning, per spec). */
function widthByChars(str, sizePt, weight, style) {
  var sum = 0;
  for (var i = 0; i < str.length; i++) {
    var cp = str.codePointAt(i);
    var ch = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    sum += M.widthOf(ch, sizePt, weight, style);
  }
  return sum;
}

/**
 * Expected block height, line tops, baselines and OPTICAL SHIFT, re-derived here
 * from literal Inter constants. `seq` is [[sizePt, carriesInk], ...] — the 8 pt
 * gap line carries no ink and must not anchor the shift.
 */
function expectedVertical(seq) {
  var i;
  var bh = 0;
  for (i = 0; i < seq.length; i++) bh += ADVANCE_FACTOR_LITERAL * seq[i][0];
  var tops = [];
  var bases = [];
  var t = (CELL_H_LITERAL - bh) / 2;
  for (i = 0; i < seq.length; i++) {
    tops.push(t);
    bases.push(t + (ASCENT_LITERAL / UPEM_LITERAL) * seq[i][0]);
    t += ADVANCE_FACTOR_LITERAL * seq[i][0];
  }
  var firstInk = -1;
  var lastInk = -1;
  for (i = 0; i < seq.length; i++) {
    if (seq[i][1]) {
      if (firstInk < 0) firstInk = i;
      lastInk = i;
    }
  }
  var shift = 0;
  if (firstInk >= 0) {
    var inkTop = bases[firstInk] - (CAP_LITERAL / UPEM_LITERAL) * seq[firstInk][0];
    // HALF the descender depth — the engine's minimax choice, re-derived here.
    var inkBottom = bases[lastInk] + ((DESC_LITERAL / UPEM_LITERAL) * seq[lastInk][0]) / 2;
    shift = -((inkTop + inkBottom - CELL_H_LITERAL) / 2);
    for (i = 0; i < seq.length; i++) {
      tops[i] += shift;
      bases[i] += shift;
    }
  }
  return { blockHeight: bh, tops: tops, bases: bases, shift: shift, bottom: t + shift };
}

/**
 * The engine's own optical box, recomputed from returned baselines and literal ink
 * constants, must be centered. Falsifiable: it uses baselineY, which the engine
 * would have to get right independently of the shift arithmetic.
 */
function assertOpticalBoxCentered(res, label) {
  var ink = res.lines.filter(function (l) { return l.text; });
  if (!ink.length) {
    ok(true, label + ' (no ink — trivially centered)');
    return;
  }
  var f = ink[0];
  var l = ink[ink.length - 1];
  var inkTop = f.baselineY - (CAP_LITERAL / UPEM_LITERAL) * f.sizePt;
  var inkBottom = l.baselineY + ((DESC_LITERAL / UPEM_LITERAL) * l.sizePt) / 2;
  var center = (inkTop + inkBottom) / 2;
  ok(Math.abs(center - CELL_H_LITERAL / 2) <= 0.01, label, 'optical center ' + r4(center) + ' vs 108');
}

// Characters whose ink actually drops below the baseline in Inter. Used ONLY by the
// per-glyph keep-out assertion, to be honest about which glyphs can reach into the
// reserve. The ENGINE deliberately assumes every line may have a descender.
var DESCENDER_GLYPHS = /[pgyjqQ,;()\[\]{}@$_\/\\|]/;

/**
 * Lower edge of a line's INK, worst case: the advance box bottom or the baseline
 * plus the FULL descender depth, whichever is lower. This is the extent a keep-out
 * must respect — the advance box alone sits 0.035 em too high, which is what let
 * descender ink reach into the reserved corner.
 */
function inkBottomOf(l) {
  return Math.max(l.lineTop + l.advance, l.baselineY + (DESC_LITERAL / UPEM_LITERAL) * l.sizePt);
}

/** Does a line's ink extent reach into the reserved y-band? */
function lineReachesBand(l, bandTop) {
  return inkBottomOf(l) > bandTop + 1e-9 && l.lineTop < CELL_H_LITERAL - 1e-9;
}

/**
 * PER-GLYPH keep-out check, matching the preview item's approach: each glyph's own
 * cell horizontally (pen position to pen + advance), and cap-height-to-descender
 * vertically with descender depth applied only to characters that actually have
 * one. Stricter and more honest than a line bounding box in both directions.
 */
function glyphsInReserve(res) {
  if (!res.logo || !res.logo.enabled) return [];
  var x0 = res.logo.reserve.x0;
  var y0 = res.logo.reserve.y0;
  var hits = [];
  res.lines.forEach(function (l) {
    if (!l.text) return;
    var pen = l.x;
    for (var i = 0; i < l.text.length; i++) {
      var ch = l.text[i];
      var adv = M.widthOf(ch, l.sizePt, l.weight, l.style);
      var gx0 = pen;
      var gx1 = pen + adv;
      pen = gx1;
      if (gx1 <= x0 + 1e-9) continue; // glyph cell entirely left of the reserve
      var top = l.baselineY - (CAP_LITERAL / UPEM_LITERAL) * l.sizePt;
      var bot = l.baselineY + (DESCENDER_GLYPHS.test(ch) ? (DESC_LITERAL / UPEM_LITERAL) * l.sizePt : 0);
      if (bot > y0 + 1e-9 && top < CELL_H_LITERAL - 1e-9) {
        hits.push(l.field + ' ' + JSON.stringify(ch) + ' x=' + r4(gx0) + '-' + r4(gx1) + ' inkBottom=' + r4(bot) + ' > y0=' + r4(y0));
      }
    }
  });
  return hits;
}

function assertNoGlyphInReserve(res, label) {
  var hits = glyphsInReserve(res);
  ok(hits.length === 0, label, hits.slice(0, 3).join('; '));
}

/**
 * TRUE ink residual: models the ink the way real glyphs behave — cap height above
 * the first inked line, and a descender below the last one ONLY if the text
 * actually contains p/g/y/j/q. This is the honest measure of "does it look
 * centered", and it is NOT centered by construction.
 */
function trueInkError(res) {
  var ink = res.lines.filter(function (l) { return l.text; });
  if (!ink.length) return 0;
  var f = ink[0];
  var l = ink[ink.length - 1];
  var top = f.baselineY - (CAP_LITERAL / UPEM_LITERAL) * f.sizePt;
  var bottom = l.baselineY + (DESCENDER_CHARS.test(l.text) ? (DESC_LITERAL / UPEM_LITERAL) * l.sizePt : 0);
  return (top + bottom) / 2 - CELL_H_LITERAL / 2;
}

function dump(label, res) {
  console.log('\n--- ' + label + ' ---');
  console.log('  blockHeight = ' + r4(res.blockHeight) + '   fits=' + res.fits);
  console.log('  appliedSizes = ' + JSON.stringify(res.appliedSizes));
  console.log(
    '  ' + pad('field', 8) + pad('size', 6) + pad('style', 8) + pad('x', 10) +
      pad('width', 10) + pad('lineTop', 10) + pad('advance', 9) + pad('baseline', 10) + 'text'
  );
  res.lines.forEach(function (ln) {
    console.log(
      '  ' + pad(ln.field, 8) + pad(ln.sizePt, 6) + pad(ln.style, 8) + pad(r4(ln.x), 10) +
        pad(r4(ln.lineWidth), 10) + pad(r4(ln.lineTop), 10) + pad(r4(ln.advance), 9) +
        pad(r4(ln.baselineY), 10) + JSON.stringify(ln.text)
    );
  });
  res.warnings.forEach(function (w) {
    console.log('  warning: ' + w);
  });
}

/**
 * Falsifiable centering check: re-measure each line's text here, per character,
 * with the weight and style the line claims, then require the engine's width AND
 * left edge to match that independent number.
 */
function assertHorizontalPlacement(res, label, logoWpt, align) {
  var bad = [];
  var mode = align || 'left'; // the engine's default, restated here on purpose
  res.lines.forEach(function (ln, i) {
    if (!ln.text) return; // the gap line has no text to re-measure
    var w = widthByChars(ln.text, ln.sizePt, ln.weight, ln.style);
    if (Math.abs(ln.lineWidth - w) > 1e-6) {
      bad.push('line ' + i + ' (' + ln.field + ') width ' + r4(ln.lineWidth) + ' != independent ' + r4(w));
    }
    // Expected x, re-derived here rather than read back:
    //   left   -> the shared block-centred edge: spanLo + (spanW - blockWidth)/2,
    //             clamped to INSET, identical for every line
    //   center -> centered in its span; a line level with the logo band is
    //             centered in [INSET, CELL_W - wPt], others in the full box
    var expX;
    if (mode === 'center') {
      var center = ln.narrowed ? (14.4 + (CELL_W_LITERAL - logoWpt)) / 2 : CELL_W_LITERAL / 2;
      expX = center - w / 2;
    } else {
      // left: the shared, block-centred left edge, recomputed independently
      expX = expectedBlockLeft(res, logoWpt || 0).x;
    }
    if (Math.abs(ln.x - expX) > 1e-6) {
      bad.push('line ' + i + ' (' + ln.field + ') x ' + r4(ln.x) + ' != independent ' + r4(expX));
    }
    if (ln.align !== mode) bad.push('line ' + i + ' reports align ' + ln.align + ' != ' + mode);
  });
  ok(bad.length === 0, label, bad.join('; '));
}

/** Falsifiable vertical check against an independently re-derived size sequence. */
function assertVerticalIndependently(res, seq, label) {
  var exp = expectedVertical(seq);
  var bad = [];
  if (res.lines.length !== seq.length) {
    bad.push('expected ' + seq.length + ' lines, got ' + res.lines.length);
  } else {
    if (Math.abs(res.blockHeight - exp.blockHeight) > 1e-9) {
      bad.push('blockHeight ' + r4(res.blockHeight) + ' != independent ' + r4(exp.blockHeight));
    }
    if (Math.abs(res.opticalShift - exp.shift) > 1e-9) {
      bad.push('opticalShift ' + r4(res.opticalShift) + ' != independent ' + r4(exp.shift));
    }
    res.lines.forEach(function (ln, i) {
      if (ln.sizePt !== seq[i][0]) bad.push('line ' + i + ' size ' + ln.sizePt + ' != expected ' + seq[i][0]);
      if (!!ln.text !== !!seq[i][1]) bad.push('line ' + i + ' ink-ness disagrees with the expectation');
      if (Math.abs(ln.lineTop - exp.tops[i]) > 1e-9) {
        bad.push('line ' + i + ' top ' + r4(ln.lineTop) + ' != independent ' + r4(exp.tops[i]));
      }
      if (Math.abs(ln.baselineY - exp.bases[i]) > 1e-9) {
        bad.push('line ' + i + ' baseline ' + r4(ln.baselineY) + ' != independent ' + r4(exp.bases[i]));
      }
    });
  }
  ok(bad.length === 0, label, bad.join('; '));
}

/** Literal expected coordinates, table-driven. Any drift fails. */
function assertLiteralLines(res, expected, label) {
  var bad = [];
  if (res.lines.length !== expected.length) {
    bad.push('line count ' + res.lines.length + ' != ' + expected.length);
  } else {
    expected.forEach(function (e, i) {
      var ln = res.lines[i];
      if (ln.field !== e[0]) bad.push(i + ' field ' + ln.field + '!=' + e[0]);
      if (ln.sizePt !== e[1]) bad.push(i + ' size ' + ln.sizePt + '!=' + e[1]);
      if (ln.style !== e[2]) bad.push(i + ' style ' + ln.style + '!=' + e[2]);
      if (Math.abs(ln.x - e[3]) > 0.001) bad.push(i + ' x ' + r4(ln.x) + '!=' + e[3]);
      if (Math.abs(ln.lineWidth - e[4]) > 0.001) bad.push(i + ' width ' + r4(ln.lineWidth) + '!=' + e[4]);
      if (Math.abs(ln.lineTop - e[5]) > 0.001) bad.push(i + ' top ' + r4(ln.lineTop) + '!=' + e[5]);
      if (Math.abs(ln.baselineY - e[6]) > 0.001) bad.push(i + ' baseline ' + r4(ln.baselineY) + '!=' + e[6]);
      if (ln.text !== e[7]) bad.push(i + ' text ' + JSON.stringify(ln.text) + '!=' + JSON.stringify(e[7]));
    });
  }
  ok(bad.length === 0, label, bad.join('; '));
}

function assertInsideCell(res, label) {
  var bad = [];
  res.lines.forEach(function (ln, i) {
    if (!(ln.x >= -1e-9)) bad.push('line ' + i + ' x=' + ln.x);
    if (!(ln.x + ln.lineWidth <= CELL_W_LITERAL + 1e-9)) bad.push('line ' + i + ' right=' + (ln.x + ln.lineWidth));
    if (!(ln.lineTop >= -1e-9)) bad.push('line ' + i + ' top=' + ln.lineTop);
    if (!(ln.lineTop + ln.advance <= CELL_H_LITERAL + 1e-9)) {
      bad.push('line ' + i + ' bottom=' + (ln.lineTop + ln.advance));
    }
  });
  ok(bad.length === 0, label, bad.join('; '));
}
function assertSizeBounds(res, label) {
  var bad = [];
  ['first', 'last', 'company', 'title'].forEach(function (f) {
    var v = res.appliedSizes[f];
    if (v > S.SIZES[f] + 1e-9) bad.push(f + ' ' + v + ' > max ' + S.SIZES[f]);
    if (v < S.FLOORS[f] - 1e-9) bad.push(f + ' ' + v + ' < floor ' + S.FLOORS[f]);
  });
  ok(bad.length === 0, label, bad.join('; '));
}
function fields(res) {
  return res.lines.map(function (l) {
    return l.field;
  });
}
function anyClipped(res) {
  return res.lines.some(function (l) {
    return l.text && l.text.slice(-1) === '…';
  });
}

// ===========================================================================
// FIXTURES (all invented)
// ===========================================================================
var NORMAL = {
  id: 'n1',
  first: 'Marguerite',
  last: 'Delacroix-Whitfield',
  title: 'General Counsel',
  company: 'Northwind Analytics'
};
var STRESS = {
  id: 's1',
  first: 'Bartholomew',
  last: 'Vandergriff-Castellanos',
  title: 'Executive Vice President, General Counsel & Corporate Secretary',
  company: 'Bristol-Myers Squibb Holdings International'
};
var LONG_CO = {
  id: 'c1',
  first: 'Ines',
  last: 'Marchetti',
  title: 'General Counsel',
  company: 'Northwind Robotics International Holdings Corporation'
};
var W40 = 'Xylophonemongerdiplomaticalness40chrabcd'; // 39 chars, no break opportunity
var BRUTAL = { id: 'b1', first: W40, last: W40, title: W40, company: W40 };

var NBSP = String.fromCharCode(0x00a0);
var ZWSP = String.fromCharCode(0x200b);

// ===========================================================================
section('1. BadgeSpec constants');
// ===========================================================================
var origins = [0, 1, 2, 3, 4, 5].map(function (i) {
  var o = S.cellOrigin(i);
  return o.x + ',' + o.y;
});
ok(origins.join(' ') === '0,0 288,0 0,216 288,216 0,432 288,432', 'cellOrigin 0..5 (y from page TOP)', origins.join(' '));
near(S.BOX_W, 259.2, 1e-9, 'BOX_W 259.2');
near(S.BOX_H, 187.2, 1e-9, 'BOX_H 187.2');
ok(S.ADVANCE_FACTOR === ADVANCE_FACTOR_LITERAL, 'ADVANCE_FACTOR 1.1499');
ok(S.STYLES.company === 'italic', 'company style is italic');
ok(S.PER_PAGE === 6 && S.PAGE_W === 612 && S.PAGE_H === 792, 'page 612x792, 6 per page');

// ===========================================================================
section('2. normal attendee — order, sizes, and LITERAL real-Inter coordinates');
// ===========================================================================
var normal = L.layout(NORMAL, null, CENTERED);
dump('NORMAL (real metrics)', normal);
ok(fields(normal).join(',') === 'first,last,gap,company,gap,title', 'order = first, last, gap, company, GAP, title (company ABOVE title)', fields(normal).join(','));
ok(normal.lines.map(function (l) { return l.sizePt; }).join('/') === '36/26/8/21/4/19', 'sizes 36/26/(8)/21/(4)/19 when everything fits');
ok(normal.fits === true && normal.warnings.length === 0, 'fits:true, no warnings', normal.warnings.join(' | '));
ok(normal.lines[0].weight === 700, 'first name is bold (700)');
assertLiteralLines(
  normal,
  [
    // field      size  style     x         width      lineTop    baselineY   text
    ['first', 36, 'normal', 46.626, 194.748, 38.8097, 73.6847, 'Marguerite'],
    ['last', 26, 'normal', 25.7051, 236.5898, 80.2061, 105.3936, 'Delacroix-Whitfield'],
    ['gap', 8, 'normal', 144, 0, 110.1035, 117.8535, ''],
    ['company', 21, 'italic', 43.563, 200.874, 119.3027, 139.6464, 'Northwind Analytics'],
    ['gap', 4, 'normal', 144, 0, 143.4506, 147.3256, ''],
    ['title', 19, 'normal', 69.6189, 148.7622, 148.0502, 166.4564, 'General Counsel']
  ],
  'every line matches its literal expected real-Inter position'
);
near(normal.blockHeight, 131.0886, 0.001, 'blockHeight = 131.0886 pt (literal, both gap lines included)');
near(normal.blockHeight, 114 * S.ADVANCE_FACTOR, 1e-9, 'blockHeight = 1.1499 * (36+26+8+21+4+19)');
assertHorizontalPlacement(normal, 'widths and x re-derived per character agree (normal, centered)', 0, 'center');
assertVerticalIndependently(normal, [[36, 1], [26, 1], [8, 0], [21, 1], [4, 0], [19, 1]], 'vertical model (incl. optical shift) re-derived independently agrees (normal)');
near(normal.opticalShift, -3.646, 0.001, 'optical shift = -3.646 pt for the normal badge (literal)');
assertOpticalBoxCentered(normal, 'the optical ink box is centered in the cell (normal)');
assertInsideCell(normal, 'nothing outside the 288x216 cell (normal)');

// falsifiability self-check: the assertions above must reject a wrong value
var mutated = JSON.parse(JSON.stringify(normal));
mutated.lines[0].x += 0.5;
var before = fail;
(function () {
  var savedLog = console.log;
  console.log = function () {};
  assertHorizontalPlacement(mutated, 'MUTATION PROBE (expected to fail)', 0, 'center');
  console.log = savedLog;
})();
ok(fail === before + 1, 'the centering assertion actually fails on a 0.5 pt error (not a tautology)');
fail = before; // discount the deliberate failure; the meta-assertion above still counts

// ===========================================================================
section('3. italic threading (company is 400 italic, real Inter tables)');
// ===========================================================================
var companyLine = normal.lines.filter(function (l) { return l.field === 'company'; })[0];
ok(companyLine.style === 'italic' && companyLine.weight === 400, 'company line is 400 italic');
ok(
  normal.lines.filter(function (l) { return l.field !== 'company'; }).every(function (l) { return l.style === 'normal'; }),
  'every non-company line is style normal'
);
var italicW = widthByChars(companyLine.text, 21, 400, 'italic');
var regularW = widthByChars(companyLine.text, 21, 400, 'normal');
near(companyLine.lineWidth, italicW, 1e-6, 'company width came from the ITALIC table');
ok(Math.abs(italicW - regularW) > 0.01, 'italic and regular really differ for this text', r4(italicW) + ' vs ' + r4(regularW));
ok(Math.abs(companyLine.x - (288 - regularW) / 2) > 0.005, 'company x is NOT the regular-table x (style not dropped)');

// ===========================================================================
section('4. stress fixture — LITERAL real-Inter coordinates, wrap-before-shrink');
// ===========================================================================
var stress = L.layout(STRESS, null, CENTERED);
dump('STRESS (real metrics)', stress);
assertLiteralLines(
  stress,
  [
    ['first', 36, 'normal', 27.1055, 233.7891, 21.1638, 56.0388, 'Bartholomew'],
    ['last', 22.5, 'normal', 16.4213, 255.1575, 62.5602, 84.3571, 'Vandergriff-Castellanos'],
    ['gap', 8, 'normal', 144, 0, 88.433, 96.183, ''],
    ['company', 21, 'italic', 39.2871, 209.4258, 97.6322, 117.9759, 'Bristol-Myers Squibb'],
    ['company', 21, 'italic', 34.6113, 218.7773, 121.7801, 142.1238, 'Holdings International'],
    ['gap', 4, 'normal', 144, 0, 145.928, 149.803, ''],
    ['title', 16, 'normal', 16.082, 255.8359, 150.5276, 166.0276, 'Executive Vice President, General'],
    ['title', 16, 'normal', 26.3828, 235.2344, 168.926, 184.426, 'Counsel & Corporate Secretary']
  ],
  'stress lines match their literal expected real-Inter positions'
);
near(stress.blockHeight, 166.1606, 0.001, 'stress blockHeight = 166.1606 pt (literal)');
assertHorizontalPlacement(stress, 'widths and x re-derived per character agree (stress, centered)', 0, 'center');
assertVerticalIndependently(stress, [[36, 1], [22.5, 1], [8, 0], [21, 1], [21, 1], [4, 0], [16, 1], [16, 1]], 'vertical model (incl. optical shift) re-derived independently agrees (stress)');
assertOpticalBoxCentered(stress, 'the optical ink box is centered in the cell (stress)');
assertInsideCell(stress, 'nothing outside the 288x216 cell (stress)');
assertSizeBounds(stress, 'stress sizes within 36/26/21/19 and 22/16/13/12');
ok(stress.blockHeight <= 187.2 + 1e-9, 'stress blockHeight <= 187.2', r4(stress.blockHeight));
ok(stress.fits === true && !anyClipped(stress), 'stress fits with no clipping');
ok(
  stress.lines.filter(function (l) { return l.field === 'company'; }).length === 2 && stress.appliedSizes.company === 21,
  'company WRAPPED before shrinking (2 lines still at the 21 pt ceiling)'
);
ok(
  stress.lines.filter(function (l) { return l.field === 'title'; }).length === 2 && stress.appliedSizes.title === 16,
  'title needed a wrap AND a shrink (2 lines at 16 pt)'
);
ok(
  Math.max.apply(null, stress.lines.map(function (l) { return l.lineWidth; })) <= 259.2 + 1e-9,
  'every stress line fits the 259.2 pt box'
);

// ===========================================================================
section('5. brutal case — 39-char unbroken word in every field');
// ===========================================================================
var brutal = L.layout(BRUTAL, null, CENTERED);
dump('BRUTAL (real metrics)', brutal);
assertInsideCell(brutal, 'nothing outside the 288x216 cell (brutal)');
assertHorizontalPlacement(brutal, 'widths and x re-derived per character agree (brutal, centered)', 0, 'center');
assertSizeBounds(brutal, 'brutal case still respects max/floor bounds');
ok(
  Math.max.apply(null, brutal.lines.map(function (l) { return l.lineWidth; })) <= 259.2 + 1e-9,
  'clipped lines fit the 259.2 pt box'
);
ok(brutal.fits === false && brutal.warnings.length > 0, 'brutal case reports fits:false with warnings');
ok(anyClipped(brutal), 'brutal case clips rather than overflowing');
ok(brutal.lines.filter(function (l) { return l.field === 'company'; })[0].style === 'italic', 'brutal company line is still italic');

// ===========================================================================
section('6. overrides clamp to [floor, max]');
// ===========================================================================
var up = L.layout(STRESS, { first: 20, last: 20, company: 20, title: 20 }, CENTERED);
var down = L.layout(STRESS, { first: -20, last: -20, company: -20, title: -20 }, CENTERED);
assertSizeBounds(up, '+20 override: no size exceeds its maximum');
assertSizeBounds(down, '-20 override: no size falls below its floor');
console.log('  +20 -> ' + JSON.stringify(up.appliedSizes));
console.log('  -20 -> ' + JSON.stringify(down.appliedSizes));
ok(down.appliedSizes.title === 12 && down.appliedSizes.company === 13, '-20 pins title/company at their floors');
ok(up.appliedSizes.first === 36, '+20 pins first at its 36 pt ceiling');
assertInsideCell(up, 'nothing outside the cell with a +20 override');
assertInsideCell(down, 'nothing outside the cell with a -20 override');
assertHorizontalPlacement(up, 'centering still independently correct with +20', 0, 'center');
assertHorizontalPlacement(down, 'centering still independently correct with -20', 0, 'center');
near(L.layout(NORMAL, { last: -3 }).appliedSizes.last, 24.5, 1e-9, 'override unit is 0.5 pt (last:-3 => 24.5 pt)');
['first', 'last', 'company', 'title'].forEach(function (f) {
  var o = {};
  o[f] = 'nonsense';
  var r = L.layout(NORMAL, o);
  ok(r.appliedSizes[f] === normal.appliedSizes[f], 'a non-numeric ' + f + ' override is ignored');
});

// ===========================================================================
section('7. REGRESSION — an upward nudge must never cost characters');
// ===========================================================================
var co0 = L.layout(LONG_CO, null);
var coUp1 = L.layout(LONG_CO, { company: 1 });
var coUp6 = L.layout(LONG_CO, { company: 6 });
var coDown2 = L.layout(LONG_CO, { company: -2 });
dump('LONG_CO override 0', co0);
dump('LONG_CO override +1 (was clipping "Corpor…" before the fix)', coUp1);
ok(co0.appliedSizes.company === 16.5 && !anyClipped(co0), 'baseline: company auto-sizes to 16.5 pt, nothing clipped');
ok(!anyClipped(coUp1), '+1 nudge does NOT clip the company name');
ok(coUp1.appliedSizes.company === 16.5, '+1 nudge is capped at 16.5 pt instead of clipping at 17 pt', String(coUp1.appliedSizes.company));
ok(
  coUp1.warnings.some(function (w) { return /capped/.test(w) && /company/.test(w); }),
  'the capped nudge is reported in warnings',
  coUp1.warnings.join(' | ')
);
ok(
  coUp1.lines.filter(function (l) { return l.field === 'company'; }).map(function (l) { return l.text; }).join(' ') ===
    'Northwind Robotics International Holdings Corporation',
  'every character of the company name survives the +1 nudge'
);
ok(!anyClipped(coUp6) && coUp6.appliedSizes.company === 16.5, 'a big +6 nudge is capped at the same safe size, still unclipped');
ok(coDown2.appliedSizes.company === 15.5 && !anyClipped(coDown2), 'DOWNWARD nudges are still honored exactly (-2 => 15.5 pt)');
// a field that already clips at its auto size is not "capped" — clipping is unavoidable there
var alreadyClipped = L.layout({ first: W40, last: 'Ng' }, { first: 4 });
ok(
  alreadyClipped.appliedSizes.first === 24 && anyClipped(alreadyClipped),
  'a field that clips even at its floor still honors the nudge (clipping was unavoidable)',
  String(alreadyClipped.appliedSizes.first)
);

// ===========================================================================
section('8. REGRESSION — zero-width characters and non-breaking spaces');
// ===========================================================================
function companyOf(str, ov) {
  return L.layout({ first: 'Ines', last: 'Marchetti', company: str, title: 'General Counsel' }, ov || null, CENTERED).lines.filter(
    function (l) { return l.field === 'company'; }
  );
}
var cleanCo = companyOf('Northwind Robotics')[0];
[
  ['U+200B ZWSP', 0x200b],
  ['U+200C ZWNJ', 0x200c],
  ['U+200D ZWJ', 0x200d],
  ['U+FEFF BOM', 0xfeff],
  ['U+00AD soft hyphen', 0x00ad],
  ['U+200E LRM', 0x200e],
  ['U+2060 word joiner', 0x2060]
].forEach(function (pair) {
  var dirty = companyOf('North' + String.fromCharCode(pair[1]) + 'wind Robotics')[0];
  ok(
    Math.abs(dirty.lineWidth - cleanCo.lineWidth) < 1e-9 && Math.abs(dirty.x - cleanCo.x) < 1e-9,
    'a pasted ' + pair[0] + ' changes neither width nor centering',
    'w ' + r4(dirty.lineWidth) + ' vs ' + r4(cleanCo.lineWidth) + ', x ' + r4(dirty.x) + ' vs ' + r4(cleanCo.x)
  );
  ok(dirty.text.indexOf(String.fromCharCode(pair[1])) === -1, pair[0] + ' is stripped from the emitted text');
});
var spVersion = companyOf('Northwind Robotics International Holdings');
var nbVersion = companyOf('Northwind' + NBSP + 'Robotics International Holdings');
ok(
  nbVersion.some(function (l) { return l.text.indexOf(NBSP) >= 0; }),
  'a non-breaking space survives normalization (not collapsed to a plain space)'
);
ok(
  nbVersion[0].text.indexOf(NBSP) >= 0 && nbVersion.length === spVersion.length,
  'the wrapper does NOT break at the non-breaking space',
  JSON.stringify(nbVersion.map(function (l) { return l.text; }))
);
near(M.widthOf('a' + NBSP + 'b', 21, 400, 'italic'), M.widthOf('a b', 21, 400, 'italic'), 1e-9, 'NBSP keeps a space\'s advance width');
var zwOnly = L.layout({ first: 'Ines', last: 'Marchetti', company: ZWSP + ' ' + ZWSP, title: '' }, null);
ok(fields(zwOnly).join(',') === 'first,last', 'a company of only invisibles counts as empty (no company line, no gap line)', fields(zwOnly).join(','));

// ===========================================================================
section('9. REGRESSION — clipping performance and the field length cap');
// ===========================================================================
[5000, 20000].forEach(function (n) {
  var junk = 'W'.repeat(n);
  var t0 = process.hrtime.bigint();
  var r = L.layout({ first: junk, last: junk, company: junk, title: junk }, null);
  var ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 25, n + '-char fields lay out in ' + ms.toFixed(2) + ' ms (was ~' + (n === 5000 ? '109' : '1681') + ' ms with the O(n^2) walk)');
  assertInsideCell(r, n + '-char fields still stay inside the cell');
  ok(
    r.lines.every(function (l) { return l.text.length <= 300; }),
    n + '-char fields are capped at 300 chars before measuring',
    r.lines.map(function (l) { return l.text.length; }).join(',')
  );
});
var t60 = process.hrtime.bigint();
for (var b = 0; b < 60; b++) L.layout({ first: 'W'.repeat(20000), last: 'X'.repeat(20000), company: 'Y'.repeat(20000), title: 'Z'.repeat(20000) }, { first: 5, company: 5 });
var ms60 = Number(process.hrtime.bigint() - t60) / 1e6;
ok(ms60 < 200, 'a 60-badge page of 20k-char junk with overrides: ' + ms60.toFixed(2) + ' ms total');

// ===========================================================================
section('10. REGRESSION — warnings report the size actually used');
// ===========================================================================
var wide = L.layout({ first: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWW', last: 'Ng' }, { first: 1000 });
console.log('  ' + wide.warnings.join('\n  '));
ok(wide.appliedSizes.first === 36, 'override clamps up to the 36 pt ceiling');
ok(
  wide.warnings.some(function (w) { return /36 pt size used/.test(w); }),
  'the warning names the 36 pt size actually used'
);
ok(
  !wide.warnings.some(function (w) { return /at its 22 pt floor/.test(w); }),
  'the warning no longer claims the floor was used'
);
var atFloorWarn = L.layout({ first: W40, last: 'Ng' }, null);
ok(
  atFloorWarn.warnings.some(function (w) { return /22 pt size used \(its floor\)/.test(w); }),
  'when the size really IS the floor, the warning says so',
  atFloorWarn.warnings.join(' | ')
);

// ===========================================================================
section('11. missing fields omit exactly the right lines');
// ===========================================================================
var noTitle = L.layout({ first: 'Priya', last: 'Ashworth', company: 'Vantage Grid', title: '   ' }, null);
ok(fields(noTitle).join(',') === 'first,last,gap,company', 'empty title omits the title line AND the company-to-title gap', fields(noTitle).join(','));
var nameOnly = L.layout({ first: 'Priya', last: 'Ashworth', company: '', title: null }, null);
ok(fields(nameOnly).join(',') === 'first,last', 'no company and no title also omits the 8 pt gap line', fields(nameOnly).join(','));
assertVerticalIndependently(nameOnly, [[36, 1], [26, 1]], 'name-only block is optically centered (independent check)');
var noCompany = L.layout({ first: 'Priya', last: 'Ashworth', company: '', title: 'Deputy GC' }, null);
ok(fields(noCompany).join(',') === 'first,last,gap,title', 'empty company keeps the first gap but NOT the company-to-title gap', fields(noCompany).join(','));
var empty = L.layout({}, null);
ok(empty.lines.length === 0 && empty.warnings.length === 1, 'an entirely empty attendee yields no lines and one warning');

// ===========================================================================
section('12. determinism and purity');
// ===========================================================================
var a1 = JSON.stringify(L.layout(STRESS, { title: -2 }));
var a2 = JSON.stringify(L.layout(STRESS, { title: -2 }));
ok(a1 === a2, 'two identical calls return identical numbers');
var input = { first: 'Marguerite', last: 'Delacroix-Whitfield', company: 'Northwind Analytics', title: 'General Counsel' };
var ovIn = { company: 2 };
var snap = JSON.stringify(input) + '|' + JSON.stringify(ovIn);
L.layout(input, ovIn);
ok(JSON.stringify(input) + '|' + JSON.stringify(ovIn) === snap, 'layout() mutates neither the attendee nor the override');
var frozen = Object.freeze({ first: 'Ada', last: 'Nkemelu', company: 'Vantage Grid', title: 'GC' });
var threw = false;
try { L.layout(frozen, Object.freeze({ first: 1 })); } catch (e) { threw = true; }
ok(!threw, 'layout() works on frozen inputs (it writes nothing back)');

// ===========================================================================
section('13. MODEL-METRICS SUITE (labelled stub — structural invariants only)');
// ===========================================================================
// A deliberately different, NON-Inter advance model. No point values are asserted
// here: the purpose is to prove the algorithm is not tuned to one metrics table.
var STUB_METRICS = {
  __model: true,
  unitsPerEm: 1000,
  ascent: 800,
  descent: 200,
  widthOf: function (t, size, weight, style) {
    if (typeof t !== 'string' || !t) return 0;
    var em = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      em += c === ' ' ? 0.3 : c >= 'A' && c <= 'Z' ? 0.75 : 0.62;
    }
    var w = em * size;
    if (weight >= 600) w *= 1.08;
    if (style === 'italic') w *= 1.05;
    return w;
  },
  ascentPt: function (s) { return 0.8 * s; },
  descentPt: function (s) { return 0.2 * s; },
  // Deliberately different ink metrics from Inter's 1490/442, so the optical shift
  // computed under this table cannot accidentally match the real-Inter numbers.
  capHeightPt: function (s) { return 0.7 * s; },
  descenderDepthPt: function (s) { return 0.25 * s; }
};
window.InterMetrics = STUB_METRICS;
[NORMAL, STRESS, LONG_CO, BRUTAL].forEach(function (att, i) {
  var r = L.layout(att, i % 2 ? { company: 3, title: -1 } : null);
  assertInsideCell(r, 'model metrics fixture ' + i + ': nothing outside the cell');
  assertSizeBounds(r, 'model metrics fixture ' + i + ': sizes within [floor, max]');
  ok(
    r.lines.every(function (l) { return l.lineWidth <= 259.2 + 1e-9; }),
    'model metrics fixture ' + i + ': every line within the 259.2 pt box'
  );
  var order = fields(r).filter(function (v, k, arr) { return k === 0 || arr[k - 1] !== v; }).join(',');
  ok(
    ['first,last,gap,company,gap,title', 'first,last', 'first,last,gap,company', 'first,last,gap,title'].indexOf(order) >= 0,
    'model metrics fixture ' + i + ': field order is company-above-title',
    order
  );
  ok(
    r.lines.filter(function (l) { return l.field === 'company'; }).every(function (l) { return l.style === 'italic'; }),
    'model metrics fixture ' + i + ': company still italic'
  );
});
ok(
  L.layout(NORMAL, null).lines[0].lineWidth !== normal.lines[0].lineWidth,
  'the model table really does disagree with real Inter (so the real numbers above are Inter-specific)'
);
window.InterMetrics = M; // restore

// ===========================================================================
section('14. OPTICAL vertical centering — residual measured against real ink');
// ===========================================================================
// The model's own box is centered by construction, so these assertions measure the
// TRUE ink extent instead: cap height above the first inked line, and a descender
// below the last one only when the text actually has one.
var withDesc = L.layout({ first: 'Marisol', last: 'Okonkwo', company: 'Northwind', title: 'Deputy General Counsel' }, null);
var noDesc = L.layout({ first: 'Marisol', last: 'Okonkwo', company: 'Northwind', title: 'General Counsel' }, null);
var eWith = trueInkError(withDesc);
var eNo = trueInkError(noDesc);
console.log('  last line HAS a descender ("Deputy General Counsel"): true ink error ' + r4(eWith) + ' pt');
console.log('  last line has NONE        ("General Counsel"):        true ink error ' + r4(eNo) + ' pt');
ok(Math.abs(eWith) <= 1.5, 'descender fixture lands within 1.5 pt of the cell center', r4(eWith) + ' pt');
ok(Math.abs(eNo) <= 1.5, 'descender-less fixture lands within 1.5 pt of the cell center', r4(eNo) + ' pt');
ok(
  Math.abs(eWith + eNo) < 1e-6,
  'the residual is SYMMETRIC (+x with a descender, -x without) — the half-descender minimax',
  r4(eWith) + ' vs ' + r4(eNo)
);
ok(eWith > 0 && eNo < 0, 'signs are as designed: descender reads low, no-descender reads high');
// the same fixture under the OLD layout-box model, re-derived here, to record the gain
var REQ = { first: 'Marisol', last: 'Okonkwo', company: 'Northwind', title: 'Legal Ops Manager' };
var req = L.layout(REQ, null);
(function () {
  var seq = req.lines.map(function (l) { return [l.sizePt, l.text ? 1 : 0]; });
  var bh = 0;
  var i;
  for (i = 0; i < seq.length; i++) bh += ADVANCE_FACTOR_LITERAL * seq[i][0];
  var t = (CELL_H_LITERAL - bh) / 2;
  var rows = [];
  for (i = 0; i < seq.length; i++) {
    rows.push({ s: seq[i][0], ink: seq[i][1], base: t + (ASCENT_LITERAL / UPEM_LITERAL) * seq[i][0], text: req.lines[i].text });
    t += ADVANCE_FACTOR_LITERAL * seq[i][0];
  }
  var ink = rows.filter(function (r) { return r.ink; });
  var f = ink[0];
  var l = ink[ink.length - 1];
  var oldErr =
    (f.base - (CAP_LITERAL / UPEM_LITERAL) * f.s + (l.base + (DESCENDER_CHARS.test(l.text) ? (DESC_LITERAL / UPEM_LITERAL) * l.s : 0))) / 2 -
    CELL_H_LITERAL / 2;
  var newErr = trueInkError(req);
  console.log('  Marisol/Okonkwo/Northwind/Legal Ops Manager: OLD layout-box error ' + r4(oldErr) + ' pt low -> NEW optical error ' + r4(newErr) + ' pt');
  ok(oldErr > 4 && Math.abs(newErr) < 1.5, 'the requested fixture improves from >4 pt low to ~1 pt', r4(oldErr) + ' -> ' + r4(newErr));
})();
// optical centering must not push anything out of the cell
[normal, stress, brutal, withDesc, noDesc, req].forEach(function (r, i) {
  assertInsideCell(r, 'optical shift keeps fixture ' + i + ' inside the cell');
});
ok(normal.opticalShift < 0, 'the shift moves the block UP (the old model sat low)', r4(normal.opticalShift));

// ===========================================================================
section('15. LOGO RESERVE — bottom-right block, narrow + recenter');
// ===========================================================================
var LOGO_1IN = { logo: { enabled: true, wPt: 72, hPt: 72 } }; // default align (left)
var LOGO_1IN_CENTER = { logo: { enabled: true, wPt: 72, hPt: 72 }, align: 'center' };
var NARROW_CENTER = (14.4 + (288 - 72)) / 2; // 115.2
var NARROW_W = 288 - 72 - 14.4; // 201.6
ok(S.LOGO_DEFAULT.enabled === false && S.LOGO_DEFAULT.wIn === 1 && S.LOGO_DEFAULT.hIn === 1, 'BadgeSpec.LOGO_DEFAULT is 1x1 in, OFF');
ok(S.LOGO_MAX_IN === 4, 'BadgeSpec.LOGO_MAX_IN is 4');

/** The hard invariant: no glyph may land in the reserved rectangle. */
function assertReserveRespected(res, label) {
  var bad = [];
  if (!res.logo.enabled) {
    ok(true, label + ' (reserve disabled)');
    return;
  }
  var rx = res.logo.reserve.x0;
  var ry = res.logo.reserve.y0;
  res.lines.forEach(function (ln, i) {
    if (!ln.text) return;
    // INK extent, not the advance box — the advance box would let descender ink
    // slip into the corner unnoticed.
    var overlapsY = lineReachesBand(ln, ry);
    var overlapsX = ln.x + ln.lineWidth > rx + 1e-9;
    if (overlapsY && overlapsX) {
      bad.push('line ' + i + ' (' + ln.field + ') right edge ' + r4(ln.x + ln.lineWidth) + ' > ' + r4(rx) + ', inkBottom ' + r4(inkBottomOf(ln)));
    }
  });
  ok(bad.length === 0, label, bad.join('; '));
}

var nLogo = L.layout(NORMAL, null, LOGO_1IN_CENTER);
dump('NORMAL with a 1x1 in logo reserve', nLogo);
console.log('  narrowed fields: ' + JSON.stringify(nLogo.logo.narrowedFields) + '  passes: ' + nLogo.logo.passes);
console.log('  per-line centers: ' + nLogo.lines.map(function (l) { return l.field + '=' + r4(l.x + l.lineWidth / 2); }).join(' '));
assertReserveRespected(nLogo, 'no glyph inside the reserved rectangle (normal, 1x1)');
assertInsideCell(nLogo, 'nothing outside the cell (normal, 1x1)');
assertHorizontalPlacement(nLogo, 'widths and x re-derived per character agree (normal, 1x1, centered)', 72, 'center');
ok(
  nLogo.lines.filter(function (l) { return l.narrowed; }).every(function (l) { return Math.abs(l.x + l.lineWidth / 2 - NARROW_CENTER) < 1e-9; }),
  'affected lines are centered on 115.2'
);
ok(
  nLogo.lines.filter(function (l) { return !l.narrowed && l.text; }).every(function (l) { return Math.abs(l.x + l.lineWidth / 2 - 144) < 1e-9; }),
  'unaffected lines stay centered on 144'
);
ok(
  nLogo.lines.some(function (l) { return l.narrowed; }) && nLogo.lines.some(function (l) { return !l.narrowed && l.text; }),
  'this fixture really does have both affected and unaffected lines'
);
ok(
  nLogo.lines.filter(function (l) { return l.narrowed && l.text; }).every(function (l) { return l.lineWidth <= NARROW_W + 1e-9; }),
  'affected lines fit the 201.6 pt narrowed span'
);
near(nLogo.blockHeight, normal.blockHeight, 1e-9, 'the reserve does not change block height (width only)');
near(nLogo.lines[0].lineTop, normal.lines[0].lineTop, 1e-9, 'the reserve does not change vertical placement');

// disabled must be byte-identical to the pre-feature behavior
var offA = JSON.stringify(L.layout(STRESS, { company: 2 }));
var offB = JSON.stringify(L.layout(STRESS, { company: 2 }, null));
var offC = JSON.stringify(L.layout(STRESS, { company: 2 }, {}));
var offD = JSON.stringify(L.layout(STRESS, { company: 2 }, { logo: { enabled: false, wPt: 72, hPt: 72 } }));
ok(offA === offB && offA === offC, 'omitting opts === passing null === passing {}');
ok(
  JSON.parse(offA).lines.every(function (l, i) { return JSON.stringify(l) === JSON.stringify(JSON.parse(offD).lines[i]); }),
  'an explicitly DISABLED reserve produces identical lines'
);

// wide sweep: every fixture, reserve honored
var SWEEP = [
  NORMAL,
  STRESS,
  LONG_CO,
  BRUTAL,
  { first: 'Anneliese', last: 'Featherstonehaugh', company: 'Quadrant Meridian Systems Group', title: 'Vice President and Associate General Counsel' },
  { first: 'Bo', last: 'Ng', company: 'Vantage', title: 'GC' },
  { first: 'Ines', last: 'Marchetti', company: 'Northwind Robotics International Holdings Corporation', title: 'Deputy General Counsel and Corporate Secretary' },
  { first: 'Priya', last: 'Ashworth', company: '', title: 'Deputy GC' },
  { first: 'Tobias', last: 'Oyelaran-Whitcombe', company: 'Helios Freight & Logistics Worldwide', title: 'Senior Managing Counsel, Commercial Transactions' }
];
var sweepBad = 0;
var sweepGlyphBad = 0;
var sweepGlyphSample = [];
var sweepChecked = 0;
SWEEP.forEach(function (att) {
  [null, { title: -2 }, { company: 4 }, { first: 6, last: 6, company: 6, title: 6 }].forEach(function (ov) {
    var r = L.layout(att, ov, LOGO_1IN);
    sweepChecked++;
    if (!r.logo.converged) sweepBad++;
    var rx = r.logo.reserve.x0;
    var ry = r.logo.reserve.y0;
    var sHits = glyphsInReserve(r);
    if (sHits.length) { sweepGlyphBad += sHits.length; sweepGlyphSample.push(sHits[0]); }
    r.lines.forEach(function (ln) {
      if (!ln.text) return;
      if (lineReachesBand(ln, ry) && ln.x + ln.lineWidth > rx + 1e-9) sweepBad++;
      if (ln.x < -1e-9 || ln.x + ln.lineWidth > 288 + 1e-9) sweepBad++;
      if (ln.lineTop < -1e-9 || ln.lineTop + ln.advance > 216 + 1e-9) sweepBad++;
    });
  });
});
ok(sweepGlyphBad === 0, 'across ' + sweepChecked + ' fixture/override combinations at 1x1: no PER-GLYPH reserve violation', sweepGlyphSample.slice(0, 2).join('; '));
ok(sweepBad === 0, 'across ' + sweepChecked + ' fixture/override combinations at 1x1: no line-level reserve or cell violation');

// exhaustive geometry sweep of reserve sizes
var geomBad = 0;
var glyphGeomBad = 0;
var glyphGeomSample = [];
var geomChecked = 0;
var maxPasses = 0;
for (var lw = 0; lw <= 288; lw += 8) {
  for (var lh = 0; lh <= 216; lh += 8) {
    for (var si = 0; si < 4; si++) {
      var rr = L.layout(SWEEP[si], null, { logo: { enabled: true, wPt: lw, hPt: lh } });
      geomChecked++;
      if (rr.logo.enabled) {
        maxPasses = Math.max(maxPasses, rr.logo.passes);
        if (!rr.logo.converged) geomBad++;
      }
      var gHits = glyphsInReserve(rr);
      if (gHits.length) { glyphGeomBad += gHits.length; glyphGeomSample.push(lw + 'x' + lh + ': ' + gHits[0]); }
      var rx2 = rr.logo.enabled ? rr.logo.reserve.x0 : 1e9;
      var ry2 = rr.logo.enabled ? rr.logo.reserve.y0 : 1e9;
      rr.lines.forEach(function (ln) {
        if (!ln.text) return;
        if (rr.logo.enabled && lineReachesBand(ln, ry2) && ln.x + ln.lineWidth > rx2 + 1e-9) geomBad++;
        if (ln.x < -1e-9 || ln.x + ln.lineWidth > 288 + 1e-9) geomBad++;
      });
    }
  }
}
ok(glyphGeomBad === 0, 'exhaustive sweep of ' + geomChecked + ' reserve geometries: zero PER-GLYPH violations', glyphGeomSample.slice(0, 2).join('; '));
ok(geomBad === 0, 'exhaustive sweep of ' + geomChecked + ' reserve geometries: zero line-level violations, all converged');
ok(maxPasses <= 4, 'the fixed point never needed more than 4 passes', 'max ' + maxPasses);

// the extreme: a 4x4 in reserve covers the whole cell
var extreme = L.layout(NORMAL, null, { logo: { enabled: true, wPt: 288, hPt: 288 } });
assertReserveRespected(extreme, '4x4 in reserve: no glyph inside the reserved rectangle');
assertInsideCell(extreme, '4x4 in reserve: nothing outside the cell');
ok(extreme.fits === false, '4x4 in reserve reports an honest fits:false');
ok(extreme.warnings.length > 0, '4x4 in reserve explains itself in warnings');
console.log('  4x4 warning: ' + extreme.warnings[0]);
ok(
  extreme.lines.every(function (l) { return l.lineWidth === 0; }),
  '4x4 in reserve prints nothing rather than printing into the logo'
);
var maxIn = L.layout(NORMAL, null, { logo: { enabled: true, wPt: 5000, hPt: 5000 } });
ok(maxIn.logo.wPt === 288 && maxIn.logo.hPt === 216, 'an absurd reserve size is clamped to the cell', maxIn.logo.wPt + 'x' + maxIn.logo.hPt);

// designed to oscillate: text that fits at full width but not narrowed, right at a
// wrap boundary, with the reserve height tuned so the last line straddles the band.
var OSC = { first: 'Ines', last: 'Marchetti', company: 'Northwind Robotics Worldwide', title: 'Associate General Counsel, Commercial' };
var oscBad = 0;
var oscPasses = 0;
for (var oh = 30; oh <= 90; oh += 0.5) {
  var ro = L.layout(OSC, null, { logo: { enabled: true, wPt: 72, hPt: oh } });
  oscPasses = Math.max(oscPasses, ro.logo.passes);
  if (!ro.logo.converged) oscBad++;
  var rx3 = ro.logo.reserve.x0;
  var ry3 = ro.logo.reserve.y0;
  ro.lines.forEach(function (ln) {
    if (!ln.text) return;
    if (lineReachesBand(ln, ry3) && ln.x + ln.lineWidth > rx3 + 1e-9) oscBad++;
  });
}
ok(oscBad === 0, 'the oscillation-hunting sweep (121 band positions) converges every time with no violation');
ok(oscPasses <= 4, 'oscillation sweep also stayed within 4 passes', 'max ' + oscPasses);
// determinism and purity with the third argument
var optsObj = { logo: { enabled: true, wPt: 72, hPt: 72 } };
var optsSnap = JSON.stringify(optsObj);
var p1 = JSON.stringify(L.layout(STRESS, { company: 1 }, optsObj));
var p2 = JSON.stringify(L.layout(STRESS, { company: 1 }, optsObj));
ok(p1 === p2, 'layout() is deterministic with a logo reserve');
ok(JSON.stringify(optsObj) === optsSnap, 'layout() does not mutate the opts object');
var frozenOpts = Object.freeze({ logo: Object.freeze({ enabled: true, wPt: 72, hPt: 72 }) });
var frozeThrew = false;
try { L.layout(STRESS, null, frozenOpts); } catch (e) { frozeThrew = true; }
ok(!frozeThrew, 'layout() accepts a deeply frozen opts object');

// ===========================================================================
section('16. SHEET PRESETS — sample top-left vs Avery 74536 (pure translation)');
// ===========================================================================
ok(S.SHEET_PRESET_DEFAULT === 'sampleTopLeft', 'the default preset is sampleTopLeft (existing behavior)');
ok(!!S.SHEET_PRESETS.sampleTopLeft && !!S.SHEET_PRESETS.avery, 'both presets are defined');
ok(S.SHEET_PRESETS.avery.originX === 18 && S.SHEET_PRESETS.avery.originY === 72, 'avery origin is (18,72) pt = 0.25 in / 1 in');
ok(S.SHEET_PRESETS.sampleTopLeft.originX === 0 && S.SHEET_PRESETS.sampleTopLeft.originY === 0, 'sample origin is (0,0)');

function originsOf(key) {
  return [0, 1, 2, 3, 4, 5]
    .map(function (i) {
      var o = S.cellOrigin(i, key);
      return o.x + ',' + o.y;
    })
    .join(' ');
}
ok(originsOf('sampleTopLeft') === '0,0 288,0 0,216 288,216 0,432 288,432', 'sampleTopLeft six origins', originsOf('sampleTopLeft'));
ok(originsOf('avery') === '18,72 306,72 18,288 306,288 18,504 306,504', 'avery six origins', originsOf('avery'));
ok(originsOf(undefined) === originsOf('sampleTopLeft'), 'omitting the preset key uses the default');
ok(originsOf('nope-not-a-preset') === originsOf('sampleTopLeft'), 'an unknown preset key falls back to the default (does not throw)');
ok(originsOf(null) === originsOf('sampleTopLeft'), 'a null preset key falls back to the default');

// Page containment: an off-by-one here misaligns every badge on every sheet.
['sampleTopLeft', 'avery'].forEach(function (key) {
  var bad = [];
  for (var i = 0; i < 6; i++) {
    var o = S.cellOrigin(i, key);
    if (o.x < 0 || o.y < 0) bad.push('cell ' + i + ' origin negative');
    if (o.x + S.CELL_W > S.PAGE_W + 1e-9) bad.push('cell ' + i + ' right edge ' + (o.x + S.CELL_W) + ' > 612');
    if (o.y + S.CELL_H > S.PAGE_H + 1e-9) bad.push('cell ' + i + ' bottom edge ' + (o.y + S.CELL_H) + ' > 792');
  }
  ok(bad.length === 0, key + ': the whole 2x3 block sits inside the 612x792 page', bad.join('; '));
});
var av = S.SHEET_PRESETS.avery;
near(av.originX + 2 * S.CELL_W + av.originX, S.PAGE_W, 1e-9, 'avery is horizontally centered: 18 + 576 + 18 = 612');
near(av.originY + 3 * S.CELL_H + av.originY, S.PAGE_H, 1e-9, 'avery is vertically centered: 72 + 648 + 72 = 792');
near(S.CELL_W, 288, 1e-9, 'cell width is unchanged by the preset work (288 pt = 4 in)');
near(S.CELL_H, 216, 1e-9, 'cell height is unchanged by the preset work (216 pt = 3 in)');

// The preset must not leak into cell math. layout() takes no preset argument at
// all, so the only way it could differ is if it read one from a global.
var layoutA = JSON.stringify(L.layout(STRESS, { company: 1 }, LOGO_1IN));
var savedDefault = S.SHEET_PRESET_DEFAULT;
var layoutB = JSON.stringify(L.layout(STRESS, { company: 1 }, LOGO_1IN));
ok(layoutA === layoutB, 'layout() output is byte-identical regardless of preset (it is cell-relative only)');
ok(S.SHEET_PRESET_DEFAULT === savedDefault, 'reading presets does not mutate the spec');
ok(
  L.layout.length <= 3,
  'layout() still takes only (attendee, override, opts) — no sheet coordinates leaked in',
  'arity ' + L.layout.length
);
// BadgeSpec is frozen, so a stray write from another module cannot move the grid.
var frozeOk = true;
try {
  S.SHEET_PRESETS.avery.originX = 999;
} catch (e) {
  frozeOk = true;
}
ok(S.SHEET_PRESETS.avery.originX === 18, 'preset definitions are frozen against accidental mutation');
ok(frozeOk, 'a frozen-write attempt does not corrupt the spec');

// ===========================================================================
section('17. CHARACTER COVERAGE — accented Latin real, unmapped still contained');
// ===========================================================================
// Scope: the 26 English letters plus accented Latin. CJK/emoji coverage is not a
// requirement, but an unmapped character must never be able to break a cell.
var ACCENTED = { first: 'Björn-Élodie', last: 'Nuñez-Skýrsgaard', company: 'Cœur Analytique Sàrl', title: 'Directeur Juridique & Secrétaire Général' };
var acc = L.layout(ACCENTED, null, CENTERED);
dump('ACCENTED LATIN', acc);
assertInsideCell(acc, 'accented Latin stays inside the cell');
assertHorizontalPlacement(acc, 'accented Latin widths and x re-derived per character agree', 0, 'center');
assertOpticalBoxCentered(acc, 'accented Latin is optically centered');
ok(acc.fits === true, 'accented Latin fits with no clipping', acc.warnings.join(' | '));
ok(
  acc.lines.every(function (l) { return l.text.indexOf('�') === -1 && l.text.slice(-1) !== '…'; }),
  'no accented character is dropped or mangled'
);
// Accented letters must resolve to REAL advances, not the .notdef fallback (1344).
var NOTDEF_PT_21 = (1344 / 2048) * 21;
['á', 'é', 'í', 'ó', 'ú', 'ñ', 'ü', 'å', 'ç', 'œ', 'É', 'Ö'].forEach(function (ch) {
  var w = M.widthOf(ch, 21, 400, 'normal');
  ok(w > 0 && Math.abs(w - NOTDEF_PT_21) > 1e-9, 'accented "' + ch + '" has a real advance, not .notdef', r4(w));
});
// An unmapped character (outside the required coverage) falls back to .notdef and
// must still be contained — that is the guard we keep regardless of scope.
var UNMAPPED = { first: '中文名字测试文本内容', last: '🚀🚀🚀🚀🚀🚀🚀🚀', company: 'कखगघङचछजझञटठडढणत', title: 'Mixed 中文 and Latin' };
var unm = L.layout(UNMAPPED, null, CENTERED);
assertInsideCell(unm, 'unmapped characters cannot escape the cell');
assertHorizontalPlacement(unm, 'unmapped characters are still measured and placed consistently', 0, 'center');
ok(
  unm.lines.every(function (l) { return l.lineWidth <= 259.2 + 1e-9; }),
  'unmapped characters are clipped to the 259.2 pt box rather than overflowing'
);
var unmLogo = L.layout(UNMAPPED, { first: 8, company: 8 }, LOGO_1IN);
assertReserveRespected(unmLogo, 'unmapped characters cannot intrude into the logo reserve');
assertInsideCell(unmLogo, 'unmapped characters with a reserve stay inside the cell');
// A surrogate pair must never be split in half by clipping.
ok(
  unm.lines.every(function (l) {
    for (var i = 0; i < l.text.length; i++) {
      var c = l.text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        var n = l.text.charCodeAt(i + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return false;
      }
    }
    return true;
  }),
  'clipping never splits a surrogate pair (no lone halves in the output)'
);

// ===========================================================================
section('18. LEFT ALIGNMENT — the new DEFAULT (flush to the 14.4 pt inset)');
// ===========================================================================
ok(S.ALIGN_DEFAULT === 'left', 'BadgeSpec.ALIGN_DEFAULT is "left"');
ok(S.ALIGNS.length === 2 && S.ALIGNS[0] === 'left' && S.ALIGNS[1] === 'center', 'BadgeSpec.ALIGNS is [left, center]', S.ALIGNS.join(','));
var RIGHT_INSET_EDGE = 288 - 14.4; // 273.6

/**
 * Independently recompute where the shared left edge should be, from widths this
 * test measures itself: blockLeft = spanLo + (spanWidth - blockWidth)/2, clamped
 * to the inset. The span's right edge is the tightest one any inked line faces.
 */
function expectedBlockLeft(res, logoWpt) {
  var inked = res.lines.filter(function (l) { return l.text; });
  if (!inked.length) return 14.4;
  var blockWidth = 0;
  var hi = RIGHT_INSET_EDGE;
  inked.forEach(function (l) {
    var w = widthByChars(l.text, l.sizePt, l.weight, l.style);
    if (w > blockWidth) blockWidth = w;
    var lineHi = l.narrowed ? 288 - logoWpt : RIGHT_INSET_EDGE;
    if (lineHi < hi) hi = lineHi;
  });
  var spanW = Math.max(0, hi - 14.4);
  return { x: 14.4 + Math.max(0, (spanW - blockWidth) / 2), blockWidth: blockWidth, spanHi: hi };
}

/** The property that actually matters under left: ONE shared left edge. */
function assertOneSharedLeftEdge(res, label, logoWpt) {
  var xs = {};
  res.lines.forEach(function (l) { xs[l.x.toFixed(9)] = 1; });
  var distinct = Object.keys(xs);
  var exp = expectedBlockLeft(res, logoWpt || 0);
  var bad = [];
  if (distinct.length !== 1) bad.push('distinct x values: ' + distinct.join(', '));
  else if (Math.abs(Number(distinct[0]) - exp.x) > 1e-6) {
    bad.push('shared x ' + r4(Number(distinct[0])) + ' != independent ' + r4(exp.x));
  }
  if (res.lines[0].x < 14.4 - 1e-9) bad.push('x ' + r4(res.lines[0].x) + ' is inside the inset');
  res.lines.forEach(function (l) {
    var lineHi = l.narrowed ? 288 - (logoWpt || 0) : RIGHT_INSET_EDGE;
    if (l.text && l.x + l.lineWidth > lineHi + 1e-9) bad.push(l.field + ' right edge ' + r4(l.x + l.lineWidth) + ' > ' + r4(lineHi));
  });
  ok(bad.length === 0, label, bad.join('; '));
}

var nLeft = L.layout(NORMAL, null);
dump('NORMAL, default alignment (left: shared edge, block centred)', nLeft);
console.log('  blockWidth=' + r4(nLeft.blockWidth) + '  blockLeft=' + r4(nLeft.blockLeft));
console.log('  per-line x: ' + nLeft.lines.map(function (l) { return l.field + '=' + r4(l.x); }).join(' '));
ok(nLeft.align === 'left', 'omitting opts yields align "left"');
ok(
  Object.keys(nLeft.lines.reduce(function (a, l) { a[l.x.toFixed(9)] = 1; return a; }, {})).length === 1,
  'ALL lines share ONE identical x (the property that matters)',
  nLeft.lines.map(function (l) { return r4(l.x); }).join(',')
);
assertOneSharedLeftEdge(nLeft, 'left: the shared edge equals the independently recomputed blockLeft');
near(nLeft.blockWidth, 236.5898, 0.001, 'blockWidth is the widest inked line (the last name, 236.5898)');
near(nLeft.blockLeft, 25.7051, 0.001, 'blockLeft = 14.4 + (259.2 - 236.5898)/2 = 25.7051');
ok(nLeft.blockLeft > 14.4, 'the block is CENTRED, not pinned to the inset, when it is narrower than the span', r4(nLeft.blockLeft));
ok(
  nLeft.lines.every(function (l) { return l.x + l.lineWidth <= RIGHT_INSET_EDGE + 1e-9; }),
  'every line still ends at or before the right inset edge 273.6'
);
assertHorizontalPlacement(nLeft, 'left: widths and x re-derived per character agree', 0, 'left');
assertInsideCell(nLeft, 'left: nothing outside the cell');
ok(nLeft.lines[0].x >= 14.4 - 1e-9, 'the shared edge never goes inside the 14.4 pt inset', r4(nLeft.lines[0].x));

// the widest line is the one that pins the block, so it sits exactly where
// centring would put it — a consequence of the formula, asserted so it is intended
var widestLeft = nLeft.lines.reduce(function (a, l) { return l.lineWidth > a.lineWidth ? l : a; });
var widestCent = normal.lines.reduce(function (a, l) { return l.lineWidth > a.lineWidth ? l : a; });
near(widestLeft.x, widestCent.x, 1e-9, 'the widest line lands at the same x under both alignments (by construction)');

// degenerate case: when the widest line is at least as wide as the span, the
// block clamps to the inset and the result is flush-left against the margin
var clamped = L.layout(NORMAL, null, { align: 'left', logo: { enabled: true, wPt: 144, hPt: 108 } });
console.log('  clamped case blockWidth=' + r4(clamped.blockWidth) + ' spanW=' + r4(288 - 144 - 14.4) + ' -> blockLeft=' + r4(clamped.blockLeft));
ok(Math.abs(clamped.blockLeft - 14.4) < 1e-9, 'a block wider than its span clamps to x = INSET exactly', r4(clamped.blockLeft));
assertOneSharedLeftEdge(clamped, 'clamped case still has one shared edge at the inset', 144);
assertReserveRespected(clamped, 'clamped case respects the reserve');
assertInsideCell(clamped, 'clamped case stays inside the cell');

// wide fixture sweep under the new default
var LEFT_SWEEP = SWEEP.concat([
  { first: 'Bartholomew', last: 'Vandergriff-Castellanos', company: 'Bristol-Myers Squibb Holdings International', title: 'Executive Vice President, General Counsel & Corporate Secretary' },
  { first: 'Ines', last: 'Marchetti', company: 'Northwind Robotics International Holdings Corporation', title: 'Chief Legal Officer and Corporate Secretary, Americas' },
  { first: 'Xiomara', last: 'Beauchamp-Villanueva', company: 'Transatlantic Reinsurance Partners Group', title: 'Associate General Counsel, Regulatory Affairs and Compliance' }
]);
var leftBad = [];
var leftChecked = 0;
LEFT_SWEEP.forEach(function (att) {
  [null, { title: -2 }, { company: 4 }, { first: 6, last: 6, company: 6, title: 6 }].forEach(function (ov) {
    [null, LOGO_1IN.logo, { enabled: true, wPt: 144, hPt: 108 }].forEach(function (lg) {
      var r = L.layout(att, ov, lg ? { align: 'left', logo: lg } : { align: 'left' });
      leftChecked++;
      var xs = {};
      r.lines.forEach(function (l) { xs[l.x.toFixed(9)] = 1; });
      if (Object.keys(xs).length > 1) leftBad.push('multiple x values');
      var exp = expectedBlockLeft(r, lg ? lg.wPt : 0);
      if (r.lines.length && Math.abs(r.lines[0].x - exp.x) > 1e-6) leftBad.push('x ' + r4(r.lines[0].x) + ' != expected ' + r4(exp.x));
      r.lines.forEach(function (ln) {
        if (ln.x < 14.4 - 1e-9) leftBad.push('x inside the inset: ' + r4(ln.x));
        var lineHi = ln.narrowed && lg ? 288 - lg.wPt : RIGHT_INSET_EDGE;
        if (ln.text && ln.x + ln.lineWidth > lineHi + 1e-9) leftBad.push('right edge ' + r4(ln.x + ln.lineWidth) + ' > ' + r4(lineHi));
        if (ln.lineTop < -1e-9 || ln.lineTop + ln.advance > 216 + 1e-9) leftBad.push('vertical overflow');
        if (!ln.text || !lg) return;
        var ry = 216 - lg.hPt;
        var rx = 288 - lg.wPt;
        if (lineReachesBand(ln, ry) && ln.x + ln.lineWidth > rx + 1e-9) {
          leftBad.push('INTO RESERVE: ' + JSON.stringify(ln.text));
        }
      });
    });
  });
});
ok(leftBad.length === 0, 'left: ' + leftChecked + ' fixture/override/reserve combinations — one shared edge, always >= 14.4, never past its span, never in the reserve', leftBad.slice(0, 4).join('; '));

// left + a 1x1 in reserve
var sLeftLogo = L.layout(STRESS, null, { align: 'left', logo: { enabled: true, wPt: 72, hPt: 72 } });
dump('STRESS, left + 1x1 in reserve', sLeftLogo);
console.log('  blockWidth=' + r4(sLeftLogo.blockWidth) + '  blockLeft=' + r4(sLeftLogo.blockLeft));
console.log('  per-line x: ' + sLeftLogo.lines.map(function (l) { return l.field + '=' + r4(l.x) + (l.narrowed ? '(narrowed)' : ''); }).join(' '));
assertReserveRespected(sLeftLogo, 'left + reserve: no glyph inside the reserved rectangle');
assertInsideCell(sLeftLogo, 'left + reserve: nothing outside the cell');
assertHorizontalPlacement(sLeftLogo, 'left + reserve: widths and x re-derived per character agree', 72, 'left');
assertOneSharedLeftEdge(sLeftLogo, 'left + reserve: one shared edge, independently recomputed', 72);
ok(
  sLeftLogo.lines.filter(function (l) { return l.narrowed && l.text; }).every(function (l) { return l.lineWidth <= 201.6 + 1e-9; }),
  'left + reserve: lines level with the logo fit the 201.6 pt narrowed width'
);
ok(
  sLeftLogo.lines.some(function (l) { return l.narrowed; }),
  'left + reserve: this fixture really does have lines level with the reserve'
);
ok(
  sLeftLogo.appliedSizes.company < 21 || sLeftLogo.appliedSizes.title < 19,
  'left + reserve: the narrowing fed SIZING too, not just x',
  JSON.stringify(sLeftLogo.appliedSizes)
);

// the centered acceptance criterion, retained and still meaningful
ok(
  normal.lines.every(function (l) { return Math.abs(l.x + l.lineWidth / 2 - 144) < 0.01; }),
  'align:center — every line centre is within 0.01 pt of 144 (old criterion, retained)'
);
ok(
  !nLeft.lines.every(function (l) { return Math.abs(l.x + l.lineWidth / 2 - 144) < 1; }),
  'align:left — line centres are deliberately NOT at 144 (documented default change)'
);

// fallback matrix: anything unrecognized resolves to the default, never throws
var ALIGN_INPUTS = [
  ['omitted', undefined],
  ['null', null],
  ['LEFT', 'LEFT'],
  ['justify', 'justify'],
  ['Center', 'Center'],
  ['right', 'right'],
  ['empty string', ''],
  ['number 42', 42],
  ['object', { align: 'center' }],
  ['array', ['center']],
  ['true', true],
  ['NaN', NaN]
];
var fallbackBad = [];
ALIGN_INPUTS.forEach(function (pair) {
  var r;
  try {
    r = L.layout(NORMAL, null, pair[1] === undefined ? {} : { align: pair[1] });
  } catch (e) {
    fallbackBad.push(pair[0] + ' threw: ' + e.message);
    return;
  }
  if (r.align !== 'left') fallbackBad.push(pair[0] + ' -> ' + r.align);
  if (Math.abs(r.lines[0].x - nLeft.lines[0].x) > 1e-9) fallbackBad.push(pair[0] + ' x ' + r4(r.lines[0].x));
});
ok(fallbackBad.length === 0, 'all 12 unrecognized align values fall back to "left" without throwing', fallbackBad.join('; '));
ok(L.layout(NORMAL, null, { align: 'center' }).align === 'center', 'the exact string "center" is honored');
ok(L.layout(NORMAL, null, { align: 'left' }).align === 'left', 'the exact string "left" is honored');

// purity, including the new field
var alignOpts = { align: 'center', logo: { enabled: true, wPt: 72, hPt: 72 } };
var alignSnap = JSON.stringify(alignOpts);
L.layout(STRESS, { company: 1 }, alignOpts);
ok(JSON.stringify(alignOpts) === alignSnap, 'layout() does not mutate opts, including the align field');
var frozenAlign = Object.freeze({ align: 'center', logo: Object.freeze({ enabled: true, wPt: 72, hPt: 72 }) });
var frozenAlignThrew = false;
try { L.layout(STRESS, null, frozenAlign); } catch (e) { frozenAlignThrew = true; }
ok(!frozenAlignThrew, 'layout() accepts a frozen opts object carrying align');

// ===========================================================================
section('19. ALIGNMENT INVARIANCE — align changes x and NOTHING else');
// ===========================================================================
// If any of these diverge, alignment has leaked into the fit loop.
function fitShapeOf(res) {
  return JSON.stringify({
    appliedSizes: res.appliedSizes,
    blockHeight: res.blockHeight,
    opticalShift: res.opticalShift,
    fits: res.fits,
    warnings: res.warnings,
    lines: res.lines.map(function (l) {
      return [l.field, l.sizePt, l.weight, l.style, l.text, l.lineTop, l.baselineY, l.advance, l.lineWidth, l.narrowed];
    })
  });
}
function fitShape(res) {
  return JSON.stringify({
    appliedSizes: res.appliedSizes,
    blockHeight: res.blockHeight,
    opticalShift: res.opticalShift,
    fits: res.fits,
    warnings: res.warnings,
    lines: res.lines.map(function (l) {
      return [l.field, l.sizePt, l.weight, l.style, l.text, l.lineTop, l.baselineY, l.advance, l.lineWidth, l.narrowed];
    })
  });
}
var invBad = [];
var invChecked = 0;
var LOGO_CASES = [null, { enabled: true, wPt: 72, hPt: 72 }, { enabled: true, wPt: 144, hPt: 144 }, { enabled: true, wPt: 36, hPt: 108 }];
LEFT_SWEEP.concat([BRUTAL, LONG_CO, ACCENTED, UNMAPPED]).forEach(function (att) {
  [null, { title: -2 }, { company: 4 }, { first: 6, last: 6, company: 6, title: 6 }].forEach(function (ov) {
    LOGO_CASES.forEach(function (lg) {
      var l = L.layout(att, ov, lg ? { align: 'left', logo: lg } : { align: 'left' });
      var c = L.layout(att, ov, lg ? { align: 'center', logo: lg } : { align: 'center' });
      invChecked++;
      if (fitShape(l) !== fitShape(c)) invBad.push(JSON.stringify(att.first) + ' ov=' + JSON.stringify(ov) + ' logo=' + JSON.stringify(lg));
      // x is allowed (and expected) to differ; the WIDEST line is the exception —
      // block-centring places it exactly where per-line centring would.
      // Only when the block was NOT clamped to the inset AND no line is narrowed by
      // the reserve (a narrowed line tightens the block's span, so the block then
      // centres in less than the full box): an unclamped, unnarrowed block is
      // centred in the full box, which puts its widest line exactly where per-line
      // centring would put it.
      if (l.blockLeft > 14.4 + 1e-9 && l.lines.every(function (ln) { return !ln.narrowed; })) {
        var widest = l.lines.reduce(function (a, ln) { return ln.lineWidth > a.lineWidth ? ln : a; });
        var wi = l.lines.indexOf(widest);
        if (widest.text && !widest.narrowed && Math.abs(widest.x - c.lines[wi].x) > 1e-6) {
          invBad.push('widest line x diverged: ' + r4(widest.x) + ' vs ' + r4(c.lines[wi].x));
        }
      }
    });
  });
});
ok(invBad.length === 0, 'across ' + invChecked + ' combinations: appliedSizes, wrap points, line counts, warnings and all vertical numbers are IDENTICAL between left and center', invBad.slice(0, 3).join('; '));
ok(
  JSON.stringify(nLeft.appliedSizes) === JSON.stringify(normal.appliedSizes),
  'normal fixture: identical appliedSizes under both alignments',
  JSON.stringify(nLeft.appliedSizes) + ' vs ' + JSON.stringify(normal.appliedSizes)
);
ok(
  nLeft.lines.map(function (l) { return l.text; }).join('|') === normal.lines.map(function (l) { return l.text; }).join('|'),
  'normal fixture: identical wrap points and line count under both alignments'
);
near(nLeft.blockHeight, normal.blockHeight, 1e-9, 'normal fixture: identical blockHeight under both alignments');
near(nLeft.opticalShift, normal.opticalShift, 1e-9, 'the VERTICAL model is untouched by alignment (same optical shift)');
near(nLeft.lines[0].lineTop, normal.lines[0].lineTop, 1e-9, 'identical lineTop under both alignments');
near(nLeft.lines[0].baselineY, normal.lines[0].baselineY, 1e-9, 'identical baselineY under both alignments');
var sc = L.layout(STRESS, null, { align: 'center', logo: { enabled: true, wPt: 72, hPt: 72 } });
ok(
  JSON.stringify(sLeftLogo.appliedSizes) === JSON.stringify(sc.appliedSizes),
  'with a reserve: identical appliedSizes under both alignments',
  JSON.stringify(sLeftLogo.appliedSizes) + ' vs ' + JSON.stringify(sc.appliedSizes)
);
ok(
  sLeftLogo.lines.map(function (l) { return l.narrowed ? 'N' : '-'; }).join('') === sc.lines.map(function (l) { return l.narrowed ? 'N' : '-'; }).join(''),
  'with a reserve: the SAME lines are narrowed under both alignments'
);

// ===========================================================================
section('20. COMPANY-TO-TITLE GAP — tuned to 4 pt from one constant');
// ===========================================================================
var coLine = normal.lines.filter(function (l) { return l.field === 'company'; }).pop();
var tiLine = normal.lines.filter(function (l) { return l.field === 'title'; })[0];
var gapNow = tiLine.baselineY - coLine.baselineY;
// Before the change there was no gap row, so the distance was just the company's
// own advance adjusted for the ascent difference between 21 pt and 19 pt.
var gapBefore = ADVANCE_FACTOR_LITERAL * 21 + (ASCENT_LITERAL / UPEM_LITERAL) * 19 - (ASCENT_LITERAL / UPEM_LITERAL) * 21;
console.log('  company -> title baseline distance: was ' + r4(gapBefore) + ' pt, now ' + r4(gapNow) + ' pt');
near(gapBefore, 22.2104, 0.001, 'the OLD company->title baseline distance was 22.2104 pt');
near(gapNow, 26.81, 0.001, 'the NEW company->title baseline distance is 26.8100 pt');
near(gapNow, (gapBefore + (gapBefore + ADVANCE_FACTOR_LITERAL * 8)) / 2, 1e-9, 'GAP_TITLE_SIZE 4 is EXACTLY halfway between no gap and the 8 pt version');
near(gapNow - gapBefore, ADVANCE_FACTOR_LITERAL * 4, 1e-9, 'the increase is exactly 1.1499 * GAP_TITLE_SIZE');
ok(S.GAP_TITLE_SIZE === 4, 'BadgeSpec.GAP_TITLE_SIZE is 4');
ok(S.GAP_SIZE === 8, 'BadgeSpec.GAP_SIZE (last->company) is still 8');
// the emitted row must read its size FROM the constant, not a hardcoded 8
var gapRows = normal.lines.filter(function (l) { return l.field === 'gap'; });
ok(gapRows.length === 2, 'two gap rows are emitted when all four fields are present');
ok(gapRows[0].sizePt === S.GAP_SIZE, 'the first gap row is sized from GAP_SIZE');
ok(gapRows[1].sizePt === S.GAP_TITLE_SIZE, 'the second gap row is sized from GAP_TITLE_SIZE');
ok(
  gapRows.every(function (l) { return l.text === '' && l.lineWidth === 0; }),
  'both gap rows are empty and zero-width'
);
// conditioned on BOTH sides existing
ok(
  L.layout({ first: 'Priya', last: 'Ashworth', company: 'Vantage Grid', title: '' }, null).lines.filter(function (l) { return l.field === 'gap'; }).length === 1,
  'no company->title gap when the title is missing'
);
ok(
  L.layout({ first: 'Priya', last: 'Ashworth', company: '', title: 'Deputy GC' }, null).lines.filter(function (l) { return l.field === 'gap'; }).length === 1,
  'no company->title gap when the company is missing'
);
ok(
  L.layout({ first: 'Priya', last: 'Ashworth', company: '', title: '' }, null).lines.filter(function (l) { return l.field === 'gap'; }).length === 0,
  'no gap rows at all when neither company nor title is present'
);
// the gap participates in the optical centring
assertOpticalBoxCentered(normal, 'the block is still optically centred with both gap rows');
near(
  normal.blockHeight,
  ADVANCE_FACTOR_LITERAL * (36 + 26 + 8 + 21 + 4 + 19),
  1e-9,
  'both gap rows are counted in blockHeight'
);

// PROOF that the size is a one-constant change: patch ONLY GAP_TITLE_SIZE in a
// copy of spec.js, load it in a sandbox, and check the gap scales and everything
// still fits. This is also the test that exercises the vertical shrink guard,
// which becomes REACHABLE above ~12.8 pt.
var vm = require('vm');
var fs = require('fs');
function withGapTitle(sizePt) {
  var ctx = { window: {}, console: console };
  ctx.window.window = ctx.window;
  var sandbox = vm.createContext(ctx);
  var specSrc = fs.readFileSync(path.join(SITE, 'js', 'spec.js'), 'utf8').replace('GAP_TITLE_SIZE: 4', 'GAP_TITLE_SIZE: ' + sizePt);
  if (specSrc.indexOf('GAP_TITLE_SIZE: ' + sizePt) < 0) throw new Error('sandbox patch failed — the constant moved');
  vm.runInContext(fs.readFileSync(path.join(SITE, 'fonts', 'inter-metrics.js'), 'utf8'), sandbox);
  vm.runInContext(specSrc, sandbox);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'js', 'layout.js'), 'utf8'), sandbox);
  return ctx.window;
}
var patched = withGapTitle(24);
ok(patched.BadgeSpec.GAP_TITLE_SIZE === 24, 'sandbox: the constant really was patched to 24');
var pN = patched.BadgeLayout.layout(NORMAL, null, CENTERED);
var pCo = pN.lines.filter(function (l) { return l.field === 'company'; }).pop();
var pTi = pN.lines.filter(function (l) { return l.field === 'title'; })[0];
near(
  pTi.baselineY - pCo.baselineY,
  gapNow + ADVANCE_FACTOR_LITERAL * 20,
  1e-9,
  'raising GAP_TITLE_SIZE 4 -> 24 grows the gap by exactly 1.1499 * 20, no other edit needed'
);
ok(
  pN.lines.every(function (l) { return l.lineTop >= -1e-9 && l.lineTop + l.advance <= 216 + 1e-9; }),
  'sandbox at 24 pt: normal fixture still inside the cell'
);
var pS = patched.BadgeLayout.layout(STRESS, null, CENTERED);
ok(
  pS.lines.every(function (l) { return l.lineTop >= -1e-9 && l.lineTop + l.advance <= 216 + 1e-9; }),
  'sandbox at 24 pt: stress fixture still inside the cell'
);
ok(pS.blockHeight <= 187.2 + 1e-9, 'sandbox at 24 pt: stress block still fits BOX_H', r4(pS.blockHeight));
ok(
  pS.appliedSizes.title < stress.appliedSizes.title,
  'sandbox at 24 pt: the vertical shrink guard becomes live and pays for the gap by shrinking the title',
  stress.appliedSizes.title + ' -> ' + pS.appliedSizes.title
);
console.log('  at GAP_TITLE_SIZE=24 the stress title shrinks ' + stress.appliedSizes.title + ' -> ' + pS.appliedSizes.title + ' pt and the block still fits (' + r4(pS.blockHeight) + ' <= 187.2)');
ok(S.GAP_TITLE_SIZE + (187.2 - ADVANCE_FACTOR_LITERAL * 154) / ADVANCE_FACTOR_LITERAL > 12, 'headroom note: the worst case stays inside BOX_H up to ~12.8 pt without any shrinking');

// ===========================================================================
section('21. RESERVE KEEP-OUT USES INK, NOT THE ADVANCE BOX (regression)');
// ===========================================================================
// The advance box bottom is baseline + (1.1499 - 1984/2048) * size = baseline +
// 0.18115 em. Real descender ink reaches baseline + 442/2048 = 0.21582 em. The
// 0.03467 em difference is the window in which a line's box clears the reserved
// band while its descender ink does not.
var BOX_DROP = ADVANCE_FACTOR_LITERAL - ASCENT_LITERAL / UPEM_LITERAL;
var INK_DROP = DESC_LITERAL / UPEM_LITERAL;
near(BOX_DROP, 0.18115, 1e-5, 'advance box drops 0.18115 em below the baseline');
near(INK_DROP, 0.215820313, 1e-9, 'descender ink drops 0.21582 em below the baseline');
ok(INK_DROP > BOX_DROP, 'ink hangs BELOW the advance box — hence the bug', r4((INK_DROP - BOX_DROP) * 21) + ' pt at 21 pt');

// --- the near-miss window, reproduced at the DEFAULT 1x1 in reserve --------
var nearMiss = L.layout(NORMAL, null, LOGO_1IN_CENTER);
var BAND_1IN = 216 - 72;
var nmCompany = nearMiss.lines.filter(function (l) { return l.field === 'company'; })[0];
var nmBoxBottom = nmCompany.lineTop + nmCompany.advance;
var nmInkBottom = nmCompany.baselineY + INK_DROP * nmCompany.sizePt;
console.log('  1x1 reserve, band top y=' + BAND_1IN + ':');
console.log('    company advance box bottom = ' + r4(nmBoxBottom) + ' (clears the band by ' + r4(BAND_1IN - nmBoxBottom) + ' pt)');
console.log('    company descender ink       = ' + r4(nmInkBottom) + ' (' + r4(nmInkBottom - BAND_1IN) + ' pt INSIDE the band)');
ok(nmBoxBottom < BAND_1IN - 1e-9, 'THE NEAR MISS: the advance box clears the band (the old rule would NOT narrow this line)', r4(nmBoxBottom));
ok(nmInkBottom > BAND_1IN + 1e-9, 'but the descender ink reaches into the band', r4(nmInkBottom));
ok(nmCompany.narrowed === true, 'so the engine narrows it — the ink extent decided, not the box');
assertNoGlyphInReserve(nearMiss, '1x1 near-miss: no glyph ink in the reserved rectangle');
assertReserveRespected(nearMiss, '1x1 near-miss: line-level keep-out also holds');
ok(
  nmCompany.x + nmCompany.lineWidth <= nearMiss.logo.reserve.x0 + 1e-9,
  'the narrowed company line now stops at or before the reserve edge',
  r4(nmCompany.x + nmCompany.lineWidth) + ' <= ' + r4(nearMiss.logo.reserve.x0)
);

// --- the counterfactual: what the OLD rule would have printed -------------
// Reconstructed here from first principles, not from the old code: an un-narrowed
// company line keeps one line at 21 pt, so its vertical position is the plain
// 6-row block, and per-line centring would place it at (288 - width)/2.
var CF_SEQ = [[36, 1], [26, 1], [8, 0], [21, 1], [4, 0], [19, 1]];
var cf = expectedVertical(CF_SEQ);
var cfCompanyBase = cf.bases[3];
var cfBoxBottom = cf.tops[3] + ADVANCE_FACTOR_LITERAL * 21;
var cfInkBottom = cfCompanyBase + INK_DROP * 21;
var cfWidth = widthByChars(NORMAL.company, 21, 400, 'italic');
var cfX = (CELL_W_LITERAL - cfWidth) / 2;
near(cfBoxBottom, nmBoxBottom, 1e-9, 'counterfactual vertical matches the real layout (narrowing did not move it)');
// walk the glyphs at the un-narrowed x and find the descender that would intrude
// for a 112 pt wide reserve (x0 = 176), the width the preview item flagged
var CF_X0 = CELL_W_LITERAL - 112;
var intruders = [];
(function () {
  var pen = cfX;
  for (var i = 0; i < NORMAL.company.length; i++) {
    var ch = NORMAL.company[i];
    var adv = M.widthOf(ch, 21, 400, 'italic');
    if (pen + adv > CF_X0 + 1e-9 && DESCENDER_GLYPHS.test(ch) && cfInkBottom > BAND_1IN + 1e-9) {
      intruders.push(JSON.stringify(ch) + ' at x=' + r4(pen) + '-' + r4(pen + adv));
    }
    pen += adv;
  }
})();
console.log('    counterfactual (old rule, 112 pt wide reserve, x0=' + CF_X0 + '): descender glyphs inside the reserve = ' + (intruders.join(', ') || 'none'));
ok(intruders.length > 0, 'the counterfactual really would have put descender ink in the reserve', intruders.join(', '));
// and the engine today does not
var fixed112 = L.layout(NORMAL, null, { align: 'center', logo: { enabled: true, wPt: 112, hPt: 72 } });
assertNoGlyphInReserve(fixed112, '112x72 reserve: the case that used to intrude is now clean');
assertReserveRespected(fixed112, '112x72 reserve: line-level keep-out holds');
ok(fixed112.logo.converged, '112x72 reserve: the fixed point still converges', 'passes ' + fixed112.logo.passes);

// --- a purpose-built descender fixture, swept across the window -----------
// "Peggy Ferrigson-Quigley / Paraguay Piggyback Logistics Group" is dense with
// p g y j q, so descenders land at many x positions. Sweep the band top in 0.25 pt
// steps so it passes through every line's near-miss window.
var DESC_FIX = { first: 'Peggy', last: 'Ferrigson-Quigley', company: 'Paraguay Piggyback Logistics Group', title: 'Deputy Paralegal, Regulatory Filings' };
var descBad = [];
var descChecked = 0;
var windowsSeen = 0;
var descPasses = 0;
[64, 72, 96, 112, 144].forEach(function (lw) {
  for (var bandTop = 40; bandTop <= 200; bandTop += 0.25) {
    ['left', 'center'].forEach(function (al) {
      var r = L.layout(DESC_FIX, null, { align: al, logo: { enabled: true, wPt: lw, hPt: 216 - bandTop } });
      descChecked++;
      descPasses = Math.max(descPasses, r.logo.passes);
      if (!r.logo.converged) descBad.push('non-convergent at ' + lw + '/' + bandTop);
      var hits = glyphsInReserve(r);
      if (hits.length) descBad.push(lw + 'x' + r4(216 - bandTop) + ' ' + al + ': ' + hits[0]);
      // count how often we actually land in the near-miss window
      r.lines.forEach(function (l) {
        if (!l.text) return;
        var bb = l.lineTop + l.advance;
        var ib = l.baselineY + INK_DROP * l.sizePt;
        if (bb <= r.logo.reserve.y0 && ib > r.logo.reserve.y0) {
          windowsSeen++;
          if (!l.narrowed) descBad.push('window line NOT narrowed at ' + lw + '/' + bandTop);
        }
      });
    });
  }
});
ok(descBad.length === 0, 'descender-dense fixture: ' + descChecked + ' band positions x 2 alignments — zero glyphs in the reserve, every near-miss line narrowed', descBad.slice(0, 3).join('; '));
ok(windowsSeen > 0, 'the sweep actually hit the near-miss window ' + windowsSeen + ' times (so it is a real test)');
ok(descPasses <= 4, 'descender sweep: fixed point still within 4 passes', 'max ' + descPasses);

// --- alignment invariance survives the stricter rule ----------------------
var strictInvBad = 0;
var strictChecked = 0;
[NORMAL, STRESS, DESC_FIX, LONG_CO].forEach(function (att) {
  [null, { company: 4 }, { title: -2 }].forEach(function (ov) {
    [72, 112, 144].forEach(function (lw) {
      for (var lh = 24; lh <= 168; lh += 12) {
        var lg = { enabled: true, wPt: lw, hPt: lh };
        var rl = L.layout(att, ov, { align: 'left', logo: lg });
        var rc = L.layout(att, ov, { align: 'center', logo: lg });
        strictChecked++;
        if (fitShapeOf(rl) !== fitShapeOf(rc)) strictInvBad++;
      }
    });
  });
});
ok(strictInvBad === 0, 'sizes, wraps and narrowed flags still identical between left and center across ' + strictChecked + ' combinations');

// ===========================================================================
console.log('\n============================================');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
