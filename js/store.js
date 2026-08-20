/*
 * js/store.js — window.BadgeStore
 *
 * The only place in the app that persists anything, and the only place that touches
 * localStorage. Three keys, one prefix:
 *
 *   lsuite.badges.attendees   JSON array  of { id, first, last, title, company }
 *   lsuite.badges.overrides   JSON object of id -> { first, last, company, title }  (0.5pt nudges)
 *   lsuite.badges.pageIndex   JSON number (0-based page currently shown)
 *   lsuite.badges.align       JSON string — 'left' (default) or 'center'. Sheet-wide.
 *   lsuite.badges.sheetPreset JSON string — 'sampleTopLeft' (grid origin 0,0) or 'avery'
 *                             (origin 18,72 pt = 0.25 in left, 1 in top). ADDENDUM 2.
 *   lsuite.badges.logo        JSON object { enabled, wIn, hIn } — the bottom-right logo
 *                             reserve block (BADGE_SPEC ADDENDUM 2 C). Stored in INCHES;
 *                             converting to points (x72) is the CALLER's job.
 *
 * PRIVACY: localStorage only. No cookies, no analytics, no telemetry, no network of any
 * kind. This file calls exactly two host APIs — window.localStorage and console — and
 * nothing here ever leaves the browser.
 * (Deliberately not naming the banned APIs here either: the CI grep for them must come
 *  back empty on this file, comments included.)
 *
 * clearAll() is the one function in this file that must never lie. It wipes every key
 * under the prefix, then RE-READS each one to confirm it is really gone, and returns
 * false if anything survived. "Clear all data" is the user's visible promise that the
 * data is local and erasable; reporting success while the attendee list is still on disk
 * is the worst failure this module could have.
 *
 * ROBUSTNESS: localStorage may be missing entirely (Safari private mode), may throw on
 * write (QuotaExceededError), may lack removeItem, and its contents may be corrupt or
 * hand-edited. Every read is wrapped and validated, no value from storage is ever
 * implicitly stringified (that is how a deeply nested array turns into a RangeError),
 * and `loaded` is set in a `finally` so a single bad read can never brick every later
 * call. A bad write degrades to in-memory-only operation with a warning.
 *
 * Works under file:// (opaque origin) — no hostname is ever consulted.
 * Classic script, no ES modules, no DOM.
 */
