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

**Update, TRO-529 / LH-024, 2026-08-13 — five of the six images are now golden-set cases.**
Troy's trademark decision (Linear TRO-529, 2026-08-12, quoted below) cleared all five warning
close-ups for use. `golden-set/manifest.json` now carries them as `provenance: "photographed"`
cases. `golden-set/README.md`'s "Real-photograph cases" section has the full mechanics. The
sixth file, `spirits-bottle-01.jpg`, is a full bottle shot, not a warning close-up. It is NOT
adopted. It stays parked for the realistic-corpus backdrop track (LH-028).
`spirits-bottle-01.json` still points at the Crown Royal photo as that track's own reference
input — unrelated to this ticket.

**These five cases are test fixtures, not compliance assessments.** Every image these cases
use is a shipped, real product with an approved COLA. This document, and the golden-set case
each file backs, record what a careful human can see in a photograph. Neither ever claims the
named product does or does not comply with 27 CFR. Sometimes the photograph cannot support a
call — most visibly, whether `GOVERNMENT WARNING:` prints bold. There, the golden-set case
records `"unknown"`, not a guess. A `false` would be a fabricated accusation against a real
company, not a measurement. That is TRO-529's own instruction, applied here.

> Troy, 2026-08-12 (Linear TRO-529): "using the trademarked images is fine... Jenny Park asked
> for 'labels photographed at weird angles, or the lighting is bad, or there's glare on the
> bottle' (L34). These five cover that spread with REAL photographs instead of `degrade.ts`
> transforms... Expect the extractor to FAIL on the harder ones. That is the point."

---

## Summary table

| File | Shows a live trademark? | Read by code? | Golden-set case |
|---|---|---|---|
| `alcohol-warning-label-1200x596-235563604.jpg` | No | **Yes** (TRO-529) | `case-35-clean-match-real-photo-flat-scan` |
| `39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg` | No | **Yes** (TRO-529) | `case-36-rotation-real-photo-gentle-curve` |
| `crown-royal-warning-label-closeup.png` | **Yes — Crown Royal** | Yes, via `spirits-bottle-01.json` AND (TRO-529) | `case-38-glare-real-photo-crown-royal` |
| `spirits-bottle-01.jpg` | **Yes — The Glencairn Glass** | No | Not adopted — parked for LH-028 |
| `Warning-Label-2.jpg` | **Yes — Francis Ford Coppola Winery** | **Yes** (TRO-529) | `case-39-rotation-real-photo-coppola-wraparound` |
| `updated-alcohol-warnin-2564515199.jpg` | Uncertain — see below | **Yes** (TRO-529) | `case-37-rotation-real-photo-severe-curve-partial-crop` |
| `spirits-bottle-01.json` | Names Crown Royal in text | Yes | N/A — a bottle-reference record, not an image |

"Read by code" means a `.ts` file resolves the path at run time, or a golden-set case's
`imagePath` names it (`golden-set/manifest.json`, checked by `src/lib/golden-set/loader.ts`).
A mention in a handoff document does not count.

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
- **Read by code:** **yes** (TRO-529, 2026-08-13). `golden-set/manifest.json`'s
  `case-35-clean-match-real-photo-flat-scan` names this path as its `imagePath`.
- **Risk:** the source and licence are unknown. The frame carries no brand, so the trademark
  risk is nil. The copyright question stays open until someone records where the file came from.
  This is unresolved by TRO-529's adoption — the "what to fix" list below still names it.
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
- **Read by code:** **yes** (TRO-529, 2026-08-13). `golden-set/manifest.json`'s
  `case-36-rotation-real-photo-gentle-curve` names this path as its `imagePath`.
- **Risk:** the source and licence are unknown, and the Wix filename points at a third-party
  website rather than a personal camera roll. The frame carries no brand, so the trademark risk
  is nil. Confirm who took the photograph before publishing it. This is unresolved by TRO-529's
  adoption — the "what to fix" list below still names it.

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
- **Read by code:** yes, twice over. Indirectly: `spirits-bottle-01.json` names it as
  `referencePhoto`. `scripts/golden/imagen.ts` reads that JSON and sends the photograph to
  Gemini as a reference input. Directly (TRO-529, 2026-08-13): `golden-set/manifest.json`'s
  `case-38-glare-real-photo-crown-royal` names this exact path as its own `imagePath` — the
  government-warning panel visible in this same frame, adopted on its own terms.
