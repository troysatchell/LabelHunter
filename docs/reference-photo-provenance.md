# Reference photo provenance

`assets/golden/references/` holds six images and one JSON sidecar. This document records
what each file shows, where it came from, whether a live trademark appears in the frame,
and whether any code reads it.

Two of the six images show no brand. Four show a real, live trademark. This document names
that risk. It does not decide it. Troy decides it.

**Read this before you commit, publish, or screenshot anything from that directory.**

Written 2026-08-12. Every observation below comes from opening the file and looking at it,
or from running a command and reading the output. Provenance claims come from
`docs/handoffs/2026-08-12-realistic-corpus-imagen-session.md`, which is the only record the
repo keeps of where these files came from.

---

## Summary table

| File | Shows a live trademark? | Read by code? |
|---|---|---|
| `alcohol-warning-label-1200x596-235563604.jpg` | No | No |
| `39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg` | No | No |
| `crown-royal-warning-label-closeup.png` | **Yes — Crown Royal** | Yes, via `spirits-bottle-01.json` |
| `spirits-bottle-01.jpg` | **Yes — The Glencairn Glass** | No |
| `Warning-Label-2.jpg` | **Yes — Francis Ford Coppola Winery** | No |
| `updated-alcohol-warnin-2564515199.jpg` | Uncertain — see below | No |
| `spirits-bottle-01.json` | Names Crown Royal in text | Yes |

"Read by code" means a `.ts` file resolves the path at run time. A mention in a handoff
document does not count.

---

## 1. `alcohol-warning-label-1200x596-235563604.jpg`

- **Size:** 1200x596, 113,530 bytes.
- **What it shows:** a flat reproduction of a government warning panel, photographed straight
  on. Off-white paper, black ink. The panel prints the full statutory warning in seven lines.
  Below it, one line prints `ALC. 10.5% BY VOL.` on the left and `CONTAINS SULFITES` on the
  right. Nothing else appears in the frame. A row scan at greyscale threshold 150 found exactly
  eight inked bands, which account for all eight printed lines.
- **Brand:** none. No brand name, no class type, no net contents, no logo, no trade dress.
- **Live trademark:** no.
- **Where it came from:** the handoff document records it as "Troy-supplied, not yet wired into
  any bottle-reference JSON." The repo records no photographer, no source URL, and no licence.
  The filename ends in a nine-digit number, which is the shape a stock-photo download uses.
- **Read by code:** no. Only the handoff document names it.
- **Risk:** the source and licence are unknown. The frame carries no brand, so the trademark
  risk is nil. The copyright question stays open until someone records where the file came from.
- **Value:** this is the only asset in the repo that measurably shows the compliant bold
  pattern. `GOVERNMENT WARNING:` prints bold and the remainder does not. The prefix/body
  stroke-width ratio measures 2.0 to 2.25, stable across three thresholds. All 32 golden-set
  cases that print a warning measure 1.00, because `render.ts` draws the whole block in one
  div at font-weight 400.

## 2. `39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg`

- **Size:** 1000x562, 101,242 bytes.
- **What it shows:** a cream back label on a real bottle, photographed close and slightly from
  the left. The label curves gently. Dark green glass shows at the left edge. Pale wood shows
  behind. The label prints the full statutory warning in seven lines, then one bottom line:
  `750ML • ALC. 15.1% BY VOL. • CONTAINS SULFITES`. A thin rule runs above the warning. The
  frame clips a line of text above that rule; only the bottoms of a few letters survive.
- **Brand:** none visible. The clipped line may have carried one. Nobody can read it.
- **Live trademark:** no.
- **Where it came from:** the handoff document records it as "Troy-supplied, not yet wired into
  any bottle-reference JSON." The filename is a Wix media identifier (`~mv2`), so the file most
  likely came off a Wix-hosted site. The repo records no source URL and no licence.
- **Read by code:** no. Only the handoff document names it.
- **Risk:** the source and licence are unknown, and the Wix filename points at a third-party
  website rather than a personal camera roll. The frame carries no brand, so the trademark risk
  is nil. Confirm who took the photograph before publishing it.

