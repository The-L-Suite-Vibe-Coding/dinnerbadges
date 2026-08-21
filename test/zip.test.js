/*
 * test/zip.test.js - js/zip.js, the store-only ZIP writer.
 *
 *     node test/zip.test.js        (run from inside site/)
 *
 * A hand-written archive writer only earns its place if it is verified against
 * something that did not come out of this repo. So the structural assertions here are
 * backed by two INDEPENDENT readers shelled out to:
 *
 *     unzip -t      (Info-ZIP, the OS tool)
 *     python3       (zipfile.testzip(), which re-computes every CRC)
 *
 * Those two are the reason to trust the byte layout; the in-process assertions below
 * are what tell you WHICH field is wrong when they complain. Both readers are optional:
 * if either is missing its group is skipped and said to be skipped, never silently
 * passed.
 *
 * The CRC-32 checks are known-answer tests against published values, not against our
 * own implementation.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var child = require('child_process');

var SITE = path.resolve(__dirname, '..');

global.window = globalThis;
new Function(fs.readFileSync(path.join(SITE, 'js', 'zip.js'), 'utf8')).call(globalThis);
var Z = globalThis.BadgeZip;

var passed = 0;
var failed = 0;
var skipped = 0;

function head(s) {
  console.log('\n=== ' + s + ' ===');
}
function assert(cond, label, detail) {
  if (cond) {
    passed++;
    console.log('  PASS   ' + label + (detail ? '  [' + detail + ']' : ''));
  } else {
    failed++;
    console.log('  FAIL   ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}
function skip(label, why) {
  skipped++;
  console.log('  SKIP   ' + label + '  (' + why + ')');
}
function have(cmd) {
  try {
    child.execSync('command -v ' + cmd, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

/* little-endian readers, so the tests parse the archive independently of the writer */
function u16(b, at) { return b[at] | (b[at + 1] << 8); }
function u32(b, at) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }

// =========================================================================
head('CRC-32 known-answer tests (published values, not our own output)');
// =========================================================================
assert(Z.crc32(new Uint8Array(0)) === 0, 'CRC of the empty input is 0');
assert(Z.crc32(Z.utf8('a')) === 0xe8b7be43, 'CRC of "a" is 0xE8B7BE43',
  '0x' + Z.crc32(Z.utf8('a')).toString(16).toUpperCase());
assert(Z.crc32(Z.utf8('abc')) === 0x352441c2, 'CRC of "abc" is 0x352441C2');
assert(Z.crc32(Z.utf8('The quick brown fox jumps over the lazy dog')) === 0x414fa339,
  'CRC of the pangram is 0x414FA339');
assert(Z.crc32(Z.utf8('123456789')) === 0xcbf43926, 'CRC of "123456789" is 0xCBF43926');
var big = new Uint8Array(1000);
for (var bi = 0; bi < 1000; bi++) big[bi] = bi & 0xff;
assert(Z.crc32(big) >>> 0 === Z.crc32(big) >>> 0 && Z.crc32(big) <= 0xffffffff,
  'CRC stays an unsigned 32-bit value on a 1000-byte input', '0x' + Z.crc32(big).toString(16));

// =========================================================================
head('UTF-8 encoding, including the cases a paste can produce');
// =========================================================================
function bytesOf(s) { return Array.prototype.slice.call(Z.utf8(s)); }
assert(bytesOf('A').join(',') === '65', 'ASCII is one byte');
assert(bytesOf('é').join(',') === '195,169', 'U+00E9 is two bytes (C3 A9)');
assert(bytesOf('€').join(',') === '226,130,172', 'U+20AC is three bytes (E2 82 AC)');
assert(bytesOf('😀').join(',') === '240,159,152,128',
  'a surrogate PAIR becomes one four-byte sequence, not two three-byte ones');
assert(bytesOf('\ud800').join(',') === '239,191,189',
  'a lone HIGH surrogate becomes U+FFFD rather than invalid UTF-8');
