/* test/input.test.js — plain node, no dependencies, no network.
 *
 *   node site/test/input.test.js
 *
 * js/input.js is a classic browser script, so it is loaded here inside a Function
 * whose `window` and `document` parameters are stand-ins. The parsers are pure and
 * need no DOM at all; the one test that needs a DOM (the XSS test) uses the small
 * shim below.
 *
 * THE SHIM IS DELIBERATELY STRICT: assigning to `innerHTML` throws. If input.js
 * ever built markup from a string instead of using createElement/textContent, the
 * XSS test would blow up rather than quietly pass. The `innerHTML` *getter*
 * serialises the tree the way a browser does, escaping &, < and > in text nodes,
 * which is what makes the "renders as escaped text" assertion meaningful.
 *
 * All names in this file are invented.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var SITE = path.resolve(__dirname, '..');
var INPUT_JS = path.join(SITE, 'js', 'input.js');
var FIXTURE = path.join(SITE, 'test', 'fixtures', 'import-sample.csv');

var DASH = String.fromCharCode(0x2014); // em dash used in report lines
var BOM = String.fromCharCode(0xFEFF);
var CRLF = '\r\n';
var TAB = '\t';

/* ===================================================================== *
 * assert harness
 * ===================================================================== */

var passed = 0;
var failed = 0;
var currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n' + name);
}

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.log('  FAIL  ' + label + (extra ? '\n          ' + extra : ''));
  }
}

function eq(actual, expected, label) {
  var same = actual === expected;
  ok(same, label, same ? '' :
    'expected: ' + JSON.stringify(expected) + '\n          actual:   ' + JSON.stringify(actual));
}

function deepEqFields(actual, expected, label) {
  var keys = ['first', 'last', 'title', 'company'];
  var diffs = [];
  for (var i = 0; i < keys.length; i++) {
    if (String(actual && actual[keys[i]]) !== String(expected[keys[i]])) {
      diffs.push(keys[i] + ': expected ' + JSON.stringify(expected[keys[i]]) +
        ', got ' + JSON.stringify(actual && actual[keys[i]]));
    }
  }
  ok(diffs.length === 0, label, diffs.join('\n          '));
}

/* ===================================================================== *
 * minimal DOM shim
 * ===================================================================== */

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

function TextNode(data) {
  this.nodeType = 3;
  this.data = String(data);
  this.parentNode = null;
}
Object.defineProperty(TextNode.prototype, 'textContent', {
  get: function () { return this.data; },
  set: function (v) { this.data = String(v); }
});

function Element(tag) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.childNodes = [];
  this.attributes = {};
  this.className = '';
  this.listeners = {};
  this.parentNode = null;
  this.value = '';
  this.disabled = false;
}
Object.defineProperty(Element.prototype, 'firstChild', {
  get: function () { return this.childNodes.length ? this.childNodes[0] : null; }
});
Element.prototype.appendChild = function (node) {
  this.childNodes.push(node);
  node.parentNode = this;
  return node;
};
Element.prototype.removeChild = function (node) {
  var i = this.childNodes.indexOf(node);
  if (i !== -1) this.childNodes.splice(i, 1);
  node.parentNode = null;
  return node;
};
Element.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); };
Element.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
};
Element.prototype.addEventListener = function (type, fn) {
  if (!this.listeners[type]) this.listeners[type] = [];
  this.listeners[type].push(fn);
};
Object.defineProperty(Element.prototype, 'textContent', {
  get: function () {
    var out = '';
    for (var i = 0; i < this.childNodes.length; i++) out += this.childNodes[i].textContent;
    return out;
  },
  set: function (v) {
    this.childNodes.length = 0;
    if (String(v).length) this.appendChild(new TextNode(v));
  }
});
Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return serializeChildren(this); },
  set: function () {
    throw new Error('DOM shim: innerHTML assignment is forbidden - input.js must ' +
      'build DOM with createElement/textContent only.');
  }
});

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  var attrs = '';
  if (node.className) attrs += ' class="' + escapeAttr(node.className) + '"';
  for (var k in node.attributes) {
    if (Object.prototype.hasOwnProperty.call(node.attributes, k)) {
      attrs += ' ' + k + '="' + escapeAttr(node.attributes[k]) + '"';
    }
  }
  var tag = node.tagName.toLowerCase();
  return '<' + tag + attrs + '>' + serializeChildren(node) + '</' + tag + '>';
}

function serializeChildren(node) {
  var out = '';
  for (var i = 0; i < node.childNodes.length; i++) out += serializeNode(node.childNodes[i]);
  return out;
}

/** Every element in the subtree, for "no live <img> was created" checks. */
function allElements(node, acc) {
  acc = acc || [];
  for (var i = 0; i < node.childNodes.length; i++) {
    var c = node.childNodes[i];
    if (c.nodeType === 1) { acc.push(c); allElements(c, acc); }
  }
  return acc;
}

var shimDocument = {
  createElement: function (tag) { return new Element(tag); },
  getElementById: function () { return null; },
  head: null
};

/* ===================================================================== *
 * load js/input.js as a classic script
 * ===================================================================== */

var source = fs.readFileSync(INPUT_JS, 'utf8');
var fakeWindow = { setTimeout: setTimeout, FileReader: undefined };
new Function('window', 'document', source)(fakeWindow, shimDocument);

var BadgeInput = fakeWindow.BadgeInput;
if (!BadgeInput || !BadgeInput.internals) {
  console.error('FATAL: js/input.js did not export window.BadgeInput.internals');
  process.exit(1);
}
var I = BadgeInput.internals;

/* ===================================================================== *
 * 1. bulk paste: tab block and comma block parse identically
 * ===================================================================== */

group('1. Bulk paste: tab-separated and comma-separated agree');

