# Badge Sheet Builder

A single-page tool that turns an attendee list into a print-ready PDF of name badges.

Type attendees in, paste a list, or import a CSV. The page shows you a live preview of the
printed sheet, **Export PDF** downloads `badges.pdf`, and **Export Word (.docx)** downloads
`badges.docx` for anyone who needs to open or edit the sheet in Word or Google Docs.

**Print from the PDF.** It is exact by construction. The `.docx` is for sharing and editing -
it names Arial rather than the app's Inter, because Word has no fallback-font list and naming
a font the reader does not have installed would silently reflow every badge.

Each sheet is US Letter portrait with **6 badges — 2 columns across, 3 rows down**, each badge
**4" wide x 3" tall**, with no gaps between them. Out of the box the grid is packed against the
top-left corner, which leaves the **right 0.5" strip and the bottom 2" band of every sheet
intentionally blank** — that matches the Word template these badges have always been made from,
so nothing prints there.

Badge text is **left-aligned by default** — a change from the older centred look, which is still
available as an option. The grid can also be switched to Avery's official position on the page.
Both live in [Sheet settings](#sheet-settings--applies-to-every-badge).

---

## READ THIS BEFORE YOU PRINT

Two settings ruin every badge on the sheet if you get them wrong.

1. **Print at 100% scale.**
2. **Turn OFF "Fit to Page" / "Scale to fit" / "Shrink oversized pages."**

Any scaling — even 97% — moves every badge off the die-cut card and all six print crooked.
In the macOS print dialog choose **Scale: 100%** (not "Scale to Fit"). In Adobe Acrobat set
**Page Sizing & Handling** to **Actual size**. In Chrome's print dialog open **More settings**
and set **Scale** to **Default** or **Custom: 100**, and leave **Fit to printable area** off.

Sheet stock: 4" x 3" name badge inserts, 6 per sheet. Avery's own 5392 is one such product
(<https://www.avery.com/products/badges/5392>), but the default sheet layout here is the
top-left grid the existing Word template uses, not Avery's centred one — see **Sheet layout**
below before assuming the two are interchangeable.

**Always print one test sheet on plain paper first**, then hold it up against a real Avery
sheet against a window or a lamp. If the text blocks sit inside the six cards, run the real
stock. If everything is shifted or shrunk, a scaling setting is still on.

---

## Privacy — where the data lives

**Everything stays in your browser, on your machine.**

- Attendee names, titles, companies, your font-size tweaks, and your sheet settings are saved
  in the browser's **`localStorage`** under six keys — `lsuite.badges.attendees`,
  `lsuite.badges.overrides`, `lsuite.badges.pageIndex`, `lsuite.badges.logo`,
  `lsuite.badges.sheetPreset`, and `lsuite.badges.align`. That is a small storage area
  belonging to this one page in this one browser. **Clear all data removes every one of them**
  (and anything else stored under the `lsuite.badges.` prefix).
- **Zero network requests at runtime.** There is no `fetch`, no `XMLHttpRequest`, no
  WebSocket, and no `http://` or `https://` address anywhere in the app's code. The only
  web address in the whole app is the SVG namespace string the browser requires to draw the
  preview, which is an identifier, not a request.
- **No cookies. No analytics. No telemetry. No backend. No accounts. No logins.**
- Everything the page needs is **vendored** — copied into this repo. The Inter font files are
  in `fonts/`, and the PDF library (`pdf-lib` plus `fontkit`) is in `vendor/`. No Google
  Fonts, no CDN.
- The PDF is built **inside the browser** and handed to you as a normal download. It is never
  uploaded anywhere. Its document title is the generic string "Name Badges" — no attendee
  name ends up in the PDF metadata.

### The flip side: it is not backed up

Because the list is local and only local:

- It is **not backed up anywhere.** There is no copy on a server.
- It is **not shared between browsers or between machines.** A list you built in Chrome will
  not appear in Safari, and a list on your laptop will not appear on your desktop.
- **Clearing your browser data wipes the list.** So does using a private/incognito window,
  or a browser set to clear site data on quit.

Treat the browser as scratch space. If you need the list to survive, keep the source
spreadsheet, and re-import it.

### Removing the data

- **Delete** on any row in the Attendees list removes that one person immediately.
- **Clear all data**, at the bottom of the right-hand panel under **Export PDF**, erases
  everything. It takes **two clicks on purpose**:
  1. The first click arms it. The button changes to **"Erase everything — click again to
     confirm"** and warns: *"This erases every attendee and every size nudge saved in this
     browser. There is no undo."* A **Cancel** button appears next to it, which backs out and
     leaves your list alone.
  2. The second click wipes all six storage keys, empties the attendee list, and returns the
     preview to a single blank sheet. You'll see **"All data cleared. Nothing is saved in this
     browser."**

  That success message is checked, not assumed: the app deletes the keys, re-reads every one to
  confirm it is really gone, and only then says the data is cleared. If a browser refuses to
  remove them, it tells you so plainly instead — *"Clearing failed — some data may still be
  stored in this browser"* — and points you at your browser settings. So when it says cleared,
  it is cleared.
- Clearing site data for the page in your browser's settings also works, and is the fallback if
  the button ever reports a failure.

---

## Running it on your own machine

### Option A — just open the file (simplest)

Double-click `index.html`, or drag it onto a browser window. **This works** — it was built to
work and it has been tested end to end at a real `file:///` address: the page loads with no
errors, all three Inter faces come up, CSV import reads your file, and the preview draws at the
right coordinates, with no network requests at any point. No server, no install, no Node.

Why it works, since browsers normally cripple local pages:

- Every script is a plain classic `<script src="...">` tag — there are **no ES modules**.
  `type="module"` is blocked on local files; this app has zero module scripts (verified).
- The three Inter font faces used on screen are **embedded as `data:` URIs** inside
  `fonts/inter-face.css`, and the font data the PDF needs is **base64 text** in
  `fonts/inter-fontdata.js`. Neither has to be fetched.
- CSV import reads your file with **`FileReader`**, the one local-file API that is allowed.
- Every asset path is relative (`fonts/...`, `vendor/...`), never `/fonts/...`.

Two caveats worth knowing:

- **Saving between visits depends on the browser.** Chrome and Firefox generally allow
  `localStorage` for local files; Safari is stricter. If storage is unavailable the app still
  works fine for the session — it keeps the list in memory and logs a console warning — but
  your list disappears on reload. If you hit that, use Option B or Chrome.
- The first paint loads about 3 MB of embedded fonts and libraries from disk, so it may take
  a beat.

### Option B — serve it locally

More reliable for saving, and closer to how it behaves on GitHub Pages. From inside the
`site/` folder:

```bash
python3 -m http.server
```

Then open the URL it prints, normally <http://localhost:8000/>. Press `Ctrl+C` in the
terminal to stop it.

---

## Using it

The preview is on the left, the controls are in the panel on the right.

The panel has **two tabs**. **Badges** is everything to do with who is on the sheet: the
Export / Clear buttons, Add attendee, Import a CSV, Paste a list, the attendee list, and the
per-badge font size override, in that order top to bottom. **Sheet settings** is the second
tab and holds the three settings that apply to every badge at once. Switching tabs only
changes what you are looking at — nothing is reset, and no setting is forgotten while its
tab is hidden.

**Export PDF / Clear all data** sit at the very top of the Badges tab, so the button you
reach for at the end of the job is the first thing on the panel.

**Add attendee** — four fields: First, Last, Title, Company. Press **Add**, or hit Enter in
any field. A first or last name is required; Title and Company can be blank.

**Paste a list** — one attendee per line, fields in this order:

```
First, Last, Title, Company
```

Separate the fields with a **tab or a comma**, so a column copied straight out of Excel or
Google Sheets pastes cleanly. Wrap a field in `"double quotes"` if it contains a comma.
Trailing fields can be left off. Then press **Add all**. You get a report of what was added
and what was skipped, with line numbers.

**Import a CSV** — pick a `.csv` file with the four columns. **Columns can be in any order**,
and headers are matched loosely: the matcher lowercases the header and strips everything that
is not a letter or digit, so `First Name`, `firstname`, `first_name`, and `FIRST-NAME` are all
the same header. The spellings it accepts:

| Field | Accepted headers |
|---|---|
| First | `first`, `first name`, `given name`, `forename`, `fname` |
| Last | `last`, `last name`, `surname`, `family name`, `lname` |
| Title | `title`, `job title`, `position`, `role`, `job position` |
| Company | `company`, `company name`, `organization`, `organisation`, `employer`, `org` |

Any column it does not recognise is ignored and named in the report. There must be at least a
First or a Last column. `test/fixtures/import-sample.csv` is a working example file.

**Attendees list** — every row shows which page and slot that badge will print in (`p1 · 3`
means page 1, slot 3) plus **Edit**, **↑**, **↓**, and **Delete**. Edit opens the four fields
inline; Enter saves, Escape cancels. The arrows reorder the list, which is how you control
which badge lands in which slot.

**Font size override** — badges size themselves automatically: the tool shrinks and wraps text
until it fits inside the badge. Company can run to **two lines** and Title to **three**, which
is what lets a long title like "Executive Vice President, General Counsel & Corporate
Secretary" print at a readable size instead of being squeezed onto two lines. A title that
uses all three lines fills the badge, so on those badges a "+ Bigger" click may do nothing
even though the type is below its ceiling — there is no room left, and the tool greys the
button out rather than letting you push text off the card. If you want a specific badge different, pick that person in
**Adjust which badge**, then use **− Smaller** / **+ Bigger** to move all four lines together
in 0.5 pt steps, or the **−** / **+** next to a single line to nudge just that line. Each
line's current size is shown, along with why a button is greyed out (`at max`, `at floor`,
`fit`, `not printed`). **Reset to auto** puts that badge back to automatic.

### Sheet settings — applies to every badge

These three live on the **Sheet settings** tab of the right-hand panel. Unlike the font
size override, they are **not per-person** — they change every badge on every sheet.

**Text alignment** — a two-option picker:

- **"Left — all four lines flush left"** — the **default**. First name, last name, company, and
  title all **share a common left edge**, so the badge reads as one left-aligned block instead of
  four separately centred lines. That block is then **centred in the badge as a whole**: the left
  edge sits wherever it needs to for the widest of the four lines to be balanced left-to-right.
  It only ends up flush against the 0.2" safety margin when the widest line fills the full width.
  Text never runs to the very edge of the card.
- **"Centred — each line centred"** — every line centred individually in its badge.

Because each badge is balanced against **its own** widest line, **badges with short text sit
further in from the left than badges with long text** — on one six-badge sheet the six left edges
came out at 16.6, 23.0, 34.7, 36.9, 43.6 and 59.2 pt. That is deliberate, not drift: badges get
cut apart and worn one at a time, so each one is balanced in itself rather than lined up with its
neighbours on the sheet.

**This is a change of default.** Badges used to be centred; they are left-aligned now. If you
preferred the old look, pick **Centred** and it behaves exactly as it always did.

One thing worth knowing: **font sizes and wrap points are identical in both modes.** Alignment
decides horizontal position and nothing else, so switching between Left and Centred will never
make text suddenly shrink or re-wrap.

**Logo reserve** — for stock that already has a logo printed in a corner of each badge.
Tick **"Reserve space for the pre-printed logo"**, pick which **Corner** it occupies
(**Bottom right** — the default — **Top right**, or **Top left**), and set a **Width** and
**Height** in **inches** (default **1 x 1**, adjustable from 0 to 4 in 0.25" steps). **On by
default**, because the stock in use has a pre-printed logo there. The tool keeps that corner
rectangle clear of text; untick the box and every badge goes back to using the full width —
that is the "no logo at all" option.

If you have used this tool before on the same computer and the reserve looks switched off,
that is your saved setting being remembered rather than the new default — tick the box (or
use **Clear all data**) and it will stick.

Lines that sit level with the reserved corner — Company and Title for a bottom corner, the
First name for a top one — get less width to work with, so they may wrap or shrink sooner.
What happens to their position depends on the alignment you chose:

- **Left** (the default): all four lines keep one shared left edge, names included. For the
  right-side corners the block simply recentres in the narrower space left of the logo, so the
  whole badge's text moves together rather than one line drifting away from the others. For
  **Top left**, only the lines level with the logo indent to its right — pushing the whole
  block right of the logo would shove a full-width line off the badge.
- **Centred**: they narrow *and* recentre in the space beside the logo, landing about **0.4"
  away from the unaffected lines** (to the left for a right-side corner, to the right for
  top-left). That looks slightly off-centre on screen. **It is intended, not a glitch** —
  those lines are centred in the space they actually have.

The preview marks the reserved corner as a screen-only guide; **nothing is drawn there in the
PDF**, because the logo is already physically on the badge.

**Sheet layout** — where the whole 2 x 3 grid sits on the page. It moves the grid, not the badge
contents. Two options:

- **Sample layout (top-left, zero margin)** — the **default**. The grid sits against the
  top-left corner of the page, leaving 0.5" unprinted at the right and 2" unprinted at the
  bottom. This matches the existing Word template these badges have always been made from, and
  it is the correct position for the badge stock in use.
- **Avery standard (5392 / 74536 / 5384 / 74540 / 74541)** — the same six 4" x 3" cells, centred
  on the page instead: 0.25" clear at the left and right, 1" clear at the top and bottom. Those
  are the numbers from Avery's published template for those product codes, offered for stock
  that expects the grid in that position.

Which one is right depends purely on the paper you are running. **If your badges land where they
should, leave this alone** — the default is already set for the stock in use. Only reach for
Avery standard if you are printing on stock that expects the centred position, and print a test
sheet either way.

**Page navigation** — under the preview, **‹ Previous** / **Next ›** step through sheets once
you have more than six attendees. **Cell guides (screen only)** outlines the six badge cells
on screen; those outlines are never printed and never in the PDF.

**Export PDF** — at the top of the Badges tab. Downloads `badges.pdf`. Then print it using
the settings at the top of this file. This is the output to print: every position in it is
computed, not re-derived by another program.

**Export Word (.docx)** — next to it. Downloads `badges.docx`, which opens in Word, Google
Docs and LibreOffice as a real 2x3 table, so a name can be corrected without coming back
here. Same grid, same page size, same line breaks — every line break is decided here and
written as its own paragraph, so Word is never asked to re-wrap anything.

Two deliberate differences from the PDF, both measured rather than estimated:

| | difference |
|---|---|
| Font | Arial, not Inter. Word cannot be given a fallback list, and a missing font reflows the sheet silently. Arial is everywhere and is what the original sample used. |
| Vertical position | Text sits **3.9-6.7 pt lower** (mean 4.3). Word centres the block of text in the cell; this app centres the visible *ink*, which is slightly higher. Uniform across every badge. |
| Horizontal position | Each line **starts** exactly where the PDF puts it; later words in the same line drift up to 9.9 pt left, because Arial's letters are narrower than Inter's. |

Nothing re-wraps and nothing leaves its cell — `test/docx.test.js` renders the file through
LibreOffice and measures every word to prove it.

---

## How it's put together

There is one fit engine, `js/layout.js`, and it is the only code in the app that decides
anything about type: where lines wrap, how much each line shrinks to fit, and the exact
position of every line inside the badge. **Both the on-screen preview (`js/preview.js`) and
the PDF export (`js/pdf.js`) call it and draw exactly what it returns** — neither one does its
own measuring or centring. That is deliberate: it is the only way the preview can be trusted
to match what comes out of the printer. If you ever change spacing or sizing rules, change
them there and both sides move together. `js/spec.js` holds the fixed numbers (page size,
cell grid, per-line maximum and minimum point sizes).

---

## Tests

There are **six test files**, together running **30,284 checks**. They are plain `node`
scripts — no test framework, no `npm install`. Run them one at a time from inside `site/`:

```bash
node test/layout.test.js
node test/input.test.js
node test/store.test.js
node test/pdf.test.js
node test/preview.test.js
node test/overrides.test.js
```

Files that do **not** end in `.test.js` are browser harnesses, not node scripts — open them in
a browser instead of running them:

- `test/preview.browser.js` (loaded by `test/preview.browser.html`)
- `test/input.harness.html`, `test/preview.probe.html`, `test/preview.shot.html`
- `test/preview.fixture.js` — shared sample data, invented names only

**Running the tests needs Node installed. Using the app does not.** Node is only for checking
the code; the badge tool itself is just a web page.

---

## Publishing it to GitHub Pages

**Nothing has been pushed anywhere. This repo has no remote configured and no commits have
left your machine.** That is on purpose — making it public is your call, so the push below is
yours to run.

1. On <https://github.com> click **New repository**. Give it a name, and **do not** let it add
   a README, `.gitignore`, or licence — this folder already has them.

2. From inside the `site/` folder, connect it and push. Replace `YOUR-USERNAME` and
   `YOUR-REPO` with the real values:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git branch -M main
   git push -u origin main
   ```

   `git branch -M main` renames your current branch to `main`; it is harmless if it is already
   called that.

3. In the repo on GitHub go to **Settings → Pages**. Under **Build and deployment** set
   **Source** to **Deploy from a branch**, then **Branch** to `main` and folder to
   **`/ (root)`**, and press **Save**.

4. Wait a minute or two, then open:

   ```
   https://YOUR-USERNAME.github.io/YOUR-REPO/
   ```

`.nojekyll` is already in this folder, which stops GitHub Pages from running its Jekyll
processor over the files and mangling them. Leave it there.

Note that the published page is **public** — anyone with the URL can open the tool. That is
fine: the tool ships with no data in it, and every list anyone builds stays in their own
browser. Nothing you type is ever visible to anyone else, including you on another device.

---

## A note on `.gitignore`

`.gitignore` blocks `*.docx`, `*.doc`, `*.csv`, `*.xlsx`, and `*.pdf` by default, so a real
attendee export or a printed badge sheet cannot be committed by accident. Two narrow
exceptions are re-included at the bottom of the file — `test/fixtures/import-sample.csv` by
name, and `test/fixtures/*.json` — and every one of those files contains invented names only.

**Please don't widen those exceptions.** Broadening them to something like
`!test/fixtures/**` would make any spreadsheet dropped into that folder committable — and
`test/fixtures/` is exactly where someone would drop a real attendee list while testing the
importer. If you add a new fixture in an ignored format, add a line for that specific file.

---

## Licences

**The app's code** is MIT licensed — see `LICENSE`.

**Inter** is used under the **SIL Open Font License, Version 1.1**. Credit to *the Inter
Project Authors*. The full licence text ships alongside the fonts as `fonts/OFL.txt`, and the
font files themselves are vendored into `fonts/` — no Google Fonts, no CDN, no runtime font
download. Licence details: <https://scripts.sil.org/OFL>.

`vendor/` contains `pdf-lib` and `@pdf-lib/fontkit`, also vendored so the app never reaches
the network.
