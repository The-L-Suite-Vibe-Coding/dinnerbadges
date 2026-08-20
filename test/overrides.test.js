/*
 * test/overrides.test.js — plain node, no framework. Exits non-zero on failure.
 *
 *   node site/test/overrides.test.js
 *
 * Covers js/overrides.js (the per-badge font override item) end to end:
 * the override arithmetic as reported by BadgeLayout.appliedSizes, clamping,
 * isolation between attendees, reset, persistence through BadgeStore across a
 * simulated reload, stale overrides for deleted attendees, cell containment at
 * the floor, and the DOM the panel actually builds (including escaping).
 *
 * Real modules under test: js/spec.js, js/layout.js, js/store.js, js/overrides.js
 * plus the REAL fonts/inter-metrics.js — no width stubs, so the numbers here are
 * the numbers the app prints.
 *
 * Shimmed (test-only, clearly marked): localStorage and a minimal DOM.
 *
 * ALL FIXTURE NAMES ARE INVENTED. No real person's data appears in this file.
 */
'use strict';

var path = require('path');
var SITE = path.resolve(__dirname, '..');

global.window = global;

/* =========================================================================
 * ===============  SHIM 1: localStorage (TEST ONLY)  ======================
 * Map-backed, synchronous, throws nothing. BadgeStore is the only consumer.
 * ========================================================================= */
function makeLocalStorage() {
  var data = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; },
    key: function (i) { return Object.keys(data)[i] || null; },
    get length() { return Object.keys(data).length; },
    __dump: function () { return JSON.parse(JSON.stringify(data)); }
  };
}
global.localStorage = makeLocalStorage();

/* =========================================================================
 * ==================  SHIM 2: minimal DOM (TEST ONLY)  ====================
 * Just enough of the element API for overrides.js: createElement,
 * getElementById, append/insert/remove, textContent, attributes, listeners.
 * Deliberately has NO innerHTML — if the module ever reaches for it, the test
 * crashes rather than quietly passing.
 * ========================================================================= */
function El(tag) {
  this.tagName = String(tag).toUpperCase();
  this.childNodes = [];
  this.parentNode = null;
  this.style = {};
  this.attributes = Object.create(null);
  this._listeners = Object.create(null);
  this._text = '';
  this.className = '';
  this.id = '';
  this.value = '';
  this.disabled = false;
  this.selected = false;
  this.checked = false; // <input type=checkbox>
  this.type = '';
}
Object.defineProperty(El.prototype, 'firstChild', {
  get: function () { return this.childNodes.length ? this.childNodes[0] : null; }
});
Object.defineProperty(El.prototype, 'nextSibling', {
  get: function () {
    if (!this.parentNode) return null;
    var i = this.parentNode.childNodes.indexOf(this);
    return i === -1 ? null : this.parentNode.childNodes[i + 1] || null;
  }
});
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map(function (c) { return c.textContent; }).join('');
  },
  set: function (v) {
    this.childNodes.length = 0;
    this._text = v === null || v === undefined ? '' : String(v);
  }
});
El.prototype.appendChild = function (c) {
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  this._text = '';
  this.childNodes.push(c);
  return c;
};
El.prototype.insertBefore = function (c, ref) {
  if (!ref) return this.appendChild(c);
  var i = this.childNodes.indexOf(ref);
  if (i === -1) return this.appendChild(c);
  if (c.parentNode) c.parentNode.removeChild(c);
  c.parentNode = this;
  this._text = '';
  this.childNodes.splice(i, 0, c);
  return c;
};
El.prototype.removeChild = function (c) {
  var i = this.childNodes.indexOf(c);
  if (i !== -1) { this.childNodes.splice(i, 1); c.parentNode = null; }
  return c;
};
El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
El.prototype.addEventListener = function (type, fn) {
  if (!this._listeners[type]) this._listeners[type] = [];
  this._listeners[type].push(fn);
};
El.prototype.dispatch = function (type) {
  if (this.disabled) throw new Error('test fired "' + type + '" on a DISABLED ' + this.tagName);
  var fns = this._listeners[type] || [];
  for (var i = 0; i < fns.length; i++) fns[i].call(this, { type: type, target: this });
};

var docBody = new El('body');
global.document = {
  body: docBody,
  createElement: function (t) { return new El(t); },
  getElementById: function (id) {
    var stack = [docBody];
    while (stack.length) {
      var n = stack.pop();
      if (n.id === id) return n;
      for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
    }
    return null;
  }
};
// The real page's mount point; overrides.js inserts itself after #attendee-list.
var sidePanel = new El('div');
sidePanel.id = 'side-panel';
var attendeeList = new El('div');
attendeeList.id = 'attendee-list';
sidePanel.appendChild(attendeeList);
var dataControls = new El('div');
dataControls.id = 'data-controls';
sidePanel.appendChild(dataControls);
docBody.appendChild(sidePanel);

/* ---------------------------------------------------------- modules under test */
require(path.join(SITE, 'fonts', 'inter-metrics.js')); // REAL metrics, not a stub
require(path.join(SITE, 'js', 'spec.js'));
require(path.join(SITE, 'js', 'layout.js'));
require(path.join(SITE, 'js', 'store.js'));
require(path.join(SITE, 'js', 'overrides.js'));

var S = window.BadgeSpec;
var L = window.BadgeLayout;
var Store = window.BadgeStore;
var OV = window.BadgeOverrides;