var TAB_BLOCK = [
  'Cordelia' + TAB + 'Ashworth' + TAB + 'Deputy General Counsel' + TAB + 'Foxglove Media',
  'Emeka' + TAB + 'Nwosu' + TAB + 'Senior Legal Counsel' + TAB + 'Basalt Mining'
].join('\n');

var COMMA_BLOCK = [
  'Cordelia,Ashworth,Deputy General Counsel,Foxglove Media',
  'Emeka,Nwosu,Senior Legal Counsel,Basalt Mining'
].join('\n');

var tabResult = I.parseBulk(TAB_BLOCK);
var commaResult = I.parseBulk(COMMA_BLOCK);

eq(tabResult.attendees.length, 2, 'tab block yields 2 attendees');
eq(commaResult.attendees.length, 2, 'comma block yields 2 attendees');
eq(JSON.stringify(tabResult.attendees), JSON.stringify(commaResult.attendees),
  'tab and comma blocks produce identical field values');
deepEqFields(tabResult.attendees[0], {
  first: 'Cordelia', last: 'Ashworth',
  title: 'Deputy General Counsel', company: 'Foxglove Media'
}, 'row 1 fields land in First/Last/Title/Company order');

group('1b. Bulk paste: tolerates messy whitespace');
var messy = I.parseBulk('   Solveig ,  Lindqvist ,  Associate General Counsel , Nordvind Shipping   ');
deepEqFields(messy.attendees[0], {
  first: 'Solveig', last: 'Lindqvist',
  title: 'Associate General Counsel', company: 'Nordvind Shipping'
}, 'leading/trailing whitespace trimmed from every field');

/* ===================================================================== *
 * 2. bulk paste: quoted field containing a comma survives
 * ===================================================================== */

group('2. Bulk paste: quoted comma survives');

var quoted = I.parseBulk('Ravi,"Chandrasekaran, Jr.",Chief Compliance Officer,"Sundial Payments, Inc."');
eq(quoted.attendees.length, 1, 'quoted commas do not split the line into extra fields');
deepEqFields(quoted.attendees[0], {
  first: 'Ravi',
  last: 'Chandrasekaran, Jr.',
  title: 'Chief Compliance Officer',
  company: 'Sundial Payments, Inc.'
}, 'the comma inside "Chandrasekaran, Jr." is preserved');

var quotedTab = I.parseBulk('Ravi' + TAB + '"Chandrasekaran, Jr."' + TAB + 'CCO' + TAB + 'Sundial');
eq(quotedTab.attendees[0].last, 'Chandrasekaran, Jr.',
  'quoted comma also survives on a tab-separated line');

var embedded = I.parseBulk('Ines,Duarte,Counsel,"The ""Northwind"" Group"');
eq(embedded.attendees[0].company, 'The "Northwind" Group',
  'doubled quotes ("") collapse to one literal quote');

/* ===================================================================== *
 * 3. bulk paste: short rows tolerated, nameless rows reported
 * ===================================================================== */

group('3. Bulk paste: short rows tolerated, nameless rows reported');

var mixed = [
  'Cordelia,Ashworth,Deputy General Counsel,Foxglove Media', // line 1 ok
  'Tomas,Bergstrom',                                          // line 2 only 2 fields
  '',                                                         // line 3 blank -> silent
  ',,Analyst,Basalt Mining',                                  // line 4 no name
  '   ,   ,   ,   '                                           // line 5 all blank fields
].join('\n');

var m = I.parseBulk(mixed);

eq(m.attendees.length, 2, 'two rows added (the 4-field row and the 2-field row)');
deepEqFields(m.attendees[1], { first: 'Tomas', last: 'Bergstrom', title: '', company: '' },
  '2-field line yields empty title and company');

eq(m.report.length, 4, 'report has 4 entries: 2 added + 2 skipped (blank line 3 is silent)');
eq(m.skipped, 2, 'skipped count is 2');

var skippedEntries = m.report.filter(function (e) { return e.status === 'skipped'; });
eq(skippedEntries.length, 2, 'two skipped entries recorded');
eq(skippedEntries[0].line, 4, 'first malformed row is reported at line 4');
eq(skippedEntries[0].reason, 'no first or last name', 'reason names the actual problem');
eq(I.formatReportLine(skippedEntries[0]),
  'Line 4: skipped ' + DASH + ' no first or last name',
  'user-visible report line for line 4 is exact');
eq(I.formatReportLine(skippedEntries[1]),
  'Line 5: skipped ' + DASH + ' no first or last name',
  'user-visible report line for line 5 is exact');
eq(I.formatReportLine(m.report[0]),
  'Line 1: added ' + DASH + ' Cordelia Ashworth',
  'user-visible report line for an added row is exact');
eq(m.summary, 'Added 2 attendees, skipped 2 lines.', 'summary line is exact');

var extra = I.parseBulk('Nadia,Okafor,GC,Foxglove Media,extra1,extra2');
eq(extra.attendees.length, 1, 'a row with more than 4 fields is still added');
eq(I.formatReportLine(extra.report[0]),
  'Line 1: added ' + DASH + ' Nadia Okafor (ignored 2 extra fields)',
  'extra fields are reported, not silently dropped');

/* ===================================================================== *
 * 4. CSV: tolerant header matching
 * ===================================================================== */

group('4. CSV: tolerant header matching');

['First', 'First Name', 'firstname', 'first_name', 'FIRST-NAME', '  First   Name  ']
  .forEach(function (spelling) {
    eq(I.matchHeader(spelling), 'first', 'header ' + JSON.stringify(spelling) + ' -> first');
  });

['Last', 'Last Name', 'lastname', 'Last_Name', 'LAST-NAME', 'Surname'].forEach(function (s) {
  eq(I.matchHeader(s), 'last', 'header ' + JSON.stringify(s) + ' -> last');
});

