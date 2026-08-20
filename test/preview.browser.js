/*
 * test/preview.browser.js — BROWSER-ONLY assertions for js/preview.js (item 6).
 *
 * MUST BE LOADED IN A PAGE. This is not a node suite: `node preview.browser.js`
 * will throw on `window`. Open test/preview.browser.html, or run the node suite
 * in test/preview.test.js. Measuring rendered geometry needs a real layout engine,
 * a real Inter face and getBoundingClientRect, so this half cannot be faked.
 *
 * Runs INSIDE the real index.html (or preview.browser.html) against the real
 * BadgeStore / BadgeLayout / InterMetrics — not against stubs. Load it by
 * appending a <script src="test/preview.browser.js"> to the live page, then:
 *
 *     await window.PreviewTests.run(sixArray, fourteenArray)
 *
 * The two fixture arrays are passed in by the driver (test/preview.fixture.js,
 * generated from test/fixtures/six.json and fourteen.json) because this file is
 * not allowed to fetch anything.
 *
 * Every number reported is measured from the live DOM with
 * getBoundingClientRect() and converted back to points by dividing out
 * BadgePreview.SCALE. Invented names only.
 */
(function (window, document) {
  'use strict';

  var results = [];

  function ok(name, pass, detail) {
    results.push({ name: name, pass: !!pass, detail: detail });
    return !!pass;
  }

  /* Wait for the preview's coalesced repaint. Normally that is two animation
     frames; but a BACKGROUND / hidden tab never fires requestAnimationFrame, which
     would hang the whole suite, so race the frames against a timer. Every
     measurement below calls getBoundingClientRect(), which forces layout
     synchronously, so the timer path measures the same finished geometry. */
  function nextFrame() {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve();
      }
      requestAnimationFrame(function () { requestAnimationFrame(finish); });
      setTimeout(finish, 200); // longer than the preview's own 100 ms flush guard
    });
  }

  function scale() {
    return window.BadgePreview.SCALE;
  }

  function root() {
    return document.getElementById('preview-root');
  }

  function sheet() {
    return root().querySelector('.bp-sheet');
  }

  function cells() {
    return Array.prototype.slice.call(root().querySelectorAll('.bp-cell'));
  }

  function badgeCells() {
    return cells().filter(function (c) { return c.hasAttribute('data-attendee-id'); });
  }

  function nav() {
    var n = document.getElementById('page-nav');
    return {
      prev: n.querySelector('.bp-prev'),
      next: n.querySelector('.bp-next'),
      label: n.querySelector('.bp-nav-label'),
      meta: n.querySelector('.bp-nav-meta')
    };
  }

  /* Rect of an element expressed in POINTS relative to the sheet's top-left. */
  function ptRect(el) {
    var s = sheet().getBoundingClientRect();
    var r = el.getBoundingClientRect();
    var k = scale();
    return {
      left: (r.left - s.left) / k,
      right: (r.right - s.left) / k,
      top: (r.top - s.top) / k,
      bottom: (r.bottom - s.top) / k,
      width: r.width / k,
      height: r.height / k
    };
  }

  function linesIn(cell) {
    return Array.prototype.slice.call(cell.querySelectorAll('text.bp-line'));
  }

  function round(n, p) {
    var f = Math.pow(10, p === undefined ? 4 : p);
    return Math.round(n * f) / f;
  }

  async function load(list) {
    window.BadgeStore.setAttendees(list);
    await nextFrame();
  }

  async function setPage(i) {
    window.BadgeStore.setPageIndex(i);
    await nextFrame();
  }

  /* ------------------------------------------------------------------ tests */

  async function test1_sixBadgesOneSheet(six) {
    await load(six);
    var sheets = root().querySelectorAll('.bp-sheet');
    var bc = badgeCells();
    var r = sheet().getBoundingClientRect();
    var ratio = r.width / r.height;
    var want = 612 / 792;
    var errPct = Math.abs(ratio - want) / want * 100;

    ok('1a: exactly one sheet rendered', sheets.length === 1, { sheets: sheets.length });
    ok('1b: exactly 6 badges on the sheet', bc.length === 6, { badges: bc.length, cells: cells().length });
    ok('1c: sheet aspect ratio 612:792 within 0.5%', errPct < 0.5, {
      sheetPx: { w: round(r.width, 3), h: round(r.height, 3) },
      sheetPt: { w: round(r.width / scale(), 4), h: round(r.height / scale(), 4) },
      ratio: round(ratio, 6), want: round(want, 6), errorPct: round(errPct, 6)
    });
    return { sheetPx: { w: r.width, h: r.height } };
  }

  /*
   * Split by alignment (ADDENDUM 4/5). "Inside its own cell" is asserted under both
   * modes. The cell-centre check only applies under align:'center'; under the
   * 'left' default the assertion is that a badge's lines share ONE left edge and
   * that edge is the centred-block position, measured on screen.
   */
  async function test2_firstNameCells(six) {
    var expectOrigins = [[0, 0], [288, 0], [0, 216], [288, 216], [0, 432], [288, 432]];
    var canAlign = typeof window.BadgeStore.setAlign === 'function';
    var out = {};

    for (var ai = 0; ai < 2; ai++) {
      var align = ['left', 'center'][ai];
      if (!canAlign && align === 'center') break;
      await load(six);
      if (canAlign) await setAlign(align);
      var rows = [];
      var allInside = true;
      var worstCenterErr = 0;

      badgeCells().forEach(function (cell, i) {
        var ox = expectOrigins[i][0], oy = expectOrigins[i][1];
        var first = linesIn(cell).filter(function (t) {
          return t.getAttribute('data-field') === 'first'; })[0];
        var pr = ptRect(first);
        var adv = advanceCentre(first);          // cell-relative points
        var cellCenter = ox + 144;
        var measuredCenter = (pr.left + pr.right) / 2;
        var centerErr = Math.abs(measuredCenter - cellCenter);
        var inside = pr.left >= ox - 0.01 && pr.right <= ox + 288 + 0.01 &&
                     pr.top >= oy - 0.01 && pr.bottom <= oy + 216 + 0.01;
        if (!inside) allInside = false;
        if (centerErr > worstCenterErr) worstCenterErr = centerErr;
        rows.push({
          idx: i, name: first.textContent, cellOrigin: [ox, oy],
          measuredPt: { left: round(pr.left), right: round(pr.right),
                        top: round(pr.top), bottom: round(pr.bottom) },
          measuredXInCell: round(adv.left, 4),
          engineX: Number(first.getAttribute('data-x')),
          engineBaselineY: Number(first.getAttribute('data-baseline-y')),
          measuredCenter: round(measuredCenter), cellCenter: cellCenter,
          centerErrPt: round(centerErr, 5), insideCell: inside
        });
      });

      ok('2a.' + align + ': every first-name line inside its own 288x216 cell',
         allInside, rows);
      if (align === 'center') {
        ok('2b.center: first-name horizontal centre within 1 pt of cell centre',
           worstCenterErr < 1, { worstCenterErrPt: round(worstCenterErr, 5) });
      } else {
        /* ADDENDUM 5: not the inset — one shared edge per badge, at the
           centred-block position. */
        var edgeRows = [];
        var allOk = true;
        badgeCells().forEach(function (cell, i) {
          var r = checkSharedLeftEdge('badge ' + i, cell, null, edgeRows);
          if (!r.attrOk || !r.measuredOk) allOk = false;
        });
        ok('2b.left: every badge shares ONE left edge at the centred-block position',
           allOk, edgeRows);
      }
      out[align] = rows;
    }

    /* Leave the default in place for the tests that follow. */
    if (canAlign) await setAlign('left');
    return out;
  }

  async function test3_engineEquality(six, align) {
    await load(six);
    if (align && typeof window.BadgeStore.setAlign === 'function') await setAlign(align);
    var tag = align ? '3[' + align + ']' : '3';
    var overrides = window.BadgeStore.getOverrides();
    var attendees = window.BadgeStore.getAttendees();
    var opts = window.BadgePreview.layoutOpts();   // the live logo + align settings
    var mismatches = [];
    var compared = 0;

    badgeCells().forEach(function (cell, i) {
      var a = attendees[i];
      var expect = window.BadgeLayout.layout(a, overrides[a.id] || null, opts);
      var got = linesIn(cell);
      if (got.length !== expect.lines.length) {
        mismatches.push({ cell: i, why: 'line count', dom: got.length, engine: expect.lines.length });
        return;
      }
      expect.lines.forEach(function (ln, j) {
        var el = got[j];
        var checks = [
          ['x', String(ln.x), el.getAttribute('x')],
          ['x', String(ln.x), el.getAttribute('data-x')],
          ['baselineY', String(ln.baselineY), el.getAttribute('y')],
          ['baselineY', String(ln.baselineY), el.getAttribute('data-baseline-y')],
          ['lineTop', String(ln.lineTop), el.getAttribute('data-line-top')],
          ['advance', String(ln.advance), el.getAttribute('data-advance')],
          ['sizePt', String(ln.sizePt), el.getAttribute('font-size')],
          ['weight', String(ln.weight), el.getAttribute('font-weight')],
          ['style', String(ln.style), el.getAttribute('font-style')],
          ['field', String(ln.field), el.getAttribute('data-field')],
          ['text', String(ln.text), el.textContent]
        ];
        checks.forEach(function (c) {
          compared++;
          if (c[1] !== c[2]) {
            mismatches.push({ cell: i, line: j, prop: c[0], engine: c[1], dom: c[2] });
          }
        });
      });
    });

    ok(tag + ': every rendered line matches BadgeLayout.layout() exactly',
       mismatches.length === 0,
       { valuesCompared: compared, mismatches: mismatches.slice(0, 12), align: opts.align });

    /* Extra: the ADVANCE width the browser actually used vs the engine's own
       measurement. This is what proves the browser is neither re-laying-out nor
       kerning the text. Measured with getEndPositionOfChar/getStartPositionOfChar,
       i.e. real pen positions — not getBoundingClientRect, whose box also contains
       the ink that overhangs the advance (an italic 'g' or 't' leans past its own
       advance by up to ~0.2 pt at 21 pt; that is glyph shape, not layout drift, and
       pdf-lib places the same glyph at the same pen position). The overhang is
       reported below so it is visible rather than hidden. */
    var worstAdvErr = 0, worstAt = null, worstOverhang = 0, overhangAt = null;
    badgeCells().forEach(function (cell, i) {
      linesIn(cell).forEach(function (el) {
        if (el.hasAttribute('data-empty')) return;
        var engineW = Number(el.getAttribute('data-line-width'));
        var n = el.textContent.length;
        var advW = el.getEndPositionOfChar(n - 1).x - el.getStartPositionOfChar(0).x;
        var err = Math.abs(advW - engineW);
        if (err > worstAdvErr) {
          worstAdvErr = err;
          worstAt = { cell: i, field: el.getAttribute('data-field'), text: el.textContent,
                      engineWidthPt: round(engineW), renderedAdvancePt: round(advW) };
        }
        var box = el.getBoundingClientRect().width / scale();
        if (box - advW > worstOverhang) {
          worstOverhang = box - advW;
          overhangAt = { field: el.getAttribute('data-field'),
                         style: el.getAttribute('font-style'), text: el.textContent };
        }
      });
    });
    ok(tag + 'b: rendered advance width matches engine measurement within 0.05 pt',
       worstAdvErr < 0.05, { worstErrPt: round(worstAdvErr, 5), worstAt: worstAt,
       worstInkOverhangBeyondAdvancePt: round(worstOverhang, 5), overhangAt: overhangAt });
    return { align: opts.align, compared: compared,
             worstAdvanceErrPt: round(worstAdvErr, 5),
             worstInkOverhangPt: round(worstOverhang, 5),
             mismatches: mismatches.length };
  }

  async function test4_pagination(fourteen) {
    await load(fourteen);
    await setPage(0);
    var out = { pages: [] };
    var n = nav();

    ok('4a: nav reports 3 pages for 14 attendees', n.label.textContent === 'Page 1 of 3',
       { label: n.label.textContent, storePages: window.BadgePreview.getState().pages });
    ok('4b: Previous disabled on page 1', n.prev.disabled === true && n.next.disabled === false,
       { prev: n.prev.disabled, next: n.next.disabled });
    out.pages.push({ label: n.label.textContent, badges: badgeCells().length,
                     names: badgeCells().map(function (c) {
                       return c.querySelector('text[data-field="first"]').textContent; }) });
    ok('4c: page 1 shows 6 badges', badgeCells().length === 6, { badges: badgeCells().length });

    n.next.click();
    await nextFrame();
    n = nav();
    ok('4d: Next moved to page 2', n.label.textContent === 'Page 2 of 3', { label: n.label.textContent });
    ok('4e: page 2 shows 6 badges', badgeCells().length === 6, { badges: badgeCells().length });
    ok('4f: both buttons enabled on the middle page',
       n.prev.disabled === false && n.next.disabled === false,
       { prev: n.prev.disabled, next: n.next.disabled });
    out.pages.push({ label: n.label.textContent, badges: badgeCells().length,
                     names: badgeCells().map(function (c) {
                       return c.querySelector('text[data-field="first"]').textContent; }) });

    n.next.click();
    await nextFrame();
    n = nav();
    ok('4g: Next moved to page 3', n.label.textContent === 'Page 3 of 3', { label: n.label.textContent });
    ok('4h: page 3 shows 2 badges', badgeCells().length === 2,
       { badges: badgeCells().length, emptyCells: cells().length - badgeCells().length });
    ok('4i: Next disabled on the last page', n.next.disabled === true && n.prev.disabled === false,
       { prev: n.prev.disabled, next: n.next.disabled });
    out.pages.push({ label: n.label.textContent, badges: badgeCells().length,
                     names: badgeCells().map(function (c) {
                       return c.querySelector('text[data-field="first"]').textContent; }) });

    /* Next while disabled must not move, then walk back with Previous. */
    n.next.click();
    await nextFrame();
    ok('4j: clicking a disabled Next does nothing', nav().label.textContent === 'Page 3 of 3',
       { label: nav().label.textContent });

    nav().prev.click();
    await nextFrame();
    ok('4k: Previous returns to page 2', nav().label.textContent === 'Page 2 of 3',
       { label: nav().label.textContent });
    nav().prev.click();
    await nextFrame();
    ok('4l: Previous returns to page 1 and disables itself',
       nav().label.textContent === 'Page 1 of 3' && nav().prev.disabled === true,
       { label: nav().label.textContent, prev: nav().prev.disabled });

    ok('4m: page index persisted through BadgeStore', window.BadgeStore.getPageIndex() === 0,
       { storeIndex: window.BadgeStore.getPageIndex() });
    return out;
  }

  async function test5_clampOnDelete(fourteen) {
    await load(fourteen);
    await setPage(2);
    var before = { label: nav().label.textContent, storeIndex: window.BadgeStore.getPageIndex() };

    /* Delete rows 7..14 through the store's own API, as the input panel would. */
    var keep = window.BadgeStore.getAttendees().slice(0, 6);
    window.BadgeStore.setAttendees(keep);
    await nextFrame();
    await nextFrame(); // the clamp write-back schedules one more paint

    var after = {
      label: nav().label.textContent,
      storeIndex: window.BadgeStore.getPageIndex(),
      badges: badgeCells().length,
      sheets: root().querySelectorAll('.bp-sheet').length
    };
    ok('5a: page index clamped to the last real page', after.storeIndex === 0, after);
    ok('5b: nav label follows the clamp', after.label === 'Page 1 of 1', after);
    ok('5c: no blank sheet — the visible page still has badges', after.badges === 6, after);

    /* And a partial shrink: 14 -> 8 while on page 3 should land on page 2. */
    await load(fourteen);
    await setPage(2);
    window.BadgeStore.setAttendees(window.BadgeStore.getAttendees().slice(0, 8));
    await nextFrame();
    await nextFrame();
    var partial = { label: nav().label.textContent, storeIndex: window.BadgeStore.getPageIndex(),
                    badges: badgeCells().length };
    ok('5d: 14 -> 8 attendees while on page 3 clamps to page 2 with 2 badges',
       partial.storeIndex === 1 && partial.label === 'Page 2 of 2' && partial.badges === 2, partial);

    /* Emptying the roster entirely must still show one blank sheet, not zero. */
    window.BadgeStore.setAttendees([]);
    await nextFrame();
    await nextFrame();
    var empty = { sheets: root().querySelectorAll('.bp-sheet').length,
                  badges: badgeCells().length, label: nav().label.textContent,
                  storeIndex: window.BadgeStore.getPageIndex(), meta: nav().meta.textContent };
    ok('5e: empty roster renders one empty sheet, Page 1 of 1, both buttons disabled',
       empty.sheets === 1 && empty.badges === 0 && empty.label === 'Page 1 of 1' &&
       nav().prev.disabled && nav().next.disabled, empty);
    return { before: before, after: after, partial: partial, empty: empty };
  }

  async function test6_hostileName() {
    var hostile = '<img src=x onerror=alert(1)>';
    window.alert_fired = false;
    var realAlert = window.alert;
    window.alert = function () { window.alert_fired = true; };
    await load([
      { id: 'h1', first: hostile, last: '</text><script>alert(2)<\/script>',
        title: '"><svg onload=alert(3)>', company: '&lt;b&gt;&amp; Co.' }
    ]);
    var cell = badgeCells()[0];
    var firstEl = cell.querySelector('text[data-field="first"]');
    var out = {
      imgElementsInPreview: root().querySelectorAll('img').length,
      svgOnloadElements: root().querySelectorAll('[onload]').length,
      scriptElementsInPreview: root().querySelectorAll('script').length,
      renderedFirstText: firstEl.textContent,
      renderedFirstTextLength: firstEl.textContent.length,
      allTextNodes: linesIn(cell).map(function (t) { return t.textContent; }),
      alertFired: window.alert_fired
    };
    window.alert = realAlert;

    ok('6a: no <img> element anywhere in the preview', out.imgElementsInPreview === 0, out);
    ok('6b: no <script> or onload handler injected', out.scriptElementsInPreview === 0 &&
       out.svgOnloadElements === 0, out);
    ok('6c: hostile first name renders as literal text (verbatim, possibly ellipsised)',
       firstEl.textContent.indexOf('<img src=x onerror=') === 0, out);
    ok('6d: nothing executed', out.alertFired === false, out);

    /* The first-name line above is ellipsised because BadgeLayout clips text that
       cannot fit 259.2 pt even at its 22 pt floor — that is the engine's decision,
       not the preview's. So assert character-exact equality against what the engine
       actually returned, and separately that a hostile string short enough to fit
       (the last-name line) survives completely verbatim. */
    var eng = window.BadgeLayout.layout(window.BadgeStore.getAttendees()[0], null);
    var domTexts = linesIn(cell).map(function (t) { return t.textContent; });
    var engTexts = eng.lines.map(function (l) { return String(l.text); });
    out.engineTexts = engTexts;
    out.lastNameVerbatim = domTexts[1];
    ok('6e: rendered text is character-exact with the engine output',
       JSON.stringify(domTexts) === JSON.stringify(engTexts),
       { dom: domTexts, engine: engTexts });
    ok('6f: a hostile string that fits renders 100% verbatim',
       domTexts[1] === '</text><script>alert(2)<\/script>',
       { rendered: domTexts[1], length: domTexts[1].length });
    return out;
  }

  async function test7_deadZones(six) {
    await load(six);
    var maxRight = -Infinity, maxBottom = -Infinity;
    var maxRightEngine = -Infinity, maxBottomEngine = -Infinity;
    var rightAt = null, bottomAt = null;

    badgeCells().forEach(function (cell, i) {
      var ox = Number(cell.getAttribute('data-cell-x'));
      var oy = Number(cell.getAttribute('data-cell-y'));
      linesIn(cell).forEach(function (el) {
        if (el.hasAttribute('data-empty')) return;       // the 8 pt gap line has no glyphs
        var pr = ptRect(el);                              // sheet-relative points
        if (pr.right > maxRight) { maxRight = pr.right; rightAt = { cell: i, field: el.getAttribute('data-field'), text: el.textContent }; }
        if (pr.bottom > maxBottom) { maxBottom = pr.bottom; bottomAt = { cell: i, field: el.getAttribute('data-field'), text: el.textContent }; }
        var ex = ox + Number(el.getAttribute('data-x')) + Number(el.getAttribute('data-line-width'));
        var ey = oy + Number(el.getAttribute('data-baseline-y'));
        if (ex > maxRightEngine) maxRightEngine = ex;
        if (ey > maxBottomEngine) maxBottomEngine = ey;
      });
    });

    var out = {
      rightmostTextEdgePt_measured: round(maxRight, 3),
      bottommostTextEdgePt_measured: round(maxBottom, 3),
      rightmostTextEdgePt_engine: round(maxRightEngine, 3),
      bottommostBaselinePt_engine: round(maxBottomEngine, 3),
      deadColumnStartsAtPt: 576, deadBandStartsAtPt: 648,
      rightmostAt: rightAt, bottommostAt: bottomAt
    };
    ok('7a: nothing rendered in the right 36 pt column (x > 576)', maxRight <= 576, out);
    ok('7b: nothing rendered in the bottom 144 pt band (y > 648)', maxBottom <= 648, out);
    return out;
  }

  async function test8_liveUpdates(six) {
    await load(six);
    var id = window.BadgeStore.getAttendees()[0].id;
    var before = badgeCells()[0].querySelector('text[data-field="first"]').textContent;

    window.BadgeStore.updateAttendee(id, { first: 'Anastasiya' });
    await nextFrame();
    var afterEdit = badgeCells()[0].querySelector('text[data-field="first"]').textContent;
    ok('8a: editing a field repaints that badge', afterEdit === 'Anastasiya',
       { before: before, after: afterEdit });

    window.BadgeStore.moveAttendee(id, 1);
    await nextFrame();
    var names = badgeCells().map(function (c) {
      return c.querySelector('text[data-field="first"]').textContent; });
    ok('8b: reordering repaints in the new order', names[1] === 'Anastasiya', { names: names });

    /* An override must move the sizes, and the DOM must follow the engine's new numbers. */
    var id2 = window.BadgeStore.getAttendees()[0].id;
    var sizeBefore = Number(badgeCells()[0].querySelector('text[data-field="first"]').getAttribute('font-size'));
    window.BadgeStore.setOverride(id2, { first: -8 });   // -8 steps of 0.5 pt = -4 pt
    await nextFrame();
    var sizeAfter = Number(badgeCells()[0].querySelector('text[data-field="first"]').getAttribute('font-size'));
    var engineAfter = window.BadgeLayout.layout(window.BadgeStore.getAttendees()[0], { first: -8 });
    ok('8c: an override changes the rendered size and still equals the engine',
       sizeAfter !== sizeBefore && sizeAfter === engineAfter.appliedSizes.first,
       { sizeBefore: sizeBefore, sizeAfter: sizeAfter, engine: engineAfter.appliedSizes.first });
    window.BadgeStore.setOverride(id2, null);
    await nextFrame();

    /* Deleting a row repaints with one fewer badge. */
    window.BadgeStore.removeAttendee(window.BadgeStore.getAttendees()[0].id);
    await nextFrame();
    ok('8d: deleting a row repaints with 5 badges', badgeCells().length === 5,
       { badges: badgeCells().length });
    return true;
  }

  /*
   * Per-GLYPH ink boxes for one rendered line, in cell-relative points. This is
   * what the reserve invariant is actually about — "no glyph may render inside the
   * reserved rectangle" — and it is materially tighter than the line's bounding
   * box in BOTH directions:
   *
   *   vertically:   getBoundingClientRect() returns the em box, padded to the
   *                 font's full ascent (0.96875 em) and descent. Real ink reaches
   *                 only cap height above the baseline, and only dips below it for
   *                 a character that actually has a descender. On the six-badge
   *                 fixture the em box of "Northwind Analytics" overlaps a 1 in
   *                 reserve band by 0.646 pt while no glyph of it comes near the
   *                 rectangle — measuring the em box produces a false alarm.
   *   horizontally: the descender that does dip below the band ('y', ink bottom
   *                 144.179) sits at x 197.6-209.4, and the glyphs that pass
   *                 x = 216 ('t','i','c','s') have no descender at all. Only a
   *                 per-glyph test can tell those apart.
   *
   * Cap height and descender depth come from InterMetrics — the same two metrics
   * the engine's optical centring uses, so this test and the layout agree on what
   * "ink" means.
   */
  /*
   * IS THIS RENDERED LINE LEVEL WITH THE RESERVE?
   *
   * Mirrors BadgeLayout's intersectsBand(), read off the DOM attributes:
   *     inkBottom = max(lineTop + advance, baselineY + descenderDepthPt(size))
   *     narrowed  = inkBottom > bandTop && lineTop < CELL_H
   * The descender term is the fix for the defect this suite surfaced — a line whose
   * advance box clears the band can still drop descender ink into the reserved
   * corner, so the keep-out uses the ink extent, at full depth (worst case).
   *
   * Every expectation below that depends on "is this line narrowed" goes through
   * here, so the assertions follow the rule instead of restating numbers.
   */
  function isNarrowedLine(el, rect) {
    if (!rect) return false;
    var M = window.InterMetrics;
    var size = Number(el.getAttribute('font-size'));
    var lineTop = Number(el.getAttribute('data-line-top'));
    var advance = Number(el.getAttribute('data-advance'));
    var baseline = Number(el.getAttribute('data-baseline-y'));
    var inkBottom = Math.max(lineTop + advance, baseline + M.descenderDepthPt(size));
    return inkBottom > rect.y0 + 1e-9 && lineTop < 216 - 1e-9;
  }

  var DESCENDER_RE = /[gjpqy,;()\[\]{}\/\\$]/;   // conservative: tails and dipping punctuation

  function glyphInkBoxes(el) {
    var txt = el.textContent;
    if (!txt) return [];
    var M = window.InterMetrics;
    var size = Number(el.getAttribute('font-size'));
    var baseline = Number(el.getAttribute('data-baseline-y'));
    var capTop = baseline - M.capHeightPt(size);
    var out = [];
    for (var i = 0; i < txt.length; i++) {
      if (txt[i] === ' ') continue;                 // a space paints nothing
      var e = el.getExtentOfChar(i);
      var descends = DESCENDER_RE.test(txt[i]);
      out.push({
        ch: txt[i],
        left: e.x,
        right: e.x + e.width,
        top: capTop,
        bottom: baseline + (descends ? M.descenderDepthPt(size) : 0),
        descends: descends
      });
    }
    return out;
  }

  /* Worst intrusion of any glyph of `el` into `rect` (negative = clearance). */
  function worstGlyphIntrusion(el, rect) {
    var worst = -Infinity, at = null;
    glyphInkBoxes(el).forEach(function (g) {
      if (g.right <= rect.x0 || g.bottom <= rect.y0) return;   // clear of the rect
      var into = Math.min(g.right - rect.x0, g.bottom - rect.y0);
      if (into > worst) { worst = into; at = g; }
    });
    return { worst: worst, at: at };
  }

  /*
   * ADDENDUM 5: under align:'left' the lines share one left edge and the BLOCK is
   * centred in the available span. Recomputed here from the widths the browser
   * actually laid out (pen advances), so it is an independent check:
   *     blockWidth = widest rendered line with text
   *     spanHi     = tightest right edge any inked line is subject to
   *     x          = INSET + max(0, (spanHi - INSET - blockWidth) / 2)
   */
  function expectedLeftX(cell, logo) {
    var INSET = 14.4;
    var CELL_W = 288, CELL_H = 216;
    var fullHi = CELL_W - INSET;
    var rect = (logo && logo.enabled)
      ? { y0: CELL_H - logo.hPt, y1: CELL_H, wPt: logo.wPt } : null;
    var blockWidth = 0, spanHi = fullHi, anyInk = false;
    linesIn(cell).forEach(function (t) {
      if (t.hasAttribute('data-empty')) return;      // gap lines carry no ink
      anyInk = true;
      var adv = advanceCentre(t);
      if (adv.width > blockWidth) blockWidth = adv.width;
      var narrowed = isNarrowedLine(t, rect);
      var hi = narrowed ? Math.min(CELL_W - rect.wPt, fullHi) : fullHi;
      if (hi < spanHi) spanHi = hi;
    });
    if (!anyInk) return { x: INSET, blockWidth: 0, spanHi: fullHi };
    return { x: INSET + Math.max(0, (spanHi - INSET - blockWidth) / 2),
             blockWidth: blockWidth, spanHi: spanHi };
  }

  /* One shared left edge per badge, at the centred-block position. Returns the
     measured shared x, or null when the lines disagree. */
  function checkSharedLeftEdge(tag, cell, logo, rows) {
    var xs = {};
    var measured = [];
    linesIn(cell).forEach(function (t) {
      xs[t.getAttribute('x')] = true;
      if (!t.hasAttribute('data-empty')) {
        measured.push({ field: t.getAttribute('data-field'),
                        x: round(advanceCentre(t).left, 4) });
      }
    });
    var distinct = Object.keys(xs);
    var exp = expectedLeftX(cell, logo);
    var attrOk = distinct.length === 1;
    var measuredOk = measured.every(function (m) { return Math.abs(m.x - exp.x) < 0.02; });
    if (rows) {
      rows.push({ tag: tag, distinctXAttributes: distinct,
                  expectedX: round(exp.x, 4), blockWidth: round(exp.blockWidth, 3),
                  spanHi: exp.spanHi, measured: measured });
    }
    return { attrOk: attrOk, measuredOk: measuredOk, exp: exp,
             sharedX: attrOk ? Number(distinct[0]) : null };
  }

  /* ---------------------------------------------------- 9. logo reserve ---- */
  /*
   * ADDENDUM 2 section C. The preview owns two things: threading the setting into
   * every layout() call, and drawing the reserve as a screen-only guide. The
   * narrowing itself is the engine's. Everything below is measured from the live
   * DOM in points.
   */
  async function setLogo(cfg) {
    window.BadgeStore.setLogo(cfg);
    await nextFrame();
    await nextFrame(); // logo:changed -> schedule -> paint
  }

  function guides(cell) {
    return Array.prototype.slice.call(cell.querySelectorAll('.bp-logo-guide'));
  }

  /**
   * A line's CENTRE as the engine defines it: the midpoint of the pen advance,
   * read back from the browser's own laid-out glyph positions (user units, i.e.
   * cell-relative points). NOT getBoundingClientRect — that box also contains ink
   * that overhangs the advance, which for an italic line shifts the apparent
   * centre by ~0.1 pt and would make an exact centring assertion lie.
   */
  function advanceCentre(el) {
    var n = el.textContent.length;
    if (!n) return null;
    var start = el.getStartPositionOfChar(0).x;
    var end = el.getEndPositionOfChar(n - 1).x;
    return { left: start, right: end, centre: (start + end) / 2, width: end - start };
  }

  async function test9_logoReserve(six) {
    var out = { supported: typeof window.BadgeStore.setLogo === 'function' };
    if (!out.supported) {
      ok('9: SKIPPED — BadgeStore.setLogo() is not available', true,
         { note: 'store item has not landed the logo setting yet' });
      return out;
    }

    await load(six);
    /* The 144 / 115.2 centres below are a CENTRED-alignment property, so set that
       mode explicitly instead of inheriting the (now left) default. A left-aligned
       pass over the same reserve follows at 9n. */
    if (typeof window.BadgeStore.setAlign === 'function') await setAlign('center');
    await setLogo({ enabled: false, wIn: 1, hIn: 1 });
    ok('9a: with the reserve off, no guide is drawn',
       root().querySelectorAll('.bp-logo-guide').length === 0,
       { guides: root().querySelectorAll('.bp-logo-guide').length });

    /* Capture the un-reserved centres so the shift is measured, not assumed. */
    var before = badgeCells().map(function (cell) {
      return linesIn(cell).filter(function (t) { return !t.hasAttribute('data-empty'); })
        .map(function (t) {
          var pr = ptRect(t);
          return { field: t.getAttribute('data-field'),
                   centre: round((pr.left + pr.right) / 2 -
                     Number(cell.getAttribute('data-cell-x')), 3) };
        });
    });

    // ---- turn it on: 1 in x 1 in --------------------------------------------
    await setLogo({ enabled: true, wIn: 1, hIn: 1 });
    var wPt = 72, hPt = 72;
    var rect = { x0: 288 - wPt, y0: 216 - hPt, x1: 288, y1: 216 };
    var narrowCentre = (14.4 + (288 - wPt)) / 2;   // 115.2
    out.reserve = rect;
    out.narrowCentre = narrowCentre;

    ok('9b: enabling the reserve re-rendered (a guide per cell)',
       root().querySelectorAll('.bp-logo-guide').length === 6,
       { guides: root().querySelectorAll('.bp-logo-guide').length,
         cells: cells().length });

    /* The guide's own geometry, in points, from the raw cell corner. */
    var gRows = [];
    var guideOk = true;
    cells().forEach(function (cell, i) {
      var g = guides(cell)[0];
      if (!g) { guideOk = false; return; }
      var cr = cell.getBoundingClientRect();
      var gr = g.getBoundingClientRect();
      var k = scale();
      var row = {
        cell: i,
        wPt: round((gr.width) / k, 3), hPt: round((gr.height) / k, 3),
        x0: round((gr.left - cr.left) / k, 3), y0: round((gr.top - cr.top) / k, 3),
        rightFlush: round((cr.right - gr.right) / k, 3),
        bottomFlush: round((cr.bottom - gr.bottom) / k, 3),
        position: getComputedStyle(g).position,
        pointerEvents: getComputedStyle(g).pointerEvents,
        insideSvg: !!g.closest('svg'),
        isTextNode: g.tagName.toLowerCase() === 'text'
      };
      if (Math.abs(row.wPt - wPt) > 0.05 || Math.abs(row.hPt - hPt) > 0.05 ||
          Math.abs(row.x0 - rect.x0) > 0.05 || Math.abs(row.y0 - rect.y0) > 0.05 ||
          row.position !== 'absolute' || row.insideSvg || row.isTextNode) guideOk = false;
      gRows.push(row);
    });
    ok('9c: guide is exactly the reserved rect, absolute, outside the <svg>', guideOk, gRows);
    out.guide = gRows[0];

    /* Zero geometric contribution, proved by removal: pull every guide out of the
       DOM and confirm no <text> box moved by even a hundredth of a pixel. */
    var boxesWith = [];
    badgeCells().forEach(function (cell) {
      linesIn(cell).forEach(function (t) {
        var r = t.getBoundingClientRect();
        boxesWith.push([r.left, r.top, r.width, r.height].join(','));
      });
    });
    var removed = root().querySelectorAll('.bp-logo-guide');
    var parents = [];
    Array.prototype.forEach.call(removed, function (g) {
      parents.push([g.parentNode, g]);
      g.parentNode.removeChild(g);
    });
    var boxesWithout = [];
    badgeCells().forEach(function (cell) {
      linesIn(cell).forEach(function (t) {
        var r = t.getBoundingClientRect();
        boxesWithout.push([r.left, r.top, r.width, r.height].join(','));
      });
    });
    parents.forEach(function (p) { p[0].appendChild(p[1]); });
    ok('9d: the guide contributes ZERO geometry (removing it moves nothing)',
       boxesWith.join('|') === boxesWithout.join('|'),
       { lines: boxesWith.length,
         firstDiff: boxesWith.find(function (b, i) { return b !== boxesWithout[i]; }) || null });

    /* The guide can never reach the PDF: it is not an SVG text node, carries no
       text, and lives outside the <svg> that holds all the drawn geometry. */
    ok('9e: no guide is inside the drawn <svg>, and none carries text',
       Array.prototype.every.call(root().querySelectorAll('.bp-logo-guide'), function (g) {
         return !g.closest('svg') && g.textContent === '';
       }), {});

    // ---- THE HARD INVARIANT + the centres ----------------------------------
    var worstIntrusion = -Infinity, intruder = null;
    var emBoxWorst = -Infinity;      // the old, over-padded measure, kept as a note
    var centreRows = [];
    var centresOk = true;
    badgeCells().forEach(function (cell, ci) {
      var ox = Number(cell.getAttribute('data-cell-x'));
      var oy = Number(cell.getAttribute('data-cell-y'));
      linesIn(cell).forEach(function (t) {
        if (t.hasAttribute('data-empty')) return;
        var pr = ptRect(t);
        var left = pr.left - ox, right = pr.right - ox;
        var top = pr.top - oy, bottom = pr.bottom - oy;
        var affected = isNarrowedLine(t, rect);

        /* HARD INVARIANT, per GLYPH — see glyphInkBoxes() for why the line's
           bounding box is the wrong instrument here. */
        var gi = worstGlyphIntrusion(t, rect);
        if (gi.worst > worstIntrusion) {
          worstIntrusion = gi.worst;
          intruder = { cell: ci, field: t.getAttribute('data-field'), text: t.textContent,
                       glyph: gi.at && gi.at.ch,
                       glyphBox: gi.at ? { left: round(gi.at.left, 2), right: round(gi.at.right, 2),
                                           top: round(gi.at.top, 2), bottom: round(gi.at.bottom, 2) }
                                       : null,
                       reserve: { x0: rect.x0, y0: rect.y0 } };
        }
        /* Diagnostic: how close the padded em box comes, for comparison. */
        if (bottom > rect.y0 && right - rect.x0 > emBoxWorst) {
          emBoxWorst = right - rect.x0;
        }

        /* CENTRING uses the ADVANCE, which is what the engine centres. */
        var adv = advanceCentre(t);
        var centre = adv.centre;
        var wantCentre = affected ? narrowCentre : 144;
        if (Math.abs(centre - wantCentre) > 0.02) centresOk = false;
        centreRows.push({ cell: ci, field: t.getAttribute('data-field'),
                          centre: round(centre, 3), want: wantCentre,
                          affected: affected,
                          advanceRight: round(adv.right, 3), inkRight: round(right, 3) });
      });
    });

    ok('9f: HARD INVARIANT — no rendered GLYPH intrudes into the reserve',
       worstIntrusion <= 0,
       { worstGlyphIntrusionPt: worstIntrusion === -Infinity ? 'no glyph in the rect'
           : round(worstIntrusion, 4), at: intruder, reserve: rect,
         note: 'the padded em box of a line reaches ' +
           (emBoxWorst === -Infinity ? 'nowhere near' : round(emBoxWorst, 3) + ' pt') +
           ' past x0, but that box is not ink — see glyphInkBoxes()' });
    ok('9g: affected lines centre on ' + narrowCentre + ' (advance), clear lines on 144',
       centresOk, centreRows);
    out.centres = centreRows;
    out.worstGlyphIntrusionPt = worstIntrusion === -Infinity ? null : round(worstIntrusion, 4);
    out.emBoxWorstPt = emBoxWorst === -Infinity ? null : round(emBoxWorst, 3);

    /* The measured shift the coordinator asked us to expect: 28.8 pt. */
    var shifts = centreRows.filter(function (r) { return r.affected; })
      .map(function (r) { return round(144 - r.centre, 3); });
    ok('9h: affected lines sit exactly 28.8 pt left of the name lines',
       shifts.length > 0 && shifts.every(function (s) { return Math.abs(s - 28.8) < 0.02; }),
       { shiftsPt: shifts, worstErrPt: round(Math.max.apply(null, shifts.map(function (s) {
           return Math.abs(s - 28.8); })), 5) });
    out.shiftPt = shifts[0];

    // ---- engine equality with the reserve ON -------------------------------
    var opts = window.BadgePreview.layoutOpts();   // live logo + align
    var overrides = window.BadgeStore.getOverrides();
    var attendees = window.BadgeStore.getAttendees();
    var mismatches = [], compared = 0;
    badgeCells().forEach(function (cell, i) {
      var a = attendees[i];
      var expect = window.BadgeLayout.layout(a, overrides[a.id] || null, opts);
      var got = linesIn(cell);
      if (got.length !== expect.lines.length) {
        mismatches.push({ cell: i, why: 'line count', dom: got.length,
                          engine: expect.lines.length });
        return;
      }
      expect.lines.forEach(function (ln, j) {
        var el = got[j];
        [['x', String(ln.x), el.getAttribute('x')],
         ['y', String(ln.baselineY), el.getAttribute('y')],
         ['font-size', String(ln.sizePt), el.getAttribute('font-size')],
         ['font-weight', String(ln.weight), el.getAttribute('font-weight')],
         ['font-style', String(ln.style), el.getAttribute('font-style')],
         ['data-line-top', String(ln.lineTop), el.getAttribute('data-line-top')],
         ['text', String(ln.text), el.textContent]
        ].forEach(function (c) {
          compared++;
          if (c[1] !== c[2]) {
            mismatches.push({ cell: i, line: j, prop: c[0], engine: c[1], dom: c[2] });
          }
        });
      });
    });
    ok('9i: engine equality still exact with the reserve enabled',
       mismatches.length === 0, { valuesCompared: compared, mismatches: mismatches.slice(0, 8) });
    out.equality = { compared: compared, mismatches: mismatches.length };

    // ---- the guide rides the existing guides toggle ------------------------
    window.BadgePreview.setGuides(false);
    await nextFrame();
    var hidden = getComputedStyle(root().querySelector('.bp-logo-guide')).display;
    window.BadgePreview.setGuides(true);
    await nextFrame();
    var shown = getComputedStyle(root().querySelector('.bp-logo-guide')).display;
    ok('9j: the reserve guide follows the cell-guides toggle',
       hidden === 'none' && shown !== 'none', { guidesOff: hidden, guidesOn: shown });

    // ---- resize, then turn it off again ------------------------------------
    await setLogo({ wIn: 1.5, hIn: 0.5 });
    var g2 = root().querySelector('.bp-logo-guide');
    var gr2 = g2.getBoundingClientRect();
    ok('9k: resizing to 1.5 x 0.5 in re-renders the guide at 108 x 36 pt',
       Math.abs(gr2.width / scale() - 108) < 0.05 &&
       Math.abs(gr2.height / scale() - 36) < 0.05,
       { wPt: round(gr2.width / scale(), 3), hPt: round(gr2.height / scale(), 3) });

    /* 9n: the same hard invariant under LEFT alignment. Lines stay on the inset,
       and any line meeting the reserved band must still stop short of it. */
    if (typeof window.BadgeStore.setAlign === 'function') {
      await setLogo({ enabled: true, wIn: 1, hIn: 1 });
      await setAlign('left');
      var leftWorst = -Infinity, leftAt = null, xOk = true, leftRows = [];
      var liveLogo = window.BadgePreview.logoPt();
      badgeCells().forEach(function (cell, ci) {
        var ox = Number(cell.getAttribute('data-cell-x'));
        var oy = Number(cell.getAttribute('data-cell-y'));
        var shared = checkSharedLeftEdge('badge ' + ci, cell, liveLogo, null);
        if (!shared.attrOk || !shared.measuredOk) xOk = false;
        linesIn(cell).forEach(function (t) {
          if (t.hasAttribute('data-empty')) return;
          var adv = advanceCentre(t);
          var gi = worstGlyphIntrusion(t, rect);
          if (gi.worst > leftWorst) {
            leftWorst = gi.worst;
            leftAt = { cell: ci, field: t.getAttribute('data-field'), text: t.textContent,
                       glyph: gi.at && gi.at.ch };
          }
          if (ci === 0) leftRows.push({ field: t.getAttribute('data-field'),
                                        x: round(adv.left, 4), right: round(adv.right, 3),
                                        expectedX: round(shared.exp.x, 4),
                                        spanHi: shared.exp.spanHi });
        });
      });
      ok('9n.left: one shared left edge at the centred-block position, with the ' +
         'reserve narrowing the span', xOk, leftRows);
      ok('9n.left: HARD INVARIANT still holds — no glyph enters the reserve',
         leftWorst <= 0, { worstGlyphIntrusionPt: leftWorst === -Infinity
           ? 'no glyph in the rect' : round(leftWorst, 4), at: leftAt, reserve: rect });
      out.leftAligned = { worstGlyphIntrusionPt: leftWorst === -Infinity ? null
                            : round(leftWorst, 4), lines: leftRows };
      await setAlign('center');
    }

    await setLogo({ enabled: false });
    var after = badgeCells().map(function (cell) {
      return linesIn(cell).filter(function (t) { return !t.hasAttribute('data-empty'); })
        .map(function (t) {
          var pr = ptRect(t);
          return { field: t.getAttribute('data-field'),
                   centre: round((pr.left + pr.right) / 2 -
                     Number(cell.getAttribute('data-cell-x')), 3) };
        });
    });
    ok('9l: turning the reserve off removes every guide',
       root().querySelectorAll('.bp-logo-guide').length === 0,
       { guides: root().querySelectorAll('.bp-logo-guide').length });
    ok('9m: geometry returns exactly to the un-reserved layout',
       JSON.stringify(before) === JSON.stringify(after),
       { before: before[0], after: after[0] });
    if (typeof window.BadgeStore.setAlign === 'function') await setAlign('left');
    return out;
  }

  /* --------------------------------------------------- 10. sheet preset ---- */
  /*
   * ADDENDUM 3. The same 2x3 grid, in one of two places on the same 612x792 sheet.
   * Measured here from the live DOM: cell rectangles relative to the sheet, the
   * margins around the block, and the absolute position of every rendered <text>
   * (which must equal the engine's cell-relative number PLUS the cell offset —
   * the anti-divergence property has to survive the translation).
   */
  var PRESET_EXPECT = {
    sampleTopLeft: { originX: 0, originY: 0,
                     cells: [[0, 0], [288, 0], [0, 216], [288, 216], [0, 432], [288, 432]] },
    avery: { originX: 18, originY: 72,
             cells: [[18, 72], [306, 72], [18, 288], [306, 288], [18, 504], [306, 504]] }
  };

  async function setAlign(mode) {
    window.BadgeStore.setAlign(mode);
    await nextFrame();
    await nextFrame(); // align:changed -> schedule -> paint
  }

  async function setPreset(key) {
    window.BadgeStore.setSheetPreset(key);
    await nextFrame();
    await nextFrame(); // sheet:changed -> schedule -> paint
  }

  async function measurePreset(key) {
    var s = sheet().getBoundingClientRect();
    var k = scale();
    var rows = cells().map(function (cell, i) {
      var r = cell.getBoundingClientRect();
      return {
        cell: i,
        x: round((r.left - s.left) / k, 3), y: round((r.top - s.top) / k, 3),
        wPt: round(r.width / k, 3), hPt: round(r.height / k, 3)
      };
    });
    var last = rows[rows.length - 1];
    return {
      preset: sheet().getAttribute('data-sheet-preset'),
      sheetPt: { w: round(s.width / k, 3), h: round(s.height / k, 3) },
      cells: rows,
      margins: {
        left: rows[0].x, top: rows[0].y,
        right: round(s.width / k - (last.x + last.wPt), 3),
        bottom: round(s.height / k - (last.y + last.hPt), 3)
      }
    };
  }

  async function test10_sheetPreset(six) {
    var out = { supported: typeof window.BadgeStore.setSheetPreset === 'function' };
    if (!out.supported) {
      ok('10: SKIPPED — BadgeStore.setSheetPreset() is not available', true,
         { note: 'store item has not landed the sheet preset yet' });
      return out;
    }

    await load(six);
    if (typeof window.BadgeStore.setLogo === 'function') {
      await setLogo({ enabled: false });
    }

    for (var pi = 0; pi < 2; pi++) {
      var key = ['sampleTopLeft', 'avery'][pi];
      var want = PRESET_EXPECT[key];
      await setPreset(key);
      var m = await measurePreset(key);
      out[key] = m;

      ok('10.' + key + ': sheet is tagged with the preset', m.preset === key,
         { tagged: m.preset });
      ok('10.' + key + ': sheet outline is still 612 x 792 pt',
         Math.abs(m.sheetPt.w - 612) < 0.05 && Math.abs(m.sheetPt.h - 792) < 0.05, m.sheetPt);

      var cellsOk = true;
      m.cells.forEach(function (c, i) {
        if (Math.abs(c.x - want.cells[i][0]) > 0.05 ||
            Math.abs(c.y - want.cells[i][1]) > 0.05 ||
            Math.abs(c.wPt - 288) > 0.05 || Math.abs(c.hPt - 216) > 0.05) cellsOk = false;
      });
      ok('10.' + key + ': all six cells at the expected sheet coordinates, still 288x216',
         cellsOk, { measured: m.cells, expected: want.cells });

      /* The block must fit the page exactly. */
      var lastCell = m.cells[m.cells.length - 1];
      ok('10.' + key + ': block fits the page (' + m.margins.left + '+576+' +
         m.margins.right + ' across, ' + m.margins.top + '+648+' + m.margins.bottom + ' down)',
         Math.abs(m.margins.left + 576 + m.margins.right - 612) < 0.05 &&
         Math.abs(m.margins.top + 648 + m.margins.bottom - 792) < 0.05 &&
         m.margins.right >= -0.05 && m.margins.bottom >= -0.05,
         { margins: m.margins, lastCell: lastCell });

      if (key === 'avery') {
        ok('10.avery: margins are symmetric (18 / 18 across, 72 / 72 down)',
           Math.abs(m.margins.left - 18) < 0.05 && Math.abs(m.margins.right - 18) < 0.05 &&
           Math.abs(m.margins.top - 72) < 0.05 && Math.abs(m.margins.bottom - 72) < 0.05,
           m.margins);
      } else {
        ok('10.sampleTopLeft: leftover is all right (36 pt) and bottom (144 pt)',
           Math.abs(m.margins.left) < 0.05 && Math.abs(m.margins.top) < 0.05 &&
           Math.abs(m.margins.right - 36) < 0.05 && Math.abs(m.margins.bottom - 144) < 0.05,
           m.margins);
      }

      /* ANTI-DIVERGENCE ACROSS THE TRANSLATION: every rendered <text> must sit at
         the engine's cell-relative number plus this cell's sheet offset. */
      var opts = window.BadgePreview.layoutOpts();  // live logo + align
      var attendees = window.BadgeStore.getAttendees();
      var overrides = window.BadgeStore.getOverrides();
      var worstX = 0, worstY = 0, mismatches = 0, compared = 0;
      badgeCells().forEach(function (cell, i) {
        var ox = Number(cell.getAttribute('data-cell-x'));
        var oy = Number(cell.getAttribute('data-cell-y'));
        var expect = window.BadgeLayout.layout(attendees[i], overrides[attendees[i].id] || null, opts);
        var got = linesIn(cell);
        got.forEach(function (el, j) {
          var ln = expect.lines[j];
          if (!ln) { mismatches++; return; }
          compared++;
          // attribute equality (cell-relative), unaffected by the preset
          if (el.getAttribute('x') !== String(ln.x) ||
              el.getAttribute('y') !== String(ln.baselineY)) mismatches++;
          if (el.hasAttribute('data-empty')) return;
          // and the absolute on-sheet position = engine value + cell offset
          var adv = advanceCentre(el);
          var pr = ptRect(el);
          worstX = Math.max(worstX, Math.abs((pr.left - ox) - adv.left));
          worstY = Math.max(worstY, Math.abs((pr.top - oy) -
            (Number(el.getAttribute('data-baseline-y')) - window.InterMetrics.ascentPt(
              Number(el.getAttribute('font-size'))))));
        });
      });
      ok('10.' + key + ': rendered text still matches the engine exactly (cell-relative)',
         mismatches === 0, { compared: compared, mismatches: mismatches });
      ok('10.' + key + ': absolute sheet position = engine value + cell offset',
         worstX < 0.05, { worstXErrPt: round(worstX, 5), worstYErrPt: round(worstY, 5) });
      out[key].equality = { compared: compared, mismatches: mismatches,
                            worstXErrPt: round(worstX, 5) };
    }

    /* The measured translation between the two presets. */
    var dx = out.avery.cells[0].x - out.sampleTopLeft.cells[0].x;
    var dy = out.avery.cells[0].y - out.sampleTopLeft.cells[0].y;
    ok('10: switching to Avery shifts the whole block by exactly 18 / 72 pt ' +
       '(22.5 / 90 px)', Math.abs(dx - 18) < 0.05 && Math.abs(dy - 72) < 0.05,
       { dxPt: round(dx, 3), dyPt: round(dy, 3),
         dxPx: round(dx * scale(), 3), dyPx: round(dy * scale(), 3) });
    out.shift = { dxPt: round(dx, 3), dyPt: round(dy, 3) };

    /* Guides ride along with their cell. */
    if (typeof window.BadgeStore.setLogo === 'function') {
      await setPreset('avery');
      await setLogo({ enabled: true, wIn: 1, hIn: 1 });
      var g = root().querySelector('.bp-logo-guide');
      var gr = g.getBoundingClientRect();
      var sr = sheet().getBoundingClientRect();
      var gx = round((gr.left - sr.left) / scale(), 3);
      var gy = round((gr.top - sr.top) / scale(), 3);
      ok('10: the logo guide moves with its cell under Avery (18+216, 72+144)',
         Math.abs(gx - (18 + 216)) < 0.05 && Math.abs(gy - (72 + 144)) < 0.05,
         { guideSheetX: gx, guideSheetY: gy, expected: [234, 216] });
      await setLogo({ enabled: false });
    }

    /* Leave it on the default. */
    await setPreset('sampleTopLeft');
    ok('10: toggling back repaints at the default preset',
       sheet().getAttribute('data-sheet-preset') === 'sampleTopLeft' &&
       Math.abs(cells()[0].getBoundingClientRect().left -
                sheet().getBoundingClientRect().left) < 0.5,
       { preset: sheet().getAttribute('data-sheet-preset') });
    return out;
  }

  /* ----------------------------------------------- 11. text alignment ---- */
  /*
   * ADDENDUM 4. Sheet-wide 'left' (default) or 'center', carried in the same opts
   * object as the logo reserve. Measured from the live DOM: the actual x each line
   * is painted at, the engine-equality property under both modes, and the proof
   * that switching alignment moves x and nothing else.
   */
  function lineSnapshot() {
    return badgeCells().map(function (cell) {
      return linesIn(cell).map(function (t) {
        var adv = t.hasAttribute('data-empty') ? null : advanceCentre(t);
        return {
          field: t.getAttribute('data-field'),
          text: t.textContent,
          x: t.getAttribute('x'),
          y: t.getAttribute('y'),
          size: t.getAttribute('font-size'),
          weight: t.getAttribute('font-weight'),
          style: t.getAttribute('font-style'),
          lineTop: t.getAttribute('data-line-top'),
          advance: t.getAttribute('data-advance'),
          measuredX: adv ? round(adv.left, 4) : null,
          measuredRight: adv ? round(adv.right, 3) : null
        };
      });
    });
  }

  async function test11_alignment(six) {
    var out = { supported: typeof window.BadgeStore.setAlign === 'function' };
    if (!out.supported) {
      ok('11: SKIPPED — BadgeStore.setAlign() is not available', true,
         { note: 'store item has not landed the alignment setting yet' });
      return out;
    }

    await load(six);
    if (typeof window.BadgeStore.setLogo === 'function') await setLogo({ enabled: false });

    /* The default, straight from the store, with nothing set by us. */
    window.BadgeStore.clearAll();
    await nextFrame();
    await nextFrame();
    var defaultAlign = window.BadgePreview.getState().align;
    ok('11a: the default alignment is left', defaultAlign === 'left',
       { storeDefault: defaultAlign, specDefault: window.BadgeSpec.ALIGN_DEFAULT });

    await load(six);
    /* clearAll() above reset the reserve to its DEFAULT, which has been ON since
       2026-08-20 — and an enabled reserve narrows every line's span by 0.4 in, which
       is exactly what the centred-block expectations below are measured against.
       Switch it back off: this section is about ALIGNMENT, and section 9 owns the
       reserve. Without this the 11d/11g expectations are out by 28.8 pt. */
    if (typeof window.BadgeStore.setLogo === 'function') await setLogo({ enabled: false });
    await setAlign('left');
    var left = lineSnapshot();
    out.left = left[0];
    ok('11b: sheet is tagged with the alignment',
       sheet().getAttribute('data-align') === 'left',
       { tagged: sheet().getAttribute('data-align') });

    /* ADDENDUM 5: within a badge every line shares ONE left edge, and that edge is
       the centred-block position — NOT the inset. Different badges legitimately get
       different edges, because each block is centred on its own widest line. */
    var edgeRows = [], attrsOk = true, measuredOk = true, sharedXs = [];
    badgeCells().forEach(function (cell, i) {
      var r = checkSharedLeftEdge('badge ' + i, cell, null, edgeRows);
      if (!r.attrOk) attrsOk = false;
      if (!r.measuredOk) measuredOk = false;
      if (r.sharedX !== null) sharedXs.push(round(r.sharedX, 4));
    });
    var worstRight = -Infinity, worstXErr = 0;
    left.forEach(function (badge) {
      badge.forEach(function (l) {
        if (l.measuredX === null) return;
        worstRight = Math.max(worstRight, l.measuredRight);
      });
    });
    edgeRows.forEach(function (r) {
      r.measured.forEach(function (m) {
        worstXErr = Math.max(worstXErr, Math.abs(m.x - r.expectedX));
      });
    });

    ok('11c: every badge has exactly ONE distinct <text x> attribute', attrsOk,
       { perBadge: edgeRows.map(function (r) {
           return { badge: r.tag, distinct: r.distinctXAttributes }; }) });
    ok('11d: that shared x is the centred-block position, measured on screen',
       measuredOk, { worstXErrPt: round(worstXErr, 5),
         perBadge: edgeRows.map(function (r) {
           return { badge: r.tag, expectedX: r.expectedX,
                    blockWidth: r.blockWidth, spanHi: r.spanHi,
                    measured: r.measured.map(function (m) { return m.x; }) }; }) });
    ok('11e: every line stays inside the 273.6 pt text box',
       worstRight <= 273.6 + 0.02,
       { worstRightPt: round(worstRight, 3), limit: 273.6 });
    ok('11e2: every shared edge is at or right of the 14.4 pt inset',
       sharedXs.every(function (x) { return x >= 14.4 - 0.02; }), { sharedXs: sharedXs });
    out.leftSharedXs = sharedXs;
    out.leftEdgeDetail = edgeRows[0];
    out.worstRightPt = round(worstRight, 3);

    /* Now centre. */
    await setAlign('center');
    var centre = lineSnapshot();
    out.center = centre[0];
    ok('11f: switching to centre re-rendered (tag follows)',
       sheet().getAttribute('data-align') === 'center',
       { tagged: sheet().getAttribute('data-align') });

    var worstCentreErr = 0;
    centre.forEach(function (badge) {
      badge.forEach(function (l) {
        if (l.measuredX === null) return;
        worstCentreErr = Math.max(worstCentreErr,
          Math.abs((l.measuredX + l.measuredRight) / 2 - 144));
      });
    });
    ok('11g: under centre every line is centred on 144 in its cell',
       worstCentreErr < 0.02, { worstCentreErrPt: round(worstCentreErr, 5) });

    /* THE LEAK TEST, on the painted DOM: only x may differ. */
    var diffs = [], xMoved = 0, compared = 0;
    left.forEach(function (badge, bi) {
      badge.forEach(function (l, li) {
        var c = centre[bi][li];
        if (!c) { diffs.push({ badge: bi, line: li, why: 'line missing' }); return; }
        ['text', 'y', 'size', 'weight', 'style', 'lineTop', 'advance'].forEach(function (k) {
          compared++;
          if (l[k] !== c[k]) {
            diffs.push({ badge: bi, line: li, prop: k, left: l[k], center: c[k] });
          }
        });
        if (l.x !== c.x) xMoved++;
      });
    });
    ok('11h: switching alignment changes ONLY x — text, baselines, sizes, weights, ' +
       'styles, lineTops and advances are byte-identical',
       diffs.length === 0, { valuesCompared: compared, differences: diffs.slice(0, 10) });
    ok('11i: and x really did move', xMoved > 0, { linesWhoseXMoved: xMoved });
    out.leak = { compared: compared, differences: diffs.length, xMoved: xMoved };

    /* Engine equality under each mode, against the live opts object. */
    var eqRows = {};
    for (var ai = 0; ai < 2; ai++) {
      var align = ['left', 'center'][ai];
      await setAlign(align);
      var opts = window.BadgePreview.layoutOpts();
      var attendees = window.BadgeStore.getAttendees();
      var overrides = window.BadgeStore.getOverrides();
      var mism = 0, cmp = 0;
      badgeCells().forEach(function (cell, i) {
        var expect = window.BadgeLayout.layout(attendees[i], overrides[attendees[i].id] || null, opts);
        var got = linesIn(cell);
        if (got.length !== expect.lines.length) { mism++; return; }
        expect.lines.forEach(function (ln, j) {
          var el = got[j];
          [['x', String(ln.x), el.getAttribute('x')],
           ['y', String(ln.baselineY), el.getAttribute('y')],
           ['font-size', String(ln.sizePt), el.getAttribute('font-size')],
           ['font-weight', String(ln.weight), el.getAttribute('font-weight')],
           ['font-style', String(ln.style), el.getAttribute('font-style')],
           ['data-x', String(ln.x), el.getAttribute('data-x')],
           ['text', String(ln.text), el.textContent]].forEach(function (c) {
            cmp++;
            if (c[1] !== c[2]) mism++;
          });
        });
      });
      ok('11j.' + align + ': engine equality exact under ' + align,
         mism === 0, { align: align, valuesCompared: cmp, mismatches: mism,
                       optsAlign: opts.align });
      eqRows[align] = { compared: cmp, mismatches: mism };
    }
    out.equality = eqRows;

    /* An unknown value must not move anything. */
    window.BadgeStore.setAlign('sideways');
    await nextFrame();
    await nextFrame();
    ok('11k: an unrecognised alignment falls back to left, not to chaos',
       window.BadgePreview.getState().align === 'left' &&
       sheet().getAttribute('data-align') === 'left',
       { state: window.BadgePreview.getState().align,
         tagged: sheet().getAttribute('data-align') });

    await setAlign('left');
    return out;
  }

  /* ------------------------------------------------------------------ driver */

  async function run(six, fourteen) {
    results = [];
    var data = {};
    data.env = {
      scale: window.BadgePreview.SCALE,
      hasStore: !!window.BadgeStore,
      hasLayout: !!window.BadgeLayout,
      hasMetrics: !!window.InterMetrics,
      hasSpec: !!window.BadgeSpec,
      hasStoreLogo: !!(window.BadgeStore && typeof window.BadgeStore.getLogo === 'function'),
      hasStoreAlign: !!(window.BadgeStore && typeof window.BadgeStore.getAlign === 'function'),
      interLoaded: document.fonts ? document.fonts.check('700 36px Inter') : 'n/a'
    };

    /* Tests 1-8 assume the un-reserved geometry (name centres at 144), so make the
       logo reserve's state explicit rather than inheriting whatever was persisted. */
    if (window.BadgeStore && typeof window.BadgeStore.setLogo === 'function') {
      window.BadgeStore.setLogo({ enabled: false, wIn: 1, hIn: 1 });
      await nextFrame();
    }
    if (window.BadgeStore && typeof window.BadgeStore.setSheetPreset === 'function') {
      window.BadgeStore.setSheetPreset('sampleTopLeft');
      await nextFrame();
    }
    if (window.BadgeStore && typeof window.BadgeStore.setAlign === 'function') {
      window.BadgeStore.setAlign('left'); // the new default
      await nextFrame();
    }
    data.t1 = await test1_sixBadgesOneSheet(six);
    data.t2 = await test2_firstNameCells(six);
    data.t3 = await test3_engineEquality(six, 'left');
    data.t3_center = await test3_engineEquality(six, 'center');
    if (window.BadgeStore && typeof window.BadgeStore.setAlign === 'function') {
      window.BadgeStore.setAlign('left');
      await nextFrame();
    }
    data.t4 = await test4_pagination(fourteen);
    data.t5 = await test5_clampOnDelete(fourteen);
    data.t6 = await test6_hostileName();
    data.t7 = await test7_deadZones(six);
    data.t8 = await test8_liveUpdates(six);
    data.t9 = await test9_logoReserve(six);
    data.t10 = await test10_sheetPreset(six);
    data.t11 = await test11_alignment(six);

    var failed = results.filter(function (r) { return !r.pass; });
    return {
      summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
      failures: failed,
      checks: results.map(function (r) { return (r.pass ? 'PASS ' : 'FAIL ') + r.name; }),
      data: data
    };
  }

  window.PreviewTests = { run: run, nextFrame: nextFrame, ptRect: ptRect,
                          badgeCells: badgeCells, linesIn: linesIn, nav: nav };

})(window, document);
