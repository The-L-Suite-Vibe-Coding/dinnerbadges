/*
 * test/store.test.js — plain node, no dependencies. Run: node test/store.test.js
 * Exits 1 on any failed assertion.
 *
 * js/store.js is a classic browser script, so we give it a `window` (globalThis) and a
 * hand-rolled localStorage shim, then re-require it with a cleared module cache whenever
 * we need to simulate a page reload against the same shim.
 *
 * Sections 1-9 are the acceptance criteria. Sections 10-16 are regressions for bugs an
 * adversarial pass found; 10 (clearAll reporting a wipe it did not perform) and 11 (a
 * validator RangeError bricking the store for the rest of the session) are the two that
 * would actually have cost Julia data or work, so they are tested hardest.
 *
 * All fixture names are invented.
 */
'use strict';

var path = require('path');
var STORE_PATH = require.resolve(path.join(__dirname, '..', 'js', 'store.js'));

/* ------------------------------------------------------------- assertion harness */

var failures = [];
var checks = 0;

function ok(cond, label) {
  checks++;
  if (cond) {
    console.log('  PASS  ' + label);
  } else {
    console.log('  FAIL  ' + label);
    failures.push(label);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label + '  (got ' + JSON.stringify(actual) +
    ', expected ' + JSON.stringify(expected) + ')');
}

function deepEq(actual, expected, label) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  ok(a === b, label + (a === b ? '' : '\n          got      ' + a + '\n          expected ' + b));
}

function noThrow(fn, label) {
  try {
    fn();
    ok(true, label);
  } catch (err) {
    ok(false, label + '  threw: ' + (err && err.name) + ': ' + (err && err.message));
  }
}

function section(name) {
  console.log('\n' + name);
}

/* --------------------------------------------------------------- localStorage shim */