## 3. `crown-royal-warning-label-closeup.png`

- **Size:** 1271x721, 1,744,660 bytes.
- **What it shows:** a close-up of the back label on a real Crown Royal bottle. Dark burgundy
  label, gold text, curved glass, amber spirit. The frame prints `www.DRINKiQ.com`,
  `1.866.752.1345`, `www.crownroyal.com`, `IMPORTED BY THE CROWN ROYAL COMPANY, NORWALK, CT`,
  `CONTAINS CARAMEL COLOR • PRODUCT OF CANADA • 750 mL`, a boxed government warning,
  `VT-ME 15¢ / IA 5¢`, a UPC barcode reading `0 82000 75989 8`, three lot codes, and a recycling
  mark.
- **Live trademark:** **yes.** Crown Royal is a live Diageo trademark. The brand name, the web
  address, the corporate name, and the trade dress all appear.
- **Where it came from:** Troy's own photograph. The handoff document records the original
  filename as `Screenshot 2026-08-12 at 11.43.00 AM.png`, which used U+202F and broke
  `fs.readFileSync`. Someone renamed the file. Rename it, never retype it, if it ever needs
  restoring.
- **Read by code:** yes, indirectly. `spirits-bottle-01.json` names it as `referencePhoto`.
  `scripts/golden/imagen.ts` reads that JSON and sends the photograph to Gemini as a reference
  input.
- **Risk — flag this one.** A live trademark, a real corporate address, a real phone number, and
  a real barcode sit in a file that this repo sends to a third-party image model. The generation
  prompt blanks the label region and forbids logos and text, so the branding should never reach
  the output. The **input** is branded either way. The handoff document records that Troy made
  this call explicitly. Two questions stay open: does a TTB take-home want a competitor's live
  trade dress in its git history, and does the reviewer see this file?

## 4. `spirits-bottle-01.jpg`

- **Size:** 2483x4088, 572,373 bytes.
- **What it shows:** a square whiskey bottle on a grey cloth backdrop, with a Glencairn tasting
  glass beside it holding whiskey. A label on the far side shows through the glass, mirrored and
  out of focus. Its text is not readable. The neck band carries embossed text nobody can read.
  The glass base is etched `The Glencairn Glass`, and that etching is legible.
- **Live trademark:** **yes.** `The Glencairn Glass` is a live Glencairn Crystal Ltd trademark,
  and it is legible in the frame. The bottle brand is not legible.
- **Where it came from:** the handoff document records it as the "first reference photo tried
  (Wikimedia, real branded product used only as a shape reference)". The repo records no
  Wikimedia URL, no author, and no licence. Wikimedia files carry attribution terms. Nobody
  recorded them.
- **Read by code:** **no.** No `.ts` file names this path. The bottle reference JSON that shares
  its name points at the Crown Royal photograph instead. This file is dead weight on disk.
- **Risk — flag this one.** Two problems, and they are separate. First, a Wikimedia file without
  its attribution is a licence violation waiting to be noticed; the repo cannot honour terms it
  never recorded. Second, the file is unused. Deleting it costs nothing and removes both the
  licence question and the trademark question at once. That is a decision, not a fact, so it
  stays open.
- **Extra note:** the handoff document records that the tasting glass in this frame leaked into
  Gemini's output. That leak is why `imagenPrompt.ts` now says "Show the bottle alone."

## 5. `Warning-Label-2.jpg`

- **Size:** 1920x1080, 141,369 bytes.
- **What it shows:** a back label on a real wine bottle, photographed at a steep angle. The top
  two lines run off the frame at both ends. They read
  `...RODUCED & BOTTLED BY FRANCIS FORD COPPOLA WIN...` and
  `ALC. 14.5% BY VOL. • CONTAINS SULFITES * NET CONTENTS 750 ML`. Below them the frame prints
  `THIS LABEL IS THE EXCLUSIVE TRADE DRESS OF FRANCIS FORD COPPOLA WINERY.`,
  `www.FrancisFordCoppolaWinery.com`, and the full government warning.