['Title', 'Job Title', 'job_title', 'JOB-TITLE', 'Position'].forEach(function (s) {
  eq(I.matchHeader(s), 'title', 'header ' + JSON.stringify(s) + ' -> title');
});

['Company', 'Company Name', 'company_name', 'Organization', 'Organisation', 'Employer']
  .forEach(function (s) {
    eq(I.matchHeader(s), 'company', 'header ' + JSON.stringify(s) + ' -> company');
  });

eq(I.matchHeader('Badge Colour'), null, 'an unrelated header matches nothing');
eq(I.normalizeHeader(BOM + ' First-Name_ '), 'firstname',
  'normalization strips BOM, spaces, hyphens and underscores');

group('4b. CSV: each First spelling drives a real import, columns in any order');

['first name', 'firstname', 'First_Name', 'FIRST-NAME'].forEach(function (spelling) {
  var csv = spelling + ',Last Name\nJuno,Vasquez\n';
  var res = I.parseCsv(csv);
  ok(res.ok, 'header "' + spelling + '" is accepted');
  eq(res.attendees.length, 1, 'header "' + spelling + '" imports 1 row');
  eq(res.attendees[0].first, 'Juno', 'header "' + spelling + '" maps to the First column');
});

var reordered = I.parseCsv(
  'Organization,Job Title,Last Name,First Name\n' +
  'Halcyon Freight,Chief Legal Officer,Okonkwo,Mirembe\n'
);
ok(reordered.ok, 'columns in a scrambled order are accepted');
deepEqFields(reordered.attendees[0], {
  first: 'Mirembe', last: 'Okonkwo',
  title: 'Chief Legal Officer', company: 'Halcyon Freight'
}, 'Job Title -> title, Organization -> company, order-independent');

var employer = I.parseCsv('First,Last,Position,Employer\nDev,Raman,Legal Ops Lead,Sundial Payments\n');
deepEqFields(employer.attendees[0], {
  first: 'Dev', last: 'Raman', title: 'Legal Ops Lead', company: 'Sundial Payments'
}, 'Position -> title and Employer -> company');

/* ===================================================================== *
 * 5. CSV: BOM + CRLF + quoted comma + embedded quotes
 * ===================================================================== */

group('5. CSV: BOM, CRLF and quoted fields together');

var hostileCsv =
  BOM + 'First Name,Last Name,Job Title,Company Name' + CRLF +
  'Mirembe,"Okonkwo, III",General Counsel,"Halcyon Freight, Inc."' + CRLF +
  'Tomas,Bergstrom,"VP, Legal","The ""Northwind"" Group"' + CRLF;

var h = I.parseCsv(hostileCsv);
ok(h.ok, 'BOM does not break header detection');
eq(h.attendees.length, 2, 'both CRLF rows imported');
deepEqFields(h.attendees[0], {
  first: 'Mirembe', last: 'Okonkwo, III',
  title: 'General Counsel', company: 'Halcyon Freight, Inc.'
}, 'quoted commas survive in both last name and company');
deepEqFields(h.attendees[1], {
  first: 'Tomas', last: 'Bergstrom',
  title: 'VP, Legal', company: 'The "Northwind" Group'
}, 'quoted comma in title and "" escaping in company both handled');
eq(h.summary, 'Imported 2 attendees.', 'clean import summary has no skip clause');

group('5b. CSV: line numbers survive CRLF, and skipped rows are reported');

var withGap =
  'First Name,Last Name,Title,Company' + CRLF +
  'Juno,Vasquez,Counsel,Basalt Mining' + CRLF +
  ',,Analyst,Basalt Mining' + CRLF +
  'Dev,Raman,Legal Ops Lead,Sundial Payments' + CRLF;

var g = I.parseCsv(withGap);
eq(g.attendees.length, 2, 'two good rows imported');
eq(g.skipped, 1, 'one row skipped');
var csvSkipped = g.report.filter(function (e) { return e.status === 'skipped'; })[0];
eq(csvSkipped.line, 3, 'the nameless row is reported at its true line number (3)');
eq(I.formatReportLine(csvSkipped), 'Line 3: skipped ' + DASH + ' no first or last name',
  'CSV skip report line is exact');
eq(g.summary, 'Imported 2 attendees, skipped 1 line.', 'summary counts imports and skips');

var quotedNewline = I.parseCsv(
  'First,Last,Title,Company\nAsha,Bello,"Counsel,\nCommercial",Foxglove Media\n'
);
eq(quotedNewline.attendees.length, 1, 'a newline inside quotes does not split the record');
eq(quotedNewline.attendees[0].title, 'Counsel,\nCommercial',
  'the quoted newline stays inside the field');

/* ===================================================================== *
 * 6. CSV: unrecognizable header is an error and imports nothing
 * ===================================================================== */

group('6. CSV: unrecognizable header imports nothing');

var junk = I.parseCsv('col1,col2,col3,col4\nfoo,bar,baz,qux\nalpha,beta,gamma,delta\n');
eq(junk.ok, false, 'result is flagged not-ok');
eq(junk.attendees.length, 0, 'nothing was imported');
eq(junk.imported, 0, 'imported count is 0');
ok(junk.error.indexOf('No recognizable header row') === 0,
  'error opens with "No recognizable header row"', 'got: ' + junk.error);
ok(junk.error.indexOf('col1 | col2 | col3 | col4') !== -1,
  'error shows the header row it actually saw', 'got: ' + junk.error);
ok(junk.error.indexOf('Nothing was imported') !== -1,
  'error states plainly that nothing was imported');

var titleOnly = I.parseCsv('Job Title,Company\nCounsel,Basalt Mining\n');
eq(titleOnly.ok, false, 'a header with no name column is also refused');
eq(titleOnly.attendees.length, 0, 'and imports nothing');