function makeShim(opts) {
  opts = opts || {};
  var data = Object.create(null);
  var shim = {
    throwOnWrite: false,
    setItemCalls: 0,
    getItem: function (k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem: function (k, v) {
      this.setItemCalls++;
      if (this.throwOnWrite) {
        var err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data[String(k)] = String(v);
    },
    clear: function () { data = Object.create(null); },
    key: function (i) {
      var keys = Object.keys(data);
      return i >= 0 && i < keys.length ? keys[i] : null;
    },
    // test-only helpers
    _keys: function () { return Object.keys(data); },
    _raw: function (k) { return data[k]; },
    _put: function (k, v) { data[String(k)] = String(v); }
  };
  // `length` must be live, like the real Storage interface
  Object.defineProperty(shim, 'length', { get: function () { return Object.keys(data).length; } });
  // Some storage implementations are locked down / partial. Both variants must be handled.
  if (opts.removeItem === 'throws') {
    shim.removeItem = function () { throw new Error('removeItem is not permitted here'); };
  } else if (opts.removeItem !== 'absent') {
    shim.removeItem = function (k) { delete data[k]; };
  }
  return shim;
}

/* Load a FRESH copy of store.js (new closure, new in-memory state) against whatever
   globalThis.localStorage currently is — this is our "page reload". */
function freshStore() {
  delete require.cache[STORE_PATH];
  delete globalThis.BadgeStore;
  require(STORE_PATH);
  return globalThis.BadgeStore;
}

globalThis.window = globalThis;

/* Capture expected warnings/errors instead of printing them: several tests deliberately
   feed the store corrupt data, a throwing setItem, a throwing subscriber, and a
   write-back loop — the store is SUPPOSED to log about all of those. */
var realWarn = console.warn;
var realError = console.error;
var warnLog = [];
console.warn = function (m) { warnLog.push(String(m)); };
console.error = function (m) { warnLog.push(String(m)); };
function clearWarnLog() { warnLog = []; }
function warnsMatching(re) { return warnLog.filter(function (m) { return re.test(m); }); }

var PREFIX = 'lsuite.badges.';
function prefixedKeys(shim) {
  return shim._keys().filter(function (k) { return k.indexOf(PREFIX) === 0; }).sort();
}

/* ================================================================= 1. round-trip */

section('1. round-trip through a simulated reload');
var shim = makeShim();
globalThis.localStorage = shim;

var A = freshStore();
A.init();

var seed = [
  { id: 'p1', first: 'Marisol', last: 'Vantree', title: 'General Counsel', company: 'Northvale Robotics' },
  { id: 'p2', first: 'Dev', last: 'Okonkwo-Ferrara', title: 'Deputy General Counsel', company: 'Bellhaven Analytics' },
  { id: 'p3', first: 'Quill', last: 'Nakamura', title: 'Head of Legal Operations', company: 'Ironpath Systems' }
];
A.setAttendees(seed);
A.setOverride('p2', { first: -1, title: 0.5 });
A.setOverride('p3', { company: -0.5 });
A.setPageIndex(2);

console.log('  keys written: ' + JSON.stringify(prefixedKeys(shim)));
deepEq(prefixedKeys(shim),
  ['lsuite.badges.attendees', 'lsuite.badges.overrides', 'lsuite.badges.pageIndex'],
  'exactly the three prefixed keys exist');

var B = freshStore(); // reload
B.init();
deepEq(B.getAttendees(), seed, 'attendees survive the reload identically');
deepEq(B.getOverrides(), { p2: { first: -1, title: 0.5 }, p3: { company: -0.5 } },
  'overrides survive the reload identically');
eq(B.getPageIndex(), 2, 'pageIndex survives the reload');

/* ================================================================== 2. clearAll */

section('2. clearAll() removes the keys, not just the values');
eq(B.clearAll(), true, 'clearAll() reports true when the wipe really happened');
deepEq(prefixedKeys(shim), [], 'ZERO keys with the lsuite.badges. prefix remain');
eq(shim.getItem('lsuite.badges.attendees'), null, 'attendees key is absent (getItem -> null)');
deepEq(B.getAttendees(), [], 'in-memory attendees emptied');
deepEq(B.getOverrides(), {}, 'in-memory overrides emptied');
eq(B.getPageIndex(), 0, 'pageIndex reset to 0');

var C = freshStore(); // a reload after clearAll must still be empty
C.init();
deepEq(C.getAttendees(), [], 'still empty after reload');

/* ============================================================== 3. corrupt data */

section('3. corrupt / hand-edited storage');
shim = makeShim();
globalThis.localStorage = shim;
shim._put('lsuite.badges.attendees', '{not json');
shim._put('lsuite.badges.overrides', '{"attendees":"notanarray"}');
shim._put('lsuite.badges.pageIndex', 'banana');

var D = null;
noThrow(function () { D = freshStore(); D.init(); }, 'init() on garbage does not throw');
deepEq(D.getAttendees(), [], 'unparseable attendees -> empty array');
deepEq(D.getOverrides(), {}, 'wrong-shaped overrides -> empty object');
eq(D.getPageIndex(), 0, 'unparseable pageIndex -> 0');

// wrong types where valid JSON parses, plus garbage entries inside a real array
shim._put('lsuite.badges.attendees', '{"attendees":"notanarray"}');
noThrow(function () { D = freshStore(); D.init(); }, 'init() on a non-array attendees value does not throw');
deepEq(D.getAttendees(), [], 'non-array attendees value -> empty array');

shim._put('lsuite.badges.attendees',
  '[null, 7, "nope", [], {"id":"g1","first":"Odalys","last":"Brennerman","title":"VP Legal","company":"Kestrel Freight"},' +
  '{"first":42,"last":null,"title":{"x":1},"company":"Sablewood Trust"}]');
shim._put('lsuite.badges.overrides',
  '{"g1":{"first":-1,"bogus":"x","last":"NaN"},"g2":"nope","g3":{},"g4":{"title":1.5}}');
shim._put('lsuite.badges.pageIndex', '-4.7');
D = freshStore();
D.init();
var repaired = D.getAttendees();
eq(repaired.length, 2, 'garbage entries dropped, repairable ones kept');
deepEq(repaired[0], { id: 'g1', first: 'Odalys', last: 'Brennerman', title: 'VP Legal', company: 'Kestrel Freight' },
  'well-formed entry passes through untouched');
eq(repaired[1].first, '42', 'numeric field coerced to string');
eq(repaired[1].last, '', 'null field coerced to empty string');
eq(repaired[1].title, '', 'object field coerced to empty string');
ok(typeof repaired[1].id === 'string' && repaired[1].id.length > 0, 'missing id was generated');
deepEq(D.getOverrides(), { g1: { first: -1 } },
  'non-numeric nudges dropped, and the orphaned g4 override pruned on load');
eq(D.getPageIndex(), 0, 'negative pageIndex clamped to 0');

/* ============================================================ 4. quota exceeded */

section('4. QuotaExceededError on write');
shim = makeShim();
globalThis.localStorage = shim;
var E = freshStore();
E.init();
shim.throwOnWrite = true;
var quotaRow = [{ id: 'q1', first: 'Thibault', last: 'Renner', title: 'Chief Legal Officer', company: 'Alder & Vane' }];
noThrow(function () { E.setAttendees(quotaRow); }, 'setAttendees() does not throw when setItem throws');
deepEq(E.getAttendees(), quotaRow, 'in-memory value still updated after a failed write');
noThrow(function () { E.setOverride('q1', { last: 1 }); }, 'setOverride() does not throw');
noThrow(function () { E.setPageIndex(3); }, 'setPageIndex() does not throw');
eq(E.getPageIndex(), 3, 'pageIndex still updated in memory');
deepEq(prefixedKeys(shim), [], 'nothing was persisted (writes all rejected)');
shim.throwOnWrite = false;

/* ====================================================== 5. no localStorage at all */

section('5. localStorage entirely absent');
delete globalThis.localStorage;
eq(typeof globalThis.localStorage, 'undefined', 'shim removed from the global');
var F = null;
noThrow(function () { F = freshStore(); F.init(); }, 'init() does not throw without localStorage');
deepEq(F.getAttendees(), [], 'starts empty without localStorage');
noThrow(function () { F.setAttendees([{ id: 'n1', first: 'Rowena', last: 'Achterberg', title: 'Associate GC', company: 'Pellmoor Grid' }]); },
  'setAttendees() does not throw without localStorage');
noThrow(function () { F.addAttendee({ first: 'Casimir', last: 'Dulaney', title: 'Legal Ops Lead', company: 'Havermill Foods' }); },
  'addAttendee() does not throw without localStorage');
noThrow(function () { F.updateAttendee('n1', { title: 'Senior Counsel' }); }, 'updateAttendee() does not throw');
noThrow(function () { F.moveAttendee('n1', 1); }, 'moveAttendee() does not throw');
noThrow(function () { F.setOverride('n1', { first: -1 }); }, 'setOverride() does not throw');
noThrow(function () { F.clearOverride('n1'); }, 'clearOverride() does not throw');
noThrow(function () { F.setPageIndex(1); }, 'setPageIndex() does not throw');
noThrow(function () { F.removeAttendee('n1'); }, 'removeAttendee() does not throw');
var clearedWithNoStorage = null;
noThrow(function () { clearedWithNoStorage = F.clearAll(); }, 'clearAll() does not throw');
eq(clearedWithNoStorage, true, 'clearAll() reports true with no storage (nothing was ever on disk)');
eq(F.getAttendees().length, 0, 'memory-only mode still behaves correctly');

/* ============================================================== 6. moveAttendee */

section('6. moveAttendee reorder + end no-ops');
shim = makeShim();
globalThis.localStorage = shim;
var G = freshStore();
G.init();
G.setAttendees([
  { id: 'm1', first: 'Anselm', last: 'Ruiz-Tate', title: 'GC', company: 'Cindervale Labs' },
  { id: 'm2', first: 'Perrine', last: 'Kovach', title: 'GC', company: 'Dunmoor Health' },
  { id: 'm3', first: 'Yusuf', last: 'Elderberry', title: 'GC', company: 'Talloway Energy' }
]);
function ids(store) {
  return store.getAttendees().map(function (a) { return a.id; });
}
eq(G.moveAttendee('m3', -1), true, 'move up returns true');
deepEq(ids(G), ['m1', 'm3', 'm2'], 'item moved up one slot');
eq(G.moveAttendee('m3', 1), true, 'move down returns true');
deepEq(ids(G), ['m1', 'm2', 'm3'], 'item moved back down');
eq(G.moveAttendee('m1', -1), false, 'moving the first item up is a no-op (false)');
deepEq(ids(G), ['m1', 'm2', 'm3'], 'order unchanged at the top end');
eq(G.moveAttendee('m3', 1), false, 'moving the last item down is a no-op (false)');
deepEq(ids(G), ['m1', 'm2', 'm3'], 'order unchanged at the bottom end');
eq(G.moveAttendee('nope', -1), false, 'unknown id is a no-op');
eq(G.moveAttendee('m1', 0), false, 'delta 0 is a no-op');
eq(G.moveAttendee('m1', 2), true, 'multi-step delta accepted');
deepEq(ids(G), ['m2', 'm3', 'm1'], 'multi-step move landed at the right index');

/* ================================================= 7. setOverride/clearOverride */

section('7. per-badge override isolation');
G.setOverride('m1', { first: -1, last: -0.5 });
G.setOverride('m2', { title: 1 });
G.setOverride('m3', { company: -1.5 });
deepEq(G.getOverride('m2'), { title: 1 }, 'getOverride returns just that badge');
eq(G.clearOverride('m2'), true, 'clearOverride returns true when it removed something');
deepEq(G.getOverrides(), { m1: { first: -1, last: -0.5 }, m3: { company: -1.5 } },
  'only m2 was removed');
eq(G.getOverride('m2'), null, 'cleared override reads back as null');
eq(G.clearOverride('m2'), false, 'clearing again is a no-op (false)');
G.setOverride('m3', null);
eq(G.getOverride('m3'), null, 'setOverride(id, null) clears that override');
deepEq(G.getOverrides(), { m1: { first: -1, last: -0.5 } }, 'm1 untouched throughout');
// removing an attendee takes its override with it
G.setOverride('m1', { first: -1 });
G.removeAttendee('m1');
deepEq(G.getOverrides(), {}, 'removing an attendee drops its orphaned override');

/* ============================================ 8. subscribers + unsubscribe + bus */

section('8. subscribers fire on every mutation; unsubscribe detaches');
shim = makeShim();
globalThis.localStorage = shim;
var busEvents = [];
globalThis.BadgeBus = {
  on: function () { return function () {}; },
  emit: function (evt) { busEvents.push(evt); }
};
var H = freshStore();
H.init();

var hits = [];
var unsub = H.subscribe(function (change) { hits.push(change && change.type); });
var otherHits = 0;
H.subscribe(function () { otherHits++; });
H.subscribe(function () { throw new Error('bad subscriber'); }); // must not break dispatch

function countAfter(fn, label) {
  var before = hits.length;
  noThrow(fn, label + ' — a throwing subscriber does not break the caller');
  ok(hits.length > before, label + ' notified subscribers');
}

countAfter(function () { H.setAttendees([{ id: 's1', first: 'Lorcan', last: 'Whitmore', title: 'GC', company: 'Verrico Media' }]); }, 'setAttendees');
countAfter(function () { H.addAttendee({ id: 's2', first: 'Ingrid', last: 'Palewski', title: 'DGC', company: 'Onyxbridge' }); }, 'addAttendee');
countAfter(function () { H.updateAttendee('s1', { title: 'Chief Legal Officer' }); }, 'updateAttendee');
countAfter(function () { H.moveAttendee('s2', -1); }, 'moveAttendee');
countAfter(function () { H.setOverride('s1', { first: -1 }); }, 'setOverride');
countAfter(function () { H.clearOverride('s1'); }, 'clearOverride');
countAfter(function () { H.setPageIndex(4); }, 'setPageIndex');
countAfter(function () { H.removeAttendee('s1'); }, 'removeAttendee');
countAfter(function () { H.clearAll(); }, 'clearAll');

ok(hits.indexOf('data:changed') !== -1 && hits.indexOf('override:changed') !== -1 &&
   hits.indexOf('page:changed') !== -1, 'all three change types were delivered');
ok(otherHits > 0, 'a second subscriber also received notifications');

var beforeUnsub = hits.length;
unsub();
H.setAttendees([{ id: 's9', first: 'Bertrand', last: 'Osei-Cole', title: 'GC', company: 'Marlowe Grain' }]);
eq(hits.length, beforeUnsub, 'unsubscribe() actually detached the listener');
unsub(); // double-unsubscribe must be harmless
ok(otherHits > 1, 'remaining subscriber still attached after the other unsubscribed');

ok(busEvents.indexOf('data:changed') !== -1 && busEvents.indexOf('override:changed') !== -1 &&
   busEvents.indexOf('page:changed') !== -1, 'BadgeBus received all three event names');
delete globalThis.BadgeBus;
noThrow(function () { H.setPageIndex(0); }, 'mutations still work with no BadgeBus present');

/* =========================================== extra: id generation without crypto */

section('extra. id generation without crypto.randomUUID');
var cryptoDesc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
delete globalThis.crypto;
shim = makeShim();
globalThis.localStorage = shim;
var I = freshStore();
I.init();
var made = [];
for (var n = 0; n < 50; n++) {
  made.push(I.addAttendee({ first: 'Guest' + n, last: 'Placeholder', title: 'Counsel', company: 'Fixture Co' }).id);
}
var uniq = {};
made.forEach(function (id) { uniq[id] = true; });
eq(Object.keys(uniq).length, 50, '50 generated ids are unique without crypto');
if (cryptoDesc) Object.defineProperty(globalThis, 'crypto', cryptoDesc);

// returned copies must not be live references into store state
var snapshot = I.getAttendees();
snapshot[0].first = 'MUTATED';
ok(I.getAttendees()[0].first !== 'MUTATED', 'getAttendees() returns copies, not live state');

/* ============================================ 9. no network / no cookies in source */

section('9. source scan: zero network, zero cookies, zero external URLs');
var src = require('fs').readFileSync(STORE_PATH, 'utf8');
var BANNED = [
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /sendBeacon/,
  /document\s*\.\s*cookie/,
  /https?:\/\//,
  /\bimport\s/,
  /\bexport\s/,
  /EventSource/,
  /navigator\s*\.\s*/
];
BANNED.forEach(function (re) {
  ok(!re.test(src), 'js/store.js contains no ' + re.source);
});
ok(src.indexOf('localStorage') !== -1, 'js/store.js does use localStorage (the only storage allowed)');

/* ================================================================================
 * REGRESSIONS — bugs found by the adversarial pass.
 * ============================================================================== */

/* ------------------------------------------------------- 10. clearAll must not lie */

section('10. REGRESSION: clearAll() must never report a wipe it did not perform');

// (a) removeItem throws — the original bug: swallowed, then `return true` anyway.
shim = makeShim({ removeItem: 'throws' });
globalThis.localStorage = shim;
var J = freshStore();
J.init();
J.setAttendees([{ id: 'x1', first: 'Ottoline', last: 'Vasquez-Prynne', title: 'GC', company: 'Sundermere Rail' }]);
J.setOverride('x1', { first: -1 });
J.setPageIndex(1);
var keysBefore = prefixedKeys(shim);
clearWarnLog();
var jResult = J.clearAll();
var keysAfter = prefixedKeys(shim);
console.log('  removeItem throws — keys before: ' + JSON.stringify(keysBefore));
console.log('                       keys after:  ' + JSON.stringify(keysAfter));
console.log('                       clearAll() returned: ' + jResult +
  '   (before the fix: true — a false success)');
eq(jResult, false, 'clearAll() returns FALSE when the keys could not be deleted');
eq(keysAfter.length, 3, 'the keys are indeed still on disk (so true would have been a lie)');
ok(warnsMatching(/clearAll\(\) FAILED/).length === 1, 'exactly one loud warning names the failure');
ok(/lsuite\.badges\.attendees/.test(warnsMatching(/clearAll\(\) FAILED/)[0] || ''),
  'the warning names the surviving key(s)');
// the UI must still reset even though the disk wipe failed
deepEq(J.getAttendees(), [], 'in-memory state is still cleared on a failed wipe');
// ...and the data really does come back on reload — which is why the return value matters
var J2 = freshStore();
J2.init();
eq(J2.getAttendees().length, 1, 'the attendee list DOES come back after reload (the harm)');

// (b) storage object with no removeItem at all
shim = makeShim({ removeItem: 'absent' });
globalThis.localStorage = shim;
var K = freshStore();
K.init();
K.setAttendees([{ id: 'y1', first: 'Emeric', last: 'Haldane', title: 'DGC', company: 'Wrenfield Bio' }]);
eq(typeof shim.removeItem, 'undefined', 'shim has no removeItem');
clearWarnLog();
eq(K.clearAll(), false, 'clearAll() returns FALSE when removeItem does not exist');
ok(warnsMatching(/clearAll\(\) FAILED/).length === 1, 'the missing-removeItem case also warns');

// (c) healthy storage — must still report true, and really be empty
shim = makeShim();
globalThis.localStorage = shim;
var L = freshStore();
L.init();
L.setAttendees([{ id: 'z1', first: 'Solveig', last: 'Amankwah', title: 'GC', company: 'Petrarch Labs' }]);
L.setOverride('z1', { title: 1 });
L.setPageIndex(2);
clearWarnLog();
eq(L.clearAll(), true, 'clearAll() returns TRUE on a real wipe');
deepEq(prefixedKeys(shim), [], 'and zero prefixed keys remain');
eq(warnsMatching(/clearAll\(\) FAILED/).length, 0, 'no warning on a successful wipe');

/* ------------------------------------------- 11. a bad read must not brick the store */

section('11. REGRESSION: pathological stored value must not throw, or poison later calls');

// JSON.parse SUCCEEDS on this (V8 parses 5000-deep arrays fine); it was parseInt's
// implicit ToString -> Array.prototype.join recursion that threw RangeError.
var DEEP = 5000;
var deepJson = '['.repeat(DEEP) + ']'.repeat(DEEP);
shim = makeShim();
globalThis.localStorage = shim;
shim._put('lsuite.badges.pageIndex', deepJson);
shim._put('lsuite.badges.attendees',
  '[{"id":"d1","first":"Isolde","last":"Marchetti","title":"General Counsel","company":"Halvorsen Metals"}]');

var M = null;
noThrow(function () { M = freshStore(); M.init(); }, 'init() on a ' + DEEP + '-deep nested array does not throw');
eq(M.getPageIndex(), 0, 'pathological pageIndex falls back to 0');
// The real damage was the SECOND call onward: load() never reached `loaded = true`, so
// ensureLoaded() re-ran and re-threw on every getter and setter forever.
noThrow(function () { M.getAttendees(); }, 'getAttendees() works after the bad read (not bricked)');
eq(M.getAttendees().length, 1, 'and the good attendees slice survived the bad pageIndex slice');
noThrow(function () { M.getOverrides(); }, 'getOverrides() works after the bad read');
noThrow(function () { M.setAttendees([{ id: 'd2', first: 'Anouk', last: 'Sterling-Reyes', title: 'DGC', company: 'Corveth Textiles' }]); },
  'setAttendees() works after the bad read');
noThrow(function () { M.addAttendee({ first: 'Rafferty', last: 'Nkemelu', title: 'Counsel', company: 'Baldrick Grid' }); },
  'addAttendee() works after the bad read');
noThrow(function () { M.setOverride('d2', { first: -1 }); }, 'setOverride() works after the bad read');
noThrow(function () { M.setPageIndex(1); }, 'setPageIndex() works after the bad read');
eq(M.getPageIndex(), 1, 'and the store is fully functional again');
eq(M.getAttendees().length, 2, 'writes after the bad read take effect');

// Same hazard through the public API, no storage involved.
var deepArr = [];
var cursor = deepArr;
for (var q = 0; q < 20000; q++) { var nxt = []; cursor.push(nxt); cursor = nxt; }
noThrow(function () { M.setPageIndex(deepArr); }, 'setPageIndex(deeply nested array) does not throw');
eq(M.getPageIndex(), 0, 'a non-number, non-string pageIndex becomes 0');
noThrow(function () { M.getAttendees(); }, 'store still healthy after the hostile setPageIndex');
// other non-coercible types
[true, false, {}, [], function () {}, null, undefined, NaN, Infinity, -1, 'banana'].forEach(function (v) {
  var label = typeof v === 'function' ? 'function' :
    (typeof v === 'object' && v !== null ? (Array.isArray(v) ? '[]' : '{}') : String(v));
  M.setPageIndex(5);
  M.setPageIndex(v);
  eq(M.getPageIndex(), 0, 'setPageIndex(' + label + ') -> 0');
});
eq(M.setPageIndex('3'), 3, 'numeric strings still parse (real storage round-trips strings)');

/* ------------------------------------------------- 12. clearAll prefix-scans storage */

section('12. REGRESSION: clearAll() sweeps the whole prefix, not three hardcoded keys');
shim = makeShim();
globalThis.localStorage = shim;
var N = freshStore();
N.init();
N.setAttendees([{ id: 'v1', first: 'Ptolemy', last: 'Wrensfield', title: 'GC', company: 'Aldergate Foods' }]);
// keys from a hypothetical earlier/renamed schema, plus a key belonging to something else
shim._put('lsuite.badges.v1.attendees', '[{"id":"old","first":"Legacy"}]');
shim._put('lsuite.badges.draft', '{"first":"Halfwritten"}');
shim._put('someoneElse.app.state', 'keep me');
eq(N.clearAll(), true, 'clearAll() succeeds');
deepEq(prefixedKeys(shim), [], 'legacy lsuite.badges.* keys are gone too');
eq(shim.getItem('someoneElse.app.state'), 'keep me', 'keys outside our prefix are untouched');

/* --------------------------------------------------------- 13. orphan override prune */

section('13. REGRESSION: orphaned overrides are pruned, not accumulated');
shim = makeShim();
globalThis.localStorage = shim;
var O = freshStore();
O.init();
O.setAttendees([
  { id: 'o1', first: 'Delphine', last: 'Karabo', title: 'GC', company: 'Nettlebay Marine' },
  { id: 'o2', first: 'Ignatius', last: 'Fairweather', title: 'DGC', company: 'Crowmoor Data' }
]);
O.setOverride('o1', { first: -1 });
O.setOverride('o2', { title: 1 });
// simulate re-importing a fresh CSV: entirely new ids
O.setAttendees([{ id: 'o3', first: 'Marguerite', last: 'Oyelaran', title: 'GC', company: 'Fenwick Optics' }]);
deepEq(O.getOverrides(), {}, 'a replacement attendee list drops the old overrides');
deepEq(JSON.parse(shim._raw('lsuite.badges.overrides')), {}, 'and the pruned map is what is on disk');
// prune also happens on load, for files written by an older build
shim._put('lsuite.badges.overrides', '{"o3":{"first":-1},"ghost1":{"title":1},"ghost2":{"last":-2}}');
var P = freshStore();
P.init();
deepEq(P.getOverrides(), { o3: { first: -1 } }, 'load() prunes overrides with no matching attendee');
deepEq(JSON.parse(shim._raw('lsuite.badges.overrides')), { o3: { first: -1 } },
  'the cleaned map is written back so the file stops growing');

/* ------------------------------------------------ 14. per-subscriber payload copies */

section('14. REGRESSION: each subscriber gets its own payload (order is not load-bearing)');
shim = makeShim();
globalThis.localStorage = shim;
var Q = freshStore();
Q.init();
var secondSaw = null;
Q.subscribe(function (change) {
  // a badly behaved subscriber that mutates what it was handed
  if (change.attendees) {
    change.attendees.length = 0;
    change.attendees.push({ id: 'HIJACK', first: 'Tampered', last: '', title: '', company: '' });
  }
  if (change.overrides) change.overrides.INJECTED = { first: 99 };
  change.type = 'clobbered';
});
Q.subscribe(function (change) { secondSaw = JSON.parse(JSON.stringify(change)); });
Q.setAttendees([{ id: 'w1', first: 'Cressida', last: 'Bellweather', title: 'GC', company: 'Thornquist Rail' }]);
eq(secondSaw.type, 'data:changed', 'the second subscriber sees an untampered type');
eq(secondSaw.attendees.length, 1, 'the second subscriber sees the real attendee list');
eq(secondSaw.attendees[0].first, 'Cressida', 'not the hijacked entry');
Q.setOverride('w1', { first: -1 });
eq(secondSaw.overrides.INJECTED, undefined, 'the second subscriber sees an untampered overrides map');
deepEq(Q.getAttendees(), [{ id: 'w1', first: 'Cressida', last: 'Bellweather', title: 'GC', company: 'Thornquist Rail' }],
  'store state itself is unaffected by a mutating subscriber');

/* -------------------------------------- 15. no-op short-circuit + reentrancy guard */

section('15. REGRESSION: identical writes short-circuit; write-back loops terminate');
shim = makeShim();
globalThis.localStorage = shim;
var R = freshStore();
R.init();
var rHits = 0;
R.subscribe(function () { rHits++; });

R.setAttendees([{ id: 'r1', first: 'Leocadia', last: 'Munteanu', title: 'GC', company: 'Aubrey Stone' }]);
var writesAfterSeed = shim.setItemCalls;
var hitsAfterSeed = rHits;

R.setPageIndex(1);
var writesAfterFirstPage = shim.setItemCalls;
ok(rHits > hitsAfterSeed, 'a real setPageIndex notifies');
var hitsAfterFirstPage = rHits;
R.setPageIndex(1);
eq(rHits, hitsAfterFirstPage, 'setPageIndex with the same value does not notify again');
eq(shim.setItemCalls, writesAfterFirstPage, 'and does not write again');

R.setOverride('r1', { first: -1 });
var hitsAfterOverride = rHits;
var writesAfterOverride = shim.setItemCalls;
R.setOverride('r1', { first: -1 });
eq(rHits, hitsAfterOverride, 'setOverride with an identical value does not notify again');
eq(shim.setItemCalls, writesAfterOverride, 'and does not write again');

R.updateAttendee('r1', { title: 'GC' }); // unchanged
eq(rHits, hitsAfterOverride, 'updateAttendee with unchanged values does not notify');
eq(R.updateAttendee('r1', { title: 'GC' }), false, 'and reports false');
eq(R.updateAttendee('r1', { title: 'Chief Legal Officer' }), true, 'a real change still reports true');

R.setAttendees(R.getAttendees()); // identical list
var hitsBeforeIdenticalList = rHits;
R.setAttendees(R.getAttendees());
eq(rHits, hitsBeforeIdenticalList, 'setAttendees with an identical list does not notify');
ok(writesAfterSeed > 0, 'sanity: real writes do reach storage');

// reentrancy: a subscriber that writes back on every page:changed
shim = makeShim();
globalThis.localStorage = shim;
var S = freshStore();
S.init();
clearWarnLog();
var loopUnsub = S.subscribe(function (change) {
  if (change.type === 'page:changed') S.setPageIndex(change.pageIndex + 1); // pathological
});
var loopThrew = null;
try {
  S.setPageIndex(1);
} catch (err) {
  loopThrew = (err && err.name) + ': ' + (err && err.message);
}
eq(loopThrew, null, 'a write-back subscriber does not blow the stack out of setPageIndex');
ok(shim.setItemCalls < 250, 'the cascade is bounded (' + shim.setItemCalls + ' writes, not thousands)');
eq(warnsMatching(/notification cascade exceeded/).length, 1,
  'the runaway cascade is reported, not silently swallowed');
eq(warnsMatching(/Maximum call stack/).length, 0, 'and it never became a stack overflow');
loopUnsub();
noThrow(function () { S.setPageIndex(0); }, 'store still usable after a runaway cascade');

/* ------------------------------------------------------- 16. write warning re-arms */

section('16. REGRESSION: the write-failure warning re-arms after a successful write');
shim = makeShim();
globalThis.localStorage = shim;
var T = freshStore();
T.init();
clearWarnLog();
shim.throwOnWrite = true;
T.setAttendees([{ id: 't1', first: 'Corvin', last: 'Ashdown', title: 'GC', company: 'Rillington Fuels' }]);
eq(warnsMatching(/could not save/).length, 1, 'first failed write warns once');
T.setPageIndex(1);
T.setPageIndex(2);
eq(warnsMatching(/could not save/).length, 1, 'a run of failures does not spam the console');
shim.throwOnWrite = false;
T.setPageIndex(3); // succeeds -> re-arms
clearWarnLog();
shim.throwOnWrite = true;
T.setPageIndex(4);
eq(warnsMatching(/could not save/).length, 1,
  'a LATER data-loss event warns again (the latch is not permanent)');
shim.throwOnWrite = false;

/* ================================================================================
 * 17. The "Clear all data" button. Enough of a DOM to exercise the real code path;
 *     a headless-Chrome run verifies the same behaviour in the actual page.
 * ============================================================================== */

section('17. "Clear all data" button');

/* --- tiny DOM shim: only what js/store.js and js/pdf.js actually touch ---------- */
function makeDom() {
  function El(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attributes = Object.create(null);
    this._listeners = Object.create(null);
    this._text = '';
    this.hidden = false;
    this.className = '';
    this.parentNode = null;
  }
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () {
      if (this.children.length) {
        return this.children.map(function (c) { return c.textContent; }).join('');
      }
      return this._text;
    },
    set: function (v) { this._text = v === null || v === undefined ? '' : String(v); this.children = []; }
  });
  El.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
  El.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  };
  El.prototype.appendChild = function (c) { this.children.push(c); c.parentNode = this; return c; };
  El.prototype.addEventListener = function (t, fn) {
    if (!this._listeners[t]) this._listeners[t] = [];
    this._listeners[t].push(fn);
  };
  El.prototype.click = function () {
    var ls = (this._listeners.click || []).slice();
    for (var i = 0; i < ls.length; i++) ls[i]({ type: 'click', target: this });
  };
  El.prototype.matches = function (sel) {
    if (sel.charAt(0) === '[') {
      var name = sel.slice(1, -1).split('=')[0].replace(/["']/g, '');
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    }
    if (sel.charAt(0) === '.') return (' ' + this.className + ' ').indexOf(' ' + sel.slice(1) + ' ') !== -1;
    return this.tagName === sel.toUpperCase();
  };
  El.prototype.querySelectorAll = function (sel) {
    var out = [];
    (function walk(node) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    })(this);
    return out;
  };
  El.prototype.querySelector = function (sel) {
    var all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  };

  var byId = Object.create(null);
  var doc = {
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) { return byId[id] || null; },
    _addContainer: function (id) {
      var el = new El('div');
      el.attributes.id = id;
      byId[id] = el;
      return el;
    },
    _drop: function (id) { delete byId[id]; }
  };
  return doc;
}