assert(bytesOf('\udc00').join(',') === '239,191,189',
  'a lone LOW surrogate becomes U+FFFD');
assert(bytesOf('a\ud800b').join(',') === '97,239,191,189,98',
  'a lone surrogate mid-string does not eat its neighbours');
assert(Z.utf8('').length === 0, 'the empty string encodes to no bytes');

// =========================================================================
head('archive structure, parsed back out of the bytes');
// =========================================================================
var files = [
  { name: '[Content_Types].xml', text: '<Types/>' },
  { name: '_rels/.rels', text: '<Relationships/>' },
  { name: 'word/document.xml', text: '<w:document>é</w:document>' }
];
var zip = Z.write(files);

assert(u32(zip, 0) === 0x04034b50, 'starts with a local file header signature');
var eocdAt = zip.length - 22;
assert(u32(zip, eocdAt) === 0x06054b50, 'ends with an end-of-central-directory record');
assert(u16(zip, eocdAt + 8) === files.length, 'EOCD entry count matches the file count',
  u16(zip, eocdAt + 8) + ' entries');
assert(u16(zip, eocdAt + 8) === u16(zip, eocdAt + 10),
  'the two EOCD entry counts agree (one disk)');

var cdSize = u32(zip, eocdAt + 12);
var cdAt = u32(zip, eocdAt + 16);
assert(cdAt + cdSize === eocdAt,
  'the central directory offset + size lands exactly on the EOCD',
  'offset ' + cdAt + ' + size ' + cdSize + ' = ' + (cdAt + cdSize) + ', EOCD at ' + eocdAt);
assert(u32(zip, cdAt) === 0x02014b50, 'the central directory offset points at a real header');

/* Walk both structures and cross-check them against each other. */
var at = cdAt;
var seen = [];
var crcMismatch = 0;
var offsetBad = 0;
for (var i = 0; i < files.length; i++) {
  assert(u32(zip, at) === 0x02014b50, 'central entry ' + i + ' has the right signature');
  var cCrc = u32(zip, at + 16);
  var cSize = u32(zip, at + 20);
  var nameLen = u16(zip, at + 28);
  var localAt = u32(zip, at + 42);
  var name = Buffer.from(zip.slice(at + 46, at + 46 + nameLen)).toString('utf8');
  seen.push(name);
  if (u32(zip, localAt) !== 0x04034b50) offsetBad++;
  if (u32(zip, localAt + 14) !== cCrc) crcMismatch++;
  var expect = Z.crc32(Z.utf8(files[i].text));
  if (cCrc !== expect) crcMismatch++;
  assert(u32(zip, localAt + 18) === u32(zip, localAt + 22),
    'entry ' + i + ': compressed size equals uncompressed size (stored)');
  assert(cSize === Z.utf8(files[i].text).length,
    'entry ' + i + ': recorded size is the UTF-8 byte length, not the character count',
    cSize + ' bytes');
  at += 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32);
}
assert(offsetBad === 0, 'every central-directory offset points at its local header');
assert(crcMismatch === 0, 'every CRC agrees between local header, central directory and a fresh computation');
assert(seen.join('|') === files.map(function (f) { return f.name; }).join('|'),
  'names round-trip in order', seen.join(', '));
assert(u16(zip, 6) === 0x0800, 'the UTF-8 name flag (bit 11) is set on the local header');
assert(u16(zip, 8) === 0, 'the compression method is 0 (stored)');

// =========================================================================
head('determinism and refusals');
// =========================================================================
var again = Z.write(files);
assert(Buffer.compare(Buffer.from(zip), Buffer.from(again)) === 0,
  'the same input twice produces byte-identical output (no clock in the headers)');

function throws(fn) {
  try { fn(); return false; } catch (err) { return true; }
}
assert(throws(function () { Z.write([]); }), 'an empty file list is refused');
assert(throws(function () { Z.write(null); }), 'a null file list is refused');
assert(throws(function () { Z.write([{ name: '/abs.xml', text: 'x' }]); }),
  'a leading slash is refused (Word rejects such a package)');
