/* js/input.js \u2014 window.BadgeInput
 *
 * The right-hand side panel's data entry. Owns four mount points that index.html
 * ships empty:
 *
 *   #entry-form     four-field manual add (First / Last / Title / Company)
 *   #bulk-paste     one-attendee-per-line paste box (tab OR comma separated)
 *   #csv-import     local .csv file import (FileReader \u2014 never fetch)
 *   #attendee-list  the editable, reorderable list of attendees
 *
 * Everything is written into the store through window.BadgeStore. The store is
 * treated as optional: if it has not landed, mount() logs a warning and the
 * panel still renders (it just has nowhere to persist to).
 *
 * HARD RULES honoured here:
 *   - No network of any kind: no fetch, no XHR, no sockets, no beacons, no URLs.
 *     (The banned API names are deliberately not spelled out here, so a repo-wide
 *     grep for them returns real hits only.) CSV files are read with FileReader,
 *     the only local-file reader that works under file://.
 *   - Classic script, no ES modules, assigns one global.
 *   - All user text reaches the DOM through textContent / createElement only.
 *     There is no innerHTML assignment anywhere in this file, so a name like
 *     <img src=x onerror=...> can only ever become a text node.
 *
 * Parsers are pure and exported on BadgeInput.internals for the node test.
 */