/* Stand-in for what js/pdf.js appends, so we can prove coexistence and that nothing
   clears the container. Mirrors pdf.js: a wrapper div + a marked button. */
function mountExportStandIn(doc, host) {
  var wrap = doc.createElement('div');
  wrap.className = 'pdf-export';
  var b = doc.createElement('button');
  b.type = 'button';
  b.textContent = 'Export PDF';
  b.setAttribute('data-badge-pdf-export', '1');
  wrap.appendChild(b);
  host.appendChild(wrap);
  return b;
}

function clearBtn(host) { return host.querySelector('[data-badge-clear-all]'); }
function cancelBtn(host) { return host.querySelector('[data-badge-clear-cancel]'); }
function statusEl(host) { return host.querySelector('[data-badge-clear-status]'); }

var SEED_ONE = [{ id: 'ui1', first: 'Xiomara', last: 'Deveraux', title: 'General Counsel', company: 'Pallister Freight' }];

/* --- (a) missing container: warn, do not throw --------------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
globalThis.document = makeDom(); // no #data-controls in it
clearWarnLog();
var U = freshStore();
noThrow(function () { U.init(); }, 'init() does not throw when #data-controls is missing');
eq(warnsMatching(/#data-controls not found/).length, 1, 'missing container warns exactly once');
eq(U.mountControls(), null, 'mountControls() returns null with no container');

/* --- (b) coexistence with Export PDF + append, never replace -------------------- */
var doc = makeDom();
globalThis.document = doc;
var host = doc._addContainer('data-controls');
var exportBtn = mountExportStandIn(doc, host); // pdf.js got here first
shim = makeShim();
globalThis.localStorage = shim;
var V = freshStore();
V.init();
ok(clearBtn(host) !== null, 'init() mounts the Clear all data button');
eq(clearBtn(host).textContent, 'Clear all data', 'button label is "Clear all data"');
ok(host.querySelector('[data-badge-pdf-export]') === exportBtn,
  'the pre-existing Export PDF button is still there (container was appended to, not cleared)');