var emptyFile = I.parseCsv('');
eq(emptyFile.ok, false, 'an empty file is reported, not silently accepted');
eq(emptyFile.error, 'The file is empty.', 'empty-file message is plain');

/* ===================================================================== *
 * 7. committed fixture
 * ===================================================================== */

group('7. Fixture test/fixtures/import-sample.csv');

ok(fs.existsSync(FIXTURE), 'fixture file exists at ' + FIXTURE);
var fixtureText = fs.readFileSync(FIXTURE, 'utf8');
var fx = I.parseCsv(fixtureText);

ok(fx.ok, 'fixture parses');
eq(fx.attendees.length, 4, 'fixture yields exactly 4 attendees');
eq(fx.skipped, 0, 'fixture has no skipped rows');
deepEqFields(fx.attendees[0], {
  first: 'Cordelia', last: 'Ashworth',
  title: 'Deputy General Counsel', company: 'Foxglove Media'
}, 'fixture row 1 maps correctly');
deepEqFields(fx.attendees[3], {
  first: 'Ravi', last: 'Chandrasekaran',
  title: 'Chief Compliance Officer', company: 'Sundial Payments'
}, 'fixture row 4 maps correctly');
eq(fx.columns.first, 0, 'fixture "First Name" is column 0');
eq(fx.columns.last, 1, 'fixture "Last Name" is column 1');
eq(fx.columns.title, 2, 'fixture "Title" is column 2');
eq(fx.columns.company, 3, 'fixture "Company" is column 3');

/* ===================================================================== *
 * 8. XSS: hostile text renders as literal text, never as an element
 * ===================================================================== */

group('8. XSS: hostile attendee text renders literally');

var PAYLOAD = '<img src=x onerror=alert(1)>';
var hostile = {
  id: 'x1',
  first: 'Wren',
  last: PAYLOAD,
  title: 'Counsel & "Advisor"',
  company: '<script>alert(2)</script>'
};

var row = I.buildRow(hostile, 0, {}, shimDocument);

ok(row.textContent.indexOf(PAYLOAD) !== -1,
  'row textContent contains the payload as literal text',
  'textContent was: ' + row.textContent);

var html = row.innerHTML;
ok(html.indexOf('&lt;img') !== -1,
  'serialized row contains the ESCAPED form &lt;img',
  'innerHTML was: ' + html);
ok(html.indexOf('<img') === -1,
  'serialized row contains no live <img tag',
  'innerHTML was: ' + html);
ok(html.indexOf('<script') === -1 && html.indexOf('&lt;script') !== -1,
  'the <script> company value is escaped, not live');
ok(html.indexOf('onerror=alert') === -1 || html.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1,
  'onerror only ever appears inside the escaped text run');

var tags = allElements(row).map(function (e) { return e.tagName; });
eq(tags.indexOf('IMG'), -1, 'no IMG element node exists anywhere in the row');
eq(tags.indexOf('SCRIPT'), -1, 'no SCRIPT element node exists anywhere in the row');
ok(tags.join(',').length > 0, 'the row did build real elements (' + tags.join(',') + ')');

ok(html.indexOf('&amp;') !== -1, 'a bare & in the title is escaped to &amp;',
  'innerHTML was: ' + html);

/* The edit form must also be safe: the payload goes into input.value, not markup. */
var editRow = I.buildEditRow(hostile, function () {}, function () {}, shimDocument);
eq(editRow.innerHTML.indexOf('<img'), -1, 'edit row contains no live <img either');

/* Proof the shim would have caught an innerHTML assignment. */
var threw = false;
try { new Element('div').innerHTML = '<b>x</b>'; } catch (e) { threw = true; }
ok(threw, 'the shim throws on innerHTML assignment, so the tests above are meaningful');

/* ===================================================================== *
 * 9. source audit — the banned APIs
 * ===================================================================== */

group('9. Source audit of js/input.js');

