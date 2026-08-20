# VERIFICATION

What was tested, the measured numbers, and every place we knowingly deviated from the
original brief. Written by the orchestrating agent; per-item work was built and then
adversarially re-tested by separate agents whose job was to break it, not confirm it.

Nothing in this repo has been pushed anywhere. See README for the push steps.

---

## 1. Where the layout numbers came from

The brief's font-size table was wrong and the sample `.docx` is the source of truth. The
`.docx` itself is **not** in this repo and is in no commit — it contains real attendee
names. It was read only to extract geometry.

`word/document.xml`, measured directly:

| Property | Raw value | Converted |
|---|---|---|
| `w:pgSz` | 12240 x 15840 twips | **612 x 792 pt** (US Letter) |
| `w:pgMar` | top/right/bottom/left all `0` | zero margins |
| `w:tblGrid` | 2 x `gridCol w:w="5760"` | **288 pt** per column |
| `w:trHeight` | `hRule="exact" w:val="4320"` x 3 | **216 pt** per row |
| `w:tcW` | 5760 dxa, `tblLayout fixed` | fixed 288 pt cells |
| `w:vAlign` / `w:jc` | `center` / `center` | centred both ways |
| `w:tblCellMar` | left/right `15` twips | 0.75 pt (we use 14.4 pt instead — see 6.1) |

`w:sz` is in **half-points**. The brief halved these a second time, making every size half
what the sample actually uses. Julia confirmed: use the `.docx` values.

| Line | `w:sz` | Actual | Weight / style |
|---|---|---|---|
| First name | 72 | **36 pt** | bold 700 |
| Last name | 52 | **26 pt** | regular 400 |
| *gap* | 16 | **8 pt** | empty line |
| Company | 42 | **21 pt** | **italic 400** |
| Title | 38 | **19 pt** | regular 400 |

The company line being **italic** was also missing from the brief. Confirmed two ways:
`<w:i/>` is present on the company run in all three badges, and the sample's own rendered
PDF embeds three faces — `Arial-BoldMT`, `ArialMT`, **`Arial-ItalicMT`**.

Independent confirmation of the sizes: rendered line ink heights measured 40.18 / 29.02 /
23.44 / 21.20 pt = 1.1161 x 36 / 26 / 21 / 19.