eq(host.children.length, 2, 'container holds both blocks: Export PDF and Clear all data');
eq(host.children[0].className, 'pdf-export', 'Export PDF block stayed first');
eq(host.children[1].className, 'clear-all', 'Clear all data block was appended after it');
// and the reverse order (store first, pdf.js second) must also work
var doc2 = makeDom();
globalThis.document = doc2;
var host2 = doc2._addContainer('data-controls');
var V2 = freshStore();
V2.init();
var lateExport = mountExportStandIn(doc2, host2);
ok(host2.querySelector('[data-badge-clear-all]') !== null && lateExport !== null,
  'both coexist when the store mounts first and Export PDF arrives later');

/* --- (c) accessibility + secondary styling ------------------------------------- */
globalThis.document = doc;
var cb = clearBtn(host);
eq(cb.type, 'button', 'button has type="button" (never submits a form)');
ok(/clear all saved badge data/i.test(cb.getAttribute('aria-label') || ''),
  'button has a descriptive aria-label');
eq(statusEl(host).getAttribute('role'), 'status', 'status line has role="status"');
eq(statusEl(host).getAttribute('aria-live'), 'polite', 'status line is aria-live="polite"');
eq(statusEl(host).hidden, true, 'status line starts hidden');
eq(cb.style.background, 'transparent', 'button is visually quiet (transparent) next to Export PDF');
ok(cb.style.fontSize === '12px', 'and smaller than the primary action');
ok(src.indexOf('innerHTML') === -1, 'js/store.js never uses innerHTML');

/* --- (d) double mount yields exactly one button -------------------------------- */
V.mountControls();
V.mountControls();
V.mount();
eq(host.querySelectorAll('[data-badge-clear-all]').length, 1,
  'mounting repeatedly yields exactly ONE Clear all data button');
eq(host.children.length, 2, 'and no duplicate blocks in the container');
// one handler, not four: a single armed click must not fire four times
eq(cb._listeners.click.length, 1, 'exactly one click handler is attached');

/* --- (e) first click only arms; nothing is destroyed --------------------------- */
V.setAttendees(SEED_ONE);
V.setOverride('ui1', { first: -1 });
V.setPageIndex(1);
var uiHits = 0;
var uiUnsub = V.subscribe(function () { uiHits++; });
var hitsBeforeArm = uiHits;
cb.click(); // arm
deepEq(V.getAttendees(), SEED_ONE, 'one click does NOT clear the attendees');
eq(prefixedKeys(shim).length, 3, 'and does not touch storage');
eq(uiHits, hitsBeforeArm, 'and notifies nobody');
ok(/no undo/i.test(statusEl(host).textContent), 'the armed state warns that there is no undo');
ok(/click again to confirm/i.test(cb.textContent), 'the button asks for a second click');
eq(cancelBtn(host).hidden, false, 'a Cancel button appears while armed');

/* --- (f) cancel = declined confirmation: nothing changes ----------------------- */
cancelBtn(host).click();
eq(cb.textContent, 'Clear all data', 'Cancel returns the button to its resting label');
eq(cancelBtn(host).hidden, true, 'Cancel hides itself again');
eq(statusEl(host).textContent, '', 'and the warning is withdrawn');
deepEq(V.getAttendees(), SEED_ONE, 'declining the confirmation changes NOTHING');
eq(prefixedKeys(shim).length, 3, 'storage untouched after a declined confirmation');
eq(uiHits, hitsBeforeArm, 'no subscriber was notified by the declined attempt');
// and a click after cancelling arms again rather than firing
cb.click();
deepEq(V.getAttendees(), SEED_ONE, 'the next single click re-arms instead of erasing');
cancelBtn(host).click();

/* --- (g) confirmed click wipes everything ------------------------------------- */
cb.click(); // arm
cb.click(); // confirm
deepEq(prefixedKeys(shim), [], 'confirmed click leaves ZERO lsuite.badges.* keys');
deepEq(V.getAttendees(), [], 'in-memory attendees emptied');
deepEq(V.getOverrides(), {}, 'in-memory overrides emptied');
eq(V.getPageIndex(), 0, 'page index reset');
ok(uiHits > hitsBeforeArm, 'subscribers were notified by the real wipe');
eq(statusEl(host).textContent, 'All data cleared. Nothing is saved in this browser.',
  'the UI reports success');
eq(cb.textContent, 'Clear all data', 'the button disarms itself after firing');
uiUnsub();

/* --- (h) failed wipe must NOT claim success ------------------------------------ */
var doc3 = makeDom();
globalThis.document = doc3;
var host3 = doc3._addContainer('data-controls');
mountExportStandIn(doc3, host3);
shim = makeShim({ removeItem: 'throws' });
globalThis.localStorage = shim;
var W = freshStore();
W.init();
W.setAttendees([{ id: 'ui2', first: 'Auberon', last: 'Selkirk', title: 'Deputy GC', company: 'Marrowfield Aero' }]);
W.setOverride('ui2', { last: -0.5 });
W.setPageIndex(2);
eq(prefixedKeys(shim).length, 3, 'three keys are on disk before the failed wipe');
var wBtn = clearBtn(host3);
clearWarnLog();
wBtn.click();
wBtn.click();
var failMsg = statusEl(host3).textContent;
console.log('  failure message: "' + failMsg + '"');
ok(/failed/i.test(failMsg), 'the UI says clearing FAILED');
ok(/may still be stored in this browser/i.test(failMsg), 'and that data may still be stored here');
ok(/browser settings/i.test(failMsg), 'and points at browser settings as the remedy');
ok(!/All data cleared/i.test(failMsg), 'and never claims success');
eq(prefixedKeys(shim).length, 3, 'the keys really are still there (so the message is true)');
eq(warnsMatching(/clearAll\(\) FAILED/).length, 1, 'and the console warning fired too');

globalThis.document = undefined;
delete globalThis.document;

/* ================================================================================
 * 18. Logo reserve config (BADGE_SPEC ADDENDUM 2 C). Stored in INCHES under
 *     lsuite.badges.logo; converting to points is the caller's job.
 * ============================================================================== */

section('18. logo reserve config: getLogo / setLogo');

var LOGO_KEY = 'lsuite.badges.logo';
/* ON by default since 2026-08-20 (Julia's stock is pre-printed with a corner logo).
   The "writes nothing until something changes it" property below is unaffected: the
   default lives in code, not in storage, so a fresh browser still has no logo key. */
var LOGO_DEFAULTS = { enabled: true, wIn: 1, hIn: 1, pos: 'bottomRight' };

/* --- (a) defaults when the key is absent --------------------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var LA = freshStore();
LA.init();
deepEq(LA.getLogo(), LOGO_DEFAULTS, 'defaults to {enabled:true, wIn:1, hIn:1, pos:bottomRight} with no stored key');
eq(typeof LA.getLogo().enabled, 'boolean', 'enabled is a real boolean, not truthy');
eq(shim.getItem(LOGO_KEY), null, 'no logo key is written until something changes it');
deepEq(prefixedKeys(shim), [], 'the default reserve writes nothing at all — the default is code, not storage');
// the reserve being off must not disturb anything else
LA.setAttendees([{ id: 'lg0', first: 'Perpetua', last: 'Kalinowski', title: 'GC', company: 'Windrose Cement' }]);
deepEq(prefixedKeys(shim), ['lsuite.badges.attendees'], 'still no logo key after unrelated writes');
/* The flip of the default must not have quietly become a write-on-read. */
LA.getLogo();
deepEq(prefixedKeys(shim), ['lsuite.badges.attendees'], 'reading the default never persists it');

/* --- (b) round-trip through a simulated reload --------------------------------- */
LA.setLogo({ enabled: true, wIn: 1.5, hIn: 0.75 });
deepEq(LA.getLogo(), { enabled: true, wIn: 1.5, hIn: 0.75, pos: 'bottomRight' }, 'setLogo applies a full config');
ok(prefixedKeys(shim).indexOf(LOGO_KEY) !== -1, 'the logo key is now on disk');
deepEq(JSON.parse(shim._raw(LOGO_KEY)), { enabled: true, wIn: 1.5, hIn: 0.75, pos: 'bottomRight' },
  'stored payload is exactly {enabled, wIn, hIn, pos}');