- **Live trademark:** **yes.** Francis Ford Coppola Winery. The label itself prints the words
  "EXCLUSIVE TRADE DRESS".
- **Where it came from:** the handoff document records it as "Troy-supplied, not yet wired into
  any bottle-reference JSON." No source URL, no licence.
- **Read by code:** no. Only the handoff document names it.
- **Risk — flag this one.** The label declares its own trade dress claim in printed text. That
  makes it the worst candidate of the six for any use that reproduces the frame. Its warning is
  also unusable as ground truth: the perspective is steep enough that several lines are
  compressed to the point where a character-for-character transcription is a guess.

## 6. `updated-alcohol-warnin-2564515199.jpg`

- **Size:** 800x530, 44,753 bytes.
- **What it shows:** a curved bottle photographed close and cropped hard. The frame prints
  `NEW YORK, NY.`, a partial government warning whose right edge runs off the frame, `CRV`
  (California Redemption Value), and a partial line reading `SIT REPONSIBILITY.ORG`. A barcode
  shows at the lower right.
- **Brand:** no brand name is visible. The frame is too tight.
- **Live trademark:** uncertain. No mark is legible. `Responsibility.org` is a real
  organisation, and the printed line appears to read `REPONSIBILITY.ORG`, missing an S. Nobody
  should call that a printing error from a crop this tight; the frame may simply cut the letter.
- **Where it came from:** **unknown.** This file appears in no repo record at all, not even the
  handoff document that lists the other five. The truncated filename plus a ten-digit suffix is
  the shape a news-site or stock image download uses.
- **Read by code:** no. Nothing in the repo names it.
- **Risk:** provenance is entirely unrecorded, which is worse than the others rather than
  better. The warning is clipped, so the file cannot serve as ground truth either. It has no
  use and no paper trail.

## 7. `spirits-bottle-01.json`

- **Size:** 637 bytes.
- **What it is:** the bottle-reference record that drives `scripts/golden/imagenPrompt.ts`. It
  declares `bottleId`, `referencePhoto`, `beverageType`, `bottleDescription`, one scene
  (`compliance-desk`), and one camera condition (`steady`).
- **Live trademark:** the file names "the Crown Royal Company" inside `bottleDescription`, and
  `referencePhoto` points at the Crown Royal image.
- **Read by code:** yes. `src/lib/golden-set/bottleReference.ts` validates it.
  `scripts/golden/imagenPrompt.ts` compiles it into a prompt.
- **Note:** `bottleDescription` is validated as required in `bottleReference.ts`, and
  `buildBackdropPrompt` never reads it. The brand name sits in a field the prompt compiler
  ignores. That is worth knowing before anyone assumes the string reaches Gemini.

---

## The risks, named plainly

Four of the six images show a live trademark: Crown Royal, The Glencairn Glass, Francis Ford
Coppola Winery, and the uncertain sixth file. One of those four, the Crown Royal photograph,
is wired into the pipeline and gets sent to a third-party image model on every run.

Five of the six images have no recorded source and no recorded licence. One of the five is
recorded as a Wikimedia file, which carries attribution terms this repo never captured.

The two brand-free images carry no trademark risk at all. They are the only two of the six a
reviewer can see without a conversation about someone else's brand.

None of that is a decision. Troy decides.

## What to fix, in order

1. Record where `alcohol-warning-label-1200x596-235563604.jpg` and
   `39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg` came from. These are the two
   the golden set wants. Provenance is cheap now and expensive later.
2. Decide whether `spirits-bottle-01.jpg` stays. No code reads it. Its Wikimedia attribution is
   missing.
3. Decide whether `updated-alcohol-warnin-2564515199.jpg` stays. No code reads it. No record
   names it. Its warning is clipped.
4. Decide whether `Warning-Label-2.jpg` stays. No code reads it. Its own printed text asserts a
   trade dress claim.
5. Keep the Crown Royal decision under review. It is already made and already recorded. It is
   also the only branded file the pipeline actually touches.