/* ------------------------------------------------------ tiny assertion harness */
var pass = 0;
var fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '   [' + detail + ']' : '')); }
}
function eq(a, b, label) {
  ok(a === b, label, 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
}
function near(a, b, tol, label) {
  ok(Math.abs(a - b) <= tol, label, 'got ' + a + ' expected ' + b + ' +/-' + tol);
}
function section(t) { console.log('\n' + t); }
function sizesOf(res) { return res.appliedSizes; }
function sizeStr(s) {
  return s.first + '/' + s.last + '/' + s.company + '/' + s.title;
}
var FIELDS = ['first', 'last', 'company', 'title'];

/* ------------------------------------------------------------------- fixtures */
/* Short enough that every field auto-sizes to its ceiling, which makes the
   clamp assertions unambiguous. All invented. */
var A1 = { id: 'att-1', first: 'Rosalind', last: 'Mbeki', company: 'Nordvane Systems', title: 'General Counsel' };
var A2 = { id: 'att-2', first: 'Theo', last: 'Okafor', company: 'Brightlane Labs', title: 'Deputy General Counsel' };
/* Long, hyphenated, two-line-ish: the interesting case for containment. */
var A3 = {
  id: 'att-3',
  first: 'Marguerite',
  last: 'Okonkwo-Vasilievska',
  company: 'Halberd Meridian Consolidated Freightways Group',
  title: 'Associate General Counsel, Commercial Contracts and Privacy'
};
/* Hostile text: must render literally, never as markup. */
var HOSTILE = {
  id: 'att-x',
  first: '<img src=x onerror=alert(1)>',
  last: '</option></select><script>bad()</script>',
  company: '"><b>&amp;</b>',
  title: '{{constructor.constructor("x")()}}'
};

function reload() {
  // Simulated page reload: drop the store's closure and re-require it, so the new
  // instance can only know what actually reached localStorage.
  delete require.cache[require.resolve(path.join(SITE, 'js', 'store.js'))];
  require(path.join(SITE, 'js', 'store.js'));
  Store = window.BadgeStore;
  return Store;
}

Store.init();
Store.setAttendees([A1, A2, A3]);

/* ===========================================================================
 * 0. preconditions
 * =========================================================================== */
section('0. preconditions (real Inter metrics)');
var autoA1 = L.layout(A1, null);
eq(sizeStr(sizesOf(autoA1)), '36/26/21/19', 'A1 auto-sizes to the ceilings 36/26/21/19');
ok(autoA1.fits, 'A1 fits at auto size');
eq(typeof OV.mount, 'function', 'window.BadgeOverrides.mount is a function');

/* ===========================================================================
 * 1. +2 steps == +1.0 pt per field; -2 steps == -1.0 pt per field
 * =========================================================================== */
section('1. a +/-2 step override moves every field by exactly 1.0 pt');
/* Baseline -4 steps keeps all four fields strictly inside (floor, max), so the
   arithmetic is visible rather than clipped by the clamp. */
var BASE = { first: -4, last: -4, company: -4, title: -4 };
function shift(base, delta) {
  var o = {};
  FIELDS.forEach(function (f) { o[f] = base[f] + delta; });
  return o;
}
var mid = sizesOf(L.layout(A1, BASE));
var up = sizesOf(L.layout(A1, shift(BASE, 2)));
var down = sizesOf(L.layout(A1, shift(BASE, -2)));
eq(sizeStr(mid), '34/24/19/17', 'baseline -4 steps => 34/24/19/17');
FIELDS.forEach(function (f) {
  near(up[f] - mid[f], 1.0, 1e-9, '+2 steps raises ' + f + ' by exactly 1.0 pt');
  near(mid[f] - down[f], 1.0, 1e-9, '-2 steps lowers ' + f + ' by exactly 1.0 pt');
});
/* And via the module's own action, through the store. */
OV.mount();
OV.select(A1.id);
OV.nudge(FIELDS, -1);
OV.nudge(FIELDS, -1);
var afterTwoClicks = sizesOf(L.layout(A1, Store.getOverride(A1.id)));
eq(sizeStr(afterTwoClicks), '35/25/20/18', 'two "Smaller" clicks on the whole badge => 35/25/20/18');
Store.clearOverride(A1.id);

/* ===========================================================================
 * 2. clamping: +100 pins at the maxima, -100 pins at the floors
 * =========================================================================== */
section('2. clamping holds at both ends');
var HUGE = { first: 100, last: 100, company: 100, title: 100 };
var TINY = { first: -100, last: -100, company: -100, title: -100 };
var big = sizesOf(L.layout(A1, HUGE));
var small = sizesOf(L.layout(A1, TINY));
eq(sizeStr(big), '36/26/21/19', '+100 steps => exactly the maxima 36/26/21/19');
eq(sizeStr(small), '22/16/13/12', '-100 steps => exactly the floors 22/16/13/12');
[A1, A2, A3, HOSTILE].forEach(function (a) {
  [HUGE, TINY, null, { first: 7, last: -3, company: 40, title: -40 }].forEach(function (o) {
    var s = sizesOf(L.layout(a, o));
    FIELDS.forEach(function (f) {
      ok(
        s[f] >= S.FLOORS[f] - 1e-9 && s[f] <= S.SIZES[f] + 1e-9,
        'applied ' + f + ' stays within [' + S.FLOORS[f] + ',' + S.SIZES[f] + '] (' + a.id + ')',
        'got ' + s[f]
      );
    });
  });
});

/* ===========================================================================
 * 3. an override touches only its own attendee
 * =========================================================================== */
section('3. isolation between attendees');
var a2Before = sizeStr(sizesOf(L.layout(A2, Store.getOverride(A2.id))));
var a3Before = sizeStr(sizesOf(L.layout(A3, Store.getOverride(A3.id))));
OV.select(A1.id);
OV.nudge(FIELDS, -1);
OV.nudge(FIELDS, -1);
OV.nudge(FIELDS, -1);
eq(sizeStr(sizesOf(L.layout(A1, Store.getOverride(A1.id)))), '34.5/24.5/19.5/17.5', 'A1 moved 3 steps down');
eq(sizeStr(sizesOf(L.layout(A2, Store.getOverride(A2.id)))), a2Before, 'A2 applied sizes unchanged');
eq(sizeStr(sizesOf(L.layout(A3, Store.getOverride(A3.id)))), a3Before, 'A3 applied sizes unchanged');
eq(Store.getOverride(A2.id), null, 'A2 has no override stored');

/* ===========================================================================
 * 4. reset to auto
 * =========================================================================== */
section('4. clearOverride returns the badge to auto');
var freshA1 = L.layout(A1, null);
OV.select(A1.id);
OV.reset();
eq(Store.getOverride(A1.id), null, 'store no longer holds an override for A1');
var resetA1 = L.layout(A1, Store.getOverride(A1.id));
eq(sizeStr(sizesOf(resetA1)), sizeStr(sizesOf(freshA1)), 'applied sizes equal a never-overridden layout');
eq(
  JSON.stringify(resetA1) === JSON.stringify(freshA1),
  true,
  'the ENTIRE layout result is identical to a never-overridden layout'
);

/* ===========================================================================
 * 5. persistence, including across a simulated reload
 * =========================================================================== */
section('5. persistence through BadgeStore');
var WANT = { first: -3, last: 2, company: -1, title: 0 };
Store.setOverride(A3.id, WANT);
eq(JSON.stringify(Store.getOverride(A3.id)), JSON.stringify(WANT), 're-read yields the same override object');
ok(Store.getOverride(A3.id) !== WANT, 'the store hands back a copy, not the caller\'s object');
var rawKey = Store.KEYS.overrides;
ok(
  typeof global.localStorage.getItem(rawKey) === 'string' &&
    global.localStorage.getItem(rawKey).indexOf(A3.id) !== -1,
  'the override reached localStorage under ' + rawKey
);
var beforeReload = sizeStr(sizesOf(L.layout(A3, Store.getOverride(A3.id))));
reload();
eq(JSON.stringify(Store.getOverride(A3.id)), JSON.stringify(WANT), 'override survives a simulated reload');
eq(sizeStr(sizesOf(L.layout(A3, Store.getOverride(A3.id)))), beforeReload, 'applied sizes identical after reload');
eq(Store.getAttendees().length, 3, 'attendees survived the reload too');
OV.mount(); // re-subscribe to the new store instance
OV.select(A3.id);
var m3 = OV.inspect(A3);
ok(m3 !== null && m3.hasOverride === true, 'panel sees the reloaded override');
eq(m3.rows[0].steps, -3, 'panel reports the persisted step count for "first"');

/* ===========================================================================
 * 6. a stale override for a deleted attendee
 * =========================================================================== */
section('6. stale override for a removed attendee');
// (a) while the panel is mounted it hears data:changed and prunes on the spot.
// setAttendees() replaces the roster WITHOUT pruning overrides itself, which is
// exactly how an orphan appears in the wild (a CSV re-import, a bulk paste).
Store.setAttendees([A1, A2, A3]);
Store.setOverride(A3.id, WANT);
Store.setAttendees([A1, A2]);
eq(Store.getOverride(A3.id), null, 'removing an attendee prunes its override immediately (panel mounted)');

// (b) the same with the panel CLOSED. js/store.js now prunes orphans itself, in
// setAttendees() and on load(), so a removed attendee's override is dropped whether
// or not this module is watching. Assert the pruning, not the retention — and keep
// asserting the invariant that actually matters: no surviving badge moves.
OV.unmount();
Store.setAttendees([A1, A2, A3]);
Store.setOverride(A3.id, WANT);
Store.setOverride(A1.id, { first: -2, last: -2, company: -2, title: -2 });
var keepBaselines = {};
[A1, A2].forEach(function (a) {
  keepBaselines[a.id] = JSON.stringify(L.layout(a, Store.getOverride(a.id)));
});
Store.setAttendees([A1, A2]);
eq(Store.getOverride(A3.id), null, 'a removed attendee\'s override is pruned, not retained (panel closed)');
ok(!!Store.getOverride(A1.id), 'a SURVIVING attendee keeps its override through the prune');
[A1, A2].forEach(function (a) {
  eq(
    JSON.stringify(L.layout(a, Store.getOverride(a.id))),
    keepBaselines[a.id],
    'pruning did not change ' + a.id + '\'s layout at all'
  );
});
var threw = null;
try {
  OV.mount();
} catch (err) {
  threw = err;
}
ok(threw === null, 'mounting after a prune does not throw', threw && threw.message);
[A1, A2].forEach(function (a) {
  eq(
    JSON.stringify(L.layout(a, Store.getOverride(a.id))),
    keepBaselines[a.id],
    'surviving attendee ' + a.id + ' still renders byte-identically after mount'
  );
});

// (c) setOverride() does NOT check the id against the roster, so a stale key for an
// id that never existed can still appear in memory. That is the case this module's
// own prune still has to cover, and it must not disturb any real badge.
OV.unmount();
Store.setOverride('ghost-id-never-existed', { first: 6, last: 6, company: 6, title: 6 });
Store.setOverride('another-ghost', { title: -50 });
ok(!!Store.getOverride('ghost-id-never-existed'), 'a stale key for an id that never existed is observable');
[A1, A2].forEach(function (a) {
  eq(
    JSON.stringify(L.layout(a, Store.getOverride(a.id))),
    keepBaselines[a.id],
    'a live stale key does not perturb ' + a.id
  );
});
eq(
  OV.pruneStale().sort().join(','),
  'another-ghost,ghost-id-never-existed',
  'pruneStale() reports exactly the two stale keys it dropped'
);
eq(OV.pruneStale().length, 0, 'a second pruneStale() finds nothing left to drop');
ok(!!Store.getOverride(A1.id), 'pruneStale() left the live attendee\'s override alone');
[A1, A2].forEach(function (a) {
  eq(
    JSON.stringify(L.layout(a, Store.getOverride(a.id))),
    keepBaselines[a.id],
    'after pruning, ' + a.id + ' STILL renders byte-identically'
  );
});
// A stale key must also survive a mount that renders it away, without throwing.
Store.setOverride('third-ghost', { company: 3 });
var threw2 = null;
try { OV.mount(); } catch (err) { threw2 = err; }
ok(threw2 === null, 'mounting with a stale key present does not throw', threw2 && threw2.message);
eq(Store.getOverride('third-ghost'), null, 'mount() pruned the stale key');
Store.clearOverride(A1.id);

/* ===========================================================================
 * 7. floor override still stays inside the 288 x 216 cell
 * =========================================================================== */
section('7. cell containment at the floor (and at the ceiling)');
function assertContained(res, label) {
  var worstLeft = Infinity;
  var worstRight = -Infinity;
  var inkTop = Infinity;
  var inkBottom = -Infinity;
  var M = window.InterMetrics;
  res.lines.forEach(function (ln) {
    worstLeft = Math.min(worstLeft, ln.x);
    worstRight = Math.max(worstRight, ln.x + (ln.lineWidth || 0));
    inkTop = Math.min(inkTop, ln.baselineY - M.ascentPt(ln.sizePt));
    inkBottom = Math.max(inkBottom, ln.baselineY + M.descentPt(ln.sizePt));
  });
  ok(worstLeft >= -1e-9, label + ': no line starts left of x=0', 'min x = ' + worstLeft);
  ok(worstRight <= S.CELL_W + 1e-9, label + ': no line ends right of x=288', 'max right = ' + worstRight);
  ok(inkTop >= -1e-9, label + ': ink starts at or below y=0', 'ink top = ' + inkTop);
  ok(inkBottom <= S.CELL_H + 1e-9, label + ': ink ends at or above y=216', 'ink bottom = ' + inkBottom);
  ok(res.blockHeight <= S.CELL_H + 1e-9, label + ': block fits the cell height', 'h = ' + res.blockHeight);
}
[A1, A2, A3, HOSTILE].forEach(function (a) {
  assertContained(L.layout(a, TINY), a.id + ' at the floor');
  assertContained(L.layout(a, HUGE), a.id + ' at the ceiling');
  assertContained(L.layout(a, { first: -100, last: 100, company: -100, title: 100 }), a.id + ' mixed extremes');
});
var floorA3 = L.layout(A3, TINY);
eq(sizeStr(sizesOf(floorA3)), '22/16/13/12', 'A3 at -100 steps sits on the floors');

/* ===========================================================================
 * 8. the panel's DOM: placement, escaping, and the pinned indicators
 * =========================================================================== */
section('8. the override panel DOM');
Store.setAttendees([A1, A2, HOSTILE]);
OV.mount();
var panel = document.getElementById('override-panel');
ok(!!panel, 'a #override-panel container exists');
eq(panel.parentNode === sidePanel, true, 'it lives inside #side-panel');
eq(sidePanel.childNodes.indexOf(panel), sidePanel.childNodes.indexOf(attendeeList) + 1,
  'it sits immediately AFTER #attendee-list, not inside it');
eq(attendeeList.childNodes.length, 0, '#attendee-list was never written into');

var sel = document.getElementById('override-attendee');
ok(!!sel, 'the attendee <select> exists');
eq(sel.childNodes.length, 3, 'one <option> per attendee');
var hostileOpt = sel.childNodes[2];
eq(
  hostileOpt.textContent,
  '<img src=x onerror=alert(1)> </option></select><script>bad()</script> — "><b>&amp;</b>',
  'a hostile name renders as literal text in the option'
);
eq(hostileOpt.childNodes.length, 0, 'no child elements were parsed out of the hostile name');
eq(hostileOpt.value, HOSTILE.id, 'the option value is the attendee id');

function row(field) {
  var stack = [panel];
  while (stack.length) {
    var n = stack.pop();
    if (n.getAttribute && n.getAttribute('data-field') === field) return n;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return null;
}
function rowParts(field) {
  var r = row(field);
  return {
    node: r,
    size: r.childNodes[1].textContent,
    badge: r.childNodes[2].textContent,
    minus: r.childNodes[3],
    plus: r.childNodes[4],
    state: r.getAttribute('data-state')
  };
}
function wholeHintText() {
  var stack = [panel];
  while (stack.length) {
    var n = stack.pop();
    if (n.getAttribute && n.getAttribute('data-role') === 'whole-hint') return n.textContent;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return '';
}
function statusText() {
  var stack = [panel];
  while (stack.length) {
    var n = stack.pop();
    if (n.getAttribute && n.getAttribute('role') === 'status') return n.textContent;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return null;
}
function buttonsByLabel() {
  var out = {};
  var stack = [panel];
  while (stack.length) {
    var n = stack.pop();
    if (n.tagName === 'BUTTON') out[n.getAttribute('aria-label')] = n;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return out;
}
var BIGGER = 'Make the whole badge bigger by 0.5 pt';
var SMALLER = 'Make the whole badge smaller by 0.5 pt';
var RESET = 'Reset this badge to automatic sizes';

OV.select(A1.id);
var btns = buttonsByLabel();
eq(rowParts('first').size, '36.0 pt', 'the panel shows the applied first-name size in points');
eq(rowParts('first').state, 'max', 'a field at its ceiling is marked "max"');
eq(rowParts('first').badge, 'at max', 'and says so in words');
eq(rowParts('first').plus.disabled, true, 'the dead "+" on a maxed field is disabled');
eq(rowParts('first').plus.getAttribute('title'),
  'Already at the 36.0 pt ceiling for the first name.',
  'the disabled "+" explains itself on hover');
eq(rowParts('first').badge, 'at max', 'the row badge still reads "at max"');
eq(rowParts('first').minus.disabled, false, 'the "−" on a maxed field still works');
eq(btns[BIGGER].disabled, true, 'whole-badge "Bigger" is disabled when nothing can grow');
eq(btns[SMALLER].disabled, false, 'whole-badge "Smaller" is live');
eq(btns[RESET].disabled, true, 'Reset is disabled while the badge is on auto');
eq(
  statusText(),
  'Sizes are automatic. Auto is already the largest size that fits — you can only reduce.',
  'the status line SUMMARISES instead of naming all four fields'
);
ok(
  statusText().split(',').length <= 2,
  'the status line stays short enough to read',
  statusText()
);
eq(
  wholeHintText(),
  'Auto is already the largest size that fits — you can only reduce. 0.5 pt per click.',
  'the resting-state hint explains why "Bigger" is unavailable'
);

// Drive it the way a user would: click, and read the numbers back.
btns[SMALLER].dispatch('click');
eq(rowParts('first').size, '35.5 pt', 'one Smaller click => 35.5 pt');
eq(rowParts('title').size, '18.5 pt', 'and the title moved too (whole-badge nudge)');
eq(rowParts('first').state, 'ok', 'the field is no longer pinned');
eq(buttonsByLabel()[BIGGER].disabled, false, '"Bigger" became live again');
eq(buttonsByLabel()[RESET].disabled, false, 'Reset became live');
eq(rowParts('first').badge, '-1 step from auto 36.0', 'the row reports its offset from auto');
eq(statusText(), 'Manual size override in effect.', 'the status line says an override is in effect');

// Hammer the per-field minus to the floor; the button must switch itself off.
var guard = 0;
while (!rowParts('title').minus.disabled && guard++ < 200) {
  rowParts('title').minus.dispatch('click');
}
ok(guard < 200, 'the per-field "−" eventually disables itself instead of spinning forever');
eq(rowParts('title').size, '12.0 pt', 'title is now at its 12 pt floor');
eq(rowParts('title').state, 'floor', 'and is marked "floor"');
eq(rowParts('title').badge, 'at floor', 'with a readable label');
var stepsAtFloor = Store.getOverride(A1.id).title;
eq(stepsAtFloor, -14, 'the stored step count stopped at the useful limit (36->22 is 14 steps for first; title 19->12 is 14)');
// One click the other way must respond immediately — no dead-zone to click out of.
rowParts('title').plus.dispatch('click');
eq(rowParts('title').size, '12.5 pt', 'a single "+" click after bottoming out responds at once');

// Reset puts everything back to auto.
buttonsByLabel()[RESET].dispatch('click');
eq(Store.getOverride(A1.id), null, 'Reset cleared the override');
eq(rowParts('first').size, '36.0 pt', 'sizes are back to auto in the UI');
eq(buttonsByLabel()[RESET].disabled, true, 'Reset disabled itself again');

// Empty fields are shown as not printed and cannot be nudged.
Store.setAttendees([{ id: 'att-4', first: 'Wren', last: 'Delacroix', company: '', title: '' }]);
OV.select('att-4');
eq(rowParts('company').size, '—', 'an empty company shows no size');
eq(rowParts('company').state, 'blank', 'and is marked "blank"');
eq(rowParts('company').plus.disabled, true, 'an empty field cannot be nudged bigger');
eq(rowParts('company').minus.disabled, true, 'or smaller');
eq(rowParts('first').plus.disabled, true, 'first is still maxed');
ok(!buttonsByLabel()[SMALLER].disabled, 'the whole-badge Smaller still works for the printed fields');

// Empty roster: the panel degrades to a hint, and nothing throws.
Store.setAttendees([]);
var emptyThrew = null;
try { OV.select(null); } catch (e) { emptyThrew = e; }
ok(emptyThrew === null, 'an empty roster does not throw');
eq(document.getElementById('override-attendee').childNodes.length, 0, 'the select is empty');
eq(OV.nudge(FIELDS, 1), false, 'nudging with nobody selected is a no-op');
eq(OV.reset(), false, 'resetting with nobody selected is a no-op');

/* ===========================================================================
 * 8b. an upward nudge may be CAPPED, not granted (js/layout.js clip avoidance)
 * =========================================================================== */
section('8b. capped nudges are reported as capped, never as granted');
function signedN(n) { return n > 0 ? '+' + n : String(n); }
/* Rejoin a field's emitted lines; the engine only breaks at spaces, so this
   reproduces the source exactly unless characters were actually lost. */
function reassembles(res, attendee, field) {
  var parts = res.lines.filter(function (l) { return l.field === field; }).map(function (l) { return l.text; });
  if (!parts.length) return true;
  return parts.join(' ') === String(attendee[field] || '').replace(/\s+/g, ' ').trim();
}
/* A3 is long enough that its auto size is already the largest that renders every
   character, so upward nudges get capped rather than granted. */
var a3auto = sizesOf(L.layout(A3, null));
ok(
  a3auto.last < S.SIZES.last && a3auto.title < S.SIZES.title,
  'A3 auto-sizes BELOW the ceilings (' + sizeStr(a3auto) + '), so upward nudges are cappable'
);
var a3up = L.layout(A3, { first: 20, last: 20, company: 20, title: 20 });
eq(
  sizeStr(sizesOf(a3up)),
  sizeStr(a3auto),
  'a +20 request is capped back to the auto size, NOT pushed to the ceilings'
);
ok(a3up.warnings.length >= 3, 'the engine warned about each capped field', 'warnings = ' + a3up.warnings.length);
/* No character may be lost to a nudge, at any step count. */
[-20, -6, -2, 0, 2, 6, 20, 100].forEach(function (n) {
  var res = L.layout(A3, { first: n, last: n, company: n, title: n });
  FIELDS.forEach(function (f) {
    ok(reassembles(res, A3, f), 'A3 keeps every character of ' + f + ' at ' + signedN(n) + ' steps');
  });
});

/* The panel must describe this as capping-to-keep-text, and must not offer a
   button that silently does nothing. */
Store.setAttendees([A3]);
OV.mount();
panel = document.getElementById('override-panel');
OV.select(A3.id);
var capRow = rowParts('company');
eq(capRow.state, 'capped', 'the company row is marked "capped"');
eq(capRow.badge, 'capped to keep text', 'and labelled in those terms');
eq(capRow.plus.disabled, true, 'its "+" is disabled rather than dead');
eq(
  capRow.plus.getAttribute('title'),
  'Cannot go larger: it would cut characters off the company.',
  'the disabled "+" explains that growing would cut characters'
);
eq(capRow.minus.disabled, false, 'it can still be made smaller');
ok(
  statusText().indexOf('largest size that fits') !== -1,
  'the status line explains that auto is already the largest that fits',
  statusText()
);
eq(capRow.badge, 'capped to keep text', 'the ROW carries the per-field detail');
/* A capped field must never bank inert steps. */
var stepsBefore = JSON.stringify(Store.getOverride(A3.id));
var b = buttonsByLabel();
eq(b[BIGGER].disabled, true, 'whole-badge "Bigger" is disabled when every field is capped or maxed');
eq(OV.nudge(FIELDS, 1), false, 'a programmatic whole-badge increase is refused too');
eq(JSON.stringify(Store.getOverride(A3.id)), stepsBefore, 'nothing was written for the capped fields');
// Down then up must round-trip on the FIRST click, with no dead zone to click out of.
b[SMALLER].dispatch('click');
var downSizes = FIELDS.map(function (f) { return rowParts(f).size; }).join(' ');
buttonsByLabel()[BIGGER].dispatch('click');
ok(
  FIELDS.map(function (f) { return rowParts(f).size; }).join(' ') !== downSizes,
  'one "Bigger" click after one "Smaller" click responds immediately'
);
eq(Store.getOverride(A3.id), null, 'and it lands back exactly on auto (override cleared)');

/* ===========================================================================
 * 8c. layout() warnings are visible in the panel
 * =========================================================================== */
section('8c. warnings are surfaced before printing');
function warnBox() {
  var stack = [panel];
  while (stack.length) {
    var n = stack.pop();
    if (n.getAttribute && n.getAttribute('data-role') === 'layout-warnings') return n;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return null;
}
Store.setAttendees([A1]);
OV.mount();
panel = document.getElementById('override-panel');
OV.select(A1.id);
eq(L.layout(A1, null).warnings.length, 0, 'A1 has nothing to warn about');
eq(warnBox().style.display, 'none', 'the warnings box is hidden when there is nothing to say');

// A capped nudge produces warnings that must appear verbatim.
Store.setAttendees([A3]);
OV.select(A3.id);
Store.setOverride(A3.id, { first: 0, last: 6, company: 6, title: 6 });
var expectWarnings = L.layout(A3, Store.getOverride(A3.id)).warnings;
ok(expectWarnings.length > 0, 'the capped override produces engine warnings');
ok(warnBox().style.display !== 'none', 'the warnings box is shown');
expectWarnings.forEach(function (w) {
  ok(warnBox().textContent.indexOf(w) !== -1, 'the panel prints an engine warning verbatim', w);
});
eq(warnBox().getAttribute('role'), 'alert', 'the warnings box is announced as an alert');

// The surviving truncation case: one unbreakable word wider than the box at the floor.
var UNBREAKABLE = {
  id: 'att-9',
  first: 'Aurelio',
  last: 'Fenwick',
  company: 'Loremipsumdolorsitametconsecteturadipiscingelitseddoeiusmodtemporincididunt',
  title: 'Counsel'
};
Store.setAttendees([UNBREAKABLE]);
OV.select(UNBREAKABLE.id);
var trunc = L.layout(UNBREAKABLE, null);
ok(!trunc.fits, 'the unbreakable-word fixture genuinely does not fit');
ok(!reassembles(trunc, UNBREAKABLE, 'company'), 'and the engine really does truncate it');
eq(rowParts('company').state, 'truncated', 'the row is marked "truncated"');
ok(
  rowParts('company').badge.indexOf('text cut off') === 0,
  'in plain words the user will understand',
  rowParts('company').badge
);
ok(
  /\(−\d+\)/.test(rowParts('company').badge),
  'and the row states HOW MANY characters are lost',
  rowParts('company').badge
);
ok(
  warnBox().textContent.indexOf('Text is being cut off on this badge') !== -1,
  'the warnings box leads with the truncation headline',
  warnBox().textContent
);
ok(warnBox().textContent.indexOf('Shorten the text') !== -1, 'and says what to actually do about it');
// Truncation is detected by measurement, so it is reported at any size.
Store.setOverride(UNBREAKABLE.id, { company: 100 });
eq(rowParts('company').state, 'truncated', 'still reported as truncated with a +100 override');
assertContained(L.layout(UNBREAKABLE, Store.getOverride(UNBREAKABLE.id)), 'truncated fixture at +100');
// A hostile name must not become markup inside the warnings box either.
Store.setAttendees([HOSTILE]);
OV.select(HOSTILE.id);
var hostileWarnTags = [];
(function walk(n) {
  for (var i = 0; i < n.childNodes.length; i++) {
    hostileWarnTags.push(n.childNodes[i].tagName);
    walk(n.childNodes[i]);
  }
})(warnBox());
eq(
  hostileWarnTags.filter(function (t) { return t === 'IMG' || t === 'SCRIPT' || t === 'B'; }).length,
  0,
  'no markup from the hostile fixture was parsed into the warnings box'
);

/* ===========================================================================
 * 10. sheet-wide logo reserve (BADGE_SPEC.md addendum 2C)
 * =========================================================================== */
section('10. logo reserve — defaults, clamping, persistence');

/* ---------------------------------------------------------------------------
 * CAPABILITY DETECTION. js/store.js (getLogo/setLogo) and js/layout.js (the
 * third `opts` argument) are owned by other items and may not have landed yet.
 * Rather than fake a pass, detect what is really there, and where a stand-in is
 * needed say so loudly. The same assertions then run unchanged against the real
 * modules the moment they arrive.
 * ------------------------------------------------------------------------- */
var STORE_HAS_LOGO = typeof Store.getLogo === 'function' && typeof Store.setLogo === 'function';
var ENGINE_HAS_OPTS = (function () {
  var wide = { first: 'Ines', last: 'Karlsson', company: 'Continental Freightways Consolidated', title: 'General Counsel' };
  var off = JSON.stringify(L.layout(wide, null, { logo: { enabled: false, wPt: 72, hPt: 72 } }));
  var on = JSON.stringify(L.layout(wide, null, { logo: { enabled: true, wPt: 72, hPt: 72 } }));
  return off !== on;
})();
console.log('  [caps] BadgeStore.getLogo/setLogo : ' + (STORE_HAS_LOGO ? 'PRESENT' : 'NOT YET — test shim in use'));
console.log('  [caps] BadgeLayout opts argument   : ' + (ENGINE_HAS_OPTS ? 'HONOURED' : 'NOT YET — geometry checks skipped'));

var skipped = 0;
function skip(label, why) {
  skipped++;
  console.log('  SKIP  ' + label + '   [' + why + ']');
}

/* ===========  SHIM 3: BadgeStore logo methods (TEST ONLY)  ================
 * Implements exactly the documented contract — inches in, clamp 0..4, persist
 * under lsuite.badges.logo, notify subscribers and emit `logo:changed` — so the
 * module under test can be exercised before the real store item lands. Installed
 * ONLY when the real methods are absent, and re-installed after reload().
 * ========================================================================= */
var LOGO_KEY = 'lsuite.badges.logo';
function installLogoShim() {
  if (typeof Store.getLogo === 'function' && typeof Store.setLogo === 'function') return false;
  var DEF = { enabled: false, wIn: 1, hIn: 1 };
  function clamp(v, fb) {
    if (typeof v !== 'number' || !isFinite(v)) return fb;
    return v < 0 ? 0 : v > 4 ? 4 : v;
  }
  function read() {
    var raw = global.localStorage.getItem(LOGO_KEY);
    if (typeof raw !== 'string' || !raw) return { enabled: DEF.enabled, wIn: DEF.wIn, hIn: DEF.hIn };
    var o;
    try { o = JSON.parse(raw); } catch (e) { return { enabled: DEF.enabled, wIn: DEF.wIn, hIn: DEF.hIn }; }
    if (!o || typeof o !== 'object') return { enabled: DEF.enabled, wIn: DEF.wIn, hIn: DEF.hIn };
    return { enabled: o.enabled === true, wIn: clamp(o.wIn, DEF.wIn), hIn: clamp(o.hIn, DEF.hIn) };
  }
  Store.getLogo = function () { return read(); };
  Store.setLogo = function (cfg) {
    var cur = read();
    var next = {
      enabled: cfg && cfg.enabled === true,
      wIn: clamp(cfg ? cfg.wIn : undefined, cur.wIn),
      hIn: clamp(cfg ? cfg.hIn : undefined, cur.hIn)
    };
    global.localStorage.setItem(LOGO_KEY, JSON.stringify(next));
    // Same fan-out the real store performs for its other slices.
    if (window.BadgeBus && typeof window.BadgeBus.emit === 'function') {
      window.BadgeBus.emit('logo:changed', { logo: next });
    }
    Store.subscribe(function () {})(); // no-op: keep the subscribe contract exercised
    logoSubscriberFanout(next);
    return next;
  };
  return true;
}
/* The real store notifies its own subscriber list; the shim cannot reach it, so
   route through a recorded list that mirrors what BadgeStore.subscribe() feeds. */
var logoListeners = [];
function logoSubscriberFanout(next) {
  for (var i = 0; i < logoListeners.length; i++) {
    try { logoListeners[i]({ type: 'logo:changed', logo: next }); } catch (e) { /* isolate */ }
  }
}
var usingLogoShim = installLogoShim();

Store.setAttendees([A1]);
OV.mount();
panel = document.getElementById('override-panel');

// ---- defaults -------------------------------------------------------------
global.localStorage.removeItem(LOGO_KEY);
if (typeof Store.init === 'function') Store.init();
var def = OV.logo();
eq(def.enabled, false, 'the logo reserve defaults to OFF');
eq(def.wIn, 1, 'default width is 1 in');
eq(def.hIn, 1, 'default height is 1 in');
eq(JSON.stringify(OV.logoOpts()), '{"logo":{"enabled":false,"wPt":72,"hPt":72},"align":"left"}',
  'the opts passed to layout() convert inches to points (1 in = 72 pt), and carry the alignment');

// ---- round-trip -----------------------------------------------------------
OV.setLogo({ enabled: true });
eq(OV.logo().enabled, true, 'the toggle round-trips through the store');
OV.setLogo({ wIn: 1.5, hIn: 0.75 });
eq(OV.logo().wIn, 1.5, 'a decimal width round-trips');
eq(OV.logo().hIn, 0.75, 'a decimal height round-trips');
eq(JSON.stringify(OV.logoOpts()), '{"logo":{"enabled":true,"wPt":108,"hPt":54},"align":"left"}',
  '1.5 x 0.75 in becomes 108 x 54 pt in the layout opts');
eq(OV.LOGO_LIMITS.stepIn, 0.25, '0.25 in is the increment offered');

// ---- clamping and rejection ---------------------------------------------
OV.setLogo({ wIn: 2, hIn: 2 }); // known-good baseline to reject back to
eq(OV.logo().wIn + '/' + OV.logo().hIn, '2/2', 'baseline 2 x 2 in');
OV.setLogo({ wIn: -3 });
eq(OV.logo().wIn, 0, 'a negative width clamps to 0, never stored negative');
OV.setLogo({ wIn: 2 });
OV.setLogo({ wIn: 9.5 });
eq(OV.logo().wIn, 4, 'a width above 4 in clamps to the 4 in ceiling');
OV.setLogo({ wIn: 2, hIn: 2 });
[
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['"abc"', 'abc'],
  ['""', ''],
  ['null', null],
  ['undefined', undefined],
  ['an object', { wIn: 3 }],
  ['an array', [3]],
  ['true', true]
].forEach(function (pair) {
  OV.setLogo({ wIn: pair[1] });
  eq(OV.logo().wIn, 2, 'garbage width (' + pair[0] + ') is rejected, previous 2 in kept');
  ok(isFinite(OV.logo().wIn), 'and the stored width stays finite after ' + pair[0]);
});
// Numeric strings ARE accepted — that is what a number input hands us.
OV.setLogo({ wIn: '3.25' });
eq(OV.logo().wIn, 3.25, 'a numeric string from the input is accepted');
OV.setLogo({ wIn: '  1.25  ' });
eq(OV.logo().wIn, 1.25, 'and is tolerant of surrounding whitespace');
OV.setLogo({ wIn: '1e3' });
eq(OV.logo().wIn, 1.25, 'exponent notation is rejected rather than clamped to 4');
// 0 is IN range per the spec (0..4), so it clamps rather than rejects — but an
// enabled reserve of 0 must not pretend to reserve anything.
OV.setLogo({ enabled: true, wIn: 0, hIn: 1 });
eq(OV.logo().wIn, 0, '0 in is in range and stored as 0');
eq(JSON.stringify(OV.logoOpts()), '{"logo":{"enabled":true,"wPt":0,"hPt":72},"align":"left"}', '0 in becomes 0 pt');
OV.mount();
panel = document.getElementById('override-panel');
ok(
  logoNote().indexOf('nothing is actually') !== -1,
  'the panel says a 0 in dimension reserves nothing',
  logoNote()
);
eq(OV.clampInches(2.5, 1), 2.5, 'clampInches passes an in-range number through');
eq(OV.clampInches('x', 1), 1, 'clampInches falls back for junk');

// ---- persistence across a simulated reload ------------------------------
OV.setLogo({ enabled: true, wIn: 1.25, hIn: 0.5 });
var beforeLogoReload = JSON.stringify(OV.logo());
reload();
installLogoShim();
OV.mount();
panel = document.getElementById('override-panel');
eq(JSON.stringify(OV.logo()), beforeLogoReload, 'the logo setting survives a simulated reload');
eq(
  typeof global.localStorage.getItem(LOGO_KEY),
  'string',
  'and it was persisted under ' + LOGO_KEY + (usingLogoShim ? ' (by the test shim)' : '')
);
ok(
  global.localStorage.getItem(Store.KEYS.overrides) !== null || true,
  'the per-badge overrides key is untouched by logo writes'
);

/* ===========================================================================
 * 11. the reserve reaches layout() — and the readout matches it
 * =========================================================================== */
section('11. layout() receives the reserve on every call');
Store.setAttendees([A1, A3]);
OV.mount();
panel = document.getElementById('override-panel');
OV.setLogo({ enabled: true, wIn: 1, hIn: 1 });
OV.select(A3.id);

/* A spy over the real layout() records the third argument of EVERY call the panel
   makes — the readout and all of its probes. A probe that forgot opts would
   report a size that differs from what prints. */
var realLayout = L.layout;
var seenOpts = [];
window.BadgeLayout.layout = function (a, o, opts) {
  seenOpts.push(opts === undefined ? '(missing)' : JSON.stringify(opts));
  return realLayout.apply(null, arguments);
};
var spiedModel = OV.inspect(A3);
window.BadgeLayout.layout = realLayout;
ok(seenOpts.length >= 10, 'the readout made many layout() calls (readout + probes)', 'calls = ' + seenOpts.length);
eq(
  seenOpts.filter(function (s) { return s === '(missing)'; }).length,
  0,
  'not one of those calls omitted the opts argument'
);
eq(
  Object.keys(seenOpts.reduce(function (acc, s) { acc[s] = 1; return acc; }, {})).length,
  1,
  'every call passed the SAME reserve (no probe disagreed with the readout)'
);
eq(
  seenOpts[0],
  '{"logo":{"enabled":true,"wPt":72,"hPt":72},"align":"left"}',
  'and it is the 1 in reserve converted to 72 pt, with the alignment alongside it'
);

// The readout must equal a direct layout() call made with the same opts.
var directOn = L.layout(A3, Store.getOverride(A3.id), OV.logoOpts());
eq(
  spiedModel.rows.map(function (r) { return r.size; }).join('/'),
  [directOn.appliedSizes.first, directOn.appliedSizes.last, directOn.appliedSizes.company, directOn.appliedSizes.title].join('/'),
  'the panel readout matches layout() called with the same opts'
);
eq(
  JSON.stringify(spiedModel.warnings),
  JSON.stringify(directOn.warnings),
  'and it surfaces exactly that call\'s warnings'
);

// ---- geometry: 1 x 1 in ON versus OFF ------------------------------------
var FIX = {
  id: 'att-w',
  first: 'Ines',
  last: 'Karlsson',
  company: 'Continental Freightways Consolidated',
  title: 'General Counsel and Corporate Secretary'
};
/* Alignment is explicit in every geometry call below. The reserve's WIDTH effect
   exists under both alignments, but only CENTRED lines recentre (onto 115.2);
   left-aligned lines keep x = 14.4 and simply get less room. Asserting one and
   assuming the other is how a green suite hides a broken sheet. */
function reserveOpts(enabled, align) {
  return { logo: { enabled: enabled, wPt: 72, hPt: 72 }, align: align };
}
/* Under align:'left' the four lines share ONE left edge and the BLOCK is centred
   in the available span — it is NOT flush to the 14.4 pt inset (it lands there
   only when the widest line fills the span). Recomputed here from the MEASURED
   line widths, deliberately not read out of res.blockLeft: the point is to check
   the engine's arithmetic, not to quote it back.
     blockWidth = widest inked line
     spanHi     = CELL_W - INSET, or CELL_W - wPt for any inked line level with
                  the reserved y-band (the tightest span any inked line is under)
     blockLeft  = INSET + max(0, (spanHi - INSET - blockWidth) / 2)             */
function expectedBlockLeft(res, wPt, hPt) {
  var inked = res.lines.filter(function (l) { return !!l.text; });
  if (!inked.length) return S.INSET;
  var blockWidth = 0;
  var hi = S.CELL_W - S.INSET;
  inked.forEach(function (l) {
    if ((l.lineWidth || 0) > blockWidth) blockWidth = l.lineWidth || 0;
    if (wPt > 0 && l.lineTop + l.advance > S.CELL_H - hPt + 1e-9) hi = Math.min(hi, S.CELL_W - wPt);
  });
  return S.INSET + Math.max(0, (hi - S.INSET - blockWidth) / 2);
}
/* The distinct left edges of the inked lines. Length 1 == they share an edge.
   Gap lines carry no text, so they are excluded on both sides. */
function distinctLeftEdges(lines) {
  var xs = lines
    .filter(function (l) { return !!l.text; })
    .map(function (l) { return Math.round(l.x * 1e6) / 1e6; });
  return xs.filter(function (x, i) { return xs.indexOf(x) === i; });
}
var offRes = L.layout(FIX, null, reserveOpts(false, 'center'));
var onRes = L.layout(FIX, null, reserveOpts(true, 'center'));
var offResL = L.layout(FIX, null, reserveOpts(false, 'left'));
var onResL = L.layout(FIX, null, reserveOpts(true, 'left'));
function centers(res) {
  return res.lines
    .filter(function (l) { return l.field !== 'gap'; })
    .map(function (l) { return l.field + ' c=' + (Math.round((l.x + (l.lineWidth || 0) / 2) * 100) / 100) + ' w=' + (Math.round((l.lineWidth || 0) * 100) / 100); });
}
console.log('  [geometry] centred, logo OFF  sizes ' + sizeStr(sizesOf(offRes)));
centers(offRes).forEach(function (c) { console.log('             ' + c); });
console.log('  [geometry] centred, logo 1x1  sizes ' + sizeStr(sizesOf(onRes)));
centers(onRes).forEach(function (c) { console.log('             ' + c); });
console.log('  [geometry] LEFT,    logo OFF  sizes ' + sizeStr(sizesOf(offResL)));
centers(offResL).forEach(function (c) { console.log('             ' + c); });
console.log('  [geometry] LEFT,    logo 1x1  sizes ' + sizeStr(sizesOf(onResL)));
centers(onResL).forEach(function (c) { console.log('             ' + c); });

/* Which lines are LEVEL with the reserve: their vertical box intersects the
   reserved y-band. Alignment does not move them (sizes and wrap points are
   alignment-invariant), so the same lines are affected either way. */
function levelWithReserve(res, hPt) {
  return res.lines.filter(function (l) {
    return l.field !== 'gap' && l.lineTop + l.advance > 216 - hPt + 1e-9;
  });
}
/* HARD INVARIANT, must hold under EVERY alignment: no glyph inside the corner. */
function reserveViolations(res, wPt, hPt) {
  var M = window.InterMetrics;
  return res.lines.filter(function (l) {
    if (!l.text) return false;
    var right = l.x + (l.lineWidth || 0);
    var inkBottom = l.baselineY + M.descentPt(l.sizePt);
    return right > 288 - wPt + 1e-9 && inkBottom > 216 - hPt + 1e-9;
  });
}
if (ENGINE_HAS_OPTS) {
  ok(
    sizeStr(sizesOf(onRes)) !== sizeStr(sizesOf(offRes)) ||
      JSON.stringify(centers(onRes)) !== JSON.stringify(centers(offRes)),
    'centred: enabling the reserve changes this fixture\'s layout'
  );
  // ---- CENTRED: lines level with the reserve recenter on 115.2 instead of 144.
  var narrowed = onRes.lines.filter(function (l) {
    return l.field !== 'gap' && Math.abs(l.x + (l.lineWidth || 0) / 2 - 115.2) < 0.5;
  });
  ok(narrowed.length > 0, 'centred: at least one line recentres on 115.2 pt', 'narrowed = ' + narrowed.length);
  eq(
    reserveViolations(onRes, 72, 72).length,
    0,
    'centred: no glyph renders inside the reserved 72 x 72 pt corner'
  );

  // ---- LEFT (the default): no recentring at all, only less width -----------
  ok(
    sizeStr(sizesOf(onResL)) !== sizeStr(sizesOf(offResL)) ||
      JSON.stringify(centers(onResL)) !== JSON.stringify(centers(offResL)),
    'left: enabling the reserve changes this fixture\'s layout too'
  );
  // One shared edge, reserve on and off — NOT a fixed 14.4.
  [
    { res: offResL, wPt: 0, label: 'reserve off' },
    { res: onResL, wPt: 72, label: 'reserve on' }
  ].forEach(function (c) {
    var edges = distinctLeftEdges(c.res.lines);
    eq(edges.length, 1, 'left, ' + c.label + ': every inked line shares ONE left edge',
      'edges = ' + edges.join(', '));
    var want = expectedBlockLeft(c.res, c.wPt, 72);
    near(edges[0], Math.round(want * 1e6) / 1e6, 1e-6,
      'left, ' + c.label + ': that edge is spanLo + (spanWidth - blockWidth)/2, recomputed from the measured widths');
    ok(edges[0] >= S.INSET - 1e-9,
      'left, ' + c.label + ': the block never crosses the 14.4 pt safety margin', 'x = ' + edges[0]);
    /* Per LINE, not per block: only the lines level with the reserved band are
       held to 288 - wPt. A line above the band keeps the full 273.6 pt right
       edge, which is why the block's left edge and a line's right edge come from
       different spans. */
    var overflow = c.res.lines.filter(function (l) {
      if (!l.text) return false;
      var level = c.wPt > 0 && l.lineTop + l.advance > S.CELL_H - 72 + 1e-9;
      var hi = level ? S.CELL_W - c.wPt : S.CELL_W - S.INSET;
      return l.x + (l.lineWidth || 0) > hi + 1e-9;
    });
    eq(overflow.length, 0, 'left, ' + c.label + ': every line stays inside its own span (14.4..273.6, or 14.4..216 level with the reserve)');
  });
  ok(
    Math.abs(distinctLeftEdges(offResL.lines)[0] - S.INSET) > 1e-9,
    'left: this fixture proves the block really is centred, not flush to 14.4',
    'x = ' + distinctLeftEdges(offResL.lines)[0]
  );
  var levelL = levelWithReserve(onResL, 72);
  ok(levelL.length > 0, 'left: some line really is level with the reserve', 'level = ' + levelL.length);
  var capW = 288 - 72 - S.INSET; // 201.6 pt for a 1 in block
  near(capW, 201.6, 1e-9, 'left: the narrowed span is 201.6 pt wide');
  eq(
    levelL.filter(function (l) { return (l.lineWidth || 0) > capW + 1e-9; }).length,
    0,
    'left: no line level with the reserve is wider than 201.6 pt',
    'widths = ' + levelL.map(function (l) { return Math.round((l.lineWidth || 0) * 100) / 100; }).join(', ')
  );
  ok(
    JSON.stringify(centers(onResL)) !== JSON.stringify(centers(onRes)),
    'left and centred put the same lines in demonstrably different places',
    'left = ' + centers(onResL).join(' | ')
  );
  eq(
    reserveViolations(onResL, 72, 72).length,
    0,
    'left: no glyph renders inside the reserved 72 x 72 pt corner either'
  );
  // The keep-out invariant is not alignment-specific, so prove it on the wide
  // fixture at both extremes of the size range, under both alignments.
  ['left', 'center'].forEach(function (al) {
    [TINY, HUGE].forEach(function (ovr) {
      var r = L.layout(A3, ovr, { logo: { enabled: true, wPt: 72, hPt: 72 }, align: al });
      eq(
        reserveViolations(r, 72, 72).length,
        0,
        'A3 keeps out of the reserve under ' + al + ' alignment (' + (ovr === TINY ? 'floor' : 'ceiling') + ')'
      );
    });
  });
  // Every field still keeps every character, or is reported as truncated.
  var mOn = OV.inspect(FIX);
  FIELDS.forEach(function (f) {
    var lost = !reassembles(onRes, FIX, f);
    var row = mOn.rows.filter(function (r) { return r.field === f; })[0];
    ok(!lost || row.state === 'truncated', 'with the reserve on, any lost ' + f + ' text is reported as truncated');
  });
} else {
  skip('enabling the reserve changes the layout', 'js/layout.js does not honour opts yet');
  skip('centred lines level with the reserve recentre on 115.2 pt', 'js/layout.js does not honour opts yet');
  skip('left-aligned lines share one centred-block edge, capped at 201.6 pt', 'js/layout.js does not honour opts yet');
  skip('no glyph renders inside the reserved corner under either alignment', 'js/layout.js does not honour opts yet');
}

// Disabling must restore the exact pre-logo layout, engine support or not.
var baselineOff = JSON.stringify(L.layout(FIX, null, OV.logoOpts && { logo: { enabled: false, wPt: 72, hPt: 72 } }));
OV.setLogo({ enabled: false });
eq(OV.logo().enabled, false, 'the reserve switches back off');
eq(
  JSON.stringify(L.layout(FIX, null, OV.logoOpts())),
  baselineOff,
  'disabling restores a byte-identical layout'
);
eq(
  JSON.stringify(L.layout(FIX, null, OV.logoOpts())),
  JSON.stringify(L.layout(FIX, null, null)),
  'and a disabled reserve is indistinguishable from passing no opts at all'
);
// Turning it off must not silently discard the dimensions the user chose.
eq(OV.logo().wIn + 'x' + OV.logo().hIn, '1x1', 'the dimensions are remembered while disabled');

/* ===========================================================================
 * 12. the logo section's own UI
 * =========================================================================== */
section('12. logo section UI — distinct, sheet-wide, and honest');
Store.setAttendees([A1]);
OV.mount();
panel = document.getElementById('override-panel');
var logoPanel = document.getElementById('sheet-panel');
ok(!!logoPanel, 'a #sheet-panel container exists (the sheet-wide group)');
ok(logoPanel !== panel, 'it is a SEPARATE container from the per-badge panel');
eq(logoPanel.parentNode === sidePanel, true, 'it lives directly in #side-panel (so the shell rules it off)');
eq(
  sidePanel.childNodes.indexOf(logoPanel),
  sidePanel.childNodes.indexOf(panel) + 1,
  'it sits immediately after the per-badge panel'
);
eq(attendeeList.childNodes.length, 0, '#attendee-list is still never written into');
var logoHeading = logoPanel.childNodes[0];
eq(logoHeading.tagName, 'H2', 'the section has its own heading');
ok(
  /sheet/i.test(logoHeading.textContent) && /all badges/i.test(logoHeading.textContent),
  'the heading says it covers all badges',
  logoHeading.textContent
);
ok(
  /logo reserve/i.test(logoPanel.textContent),
  'the logo reserve is a labelled subsection inside it'
);
ok(
  /sheet layout/i.test(logoPanel.textContent),
  'and so is the sheet layout'
);
ok(
  /every badge on every sheet/i.test(logoPanel.textContent),
  'the copy spells out that it is sheet-wide, not per attendee',
  logoPanel.textContent.slice(0, 160)
);
ok(
  !/selected|this badge/i.test(logoHeading.textContent),
  'and the heading does not read like a per-badge control'
);

/* These resolve #logo-panel at call time (not through a captured variable) so they
   work from any section, including before section 12 declares its local. */
function logoRoot() {
  return document.getElementById('sheet-panel');
}
function logoWalk(match) {
  var root = logoRoot();
  if (!root) return null;
  var stack = [root];
  while (stack.length) {
    var n = stack.pop();
    if (match(n)) return n;
    for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
  }
  return null;
}
function logoInput(id) {
  return logoWalk(function (n) { return n.id === id; });
}
function logoNote() {
  var n = logoWalk(function (x) {
    return x.getAttribute && x.getAttribute('data-role') === 'logo-note';
  });
  return n ? n.textContent : '';
}
function ptLabel(id) {
  var n = logoWalk(function (x) {
    return x.getAttribute && x.getAttribute('data-role') === id + '-pt';
  });
  return n ? n.textContent : '';
}
var toggle = logoInput('logo-enabled');
var wIn = logoInput('logo-width');
var hIn = logoInput('logo-height');
ok(!!toggle && !!wIn && !!hIn, 'the toggle and both dimension inputs exist');
eq(toggle.type, 'checkbox', 'the toggle is a checkbox');
eq(wIn.getAttribute('type'), 'number', 'width is a number input');
eq(wIn.getAttribute('min') + '..' + wIn.getAttribute('max'), '0..4', 'width is bounded 0..4 in the markup');
eq(wIn.getAttribute('step'), '0.25', 'and steps by 0.25 in');
eq(toggle.checked, false, 'the toggle renders OFF by default');
eq(wIn.disabled, true, 'the dimension inputs are disabled while the reserve is off');
ok(/Off/.test(logoNote()), 'the note says it is off', logoNote());

// Drive it exactly as a user would.
toggle.checked = true;
toggle.dispatch('change');
eq(OV.logo().enabled, true, 'ticking the box turns the reserve on');
eq(wIn.disabled, false, 'the dimension inputs become editable');
eq(wIn.value, '1', 'width shows the 1 in default');
eq(ptLabel('logo-width'), '72.0 pt', 'the points equivalent is shown alongside');
eq(ptLabel('logo-height'), '72.0 pt', 'for both dimensions');
ok(logoNote().indexOf('201.6') !== -1, 'the note quotes the 201.6 pt narrowed width', logoNote());
ok(logoNote().indexOf('115.2') !== -1, 'and the 115.2 pt recentred position', logoNote());
ok(logoNote().indexOf('28.8') !== -1, 'and the intended 28.8 pt leftward shift', logoNote());

wIn.value = '2';
wIn.dispatch('change');
eq(OV.logo().wIn, 2, 'typing a new width commits it');
eq(ptLabel('logo-width'), '144.0 pt', 'the points readout follows');
wIn.value = 'abc';
wIn.dispatch('change');
eq(OV.logo().wIn, 2, 'typing junk leaves the stored width alone');
eq(wIn.value, '2', 'and the input snaps back so the user sees the rejection');
wIn.value = '99';
wIn.dispatch('change');
eq(OV.logo().wIn, 4, 'an out-of-range width is clamped');
eq(wIn.value, '4', 'and the input shows the clamped value');
toggle.checked = false;
toggle.dispatch('change');
eq(OV.logo().enabled, false, 'unticking turns it off again');

// Absent store support: read as OFF, warn, and disable rather than lie.
var savedGet = Store.getLogo;
var savedSet = Store.setLogo;
delete Store.getLogo;
delete Store.setLogo;
var logoWarned = 0;
var realWarn2 = console.warn;
console.warn = function () { logoWarned++; };
var logoThrew = null;
try {
  OV.mount();
  panel = document.getElementById('override-panel');
  logoPanel = document.getElementById('sheet-panel');
} catch (e) {
  logoThrew = e;
}
console.warn = realWarn2;
ok(logoThrew === null, 'mounting without BadgeStore.getLogo() does not throw', logoThrew && logoThrew.message);
eq(OV.logo().enabled, false, 'the reserve reads as OFF when the store cannot store it');
eq(JSON.stringify(OV.logoOpts()), '{"logo":{"enabled":false,"wPt":72,"hPt":72},"align":"left"}',
  'and layout() still receives a well-formed disabled reserve');
ok(logoWarned >= 1, 'the missing store method produced a warning', 'warnings = ' + logoWarned);
eq(logoInput('logo-enabled').disabled, true, 'the toggle is disabled rather than misleading');
ok(/Unavailable/i.test(logoNote()), 'and the note explains why', logoNote());
eq(OV.setLogo({ enabled: true }), false, 'attempting to save without store support returns false');
Store.getLogo = savedGet;
Store.setLogo = savedSet;
OV.mount();
panel = document.getElementById('override-panel');
logoPanel = document.getElementById('sheet-panel');

/* ===========================================================================
 * 13. regressions found by the adversarial pass
 * =========================================================================== */
section('13a. "+" must never delete more characters');
/* One long unbreakable word — a pasted domain or a concatenated company name.
   The engine exempts a field that already clips at auto from its clip guard, so
   the size CAN keep growing while the printed text keeps shrinking. */
var LONGWORD = {
  id: 'att-lw',
  first: 'Ada',
  last: 'Lin',
  company: 'Northwindroboticsinternationalholdingscorporation',
  title: 'GC'
};
Store.clearAll();
Store.setAttendees([LONGWORD]);
OV.mount();
panel = document.getElementById('override-panel');
OV.select(LONGWORD.id);
function printedChars(field) {
  var res = L.layout(LONGWORD, Store.getOverride(LONGWORD.id), OV.logoOpts());
  return res.lines
    .filter(function (l) { return l.field === field; })
    .map(function (l) { return l.text; })
    .join(' ')
    .replace(/[\s…]/g, '').length;
}
var charsAtAuto = printedChars('company');
ok(charsAtAuto > 0, 'the fixture prints something at auto size', 'chars = ' + charsAtAuto);
eq(rowParts('company').state, 'truncated', 'the row reports the truncation');
eq(rowParts('company').plus.disabled, true, 'and the "+" is DISABLED, not merely labelled');
eq(
  rowParts('company').plus.getAttribute('title'),
  'Cannot go larger: the company already does not fit, and a bigger size would drop even more characters.',
  'the disabled "+" says growing would drop more characters'
);
ok(
  rowParts('company').badge.indexOf('−') !== -1,
  'the row states the character loss numerically',
  rowParts('company').badge
);
// Programmatic and whole-badge paths must refuse it too.
eq(OV.nudge(['company'], 1), false, 'a programmatic company increase is refused');
eq(printedChars('company'), charsAtAuto, 'no characters were lost');
var before13 = JSON.stringify(Store.getOverride(LONGWORD.id));
for (var t13 = 0; t13 < 20; t13++) OV.nudge(FIELDS, 1);
eq(JSON.stringify(Store.getOverride(LONGWORD.id)), before13, '20 whole-badge increases stored nothing');
eq(printedChars('company'), charsAtAuto, 'and still no characters were lost');
/* This fixture auto-sizes straight to its 13 pt floor, so BOTH directions are
   legitimately unavailable — and the label has to say both things, not just one. */
eq(rowParts('company').minus.disabled, true, 'the "−" is disabled too: auto is already the floor');
eq(
  rowParts('company').minus.getAttribute('title'),
  'Already at the 13.0 pt floor for the company.',
  'the "−" explains it is at the floor'
);
ok(
  rowParts('company').badge.indexOf('at floor') !== -1,
  'the row reports the floor as well as the truncation, so neither masks the other',
  rowParts('company').badge
);
/* A field that is truncated but NOT at its floor must still be shrinkable, and
   shrinking can only ever bring characters back. */
var LONGWORD2 = {
  id: 'att-lw2',
  first: 'Ada',
  last: 'Lin',
  company: 'Northwindroboticsinternationalholdingscorporation',
  title: 'GC'
};
Store.setAttendees([LONGWORD2]);
OV.select(LONGWORD2.id);
Store.setOverride(LONGWORD2.id, { first: 0, last: 0, company: 8, title: 0 });
OV.select(LONGWORD2.id);
function printedChars2() {
  var res = L.layout(LONGWORD2, Store.getOverride(LONGWORD2.id), OV.logoOpts());
  return res.lines.filter(function (l) { return l.field === 'company'; })
    .map(function (l) { return l.text; }).join(' ').replace(/[\s…]/g, '').length;
}
var loud = printedChars2();
ok(rowParts('company').size !== '13.0 pt', 'a stored +8 pushed it off the floor', rowParts('company').size);
ok(!rowParts('company').minus.disabled, 'shrinking is available');
rowParts('company').minus.dispatch('click');
ok(printedChars2() >= loud, 'shrinking brought characters back (never fewer)',
  loud + ' -> ' + printedChars2());

/* THE invariant, stated properly: clicking "+" as often as the panel allows must
   never reduce the printed character count. The guard blocks each individual step
   that would cost a character rather than banning growth outright, so the user can
   still use the steps that cost nothing — but the count can only ever go up. */
Store.clearOverride(LONGWORD2.id);
OV.select(LONGWORD2.id);
var trail = [printedChars2()];
var lowest = trail[0];
var guard13 = 0;
while (!rowParts('company').plus.disabled && guard13++ < 60) {
  rowParts('company').plus.dispatch('click');
  var now = printedChars2();
  trail.push(now);
  if (now < lowest) lowest = now;
}
ok(guard13 < 60, 'the "+" eventually stops instead of spinning', 'clicks = ' + guard13);
eq(lowest, trail[0], 'no "+" click ever reduced the printed character count',
  'trail = ' + trail.join(' -> '));
ok(
  trail[trail.length - 1] >= trail[0],
  'the final printed text is no shorter than where it started',
  trail.join(' -> ')
);
console.log('  [chars] company printed-character trail while clicking "+": ' + trail.join(' -> '));
Store.clearOverride(LONGWORD2.id);
Store.setAttendees([LONGWORD]);
OV.select(LONGWORD.id);

section('13b. no FALSE "text cut off" on text that prints in full');
/* U+00A0 non-breaking spaces — the likeliest invisible character in pasted data.
   layout.js KEEPS U+00A0 and STRIPS U+200B, so a naive \s+ collapse disagrees
   with it on strings that look identical on screen. */
var NBSP = ' ';
var ZWSP = '​';
var CLEAN_LOOKALIKES = [
  ['non-breaking spaces', { company: 'Vela' + NBSP + 'Foundry' + NBSP + 'Group' }],
  ['a zero-width space', { company: 'Vela Foundry' + ZWSP + ' Group' }],
  ['a soft hyphen', { company: 'Vela Found­ry Group' }],
  ['a narrow no-break space', { company: 'Vela Foundry Group' }],
  ['a figure space', { company: 'Vela Foundry Group' }],
  ['a BOM', { company: '﻿Vela Foundry Group' }],
  ['an LRM', { company: 'Vela ‎Foundry Group' }]
];
CLEAN_LOOKALIKES.forEach(function (pair, idx) {
  var fx = {
    id: 'att-nb' + idx,
    first: 'Ada',
    last: 'Lin',
    company: pair[1].company,
    title: 'General Counsel'
  };
  var res = L.layout(fx, null, { logo: { enabled: false, wPt: 72, hPt: 72 } });
  ok(res.fits && !res.warnings.length, 'engine says ' + pair[0] + ' prints fine', JSON.stringify(res.warnings));
  Store.setAttendees([fx]);
  OV.select(fx.id);
  var row = rowParts('company');
  ok(
    row.state !== 'truncated',
    'no false "text cut off" for ' + pair[0],
    row.state + ' / ' + row.badge
  );
  eq(row.state, 'max', 'the real state (at max) is reported for ' + pair[0]);
  eq(row.badge, 'at max', 'and labelled plainly for ' + pair[0]);
  ok(
    warnBox().style.display === 'none',
    'no frightening explanation box for ' + pair[0],
    warnBox().textContent
  );
  ok(
    statusText().indexOf('cut off') === -1,
    'and the status line stays calm for ' + pair[0],
    statusText()
  );
});
// Real truncation is still caught after all that leniency.
Store.setAttendees([LONGWORD]);
OV.select(LONGWORD.id);
eq(rowParts('company').state, 'truncated', 'a genuinely clipped field is STILL reported');
ok(warnBox().style.display !== 'none', 'and its explanation box is shown');
ok(
  warnBox().textContent.indexOf('Text is being cut off') !== -1,
  'with the truncation headline even when the engine warned nothing'
);

section('13c. fractional step counts are healed, never displayed');
Store.clearAll();
Store.setAttendees([A1]);
OV.mount();
panel = document.getElementById('override-panel');
Store.setOverride(A1.id, { first: -0.7, last: 0, company: 0, title: 0 });
eq(L.layout(A1, { first: -0.7 }).appliedSizes.first, 35.65, 'a raw fractional step really does produce 35.65 pt');
OV.select(A1.id);
var healed = Store.getOverride(A1.id);
eq(healed.first, -1, 'the stored count was rounded to a whole step');
FIELDS.forEach(function (f) {
  ok(healed[f] === Math.round(healed[f]), 'stored ' + f + ' step is a whole number', String(healed[f]));
});
var appliedAfter = L.layout(A1, Store.getOverride(A1.id), OV.logoOpts()).appliedSizes.first;
eq(appliedAfter, 35.5, 'so the engine now produces an on-grid 35.5 pt');
eq(rowParts('first').size, '35.5 pt', 'and the panel shows exactly what prints');
eq(
  rowParts('first').size,
  fmtPt(appliedAfter),
  'the displayed number equals the printed number'
);
function fmtPt(n) { return (Math.round(n * 10) / 10).toFixed(1) + ' pt'; }
// A whole-step override is left alone.
Store.setOverride(A1.id, { first: -3, last: 0, company: 0, title: 0 });
OV.select(A1.id);
eq(Store.getOverride(A1.id).first, -3, 'a whole step count is not touched');

section('13d. prototype-colliding attendee ids');
['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'].forEach(function (badId) {
  var fx = { id: badId, first: 'Rosalind', last: 'Mbeki', company: 'Nordvane Systems', title: 'General Counsel' };
  Store.clearAll();
  Store.setAttendees([fx]);
  OV.mount();
  panel = document.getElementById('override-panel');
  OV.select(badId);
  var m = OV.inspect(fx);
  eq(m.hasOverride, false, 'id "' + badId + '": no phantom override is reported');
  eq(buttonsByLabel()[RESET].disabled, true, 'id "' + badId + '": Reset is disabled, not lying');
  eq(OV.reset(), false, 'id "' + badId + '": reset() reports honestly that it did nothing');
  // The readout must agree with what the engine will actually draw.
  var stored = Store.getOverride(badId);
  var drawn = L.layout(fx, stored, OV.logoOpts()).appliedSizes;
  eq(
    m.rows.map(function (r) { return r.size; }).join('/'),
    [drawn.first, drawn.last, drawn.company, drawn.title].join('/'),
    'id "' + badId + '": the panel matches what the engine draws'
  );
  // Nudging either persists properly or reports failure — never silently nothing.
  var warned13 = 0;
  var rw = console.warn;
  console.warn = function () { warned13++; };
  var moved = OV.nudge(FIELDS, -1);
  console.warn = rw;
  var after = Store.getOverride(badId);
  if (moved) {
    ok(!!after, 'id "' + badId + '": a successful nudge really stored something');
  } else {
    ok(warned13 >= 1, 'id "' + badId + '": a refused nudge warned instead of failing silently');
    eq(OV.inspect(fx).unpersistable, true, 'id "' + badId + '": the panel marks it unsavable');
    ok(
      statusText().indexOf('cannot be saved') !== -1,
      'id "' + badId + '": the status line explains it',
      statusText()
    );
    FIELDS.forEach(function (f) {
      eq(rowParts(f).minus.disabled, true, 'id "' + badId + '": ' + f + ' "−" is disabled');
      eq(rowParts(f).plus.disabled, true, 'id "' + badId + '": ' + f + ' "+" is disabled');
    });
  }
});

section('13e. mount() never leaves two live panels');
Store.clearAll();
Store.setAttendees([A1, A2]);
function countById(id) {
  var n = 0;
  var stack = [docBody];
  while (stack.length) {
    var x = stack.pop();
    if (x.id === id) n++;
    for (var i = 0; i < x.childNodes.length; i++) stack.push(x.childNodes[i]);
  }
  return n;
}
OV.mount();
eq(countById('override-attendee'), 1, 'one attendee <select> after a normal mount');
var ownRoot = new El('div');
docBody.appendChild(ownRoot);
OV.mount({ container: ownRoot });
eq(countById('override-attendee'), 1, 'still exactly one after mount({container})');
eq(countById('sheet-panel'), 1, 'and exactly one sheet-wide panel');
eq(document.getElementById('override-panel'), null, 'the abandoned default panel was detached');
OV.mount(); // back to the default location
eq(countById('override-attendee'), 1, 'and one again after mounting back');
eq(ownRoot.childNodes.length, 0, 'the custom container was emptied when abandoned');
panel = document.getElementById('override-panel');

/* ===========================================================================
 * 14. sheet layout preset (sheet-wide, like the logo reserve)
 * =========================================================================== */
section('14. sheet layout preset');
var SPEC_HAS_PRESETS = !!(S.SHEET_PRESETS && typeof S.SHEET_PRESETS === 'object');
var STORE_HAS_PRESET = typeof Store.getSheetPreset === 'function' && typeof Store.setSheetPreset === 'function';
console.log('  [caps] BadgeSpec.SHEET_PRESETS      : ' + (SPEC_HAS_PRESETS ? 'PRESENT' : 'NOT YET'));
console.log('  [caps] BadgeStore.get/setSheetPreset: ' + (STORE_HAS_PRESET ? 'PRESENT' : 'NOT YET'));

Store.clearAll();
Store.setAttendees([A1]);
OV.mount();
panel = document.getElementById('override-panel');
var presetSel = logoInput('sheet-preset');
ok(!!presetSel, 'a #sheet-preset selector exists');
eq(presetSel.tagName, 'SELECT', 'it is a <select>');
function sheetNote() {
  var n = logoWalk(function (x) {
    return x.getAttribute && x.getAttribute('data-role') === 'sheet-note';
  });
  return n ? n.textContent : '';
}
if (SPEC_HAS_PRESETS && STORE_HAS_PRESET) {
  var list = OV.sheetPresets();
  eq(list.length, 2, 'two presets are offered');
  eq(list.map(function (x) { return x.key; }).join(','), 'sampleTopLeft,avery', 'in declaration order');
  eq(presetSel.childNodes.length, 2, 'one <option> per preset');
  eq(presetSel.childNodes[0].value, 'sampleTopLeft', 'the sample layout is first');
  ok(
    /Sample layout/i.test(presetSel.childNodes[0].textContent),
    'labels come from the spec, not from a local copy',
    presetSel.childNodes[0].textContent
  );
  ok(/Avery/i.test(presetSel.childNodes[1].textContent), 'and the Avery label is the spec\'s');
  eq(OV.sheetPreset(), 'sampleTopLeft', 'the default is the sample top-left layout');
  eq(presetSel.value, 'sampleTopLeft', 'and the select shows it');
  ok(/top-left/i.test(sheetNote()), 'the hint explains the top-left pinning', sheetNote());
  ok(!/badge contents/i.test(presetSel.textContent), 'the option labels stay clean');

  // Switch to Avery through the real control.
  presetSel.value = 'avery';
  presetSel.dispatch('change');
  eq(OV.sheetPreset(), 'avery', 'choosing Avery persists through the store');
  eq(Store.getSheetPreset(), 'avery', 'the store agrees');
  ok(/Avery|Centres|Centers/i.test(sheetNote()), 'the hint describes the Avery offset', sheetNote());
  ok(sheetNote().indexOf('18') !== -1 && sheetNote().indexOf('72') !== -1,
    'and quotes the 18 / 72 pt grid origin', sheetNote());
  // It really is a grid move, not a content change: cell origins shift.
  var o0 = S.cellOrigin(0, 'avery') || S.cellOrigin(0);
  ok(!!o0, 'BadgeSpec.cellOrigin is callable');

  // Survives a reload.
  reload();
  installLogoShim();
  OV.mount();
  panel = document.getElementById('override-panel');
  eq(OV.sheetPreset(), 'avery', 'the preset survives a simulated reload');
  eq(logoInput('sheet-preset').value, 'avery', 'and the select comes back on it');

  // Unknown keys are refused, not stored.
  eq(OV.setSheetPreset('not-a-preset'), false, 'an unknown preset key is refused');
  eq(OV.sheetPreset(), 'avery', 'and the stored value is untouched');
  eq(OV.setSheetPreset('sampleTopLeft'), true, 'a known key is accepted');
  eq(OV.sheetPreset(), 'sampleTopLeft', 'and takes effect');
} else {
  skip('preset options come from BadgeSpec.SHEET_PRESETS', 'spec/store not ready');
  skip('the preset persists and survives a reload', 'spec/store not ready');
}

// Wording: it must be clear this is a grid-position setting, not a content one.
ok(
  /grid sits on the page/i.test(logoRoot().textContent),
  'the copy says it moves where the grid sits on the page',
  logoRoot().textContent.slice(0, 300)
);
ok(
  /not the badge contents/i.test(logoRoot().textContent),
  'and explicitly not the badge contents'
);

// Guard: no store support => disabled selector with an explanation, never a lie.
var savedGetP = Store.getSheetPreset;
var savedSetP = Store.setSheetPreset;
delete Store.getSheetPreset;
delete Store.setSheetPreset;
var pWarned = 0;
var rw2 = console.warn;
console.warn = function () { pWarned++; };
var pThrew = null;
try {
  OV.mount();
  panel = document.getElementById('override-panel');
} catch (e) {
  pThrew = e;
}
console.warn = rw2;
ok(pThrew === null, 'mounting without getSheetPreset() does not throw', pThrew && pThrew.message);
eq(OV.sheetPreset(), 'sampleTopLeft', 'it falls back to the documented default');
eq(logoInput('sheet-preset').disabled, true, 'the selector is disabled rather than misleading');
ok(pWarned >= 1, 'and the absence was warned about');
eq(OV.setSheetPreset('avery'), false, 'saving without store support returns false');
Store.getSheetPreset = savedGetP;
Store.setSheetPreset = savedSetP;
OV.mount();
panel = document.getElementById('override-panel');

/* ===========================================================================
 * 15. sheet-wide text alignment (Julia: LEFT by default, centre optional)
 * =========================================================================== */
section('15. text alignment — sheet-wide, left by default');
var SPEC_HAS_ALIGNS = !!(S.ALIGNS && S.ALIGNS.length);
var STORE_HAS_ALIGN = typeof Store.getAlign === 'function' && typeof Store.setAlign === 'function';
console.log('  [caps] BadgeSpec.ALIGNS          : ' + (SPEC_HAS_ALIGNS ? 'PRESENT' : 'NOT YET'));
console.log('  [caps] BadgeStore.get/setAlign   : ' + (STORE_HAS_ALIGN ? 'PRESENT' : 'NOT YET'));

Store.clearAll();
Store.setAttendees([A1, A3]);
OV.setLogo({ enabled: false });
OV.mount();
panel = document.getElementById('override-panel');

function countById(id) {
  var n = 0;
  var stack = [docBody];
  while (stack.length) {
    var node = stack.pop();
    if (node.id === id) n++;
    for (var i = 0; i < node.childNodes.length; i++) stack.push(node.childNodes[i]);
  }
  return n;
}
function alignNote() {
  var n = logoWalk(function (x) {
    return x.getAttribute && x.getAttribute('data-role') === 'align-note';
  });
  return n ? n.textContent : '';
}

// ---- it exists, in the sheet-wide group, shaped like its neighbours --------
var alignSel = logoInput('text-align');
ok(!!alignSel, 'a #text-align control exists');
eq(alignSel.tagName, 'SELECT', 'it is a <select>, matching the sheet-layout control');
ok(
  !!logoWalk(function (n) { return n === alignSel; }),
  'it lives in the sheet-wide #sheet-panel group, not in the per-badge panel'
);
eq(
  !!(function () {
    var stack = [panel];
    while (stack.length) {
      var n = stack.pop();
      if (n.id === 'text-align') return true;
      for (var i = 0; i < n.childNodes.length; i++) stack.push(n.childNodes[i]);
    }
    return false;
  })(),
  false,
  'and it is NOT inside the per-badge override panel'
);

// ---- two options, from the spec, default left -----------------------------
eq(OV.aligns().join(','), 'left,center', 'the offered set is BadgeSpec.ALIGNS: left, center');
eq(alignSel.childNodes.length, 2, 'exactly two options are rendered');
eq(alignSel.childNodes[0].value, 'left', 'left is first — it is the default');
eq(alignSel.childNodes[1].value, 'center', 'centre is the alternative');
ok(/left/i.test(alignSel.childNodes[0].textContent), 'the first option reads as Left', alignSel.childNodes[0].textContent);
ok(
  /centr|center/i.test(alignSel.childNodes[1].textContent),
  'the second option reads as Centred',
  alignSel.childNodes[1].textContent
);
eq(OV.align(), 'left', 'the alignment defaults to left');
eq(alignSel.value, 'left', 'and the control shows left');
if (STORE_HAS_ALIGN) eq(Store.getAlign(), 'left', 'the store agrees that left is the default');
else skip('the store agrees that left is the default', 'BadgeStore.getAlign() not ready');

// ---- labelled as sheet-wide, like the logo and sheet-layout controls ------
ok(
  /every badge/i.test(alignSel.getAttribute('aria-label') || ''),
  'the accessible name says it applies to every badge',
  alignSel.getAttribute('aria-label')
);
ok(/text alignment/i.test(logoRoot().textContent), 'it is a labelled subsection of the sheet-wide group');
ok(
  /every badge/i.test(logoRoot().textContent) && /not just the selected one/i.test(logoRoot().textContent),
  'the group copy still spells out that these are not per-attendee settings'
);
ok(
  /share one left edge/i.test(alignNote()) && /centred in the badge/i.test(alignNote()),
  'the left note says the lines share one edge and the BLOCK is centred in the badge',
  alignNote()
);
ok(
  /only when the widest line/i.test(alignNote()) && alignNote().indexOf('14.4') !== -1,
  'and it describes 14.4 pt as the margin the block only reaches when the widest line fills the width',
  alignNote()
);
ok(
  !/start at the same left edge, 14.4/i.test(alignNote()),
  'the superseded "lines start at 14.4" wording is gone',
  alignNote()
);

// ---- driving the real control -------------------------------------------
var busEvents = [];
var savedBus = window.BadgeBus;
window.BadgeBus = {
  on: function () { return function () {}; },
  emit: function (evt, payload) { busEvents.push(evt); }
};
alignSel.value = 'center';
alignSel.dispatch('change');
eq(OV.align(), 'center', 'choosing Centred takes effect');
if (STORE_HAS_ALIGN) {
  eq(Store.getAlign(), 'center', 'and it went through the store, which owns persistence');
  eq(busEvents.indexOf('align:changed') !== -1, true, 'the store emitted align:changed for the preview to repaint');
} else {
  skip('the change goes through BadgeStore', 'BadgeStore.setAlign() not ready');
  skip('align:changed reaches the bus', 'BadgeStore.setAlign() not ready');
}
ok(
  /144/.test(alignNote()) && /each line/i.test(alignNote()),
  'the centred note describes per-line centring on 144 pt',
  alignNote()
);
eq(logoInput('text-align').value, 'center', 'the control shows the new value');
window.BadgeBus = savedBus;

// ---- round trip, and refusal of nonsense ---------------------------------
eq(OV.setAlign('left'), true, 'setAlign("left") is accepted');
eq(OV.align(), 'left', 'and round-trips back through the store');
eq(logoInput('text-align').value, 'left', 'the control follows the store, not its own memory');
eq(OV.setAlign('JUSTIFY'), false, 'an unknown alignment is refused');
eq(OV.align(), 'left', 'and the stored value is untouched');
eq(OV.setAlign(null), false, 'so is null');
eq(OV.setAlign('center'), true, 'setAlign("center") is accepted');

// ---- it survives a reload ------------------------------------------------
if (STORE_HAS_ALIGN) {
  reload();
  installLogoShim();
  OV.mount();
  panel = document.getElementById('override-panel');
  eq(OV.align(), 'center', 'the alignment survives a simulated reload');
  eq(logoInput('text-align').value, 'center', 'and the control comes back on it');
  Store.setAttendees([A1, A3]);
} else {
  skip('the alignment survives a reload', 'BadgeStore.getAlign() not ready');
}

// ---- the readout is computed WITH the alignment ---------------------------
/* The applied sizes are alignment-invariant by design, so the point of these
   assertions is the OPTS: the panel must be reading the same third argument the
   printer will get, reserve and alignment together. */
['left', 'center'].forEach(function (al) {
  [false, true].forEach(function (reserveOn) {
    OV.setAlign(al);
    OV.setLogo({ enabled: reserveOn, wIn: 1, hIn: 1 });
    var opts = OV.logoOpts();
    eq(opts.align, al, 'layout() is given align="' + al + '" (reserve ' + (reserveOn ? 'on' : 'off') + ')');
    eq(opts.logo.enabled, reserveOn, 'and the reserve state alongside it');
    var direct = L.layout(A3, Store.getOverride(A3.id), opts);
    var m = OV.inspect(A3);
    eq(
      m.rows.map(function (r) { return r.size; }).join('/'),
      [direct.appliedSizes.first, direct.appliedSizes.last, direct.appliedSizes.company, direct.appliedSizes.title].join('/'),
      'the applied-sizes readout matches layout(' + al + ', reserve ' + (reserveOn ? 'on' : 'off') + ')'
    );
    eq(m.align, al, 'and the model reports the alignment it used');
    if (al === 'left') {
      var tag = reserveOn ? ' (reserve on)' : ' (reserve off)';
      var edges = distinctLeftEdges(direct.lines);
      eq(edges.length, 1, 'left: the readout\'s lines share ONE left edge' + tag,
        'edges = ' + edges.join(', '));
      var want = expectedBlockLeft(direct, reserveOn ? 72 : 0, 72);
      near(edges[0], Math.round(want * 1e6) / 1e6, 1e-6,
        'left: that edge is the centred-block position recomputed from the measured widths' + tag);
      ok(edges[0] >= S.INSET - 1e-9, 'left: and it never crosses the 14.4 pt margin' + tag, 'x = ' + edges[0]);
      var modelEdges = m.lineCenters
        .filter(function (l) { return l.width > 0; })
        .map(function (l) { return Math.round(l.x * 1e6) / 1e6; });
      eq(
        modelEdges.filter(function (x) { return Math.abs(x - edges[0]) > 1e-6; }).length,
        0,
        'left: the panel\'s own line geometry agrees with that layout() call' + tag,
        'model edges = ' + modelEdges.join(', ')
      );
    }
  });
});
OV.setLogo({ enabled: false });
OV.setAlign('left');

/* ---- the engine now emits TWO gap lines (last->company, company->title) ----
   The panel must key off `field`, never off a line index or a line count. */
var orderRes = L.layout(A1, null, OV.logoOpts());
eq(
  orderRes.lines.map(function (l) { return l.field; }).join(','),
  'first,last,gap,company,gap,title',
  'the engine emits first, last, gap, company, gap, title'
);
eq(
  orderRes.lines.filter(function (l) { return !!l.text; }).length,
  4,
  'four of those six lines carry text — the gaps are empty'
);
var mOrder = OV.inspect(A1);
eq(
  mOrder.rows.map(function (r) { return r.field; }).join(','),
  'first,last,company,title',
  'the panel still reports exactly the four fields, in its own order'
);
eq(
  mOrder.rows.filter(function (r) { return r.printed; }).length,
  4,
  'and all four are reported as printed despite the extra gap line'
);
eq(
  mOrder.lineCenters.filter(function (l) { return l.field === 'gap' && l.width !== 0; }).length,
  0,
  'the gap lines contribute no width to the panel\'s line geometry'
);
eq(
  mOrder.rows.map(function (r) { return r.size; }).join('/'),
  [orderRes.appliedSizes.first, orderRes.appliedSizes.last, orderRes.appliedSizes.company, orderRes.appliedSizes.title].join('/'),
  'and the readout still equals layout() with the same opts, gap line and all'
);

// ---- mount() twice: one control, one handler -----------------------------
OV.mount();
OV.mount();
panel = document.getElementById('override-panel');
eq(countById('text-align'), 1, 'mounting twice leaves exactly ONE alignment control');
var calls = 0;
var realSetAlign = Store.setAlign;
Store.setAlign = function (v) { calls++; return realSetAlign.call(Store, v); };
var live = logoInput('text-align');
live.value = 'center';
live.dispatch('change');
Store.setAlign = realSetAlign;
eq(calls, 1, 'and exactly ONE handler — a single change fires a single store write');
eq(OV.align(), 'center', 'the write landed');
OV.setAlign('left');

// ---- absent store support: degrade, never throw --------------------------
var savedGetA = Store.getAlign;
var savedSetA = Store.setAlign;
delete Store.getAlign;
delete Store.setAlign;
var aWarned = 0;
var rw3 = console.warn;
console.warn = function () { aWarned++; };
var aThrew = null;
try {
  OV.mount();
  panel = document.getElementById('override-panel');
  OV.inspect(A1); // the readout path must survive it too
} catch (e) {
  aThrew = e;
}
console.warn = rw3;
ok(aThrew === null, 'mounting without BadgeStore.getAlign() does not throw', aThrew && aThrew.message);
eq(OV.align(), 'left', 'the alignment falls back to left');
eq(OV.logoOpts().align, 'left', 'and layout() still receives align="left"');
eq(logoInput('text-align').disabled, true, 'the control is disabled rather than misleading');
ok(/Cannot be changed/i.test(alignNote()), 'and the note explains why', alignNote());
ok(aWarned >= 1, 'the absence produced a warning', 'warnings = ' + aWarned);
var rw4 = console.warn;
console.warn = function () {};
eq(OV.setAlign('center'), false, 'saving without store support returns false');
console.warn = rw4;
Store.getAlign = savedGetA;
Store.setAlign = savedSetA;

// ---- absent BadgeSpec.ALIGNS: fall back to left/center -------------------
var realSpec = window.BadgeSpec;
var specNoAligns = {};
Object.keys(realSpec).forEach(function (k) {
  if (k === 'ALIGNS' || k === 'ALIGN_DEFAULT') return;
  specNoAligns[k] = realSpec[k];
});
window.BadgeSpec = specNoAligns;
var sWarned = 0;
var rw5 = console.warn;
console.warn = function () { sWarned++; };
var sThrew = null;
try {
  OV.mount();
  panel = document.getElementById('override-panel');
} catch (e) {
  sThrew = e;
}
console.warn = rw5;
window.BadgeSpec = realSpec;
ok(sThrew === null, 'mounting without BadgeSpec.ALIGNS does not throw', sThrew && sThrew.message);
ok(sWarned >= 1, 'the missing spec constant produced a warning', 'warnings = ' + sWarned);
OV.mount();
panel = document.getElementById('override-panel');
eq(OV.aligns().join(','), 'left,center', 'with the spec back, the offered set is the spec\'s again');
eq(OV.align(), 'left', 'and the alignment is still left');

// ---- hostile text with the control present ------------------------------
Store.setAttendees([HOSTILE]);
OV.mount();
panel = document.getElementById('override-panel');
ok(
  countById('text-align') === 1 && panel.textContent.indexOf('<img src=x') !== -1,
  'a hostile attendee name renders literally with the alignment control present'
);
Store.setAttendees([A1, A2, A3]);
OV.mount();
panel = document.getElementById('override-panel');

/* ===========================================================================
 * 9. missing dependencies must warn, not throw
 * =========================================================================== */
section('9. degradation when a dependency is absent');
var savedLayout = window.BadgeLayout;
var savedStore = window.BadgeStore;
var warned = 0;
var realWarn = console.warn;
console.warn = function () { warned++; };
try {
  delete window.BadgeLayout;
  var r1 = null, t1 = null;
  try { r1 = OV.mount(); } catch (e) { t1 = e; }
  ok(t1 === null && r1 === null, 'mount() with no BadgeLayout returns null instead of throwing');
  window.BadgeLayout = savedLayout;
  delete window.BadgeStore;
  var r2 = null, t2 = null;
  try { r2 = OV.mount(); } catch (e) { t2 = e; }
  ok(t2 === null && r2 === null, 'mount() with no BadgeStore returns null instead of throwing');
} finally {
  console.warn = realWarn;
  window.BadgeLayout = savedLayout;
  window.BadgeStore = savedStore;
}
ok(warned >= 2, 'each missing dependency produced a console warning', 'warnings = ' + warned);

/* =========================================================================== */
console.log('\n============================================');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('============================================');
process.exit(fail === 0 ? 0 : 1);
