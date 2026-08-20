# Vendored dependency provenance

Both files in this directory are third-party code, copied in rather than fetched at
runtime. That is deliberate: the app has to work from `file://` with no network, so a
CDN or an `npm install` is not an option (see the "Classic scripts only" rule in
`CLAUDE.md`).

The cost of vendoring is that nothing records *what* was copied in. This file is that
record. **If you replace either file, update the fingerprint below in the same commit.**

## Files

| File | Bytes | SHA-256 |
|------|-------|---------|
| `pdf-lib.min.js` | 525,059 | `278627f3a5e3efa95e77ab565f10831d3cdb9cbb617ef8388d6ff4bf962d4887` |
| `pdf-lib-fontkit.min.js` | 758,440 | `d8df561b9fba98e24f2e5130e40948809281bbbc55a20c412359f1a0a5eb35a6` |

Verify the files on disk still match, from inside `site/`:

```bash
shasum -a 256 -c vendor/SHA256SUMS
```

## What they are

- **`pdf-lib.min.js`** — [`pdf-lib`](https://github.com/Hopding/pdf-lib), a pure-JS PDF
  writer. UMD build, exposes `window.PDFLib`. Carries an **Apache-2.0** licence URL in
  its banner comment.
- **`pdf-lib-fontkit.min.js`** — [`@pdf-lib/fontkit`](https://github.com/Hopding/fontkit),
  the font-subsetting engine `pdf-lib` needs to embed an arbitrary TTF. UMD build,
  exposes `window.fontkit`. Registered via `pdfDoc.registerFontkit()`.

## Version: NOT RECORDED

Neither minified bundle contains a version string, and no version was written down when
they were vendored, so **the exact releases are unknown**. This is the gap this file
exists to stop recurring — it is deliberately not guessed here.

To establish it, download a candidate release and compare against the table above:

```bash
npm pack pdf-lib@1.17.1 --pack-destination /tmp && tar -xzO -f /tmp/pdf-lib-1.17.1.tgz package/dist/pdf-lib.min.js | shasum -a 256
```

A matching hash identifies the release; record it here when it does.

## API surface this project actually depends on

Kept narrow on purpose — an upgrade only has to preserve these:

`PDFLib.PDFDocument` (`.create`, `.addPage`, `.embedFont`, `.registerFontkit`,
`.setTitle`, `.setSubject`, `.setCreator`, `.setProducer`, `.flush`, `.save`, `.context`),
`PDFLib.PDFName.of`, `PDFLib.PDFNumber.of`, and `page.drawText`.

One non-obvious dependency: `js/pdf.js` reaches into `pdfDoc.context` to write an
explicit `/DW` (default glyph width) into the embedded CID font dictionary, because
`pdf-lib` omits it and the PDF default of 1000 disagrees with Inter's real `.notdef`
advance. See `patchCidFontDefaultWidths()` in `js/pdf.js` and the `/DW` assertions in
`test/pdf.test.js`. **An upgrade must re-verify that patch still applies** — it depends
on `pdf-lib`'s internal object model, not its public API.

## Licences

`pdf-lib` is Apache-2.0. Inter (in `fonts/`, not here) is SIL OFL 1.1 with its full text
at `fonts/OFL.txt`. See the Licensing section of `README.md`.