- **Risk — flag this one.** A live trademark, a real corporate address, a real phone number, and
  a real barcode sit in a file this repo sends to a third-party image model. This repo now also
  uses it directly as a golden-set case image. The generation prompt blanks the label region
  and forbids logos and text, so the branding should never reach imagen.ts's own output. The
  golden-set case is different: it uses this photograph's real pixels AS the test image, on
  purpose. Troy's explicit 2026-08-12 trademark decision (Linear TRO-529) authorizes exactly
  this. The golden-set case's own `notes` field states plainly that it is a test fixture, not a
  compliance claim about Crown Royal's real, approved label. One question stays open regardless.
  Does a TTB take-home want a competitor's live trade dress in its git history? Does the
  reviewer see this file? Troy's call stands either way.

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
- **Read by code:** **yes** (TRO-529, 2026-08-13). `golden-set/manifest.json`'s
  `case-39-rotation-real-photo-coppola-wraparound` names this path as its `imagePath`.
- **Risk — flag this one.** The label declares its own trade dress claim in printed text. That
  makes it the worst candidate of the six for any use that reproduces the frame. Its own case's
  `notes` field states plainly that it is a test fixture, not a claim about this real product's
  compliance — the same posture as the Crown Royal case above. **Correction, TRO-529
  (2026-08-13):** a direct read of this photograph, warning block only, found the full
  statutory text legible. It is byte-for-byte exact once case-folded. This earlier note called
  the transcription "a guess." That was true of the steep-perspective producer-name lines above
  the warning, not of the warning block itself. `verified` still stays `false` on the golden-set
  case regardless — only Troy's own check changes that.

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
- **Read by code:** **yes** (TRO-529, 2026-08-13). `golden-set/manifest.json`'s
  `case-37-rotation-real-photo-severe-curve-partial-crop` names this path as its `imagePath`.
- **Risk:** provenance is entirely unrecorded, which is worse than the others rather than
  better. This is unresolved by TRO-529's adoption — the "what to fix" list below still names
  it. **Correction, TRO-529 (2026-08-13):** the warning is clipped, so this file cannot serve
  as EXACT ground truth for the full statutory text. But "the file cannot serve as ground truth
  either" overstated the gap. TRO-529's case records exactly what is legible. It marks every
  cropped gap explicitly (`[cut]`). It drives the case to `NEEDS_REVIEW` rather than pretending
  completeness — the deliberately hard, "explicit unreadable outcome" case TH-R10 asks for
  (`golden-set/README.md`'s own case-by-case list has the detail). A clipped photograph is real
  ground truth for what a clipped photograph shows.

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
Coppola Winery, and the uncertain sixth file. **Troy decided, 2026-08-12 (Linear TRO-529):
using the trademarked images is fine.** That decision covers the five warning close-ups. It
does not cover `spirits-bottle-01.jpg` (below), which stays a separate, still-open question.
The Crown Royal photograph is now read twice over. `imagen.ts` still sends it to a third-party
image model as a backdrop reference, unrelated to this decision. Since TRO-529, its own
government-warning panel is also a golden-set case's `imagePath` directly.

Five of the six images have no recorded source and no recorded licence. One of the five is
recorded as a Wikimedia file, which carries attribution terms this repo never captured. TRO-529
adopted five of these six images as golden-set cases without resolving this. Troy's trademark
call authorizes the ADOPTION. It does not supply a photographer, a source URL, or a licence for
any file that lacked one before. That gap is unchanged by this update — see the list below.

The two brand-free images carry no trademark risk at all. They are the only two of the six a
reviewer can see without a conversation about someone else's brand.

None of the source/licence gap is a decision this document makes. Troy decides.

## What to fix, in order

1. Record where `alcohol-warning-label-1200x596-235563604.jpg` and
   `39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg` came from. Both are now golden-set
   cases (`case-35`, `case-36`) with no source or licence on file. Provenance is cheap now and
   expensive later.
2. Decide whether `spirits-bottle-01.jpg` stays. No code reads it. This is the one file TRO-529
   did NOT adopt — a full bottle shot, not a warning close-up, it belongs to the parked LH-028
   realistic-corpus track instead. Its Wikimedia attribution is still missing.
3. Record where `updated-alcohol-warnin-2564515199.jpg` came from. No record names it. It is now
   a golden-set case (`case-37`) despite the still-open provenance gap. Troy's trademark
   decision and this file's own lack of any visible brand together made adoption defensible
   without first closing this gap. The gap itself is still real.
4. Record where `Warning-Label-2.jpg` came from. It is now a golden-set case
   (`case-39-rotation-real-photo-coppola-wraparound`) under Troy's explicit trademark decision.
   Its own printed text still asserts a trade dress claim. The golden-set case's `notes` field
   states plainly that it is a test fixture, not a compliance claim.
5. Keep the Crown Royal decision under review. It is already made and already recorded. It is
   the only file in this batch both wired into `imagen.ts`'s pipeline AND adopted directly as a
   golden-set case (`case-38-glare-real-photo-crown-royal`).
