/*
 * js/zip.js - window.BadgeZip
 *
 * A minimal ZIP writer, because a .docx IS a ZIP archive and this project has no
 * bundler and no npm (see CLAUDE.md). Vendoring a general-purpose ZIP library would
 * have meant ~100 KB of third-party code, plus its own provenance record and audit,
 * to get the ~120 lines below.
 *
 * SCOPE - deliberately the smallest thing that works:
 *   - STORE only (compression method 0). Deflate is the one genuinely hard part of
 *     ZIP and we do not need it: a badge sheet's XML is ~40 KB, and Word, Google Docs
 *     and LibreOffice all open stored archives. Verified by repacking the sample
 *     .docx with `zip -0` and converting it with LibreOffice: 612x792 pt, opens clean.
 *   - No reading, no streaming, no encryption, no Zip64, no directory entries.
 *   - Files must be small enough to hold in memory. A badge sheet always is.
 *
 * Zip64 is NOT implemented, so the 32-bit header fields must not overflow. write()
 * throws if any file, or the archive, would exceed 4 GB, rather than silently
 * emitting a corrupt archive - a truncated offset is exactly the kind of bug that
 * opens in one reader and fails in another.
 *
 * Format reference: PKWARE APPNOTE.TXT, sections 4.3.7 (local file header),
 * 4.3.12 (central directory) and 4.3.16 (end of central directory). All integers are
 * little-endian. The layout is frozen and has been for decades.
 *
 * Classic script. No ES modules, no network, no DOM.
 */
(function (window) {
  'use strict';

  var LOCAL_SIG = 0x04034b50;
  var CENTRAL_SIG = 0x02014b50;
  var EOCD_SIG = 0x06054b50;
  var VERSION_NEEDED = 20;   // 2.0 - the floor for a stored entry
  var METHOD_STORE = 0;
  var MAX_U32 = 0xffffffff;

  /* CRC-32 (IEEE 802.3), table built once on first use. The ZIP central directory
     stores this per entry and readers verify it, so an error here produces an archive
     that looks fine until something opens it. */
  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    var t = crcTable();
    var c = -1; // 0xffffffff
    for (var i = 0; i < bytes.length; i++) {
      c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
  }

  /*
   * String -> UTF-8 bytes, done by hand rather than via TextEncoder. Two reasons:
   * it keeps the output byte-identical everywhere (so the tests can assert exact
   * bytes), and it keeps this file working in any environment that runs the app,
   * including a bare file:// page in an older browser.
   *
   * Lone surrogates - a paste can produce one - are encoded as U+FFFD rather than
   * as an invalid sequence, because a malformed UTF-8 byte in an XML part makes the
   * whole .docx unopenable.
   */
  function utf8(str) {
    var s = String(str);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var cp = s.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        var lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        } else {
          cp = 0xfffd; // unpaired high surrogate
        }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        cp = 0xfffd; // unpaired low surrogate
      }
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /* Growable little-endian byte sink. */
  function Sink() {
    this.parts = [];
    this.length = 0;
  }
  Sink.prototype.bytes = function (u8) {
    this.parts.push(u8);
    this.length += u8.length;
  };
  Sink.prototype.u16 = function (v) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  };
  Sink.prototype.u32 = function (v) {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  };
  Sink.prototype.concat = function () {
    var out = new Uint8Array(this.length);
    var at = 0;
    for (var i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], at);
      at += this.parts[i].length;
    }
    return out;
  };

  /*
   * Fixed 1980-01-01 00:00 timestamp on every entry, matching the sample .docx
   * (which also reports 1980). Deliberately NOT the current time: identical input
   * must produce a byte-identical archive, or the tests could not assert on bytes
   * and two exports of the same roster would differ for no reason.
   *   DOS time = hours<<11 | minutes<<5 | seconds/2      -> 0
   *   DOS date = (year-1980)<<9 | month<<5 | day         -> 1980-01-01 = 0x0021
   */
  var DOS_TIME = 0;
  var DOS_DATE = 0x0021;

  /**
   * write(files) -> Uint8Array
   * `files` is [{ name: 'word/document.xml', text: '<?xml ...' }] or
   *         [{ name: ..., bytes: Uint8Array }]. `text` is encoded as UTF-8.
   * Names must use forward slashes and no leading slash (ZIP requires it, and Word
   * rejects an archive whose part names do not match its relationships).
   */
  function write(files) {
    if (!files || !files.length) throw new Error('BadgeZip.write: no files given.');

    var entries = [];
    var body = new Sink();
    var i;

    for (i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.name) throw new Error('BadgeZip.write: entry ' + i + ' has no name.');
      if (f.name.charAt(0) === '/' || f.name.indexOf('\\') !== -1) {
        throw new Error('BadgeZip.write: bad entry name "' + f.name +
          '" - use forward slashes and no leading slash.');
      }
      var data = f.bytes ? f.bytes : utf8(f.text || '');
      if (data.length > MAX_U32) {
        throw new Error('BadgeZip.write: "' + f.name + '" exceeds 4 GB; Zip64 is not implemented.');
      }
      var nameBytes = utf8(f.name);
      var sum = crc32(data);

      entries.push({
        nameBytes: nameBytes,
        crc: sum,
        size: data.length,
        offset: body.length
      });

      // ---- local file header (APPNOTE 4.3.7) ----
      body.u32(LOCAL_SIG);
      body.u16(VERSION_NEEDED);
      body.u16(0x0800);          // general purpose flags: bit 11 = names/comments are UTF-8
      body.u16(METHOD_STORE);
      body.u16(DOS_TIME);
      body.u16(DOS_DATE);
      body.u32(sum);
      body.u32(data.length);     // compressed size == uncompressed size when stored
      body.u32(data.length);
      body.u16(nameBytes.length);
      body.u16(0);               // extra field length
      body.bytes(nameBytes);
      body.bytes(data);
    }

    // ---- central directory (APPNOTE 4.3.12) ----
    var central = new Sink();
    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      central.u32(CENTRAL_SIG);
      central.u16(VERSION_NEEDED); // version made by
      central.u16(VERSION_NEEDED); // version needed
      central.u16(0x0800);
      central.u16(METHOD_STORE);
      central.u16(DOS_TIME);
      central.u16(DOS_DATE);
      central.u32(e.crc);
      central.u32(e.size);
      central.u32(e.size);
      central.u16(e.nameBytes.length);
      central.u16(0);              // extra
      central.u16(0);              // comment
      central.u16(0);              // disk number start
      central.u16(0);              // internal attributes
      central.u32(0);              // external attributes
      central.u32(e.offset);
      central.bytes(e.nameBytes);
    }

    if (body.length > MAX_U32 || body.length + central.length > MAX_U32) {
      throw new Error('BadgeZip.write: archive exceeds 4 GB; Zip64 is not implemented.');
    }

    // ---- end of central directory (APPNOTE 4.3.16) ----
    var end = new Sink();
    end.u32(EOCD_SIG);
    end.u16(0);                    // this disk
    end.u16(0);                    // disk with the central directory
    end.u16(entries.length);       // entries on this disk
    end.u16(entries.length);       // entries total
    end.u32(central.length);
    end.u32(body.length);          // offset of the central directory
    end.u16(0);                    // comment length

    var all = new Sink();
    all.bytes(body.concat());
    all.bytes(central.concat());
    all.bytes(end.concat());
    return all.concat();
  }

  window.BadgeZip = { write: write, crc32: crc32, utf8: utf8 };
})(typeof window !== 'undefined' ? window : globalThis);