(function (window) {
  'use strict';

  var PREFIX = 'lsuite.badges.';
  var KEY_ATTENDEES = PREFIX + 'attendees';
  var KEY_OVERRIDES = PREFIX + 'overrides';
  var KEY_PAGE = PREFIX + 'pageIndex';
  var KEY_LOGO = PREFIX + 'logo';
  var KEY_SHEET = PREFIX + 'sheetPreset';
  var KEY_ALIGN = PREFIX + 'align';
  var ALL_KEYS = [KEY_ATTENDEES, KEY_OVERRIDES, KEY_PAGE, KEY_LOGO, KEY_SHEET, KEY_ALIGN];

  var FIELDS = ['first', 'last', 'title', 'company'];
  var NUDGE_FIELDS = ['first', 'last', 'company', 'title'];

  /* Logo reserve block. ON by default (Julia, 2026-08-20): the stock she prints on has a
     pre-printed logo in each badge's bottom-right corner, so reserving that corner is the
     normal case. BadgeSpec.LOGO_DEFAULT is the authority and is read at call time by
     logoDefault() below; this copy is only the fallback for a build where spec.js failed
     to load, so the two can no longer drift.
     INCHES, never points — 1 in is 72 pt, and that conversion belongs to the caller.
     NOTE: a browser that already saved `lsuite.badges.logo` keeps whatever it saved; the
     default only applies to storage that has never been written. */
  var LOGO_FALLBACK = { enabled: true, wIn: 1, hIn: 1 };
  var LOGO_MIN_IN_FALLBACK = 0;
  var LOGO_MAX_IN_FALLBACK = 4; // a 4 in reserve already eats the whole 4 in cell width

  /* Read from BadgeSpec at call time, exactly like enumKeys()/enumDefault() do for the
     alignment and sheet-preset lists. The constants above are the fallback for a build
     where spec.js has not loaded — they are no longer a second source of truth that has
     to be kept in step by hand. */
  function logoDefault() {
    var S = window.BadgeSpec;
    var d = S && S.LOGO_DEFAULT;
    if (isPlainObject(d) && typeof d.wIn === 'number' && typeof d.hIn === 'number') {
      return { enabled: d.enabled === true, wIn: d.wIn, hIn: d.hIn };
    }
    return { enabled: LOGO_FALLBACK.enabled, wIn: LOGO_FALLBACK.wIn, hIn: LOGO_FALLBACK.hIn };
  }
  function logoMinIn() {
    var S = window.BadgeSpec;
    return (S && typeof S.LOGO_MIN_IN === 'number' && isFinite(S.LOGO_MIN_IN))
      ? S.LOGO_MIN_IN : LOGO_MIN_IN_FALLBACK;
  }
  function logoMaxIn() {
    var S = window.BadgeSpec;
    return (S && typeof S.LOGO_MAX_IN === 'number' && isFinite(S.LOGO_MAX_IN))
      ? S.LOGO_MAX_IN : LOGO_MAX_IN_FALLBACK;
  }

  /* Sheet layout preset. Both presets use the same 288x216 pt cells in a 2x3 grid; only
     the grid ORIGIN differs (0,0 vs 18,72 pt). Default is the sample-derived layout so
     existing sheets and the acceptance tests are unaffected until Julia switches.
     The valid keys live in js/spec.js (SHEET_PRESETS); these are only a fallback for when
     spec.js has not loaded, so the two lists cannot drift in normal operation. */
  var SHEET_KEYS_FALLBACK = ['sampleTopLeft', 'avery'];
  var SHEET_DEFAULT_FALLBACK = 'sampleTopLeft';

  /* Badge text alignment, sheet-wide. Julia's chosen default is LEFT — note that this is a
     changed default for how badges print, not just a new key. Valid values come from
     js/spec.js (ALIGNS / ALIGN_DEFAULT) when it is loaded; these are the fallback. */
  var ALIGN_KEYS_FALLBACK = ['left', 'center'];
  var ALIGN_DEFAULT_FALLBACK = 'left';

  /* A subscriber that mutates the store on notification would otherwise recurse without
     bound. Cascades are dispatched iteratively (never nested) and capped here. */
  var MAX_CASCADE = 100;

  /* ------------------------------------------------------------- in-memory state */

  var attendees = [];           // array of validated attendee objects
  /* Object.create(null): an attendee id of '__proto__' must create an OWN key, not walk
     into Object.prototype. With a plain {} literal, overrides['__proto__'] = x silently
     sets the prototype instead — getOverrides() then reports {} while getOverride()
     returns a truthy INHERITED value, so the override panel would show sizes that
     disagree with what the preview and the PDF actually draw. Ids like 'toString' and
     'valueOf' are the same class: an unset id would read back as an inherited function.
     Every read below is additionally hasOwn-guarded. */
  var overrides = Object.create(null); // id -> nudge object (only for ids that exist)
  var pageIndex = 0;
  var logo = { enabled: true, wIn: 1, hIn: 1 };
  var sheetPreset = SHEET_DEFAULT_FALLBACK;
  var align = ALIGN_DEFAULT_FALLBACK;
  var loaded = false;           // has load() run (set in a finally — see load())
  var subscribers = [];
  var idCounter = 0;
  var warnedWrite = false;      // one warning per run of failures, reset on success

  /* ------------------------------------------------------------------- storage IO */

  /* Resolved on every call, never cached: the shim/host object can disappear between
     calls (private mode, teardown in tests), and merely READING window.localStorage can
     throw in some browsers when storage is disabled. */
  function storage() {
    try {
      var ls = window.localStorage;
      if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') {
        return null;
      }
      return ls;
    } catch (err) {
      return null;
    }
  }

  function readRaw(key) {
    var ls = storage();
    if (!ls) return null;
    try {
      var v = ls.getItem(key);
      return typeof v === 'string' ? v : null;
    } catch (err) {
      return null;
    }
  }

  /* Returns fallback on: no storage, missing key, unparseable JSON, or JSON null.
     JSON.parse can also throw RangeError on pathologically nested input — the catch
     covers every Error type on purpose. */
  function readJson(key, fallback) {
    var raw = readRaw(key);
    if (raw === null || raw === '') return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      console.warn('[BadgeStore] ignoring corrupt value at "' + key + '" — using empty state.');
      return fallback;
    }
  }

  function writeJson(key, value) {
    var ls = storage();
    if (!ls) {
      warnWrite('localStorage is unavailable');
      return false;
    }
    try {
      ls.setItem(key, JSON.stringify(value));
      warnedWrite = false; // storage is healthy again; re-arm the warning
      return true;
    } catch (err) {
      // QuotaExceededError, SecurityError, a throwing shim, a value that will not
      // serialize — all the same to us: keep the in-memory value and carry on unsaved.
      warnWrite(err && err.name ? err.name : 'write failed');
      return false;
    }
  }

  function warnWrite(what) {
    if (warnedWrite) return; // don't spam per-keystroke; re-armed by the next good write
    warnedWrite = true;
    console.warn('[BadgeStore] could not save to localStorage (' + what +
      '). Continuing in memory only — data will be lost on reload.');
  }

  function removeKey(key) {
    var ls = storage();
    if (!ls) return;
    try {
      if (typeof ls.removeItem === 'function') ls.removeItem(key);
    } catch (err) {
      /* Swallowed here on purpose: clearAll() does not trust this function, it verifies
         with getItem afterwards. */
    }
  }

  /* Every key currently in storage that starts with our prefix, newest scan each time,
     plus our three canonical keys as a floor. Enumerated in reverse because removal
     re-indexes the store. Catches keys from older/renamed schema versions
     (e.g. a future lsuite.badges.v2.attendees) that would otherwise outlive "Clear all". */
  function collectPrefixedKeys() {
    var found = [];
    var ls = storage();
    if (ls) {
      try {
        var n = typeof ls.length === 'number' ? ls.length : 0;
        if (typeof ls.key === 'function') {
          for (var i = n - 1; i >= 0; i--) {
            var k = ls.key(i);
            if (typeof k === 'string' && k.indexOf(PREFIX) === 0 && found.indexOf(k) === -1) {
              found.push(k);
            }
          }
        }
      } catch (err) {
        /* fall through to the canonical list below */
      }
    }
    for (var j = 0; j < ALL_KEYS.length; j++) {
      if (found.indexOf(ALL_KEYS[j]) === -1) found.push(ALL_KEYS[j]);
    }
    return found;
  }

  /* ------------------------------------------------------------------- validation */

  function str(v) {
    // Deliberately narrow: never String(v) an object/array from storage.
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  /* Own-property test that works on null-prototype maps and on hostile keys alike. */
  function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* Assign onto an object we hand to callers (or serialize) WITHOUT tripping the
     '__proto__' setter: defineProperty creates a real own, enumerable, JSON-visible
     property even for that key. Keeps the result a normal object — callers can still
     call .hasOwnProperty on it — while staying pollution-proof. */
  function safeSet(obj, key, value) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function nextId() {
    // No network, no crypto dependency required. crypto.randomUUID is used only when it
    // is genuinely present; otherwise timestamp + counter, unique per session and
    // collision-checked against the ids already in memory.
    var id = null;
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        id = window.crypto.randomUUID();
      }
    } catch (err) {
      id = null;
    }
    if (!id) {
      idCounter += 1;
      id = 'a' + Date.now().toString(36) + '-' + idCounter.toString(36);
    }
    while (indexOfId(id) !== -1) {
      idCounter += 1;
      id = 'a' + Date.now().toString(36) + '-' + idCounter.toString(36);
    }
    return id;
  }

  /* Coerce one entry into a valid attendee, or null if it is not repairable.
     `seen` collects ids so a corrupt file (or a caller) with duplicate ids still yields
     unique ids; note that a duplicate id is REWRITTEN, so any override keyed to it is
     orphaned — pruneOverrides() cleans that up. */
  function repairAttendee(raw, seen) {
    if (!isPlainObject(raw)) return null; // strings, numbers, arrays, null => garbage
    var out = { id: '', first: '', last: '', title: '', company: '' };
    for (var i = 0; i < FIELDS.length; i++) out[FIELDS[i]] = str(raw[FIELDS[i]]);
    var id = str(raw.id);
    if (!id || (seen && seen[id])) id = nextId();
    out.id = id;
    if (seen) seen[id] = true;
    return out;
  }

  function normalizeAttendees(raw) {
    if (!Array.isArray(raw)) return [];   // e.g. {"attendees":"notanarray"}
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var a = repairAttendee(raw[i], seen);
      if (a) out.push(a); // unrepairable entries are dropped, not trusted
    }
    return out;
  }

  /* An override is a bag of finite numeric nudges. Anything else in it is dropped;
     an override that ends up empty is dropped entirely. */
  function normalizeOverride(raw) {
    if (!isPlainObject(raw)) return null;
    var out = {};
    var any = false;
    for (var i = 0; i < NUDGE_FIELDS.length; i++) {
      var k = NUDGE_FIELDS[i];
      var v = raw[k];
      if (typeof v === 'number' && isFinite(v)) {
        out[k] = v;
        any = true;
      }
    }
    return any ? out : null;
  }

  function normalizeOverrides(raw) {
    var out = Object.create(null); // safe to assign any key, including '__proto__'
    if (!isPlainObject(raw)) return out;
    var keys = Object.keys(raw); // JSON.parse gives '__proto__' as an OWN key, so it is here
    for (var i = 0; i < keys.length; i++) {
      if (!hasOwn(raw, keys[i])) continue;
      var o = normalizeOverride(raw[keys[i]]);
      if (o) out[keys[i]] = o;
    }
    return out;
  }

  /* NOTE: only numbers and strings are coerced. Anything else (array, object, boolean)
     falls straight to 0. Handing a deeply nested array to parseInt would ToString it,
     and Array.prototype.join recurses per nesting level -> RangeError from a *validator*,
     which used to poison every later call through ensureLoaded(). */
  function normalizePageIndex(raw) {
    var n;
    if (typeof raw === 'number') {
      n = raw;
    } else if (typeof raw === 'string') {
      n = parseInt(raw, 10);
    } else {
      return 0;
    }
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  /* Inches for the logo reserve. Same rule as normalizePageIndex: coerce ONLY number and
     string, so nothing read from storage is ever implicitly ToString'd (that is the bug
     class that bricked the store). Out-of-range numbers CLAMP to 0..4; junk that is not a
     number at all falls back to the caller's base value. Number() not parseInt(), because
     these are fractional inches ("1.5"). */
  function normalizeInches(raw, fallback) {
    var n;
    if (typeof raw === 'number') {
      n = raw;
    } else if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return fallback;   // Number('') is 0; an empty input is "unset", not zero
      n = Number(t);             // '1.5' -> 1.5, '1.5in' -> NaN -> fallback below
    } else {
      return fallback;           // object, array, boolean, null, undefined, function
    }
    if (typeof n !== 'number' || !isFinite(n)) return fallback; // NaN, +/-Infinity
    var lo = logoMinIn();
    var hi = logoMaxIn();
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /* Must end up a REAL boolean, never merely truthy. Recognised spellings only; anything
     else keeps the base value rather than guessing. */
  function normalizeEnabled(raw, fallback) {
    if (raw === true || raw === 1 || raw === 'true' || raw === '1') return true;
    if (raw === false || raw === 0 || raw === 'false' || raw === '0' || raw === '') return false;
    return fallback === true;
  }

  /* Doubles as loader and patcher: `base` is logoDefault() when reading storage, and the
     CURRENT config when applying a partial patch — so setLogo({enabled:true}) keeps the
     existing wIn/hIn. A garbage blob degrades to `base` without throwing. */
  function normalizeLogo(raw, base) {
    var def = logoDefault();
    var b = isPlainObject(base) ? base : def;
    var out = {
      enabled: normalizeEnabled(b.enabled, def.enabled),
      wIn: normalizeInches(b.wIn, def.wIn),
      hIn: normalizeInches(b.hIn, def.hIn)
    };
    if (!isPlainObject(raw)) return out; // '{not json', a number, an array, a deep array
    if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) {
      out.enabled = normalizeEnabled(raw.enabled, out.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'wIn')) {
      out.wIn = normalizeInches(raw.wIn, out.wIn);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'hIn')) {
      out.hIn = normalizeInches(raw.hIn, out.hIn);
    }
    return out;
  }

  /* ---- string-enum settings (sheet preset, text alignment) -------------------
     Both follow one rule, so they share one implementation: the valid set and the default
     are read from js/spec.js AT CALL TIME when it is loaded, so the store cannot drift
     from the spec, with a hardcoded fallback for when it is not (or has not landed yet).
     The spec may publish its set as either an object keyed by value or a plain array of
     strings; both are accepted, so a shape change in spec.js cannot silently reject
     everything and strand the user on the default. */
  function enumKeys(specProp, fallbackList) {
    try {
      var S = window.BadgeSpec;
      if (S) {
        var src = S[specProp];
        var keys = null;
        if (isPlainObject(src)) {
          keys = Object.keys(src);
        } else if (Array.isArray(src)) {
          keys = src.filter(function (k) { return typeof k === 'string' && k; });
        }
        if (keys && keys.length) return keys;
      }
    } catch (err) {
      /* fall through to the fallback list */
    }
    return fallbackList;
  }

  function enumDefault(specProp, specDefaultProp, fallbackList, fallbackDefault) {
    try {
      var S = window.BadgeSpec;
      if (S && typeof S[specDefaultProp] === 'string' &&
          enumKeys(specProp, fallbackList).indexOf(S[specDefaultProp]) !== -1) {
        return S[specDefaultProp];
      }
    } catch (err) {
      /* fall through */
    }
    return fallbackDefault;
  }

  /* Strings only, trimmed, exact match against the allowed set. Numbers, objects, arrays
     (including pathologically nested ones, which must never be ToString'd), booleans,
     null, undefined, NaN and arbitrary strings all fall back to the default. Only the
     string itself is ever stored. */
  function normalizeEnum(raw, specProp, specDefaultProp, fallbackList, fallbackDefault) {
    var def = enumDefault(specProp, specDefaultProp, fallbackList, fallbackDefault);
    if (typeof raw !== 'string') return def;
    var t = raw.trim();
    return enumKeys(specProp, fallbackList).indexOf(t) !== -1 ? t : def;
  }

  function sheetPresetDefault() {
    return enumDefault('SHEET_PRESETS', 'SHEET_PRESET_DEFAULT', SHEET_KEYS_FALLBACK, SHEET_DEFAULT_FALLBACK);
  }

  function normalizeSheetPreset(raw) {
    return normalizeEnum(raw, 'SHEET_PRESETS', 'SHEET_PRESET_DEFAULT', SHEET_KEYS_FALLBACK, SHEET_DEFAULT_FALLBACK);
  }

  function alignDefault() {
    return enumDefault('ALIGNS', 'ALIGN_DEFAULT', ALIGN_KEYS_FALLBACK, ALIGN_DEFAULT_FALLBACK);
  }

  function normalizeAlign(raw) {
    return normalizeEnum(raw, 'ALIGNS', 'ALIGN_DEFAULT', ALIGN_KEYS_FALLBACK, ALIGN_DEFAULT_FALLBACK);
  }

  /* Overrides for attendees that no longer exist are dead weight that would otherwise
     accumulate on disk forever (each fresh guest list loaded in leaves a new crop). */
  function pruneOverrides() {
    var keys = Object.keys(overrides);
    if (!keys.length) return false;
    var live = Object.create(null);
    for (var i = 0; i < attendees.length; i++) live[attendees[i].id] = true;
    var dropped = false;
    for (var j = 0; j < keys.length; j++) {
      if (!live[keys[j]]) {
        delete overrides[keys[j]];
        dropped = true;
      }
    }
    return dropped;
  }

  /* ------------------------------------------------------------------ copy helpers */
  /* Callers get copies so nobody can mutate our state behind our back — and every
     subscriber gets its OWN copy, so subscriber order is never load-bearing. */

  function copyAttendee(a) {
    return { id: a.id, first: a.first, last: a.last, title: a.title, company: a.company };
  }

  function copyAttendees(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(copyAttendee(list[i]));
    return out;
  }

  function copyOverride(o) {
    var out = {};
    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = o[keys[i]];
    return out;
  }

  /* Hands back a NORMAL object (Object.prototype intact, so callers may use
     .hasOwnProperty) that is still JSON-serializable and still carries a hostile id as a
     real own key, via safeSet. */
  function copyOverrides(map) {
    var out = {};
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      safeSet(out, keys[i], copyOverride(map[keys[i]]));
    }
    return out;
  }

  function copyLogo(l) {
    return { enabled: l.enabled === true, wIn: l.wIn, hIn: l.hIn };
  }

  function indexOfId(id) {
    for (var i = 0; i < attendees.length; i++) {
      if (attendees[i].id === id) return i;
    }
    return -1;
  }

  /* -------------------------------------------------------------- equality helpers */
  /* Used to skip pointless writes and notifications: a no-change "change" costs a
     localStorage write and a full re-render, and is the fuel for feedback loops. */

  function sameAttendeeList(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return false;
      for (var f = 0; f < FIELDS.length; f++) {
        if (a[i][FIELDS[f]] !== b[i][FIELDS[f]]) return false;
      }
    }
    return true;
  }

  function sameLogo(a, b) {
    return a.enabled === b.enabled && a.wIn === b.wIn && a.hIn === b.hIn;
  }

  function sameOverride(a, b) {
    if (!a || !b) return a === b;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (a[ka[i]] !== b[ka[i]]) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ notification */

  function emit(evt, payload) {
    var bus = window.BadgeBus;
    if (!bus || typeof bus.emit !== 'function') return; // bus is optional
    try {
      bus.emit(evt, payload);
    } catch (err) {
      console.error('[BadgeStore] BadgeBus.emit("' + evt + '") threw:', err);
    }
  }

  /* Dispatch is iterative, never nested: if a subscriber mutates the store, the new
     notification is queued and drained by the loop already running, so a write-back
     loop costs queue slots instead of stack frames. Capped, and the cap is loud —
     a swallowed stack overflow is exactly the kind of silence that hides bugs. */
  var dispatching = false;
  var queue = [];
  var cascadeWarned = false;

  function notify(factory) {
    queue.push(factory);
    if (dispatching) return;
    dispatching = true;
    var rounds = 0;
    try {
      while (queue.length) {
        rounds += 1;
        if (rounds > MAX_CASCADE) {
          if (!cascadeWarned) {
            cascadeWarned = true;
            console.warn('[BadgeStore] notification cascade exceeded ' + MAX_CASCADE +
              ' rounds — a subscriber is very likely writing back to the store on every ' +
              'change. Dropping the remaining ' + queue.length + ' notification(s).');
          }
          queue.length = 0;
          break;
        }
        var make = queue.shift();
        var snapshot = subscribers.slice(); // a handler may (un)subscribe mid-dispatch
        for (var i = 0; i < snapshot.length; i++) {
          try {
            snapshot[i](make()); // fresh payload per subscriber
          } catch (err) {
            console.error('[BadgeStore] subscriber threw:', err);
          }
        }
      }
    } finally {
      dispatching = false;
      queue.length = 0;
    }
  }

  function attendeePayload() {
    return { type: 'data:changed', attendees: copyAttendees(attendees) };
  }

  function overridePayload(id) {
    return function () {
      return { type: 'override:changed', id: id || null, overrides: copyOverrides(overrides) };
    };
  }

  function pagePayload() {
    return { type: 'page:changed', pageIndex: pageIndex };
  }

  function logoPayload() {
    return { type: 'logo:changed', logo: copyLogo(logo) };
  }

  function changedAttendees() {
    writeJson(KEY_ATTENDEES, attendees);
    notify(attendeePayload);
    emit('data:changed', { attendees: copyAttendees(attendees) });
  }

  function changedOverrides(id) {
    writeJson(KEY_OVERRIDES, copyOverrides(overrides));
    notify(overridePayload(id));
    emit('override:changed', { id: id || null, overrides: copyOverrides(overrides) });
  }

  function changedPage() {
    writeJson(KEY_PAGE, pageIndex);
    notify(pagePayload);
    emit('page:changed', { pageIndex: pageIndex });
  }

  function alignPayload() {
    return { type: 'align:changed', align: align };
  }

  function changedAlign() {
    writeJson(KEY_ALIGN, align);
    notify(alignPayload);
    emit('align:changed', { align: align });
  }

  function sheetPayload() {
    return { type: 'sheet:changed', sheetPreset: sheetPreset };
  }

  function changedSheet() {
    writeJson(KEY_SHEET, sheetPreset);
    notify(sheetPayload);
    emit('sheet:changed', { sheetPreset: sheetPreset });
  }

  function changedLogo() {
    writeJson(KEY_LOGO, logo);
    notify(logoPayload);
    emit('logo:changed', { logo: copyLogo(logo) });
  }

  /* ------------------------------------------------------------------------- load */

  function load() {
    // Each slice is read independently so one corrupt key cannot wipe the other two,
    // and `loaded` is set in the finally: if anything in here still manages to throw,
    // the next call must NOT re-run this and re-throw. A single bad byte in storage
    // used to brick every getter and setter for the rest of the session.
    try {
      attendees = normalizeAttendees(readJson(KEY_ATTENDEES, []));
    } catch (err) {
      console.warn('[BadgeStore] attendees unreadable — starting empty.', err);
      attendees = [];
    }
    try {
      overrides = normalizeOverrides(readJson(KEY_OVERRIDES, {}));
    } catch (err) {
      console.warn('[BadgeStore] overrides unreadable — starting empty.', err);
      overrides = {};
    }
    try {
      pageIndex = normalizePageIndex(readJson(KEY_PAGE, 0));
    } catch (err) {
      console.warn('[BadgeStore] pageIndex unreadable — starting at 0.', err);
      pageIndex = 0;
    }
    try {
      align = normalizeAlign(readJson(KEY_ALIGN, null));
    } catch (err) {
      console.warn('[BadgeStore] alignment unreadable — using the default.', err);
      align = alignDefault();
    }
    try {
      sheetPreset = normalizeSheetPreset(readJson(KEY_SHEET, null));
    } catch (err) {
      console.warn('[BadgeStore] sheet preset unreadable — using the default.', err);
      sheetPreset = sheetPresetDefault();
    }
    try {
      // A missing key is normal (the reserve is off until switched on), so the fallback
      // here is the default config rather than an error.
      logo = normalizeLogo(readJson(KEY_LOGO, null), logoDefault());
    } catch (err) {
      console.warn('[BadgeStore] logo config unreadable — using the default.', err);
      logo = normalizeLogo(null, logoDefault());
    }
    try {
      // Overrides whose attendee is gone never come back; drop them at the door and
      // write the cleaned map so the file does not grow forever.
      if (pruneOverrides()) writeJson(KEY_OVERRIDES, copyOverrides(overrides));
    } finally {
      loaded = true;
    }
  }

  /* Any accessor may be called before app.js runs init(); load on first touch. */
  function ensureLoaded() {
    if (!loaded) load();
  }

  /* ------------------------------------------------------------------ UI control */
  /*
   * The "Clear all data" button — the visible half of the privacy promise. Lives here
   * rather than in a UI module because it is the one control whose correctness depends
   * on clearAll()'s return value, and a button that reports success on a failed wipe is
   * worse than no button at all.
   *
   * Two-step by design (arm, then confirm) because this destroys the whole attendee list
   * with no undo. Deliberately NOT window.confirm(): a native dialog blocks the page,
   * cannot be styled or made to explain itself, and is invisible to the headless run
   * that verifies this. The armed state says exactly what is about to happen.
   *
   * Appends to #data-controls and never clears it — js/pdf.js mounts its Export PDF
   * button into the same container, and neither module may assume it got there first.
   * Built with createElement/textContent only — no HTML strings are ever parsed here
   * (the source scan in the test suite bans that API by name, comments included).
   */
  var MARKER = 'data-badge-clear-all';

  function mountControls() {
    var doc = window.document;
    if (!doc || typeof doc.getElementById !== 'function') return null; // no DOM (tests, workers)

    var host = doc.getElementById('data-controls');
    if (!host) {
      console.warn('[BadgeStore] mountControls: #data-controls not found; ' +
        '"Clear all data" button not added.');
      return null;
    }

    // Idempotent: a second mount must not add a second button or a second handler.
    if (typeof host.querySelector === 'function') {
      var existing = host.querySelector('[' + MARKER + ']');
      if (existing) return existing;
    }

    var wrap = doc.createElement('div');
    wrap.className = 'clear-all';
    // Visually secondary to Export PDF: quiet until armed. Inline because styles.css is
    // owned by another item and has no class for a tertiary/destructive button.
    wrap.style.marginTop = '10px';

    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-quiet clear-all-btn';
    btn.setAttribute(MARKER, '1');
    btn.style.background = 'transparent';
    btn.style.border = '1px solid var(--line-soft, #e6e6ea)';
    btn.style.color = 'var(--ink-3, #83838d)';
    btn.style.fontSize = '12px';
    btn.style.padding = '5px 9px';

    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'clear-all-cancel';
    cancel.setAttribute('data-badge-clear-cancel', '1');
    cancel.textContent = 'Cancel';
    cancel.style.marginLeft = '6px';
    cancel.style.fontSize = '12px';
    cancel.style.padding = '5px 9px';
    cancel.hidden = true;

    var note = doc.createElement('p');
    note.className = 'clear-all-note';
    note.setAttribute('data-badge-clear-status', '1');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    note.style.margin = '6px 0 0';
    note.style.fontSize = '12px';
    note.style.color = 'var(--ink-2, #55555e)';
    note.hidden = true;

    var armed = false;

    function say(msg) {
      note.textContent = msg || '';
      note.hidden = !msg;
    }

    function disarm() {
      armed = false;
      btn.textContent = 'Clear all data';
      btn.setAttribute('aria-label', 'Clear all saved badge data from this browser');
      btn.style.color = 'var(--ink-3, #83838d)';
      btn.style.borderColor = 'var(--line-soft, #e6e6ea)';
      btn.style.fontWeight = 'normal';
      cancel.hidden = true;
    }

    function arm() {
      armed = true;
      btn.textContent = 'Erase everything — click again to confirm';
      btn.setAttribute('aria-label',
        'Confirm erasing all saved badge data from this browser. This cannot be undone.');
      btn.style.color = '#a3231f';
      btn.style.borderColor = '#e0b4b2';
      btn.style.fontWeight = '500';
      cancel.hidden = false;
      say('This erases every attendee and every size nudge saved in this browser. ' +
        'There is no undo.');
    }

    btn.addEventListener('click', function () {
      if (!armed) {
        arm();
        return;
      }
      disarm();
      // The return value is the whole point: it distinguishes "gone" from
      // "still on this device". Never report success without it.
      var wiped = false;
      try {
        wiped = BadgeStore.clearAll() === true;
      } catch (err) {
        console.error('[BadgeStore] clearAll() threw from the button handler:', err);
        wiped = false;
      }
      if (wiped) {
        say('All data cleared. Nothing is saved in this browser.');
      } else {
        say('Clearing failed — some data may still be stored in this browser. ' +
          'To remove it, clear this site’s data in your browser settings.');
      }
    });

    cancel.addEventListener('click', function () {
      disarm();
      say('');
    });

    disarm(); // sets the resting label + aria-label
    wrap.appendChild(btn);
    wrap.appendChild(cancel);
    wrap.appendChild(note);
    host.appendChild(wrap); // APPEND — Export PDF may already be in here, or arrive later
    keepLast(host, wrap);
    return btn;
  }

  /* app.js mounts the store BEFORE js/pdf.js, so on a cold boot this destructive control
     would land above the primary Export PDF action. Re-append our own block (appendChild
     moves an existing node) once the boot sequence has settled, so the quiet destructive
     action always sits last. Only ever moves the node this module created; pdf.js's DOM
     is never touched, and if Export PDF is already last-mounted this is a no-op. */
  function keepLast(host, wrap) {
    function moveToEnd() {
      try {
        var kids = host.children;
        var last = kids && kids.length ? kids[kids.length - 1] : null;
        if (last !== wrap) host.appendChild(wrap);
      } catch (err) {
        /* ordering is cosmetic — never let it break the page */
      }
    }
    try {
      if (typeof window.setTimeout === 'function') window.setTimeout(moveToEnd, 0);
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(moveToEnd);
    } catch (err) {
      /* no scheduler: leave the order as-is */
    }
  }

  /* ---------------------------------------------------------------------- public */

  var BadgeStore = {
    /* Idempotent, and re-reads storage — so it doubles as a reload. Notifies afterwards
       so a re-init cannot leave already-rendered UI showing stale data. (At boot there
       are no subscribers yet, so this is free.) */
    init: function init() {
      load();
      if (subscribers.length) {
        notify(attendeePayload);
        notify(overridePayload(null));
        notify(pagePayload);
        notify(logoPayload);
        notify(sheetPayload);
        notify(alignPayload);
      }
      // app.js's bootstrap calls init() (not mount()) for the store role, and it runs on
      // DOMContentLoaded, so the container exists by now. Wrapped: a DOM problem must
      // never stop the store itself from coming up.
      try {
        mountControls();
      } catch (err) {
        console.error('[BadgeStore] mountControls() threw:', err);
      }
      return BadgeStore;
    },

    /* The bootstrap in app.js calls mount() on UI modules; the store is mounted via
       init(), but expose mount() too so either wiring works. Both are idempotent. */
    mount: function mount() {
      return mountControls();
    },

    /* Exposed so the button can be mounted independently of init() (and asserted on). */
    mountControls: mountControls,

    // ---- attendees -----------------------------------------------------------
    getAttendees: function getAttendees() {
      ensureLoaded();
      return copyAttendees(attendees);
    },

    setAttendees: function setAttendees(arr) {
      ensureLoaded();
      var next = normalizeAttendees(arr);
      if (sameAttendeeList(next, attendees)) return copyAttendees(attendees); // no-op
      attendees = next;
      var pruned = pruneOverrides(); // a replacement list orphans the old overrides
      changedAttendees();
      if (pruned) changedOverrides(null);
      return copyAttendees(attendees);
    },

    /* Returns the stored attendee (with its final id), or null if unusable. */
    addAttendee: function addAttendee(obj) {
      ensureLoaded();
      var seen = Object.create(null);
      for (var i = 0; i < attendees.length; i++) seen[attendees[i].id] = true;
      var a = repairAttendee(obj, seen);
      if (!a) return null;
      attendees.push(a);
      changedAttendees();
      return copyAttendee(a);
    },

    /* Returns true only when a field actually changed. */
    updateAttendee: function updateAttendee(id, patch) {
      ensureLoaded();
      var i = indexOfId(str(id));
      if (i === -1 || !isPlainObject(patch)) return false;
      var target = attendees[i];
      var touched = false;
      for (var f = 0; f < FIELDS.length; f++) {
        var k = FIELDS[f];
        if (Object.prototype.hasOwnProperty.call(patch, k)) {
          var v = str(patch[k]);
          if (target[k] !== v) {
            target[k] = v;
            touched = true;
          }
        }
      }
      if (!touched) return false; // identical patch: no write, no re-render
      changedAttendees();
      return true;
    },

    removeAttendee: function removeAttendee(id) {
      ensureLoaded();
      var key = str(id);
      var i = indexOfId(key);
      if (i === -1) return false;
      attendees.splice(i, 1);
      var hadOverride = hasOwn(overrides, key);
      if (hadOverride) delete overrides[key];
      changedAttendees();
      // Two events for one logical action, on purpose: override listeners must not have
      // to infer an override removal from a data:changed.
      if (hadOverride) changedOverrides(key);
      return true;
    },

    /* delta is a signed offset (-1 = up, +1 = down). No-op (returns false) when the
       move would fall off either end, or when delta rounds to 0. */
    moveAttendee: function moveAttendee(id, delta) {
      ensureLoaded();
      var i = indexOfId(str(id));
      if (i === -1) return false;
      var d = typeof delta === 'number' && isFinite(delta) ? Math.round(delta) : 0;
      if (d === 0) return false;
      var j = i + d;
      if (j < 0 || j >= attendees.length) return false;
      var moved = attendees.splice(i, 1)[0];
      attendees.splice(j, 0, moved);
      changedAttendees();
      return true;
    },

    // ---- overrides -----------------------------------------------------------
    getOverrides: function getOverrides() {
      ensureLoaded();
      return copyOverrides(overrides);
    },

    getOverride: function getOverride(id) {
      ensureLoaded();
      var key = str(id);
      if (!hasOwn(overrides, key)) return null; // never report an inherited value
      var o = overrides[key];
      return o ? copyOverride(o) : null;
    },

    /* Passing null/{}/garbage clears the override for that id. */
    setOverride: function setOverride(id, obj) {
      ensureLoaded();
      var key = str(id);
      if (!key) return false;
      var o = normalizeOverride(obj);
      if (!o) return BadgeStore.clearOverride(key);
      var current = hasOwn(overrides, key) ? overrides[key] : null;
      if (sameOverride(current, o)) return true; // identical: no write, no re-render
      overrides[key] = o;
      changedOverrides(key);
      return true;
    },

    clearOverride: function clearOverride(id) {
      ensureLoaded();
      var key = str(id);
      if (!hasOwn(overrides, key)) return false;
      delete overrides[key];
      changedOverrides(key);
      return true;
    },

    // ---- page index ----------------------------------------------------------
    getPageIndex: function getPageIndex() {
      ensureLoaded();
      return pageIndex;
    },

    setPageIndex: function setPageIndex(n) {
      ensureLoaded();
      var next = normalizePageIndex(n);
      if (next === pageIndex) return pageIndex; // no-op: breaks write-back loops
      pageIndex = next;
      changedPage();
      return pageIndex;
    },

    // ---- text alignment ------------------------------------------------------
    /* 'left' (the default) or 'center'. Sheet-wide, not per badge. */
    getAlign: function getAlign() {
      ensureLoaded();
      return align;
    },

    /* Unrecognised input falls back to the default rather than throwing. Returns the
       value in force. */
    setAlign: function setAlign(value) {
      ensureLoaded();
      var next = normalizeAlign(value);
      if (next === align) return align; // re-selecting the current alignment costs nothing
      align = next;
      changedAlign();
      return align;
    },

    // ---- sheet layout preset -------------------------------------------------
    /* 'sampleTopLeft' (grid origin 0,0) or 'avery' (origin 18,72 pt). Same 288x216 cells
       either way — only the origin differs. */
    getSheetPreset: function getSheetPreset() {
      ensureLoaded();
      return sheetPreset;
    },

    /* Unrecognised input falls back to the default rather than throwing: a stale value in
       storage should print a correct sheet, not break the app. Returns the value in force. */
    setSheetPreset: function setSheetPreset(key) {
      ensureLoaded();
      var next = normalizeSheetPreset(key);
      if (next === sheetPreset) return sheetPreset; // re-selecting costs nothing
      sheetPreset = next;
      changedSheet();
      return sheetPreset;
    },

    // ---- logo reserve --------------------------------------------------------
    /* { enabled, wIn, hIn } in INCHES. Callers multiply by 72 for points. */
    getLogo: function getLogo() {
      ensureLoaded();
      return copyLogo(logo);
    },

    /* Accepts a PARTIAL patch: setLogo({enabled:true}) leaves wIn/hIn alone. Returns the
       resulting config. Short-circuits when nothing actually changed, so a number input
       firing per keystroke does not thrash storage or repaint the preview. */
    setLogo: function setLogo(cfg) {
      ensureLoaded();
      if (!isPlainObject(cfg)) return copyLogo(logo); // nothing to patch
      var next = normalizeLogo(cfg, logo);
      if (sameLogo(next, logo)) return copyLogo(logo);
      logo = next;
      changedLogo();
      return copyLogo(logo);
    },

    // ---- nuke ----------------------------------------------------------------
    /*
     * Wipe everything, then PROVE it. Removes every key under the prefix (scanned, not
     * hardcoded), re-reads each one, and returns:
     *   true  — nothing under the prefix remains readable
     *   false — at least one key survived; the names are logged
     * Memory is cleared and subscribers notified either way, so the UI still resets, but
     * a caller that shows "All data cleared" must check the return value first.
     */
    clearAll: function clearAll() {
      var targets = collectPrefixedKeys();
      var survivors = [];
      for (var i = 0; i < targets.length; i++) {
        removeKey(targets[i]);
        // Verification, not optimism: removeItem may be absent, may throw, or may be a
        // no-op in a locked-down storage implementation.
        if (readRaw(targets[i]) !== null) survivors.push(targets[i]);
      }

      attendees = [];
      overrides = Object.create(null);
      pageIndex = 0;
      logo = normalizeLogo(null, logoDefault()); // back to {enabled:true, wIn:1, hIn:1}
      sheetPreset = sheetPresetDefault();
      align = alignDefault(); // back to 'left'
      loaded = true; // state is authoritative now; don't re-read on next access
      warnedWrite = false;

      notify(attendeePayload);
      notify(overridePayload(null));
      notify(pagePayload);
      notify(logoPayload);
      notify(sheetPayload);
      notify(alignPayload);
      emit('data:changed', { attendees: [] });
      emit('override:changed', { id: null, overrides: {} });
      emit('page:changed', { pageIndex: 0 });
      emit('logo:changed', { logo: copyLogo(logo) });
      emit('sheet:changed', { sheetPreset: sheetPreset });
      emit('align:changed', { align: align });

      if (survivors.length) {
        console.warn('[BadgeStore] clearAll() FAILED to delete ' + survivors.length +
          ' key(s) — data is still on this device: ' + survivors.join(', ') +
          '. Do not tell the user their data was cleared.');
        return false;
      }
      return true;
    },

    // ---- subscription --------------------------------------------------------
    subscribe: function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      subscribers.push(fn);
      var live = true;
      return function unsubscribe() {
        if (!live) return;
        live = false;
        var i = subscribers.indexOf(fn);
        if (i !== -1) subscribers.splice(i, 1);
      };
    },

    // exposed for tests and for the "Clear all data" button's confirmation copy
    KEYS: {
      attendees: KEY_ATTENDEES,
      overrides: KEY_OVERRIDES,
      pageIndex: KEY_PAGE,
      logo: KEY_LOGO,
      sheetPreset: KEY_SHEET,
      align: KEY_ALIGN
    },
    PREFIX: PREFIX,

    /* Read-only limits, exposed so the UI that builds the width/height inputs clamps to
       the same range the store enforces instead of hard-coding its own. */
    LOGO_LIMITS: { minIn: logoMinIn(), maxIn: logoMaxIn(), defaults: copyLogo(logoDefault()) }
  };

  window.BadgeStore = BadgeStore;

})(typeof window !== 'undefined' ? window : globalThis);