var storedLogo = JSON.parse(shim._raw(LOGO_KEY));
ok(storedLogo.wIn === 1.5 && storedLogo.wIn !== 108,
  'stored in INCHES, not points (1.5 in, not 108 pt)');
var LB = freshStore(); // reload
LB.init();
deepEq(LB.getLogo(), { enabled: true, wIn: 1.5, hIn: 0.75, pos: 'bottomRight' }, 'logo config survives the reload identically');

/* --- (c) partial patches must not wipe untouched fields ------------------------ */
LB.setLogo({ enabled: false });
deepEq(LB.getLogo(), { enabled: false, wIn: 1.5, hIn: 0.75, pos: 'bottomRight' },
  'setLogo({enabled:false}) keeps wIn/hIn');
LB.setLogo({ wIn: 2 });
deepEq(LB.getLogo(), { enabled: false, wIn: 2, hIn: 0.75, pos: 'bottomRight' },
  'setLogo({wIn:2}) keeps enabled/hIn');
LB.setLogo({ hIn: 1.25 });
deepEq(LB.getLogo(), { enabled: false, wIn: 2, hIn: 1.25, pos: 'bottomRight' },
  'setLogo({hIn:1.25}) keeps enabled/wIn');
LB.setLogo({ enabled: true });
deepEq(LB.getLogo(), { enabled: true, wIn: 2, hIn: 1.25, pos: 'bottomRight' },
  'setLogo({enabled:true}) keeps the current size');
deepEq(LB.setLogo({ wIn: 2.5 }), { enabled: true, wIn: 2.5, hIn: 1.25, pos: 'bottomRight' },
  'setLogo returns the resulting config');
LB.setLogo({ pos: 'topLeft' });
deepEq(LB.getLogo(), { enabled: true, wIn: 2.5, hIn: 1.25, pos: 'topLeft' },
  'setLogo({pos:topLeft}) keeps enabled and both sizes');
LB.setLogo({ wIn: 2 });
eq(LB.getLogo().pos, 'topLeft', 'and a later size patch keeps the position');
LB.setLogo({ pos: 'bottomRight' }); // back to the baseline for the sections below

/* --- (d) clamping at both ends ------------------------------------------------- */
LB.setLogo({ wIn: -5, hIn: -0.0001 });
deepEq(LB.getLogo(), { enabled: true, wIn: 0, hIn: 0, pos: 'bottomRight' }, 'negative inches clamp UP to 0');
LB.setLogo({ wIn: 99, hIn: 4.0001 });
deepEq(LB.getLogo(), { enabled: true, wIn: 4, hIn: 4, pos: 'bottomRight' }, 'oversize inches clamp DOWN to 4');
LB.setLogo({ wIn: 0, hIn: 4 });
deepEq(LB.getLogo(), { enabled: true, wIn: 0, hIn: 4, pos: 'bottomRight' }, 'the exact bounds 0 and 4 are kept as-is');
LB.setLogo({ wIn: '1.5', hIn: ' 2.25 ' });
deepEq(LB.getLogo(), { enabled: true, wIn: 1.5, hIn: 2.25, pos: 'bottomRight' },
  'numeric strings parse (number inputs hand over strings), whitespace tolerated');
LB.setLogo({ wIn: '1e3' });
eq(LB.getLogo().wIn, 4, 'exponential notation still clamps');

/* --- (e) junk values fall back, never throw, never poison ---------------------- */
LB.setLogo({ enabled: true, wIn: 1, hIn: 1 }); // known baseline
var JUNK = [NaN, Infinity, -Infinity, null, undefined, {}, [], function () {}, 'banana', '', '1.5in', true, false];
JUNK.forEach(function (v) {
  var label = typeof v === 'function' ? 'function' :
    (typeof v === 'object' && v !== null ? (Array.isArray(v) ? '[]' : '{}') : String(v));
  var before = LB.getLogo();
  var threw = null;
  try { LB.setLogo({ wIn: v }); } catch (err) { threw = err; }
  var after = LB.getLogo();
  ok(threw === null && after.wIn === before.wIn,
    'setLogo({wIn:' + label + '}) is ignored (stays ' + before.wIn + '), does not throw');
});
eq(typeof LB.getLogo().wIn, 'number', 'wIn is always a number after the junk sweep');
ok(isFinite(LB.getLogo().wIn), 'and always finite');

/* --- (f) enabled is coerced to a genuine boolean ------------------------------- */
[[1, true], ['1', true], ['true', true], [true, true],
 [0, false], ['0', false], ['false', false], [false, false]].forEach(function (pair) {
  LB.setLogo({ enabled: pair[0] });
  var got = LB.getLogo().enabled;
  ok(got === pair[1] && typeof got === 'boolean',
    'setLogo({enabled:' + JSON.stringify(pair[0]) + '}) -> ' + pair[1] + ' (real boolean)');
});
LB.setLogo({ enabled: true });
LB.setLogo({ enabled: 'maybe' });
eq(LB.getLogo().enabled, true, 'an unrecognised enabled value leaves the current state alone');
LB.setLogo({ enabled: {} });
eq(LB.getLogo().enabled, true, 'an object for enabled is ignored too');

/* --- (g) non-object patches are no-ops ---------------------------------------- */
var beforeNoop = LB.getLogo();
[null, undefined, 42, 'enabled', [], true].forEach(function (v) {
  noThrow(function () { LB.setLogo(v); }, 'setLogo(' + JSON.stringify(v === undefined ? null : v) + ') does not throw');
});
deepEq(LB.getLogo(), beforeNoop, 'and none of them changed the config');

/* --- (h) corrupt stored payloads degrade to the default ----------------------- */
var CORRUPT = [
  ['{not json', 'unparseable JSON'],
  ['"a string"', 'a JSON string'],
  ['123', 'a JSON number'],
  ['null', 'JSON null'],
  ['[]', 'an array'],
  ['[[[["nested"]]]]', 'a nested array'],
  ['true', 'a JSON boolean'],
  ['{"enabled":"yes","wIn":{"x":1},"hIn":[1,2]}', 'right shape, wrong types'],
  ['{"enabled":null,"wIn":"NaN","hIn":"Infinity"}', 'stringified non-numbers'],
  ['{"wIn":-99,"hIn":1000,"enabled":1}', 'out-of-range numbers (clamped, not rejected)']
];
CORRUPT.forEach(function (pair) {
  var raw = pair[0], why = pair[1];
  shim = makeShim();
  globalThis.localStorage = shim;
  shim._put(LOGO_KEY, raw);
  var LC = null;
  var threw = null;
  try { LC = freshStore(); LC.init(); } catch (err) { threw = err; }
  if (threw) {
    checks++;
    console.log('  FAIL  logo key holding ' + why + ' threw: ' + threw.name);
    failures.push('corrupt logo payload threw: ' + why);
    return;
  }
  var got = LC.getLogo();
  var isDefault = got.enabled === LOGO_DEFAULTS.enabled && got.wIn === 1 && got.hIn === 1;
  var isClamped = got.enabled === true && got.wIn === 0 && got.hIn === 4; // the last case
  ok((isDefault || isClamped) && typeof got.enabled === 'boolean',
    'logo key holding ' + why + ' -> safe config ' + JSON.stringify(got));
});

/* --- (i) the RangeError brick, applied to the logo key ------------------------ */
// JSON.parse succeeds on this; it was the implicit ToString that used to throw and then
// poison every later call through ensureLoaded().
shim = makeShim();
globalThis.localStorage = shim;
shim._put(LOGO_KEY, '['.repeat(5000) + ']'.repeat(5000));
shim._put('lsuite.badges.attendees',
  '[{"id":"lg1","first":"Cosima","last":"Broadwater","title":"General Counsel","company":"Ashgrove Rail"}]');
var LD = null;
noThrow(function () { LD = freshStore(); LD.init(); }, 'init() with a 5000-deep array in the logo key does not throw');
deepEq(LD.getLogo(), LOGO_DEFAULTS, 'the pathological logo blob falls back to the default');
eq(LD.getAttendees().length, 1, 'and the other slices still loaded');
noThrow(function () { LD.getLogo(); }, 'getLogo() works afterwards (store not bricked)');
noThrow(function () { LD.setLogo({ enabled: true }); }, 'setLogo() works afterwards');
noThrow(function () { LD.setAttendees([]); }, 'setAttendees() works afterwards');
eq(LD.getLogo().enabled, true, 'and the store is fully functional again');
// same hazard straight through the public API
var deepLogo = [];
var lcur = deepLogo;
for (var dq = 0; dq < 20000; dq++) { var dn = []; lcur.push(dn); lcur = dn; }
noThrow(function () { LD.setLogo({ wIn: deepLogo }); }, 'setLogo({wIn: 20000-deep array}) does not throw');
eq(LD.getLogo().wIn, 1, 'and the value is left at its previous setting');
noThrow(function () { LD.setLogo(deepLogo); }, 'setLogo(deep array as the whole patch) does not throw');

/* --- (j) short-circuit: identical writes cost nothing ------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var LE = freshStore();
LE.init();
var logoHits = 0;
LE.subscribe(function (change) { if (change && change.type === 'logo:changed') logoHits++; });

LE.setLogo({ enabled: true, wIn: 1.25, hIn: 1.25 });
var writesAfterFirst = shim.setItemCalls;
eq(logoHits, 1, 'a real change notifies once');

LE.setLogo({ enabled: true, wIn: 1.25, hIn: 1.25 }); // identical
eq(shim.setItemCalls, writesAfterFirst, 'an identical full config does not write again');
eq(logoHits, 1, 'and does not notify again');

LE.setLogo({ wIn: 1.25 }); // identical single field
eq(shim.setItemCalls, writesAfterFirst, 'an identical single-field patch does not write');
eq(logoHits, 1, 'and does not notify');

LE.setLogo({}); // empty patch
eq(shim.setItemCalls, writesAfterFirst, 'an empty patch does not write');
LE.setLogo('nonsense');
eq(shim.setItemCalls, writesAfterFirst, 'a non-object patch does not write');
eq(logoHits, 1, 'no spurious notifications from empty/garbage patches');

// clamped-to-the-same-value patches are also no-ops
LE.setLogo({ wIn: 99 });
var writesAfterClamp = shim.setItemCalls;
ok(writesAfterClamp > writesAfterFirst, '99 in clamps to 4 and IS a change, so it writes');
LE.setLogo({ wIn: 250 });
eq(shim.setItemCalls, writesAfterClamp, 'another oversize value clamps to the same 4 and does NOT write');
eq(logoHits, 2, 'and notified only for the first of the two');

LE.setLogo({ enabled: false });
eq(logoHits, 3, 'toggling off is a real change');

/* --- (k) logo:changed on the bus, only for real changes ---------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var busLog = [];
globalThis.BadgeBus = {
  on: function () { return function () {}; },
  emit: function (evt, payload) { busLog.push({ evt: evt, payload: payload }); }
};
var LF = freshStore();
LF.init();
busLog = [];
/* enabled:true is now the DEFAULT, so toggling it on is not a change and must not
   emit. Toggling it OFF is the real change on a fresh store. */