### Line advance model
`advance(size) = 1.1499 x size`, which is Arial's `(ascender + descender + lineGap) / upem
= (1854 + 434 + 67) / 2048`. Verified against the sample's own rendered line tops:

| | line 1 | line 2 | line 3 | line 4 | line 5 |
|---|---|---|---|---|---|
| measured | 0 | 41.40 | 80.48 | 104.64 | 126.54 |
| predicted | 0 | 41.40 | 80.50 | 104.65 | 126.50 |

**Max error 0.04 pt.** We keep Arial's 1.1499 factor with Inter glyphs so the vertical
rhythm matches the sample; Inter's own hhea factor is 1.2100 and would drift ~5%.

---

## 2. Sample vs. our output — the side-by-side (criterion 9)

Both rendered to PNG at 150 dpi (1275 x 1650 px = 8.5 x 11 in). Compared like-for-like,
using a 5-line badge in both cases; ours used invented names (`Corin` / `Blackwood` /
`ACM Power Corporation` / `Director, Assistant General Counsel`).

| Step | Sample | Ours | Delta |
|---|---|---|---|
| first -> last | 41.40 | 41.40 | **0.00** |
| last -> company (incl. 8 pt gap) | 39.08 | 39.09 | **0.01** |
| company -> title line 1 | 24.16 | 24.15 | **0.01** |
| title line 1 -> line 2 | 21.90 | 21.85 | **0.05** |
| horizontal centring error | +/-0.11 | **+0.00** | — |
| block ink height | 147.74 | 149.48 | +1.74 |

The 1.74 pt height difference is fully accounted for by the intentional Arial -> Inter
substitution: Inter's ink box is 1.2100 em against Arial's 1.1161 em, which is +1.79 pt on
a 19 pt line by itself. Wrap points are identical ("Director, Assistant General /
Counsel"; "Regulatory Affairs & / Commercial Counsel"). Visual comparison confirms the same
grid, hierarchy, italic company line and wrap behaviour.

The composite image is **not** committed — it contains the sample's real names.

---

## 3. Sheet layout presets (Avery research)

Julia asked for a toggle to a standard Avery 74536 layout. Guessing template margins would
misalign every badge, so this was researched.

Avery publishes 3" x 4", 6 per sheet, US Letter, but **no margins**, and states one
template covers 5384 / 5392 / 5393 / 74459 / **74536** / 74540 / 74541 / 78617 / 78619.
Authoritative numbers came from LibreOffice's bundled Avery label database
(`labels.xml`, format `S;hdist;vdist;width;height;left;upper;cols;rows;pwidth;pheight` in
1/100 mm). **The parser was validated first against Avery 5160**, which decodes to
2.625" x 1", 3 x 10 — matching its published spec — and only then were the badge entries
trusted. Entries `5384`, `5392`, `74540`, `74541` are byte-identical:

```
cell 4.0000in x 3.0000in = 288 x 216 pt      grid 2 x 3, pitch 288 / 216, no gutters
left margin 0.2500in = 18 pt                 top margin 1.0000in = 72 pt
page 612 x 792 pt                            leftover right 18 pt, bottom 72 pt (centred)
```
18 + 576 + 18 = 612 exactly; 72 + 648 + 72 = 792 exactly.

So the two presets differ **only by grid origin**:

| Preset | Origin | Unprinted area |
|---|---|---|
| `sampleTopLeft` (default, matches the `.docx`) | (0, 0) | right 36 pt, bottom 144 pt |
| `avery` | (18, 72) | 18 pt left+right, 72 pt top+bottom |

**A wrong inference, corrected — recorded because it reached the README before it was
caught.** From the Avery template geometry I inferred that the sample layout misprints:
the `.docx` does have all four page margins set to zero (verified), so its grid is pinned to
the top-left rather than centred like Avery's published template, and I concluded badges
must therefore land 0.25" left and 1" high of the die-cut cards. I wrote that into this file
and the README as fact, and recommended switching.

**That conclusion was wrong.** Julia confirmed the top-left position is correct for the badge
stock actually in use. The Avery numbers are accurate as the geometry of Avery's own
template; what did not follow is that her paper matches it. `sampleTopLeft` is the correct
default and stays the default; `avery` is offered as an alternative for stock that expects
the centred position, with no implication that either is a mistake. The README wording has
been corrected too.

Worth keeping as a lesson: a verified measurement (Avery's template) plus an unverified
assumption (that her stock is that template) produced a confident, wrong, user-facing
recommendation. The measurement was never the problem.

---

## 4. Headless / programmatic results (measured by the orchestrator, not self-reported)

PDFs generated from the committed fixtures by loading the SHIPPED `js/*.js`, `fonts/*.js`
and `vendor/*.js` into a node VM sandbox (no modifications), then measured with poppler
(`pdftotext -bbox`, `pdffonts`, `pdfinfo`) and rendered with `pdftoppm`.

| Criterion | Requirement | Measured |
|---|---|---|
| Page box | exactly 612 x 792 pt | **612.00 x 792.00** on every page of every fixture |
| Cell origins | (0,0) (288,0) (0,216) (288,216) (0,432) (288,432) within 1 pt | **exact** — all six cells show identical cell-relative extents |
| Cell containment | every run inside its own 288 x 216 cell | **0 violations** |
| Horizontal centring | each line's centre within 1 pt of cell centre | **+0.00 pt on all 24 lines** — but this criterion now applies to the `center` option only; see 5.3 and the note below |
| Vertical centring | block centred within 2 pt | **+/-1.03 pt** by visible ink; **-3.08 pt** by font box — see the note below |
| Right 36 pt column | nothing rendered | max ink x = **559.38** |
| Bottom 144 pt band | nothing rendered | max ink y = **600.74** |
| 14-attendee fixture | exactly 3 pages, 6 / 6 / 2 | **3 pages, [6, 6, 2]** |
| Stress fixture | inside cell, sizes within max/floor | x[16.08, 271.92] y[23.46, 185.99]; sizes **36 / 22.5 / 21 / 16** (maxima 36/26/21/19, floors 22/16/13/12) |
| Inset width | lines <= 259.2 pt | widest line **255.84** |
| Embedded fonts | Inter present, no fallback | **Inter-Bold / Inter-Regular / Inter-Italic** only; no Helvetica, no Arial, on all fixtures |
| `fonts/` contents | Inter files + OFL | 3 TTF, 3 woff2, real `OFL.txt` (SIL OFL 1.1, 92 lines) |

### The one criterion that does not pass under both measures — stated plainly
"Vertically centred within +/-2 pt" depends on what you measure, and after the switch to
optical centring the two available measures disagree:

| Measure | Error | vs +/-2 pt |
|---|---|---|
| **visible ink** (cap line to descender — what a person actually sees) | **+/-1.03 pt** | passes |
| **font box** (ascent-to-descent, what `pdftotext -bbox` reports) | **-3.08 pt** | **fails** |

These cannot both be satisfied. Satisfying the font-box measure requires shifting the block
down by at least 1.08 pt; satisfying the ink measure requires shifting by at most 0.97 pt.
No single position does both, because Inter's hhea ascent (0.96875 em) sits far above its cap
height (0.7275 em), so the font box is not symmetric around the ink it contains.

Julia was shown this trade-off explicitly and chose optical centring, on the grounds that
badges are cut apart and viewed individually so "looks centred" is the real requirement.
Before the change, the font box measured +0.57 pt and the ink measured +3.95 to +4.67 pt low.
We therefore report this criterion as **passing on the measure that reflects the printed
result, and failing on the font-box measure, by explicit choice**. Reverting is a one-constant
change (drop the optical shift in `js/layout.js`) if that judgement is ever revisited.

The stress fixture is `Bartholomew` / `Vandergriff-Castellanos` / `Executive Vice President,
General Counsel & Corporate Secretary` / `Bristol-Myers Squibb Holdings International`.
Independent cross-check of the shrink logic: real Inter gives `Vandergriff-Castellanos` a
width of 294.85 pt at 26 pt, over the 259.2 box, so it must shrink to
259.2/294.85 x 26 = 22.86 -> **22.5 pt** on the 0.5 pt grid. The engine independently
reported 22.5.

### Network isolation (criterion 6)
`grep -rniE 'https?://|fonts\.googleapis|cdn|fetch\(|XMLHttpRequest|WebSocket|sendBeacon'`
over `site/` returns 34 hits, **none of them a runtime network reference**:

| Source | Hits | What they are |
|---|---|---|
| `fonts/inter-fontdata.js` | 13 | the string `cdn` appearing by coincidence inside base64 TTF payloads (`CDn`, `cDN`, `Cdn`...), confirmed by extracting only the matched substrings |
| `fonts/inter-face.css` | 3 lines | same coincidence inside base64 woff2 payloads; every `src:` is a `data:` URI |
| `fonts/OFL.txt` | 2 | the SIL OFL's own attribution URLs |
| `vendor/pdf-lib.min.js` | 2 | Apache-2.0 licence URL in a comment, plus a coincidental `cdn` |
| `vendor/pdf-lib-fontkit.min.js` | 1 | an iconv-lite doc URL inside a warning *string* |
| `js/preview.js` | 2 | a comment, and `SVG_NS = 'http://www.w3.org/2000/svg'` — an XML namespace identifier, never fetched |
| `js/store.js`, `js/pdf.js` | 2 | comments explaining that these APIs are not used |
| `test/*.test.js` | 11 | the tests' own regex literals asserting these APIs are absent |

Independently confirmed the vendored libraries contain **zero** occurrences of `fetch(`,
`XMLHttpRequest`, `WebSocket` or `sendBeacon` — so even as third-party minified code they
have no network code path at all.

### A second criterion superseded by a later decision — stated plainly
The original criteria require each line's horizontal centre to match its cell centre within
+/-1 pt. Julia later asked for badge text to be **left-aligned by default**, with centring as
an option (section 5.3). Under the shipped default that criterion is therefore false by
design: every line sits flush at x = 14.4 instead.

This is a requirement change on the user's explicit instruction, not a regression, and it is
verified in both directions rather than quietly dropped:
- `align:'center'` — the original centring assertion is retained and passes (+0.00 pt).
- `align:'left'` — every line's x is exactly 14.4 and every right edge is at or before
  273.6, measured from real exported PDFs across both sheet presets.
- The fit engine additionally asserts that line centres are **not** at 144 under `left`, so
  the changed default cannot later be mistaken for a centring bug.

### The defect that only rasterising could find
`pdftotext`-based geometry tests were blind to this one, and it is worth recording because
it shows why the verification used more than one instrument.

pdf-lib builds a subset font's `/W` (glyph widths) array only from the glyphs actually in
the subset, and glyph 0 (`.notdef`) never is — so the embedded CID fonts shipped with an
empty `/W` and **no `/DW`** (default width). At render time every `.notdef` glyph therefore
advanced at the PDF default of 1000/1000 em, while `InterMetrics` and pdf-lib's own
`widthOfTextAtSize` both reported Inter's real notdef advance of 1344/2048 = 0.65625 em.
Expansion factor **1.5238**.

Consequence: any codepoint Inter does not map (CJK, Arabic, Devanagari, emoji) rendered
1.52x wider than the engine believed, and escaped its cell — 11 such characters in a company
field pushed ink 2.16 pt past the 288 pt edge, 19 pushed it 108.7 pt into the neighbouring
badge, and six such attendees put ink at x = 611.64 on a 612 pt page. `pdftotext` reports
zero words for notdef ink, so every bbox-based check passed while the raster was wrong. The
preview used the same metrics, so it looked correct while the print overflowed — precisely
the divergence the shared-fit-engine design exists to prevent.

Fixed by writing an explicit `/DW` on each embedded CID font. Verified after the fix:

```
/DW values in the embedded fonts: [656]          (= 1344/2048 x 1000)
repro: first 'Kenji', last 'Watanabe', company = 11 x U+5B57, title 'Legal Counsel'
rasterised ink at 200 dpi: x 69.84..218.52 pt, y 48.24..167.76 pt
cell 0..288 x 0..216 -> INSIDE, right-edge headroom +69.48 pt   (was x..290.16, OVERFLOW)
```

Julia has since confirmed only the 26 English letters plus accented Latin are needed, so
rendering CJK was never a requirement — but the guard stays, because a single character
pasted from a spreadsheet should not be able to push text into the next badge.

### Data hygiene
No `.docx`/`.doc`/`.xlsx`/`.pdf` anywhere under `site/`. The only committed CSV is
`test/fixtures/import-sample.csv` (invented names). Scanned every text file for the sample's
real surnames and employers: zero hits (the sole apparent match was `Hungarumlautsmall`, a
standard PostScript glyph name inside fontkit). `.gitignore` ignores `*.docx`/`*.doc`/`*.csv`/
`*.xlsx` by default and re-includes only the named fixtures — verified in a throwaway repo
that `test/fixtures/deep/deeper.csv`, `nested.xlsx` and `badge.pdf` all stay ignored.

---

## 5. The two added features, verified end to end

Both were requested mid-build and both were **off by default at the time this section was
written**, so every number in section 4 is unaffected until they are switched on. The logo
reserve default was later flipped to **on** — see section 9.1; the geometry described below
is unchanged, only which state you get without touching anything.

### 5.1 Bottom-right logo reserve
Keeps a rectangle in each badge's bottom-right corner clear, so text cannot print over a
logo already on the stock. Global setting, per badge geometry, **1 x 1 in** (72 x 72 pt),
adjustable 0-4 in, persisted in `localStorage`. Default was off when this was built and is
**on** as of 2026-08-20 (section 9.1).

Reserved region is cell-relative from the raw cell edge: `x` from `288 - wPt` to 288, `y`
from `216 - hPt` to 216. A line whose vertical box intersects the reserved band gets width
`288 - wPt - 14.4` and is recentred in the remaining span; other lines are unaffected.
With a 1 in block that puts affected lines at centre **115.2** instead of 144 — i.e. 28.8 pt
left of the name lines. That asymmetry is the explicitly chosen behaviour ("narrow and
recentre only the affected lines" rather than shifting the whole block).

Because the affected set depends on vertical position, which depends on the sizes, which
depend on available width, the fit iterates to a fixed point. Convergence measured over
**4,144 reserve geometries** (w 0-288 x h 0-216 in 8 pt steps x 4 fixtures) plus 121 band
positions straddling a wrap boundary: **max 4 passes, zero violations**.

Orchestrator's independent check: 209 emitted lines across 5 reserve geometries x 8
fixtures, 106 of them vertically level with the reserve — **0 intrusions, 0 cell
violations**. Verified again in a real exported PDF measured with `pdftotext -bbox`: 0
intrusions under both sheet presets. The reserve is drawn in the preview as a screen-only
guide and **nothing is drawn for it in the PDF** — it is a keep-out region, not a box.

Edge case, documented: a reserve large enough to cover the whole cell (e.g. 4 x 4 in)
yields `fits:false` with explanatory warnings and prints nothing, rather than printing into
the reserved area. A badge maxed out that way comes out blank.

### 5.2 Sheet layout preset
`sampleTopLeft` (default) vs `avery`. See section 3 for the researched geometry. Confirmed a
pure sheet-level translation: `layout()` never receives the preset, its arity is unchanged,
and its output is byte-identical under both presets — so no sheet coordinate leaks into cell
math.

Orchestrator's independent verification of the origins:

| Preset | Six cell origins | Block | Leftover |
|---|---|---|---|
| `sampleTopLeft` | (0,0) (288,0) (0,216) (288,216) (0,432) (288,432) | 0..576 x 0..648 | R 36, B 144 |
| `avery` | (18,72) (306,72) (18,288) (306,288) (18,504) (306,504) | 18..594 x 72..720 | L/R 18, T/B 72 |

Unknown, `null` and omitted preset keys all fall back to the default without throwing.
Measured in a real exported PDF under `avery`: min x 54.85, max x 577.38, min y 113.11,
max y 672.74 — all inside the 18/594/72/720 bounds, 6 distinct cells, every run inside its
own cell.

### 5.3 Text alignment — LEFT by default, CENTER optional (changes a default)
Julia asked for badge text to be left-aligned by default with centring as an option. All
four lines flush to a common left edge; sheet-wide setting, persisted.

`opts.align` is `'left' | 'center'`, default **`'left'`**, carried in the same options object
as `logo` (no extra parameter).

`left` went through two rounds on Julia's feedback. It first pinned every line to
`x = INSET` (14.4 pt); she asked that the lines still share a left edge but that "the whole
thing should sit closer to the center". So the shipped rule is a **centred block with
left-aligned text**:
```
blockWidth = max(lineWidth) over emitted lines with text
x (all lines) = span.lo + (spanWidth - blockWidth) / 2      // span = [INSET, CELL_W - logoWpt]
```
clamped so `x >= INSET`. It degenerates to the inset only when the widest line fills the
span. Under `center` each line is centred individually — the previous behaviour.

Measured per-line x for a normal fixture (sizes 36/26/21/19 in both cases):

| line | `left` (new default) | `center` |
|---|---|---|
| first | **43.563** | 46.626 |
| last | **43.563** | 86.230 |
| company | **43.563** | 43.563 |
| title | **43.563** | 69.619 |

One shared left edge of 43.563 = `14.4 + (259.2 - 200.874)/2`, where 200.874 is that
badge's widest line. Because each badge centres on **its own** widest line, the six badges of
a full sheet land on six different edges — measured 16.622, 22.958, 34.671, 36.847, 43.563,
59.233 pt, a 42.6 pt spread. Julia reviewed that on a rendered sheet and approved it: each
badge is balanced in itself, which is what matters once they are cut apart and worn
individually. (A sheet-uniform edge was offered and declined; it would have required a
two-pass design, since `layout()` is deliberately per-attendee and knows nothing of the
others.)

**Alignment changes only x — never sizing or wrapping.** Asserted across **256
combinations** (13 fixtures x 4 override sets x 4 reserve geometries) comparing
`appliedSizes`, `blockHeight`, `opticalShift`, `fits`, `warnings` and every per-line field:
**zero divergence**. This is structural rather than lucky — both alignments share one span
`[INSET, CELL_W - wPt]`, so the available width driving every wrap and shrink decision is
identical; alignment only picks `x` from the span's low edge versus its centre.

Interaction with the logo reserve under `left` — measured, and worth knowing because it is
a visible consequence that surprises people: the block is centred within **one span**, and
that span is the tightest any inked line is subject to. So if *any* line is level with the
reserve, the **whole block** recentres, moving all four lines together:

| fixture | reserve off | reserve on (1x1 in) | shift |
|---|---|---|---|
| short text (widest line 169.53) | x = 59.23 | x = **30.43** | -28.80 |
| long text (widest line 200.87) | x = 43.56 | x = **14.76** | -28.80 |

In both cases only the *title* was actually level with the reserve, yet everything moved.
That is forced by the requirement that all four lines share one left edge — narrowing only
the affected line would necessarily give it a different left edge. The practical effect is
that switching the logo reserve on pushes all the text noticeably left, and with a 1 in
reserve plus a wide company line the block ends up almost flush against the 14.4 pt inset
(14.76). Under `center`, by contrast, only the affected lines move (to 115.2), which is why
that case looks like one or two lines drifting away from the names.

The older behaviour, before Julia's revision, kept the affected line's x fixed (to 201.6 pt for a 1 in block) — no sideways shift. Under
`center` it narrows *and* recentres onto 115.2. The keep-out invariant holds identically
under both; measured worst ink-to-reserve gap **32.40 pt** under `left` and **16.56 pt**
under `center`.

Orchestrator's independent verification in a real exported PDF — cell-relative left edges
across all 24 runs of a full sheet:

| Export | Cell-relative left edges | |
|---|---|---|
| `left` | 16.622 / 22.958 / 34.671 / 36.847 / 43.563 / 59.233 | **one per badge**, each its own centred-block position |
| `center` | many per badge | each line centred individually |

The PDF item re-derives the expected edge from the engine's own returned line widths rather
than hardcoding it, and measures a worst deviation of **4.22e-7 pt** — under both sheet
presets, which must match since the preset only translates the grid. The degenerate case is
covered too: the stress fixture's widest line is 255.836 pt in a 259.200 pt span, giving
**16.082**, close to the inset without crossing it.

Fallback matrix: omitted, `null`, `undefined`, `'LEFT'`, `'justify'`, `'Center'`, `'right'`,
`''`, `42`, an object, an array, `true`, `NaN` — all resolve to `'left'` without throwing.
Deliberately not case-normalised: only the exact strings in `BadgeSpec.ALIGNS` are honoured.

On-screen the same holds: under `left` every line of a badge shares one x (verified in a real
browser: cell 0 at 32.20 for a widest line of 223.6, cell 1 at 15.88 for 256.23 — each
matching the formula), and under `center` every line centres on 144 within **0.02 pt**. A dedicated leak test compares whole line objects
between the two modes with the x-carrying fields removed: **0 differences** in text,
baselines, sizes, weights, styles, lineTops or advances, while x moved on 30 of 30 lines.

Mutation-covered on the PDF side: dropping `align` from the layout call fails 56 assertions,
and hard-coding `left` while `center` was requested fails 49 — that second one is the
silent preview/print divergence case, and it now fails two independent ways.

### 5.3b The keep-out hole that a per-glyph test found
Recorded because it shows the difference between a test that restates the code and one that
measures the artefact.

The engine decided "is this line level with the logo reserve" from the line's **advance box**
`[lineTop, lineTop + advance]`. Descender ink hangs below that box, so a line could clear the
band by less than its descender depth, not be narrowed, and run past the reserve's left edge
with ~0.2 pt of descender ink inside the reserved corner. Measured on the six-badge fixture
with a 1 in reserve (band top y = 144):

```
company line advance box bottom = 143.451   -> clears the band -> NOT narrowed -> runs to x 215.64
company line ink bottom         = 144.179   -> 0.179 pt INSIDE the band
```

**This was a live bug, not a theoretical one — and the orchestrator initially mis-called it.**
The fixture that surfaced it did not itself intrude (its only descender sat left of the
rectangle), so it was first characterised as a reachable-in-principle 0.2 pt edge case worth
fixing on principle. Running the old and new engines side by side across **5,180
fixture/geometry pairs** with a per-glyph check settled it:

| | per-glyph violations |
|---|---|
| before the fix | **26** |
| after the fix | **0** |

Concrete instances: `NORMAL` at a 112x72 reserve put the `y` of *Analytics* at x 168.4-180.2
across the reserve edge at x0 = 176, ink bottom 144.179 against a band top of 144; a
descender-dense fixture at 56x128 and at 120x24 did the same with `y` and `g`. So the
invariant was actually being broken in configurations a user could select, not merely in a
constructed one. The lesson recorded: "reachable in principle" deserved measurement before
being downgraded to negligible, and the measurement was cheap.

Fix: the band test now compares against the line's ink extent,
`baseline + descenderDepthPt(size)`, using the **full** descender depth — optical centring
wants the expected extent, but a keep-out needs the worst case. Both numbers are documented
in place so nobody later "simplifies" them into one.

**What visibly moved.** Of the 5,180 geometries, 79 changed: 64 applied-size changes, 50
`blockLeft` changes, 12 wrap-only. The one worth knowing is the **default 1x1 in reserve**:
the normal fixture's company line used to clear the band by 0.5494 pt and now counts as
level, so under `center` its line centre moves **144 -> 115.2** (per-line centres become
first 144, last 144, company 115.2, title 115.2). Sizes and wrapping are unchanged there —
200.874 pt still fits the 201.6 pt narrowed span — so it is purely a horizontal shift, but it
is visible and it affects the most likely real configuration. Larger reserves shift more: at
112x72 the normal company wraps to `Northwind` / `Analytics`, and the tightest corners drop
first 36 -> 22 or company 21 -> 13. None of this touches the shipped defaults, where the
reserve is off.

Orchestrator's independent re-verification after the fix — a **per-glyph** sweep rather than a
line-box one, walking each character's advance and applying descender depth only to
characters that actually have one (`g j p q y`):

```
16 reserve geometries (w,h in {36,72,108,144}) x 2 alignments x 6 fixtures
9,828 glyphs checked      worst intrusion into the reserve: NONE
```

The engine's own suite gained a regression section for this (`21. RESERVE KEEP-OUT USES INK,
NOT THE ADVANCE BOX`) which does three things worth noting: it proves the mechanism in em
units (advance box 0.18115 em below the baseline versus descender ink 0.21582 em), it
reproduces the near-miss line and asserts the engine now narrows it, and it builds a
**counterfactual** showing the old rule really would have put descender ink in the reserve —
so the test proves the bug existed rather than merely asserting the fix. It also sweeps band
positions x alignments and then asserts the sweep **actually hit the near-miss window** a
non-zero number of times, guarding against a sweep that passes vacuously.

Two lessons kept on the record. The preview item's original keep-out test used the line
bounding box and produced a **false alarm** — its padded em box reached 28.4 pt past the
reserve edge while no actual glyph came near. Rewriting it per-glyph made it simultaneously
stricter (it found the real 0.179 pt case) and more honest (it stopped flagging the phantom
one). And the real defect was invisible to every advance-width-based test in the project,
including the orchestrator's; it took measuring glyph ink to see it.

### 5.4 Company-to-Title spacing
Julia asked for the space between the Company and Title lines to be doubled, then judged the
result too wide and asked for the halfway point. Both are one constant,
`BadgeSpec.GAP_TITLE_SIZE`, emitted as a gap line only when both a company and a title line
exist:

| Setting | `GAP_TITLE_SIZE` | Company->Title baseline separation | `blockHeight` |
|---|---|---|---|
| original | 0 (no gap line) | 22.21036 pt | 126.489 |
| doubled | 8 | 31.40996 pt | 135.688 |
| **shipped** | **4** | **26.81016 pt** | **131.089** |

Halfway is exact rather than approximate: `(22.21036 + 31.40996) / 2 = 26.81016`, and
`22.21036 + 1.1499 x 4 = 26.81016`. The test asserts this **symbolically**
(`gapNow === (gapBefore + gapAt8) / 2`) rather than against a rounded literal, so it cannot
drift. Approved by Julia on a rendered sheet.

Tunability is proven mechanically rather than asserted: one test patches only that single
number in a sandboxed copy of `spec.js` and checks the gap scales by exactly
`1.1499 x delta`. `layout.js` references the constant in exactly two places and hardcodes no
number.

**Ceiling on this constant, worth knowing before anyone raises it:** as written, headroom
below the 187.2 pt text box was 10.1 pt (worst observed block 177.085), and above roughly
**12.8 pt** the vertical shrink guard went live and started paying for the extra spacing by
shrinking the title — at 24 pt the stress fixture's title dropped from 16 to 15 pt. That
path is tested, so a larger value degrades gracefully rather than overflowing.

**Superseded on 2026-08-20 by the third title line (section 9.2):** there is no permanent
headroom any more. The worst case is 198.93 pt against 187.2, so the shrink guard is a live
part of normal operation rather than a dormant backstop, and the trade above is now made on
every badge that fills all three title lines, not only past a 12.8 pt gap.

The separation is `advance(company) + advance(gap) + ascent(title) - ascent(company)` — the
ascent difference between the 21 pt company and 19 pt title belongs in it because these are
baselines, not line tops. The PDF item initially derived it from the advances alone, got
33.347 against a measured 31.410, and correctly trusted the measurement over its formula.

The gap is included in the optical vertical centring, so the block stays centred as it grows;
the residual ink-centring error is unchanged at **+1.025 pt**. Three of the four downstream
suites now read the constant from `BadgeSpec` rather than hardcoding it, so future tuning
does not churn the tests.

---

## 7. Headed / real-browser results

Driven in a real browser against `site/` served from a local static server, with the app's
own UI (no test harness substituting for it). Numbers below are measured from the live DOM.

| Check | Result |
|---|---|
| Add one attendee via the four fields | works; row stored and rendered |
| Paste a 5-row block | 5 added; a quoted title containing **both** a comma and an ampersand (`"Counsel, Privacy & Data"`) survived intact |
| Import a 4-column CSV | 4 imported with **scrambled column order** (`Job Title, Organization, First_Name, LAST-NAME`), a UTF-8 BOM, CRLF line endings, and a quoted comma inside a company name (`"Granite Peak Foods, Inc."`) |
| Preview shows a 2 x 3 top-left grid | 6 badge SVGs on sheet 1; nav reads "Page 1 of 2 · 10 attendees · 6 on this page" |
| Per-badge override changes the preview | first name **36 -> 35 pt** after two "Smaller" clicks; x recentred 49.93 -> 52.54; **neighbouring badge unchanged at 36**; override persisted |
| Export produces a PDF | blob `application/pdf`, **25,370 bytes**, magic `%PDF-1.7`; object URL created once and **revoked once** |
| Logo reserve toggle | screen guides 0 -> **6**; company x 53.93 -> 25.13 and title x 63.69 -> 34.89 (**-28.80 pt each**); name lines unchanged |
| Sheet preset toggle | `data-sheet-preset="avery"`, cell 0 offset **22.5 px = 18 pt x 1.25 scale**; cell-relative text x values **unchanged**, confirming a pure sheet translation |
| Persistence across a restart | the 10 attendees entered by three different routes survived a full **browser restart** (not merely a reload) and were read back from `localStorage` |
| Clear all data | two-step confirm (first click re-labels to "Erase everything — click again to confirm" and changes nothing); after confirming, **all five `lsuite.badges.*` keys removed**, 0 attendees, 0 overrides, logo and preset back to defaults (which since 2026-08-20 means the reserve comes back **on**, not off), one empty sheet, "No attendees yet." |
| Zero outbound network | see below |
| Laptop layout | see below |

### Zero network (criterion 11) — two independent instruments
1. **The server's own access log** for the whole session records exactly 16 requests: the 14
   expected local files, `index.html`, and a browser-initiated `favicon.ico` (404). **No
   font file was ever requested** — the three woff2 faces load from `data:` URIs — and there
   is no request to any external host.
2. **In-page interception** of `fetch`, `XMLHttpRequest.open`, `WebSocket`, `navigator.sendBeacon`
   and `Image.src`, then a full flow (add attendee -> override -> export PDF -> page
   navigation): **zero outbound attempts**, and `document.cookie` empty.

### Laptop layout (criterion 13)
| Viewport | Preview column | Side panel | Overlap | Document h-scroll | Panel child overflow |
|---|---|---|---|---|---|
| 1280 x 800 | x 0, w 920 | x 920, w 360 | **0 px** | **no** | **0 px** |
| 1440 x 900 | x 0, w 1080 | x 1080, w 360 | **0 px** | **no** | **0 px** |
The panel scrolls itself rather than pushing the layout, and the sheet stays visible at both
sizes.

### `file://` (criterion 12)
Verified with real headless Chrome at an actual `file:///...` URL, driven over the DevTools
Protocol — **by the independent per-item testers, not by the orchestrator**. The
orchestrator's own attempts are recorded honestly: driving `file://` through the in-app
preview pane is invalid (it rewrites out-of-project `file://` pages into a `data:` snapshot,
which strips relative script paths and would give a false pass), and a plain
`--headless=new --dump-dom` invocation hung on this page's size. A `--screenshot` run at the
same `file://` URL did succeed, giving a first-hand orchestrator result: the app **loads and
renders completely** from `file:///` — the 8.5 x 11 sheet with all six cell guides in a 2 x 3
top-left grid, the right strip and bottom band empty, and the full side panel (add form,
paste box, CSV import, attendee list, font-size override, sheet settings). With storage
cleared there are no attendees, so that shot demonstrates boot, CSS, panel and grid rather
than glyph rendering; the font half is the testers' evidence below. The orchestrator also
verified first-hand the code properties that make `file://` work at all: zero
`type="module"` scripts, zero `fetch`/XHR in any code path, all asset paths relative, all
three fonts inlined as `data:` URIs, and CSV reading via `FileReader`.

Confirmed by the testers at a genuine `file://` origin: the page loads with **zero
uncaught exceptions**; `document.fonts.status = loaded` with all three Inter faces present,
and canvas `measureText` agreeing with `InterMetrics.widthOf` to **0.0000 pt** at 400, 700
and italic (a fallback font could not produce three exact zeroes); CSV import works through
`FileReader` with zero network requests, checked without
`--allow-file-access-from-files`; and the preview renders 6 cells with exact coordinates,
including with both new features enabled.

Caveat stated in the README: `localStorage` on `file://` is browser-dependent — Chrome and
Firefox generally allow it, Safari is stricter. The store degrades to in-memory with a
console warning, so the app still works but may not remember the list; serving locally is
the recommended path if that happens.

### Known cosmetic issue, not fixed
After **Clear all data**, the add-form's transient confirmation (`Added <name>.`) remains on
screen until the next reload. `localStorage` is genuinely empty at that point, no form field
retains a name, and a reload shows a completely clean state (verified: 0 keys, 0 attendees,
no name anywhere in the DOM). But the status line says "Nothing is saved in this browser"
while a name is still visible, which is a poor look for a privacy control that may well be
clicked just before handing the laptop to someone. The fix is small and local — clear the
three report containers (`#entry-form`, `#bulk-paste`, `#csv-import`) whenever the attendee
list becomes empty, which would also cover deleting the last row by hand. Recorded rather
than fixed because the owning agent was cancelled and the issue is transient.

---

## 8. Test suite and delivery

### The committed suites
Six plain `node` scripts under `test/`, each exiting non-zero on failure. Run them with
`node test/<name>.test.js`. Files NOT matching `*.test.js` (e.g. `preview.browser.js`) are
browser-only and must be loaded in a page.

| Suite | Checks |
|---|---|
| `test/input.test.js` | 214 |
| `test/layout.test.js` | 292 |
| `test/overrides.test.js` | 625 |
| `test/pdf.test.js` | 584 |
| `test/preview.test.js` | 27,242 |
| `test/store.test.js` | 533 |
| **Total** | **29,490** |

Plus browser-only suites not counted above (`preview.browser.js`, 85 checks) and the
adversarial testers' own throwaway harnesses, which were deliberately written separately
from the builders' tests so a wrong test and wrong code could not agree with each other.

Several suites are **mutation-tested** — a bug is deliberately re-injected to prove the test
would catch it. Verified this way: the PDF y-flip, dropping the sheet preset from
`cellOrigin()`, dropping `align` or `logo` from the `layout()` call, hard-coding `left` while
`center` was requested, removing the `/DW` patch, the `clearAll()` false-success, the store
`RangeError` brick, prototype-polluted override ids, and rounding the preview's `x` to whole
points. A passing test that would also pass on broken code is worth little; these were
checked.

### Delivery state
- `site/` is a standalone git repo, everything committed on `main`, **43 files**.
- **No remote is configured and nothing has been pushed.** Deliberate — the public push is
  Julia's to make. `README.md` has the literal commands.
- `git status` is clean; nothing is present-but-ignored.
- The parent `Documents/Claude` repo ignores `site/` (one line added to its `.gitignore`,
  the only change made outside this folder).
- The sample `.docx` is not in the repo and is in no commit. `.gitignore` blocks
  `*.docx`/`*.doc`/`*.csv`/`*.xlsx` by default and re-includes only the named
  invented-name fixtures.

### What was NOT done, deliberately
- Nothing was pushed; no remote was created; GitHub Pages was not enabled.
- No email, Slack, Airtable, or contact of any kind with any member, prospect or sponsor.
- No real member, prospect or sponsor data appears in any file or commit. Every fixture,
  CSV and screenshot uses invented names, and the committed tree was scanned for the
  sample's real surnames and employers (zero hits; the sole apparent match was
  `Hungarumlautsmall`, a standard PostScript glyph name inside fontkit).

---

## 6. Conscious deviations from the brief

**6.1 Text box inset 14.4 pt (0.2"), not the sample's 0.75 pt.** As the brief specified.
The `.docx` cell margin leaves no printer safety margin; 0.2" is deliberate.

**6.2 Inter instead of Arial.** As the brief specified; the only intentional font
deviation. Inter v4.1, SIL OFL, vendored, three faces (400 / 700 / 400 italic).

**6.3 The sample's block is not vertically centred; ours is.** The sample's cells disagree
with each other — row 0 sits 16.86 pt off centre, row 1 20.91 pt — because of leftover
empty trailing paragraphs in the Word cells (row 0 has three at 18 pt; row 1 col 0 has four
at 24 pt plus three at 18 pt) that consume line-box height. There is therefore no canonical
sample vertical origin to match, and the acceptance criteria require true centring, so we
centre properly and do not reproduce the sample's stray whitespace.

**6.4 Vertical centring is optical, not layout-box.** Centring the layout box left visible
ink 2.0-4.7 pt low (median 3.9), because the model reserves Inter's hhea ascent
(1984/2048 = 0.96875 em) above the first baseline while Inter's cap height is only
1490/2048 = 0.7275 em. We now centre the optical ink box instead:

```
inkTop    = firstBaseline - capHeightPt(sizeOfFirstLine)
inkBottom = lastBaseline  + descenderDepthPt(sizeOfLastLine) / 2
shift     = -((inkTop + inkBottom - 216) / 2)
```
`capHeight` = 1490 units (from `OS/2.sCapHeight`, cross-checked against the glyf yMax of
H/E/T/I and B/D/F/K/L/M/N/P/R — all 1490). `descenderDepth` = 442 units, the deepest
measured glyf yMin across `p g y j q` (`g` = -442), **not** the hhea descender of 494,
which is ~10.5% deeper than any real lowercase ink and was the source of the
over-reservation. Both are identical across all three faces, and the font build fails if a
future Inter release makes them diverge.

The `/2` is a minimax choice: at layout time we cannot know whether the last line contains
a descender without becoming content-dependent. Reserving half makes the error symmetric.
Measured on `Marisol` / `Okonkwo` / `Northwind` / `Legal Ops Manager` at 36/26/21/19:

| Model | True ink-centre error |
|---|---|
| old layout-box | **+4.6712 pt low** |
| new optical, last line has a descender | **+1.0251 pt** |
| new optical, last line has none | **-1.0251 pt** |

Deliberately **content-independent** — always cap height at the top, always the same
descender reservation at the bottom — because content-aware ink centring makes badges on one
sheet sit at visibly different heights (measured spread up to 2.7 pt), and uniformity
matters more than the last fraction of a point.

**6.5 Accented capitals hang above the cap line.** `É` reaches 1930 font units against a
cap height of 1490 — about 7.7 pt at 36 pt. Optical centring measures the cap line, so an
accented capital extends slightly above the other badges' letter tops. This is standard
typographic practice (a line is not re-centred because it contains an accent) and the
alternative reintroduces cross-badge inconsistency. 1,568 of 2,852 mapped codepoints exceed
cap height, so the acceptance measurement uses the cap line rather than raw ink.

**6.6 The preview renders SVG `<text>`, not positioned HTML.** The brief suggested
absolutely-positioned elements with `line-height: 1`. Measured in Chrome, that puts
baselines **2.41-3.68 pt** too high, from CSS half-leading plus whole-pixel baseline
snapping. SVG `<text y>` *is* the baseline, lands fractionally, and cannot wrap. Also
found: browsers apply kerning by default, diverging up to 1.33 px from `InterMetrics`;
disabled with `font-kerning: none` and ligatures off. Without that the preview would lie
about what prints.

**6.7 Font data ships four times** (TTF, woff2, base64-in-JS, base64-in-CSS), of which
1.52 MB is never fetched by `index.html`. The TTFs and woff2 stay because an acceptance
criterion requires the real Inter files present in `fonts/`; the base64 copies exist
because `fetch` is banned and also blocked under `file://`. Cost: `fonts/` is ~3.9 MB,
`site/` ~5.5 MB, ~1.09 MB gzipped of font bytes on first load. Well inside GitHub Pages
limits.

**6.8 No email / share button.** Considered and rejected. `mailto:` cannot attach a file.
An email API would require shipping an API key in a page that is public on GitHub Pages —
anyone could send mail as The L Suite. A backend contradicts the no-server scope.
`navigator.share()` was the only safe option but requires a secure context, so it would
silently not exist under `file://` (which an acceptance criterion requires), it hands the
file to any share target rather than specifically to mail, and it leaves no audit trail of
where a confidential roster went. Export-to-download achieves the same end and behaves
identically however the app is opened.

**6.9 The font override is shrink-only.** Auto-sizing already selects the largest size that
fits, and 36 / 26 / 21 / 19 are hard ceilings, so "bigger" is structurally unreachable for
any badge whose text fits (measured: 0 of 60 clean fixtures). This is correct behaviour
rather than a bug; the UI states it instead of showing an unexplained disabled control.

**6.10 CJK / emoji are out of scope.** Julia confirmed only the 26 English letters plus
accented Latin are needed. Every codepoint Inter maps — 2,852 per face, including all
accented Latin — measures exactly. Characters Inter does not map cannot be printed by a
vendored Latin font; the guard that prevents them from overflowing a cell is retained.

**6.11 Dev-time tooling used, none of it a runtime dependency.** LibreOffice (to render the
sample for comparison and for its Avery label database), poppler (`pdftotext -bbox`,
`pdffonts`, `pdfinfo`, `pdftoppm`), Python + PIL, and headless Chrome driven over the
DevTools Protocol. The shipped site needs none of it — only a browser.

---

## 9. Changes of 2026-08-20 — sidebar reorganisation and two default flips

Five changes were asked for. Four landed; one was withdrawn after measurement. Test totals
went from **29,470** to **30,284** node checks across the six suites plus **86** real-browser
checks, all green. Every number below was measured after the change, not predicted.

### 9.1 Logo reserve is ON by default

`LOGO_DEFAULT.enabled` false -> **true**, in all three places that hold a copy of it
(`js/spec.js`, `js/store.js`, `js/overrides.js`; the latter two exist only as fallbacks for
a build where `spec.js` failed to load, and the suites assert they agree). The stock Julia
prints on carries a pre-printed logo in each badge's bottom-right corner, so reserving that
corner is the normal case.

Nothing about the reserve's geometry changed — section 5.1 still describes it exactly. What
changed is the state you get without touching the control, and the consequences are the ones
already documented there: lines level with the reserve are laid out in a 201.6 pt span
instead of 259.2, and under `left` alignment the whole block re-centres in that narrower
span, which moves **every** line of an affected badge about 0.4 in left. Verified in the
live app that this is now what happens with no stored setting at all (`lsuite.badges.logo`
absent from `localStorage`, reserve guides drawn on all six cells).

Two consequences worth stating plainly:

- **A browser that has already saved a logo setting keeps it.** The default only applies to
  storage that has never been written. If the reserve looks off on a machine that has used
  the app before, the stored value is why; toggling it, or "Clear all data", picks up the
  new default. `getLogo()` was checked not to persist the default on read, so a fresh
  browser still writes no logo key until something actually changes.
- **`clearAll()` now resets to on, not off.** Asserted directly in `store.test.js` rather
  than left implicit.

One test bug was exposed by the flip and fixed rather than worked around:
`test/preview.browser.js` section 11 disabled the reserve, then called `clearAll()`, which
reset it to the default — so its centred-block expectations were measured against
reserve-off geometry while the page rendered reserve-on. Failure magnitude was exactly
**28.7998 pt**, i.e. the 0.4 in narrowing, which is what identified it. The harness now
re-disables the reserve after the wipe; that section is about alignment, and section 9 of
the same file owns the reserve. 86/86 in a real browser after the fix.

### 9.2 Title may wrap to three lines

`MAX_LINES.title` 2 -> **3**. In-house legal titles routinely need it ("Executive Vice
President, General Counsel & Corporate Secretary").

**This makes the vertical shrink guard reachable, and that is the whole story of the
change.** The tallest possible block goes from `1.1499 x (36 + 26 + 8 + 2x21 + 4 + 2x19)` =
177.085 pt to `1.1499 x (36 + 26 + 8 + 2x21 + 4 + 3x19)` = **198.93 pt** against a `BOX_H`
of 187.2. Step 4 of the algorithm — shrink title, then company, last, first, until the block
fits — previously could not run and was documented in `layout.js` as unreachable. It runs
now. That comment has been corrected in place; leaving it would have been the most
misleading line in the file.

Measured on a fixture built to reach it (`Ana Rios` / `Whitfield Cordovan Analytics Group` /
`Deputy General Counsel and Chief Privacy Officer for the Americas Region`, invented):

| | two-line era | three lines |
|---|---|---|
| title size | 13.5 pt x 2 lines | **15.5 pt x 3 lines** |
| block height | 164.44 pt | **186.86 pt** (0.34 pt inside `BOX_H`) |
| what set the size | available width | **the vertical pass** — width alone allows 19 pt |

The comparison is not from memory: the test patches only `MAX_LINES` in a sandboxed copy of
`spec.js` and runs both engines side by side, the same technique section 6 uses for the gap
constant.

New `layout.test.js` section 22 proves three separate things:

- **(a) the guard fires** — width alone would allow the title at its 19 pt ceiling in three
  lines; 15.5 pt was used, and 15.5 is the largest half-point step that fits (16 pt
  overflows), re-derived here from the advance model rather than read off the engine.
- **(b) it contains** — across **504** combinations (7 long titles x 4 companies x 3 name
  lengths x 3 reserve geometries x 2 alignments): zero blocks over `BOX_H`, zero fourth
  lines, zero lines outside the 288 x 216 cell, zero clipping.
- **(c) it is a net win** — across 9 titles, **no title prints smaller** than it did with two
  lines and the long ones print larger. Short titles are bit-identical.

Through the exporter (`pdf.test.js`, new section): a two-badge sheet with three-line titles
and the reserve on — 14 text runs byte-equal to `layout()`, every word of both titles present
in the PDF text layer, and rasterised at 300 dpi, **zero ink in either reserved corner and
zero ink below either cell**. The third line is the lowest ink on a badge, so the bottom edge
is the one that would fail first; it was scanned explicitly.

Three existing expectations moved and were re-pinned with measured values, not loosened:
the `STRESS` literal line table (title 16 pt x 2 lines -> **16.5 pt x 3**, block 166.1606 ->
**186.2838**); the worst-case headroom note in section 20, rewritten symbolically off the
spec so it cannot drift; and one `overrides.test.js` assertion about capped nudges — see
below, because it is a real behavioural distinction rather than a number.

**A nudge can now be refused silently.** `overrides.test.js` asserted that all three
cappable fields warn when an upward nudge is denied. With three title lines, the `A3`
fixture's title is denied for a different reason: it fits at 19 pt by width, but the block
would then exceed `BOX_H`, so the vertical pass claws it back to 18 pt. That pass is
deliberately silent — nothing is truncated and nothing is lost — which is exactly the third
of the three reasons the dead-button probe at the top of `js/overrides.js` exists. The
button is still correctly disabled, because the probe runs `layout()` and compares the
applied size rather than assuming a requested nudge was granted. The test now asserts both
halves: the two clip-capped fields are named in the warnings, and the title is *not*, while
still not moving.

### 9.3 Side panel reorganised into two tab pages

Order on the **Badges** page, top to bottom, as requested: Export / Clear, Add attendee,
Import a CSV, Paste a list, Attendees, Font size override. **Sheet settings** — text
alignment, logo reserve, sheet layout — is now its own page behind a tab.

Done almost entirely in `index.html` and `styles.css`, on purpose:

- `#override-panel` and `#sheet-panel` are now declared in the markup. `js/overrides.js`
  already reused an existing element with those ids and only created one as a fallback, so
  it needed **no change at all** to move — the order lives in one readable place instead of
  in DOM-insertion code.
- Export before Clear is settled in CSS (`#data-controls` is a flex column, `.pdf-export`
  order 1, `.clear-all` order 2) rather than by mount order. `js/pdf.js` and `js/store.js`
  each append into that container and neither may assume it got there first, so ordering by
  mount order would have been a latent dependency on the bootstrap sequence.
- The tab strip is ~50 lines in `app.js`, which already owns shell wiring. It only sets
  `hidden` on containers that already exist and never touches their contents, so a hidden
  page's controls stay mounted and live (verified: `#sheet-panel` keeps its 15 children and
  the logo checkbox keeps its state while the Badges tab is showing). If either the tabs or
  the pages are missing it wires nothing and every page is simply visible, so the test
  harnesses that build their own DOM are unaffected.
- ARIA tabs pattern, verified in the live app: roving `tabindex`, `aria-selected` following
  the active page, and Arrow/Home/End moving between tabs with wraparound. The panel scrolls
  back to the top on a switch, because the two pages are very different heights.

The `.side-panel > div:not(:empty)` divider rule became `.panel-page > div:not(:empty)` —
without that the tab strip itself would have been ruled off as if it were a section.

Checked at 1440 x 900 and in the narrow (<1100 px) stacked fallback, and the console is
clean on load.

### 9.4 "Avery 5392" removed from the header

The sub-line now reads `6 per sheet · 4″ × 3″`. The stock reference came off because it
names a template Julia does not necessarily run — the same inference that produced the
sheet-preset error recorded in section 3. The dimensions stay because they are true of the
paper regardless of who made it. `Avery 5392` no longer appears anywhere in the rendered
page; the researched Avery geometry is still in `spec.js` and still offered as the `avery`
sheet preset, which is unchanged.

### 9.5 Print-safe left border — asked for, then withdrawn

A hidden keep-out at 0.0825 in from the left of the sheet was requested, "a print-safe
border, but not a true margin like the perforations".

Measured before building it: 0.0825 in is **5.94 pt**, and text already stops at the 14.4 pt
(0.2 in) inset on all four sides — the inset that section 6.1 records as existing precisely
to be a printer safety margin. A 5.94 pt keep-out is therefore inside a limit already
enforced and could never bind, under either sheet preset (`sampleTopLeft` puts column 0's
cell edge at page x = 0, so the keep-out would sit at 5.94 pt with text at 14.4; `avery`
puts the cell edge at 18 pt, so it could not bind at all). Julia's call on being shown the
arithmetic: not needed. **Nothing was built**, and the 0.2 in inset remains the only left
limit.