(function (window, document) {
  'use strict';

  /* =====================================================================
   * 1. Field/header vocabulary
   * ===================================================================== */

  /* Canonical field order for bulk paste, and the order the entry form shows. */
  var FIELDS = ['first', 'last', 'title', 'company'];

  var FIELD_LABELS = {
    first: 'First',
    last: 'Last',
    title: 'Title',
    company: 'Company'
  };

  /**
   * Tolerant header normalisation.
   *
   * THE RULE: lowercase, then delete every character that is not a-z or 0-9.
   * That removes spaces, underscores, hyphens, dots, a UTF-8 BOM, stray quotes
   * and any other punctuation in one pass, so all of these collapse to "firstname":
   *   "First Name"  "firstname"  "first_name"  "FIRST-NAME"  " first name "  "\uFEFFFirst Name"
   */
  function normalizeHeader(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /* Accepted spellings, already normalised. First match wins; a header that
     normalises to none of these is an unrecognised column and is ignored. */
  var HEADER_ALIASES = {
    first: ['first', 'firstname', 'givenname', 'forename', 'fname'],
    last: ['last', 'lastname', 'surname', 'familyname', 'lname'],
    title: ['title', 'jobtitle', 'position', 'role', 'jobposition'],
    company: ['company', 'companyname', 'organization', 'organisation', 'employer', 'org']
  };

  /** @return 'first' | 'last' | 'title' | 'company' | null */
  function matchHeader(raw) {
    var key = normalizeHeader(raw);
    if (!key) return null;
    for (var i = 0; i < FIELDS.length; i++) {
      var field = FIELDS[i];
      if (HEADER_ALIASES[field].indexOf(key) !== -1) return field;
    }
    return null;
  }

  /* =====================================================================
   * 2. Delimited-text primitives
   * ===================================================================== */

  /**
   * Split one already-isolated line on `delim`, honouring double quotes.
   * `""` inside a quoted field is a literal quote. Fields are trimmed, which is
   * how "tolerate extra whitespace" is satisfied; the trim happens after quote
   * removal so a quoted field keeps its interior spacing intact.
   */
  function splitLine(line, delim) {
    var out = [];
    var cur = '';
    var inQuotes = false;
    var i = 0;
    var s = String(line == null ? '' : line);

    while (i < s.length) {
      var ch = s.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        cur += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === delim) { out.push(cur); cur = ''; i++; continue; }
      cur += ch; i++;
    }
    out.push(cur);

    for (var j = 0; j < out.length; j++) out[j] = out[j].trim();
    return out;
  }

  /**
   * Which delimiter is this record using? A tab OUTSIDE quotes wins, otherwise comma.
   *
   * Scanning outside quotes is the whole point. In
   *     Cordelia,"Ash<TAB>worth",GC,Foxglove
   * the tab belongs to a quoted value, so calling the record tab-separated would
   * collapse all four fields into `first`. Quote state is tracked exactly the way
   * splitLine() tracks it, so the two can never disagree about what is quoted.
   */
  function detectDelimiter(line) {
    var s = String(line == null ? '' : line);
    var inQuotes = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"') {
        if (inQuotes && s.charAt(i + 1) === '"') { i++; continue; } // "" is an escape
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === '\t' && !inQuotes) return '\t';
    }
    return ',';
  }

  /**
   * Does every opening quote in this text have a closing one? Same "" handling as
   * splitLine(). An unbalanced quote makes the splitter swallow every remaining
   * delimiter, which silently mangles the row instead of failing, so callers use
   * this to reject the row outright.
   */
  function quotesBalanced(text) {
    var s = String(text == null ? '' : text);
    var inQuotes = false;
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) !== '"') continue;
      if (inQuotes && s.charAt(i + 1) === '"') { i++; continue; }
      inQuotes = !inQuotes;
    }
    return !inQuotes;
  }

  /** Strip a UTF-8 BOM, if present. (\uFEFF written as an escape on purpose.) */
  function stripBom(text) {
    var s = String(text == null ? '' : text);
    return s.charAt(0) === '\uFEFF' ? s.slice(1) : s;
  }

  /* Map an array of raw values onto {first,last,title,company} in FIELDS order.
     Missing trailing values become ''. */
  function fieldsFromPositional(values) {
    var rec = { first: '', last: '', title: '', company: '' };
    for (var i = 0; i < FIELDS.length; i++) {
      rec[FIELDS[i]] = values.length > i ? String(values[i] || '').trim() : '';
    }
    return rec;
  }

  function hasName(rec) {
    return !!((rec.first && rec.first.length) || (rec.last && rec.last.length));
  }

  function displayName(rec) {
    return (String(rec.first || '') + ' ' + String(rec.last || '')).trim();
  }

  /* =====================================================================
   * 3. Report model
   *
   * Every parse returns `report`: one entry per non-blank input line, never
   * fewer. Nothing is ever silently dropped except genuinely blank lines.
   *
   *   { line: <1-based line number>, status: 'added' | 'skipped',
   *     reason: <human sentence>, name: <display name or ''> }
   *
   * formatReportLine() is the exact string the user sees:
   *   "Line 2: added \u2014 Cordelia Ashworth"
   *   "Line 5: skipped \u2014 no first or last name"
   * ===================================================================== */

  var DASH = '\u2014'; // em dash, escaped so this source file stays plain ASCII

  /* endLine matters for records that span physical lines (a quoted newline): the
     bulk box removes the exact line range it managed to store. */
  function reportEntry(line, status, reason, name, endLine) {
    return {
      line: line,
      endLine: endLine === undefined || endLine === null ? line : endLine,
      status: status,
      reason: reason || '',
      name: name || ''
    };
  }

  function formatReportLine(entry) {
    var tail = entry.status === 'added'
      ? (entry.name || '(unnamed)') + (entry.reason ? ' (' + entry.reason + ')' : '')
      : (entry.reason || 'skipped');
    return 'Line ' + entry.line + ': ' + entry.status + ' ' + DASH + ' ' + tail;
  }

  function countStatus(report, status) {
    var n = 0;
    for (var i = 0; i < report.length; i++) if (report[i].status === status) n++;
    return n;
  }

  var REASON_NO_NAME = 'no first or last name';
  var REASON_BAD_QUOTE = 'unbalanced quote - an opening " with no closing "';

  function extraFieldsNote(extra) {
    return 'ignored ' + extra + ' extra field' + (extra === 1 ? '' : 's');
  }

  /* Quoted, capitalised label: "the last field" would read as "the final field". */
  function lineBreakNote(field) {
    return 'the "' + FIELD_LABELS[field] + '" field contains a line break';
  }

  /* =====================================================================
   * 4. Bulk paste parser
   * ===================================================================== */

  /**
   * Split a pasted block into RECORDS rather than lines, tracking quote state, so a
   * quoted field containing a newline stays one field. The CSV parser already worked
   * this way; doing it here too stops the two paths from disagreeing about the same
   * input, which is how a company name used to end up inside a last-name line.
   *
   * @return array of { text, line, endLine, unterminated }
   *   `unterminated` = the quotes never closed before end of input.
   */
  function scanBulkRecords(text) {
    var s = stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var records = [];
    var cur = '';
    var inQuotes = false;
    var line = 1;
    var startLine = 1;
    var i = 0;

    while (i < s.length) {
      var ch = s.charAt(i);

      if (ch === '"') {
        if (inQuotes && s.charAt(i + 1) === '"') { cur += '""'; i += 2; continue; }
        inQuotes = !inQuotes;
        cur += ch; i++; continue;
      }

      if (ch === '\n') {
        if (inQuotes) { cur += '\n'; i++; line++; continue; } // newline inside a field
        records.push({ text: cur, line: startLine, endLine: line, unterminated: false });
        cur = ''; i++; line++; startLine = line;
        continue;
      }

      cur += ch; i++;
    }

    if (cur.length) {
      records.push({ text: cur, line: startLine, endLine: line, unterminated: inQuotes });
    }
    return records;
  }

  /**
   * @param {string} text  the pasted block
   * @return {{attendees:Array, report:Array, added:number, skipped:number, summary:string}}
   */
  function parseBulk(text) {
    var attendees = [];
    var report = [];
    var records = scanBulkRecords(text);

    for (var r = 0; r < records.length; r++) {
      var rec = records[r];
      if (rec.unterminated) {
        recoverUnterminated(rec, attendees, report);
        continue;
      }
      consumeBulkRecord(rec.text, rec.line, rec.endLine, attendees, report);
    }

    var added = countStatus(report, 'added');
    var skipped = countStatus(report, 'skipped');
    return {
      attendees: attendees,
      report: report,
      added: added,
      skipped: skipped,
      summary: summarize('Added', added, skipped)
    };
  }

  /**
   * A stray quote makes the scanner swallow everything to the end of the paste. Rather
   * than rejecting every good row after it, fall back to line-by-line: each physical
   * line whose quotes do not balance is REPORTED as malformed, the balanced ones parse
   * normally. Nothing is silently mangled and nothing good is lost.
   */
  function recoverUnterminated(rec, attendees, report) {
    var lines = String(rec.text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var lineNo = rec.line + i;
      if (!raw || !raw.trim()) continue; // blank: silent, by spec
      if (!quotesBalanced(raw)) {
        report.push(reportEntry(lineNo, 'skipped', REASON_BAD_QUOTE, ''));
        continue;
      }
      consumeBulkRecord(raw, lineNo, lineNo, attendees, report);
    }
  }

  /** Parse one balanced record into an attendee, or report why it was rejected. */
  function consumeBulkRecord(rawText, lineNo, endLine, attendees, report) {
    if (!rawText || !rawText.trim()) return; // blank record: skipped silently, by spec

    var values = splitLine(rawText, detectDelimiter(rawText));
    var rec = fieldsFromPositional(values);

    if (!hasName(rec)) {
      report.push(reportEntry(lineNo, 'skipped', REASON_NO_NAME, '', endLine));
      return;
    }

    var notes = [];
    var extra = values.length - FIELDS.length;
    if (extra > 0) notes.push(extraFieldsNote(extra));
    for (var f = 0; f < FIELDS.length; f++) {
      if (String(rec[FIELDS[f]]).indexOf('\n') !== -1) notes.push(lineBreakNote(FIELDS[f]));
    }

    report.push(reportEntry(lineNo, 'added', notes.join('; '), displayName(rec), endLine));
    attendees.push(rec);
  }

  function summarize(verb, added, skipped) {
    var s = verb + ' ' + added + ' attendee' + (added === 1 ? '' : 's');
    s += skipped ? ', skipped ' + skipped + ' line' + (skipped === 1 ? '' : 's') + '.' : '.';
    return s;
  }

  /* =====================================================================
   * 5. CSV parser
   * ===================================================================== */

  /**
   * Split CSV text into records, quote-aware, tracking each record's starting
   * 1-based line number. Handles CRLF, bare CR, and newlines inside quotes.
   */
  function parseCsvRecords(text, delim) {
    var s = stripBom(text);
    var records = [];
    var fields = [];
    var cur = '';
    var inQuotes = false;
    var line = 1;            // physical line currently being consumed
    var recordStartLine = 1; // line the in-progress record began on
    var pending = false;     // has anything been consumed for this record?
    var i = 0;

    while (i < s.length) {
      var ch = s.charAt(i);

      if (inQuotes) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; } // "" -> "
          inQuotes = false; i++; continue;
        }
        // A newline inside quotes belongs to the field, not to the record.
        if (ch === '\r') {
          cur += '\n';
          if (s.charAt(i + 1) === '\n') i++;
          i++; line++; continue;
        }
        if (ch === '\n') { cur += '\n'; i++; line++; continue; }
        cur += ch; i++; continue;
      }

      if (ch === '"') { inQuotes = true; pending = true; i++; continue; }
      if (ch === delim) { fields.push(cur.trim()); cur = ''; pending = true; i++; continue; }

      if (ch === '\r' || ch === '\n') { // end of record (CRLF, LF or bare CR)
        fields.push(cur.trim());
        cur = '';
        records.push({ fields: fields, line: recordStartLine });
        fields = [];
        if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
        i++; line++;
        recordStartLine = line;
        pending = false;
        continue;
      }

      cur += ch; pending = true; i++;
    }

    // Flush a final record only if the file did not end on a clean line break.
    if (pending || cur.length || fields.length) {
      fields.push(cur.trim());
      records.push({ fields: fields, line: recordStartLine });
    }

    return records;
  }

  function isBlankRecord(rec) {
    for (var i = 0; i < rec.fields.length; i++) {
      if (rec.fields[i] && rec.fields[i].length) return false;
    }
    return true;
  }

  /**
   * @param {string} text  raw CSV file contents
   * @return {{ok:boolean, error:string, attendees:Array, report:Array,
   *           imported:number, skipped:number, summary:string,
   *           headerMap:Object, unrecognized:Array}}
   */
  function parseCsv(text) {
    var clean = stripBom(text);
    var firstPhysicalLine = clean.split(/\r\n|\r|\n/)[0] || '';
    var delim = detectDelimiter(firstPhysicalLine);

    var records = parseCsvRecords(clean, delim);

    // Drop leading blank records so a file that starts with an empty line still works.
    while (records.length && isBlankRecord(records[0])) records.shift();

    if (!records.length) {
      return csvFailure('The file is empty.');
    }

    var header = records[0];
    var headerMap = {};       // column index -> field
    var found = {};           // field -> column index
    var unrecognized = [];    // headers that matched no field at all
    var duplicates = [];      // a second column claiming a field already taken

    for (var c = 0; c < header.fields.length; c++) {
      var field = matchHeader(header.fields[c]);
      if (field && found[field] === undefined) {
        headerMap[c] = field;
        found[field] = c;
      } else if (field) {
        /* First one wins, but the loser's data would vanish without a word, so it
           is reported like any other ignored column. */
        duplicates.push({
          header: header.fields[c] || FIELD_LABELS[field],
          field: field,
          column: c + 1
        });
      } else if (header.fields[c]) {
        unrecognized.push(header.fields[c]);
      }
    }

    /* A usable header must give us at least one name column. Without first or
       last there is no badge to make, so we refuse rather than import garbage. */
    if (found.first === undefined && found.last === undefined) {
      return csvFailure(
        'No recognizable header row. Line ' + header.line + ' reads: ' +
        header.fields.join(' | ') + '. Expected a header with First and/or Last ' +
        '(also accepted: First Name, firstname, Last Name, Job Title, Position, ' +
        'Company, Company Name, Organization, Employer). Nothing was imported.'
      );
    }

    var attendees = [];
    var report = [];
    var expectedCols = header.fields.length;

    for (var r = 1; r < records.length; r++) {
      var rec = records[r];
      if (isBlankRecord(rec)) continue; // blank rows skipped silently

      var row = { first: '', last: '', title: '', company: '' };
      for (var k = 0; k < FIELDS.length; k++) {
        var f = FIELDS[k];
        var idx = found[f];
        row[f] = (idx !== undefined && rec.fields.length > idx)
          ? String(rec.fields[idx] || '').trim()
          : '';
      }

      if (!hasName(row)) {
        report.push(reportEntry(rec.line, 'skipped', REASON_NO_NAME, ''));
        continue;
      }

      var notes = '';
      var extra = rec.fields.length - expectedCols;
      if (extra > 0) notes = extraFieldsNote(extra);
      else if (rec.fields.length < expectedCols) notes = 'short row, missing fields left blank';

      report.push(reportEntry(rec.line, 'added', notes, displayName(row)));
      attendees.push(row);
    }

    var imported = countStatus(report, 'added');
    var skipped = countStatus(report, 'skipped');

    return {
      ok: true,
      error: '',
      attendees: attendees,
      report: report,
      imported: imported,
      skipped: skipped,
      summary: summarize('Imported', imported, skipped),
      headerMap: headerMap,
      columns: found,
      unrecognized: unrecognized,
      duplicates: duplicates
    };
  }

  function csvFailure(message) {
    return {
      ok: false,
      error: message,
      attendees: [],
      report: [],
      imported: 0,
      skipped: 0,
      summary: message,
      headerMap: {},
      columns: {},
      unrecognized: [],
      duplicates: []
    };
  }

  /* =====================================================================
   * 6. Store adapter
   *
   * BadgeStore is owned by another item. Its documented surface is
   * get/setAttendees + subscribe; this item is also told to use addAttendee /
   * updateAttendee / removeAttendee / moveAttendee. So: prefer the specific
   * method when it exists, otherwise fall back to a get/set round trip. Every
   * call is guarded \u2014 a missing store warns, it never throws.
   *
   * THREE RULES, each learned from a real defect:
   *
   *  1. moveAttendee takes a signed DELTA (-1 up, +1 down), matching js/store.js.
   *     Passing an absolute index made the store treat it as a delta, so the row
   *     shot to the wrong slot, got persisted that way, and only a second write
   *     corrected it \u2014 two broadcasts and two saves per click, the first wrong.
   *     The first call must be right; verification must never be load-bearing.
   *
   *  2. A FAILED READ IS NOT AN EMPTY LIST. readAttendees() returns null when the
   *     store throws or hands back a non-array. Every fallback writer aborts on
   *     null instead of building a replacement list on top of nothing \u2014 that
   *     shape silently deleted every attendee.
   *
   *  3. Writers report whether the data actually landed. The UI must never say
   *     "Added" when nothing was stored, and must not throw away the user's
   *     typing on the strength of an assumption.
   * ===================================================================== */

  var idSeq = 0;

  function newId() {
    idSeq++;
    return 'att-' + Date.now().toString(36) + '-' + idSeq.toString(36);
  }

  function store() {
    return window.BadgeStore || null;
  }

  function warnNoStore(what) {
    console.warn('[input] BadgeStore is not available - "' + what + '" did nothing.');
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  /**
   * Read the attendee list, or return NULL if it could not be read.
   * null and [] mean completely different things: [] is "there are no attendees",
   * null is "I do not know what the attendees are". Only rendering may treat the
   * two alike; no writer may.
   */
  function readAttendees() {
    var s = store();
    if (!s || typeof s.getAttendees !== 'function') return null;
    try {
      var arr = s.getAttendees();
      if (!isArray(arr)) {
        console.error('[input] BadgeStore.getAttendees() returned a non-array ' +
          '(' + Object.prototype.toString.call(arr) + '); treating the list as unreadable.');
        return null;
      }
      return arr;
    } catch (err) {
      console.error('[input] BadgeStore.getAttendees() threw:', err);
      return null;
    }
  }

  /** Render-only view: an unreadable list shows as empty, which is safe to draw. */
  function getAttendees() {
    var arr = readAttendees();
    return arr ? arr : [];
  }

  function setAttendees(arr) {
    var s = store();
    if (!s || typeof s.setAttendees !== 'function') { warnNoStore('setAttendees'); return false; }
    try { s.setAttendees(arr); return true; } catch (err) {
      console.error('[input] BadgeStore.setAttendees() threw:', err);
      return false;
    }
  }

  /**
   * Append records (each {first,last,title,company}).
   * @return {number} how many were ACTUALLY stored. Callers must check it.
   */
  function addAttendees(records) {
    var s = store();
    if (!s) { warnNoStore('add attendee'); return 0; }

    var pending = records.slice();
    var stored = 0;

    if (typeof s.addAttendee === 'function') {
      while (pending.length) {
        try {
          /* js/store.js returns the stored attendee, or null when it refused the
             row outright. A refusal will not succeed via the fallback either, so
             drop it rather than retrying. Any other return (incl. undefined) is
             taken as success. */
          var result = s.addAttendee(pending[0]);
          if (result === null) {
            console.error('[input] BadgeStore.addAttendee() refused a row:', pending[0]);
            pending.shift();
            continue;
          }
          pending.shift();
          stored++;
        } catch (err) {
          console.error('[input] BadgeStore.addAttendee() threw; falling back to ' +
            'setAttendees for the remaining ' + pending.length + ' row(s):', err);
          break;
        }
      }
      if (!pending.length) return stored;
    }

    var base = readAttendees();
    if (!base) {
      console.error('[input] the attendee list is unreadable, so it will not be ' +
        'overwritten. ' + pending.length + ' row(s) were not added.');
      return stored;
    }

    var next = base.slice();
    for (var j = 0; j < pending.length; j++) {
      next.push({
        id: pending[j].id || newId(),
        first: pending[j].first || '',
        last: pending[j].last || '',
        title: pending[j].title || '',
        company: pending[j].company || ''
      });
    }
    if (!setAttendees(next)) return stored;
    return stored + pending.length;
  }

  /** @return {boolean} whether the edit reached the store. */
  function updateAttendee(id, patch) {
    var s = store();
    if (!s) { warnNoStore('edit attendee'); return false; }

    if (typeof s.updateAttendee === 'function') {
      try {
        /* store.js returns false both for "no such id" and for "the patch changed
           nothing". Neither is a failure worth surfacing, and they cannot be told
           apart from here, so any non-throwing call counts as applied. */
        s.updateAttendee(id, patch);
        return true;
      } catch (err) {
        console.error('[input] BadgeStore.updateAttendee() threw:', err);
      }
    }

    var base = readAttendees();
    if (!base) {
      console.error('[input] the attendee list is unreadable, so the edit was ' +
        'not applied rather than risking the rest of the list.');
      return false;
    }

    var next = base.map(function (a) {
      if (a.id !== id) return a;
      return {
        id: a.id,
        first: patch.first !== undefined ? patch.first : a.first,
        last: patch.last !== undefined ? patch.last : a.last,
        title: patch.title !== undefined ? patch.title : a.title,
        company: patch.company !== undefined ? patch.company : a.company
      };
    });
    return setAttendees(next);
  }

  /** @return {boolean} whether the delete reached the store. */
  function removeAttendee(id) {
    var s = store();
    if (!s) { warnNoStore('delete attendee'); return false; }

    if (typeof s.removeAttendee === 'function') {
      try { s.removeAttendee(id); return true; } catch (err) {
        console.error('[input] BadgeStore.removeAttendee() threw:', err);
      }
    }

    var base = readAttendees();
    if (!base) {
      console.error('[input] the attendee list is unreadable, so nothing was ' +
        'deleted rather than risking the rest of the list.');
      return false;
    }
    return setAttendees(base.filter(function (a) { return a.id !== id; }));
  }

  /**
   * Move the attendee with `id` by `delta` slots. -1 = up, +1 = down.
   *
   * `delta` matches js/store.js's moveAttendee(id, delta) exactly, so the happy
   * path is ONE store write and ONE data:changed broadcast. The verification
   * re-read below only READS; it exists to catch a store whose signature differs,
   * not to correct a call we knew was wrong.
   *
   * @return {boolean} whether the row ended up where it was asked to go.
   */
  function moveAttendee(id, delta) {
    var s = store();
    if (!s) { warnNoStore('reorder attendee'); return false; }

    var before = readAttendees();
    if (!before) {
      console.error('[input] the attendee list is unreadable, so nothing was reordered.');
      return false;
    }

    var from = indexOfId(before, id);
    if (from === -1) return false;

    var to = from + delta;
    if (to < 0 || to >= before.length || delta === 0) return false; // already at the end

    if (typeof s.moveAttendee === 'function') {
      try {
        s.moveAttendee(id, delta);
        var after = readAttendees();
        if (after && indexOfId(after, id) === to) return true; // one write, done
        console.error('[input] BadgeStore.moveAttendee(id, ' + delta + ') did not ' +
          'land the row at index ' + to + '; falling back to setAttendees.');
      } catch (err) {
        console.error('[input] BadgeStore.moveAttendee() threw:', err);
      }
    }

    var list = before.slice();
    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    return setAttendees(list);
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }

  /* =====================================================================
   * 7. DOM helpers \u2014 textContent only, no innerHTML anywhere
   * ===================================================================== */

  function doc(d) { return d || document; }

  /* The builders themselves live in js/dom.js (window.BadgeDom) so this file and
     js/overrides.js cannot drift apart on them - in particular on the never-innerHTML
     rule that section 9's source audit enforces. Thin named wrappers rather than direct
     aliases, so every existing call site in this file is untouched and a missing
     BadgeDom fails with a message naming the file to load. */
  function dom() {
    var D = window.BadgeDom;
    if (!D) throw new Error('BadgeInput: window.BadgeDom is missing - load js/dom.js first.');
    return D;
  }

  function el(tag, opts, d) { return dom().el(tag, opts, doc(d)); }

  function clear(node) { dom().empty(node); }

  function sectionHeading(text, d) {
    return el('h2', { text: text }, d);
  }

  /**
   * Render a parse report: summary, any store failure, ignored columns, then one
   * line per problem row. Everything the parser noticed gets shown \u2014 a value that
   * was computed and then dropped on the floor is the same bug as never noticing it.
   *
   * Every string goes through el()'s textContent path, including headers taken
   * straight out of the user's file.
   */
  function renderReport(container, result, d) {
    clear(container);
    if (!result) return;

    if (result.ok === false) {
      container.appendChild(el('p', { className: 'report-error', text: result.error }, d));
      return;
    }

    container.appendChild(el('p', {
      className: 'report-summary',
      text: result.summary
    }, d));

    /* A write that did not land is the most important thing on screen. */
    if (result.storeError) {
      container.appendChild(el('p', { className: 'report-error', text: result.storeError }, d));
    }
    if (result.keptNote) {
      container.appendChild(el('p', { className: 'report-note', text: result.keptNote }, d));
    }

    /* Columns whose data was deliberately not imported. */
    var ignored = [];
    if (result.unrecognized && result.unrecognized.length) {
      ignored.push('Ignored ' + result.unrecognized.length + ' unrecognized column' +
        (result.unrecognized.length === 1 ? '' : 's') + ': ' + result.unrecognized.join(', ') +
        '. Nothing from ' + (result.unrecognized.length === 1 ? 'it' : 'them') +
        ' reaches the badges.');
    }
    if (result.duplicates && result.duplicates.length) {
      var dupText = [];
      for (var q = 0; q < result.duplicates.length; q++) {
        var dup = result.duplicates[q];
        dupText.push('"' + dup.header + '" (column ' + dup.column + ', a second ' +
          FIELD_LABELS[dup.field] + ')');
      }
      ignored.push('Ignored ' + result.duplicates.length + ' duplicate column' +
        (result.duplicates.length === 1 ? '' : 's') + ': ' + dupText.join('; ') +
        '. The first matching column wins.');
    }
    for (var n = 0; n < ignored.length; n++) {
      container.appendChild(el('p', { className: 'report-note', text: ignored[n] }, d));
    }

    var problems = [];
    for (var i = 0; i < result.report.length; i++) {
      var e = result.report[i];
      if (e.status === 'skipped' || e.reason) problems.push(e);
    }

    if (!problems.length) return;

    container.appendChild(el('p', {
      className: 'report-label',
      text: problems.length + ' line' + (problems.length === 1 ? '' : 's') + ' needing attention:'
    }, d));

    var ul = el('ul', { className: 'report-list' }, d);
    for (var j = 0; j < problems.length; j++) {
      ul.appendChild(el('li', {
        className: 'report-' + problems[j].status,
        text: formatReportLine(problems[j])
      }, d));
    }
    container.appendChild(ul);
  }

  /* =====================================================================
   * 8. Attendee row
   * ===================================================================== */

  function perPage() {
    var spec = window.BadgeSpec;
    return (spec && spec.PER_PAGE) ? spec.PER_PAGE : 6;
  }

  /** "p2 \u00b7 3" \u2014 the sheet and slot this row will print in. */
  function positionLabel(index) {
    var pp = perPage();
    return {
      text: 'p' + (Math.floor(index / pp) + 1) + ' \u00b7 ' + ((index % pp) + 1),
      title: 'Page ' + (Math.floor(index / pp) + 1) + ', slot ' + ((index % pp) + 1)
    };
  }

  /**
   * Build one attendee row. `handlers` is optional so the node test can build a
   * row with no store attached; `d` lets the test inject its own document.
   *
   * Every attendee value goes in via opts.text -> textContent. A last name of
   * `<img src=x onerror=alert(1)>` therefore becomes a text node, never an element.
   */
  function buildRow(attendee, index, handlers, d) {
    handlers = handlers || {};
    var label = positionLabel(index);

    var row = el('li', { className: 'att-row', attrs: { 'data-id': attendee.id || '' } }, d);

    var pos = el('span', {
      className: 'att-pos',
      text: label.text,
      attrs: { title: label.title }
    }, d);

    var body = el('div', { className: 'att-body' }, d);
    body.appendChild(el('div', {
      className: 'att-name',
      text: displayName(attendee) || '(no name)'
    }, d));
    body.appendChild(el('div', { className: 'att-meta', text: attendee.title || '' }, d));
    body.appendChild(el('div', { className: 'att-meta att-company', text: attendee.company || '' }, d));

    var acts = el('div', { className: 'att-acts' }, d);
    acts.appendChild(button('Edit', 'Edit ' + displayName(attendee), handlers.onEdit, d));
    acts.appendChild(button('\u2191', 'Move up', handlers.onUp, d));
    acts.appendChild(button('\u2193', 'Move down', handlers.onDown, d));
    acts.appendChild(button('Delete', 'Delete ' + displayName(attendee), handlers.onDelete, d));

    row.appendChild(pos);
    row.appendChild(body);
    row.appendChild(acts);
    return row;
  }

  function button(label, aria, fn, d) { return dom().button(label, aria, fn, doc(d)); }

  /**
   * Inline edit form for one attendee.
   * `index` is optional (the node test omits it); when given, the row keeps its
   * "pN \u00b7 slot" label so the column does not skip a number while a row is open.
   */
  function buildEditRow(attendee, onSave, onCancel, d, index) {
    var row = el('li', { className: 'att-row att-row-editing', attrs: { 'data-id': attendee.id || '' } }, d);
    var inputs = {};
    var grid = el('div', { className: 'att-edit-grid' }, d);

    if (typeof index === 'number' && index >= 0) {
      var label = positionLabel(index);
      row.appendChild(el('span', {
        className: 'att-pos att-edit-pos',
        text: label.text,
        attrs: { title: label.title }
      }, d));
    }

    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var input = el('input', {
        className: 'att-edit-input',
        attrs: { type: 'text', placeholder: FIELD_LABELS[f], 'aria-label': FIELD_LABELS[f] }
      }, d);
      input.value = attendee[f] || '';
      inputs[f] = input;
      grid.appendChild(el('label', { text: FIELD_LABELS[f], children: [input] }, d));
    }

    function collect() {
      return {
        first: inputs.first.value.trim(),
        last: inputs.last.value.trim(),
        title: inputs.title.value.trim(),
        company: inputs.company.value.trim()
      };
    }

    var msg = el('p', { className: 'att-edit-msg' }, d);

    function save() {
      var patch = collect();
      if (!hasName(patch)) {
        msg.textContent = 'Needs a first or last name.';
        return;
      }
      onSave(patch);
    }

    var acts = el('div', { className: 'att-acts' }, d);
    acts.appendChild(button('Save', 'Save changes', save, d));
    acts.appendChild(button('Cancel', 'Cancel editing', onCancel, d));

    if (typeof grid.addEventListener === 'function') {
      grid.addEventListener('keydown', function (ev) {
        if (ev && ev.key === 'Enter') { ev.preventDefault(); save(); }
        if (ev && ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
      });
    }

    row.appendChild(grid);
    row.appendChild(msg);
    row.appendChild(acts);
    return row;
  }

  /* =====================================================================
   * 9. mount()
   * ===================================================================== */

  var mounted = false;
  var editingId = null;
  var editSnapshot = null; // the row's stored values when editing opened
  var listNote = '';       // one-shot message shown above the list
  var renderPending = false;
  var listRoot = null;

  /* This module's presentation lives in styles.css (the "data entry" section), not in
     a style string here. It used to be injected at mount() from a STYLE_CSS array,
     which meant panel styling had two homes and neither was obvious. Note that
     js/preview.js keeps its own injected block ON PURPOSE - those rules control text
     measurement, not appearance. */

  function mount() {
    if (mounted) return;
    mounted = true;

    if (!store()) {
      console.warn('[input] BadgeStore not found at mount time; the panel will ' +
        'render but changes cannot be persisted.');
    }

    mountEntryForm(byId('entry-form'));
    mountBulkPaste(byId('bulk-paste'));
    mountCsvImport(byId('csv-import'));
    mountList(byId('attendee-list'));

    subscribeToData(scheduleRender);
    renderList();
  }

  function byId(id) {
    var node = document.getElementById(id);
    if (!node) console.warn('[input] #' + id + ' is missing from the page.');
    return node;
  }

  function subscribeToData(fn) {
    var s = store();
    if (s && typeof s.subscribe === 'function') {
      try { s.subscribe(fn); return; } catch (err) {
        console.error('[input] BadgeStore.subscribe() threw:', err);
      }
    }
    if (window.BadgeBus && typeof window.BadgeBus.on === 'function') {
      window.BadgeBus.on('data:changed', fn);
      return;
    }
    /* Neither channel is available, so changes made ELSEWHERE (another module, another
       tab) will not refresh this list. Edits made from this panel still redraw, because
       every handler here calls scheduleRender() itself rather than relying on the echo. */
    console.warn('[input] no change notifications available (BadgeStore.subscribe ' +
      'unusable and no BadgeBus): the attendee list will only refresh in response to ' +
      'edits made from this panel.');
  }

  /* Coalesce renders to one per task. Our own writes go through the store, which
     notifies us back; without this a burst of adds would re-render N times, and a
     render that itself touched the store could loop. renderList() only reads. */
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    var run = function () { renderPending = false; renderList(); };
    if (typeof window.setTimeout === 'function') window.setTimeout(run, 0);
    else run();
  }

  /* ---------------------------------------------------- 9a. entry form */

  function mountEntryForm(root) {
    if (!root) return;
    clear(root);
    root.appendChild(sectionHeading('Add attendee'));

    var inputs = {};
    var grid = el('div', { className: 'entry-grid' });

    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var input = el('input', {
        className: 'entry-input',
        attrs: { type: 'text', id: 'entry-' + f, placeholder: FIELD_LABELS[f] }
      });
      inputs[f] = input;
      var label = el('label', { text: FIELD_LABELS[f], attrs: { 'for': 'entry-' + f } });
      var wrap = el('div', { className: 'entry-field', children: [label, input] });
      grid.appendChild(wrap);
    }

    var msg = el('p', { className: 'entry-msg', attrs: { role: 'status' } });
    var addBtn = el('button', { text: 'Add', attrs: { type: 'button' } });

    function submit() {
      var rec = {
        first: inputs.first.value.trim(),
        last: inputs.last.value.trim(),
        title: inputs.title.value.trim(),
        company: inputs.company.value.trim()
      };

      if (!hasName(rec)) {
        msg.textContent = 'Enter a first or last name \u2014 a badge needs one.';
        inputs.first.focus();
        return;
      }

      /* Only claim success, and only throw the typing away, if it was really stored. */
      if (addAttendees([rec]) !== 1) {
        msg.textContent = 'Could not save ' + displayName(rec) + ' \u2014 the attendee ' +
          'list is unavailable. Your entry has been left in the form; see the console ' +
          'for details.';
        return;
      }

      msg.textContent = 'Added ' + displayName(rec) + '.';
      for (var k = 0; k < FIELDS.length; k++) inputs[FIELDS[k]].value = '';
      inputs.first.focus();
      scheduleRender();
    }

    addBtn.addEventListener('click', submit);
    grid.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    root.appendChild(grid);
    root.appendChild(el('div', { className: 'entry-actions', children: [addBtn] }));
    root.appendChild(msg);
  }

  /* ---------------------------------------------------- 9b. bulk paste */

  function mountBulkPaste(root) {
    if (!root) return;
    clear(root);
    root.appendChild(sectionHeading('Paste a list'));

    /* Visible hint text, not a tooltip: the field order must be readable
       next to the box at all times. */
    root.appendChild(el('p', {
      className: 'hint',
      text: 'One attendee per line, in this order: First, Last, Title, Company'
    }));
    root.appendChild(el('p', {
      className: 'hint hint-soft',
      text: 'Separate fields with a tab or a comma. Wrap a field in "quotes" if it ' +
            'contains a comma. Trailing fields may be left off.'
    }));

    var ta = el('textarea', {
      className: 'bulk-textarea',
      attrs: {
        id: 'bulk-textarea',
        rows: '6',
        'aria-label': 'Paste attendees, one per line: First, Last, Title, Company',
        placeholder: 'Cordelia, Ashworth, Deputy General Counsel, Foxglove Media'
      }
    });

    var report = el('div', { className: 'report', attrs: { role: 'status' } });
    var addAllBtn = el('button', { text: 'Add all', attrs: { type: 'button' } });

    addAllBtn.addEventListener('click', function () {
      var text = ta.value || '';
      if (!text.trim()) {
        renderReport(report, { ok: false, error: 'Nothing pasted yet.' });
        return;
      }

      var result = parseBulk(text);
      var stored = result.attendees.length ? addAttendees(result.attendees) : 0;

      /* The summary states what was STORED, not what parsed. */
      result.stored = stored;
      result.summary = summarize('Added', stored, result.skipped);

      if (stored < result.attendees.length) {
        result.storeError = 'Only ' + stored + ' of ' + result.attendees.length +
          ' parsed row' + (result.attendees.length === 1 ? '' : 's') + ' could be saved ' +
          '\u2014 the attendee list is unavailable. Nothing has been removed from the box; ' +
          'see the console for details.';
      }

      /* Lines that made it in are removed; everything else stays put. A second click
         therefore cannot re-add the same people, and the rows still needing a fix are
         the only ones left in front of the user. */
      if (stored > 0) {
        var remaining = remainingBulkText(text, result, stored);
        ta.value = remaining;
        if (remaining.trim()) {
          result.keptNote = 'The ' + stored + ' saved line' + (stored === 1 ? '' : 's') +
            ' have been removed from the box. What is left still needs attention \u2014 ' +
            'fix it and press Add all again.';
        }
      }

      renderReport(report, result);
      scheduleRender();
    });

    root.appendChild(ta);
    root.appendChild(el('div', { className: 'bulk-actions', children: [addAllBtn] }));
    root.appendChild(report);
  }

  /**
   * The paste text with the successfully-stored lines removed.
   *
   * addAttendees() stores in order, so when only `storedCount` of them landed it is
   * the FIRST `storedCount` added entries that are safe to drop. Records that span
   * several physical lines (a quoted newline) drop their whole line range.
   */
  function remainingBulkText(originalText, result, storedCount) {
    var lines = String(originalText == null ? '' : originalText)
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    var drop = {};
    var seen = 0;
    for (var i = 0; i < result.report.length && seen < storedCount; i++) {
      var e = result.report[i];
      if (e.status !== 'added') continue;
      seen++;
      for (var L = e.line; L <= e.endLine; L++) drop[L] = true;
    }

    var kept = [];
    for (var n = 0; n < lines.length; n++) {
      if (!drop[n + 1]) kept.push(lines[n]);
    }
    while (kept.length && !kept[kept.length - 1].trim()) kept.pop(); // no trailing blanks
    return kept.join('\n');
  }

  /* ---------------------------------------------------- 9c. CSV import */

  function mountCsvImport(root) {
    if (!root) return;
    clear(root);
    root.appendChild(sectionHeading('Import a CSV'));

    root.appendChild(el('p', {
      className: 'hint',
      text: 'Columns can be in any order. Headers are matched loosely, so ' +
            '"First Name", "firstname" and "FIRST-NAME" all work. Also accepted: ' +
            'Job Title, Position, Company Name, Organization, Employer.'
    }));

    var file = el('input', {
      className: 'csv-input',
      attrs: { type: 'file', accept: '.csv,text/csv', id: 'csv-file' }
    });
    var report = el('div', { className: 'report', attrs: { role: 'status' } });

    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      readLocalFile(f, function (err, text) {
        if (err) {
          renderReport(report, { ok: false, error: 'Could not read that file: ' + err });
          return;
        }
        var result = parseCsv(text);

        if (result.ok && result.attendees.length) {
          var stored = addAttendees(result.attendees);
          result.stored = stored;
          result.summary = summarize('Imported', stored, result.skipped);
          if (stored < result.attendees.length) {
            result.storeError = 'Only ' + stored + ' of ' + result.attendees.length +
              ' parsed row' + (result.attendees.length === 1 ? '' : 's') + ' could be ' +
              'saved \u2014 the attendee list is unavailable. Re-pick the file once that is ' +
              'resolved; see the console for details.';
          }
        }

        renderReport(report, result);
        scheduleRender();
        file.value = ''; // let the same file be re-picked
      });
    });

    root.appendChild(file);
    root.appendChild(report);
  }

  /**
   * Read a local File as text. FileReader only \u2014 no fetch, which is banned and in
   * any case blocked for local files under file://.
   */
  function readLocalFile(file, done) {
    if (typeof window.FileReader !== 'function') {
      done('this browser has no FileReader.');
      return;
    }
    var reader = new window.FileReader();
    reader.onload = function () { done(null, String(reader.result || '')); };
    reader.onerror = function () { done('read error.'); };
    try { reader.readAsText(file, 'utf-8'); } catch (err) { done(String(err)); }
  }

  /* ---------------------------------------------------- 9d. attendee list */

  function mountList(root) {
    if (!root) return;
    listRoot = root;
    clear(root);
    root.appendChild(sectionHeading('Attendees'));
    root.appendChild(el('p', { className: 'list-count', attrs: { role: 'status' } }));
    root.appendChild(el('p', { className: 'list-note', attrs: { role: 'status' } }));
    root.appendChild(el('ul', { className: 'att-list' }));
  }

  /** Snapshot of the four values, for spotting an outside change mid-edit. */
  function fieldSnapshot(a) {
    return {
      first: a.first || '', last: a.last || '',
      title: a.title || '', company: a.company || ''
    };
  }

  function sameFields(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < FIELDS.length; i++) {
      if (String(a[FIELDS[i]] || '') !== String(b[FIELDS[i]] || '')) return false;
    }
    return true;
  }

  function renderList() {
    if (!listRoot) return;
    var countNode = listRoot.querySelector('.list-count');
    var noteNode = listRoot.querySelector('.list-note');
    var ul = listRoot.querySelector('.att-list');
    if (!ul) return;

    var list = getAttendees();
    clear(ul);

    if (countNode) {
      countNode.textContent = list.length
        ? list.length + ' attendee' + (list.length === 1 ? '' : 's') + ' \u00b7 ' +
          Math.ceil(list.length / perPage()) + ' sheet' +
          (Math.ceil(list.length / perPage()) === 1 ? '' : 's')
        : 'No attendees yet.';
    }

    /* An open edit row must not quietly re-point at different data. If the row is
       gone, or its stored values changed underneath us (another module, another tab,
       a wholesale setAttendees), close the editor and say so rather than letting the
       user save their in-flight text over somebody else's row. */
    if (editingId) {
      var at = indexOfId(list, editingId);
      if (at === -1) {
        editingId = null;
        editSnapshot = null;
        listNote = 'The row being edited was removed elsewhere, so the edit was closed.';
      } else if (editSnapshot && !sameFields(list[at], editSnapshot)) {
        editingId = null;
        editSnapshot = null;
        listNote = 'The row being edited changed elsewhere, so the edit was closed. ' +
          'The current values are shown below.';
      }
    }

    if (noteNode) {
      noteNode.textContent = listNote;
      listNote = ''; // one-shot: it describes what just happened, not a standing state
    }

    for (var i = 0; i < list.length; i++) {
      ul.appendChild(rowFor(list[i], i, list.length));
    }
  }

  function rowFor(attendee, index, total) {
    if (attendee.id && attendee.id === editingId) {
      return buildEditRow(attendee, function (patch) {
        editingId = null;
        editSnapshot = null;
        updateAttendee(attendee.id, patch);
        scheduleRender();
      }, function () {
        editingId = null;
        editSnapshot = null;
        renderList();
      }, null, index);
    }

    var handlers = {
      onEdit: function () {
        editingId = attendee.id;
        editSnapshot = fieldSnapshot(attendee);
        renderList();
      },
      onDelete: function () { removeAttendee(attendee.id); scheduleRender(); },
      /* A signed DELTA, matching BadgeStore.moveAttendee(id, delta): one store write,
         one broadcast, one localStorage save, correct the first time. */
      onUp: index > 0
        ? function () { moveAttendee(attendee.id, -1); scheduleRender(); }
        : null,
      onDown: index < total - 1
        ? function () { moveAttendee(attendee.id, +1); scheduleRender(); }
        : null
    };
    return buildRow(attendee, index, handlers);
  }

  /* =====================================================================
   * 10. Export
   * ===================================================================== */

  window.BadgeInput = {
    mount: mount,

    /* Pure helpers, exported so the node test can exercise them without a DOM.
       Nothing outside this file should depend on them. */
    internals: {
      FIELDS: FIELDS,
      normalizeHeader: normalizeHeader,
      matchHeader: matchHeader,
      splitLine: splitLine,
      detectDelimiter: detectDelimiter,
      quotesBalanced: quotesBalanced,
      stripBom: stripBom,
      parseBulk: parseBulk,
      scanBulkRecords: scanBulkRecords,
      remainingBulkText: remainingBulkText,
      parseCsv: parseCsv,
      parseCsvRecords: parseCsvRecords,
      readAttendees: readAttendees,
      addAttendees: addAttendees,
      updateAttendee: updateAttendee,
      removeAttendee: removeAttendee,
      moveAttendee: moveAttendee,
      formatReportLine: formatReportLine,
      buildRow: buildRow,
      buildEditRow: buildEditRow,
      renderReport: renderReport,
      displayName: displayName,
      hasName: hasName
    }
  };

})(window, document);