LF.setLogo({ enabled: true });
eq(busLog.length, 0, 'setting the reserve to the value it already has emits nothing');
LF.setLogo({ enabled: false });
eq(busLog.length, 1, 'one bus event for one real change');
eq(busLog[0].evt, 'logo:changed', 'the event name is logo:changed');
deepEq(busLog[0].payload, { logo: { enabled: false, wIn: 1, hIn: 1, pos: 'bottomRight' } },
  'the payload carries the full resulting config');
LF.setLogo({ enabled: false }); // identical
eq(busLog.length, 1, 'no bus event when nothing changed');
LF.setLogo({ wIn: 2 });
eq(busLog.length, 2, 'a size change emits again');
// mutating what a subscriber received must not corrupt store state
busLog[1].payload.logo.wIn = 999;
eq(LF.getLogo().wIn, 2, 'the emitted payload is a copy, not live state');
var got1 = LF.getLogo();
got1.enabled = true;   // deliberately the OPPOSITE of the stored value, so the
got1.wIn = 42;         // assertion below fails if the copy is not a copy
deepEq(LF.getLogo(), { enabled: false, wIn: 2, hIn: 1, pos: 'bottomRight' }, 'getLogo() returns a copy too');

/* --- (l) clearAll() sweeps lsuite.badges.logo -------------------------------- */
LF.setAttendees([{ id: 'lg2', first: 'Evanthia', last: 'Roskilly', title: 'DGC', company: 'Pemberton Glass' }]);
LF.setOverride('lg2', { first: -1 });
LF.setPageIndex(1);
LF.setLogo({ enabled: true, wIn: 1.5, hIn: 1.5 });
deepEq(prefixedKeys(shim),
  ['lsuite.badges.attendees', 'lsuite.badges.logo', 'lsuite.badges.overrides', 'lsuite.badges.pageIndex'],
  'all four keys are on disk before the wipe');
busLog = [];
eq(LF.clearAll(), true, 'clearAll() reports a real wipe');
deepEq(prefixedKeys(shim), [], 'ZERO prefixed keys remain — lsuite.badges.logo included');
eq(shim.getItem(LOGO_KEY), null, 'the logo key specifically is gone (asserted on getItem)');
deepEq(LF.getLogo(), LOGO_DEFAULTS, 'in-memory logo config reset to the default');
ok(busLog.filter(function (e) { return e.evt === 'logo:changed'; }).length === 1,
  'clearAll() emits logo:changed so the preview drops the guide');
var LG = freshStore(); // and it stays gone across a reload
LG.init();
deepEq(LG.getLogo(), LOGO_DEFAULTS, 'after reload the logo config is back to the default');

// a renamed/legacy logo key must be swept by the prefix scan too
LG.setLogo({ enabled: true });
shim._put('lsuite.badges.logo.v2', '{"enabled":true}');
shim._put('lsuite.badges.logoDraft', '{"wIn":3}');
eq(LG.clearAll(), true, 'clearAll() succeeds with legacy logo keys present');
deepEq(prefixedKeys(shim), [], 'legacy logo-ish keys are swept by the prefix scan as well');
delete globalThis.BadgeBus;

/* --- (m) the contract the blocked modules code against ---------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var LH = freshStore();
LH.init();
var shape = LH.getLogo();
deepEq(Object.keys(shape).sort(), ['enabled', 'hIn', 'pos', 'wIn'], 'getLogo() returns exactly {enabled, wIn, hIn, pos}');
eq(typeof LH.getLogo, 'function', 'getLogo is exposed on window.BadgeStore');
eq(typeof LH.setLogo, 'function', 'setLogo is exposed on window.BadgeStore');
eq(LH.KEYS.logo, LOGO_KEY, 'KEYS.logo names the storage key');
deepEq(LH.LOGO_LIMITS, { minIn: 0, maxIn: 4, defaults: LOGO_DEFAULTS },
  'LOGO_LIMITS publishes the clamp range and defaults for the UI');
// points conversion is the caller's job — prove the store never does it
LH.setLogo({ enabled: true, wIn: 1, hIn: 1 });
deepEq(LH.getLogo(), { enabled: true, wIn: 1, hIn: 1, pos: 'bottomRight' },
  '1 in stays 1 (the x72 to 72 pt is the caller\'s conversion, per ADDENDUM 2 C)');

/* --- (n) the corner position (added 2026-08-28) ------------------------------- */
['bottomRight', 'topRight', 'topLeft'].forEach(function (p) {
  LH.setLogo({ pos: p });
  eq(LH.getLogo().pos, p, 'setLogo({pos:"' + p + '"}) round-trips');
});
LH.setLogo({ pos: 'topLeft' });
var LH2 = freshStore(); // reload
LH2.init();
eq(LH2.getLogo().pos, 'topLeft', 'the position survives a simulated reload');
// junk keeps the CURRENT position, exactly like junk inches keep the current size
[null, undefined, 42, {}, [], true, 'bottomLeft', 'TOPLEFT', ' topLeft ', ''].forEach(function (v) {
  noThrow(function () { LH2.setLogo({ pos: v }); },
    'setLogo({pos:' + (typeof v === 'string' ? JSON.stringify(v) : String(v)) + '}) does not throw');
  eq(LH2.getLogo().pos, 'topLeft', 'and the stored position is untouched');
});
// a config saved BEFORE the option existed simply lacks the key -> default corner
shim._put(LOGO_KEY, '{"enabled":true,"wIn":2,"hIn":1}');
var LH3 = freshStore();
LH3.init();
deepEq(LH3.getLogo(), { enabled: true, wIn: 2, hIn: 1, pos: 'bottomRight' },
  'a pre-position stored config reads back with pos:bottomRight — what it always printed as');
// a corrupt pos in storage lands on the default, keeping the sizes
shim._put(LOGO_KEY, '{"enabled":true,"wIn":2,"hIn":1,"pos":"underneath"}');
var LH4 = freshStore();
LH4.init();
deepEq(LH4.getLogo(), { enabled: true, wIn: 2, hIn: 1, pos: 'bottomRight' },
  'an unrecognised stored pos falls back to bottomRight without disturbing the sizes');

/* ================================================================================
 * 19. REGRESSION: hostile attendee ids must not reach Object.prototype.
 *     With a plain {} map, overrides['__proto__'] = x sets the PROTOTYPE instead of
 *     creating an own key: getOverrides() reported {} while getOverride() returned a
 *     truthy inherited value, and clearOverride() could never remove it — an override
 *     panel showing sizes that disagree with what the preview and PDF actually draw.
 * ============================================================================== */

section('19. REGRESSION: prototype-polluting attendee ids');