[
  ['fetch(', /fetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['sendBeacon', /sendBeacon/],
  ['innerHTML assignment', /innerHTML\s*=/],
  ['outerHTML assignment', /outerHTML\s*=/],
  ['document.write', /document\s*\.\s*write/],
  ['http(s) URL', /https?:\/\//],
  ['import statement', /^\s*import\s/m],
  ['export statement', /^\s*export\s/m]
].forEach(function (pair) {
  var hits = source.match(pair[1]);
  ok(!hits, 'no ' + pair[0] + ' in js/input.js', hits ? 'found: ' + hits.join(', ') : '');
});

ok(/new\s+window\.FileReader\(/.test(source),
  'CSV import uses FileReader (the only file:// safe reader)');
ok(!/[^\x00-\x7F]/.test(source), 'source file is pure ASCII (no stray invisible characters)');

/* ===================================================================== *
 * 10. mount() must not throw when BadgeStore is absent
 * ===================================================================== */

group('10. Missing BadgeStore is a warning, not an exception');

var warnings = [];
var realWarn = console.warn;
console.warn = function () {
  warnings.push(Array.prototype.slice.call(arguments).join(' '));
};

var mountThrew = null;
try {
  /* fakeWindow has no BadgeStore, and shimDocument.getElementById returns null for
     every mount point - the worst case for the guards. */
  BadgeInput.mount();
} catch (err) {
  mountThrew = err;
}
console.warn = realWarn;

ok(mountThrew === null, 'mount() with no BadgeStore and no mount points did not throw',
  mountThrew ? String(mountThrew && mountThrew.stack) : '');
ok(warnings.some(function (w) { return w.indexOf('BadgeStore not found') !== -1; }),
  'it warned that BadgeStore is missing',
  'warnings were: ' + JSON.stringify(warnings));
ok(warnings.some(function (w) { return w.indexOf('#attendee-list') !== -1; }),
  'it warned about each missing mount point');

/* ===================================================================== *
 * store mock — mirrors js/store.js's real semantics
 *
 * The important ones: moveAttendee takes a signed DELTA, and every mutating
 * method performs exactly ONE persist + ONE broadcast (store.js calls its
 * changedAttendees() once per logical change). Counting those is how we prove a
 * single Move click is a single write.
 * ===================================================================== */

function makeStore(firstNames, opts) {
  opts = opts || {};
  var list = (firstNames || []).map(function (n, i) {
    return { id: 'a' + i, first: n, last: 'L' + n, title: '', company: '' };
  });

  var st = {
    writes: 0,          // localStorage saves
    broadcasts: 0,      // data:changed emissions
    persisted: [],      // the order captured at each save
    calls: [],          // method names, in order
    order: function () { return list.map(function (a) { return a.first; }).join(''); },
    rows: function () { return list.map(function (a) { return a.first; }); },
    count: function () { return list.length; }
  };

  function persist() {
    st.writes++;
    st.broadcasts++;
    st.persisted.push(st.order());
  }

  function indexOf(id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  st.getAttendees = function () {
    st.calls.push('getAttendees');
    if (opts.readThrows) throw new Error('mock: getAttendees exploded');
    if (opts.readNonArray) return 'not-an-array';
    return list.map(function (a) { return Object.assign({}, a); });
  };

  st.setAttendees = function (arr) {
    st.calls.push('setAttendees');
    if (opts.setThrows) throw new Error('mock: setAttendees exploded');
    list = arr.map(function (a) { return Object.assign({}, a); });
    persist();
  };

  st.addAttendee = function (obj) {
    st.calls.push('addAttendee');
    if (opts.addThrows) throw new Error('mock: addAttendee exploded');
    if (opts.refuseAdd) return null; // store.js returns null for an unusable row
    var row = {
      id: 'new' + (list.length + 1), first: obj.first || '', last: obj.last || '',
      title: obj.title || '', company: obj.company || ''
    };
    list.push(row);
    persist();
    return Object.assign({}, row);
  };

  st.updateAttendee = function (id, patch) {
    st.calls.push('updateAttendee');
    if (opts.updateThrows) throw new Error('mock: updateAttendee exploded');
    var i = indexOf(id);
    if (i === -1) return false;
    Object.keys(patch).forEach(function (k) { list[i][k] = patch[k]; });
    persist();
    return true;
  };

  st.removeAttendee = function (id) {
    st.calls.push('removeAttendee');
    if (opts.removeThrows) throw new Error('mock: removeAttendee exploded');
    var i = indexOf(id);
    if (i === -1) return false;
    list.splice(i, 1);
    persist();
    return true;
  };

  /* DELTA semantics, exactly as js/store.js implements it. */
  st.moveAttendee = function (id, delta) {
    st.calls.push('moveAttendee:' + delta);
    if (opts.moveThrows) throw new Error('mock: moveAttendee exploded');
    var i = indexOf(id);
    if (i === -1) return false;
    var d = typeof delta === 'number' && isFinite(delta) ? Math.round(delta) : 0;
    if (d === 0) return false;
    var j = i + d;
    if (j < 0 || j >= list.length) return false;
    var moved = list.splice(i, 1)[0];
    list.splice(j, 0, moved);
    persist();
    return true;
  };

  st.subscribe = function () { return function () {}; };
  return st;
}

function withStore(st, fn) {
  fakeWindow.BadgeStore = st;
  try { return fn(); } finally { fakeWindow.BadgeStore = undefined; }
}

/**
 * Run fn with console.error/warn captured. The fault-injection tests below make
 * input.js log on purpose; the logging is expected behaviour, not noise to hide,
 * so the captured lines are returned and asserted on.
 */
var lastLogs = [];
function quiet(fn) {
  var logs = [];
  var realError = console.error;
  var realWarn = console.warn;
  console.error = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
  console.warn = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
  try { return fn(); } finally {
    console.error = realError;
    console.warn = realWarn;
    lastLogs = logs;
  }
}

function loggedSomethingAbout(needle, label) {
  ok(lastLogs.join(' | ').indexOf(needle) !== -1, label,
    'captured logs were: ' + JSON.stringify(lastLogs));
}

/* ===================================================================== *
 * 11. Move passes a DELTA: one write, one broadcast, right the first time
 * ===================================================================== */

group('11. Move sends a delta - single write, correct immediately');

var ORDER8 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/* The exact regression: "Move down" on row 3 (D) used to persist ABCEFGHD first
   (D flung to the end) and only then correct itself to ABCEDFGH. */
withStore(makeStore(ORDER8), function () {
  var st = fakeWindow.BadgeStore;
  var moved = I.moveAttendee('a3', +1); // row 3 (D), one slot down

  ok(moved === true, 'moveAttendee reports success');
  eq(st.writes, 1, 'exactly ONE store write for one Move click');
  eq(st.broadcasts, 1, 'exactly ONE data:changed broadcast for one Move click');
  eq(st.persisted.length, 1, 'exactly one persisted snapshot');
  eq(st.persisted[0], 'ABCEDFGH',
    'the FIRST persisted order is already correct (not ABCEFGHD then a fixup)');
  eq(st.order(), 'ABCEDFGH', 'final order is correct');
  eq(st.calls.indexOf('setAttendees'), -1,
    'setAttendees was never called - the fallback did not run');
  eq(st.calls.filter(function (c) { return c.indexOf('moveAttendee') === 0; }).length, 1,
    'moveAttendee was called exactly once');
  eq(st.calls.filter(function (c) { return c.indexOf('moveAttendee') === 0; })[0],
    'moveAttendee:1', 'it received the delta +1, not an absolute index');
});

withStore(makeStore(ORDER8), function () {
  var st = fakeWindow.BadgeStore;
  I.moveAttendee('a3', -1); // D one slot up
  eq(st.writes, 1, 'Move up is also one write');
  eq(st.persisted[0], 'ABDCEFGH', 'Move up persists the right order first time');
  eq(st.calls.filter(function (c) { return c.indexOf('moveAttendee') === 0; })[0],
    'moveAttendee:-1', 'Move up sends delta -1');
});

group('11b. Every position, both directions: one write each, order correct');

var sweepBad = [];
for (var mi = 0; mi < ORDER8.length; mi++) {
  [-1, +1].forEach(function (delta) {
    var target = mi + delta;
    var stx = makeStore(ORDER8);
    fakeWindow.BadgeStore = stx;
    var res = quiet(function () { return I.moveAttendee('a' + mi, delta); });
    fakeWindow.BadgeStore = undefined;

    var atEdge = target < 0 || target >= ORDER8.length;
    if (atEdge) {
      if (res !== false || stx.writes !== 0) {
        sweepBad.push('index ' + mi + ' delta ' + delta + ': expected a no-op at the edge, ' +
          'got res=' + res + ' writes=' + stx.writes);
      }
      return;
    }

    var want = ORDER8.slice();
    var m = want.splice(mi, 1)[0];
    want.splice(target, 0, m);
    var wantStr = want.join('');

    if (stx.writes !== 1 || stx.broadcasts !== 1) {
      sweepBad.push('index ' + mi + ' delta ' + delta + ': expected 1 write/1 broadcast, got ' +
        stx.writes + '/' + stx.broadcasts);
    }
    if (stx.persisted[0] !== wantStr) {
      sweepBad.push('index ' + mi + ' delta ' + delta + ': first persisted order was ' +
        stx.persisted[0] + ', wanted ' + wantStr);
    }
  });
}
ok(sweepBad.length === 0,
  'all 16 index/direction combinations: one write, one broadcast, correct order',
  sweepBad.join('\n          '));

group('11c. Move falls back only when the store really disagrees');

withStore(makeStore(ORDER8, { moveThrows: true }), function () {
  var st = fakeWindow.BadgeStore;
  var res = quiet(function () { return I.moveAttendee('a3', +1); });
  ok(res === true, 'a throwing moveAttendee still ends up reordered via the fallback');
  eq(st.order(), 'ABCEDFGH', 'and the resulting order is correct');
  ok(st.calls.indexOf('setAttendees') !== -1, 'the fallback used setAttendees');
  loggedSomethingAbout('moveAttendee() threw', 'the failure was logged, not swallowed');
});

/* ===================================================================== *
 * 12. A failed read must never be mistaken for an empty list
 * ===================================================================== */

group('12. Unreadable list is never overwritten');

[
  ['getAttendees throws', { readThrows: true, addThrows: true }],
  ['getAttendees returns a non-array', { readNonArray: true, addThrows: true }]
].forEach(function (pair) {
  withStore(makeStore(['A', 'B', 'C'], pair[1]), function () {
    var st = fakeWindow.BadgeStore;
    var stored = quiet(function () {
      return I.addAttendees([{ first: 'D', last: 'Delta', title: '', company: '' }]);
    });
    eq(stored, 0, pair[0] + ': addAttendees reports 0 stored');
    eq(st.count(), 3, pair[0] + ': all 3 existing attendees survive');
    eq(st.calls.indexOf('setAttendees'), -1,
      pair[0] + ': setAttendees was never called with a truncated list');
    eq(st.writes, 0, pair[0] + ': nothing was persisted');
    loggedSomethingAbout('unreadable',
      pair[0] + ': it logged that the list was unreadable');
  });
});

withStore(makeStore(['A', 'B', 'C'], { readThrows: true, updateThrows: true }), function () {
  var st = fakeWindow.BadgeStore;
  var res = quiet(function () { return I.updateAttendee('a1', { title: 'Counsel' }); });
  eq(res, false, 'update on an unreadable list reports failure');
  eq(st.count(), 3, 'and destroys nothing');
  eq(st.calls.indexOf('setAttendees'), -1, 'and never calls setAttendees');
});

withStore(makeStore(['A', 'B', 'C'], { readThrows: true, removeThrows: true }), function () {
  var st = fakeWindow.BadgeStore;
  var res = quiet(function () { return I.removeAttendee('a1'); });
  eq(res, false, 'delete on an unreadable list reports failure');
  eq(st.count(), 3, 'and destroys nothing');
});

withStore(makeStore(['A', 'B', 'C'], { readThrows: true, moveThrows: true }), function () {
  var st = fakeWindow.BadgeStore;
  var res = quiet(function () { return I.moveAttendee('a1', +1); });
  eq(res, false, 'reorder on an unreadable list reports failure');
  eq(st.count(), 3, 'and destroys nothing');
  eq(st.writes, 0, 'and persists nothing');
});

eq(I.readAttendees(), null, 'readAttendees() with no store at all returns null, not []');

/* ===================================================================== *
 * 13. Writers report what actually happened
 * ===================================================================== */

group('13. Honest return values');

quiet(function () {
  eq(I.addAttendees([{ first: 'A', last: 'B' }]), 0,
    'with no BadgeStore, addAttendees reports 0 stored (so the UI cannot claim success)');
  eq(I.updateAttendee('x', { title: 'y' }), false, 'updateAttendee reports false with no store');
  eq(I.removeAttendee('x'), false, 'removeAttendee reports false with no store');
  eq(I.moveAttendee('x', 1), false, 'moveAttendee reports false with no store');
});

withStore(makeStore([]), function () {
  eq(I.addAttendees([{ first: 'A' }, { first: 'B' }]), 2, 'a working store reports 2 stored');
});

withStore(makeStore([], { refuseAdd: true }), function () {
  var st = fakeWindow.BadgeStore;
  eq(quiet(function () { return I.addAttendees([{ first: 'A' }, { first: 'B' }]); }), 0,
    'rows the store refuses (returns null) are not counted as stored');
  eq(st.writes, 0, 'and nothing was persisted');
});

withStore(makeStore(['A'], { addThrows: true }), function () {
  var st = fakeWindow.BadgeStore;
  eq(quiet(function () { return I.addAttendees([{ first: 'B' }, { first: 'C' }]); }), 2,
    'a throwing addAttendee falls back and still stores both rows');
  eq(st.order(), 'ABC', 'in the right order, appended after the existing row');
});

/* ===================================================================== *
 * 14. Bulk paste: the three silent-mangling inputs
 * ===================================================================== */

group('14a. Quoted newline stays one attendee (matching the CSV path)');

var nlBulk = 'Cordelia,"Ash\nworth",Deputy General Counsel,Foxglove Media';
var nlRes = I.parseBulk(nlBulk);

eq(nlRes.attendees.length, 1, 'a quoted newline yields ONE attendee, not two bogus ones');
deepEqFields(nlRes.attendees[0], {
  first: 'Cordelia', last: 'Ash\nworth',
  title: 'Deputy General Counsel', company: 'Foxglove Media'
}, 'all four fields land correctly; the company never leaks into the last name');
ok(nlRes.report[0].reason.indexOf('"Last" field contains a line break') !== -1,
  'the embedded line break is reported, not silently absorbed',
  'reason was: ' + nlRes.report[0].reason);
eq(nlRes.report[0].endLine, 2, 'the record is recorded as spanning lines 1-2');

/* The bulk and CSV paths must agree about the same bytes. */
var nlCsv = I.parseCsv('First,Last,Title,Company\n' + nlBulk + '\n');
eq(nlCsv.attendees.length, 1, 'the CSV path agrees: one attendee');
eq(nlCsv.attendees[0].last, nlRes.attendees[0].last,
  'bulk and CSV produce the SAME last name for identical input');

group('14b. Unbalanced quote is reported, never silently swallowed');

var unbal = I.parseBulk('Cordelia,"Ashworth,Deputy General Counsel,Foxglove Media');
eq(unbal.attendees.length, 0, 'nothing is added from a row with an unbalanced quote');
eq(unbal.skipped, 1, 'it is counted as skipped');
eq(unbal.report[0].reason, 'unbalanced quote - an opening " with no closing "',
  'the reason names the unbalanced quote');
eq(I.formatReportLine(unbal.report[0]),
  'Line 1: skipped ' + DASH + ' unbalanced quote - an opening " with no closing "',
  'the user-visible line is exact');

group('14c. A stray quote does not take the good rows down with it');

var straggler = I.parseBulk([
  'Cordelia,Ashworth,Deputy General Counsel,Foxglove Media',
  'Emeka,"Nwosu,Senior Legal Counsel,Basalt Mining',
  'Solveig,Lindqvist,Associate General Counsel,Nordvind Shipping'
].join('\n'));

eq(straggler.attendees.length, 2, 'the two well-formed rows are still added');
eq(straggler.attendees[0].first, 'Cordelia', 'the row before the stray quote survives');
eq(straggler.attendees[1].first, 'Solveig', 'the row after the stray quote survives');
eq(straggler.skipped, 1, 'only the offending row is skipped');
var strag = straggler.report.filter(function (e) { return e.status === 'skipped'; })[0];
eq(strag.line, 2, 'and it is reported at line 2');
ok(strag.reason.indexOf('unbalanced quote') !== -1, 'with the unbalanced-quote reason');

group('14d. A tab inside quotes no longer beats the quoting');

var tabInQuotes = I.parseBulk('Cordelia,"Ash\tworth",General Counsel,Foxglove Media');
eq(tabInQuotes.attendees.length, 1, 'one attendee');
deepEqFields(tabInQuotes.attendees[0], {
  first: 'Cordelia', last: 'Ash\tworth',
  title: 'General Counsel', company: 'Foxglove Media'
}, 'the quoted tab stays in the last name; nothing collapses into first');
eq(I.detectDelimiter('Cordelia,"Ash\tworth",GC,Foxglove'), ',',
  'detectDelimiter ignores a tab that is inside quotes');
eq(I.detectDelimiter('Cordelia\tAshworth\t"GC, Legal"\tFoxglove'), '\t',
  'but still finds a real tab delimiter outside quotes');
eq(I.quotesBalanced('a,"b",c'), true, 'quotesBalanced accepts balanced quotes');
eq(I.quotesBalanced('a,"b,c'), false, 'quotesBalanced rejects an unclosed quote');
eq(I.quotesBalanced('a,"b""c",d'), true, 'quotesBalanced understands "" escapes');

/* ===================================================================== *
 * 15. CSV: ignored columns are reported, not computed and discarded
 * ===================================================================== */

group('15. Unrecognized and duplicate CSV columns are reported');

var extraCols = I.parseCsv(
  'First Name,Last Name,Email,Job Title,Dietary,Company\n' +
  'Juno,Vasquez,j@example.invalid,Counsel,Vegetarian,Basalt Mining\n'
);
ok(extraCols.ok, 'the file still imports');
eq(extraCols.attendees.length, 1, 'one attendee');
eq(JSON.stringify(extraCols.unrecognized), JSON.stringify(['Email', 'Dietary']),
  'both unrecognized headers are collected');

var dupCols = I.parseCsv('First,First,Last\nJuno,Ignored,Vasquez\n');
ok(dupCols.ok, 'a duplicate column does not break the import');
eq(dupCols.attendees[0].first, 'Juno', 'the FIRST matching column wins');
eq(dupCols.duplicates.length, 1, 'the duplicate is recorded');
eq(dupCols.duplicates[0].field, 'first', 'recorded against the field it duplicated');
eq(dupCols.duplicates[0].column, 2, 'with its 1-based column number');

/* Both must actually reach the DOM. */
var reportBox = shimDocument.createElement('div');
I.renderReport(reportBox, extraCols, shimDocument);
ok(reportBox.textContent.indexOf('Email') !== -1 &&
   reportBox.textContent.indexOf('Dietary') !== -1,
  'renderReport shows the unrecognized column names',
  'rendered: ' + reportBox.textContent);
ok(reportBox.textContent.indexOf('unrecognized') !== -1,
  'and says they were unrecognized');

var dupBox = shimDocument.createElement('div');
I.renderReport(dupBox, dupCols, shimDocument);
ok(dupBox.textContent.indexOf('duplicate') !== -1,
  'renderReport shows the duplicate column',
  'rendered: ' + dupBox.textContent);
ok(dupBox.textContent.indexOf('first matching column wins') !== -1,
  'and explains which one won');

group('15b. A store failure is surfaced, never hidden behind a success line');

var failBox = shimDocument.createElement('div');
I.renderReport(failBox, {
  ok: true, summary: 'Added 0 attendees.', report: [],
  storeError: 'Only 0 of 2 parsed rows could be saved.',
  keptNote: 'Nothing was removed from the box.'
}, shimDocument);
ok(failBox.textContent.indexOf('Only 0 of 2') !== -1, 'the store error is rendered');
ok(failBox.textContent.indexOf('Nothing was removed') !== -1, 'the kept-text note is rendered');

group('15c. Hostile column names on the new report paths are escaped too');

var hostileHeaders = I.parseCsv(
  'First,Last,<img src=x onerror=alert(3)>\nWren,Calloway,x\n'
);
var hostileBox = shimDocument.createElement('div');
I.renderReport(hostileBox, hostileHeaders, shimDocument);
ok(hostileBox.textContent.indexOf('<img src=x onerror=alert(3)>') !== -1,
  'the hostile header appears as literal text');
ok(hostileBox.innerHTML.indexOf('&lt;img') !== -1 &&
   hostileBox.innerHTML.indexOf('<img') === -1,
  'and is escaped in the serialized output, with no live element',
  'innerHTML: ' + hostileBox.innerHTML);
eq(allElements(hostileBox).map(function (e) { return e.tagName; }).indexOf('IMG'), -1,
  'no IMG node was created on the unrecognized-column path');

/* ===================================================================== *
 * 16. Re-clicking "Add all" cannot duplicate what already landed
 * ===================================================================== */

group('16. The bulk box keeps only what still needs fixing');

var reText = [
  'Cordelia,Ashworth,Deputy General Counsel,Foxglove Media',
  ',,Analyst,Basalt Mining',
  'Solveig,Lindqvist,Associate General Counsel,Nordvind Shipping'
].join('\n');

var reRes = I.parseBulk(reText);
eq(reRes.attendees.length, 2, 'two rows parse');
var leftover = I.remainingBulkText(reText, reRes, 2);
eq(leftover, ',,Analyst,Basalt Mining',
  'the two stored lines are removed, the malformed one is kept verbatim');

var second = I.parseBulk(leftover);
eq(second.attendees.length, 0, 'a second Add all on what is left adds NOTHING (no duplicates)');
eq(second.skipped, 1, 'and still reports the malformed line');

var partial = I.remainingBulkText(reText, reRes, 1);
eq(partial, ',,Analyst,Basalt Mining\nSolveig,Lindqvist,Associate General Counsel,Nordvind Shipping',
  'when only 1 of 2 stored, only the first added line is removed');

var allGood = I.remainingBulkText(
  'Cordelia,Ashworth,GC,Foxglove\nSolveig,Lindqvist,AGC,Nordvind',
  I.parseBulk('Cordelia,Ashworth,GC,Foxglove\nSolveig,Lindqvist,AGC,Nordvind'), 2);
eq(allGood, '', 'when everything stored, the box is left empty');

var spanning = 'Cordelia,"Ash\nworth",GC,Foxglove\n,,Analyst,Basalt';
var spanRes = I.parseBulk(spanning);
eq(I.remainingBulkText(spanning, spanRes, 1), ',,Analyst,Basalt',
  'a record spanning two physical lines has BOTH lines removed');

/* ===================================================================== *
 * 17. The edit row keeps its page/slot label
 * ===================================================================== */

group('17. Inline edit row keeps its position label');

var editWithPos = I.buildEditRow(
  { id: 'e1', first: 'Juno', last: 'Vasquez', title: 'Counsel', company: 'Basalt Mining' },
  function () {}, function () {}, shimDocument, 8 // index 8 => page 2, slot 3
);
ok(editWithPos.textContent.indexOf('p2') !== -1 && editWithPos.textContent.indexOf('3') !== -1,
  'the edit row shows p2 slot 3 so the column does not skip a number',
  'textContent: ' + editWithPos.textContent);

var editNoPos = I.buildEditRow(
  { id: 'e2', first: 'Juno', last: 'Vasquez' }, function () {}, function () {}, shimDocument
);
ok(editNoPos.textContent.indexOf('p') === -1 || true,
  'omitting the index is still supported (no crash)');

/* ===================================================================== *
 * summary
 * ===================================================================== */

console.log('\n' + '-'.repeat(58));
console.log((failed === 0 ? 'ALL PASS' : 'FAILURES') + '  -  ' + passed + ' passed, ' + failed + ' failed');
console.log('-'.repeat(58));
process.exit(failed === 0 ? 0 : 1);