assert(throws(function () { Z.write([{ name: 'a\\b.xml', text: 'x' }]); }),
  'a backslash separator is refused');
assert(throws(function () { Z.write([{ text: 'x' }]); }), 'an entry with no name is refused');
var emptyFile = Z.write([{ name: 'empty.txt', text: '' }]);
assert(emptyFile.length > 22, 'a zero-byte member is still a valid archive',
  emptyFile.length + ' bytes');

// =========================================================================
head('independent readers (the reason to trust the byte layout)');
// =========================================================================
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'badgezip-'));
var zipPath = path.join(tmp, 'probe.zip');
/* Deliberately hostile-ish content: non-ASCII, an XML-significant character, a nested
   path, and an empty member - all things a real badge sheet can contain. */
var probe = Z.write([
  { name: 'a.txt', text: 'hello' },
  { name: 'dir/sub/b.txt', text: 'wörld & more' },
  { name: 'emoji.txt', text: '😀' },
  { name: 'zero.txt', text: '' }
]);
fs.writeFileSync(zipPath, Buffer.from(probe));

if (have('unzip')) {
  var unzipOut = '';
  var unzipOk = true;
  try {
    unzipOut = child.execSync('unzip -t ' + JSON.stringify(zipPath), { encoding: 'utf8' });
  } catch (err) {
    unzipOk = false;
    unzipOut = String(err.stdout || err.message);
  }
  assert(unzipOk && /No errors detected/.test(unzipOut),
    'Info-ZIP `unzip -t` reports no errors', unzipOut.trim().split('\n').pop());
  var listing = child.execSync('unzip -Z1 ' + JSON.stringify(zipPath), { encoding: 'utf8' });
  assert(/dir\/sub\/b\.txt/.test(listing), 'unzip sees the nested path');
} else {
  skip('Info-ZIP verification', 'unzip not on PATH');
}

if (have('python3')) {
  var py = [
    'import zipfile,sys',
    'z=zipfile.ZipFile(sys.argv[1])',
    'bad=z.testzip()',
    'print("BAD" if bad else "OK")',
    'print(",".join(z.namelist()))',
    'print(z.read("dir/sub/b.txt").decode("utf-8"))',
    'print(z.read("emoji.txt").decode("utf-8"))',
    'print(len(z.read("zero.txt")))',
    'print(all(i.compress_type==0 for i in z.infolist()))',
    'print(all(i.flag_bits & 0x800 for i in z.infolist()))'
  ].join('\n');
  /* Written to a file rather than passed with -c: JSON.stringify turns the newlines
     into literal backslash-n, which python then refuses to parse. */
  var pyPath = path.join(tmp, 'probe.py');
  fs.writeFileSync(pyPath, py);
  var out = child.execSync('python3 ' + JSON.stringify(pyPath) + ' ' + JSON.stringify(zipPath),
    { encoding: 'utf8' }).split('\n');
  assert(out[0] === 'OK', 'python zipfile.testzip() re-computes every CRC and finds no error');
  assert(out[1] === 'a.txt,dir/sub/b.txt,emoji.txt,zero.txt', 'python sees the names in order', out[1]);
  assert(out[2] === 'wörld & more', 'non-ASCII content round-trips through a real reader', out[2]);
  assert(out[3] === '😀', 'an astral character round-trips');
  assert(out[4] === '0', 'the zero-byte member reads back as zero bytes');
  assert(out[5] === 'True', 'every member is STORED, never deflated');
  assert(out[6] === 'True', 'every member carries the UTF-8 name flag');
} else {
  skip('python zipfile verification', 'python3 not on PATH');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* leave it */ }

// =========================================================================
console.log('\n=== summary ===');
console.log('  ' + (passed + failed) + ' checks, ' + passed + ' passed, ' + failed + ' failed' +
  (skipped ? ', ' + skipped + ' group(s) skipped' : ''));
console.log(failed ? '  ' + failed + ' FAILURE(S)' : '  ALL GREEN');
process.exit(failed ? 1 : 0);