var HOSTILE = ['__proto__', 'constructor', 'toString', 'valueOf'];
function hasOwnKey(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

shim = makeShim();
globalThis.localStorage = shim;
var PA = freshStore();
PA.init();
PA.setAttendees(HOSTILE.map(function (id, i) {
  return { id: id, first: 'Hostile' + i, last: 'Fixture', title: 'General Counsel', company: 'Probe Industries' };
}));
eq(PA.getAttendees().length, 4, 'four attendees with dangerous ids are stored');

/* --- (a) an UNSET dangerous id must read back as null, not an inherited value --- */
HOSTILE.forEach(function (id) {
  eq(PA.getOverride(id), null, 'getOverride("' + id + '") is null when unset (no inherited value)');
});
deepEq(PA.getOverrides(), {}, 'getOverrides() is empty when nothing is set');

/* --- (b) set / read / enumerate / persist --------------------------------------- */
HOSTILE.forEach(function (id) {
  PA.setOverride(id, { first: -2, last: -1 });
});
HOSTILE.forEach(function (id) {
  deepEq(PA.getOverride(id), { first: -2, last: -1 }, 'getOverride("' + id + '") returns the real override');
  ok(hasOwnKey(PA.getOverrides(), id), 'getOverrides() carries "' + id + '" as an OWN key');
});
eq(Object.keys(PA.getOverrides()).length, 4, 'getOverrides() enumerates all four');
var handedOut = PA.getOverrides();
eq(Object.getPrototypeOf(handedOut), Object.prototype,
  'the object handed out is a normal object (callers may use .hasOwnProperty)');
eq(typeof handedOut.hasOwnProperty, 'function', 'and .hasOwnProperty is callable on it');
ok(JSON.stringify(handedOut).indexOf('__proto__') !== -1,
  'and it is JSON-serializable with the hostile key intact');

/* --- (c) what is on disk is plain and serializable ---------------------------- */
var rawOv = shim._raw('lsuite.badges.overrides');
ok(rawOv.indexOf('"__proto__"') !== -1, 'the persisted JSON contains the "__proto__" key');
var parsedOv = JSON.parse(rawOv);
HOSTILE.forEach(function (id) {
  ok(hasOwnKey(parsedOv, id), 'persisted JSON has "' + id + '" as an own key');
});

/* --- (d) round-trip through a simulated reload -------------------------------- */
var PB = freshStore();
PB.init();
HOSTILE.forEach(function (id) {
  deepEq(PB.getOverride(id), { first: -2, last: -1 },
    '"' + id + '" override survives the reload');
  ok(hasOwnKey(PB.getOverrides(), id), 'and is an own key after the reload');
});
eq(Object.keys(PB.getOverrides()).length, 4, 'all four survive the reload');

/* --- (e) clearOverride works and removes ONLY that id ------------------------- */
eq(PB.clearOverride('__proto__'), true, 'clearOverride("__proto__") returns true (it used to return false)');
eq(PB.getOverride('__proto__'), null, 'and the override is really gone (it used to persist forever)');
eq(Object.keys(PB.getOverrides()).length, 3, 'the other three are untouched');
eq(PB.clearOverride('__proto__'), false, 'clearing it again is a no-op');
HOSTILE.slice(1).forEach(function (id) {
  eq(PB.clearOverride(id), true, 'clearOverride("' + id + '") returns true');
  eq(PB.getOverride(id), null, 'and "' + id + '" reads back null');
});
deepEq(PB.getOverrides(), {}, 'all hostile overrides cleared');

/* --- (f) removeAttendee and orphan pruning cope with hostile ids -------------- */
PB.setOverride('__proto__', { first: -1 });
PB.setOverride('toString', { last: -1 });
eq(PB.removeAttendee('__proto__'), true, 'removeAttendee("__proto__") works');
eq(PB.getOverride('__proto__'), null, 'and takes its override with it');
ok(hasOwnKey(PB.getOverrides(), 'toString'), 'the unrelated hostile override survives');
PB.setAttendees([{ id: 'plain1', first: 'Ordinary', last: 'Fixture', title: 'GC', company: 'Probe Industries' }]);
deepEq(PB.getOverrides(), {}, 'replacing the list prunes hostile orphans too');
// pruning on load, with a hand-edited file
shim._put('lsuite.badges.overrides', '{"plain1":{"first":-1},"__proto__":{"last":-1},"toString":{"title":1}}');
var PC = freshStore();
PC.init();
deepEq(Object.keys(PC.getOverrides()).sort(), ['plain1'],
  'load() prunes hostile orphans and keeps the legitimate one');
eq(PC.getOverride('__proto__'), null, 'the pruned hostile id reads back null');

/* --- (g) nothing leaked onto Object.prototype -------------------------------- */
eq(({}).first, undefined, 'Object.prototype has no leaked "first"');
eq(({}).last, undefined, 'Object.prototype has no leaked "last"');
eq(Object.prototype.first, undefined, 'Object.prototype itself is clean');
eq(typeof ({}).toString, 'function', 'and Object.prototype.toString is still a function');
eq(Object.keys({}).length, 0, 'a fresh literal is still empty');

/* ================================================================================
 * 20. Sheet layout preset. Same 288x216 cells either way; only the grid ORIGIN
 *     differs — (0,0) sampleTopLeft vs (18,72) pt avery. Store keeps the string.
 * ============================================================================== */

section('20. sheet layout preset: getSheetPreset / setSheetPreset');

var SHEET_KEY = 'lsuite.badges.sheetPreset';

/* --- (a) default when absent, and nothing written -------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var SA = freshStore();
SA.init();
eq(SA.getSheetPreset(), 'sampleTopLeft', 'defaults to sampleTopLeft');
eq(shim.getItem(SHEET_KEY), null, 'no key is written while the default is in force');
deepEq(prefixedKeys(shim), [], 'a default preset writes nothing at all');

/* --- (b) round-trip through a simulated reload ---------------------------- */
eq(SA.setSheetPreset('avery'), 'avery', 'setSheetPreset returns the value in force');
eq(SA.getSheetPreset(), 'avery', 'the preset is applied');
eq(shim._raw(SHEET_KEY), '"avery"', 'stored as a bare JSON string, nothing else');
var SB = freshStore();
SB.init();
eq(SB.getSheetPreset(), 'avery', 'the preset survives the reload');
eq(SB.setSheetPreset('sampleTopLeft'), 'sampleTopLeft', 'switching back works');
eq(shim._raw(SHEET_KEY), '"sampleTopLeft"', 'and is persisted');

/* --- (c) junk falls back to the default, never throws --------------------- */
var deepSheet = [];
var scur = deepSheet;
for (var sq = 0; sq < 20000; sq++) { var sn = []; scur.push(sn); scur = sn; }
var SHEET_JUNK = [
  [42, '42'], ['nonsense', '"nonsense"'], ['Avery', '"Avery" (wrong case)'],
  ['AVERY', '"AVERY"'], ['', 'empty string'], [null, 'null'], [undefined, 'undefined'],
  [NaN, 'NaN'], [true, 'true'], [false, 'false'], [{}, 'an object'],
  [{ key: 'avery' }, 'an object that mentions avery'], [[], 'an array'],
  [['avery'], 'an array containing avery'], [function () {}, 'a function'],
  [deepSheet, 'a 20000-deep array']
];
SHEET_JUNK.forEach(function (pair) {
  var SC = freshStore();
  SC.init();
  SC.setSheetPreset('avery'); // known non-default starting point
  var threw = null;
  var got = null;
  try { SC.setSheetPreset(pair[0]); got = SC.getSheetPreset(); } catch (err) { threw = err; }
  ok(threw === null && got === 'sampleTopLeft',
    'setSheetPreset(' + pair[1] + ') falls back to the default without throwing');
});
eq(typeof SA.getSheetPreset(), 'string', 'getSheetPreset always returns a string');
// whitespace around a valid key is tolerated
var SD = freshStore();
SD.init();
eq(SD.setSheetPreset('  avery  '), 'avery', 'a padded valid key is trimmed and accepted');

/* --- (d) corrupt stored values degrade to the default -------------------- */
[['{not json', 'unparseable JSON'], ['123', 'a number'], ['null', 'JSON null'],
 ['{"key":"avery"}', 'an object'], ['["avery"]', 'an array'], ['"nonsense"', 'an unknown string'],
 ['true', 'a boolean'], ['[' + '['.repeat(4999) + ']'.repeat(4999) + ']', 'a 5000-deep array']
].forEach(function (pair) {
  shim = makeShim();
  globalThis.localStorage = shim;
  shim._put(SHEET_KEY, pair[0]);
  var SE = null;
  var threw = null;
  try { SE = freshStore(); SE.init(); } catch (err) { threw = err; }
  ok(threw === null && SE && SE.getSheetPreset() === 'sampleTopLeft',
    'stored ' + pair[1] + ' -> default, no throw');
});
// and the store is not bricked by the pathological one
var SF = freshStore();
SF.init();
noThrow(function () { SF.getAttendees(); SF.setSheetPreset('avery'); SF.getLogo(); },
  'the store still works after a pathological sheetPreset value');

/* --- (e) valid keys come from BadgeSpec, so the two cannot drift ---------- */
shim = makeShim();
globalThis.localStorage = shim;
globalThis.BadgeSpec = {
  SHEET_PRESETS: { sampleTopLeft: { originX: 0, originY: 0 }, avery: { originX: 18, originY: 72 }, thirdParty: { originX: 9, originY: 9 } },
  SHEET_PRESET_DEFAULT: 'avery'
};
var SG = freshStore();
SG.init();
eq(SG.getSheetPreset(), 'avery', 'the default is taken from BadgeSpec.SHEET_PRESET_DEFAULT');
eq(SG.setSheetPreset('thirdParty'), 'thirdParty', 'a preset key added in spec.js is accepted');
eq(SG.setSheetPreset('notInSpec'), 'avery', 'and an unknown key falls back to the spec default');
delete globalThis.BadgeSpec;
var SH = freshStore();
SH.init();
eq(SH.getSheetPreset(), 'avery', 'a previously stored valid key still loads without BadgeSpec');
eq(SH.setSheetPreset('sampleTopLeft'), 'sampleTopLeft', 'the hardcoded fallback list still works');
eq(SH.setSheetPreset('thirdParty'), 'sampleTopLeft',
  'without spec.js the fallback list rejects the spec-only key (fails safe)');

/* --- (f) short-circuit on identical selections --------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var SI = freshStore();
SI.init();
var sheetHits = 0;
SI.subscribe(function (change) { if (change && change.type === 'sheet:changed') sheetHits++; });
SI.setSheetPreset('avery');
var writesAfterSwitch = shim.setItemCalls;
eq(sheetHits, 1, 'a real switch notifies once');
SI.setSheetPreset('avery');
eq(shim.setItemCalls, writesAfterSwitch, 're-selecting the same preset does not write');
eq(sheetHits, 1, 'and does not notify');
SI.setSheetPreset('  avery  ');
eq(shim.setItemCalls, writesAfterSwitch, 'a padded form of the current preset does not write');
SI.setSheetPreset('garbage'); // falls back to sampleTopLeft, which IS a change
ok(shim.setItemCalls > writesAfterSwitch, 'a fallback that changes the value does write');
eq(sheetHits, 2, 'and notifies');
var writesAfterFallback = shim.setItemCalls;
SI.setSheetPreset('garbage'); // already at the default now
eq(shim.setItemCalls, writesAfterFallback, 'a fallback to the value already in force does not write');
eq(sheetHits, 2, 'and does not notify');

/* --- (g) sheet:changed on the bus, only for real changes ----------------- */
shim = makeShim();
globalThis.localStorage = shim;
var sheetBus = [];
globalThis.BadgeBus = {
  on: function () { return function () {}; },
  emit: function (evt, payload) { sheetBus.push({ evt: evt, payload: payload }); }
};
var SJ = freshStore();
SJ.init();
sheetBus = [];
SJ.setSheetPreset('avery');
eq(sheetBus.length, 1, 'one bus event for one real change');
eq(sheetBus[0].evt, 'sheet:changed', 'the event name is sheet:changed');
deepEq(sheetBus[0].payload, { sheetPreset: 'avery' }, 'the payload carries the preset key');
SJ.setSheetPreset('avery');
eq(sheetBus.length, 1, 'no bus event when nothing changed');
SJ.setSheetPreset('sampleTopLeft');
eq(sheetBus.length, 2, 'switching back emits again');

/* --- (h) clearAll() sweeps BOTH new keys -------------------------------- */
SJ.setAttendees([{ id: 'sh1', first: 'Wilhelmina', last: 'Castellanos', title: 'General Counsel', company: 'Ridgemont Steel' }]);
SJ.setOverride('sh1', { first: -1 });
SJ.setPageIndex(1);
SJ.setLogo({ enabled: true, wIn: 1.5 });
SJ.setSheetPreset('avery');
deepEq(prefixedKeys(shim),
  ['lsuite.badges.attendees', 'lsuite.badges.logo', 'lsuite.badges.overrides',
   'lsuite.badges.pageIndex', 'lsuite.badges.sheetPreset'],
  'all FIVE keys are on disk before the wipe');
sheetBus = [];
eq(SJ.clearAll(), true, 'clearAll() reports a real wipe');
deepEq(prefixedKeys(shim), [], 'ZERO prefixed keys remain — logo AND sheetPreset included');
eq(shim.getItem(SHEET_KEY), null, 'the sheetPreset key specifically is gone (asserted on getItem)');
eq(shim.getItem('lsuite.badges.logo'), null, 'the logo key specifically is gone too');
eq(SJ.getSheetPreset(), 'sampleTopLeft', 'in-memory preset reset to the default');
eq(sheetBus.filter(function (e) { return e.evt === 'sheet:changed'; }).length, 1,
  'clearAll() emits sheet:changed');
var SK = freshStore();
SK.init();
eq(SK.getSheetPreset(), 'sampleTopLeft', 'and it stays default across a reload');
// legacy/renamed variants are swept by the prefix scan as well
SK.setSheetPreset('avery');
shim._put('lsuite.badges.sheetPreset.v2', '"avery"');
shim._put('lsuite.badges.sheet', '"avery"');
eq(SK.clearAll(), true, 'clearAll() succeeds with legacy sheet keys present');
deepEq(prefixedKeys(shim), [], 'legacy sheet keys swept too');
delete globalThis.BadgeBus;

/* --- (i) the contract the blocked modules code against ------------------ */
shim = makeShim();
globalThis.localStorage = shim;
var SL = freshStore();
SL.init();
eq(typeof SL.getSheetPreset, 'function', 'getSheetPreset is exposed on window.BadgeStore');
eq(typeof SL.setSheetPreset, 'function', 'setSheetPreset is exposed on window.BadgeStore');
eq(SL.KEYS.sheetPreset, SHEET_KEY, 'KEYS.sheetPreset names the storage key');
ok(['sampleTopLeft', 'avery'].indexOf(SL.getSheetPreset()) !== -1,
  'getSheetPreset returns one of the two documented keys');

/* ================================================================================
 * 21. Badge text alignment. Sheet-wide, default 'left' — a CHANGED default for how
 *     badges print, so the "nothing is written while default" rule matters here:
 *     an existing install with no align key must read as 'left', not as 'center'.
 * ============================================================================== */

section('21. text alignment: getAlign / setAlign');

var ALIGN_KEY = 'lsuite.badges.align';

/* --- (a) default when absent, and nothing written --------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var AA = freshStore();
AA.init();
eq(AA.getAlign(), 'left', 'defaults to left');
eq(shim.getItem(ALIGN_KEY), null, 'no key is written while the default is in force');
deepEq(prefixedKeys(shim), [], 'a default alignment writes nothing at all');
AA.setAttendees([{ id: 'al0', first: 'Rosalind', last: 'Featherstone', title: 'GC', company: 'Kingsmere Paper' }]);
deepEq(prefixedKeys(shim), ['lsuite.badges.attendees'], 'still no align key after unrelated writes');

/* --- (b) round-trip through a simulated reload ------------------------------ */
eq(AA.setAlign('center'), 'center', 'setAlign returns the value in force');
eq(AA.getAlign(), 'center', 'the alignment is applied');
eq(shim._raw(ALIGN_KEY), '"center"', 'stored as a bare JSON string, nothing else');
var AB = freshStore();
AB.init();
eq(AB.getAlign(), 'center', 'the alignment survives the reload');
eq(AB.setAlign('left'), 'left', 'switching back works');
eq(shim._raw(ALIGN_KEY), '"left"', 'and is persisted');

/* --- (c) junk falls back to the default, never throws ---------------------- */
var deepAlign = [];
var acur = deepAlign;
for (var aq = 0; aq < 20000; aq++) { var an = []; acur.push(an); acur = an; }
var ALIGN_JUNK = [
  [42, '42'], [0, '0'], ['LEFT', '"LEFT" (wrong case)'], ['Center', '"Center"'],
  ['justify', '"justify"'], ['right', '"right"'], ['', 'empty string'],
  [null, 'null'], [undefined, 'undefined'], [NaN, 'NaN'], [true, 'true'], [false, 'false'],
  [{}, 'an object'], [{ align: 'center' }, 'an object that mentions center'],
  [[], 'an array'], [['center'], 'an array containing center'],
  [function () {}, 'a function'], [deepAlign, 'a 20000-deep array']
];
ALIGN_JUNK.forEach(function (pair) {
  var AC = freshStore();
  AC.init();
  AC.setAlign('center'); // known non-default starting point
  var threw = null;
  var got = null;
  try { AC.setAlign(pair[0]); got = AC.getAlign(); } catch (err) { threw = err; }
  ok(threw === null && got === 'left',
    'setAlign(' + pair[1] + ') falls back to left without throwing');
});
eq(typeof AA.getAlign(), 'string', 'getAlign always returns a string');
var AD = freshStore();
AD.init();
eq(AD.setAlign('  center  '), 'center', 'a padded valid value is trimmed and accepted');
eq(AD.setAlign('\tleft\n'), 'left', 'tabs and newlines are trimmed too');

/* --- (d) corrupt stored payloads degrade to the default -------------------- */
[['{not json', 'unparseable JSON'], ['123', 'a number'], ['null', 'JSON null'],
 ['{"align":"center"}', 'an object'], ['["center"]', 'an array'], ['"justify"', 'an unknown string'],
 ['true', 'a boolean'], ['"CENTER"', 'a wrong-case string'],
 ['[' + '['.repeat(4999) + ']'.repeat(4999) + ']', 'a 5000-deep array']
].forEach(function (pair) {
  shim = makeShim();
  globalThis.localStorage = shim;
  shim._put(ALIGN_KEY, pair[0]);
  var AE = null;
  var threw = null;
  try { AE = freshStore(); AE.init(); } catch (err) { threw = err; }
  ok(threw === null && AE && AE.getAlign() === 'left',
    'stored ' + pair[1] + ' -> left, no throw');
});
// the pathological one must not brick the store (the old RangeError failure mode)
shim = makeShim();
globalThis.localStorage = shim;
shim._put(ALIGN_KEY, '[' + '['.repeat(4999) + ']'.repeat(4999) + ']');
shim._put('lsuite.badges.attendees',
  '[{"id":"al1","first":"Barnaby","last":"Ellingsworth","title":"General Counsel","company":"Thorne & Halliwell"}]');
var AF = freshStore();
AF.init();
eq(AF.getAlign(), 'left', 'a 5000-deep align value falls back to left');
eq(AF.getAttendees().length, 1, 'and the other slices still loaded');
noThrow(function () { AF.getAlign(); AF.setAlign('center'); AF.getLogo(); AF.getSheetPreset(); AF.setAttendees([]); },
  'the store is fully usable after the pathological align value');
eq(AF.getAlign(), 'center', 'and writes after it take effect');

/* --- (e) valid set + default come from BadgeSpec, at call time ------------- */
shim = makeShim();
globalThis.localStorage = shim;
globalThis.BadgeSpec = { ALIGNS: { left: 1, center: 1, justify: 1 }, ALIGN_DEFAULT: 'center' };
var AG = freshStore();
AG.init();
eq(AG.getAlign(), 'center', 'the default comes from BadgeSpec.ALIGN_DEFAULT');
eq(AG.setAlign('justify'), 'justify', 'a value added in spec.js is accepted');
eq(AG.setAlign('nonsense'), 'center', 'and an unknown value falls back to the spec default');
// the spec may publish an ARRAY instead of an object — both shapes must work
shim = makeShim(); // fresh: with no stored value the DEFAULT is what we are testing
globalThis.localStorage = shim;
globalThis.BadgeSpec = { ALIGNS: ['left', 'center', 'start'], ALIGN_DEFAULT: 'left' };
var AH = freshStore();
AH.init();
eq(AH.getAlign(), 'left', 'an array-shaped ALIGNS still yields the spec default');
eq(AH.setAlign('start'), 'start', 'and its values are accepted');
// a broken/empty spec must not strand the user: fall back to the hardcoded set
shim = makeShim();
globalThis.localStorage = shim;
globalThis.BadgeSpec = { ALIGNS: {}, ALIGN_DEFAULT: 'nope' };
var AI = freshStore();
AI.init();
eq(AI.getAlign(), 'left', 'an empty ALIGNS falls back to the hardcoded default');
eq(AI.setAlign('center'), 'center', 'and the hardcoded set still works');
delete globalThis.BadgeSpec;
var AJ = freshStore(); // same shim: AI stored "center" above
AJ.init();
eq(AJ.getAlign(), 'center', 'a previously stored valid value still loads without BadgeSpec');
eq(AJ.setAlign('justify'), 'left',
  'without spec.js the fallback set rejects the spec-only value (fails safe to left)');

/* --- (f) short-circuit on identical selections ---------------------------- */
shim = makeShim();
globalThis.localStorage = shim;
var AK = freshStore();
AK.init();
var alignHits = 0;
AK.subscribe(function (change) { if (change && change.type === 'align:changed') alignHits++; });
AK.setAlign('center');
var writesAfterSwitch = shim.setItemCalls;
eq(alignHits, 1, 'a real switch notifies once');
AK.setAlign('center');
eq(shim.setItemCalls, writesAfterSwitch, 're-selecting the same alignment does not write');
eq(alignHits, 1, 'and does not notify');
AK.setAlign('  center  ');
eq(shim.setItemCalls, writesAfterSwitch, 'a padded form of the current alignment does not write');
eq(alignHits, 1, 'and does not notify either');
AK.setAlign('garbage'); // falls back to left, which IS a change
ok(shim.setItemCalls > writesAfterSwitch, 'a fallback that changes the value does write');
eq(alignHits, 2, 'and notifies');
var writesAfterFallback = shim.setItemCalls;
AK.setAlign('garbage'); // already at left
eq(shim.setItemCalls, writesAfterFallback, 'a fallback to the value already in force does not write');
eq(alignHits, 2, 'and does not notify');

/* --- (g) align:changed on the bus, only for real changes ------------------ */
shim = makeShim();
globalThis.localStorage = shim;
var alignBus = [];
globalThis.BadgeBus = {
  on: function () { return function () {}; },
  emit: function (evt, payload) { alignBus.push({ evt: evt, payload: payload }); }
};
var AL = freshStore();
AL.init();
alignBus = [];
AL.setAlign('center');
eq(alignBus.length, 1, 'one bus event for one real change');
eq(alignBus[0].evt, 'align:changed', 'the event name is align:changed');
deepEq(alignBus[0].payload, { align: 'center' }, 'the payload carries the alignment');
AL.setAlign('center');
eq(alignBus.length, 1, 'no bus event when nothing changed');
AL.setAlign('left');
eq(alignBus.length, 2, 'switching back emits again');

/* --- (h) clearAll() sweeps ALL THREE settings keys ----------------------- */
AL.setAttendees([{ id: 'al2', first: 'Genevieve', last: 'Ostrowski', title: 'General Counsel', company: 'Halberd Marine' }]);
AL.setOverride('al2', { first: -1 });
AL.setPageIndex(1);
AL.setLogo({ enabled: true, wIn: 1.5 });
AL.setSheetPreset('avery');
AL.setAlign('center');
deepEq(prefixedKeys(shim),
  ['lsuite.badges.align', 'lsuite.badges.attendees', 'lsuite.badges.logo',
   'lsuite.badges.overrides', 'lsuite.badges.pageIndex', 'lsuite.badges.sheetPreset'],
  'all SIX keys are on disk before the wipe');
alignBus = [];
eq(AL.clearAll(), true, 'clearAll() reports a real wipe');
deepEq(prefixedKeys(shim), [], 'ZERO prefixed keys remain');
eq(shim.getItem(ALIGN_KEY), null, 'the align key specifically is gone (asserted on getItem)');
eq(shim.getItem('lsuite.badges.sheetPreset'), null, 'the sheetPreset key specifically is gone');
eq(shim.getItem('lsuite.badges.logo'), null, 'the logo key specifically is gone');
eq(AL.getAlign(), 'left', 'in-memory alignment reset to left');
eq(AL.getSheetPreset(), 'sampleTopLeft', 'sheet preset reset too');
eq(AL.getLogo().enabled, true, 'logo reserve reset too — back to the ON default, not to off');
eq(alignBus.filter(function (e) { return e.evt === 'align:changed'; }).length, 1,
  'clearAll() emits align:changed');
var AM = freshStore();
AM.init();
eq(AM.getAlign(), 'left', 'and it stays left across a reload');
// legacy/renamed variants swept by the prefix scan
AM.setAlign('center');
shim._put('lsuite.badges.align.v2', '"center"');
shim._put('lsuite.badges.textAlign', '"center"');
eq(AM.clearAll(), true, 'clearAll() succeeds with legacy align keys present');
deepEq(prefixedKeys(shim), [], 'legacy align keys swept too');
delete globalThis.BadgeBus;

/* --- (i) the contract the blocked modules code against ------------------ */
shim = makeShim();
globalThis.localStorage = shim;
var AN = freshStore();
AN.init();
eq(typeof AN.getAlign, 'function', 'getAlign is exposed on window.BadgeStore');
eq(typeof AN.setAlign, 'function', 'setAlign is exposed on window.BadgeStore');
eq(AN.KEYS.align, ALIGN_KEY, 'KEYS.align names the storage key');
ok(['left', 'center'].indexOf(AN.getAlign()) !== -1, 'getAlign returns one of the two documented values');
// the three settings are independent of one another
AN.setAlign('center');
AN.setSheetPreset('avery');
AN.setLogo({ enabled: true, wIn: 2 });
deepEq({ a: AN.getAlign(), s: AN.getSheetPreset(), l: AN.getLogo() },
  { a: 'center', s: 'avery', l: { enabled: true, wIn: 2, hIn: 1, pos: 'bottomRight' } },
  'alignment, sheet preset and logo reserve do not interfere with each other');
AN.setAlign('left');
deepEq({ s: AN.getSheetPreset(), l: AN.getLogo().wIn }, { s: 'avery', l: 2 },
  'changing alignment leaves the other two settings alone');

/* ------------------------------------------------------------------------ report */

console.warn = realWarn;
console.error = realError;
console.log('\n' + checks + ' checks, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(function (f) { console.log(' - ' + f); });
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
