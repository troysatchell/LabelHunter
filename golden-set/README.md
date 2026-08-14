# Golden set

The golden set is a fixed collection of label test cases (TH-R12). Each case pairs a label
image with ground-truth data: what the application form says, what the label actually shows,
and what the Validation Router should decide. Later tickets use it two ways:

- **Eval harness** (PRD §6): scores the Haiku extractor and the Validation Router against
  this ground truth.
- **Demo set**: seeds the deployed instance so evaluators can try the app without uploading
  their own labels (PRD §7).

## Images: rendered and degraded (LH-004, TRO-497)

`golden-set/images/` holds a real, committed JPEG for every `rendered` and `rendered+degraded`
case — 33 of the manifest's 38 cases. Total size: about 1.29 MB (`pnpm golden:build`, measured
2026-08-13). Largest file: 48.9 KB. Every one of these 33 images stays well under the ~500 KB
per-image target. The other 5 cases are
`photographed` (TRO-529 / LH-024, below) — real camera photographs committed at their own
paths under `assets/golden/references/`, not `golden-set/images/`, and not subject to the
500 KB target (a photograph's size is not this repo's to tune).

The pipeline is the render-first hybrid design doc §2 lays out:

- **`scripts/golden/render.ts`** — an HTML/CSS→PNG renderer. It uses Playwright's bundled
  Chromium, already a repo dependency for `pnpm test:e2e`. It draws each case's `label`
  fields — brand, class/type, ABV line, net contents, government warning — with no
  paraphrasing. Whatever string the spec carries is the string on the image, byte for byte.
  No image model is ever trusted with the warning text (design doc §1's core rule).
- **`scripts/golden/degrade.ts`** — sharp transforms (rotate, perspective, glare, low light,
  blur) that derive an imperfect-photo variant from a clean rendered base. Ground truth
  carries over unchanged. Only the photo condition changes.
- **`scripts/golden/build.ts`** — orchestrates render → degrade for every case, and writes
  the committed JPEG at its manifest path. Run it with `pnpm golden:build`.

**Still not done — `ai-generated` wild labels.** Design doc §5 describes about 5 fully
`ai-generated` "wild" labels (text included). No case in this manifest has `provenance:
"ai-generated"` yet. When a future ticket adds one, its image starts out absent — the same way
every case here started before LH-004. That ticket must land the image and set `verified: true`
in the same manifest change. The loader rejects a `verified: false` `ai-generated` case at load time. It checks the schema
shape only, not whether the file exists. `scripts/golden/images.test.ts` checks that the file
exists.

**Still not done — the realistic-corpus track.** A newer design doc supersedes the rest of the
original §5 scope: `docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md`.

Under this design, Gemini generates a realistic bottle photograph from a real reference photo.
Each photo shows one camera condition: steady, motion-blur, or camera-shake. `build.ts`
composites the renderer's exact-text label onto the photo. This step removes the warning-text
transcription risk that an `ai-generated` case carries.

The tooling exists now. Synthetic fixtures test the tooling:
`scripts/golden/{imagenPrompt,blankRegionDetector,compositeBackdrop,imagen}.ts`.

`assets/golden/references/` now holds real bottle photos (TRO-529 / LH-024's five
`photographed` cases use five of them directly). No case in this manifest has provenance
`"rendered+ai-backdrop"` yet, so no case here composites onto a backdrop from this directory.

A future ticket adds the first one, once real bottle photos exist. Follow these steps:

1. Add a bottle reference JSON file and its photo under `assets/golden/references/`. The
   schema is `src/lib/golden-set/bottleReference.ts`.
2. Run `pnpm golden:imagen`. For every `(scene, cameraCondition)` combination, the tooling
   writes a backdrop PNG and a `.meta.json` sidecar to `golden-set/backdrops/`. The sidecar
   records the detected `labelPlacement` and `generationMetadata`. The tooling never edits
   `manifest.json`.
3. Check the sidecar's `labelPlacement` value. If automatic detection fails, the sidecar
   shows `labelPlacement: null` for that case. `pnpm golden:imagen` also prints "needs
   manual placement" as a reminder. When this happens, measure a valid label-placement
   quadrilateral by hand. Use it instead of the null value.
4. Hand-author the case's manifest entry: ground truth, category, and vectors, the same as
   every other case. Fold in the sidecar's `referenceBottle`, `scene`, `cameraCondition`,
   `labelPlacement`, and `generationMetadata`.
5. Keep `verified: false` until two conditions both hold. First, the entry's
   `labelPlacement` holds the real, measured quadrilateral — it is never the null
   placeholder. Second, a human confirms the composited label is legible and correctly
   placed. Do not re-transcribe the warning text — the renderer already guarantees that
   text is exact.
6. Run `pnpm golden:build`. This command composites the label onto the committed backdrop.
   The command is deterministic and makes no network call.

`scripts/golden/verify.ts` (LH-006) checks this track's consistency: every
`rendered+ai-backdrop` case's backdrop file must exist at
`golden-set/backdrops/<caseId>.png`. The loader enforces the schema shape:
`src/lib/golden-set/loader.ts`.

Every case's `verified` field stays `false`, even though its image is now real. `verified`
records a **human** sign-off (design doc §3). That is CP-2's review, not this ticket's.
Rendering a spec's exact text mechanically is not the same claim as a person confirming the
image looks right.

**Rubric-vector coverage (`audit/rubric.md` Appendix A):** every case is tagged with the
vectors it provides evidence for (`vectors` field). V1 through V9 each have at least one
covering case today. **V10** is different: it is a property of the manifest as a whole (batch
of ≥20), not any single case. The manifest's 38 cases satisfy the ≥20 count, but no case
individually claims V10, and none ever should. `loader.test.ts` asserts both halves of this
explicitly, so neither can silently drift.

**V7** (net-contents format match, e.g. `"750 mL"` vs `"750ml"`) was the last vector with no
covering case. TRO-515 closed it. `case-30-clean-match-net-contents-alt-format` isolates the
format difference as its one distinguishing feature — the same way
`case-04-clean-match-spirits-alt-format` isolates V6's ABV-format difference.

`scripts/golden/verify.ts` (`pnpm golden:verify`, LH-006) enforces coverage at the CI/CLI
layer. V10 counts as covered once the manifest holds ≥20 cases. Every other vector needs its
own covering case. `KNOWN_VECTOR_GAPS` in `verify.ts` names any vector that still has none —
empty today. A vector that loses its only covering case fails the gate. A vector that regains
coverage without its `KNOWN_VECTOR_GAPS` entry being removed in the same change also fails the
gate — the same symmetric, can't-silently-drift check that caught V7's own exception needing
removal here.

## Real-photograph cases (LH-024, TRO-529)

Five cases (`case-35` through `case-39`) use `provenance: "photographed"`. Each is a real
camera photograph of a real, physical government-warning panel — not code, not a model. This
is a fifth production method, alongside `rendered`, `rendered+degraded`, `ai-generated`, and
`rendered+ai-backdrop`. See `GoldenSetProvenance`'s own comment (`src/lib/golden-set/types.ts`)
for the full reasoning.

These five committed photos are the only real-world evidence in the corpus. Jenny Park asked
for "labels photographed at weird angles, or the lighting is bad, or there's glare on the
bottle" (source-TH.md L34). These cases cover that spread with real photographs, not
`degrade.ts` transforms on synthetic artwork: a flat scan, a gentle curve, a strong curve with
shallow depth of field, glare on a curved gold-on-maroon surface, and extreme wrap-around
curvature.

**A different image-path convention.** A `photographed` case's `imagePath` points at its own
original filename under `assets/golden/references/` (`docs/reference-photo-provenance.md`). It
is never copied or renamed into `golden-set/images/<caseId>`. The file predates its case. It IS
the forensic evidence. Renaming it to fit the render pipeline's convention would throw that
away. `src/lib/golden-set/loader.ts`'s `checkCase` enforces this different convention: the
`imagePath` must start with `assets/golden/references/`, and the "basename must equal caseId"
rule does not apply to this provenance. `scripts/golden/verify.ts` separately confirms the
resolved path stays inside that directory. This is the same path-traversal hardening
`scripts/golden/build.ts`'s `resolveImagePath` already applies to `golden-set/images/`.

**Never rendered.** `scripts/golden/build.ts`, `scripts/golden/renderSmoke.ts`, and
`scripts/golden/render.test.ts` all exclude `photographed` cases from whatever they render.
Running one through the HTML/CSS→PNG pipeline would silently overwrite a real photograph with
synthetic drawn text at the same path. `scripts/golden/images.test.ts`'s JPEG-decode and
~500 KB checks are scoped away from this provenance for the same reason: a real photograph's
format and size are not a render-pipeline tuning choice. Its own describe block runs its own,
honestly different checks instead: the file exists, decodes as a real JPEG or PNG, and stays
under a generous 5 MB backstop.

**Ground truth is what a careful human can determine from the photograph.** It is not what the
render pipeline knows in advance. Several of the five images are close crops of just the
warning panel. No brand name, class/type, or net-contents statement appears in frame at all.
Rather than inventing a plausible-looking value that was never printed on the photograph, those
fields record `"(not shown in this crop)"`. Their `expected` verdict is `NEEDS_REVIEW`, never
`MATCH` or `MISMATCH`. `governmentWarningPrefixBold` / `governmentWarningBodyBold` use the
`"unknown"` state (TRO-527 / LH-022) wherever the photograph cannot support a bold/not-bold
call. A `false` there on a real, shipped, COLA-approved product would be a fabricated
compliance accusation, not a measurement. Two of the five images show a live trademark (Crown
Royal; Francis Ford Coppola Winery) — Troy's own explicit 2026-08-12 call to use them (see
`docs/reference-photo-provenance.md`). Every one of these five cases is a test fixture. None
records a compliance claim about the real product it happens to photograph.

**`verified` stays `false`.** Only a human confirms a hand transcription is exactly right —
Troy, not this ticket. The loader does not gate the eval harness on `verified` for this
provenance. `ai-generated`/`rendered+ai-backdrop` are different: their own risk is a generated
image silently failing to render its spec's exact text. Nothing here was generated, so that
risk does not apply.

## Manifest format

`manifest.json` holds one JSON object: `{ "version": "1.0.0", "cases": [...] }`. Each entry
in `cases` is a `GoldenSetCase` — the TypeScript type is the schema of record, at
`src/lib/golden-set/types.ts`. A case has these parts:

| Field | What it holds |
|---|---|
| `caseId`, `description`, `category`, `beverageType` | Identity: a unique ID, a one-line summary, which of the 12 required test categories the case belongs to, and beer/wine/spirits. |
| `imagePath` | Where the label image lives (see naming convention below). A real committed file for every `rendered` / `rendered+degraded` / `photographed` case; still absent for a future `ai-generated` case until LH-005 adds one. |
| `provenance` | How the image was (or will be) produced: `rendered`, `rendered+degraded`, `ai-generated`, `rendered+ai-backdrop`, or `photographed` (TRO-529 / LH-024 — see that section above). Design doc §2/§5. |
| `verified` | `true` only once a real image exists and a **human** has confirmed it matches its spec — CP-2's job, not this ticket's. Required `true` for any `ai-generated` case before the eval harness may use it — enforced by the loader, not just documentation. Every case here is still `false`. |
| `vectors` | Which `audit/rubric.md` completion vectors (V1–V10) this case is evidence for. The list may be empty. See the rubric-vector coverage note above for V10, the one vector no single case tags. |
| `application` | The five example fields as filed on the application (PRD §2, §5, TH-R11). |
| `label` | The same fields as a careful human reader sees them on the label, plus warning-specific detail (`governmentWarningPrefixAllCaps`, presence flags). |
| `expected` | The Validation Router's expected output: a verdict + one-line reason per field, a label-level verdict, and — only when the label-level verdict is `REVIEW` — the `ReviewReason` that routes the label to the Sonnet resolver (PRD §3.3). |
| `degradations` | (LH-004) The `degrade.ts` transforms applied to a `rendered+degraded` case's clean base, in order, with their exact parameters — present only when the case's imperfection is a photo condition (glare, rotation, low light, blur, perspective — the five types `DegradationType` supports), absent for a render-time print choice (tiny text, an unusual font) or a clean `rendered` case. |

`src/lib/golden-set/loader.ts` reads and checks this shape. Run its tests with
`pnpm test -- src/lib/golden-set`.

## Image naming convention

An image's filename, without the extension, must equal its case's `caseId`:

```
golden-set/images/<caseId>.<jpg|jpeg|png>
```

The loader accepts all three extensions for any case. In practice, a `rendered` or
`rendered+degraded` case must use `.jpg` or `.jpeg` — `scripts/golden/build.ts` always encodes
to JPEG (mozjpeg), so a `.png` path on one of these cases would hold JPEG bytes under a PNG
name. `.png` stays available for a future `ai-generated` case (LH-005), whose image comes
straight from Imagen rather than through `build.ts`'s JPEG encode step.

Example: case `case-14-case-variant-brand-stones-throw` pairs with
`golden-set/images/case-14-case-variant-brand-stones-throw.jpg` — now a real file. The loader
checks this convention (`validateManifest` in `loader.ts`) independently of whether the file
exists; `scripts/golden/build.ts` is what makes the naming convention true for every
`rendered` / `rendered+degraded` case.

This mirrors the batch-upload pairing rule in PRD §3.5: deterministic pairing by filename,
never by upload order or a separate lookup table.

**`photographed` cases follow a different convention** (TRO-529 / LH-024, "Real-photograph
cases" above): `assets/golden/references/<original-filename>.<jpg|jpeg|png>`, keeping the
photograph's own name rather than renaming it to match `caseId`. Example: case
`case-38-glare-real-photo-crown-royal` pairs with
`assets/golden/references/crown-royal-warning-label-closeup.png`.

## The 12 required test categories (PRD §6)

38 cases across all 12 categories named in the PRD: clean match, ABV mismatch, title-case
warning, reworded warning, missing warning, case-variant brand, glare, rotation, low light,
tiny warning text, odd typography, and conflicting application-vs-label data. Two cases carry
the brief's named examples directly:

- `case-14-case-variant-brand-stones-throw` — Dave Morrison's exact example (TH-R8):
  `STONE'S THROW` on the label, `Stone's Throw` on the application, must MATCH.
- `case-08-title-case-warning-prefix-only` — Jenny Park's exact catch (TH-R9): `Government
  Warning` in title case on the label instead of `GOVERNMENT WARNING`, must FAIL.

Case counts lean toward the categories most likely to need several variants: clean match (8),
abv-mismatch (3), case-variant-brand (3), conflicting-application-vs-label (3), title-case
warning (3), reworded warning (3), and glare (3). Rotation is the biggest group at 5: TRO-529 /
LH-024's three curved/warped real photographs (`case-36`, `case-37`, `case-39`) join the two
existing rendered rotation cases. Missing warning and low light each have 2, and odd typography
has 2. Tiny warning text has 1. TRO-516 C5 merged `case-24-tiny-warning-text-miniature-bottle`
into `case-23-tiny-warning-text-standard-bottle` on 2026-08-13 — both printed the warning at
the same 9px size, on the same canvas. The freed slot goes to a genuinely different sample
later. Clean match carries every format-variant vector (V1, V6, V7) that needs a
fully-matching label to isolate cleanly, plus one of TRO-529's real photographs (`case-35`),
plus TRO-532/TRO-528's two bold-type cases (`case-33`, `case-34` — see below). That is why it
is the largest group.

**TRO-469 / LH-021 added two cases**, closing two gaps `docs/checkpoints/cp2-warning-subsystem.md`
§9.2 named at CP-2 (both ship with reasoning and no covering case until this ticket, and both
are TTB-documented real mistakes, not invented ones — CP-2 §2.6). Numbered `case-31`/`case-32`,
not `case-30`, because TRO-515's `case-30-clean-match-net-contents-alt-format` (above) landed
on `main` first:

- `case-31-title-case-warning-surgeon-general-lowercase` (finding 5) — the warning body prints
  `surgeon general` in lower case; the `GOVERNMENT WARNING` prefix stays all-caps. Covers the
  `Surgeon`/`General` capitalization positions CP-2 §5.4 added on TTB's own checklist
  authority, which no case exercised before.
- `case-32-reworded-warning-near-miss-missing-comma` (finding 4) — the warning omits the comma
  after `General`, a genuine one-character (near-miss-band) deviation. Covers CP-2 §5.5's
  proposed near-miss band (edit distance 1–2), which no case exercised before — the golden
  set's other reworded-warning cases sit at distance 24 and 38, far outside it.

**TRO-532/TRO-569 and TRO-528 fill the two bold-type cases**, `case-33` and `case-34` —
the opposite ground truth from every other warning-bearing case, which all carry
`governmentWarningPrefixBold: true`:

- `case-33-not-bold-warning-prefix` — wording and capitalization are exact, but the prefix
  does not print bold. `expected.labelVerdict` is `REVIEW` (TRO-569 / INT-005): the router
  now reads the pixel-measured bold signal at exactly the MATCH -> REVIEW edge, so a
  compliant-except-for-bold-type label routes to a human instead of passing silently.
- `case-34-bold-body-warning-violation` — the prefix IS bold (compliant), but the warning
  BODY also prints bold, which 27 CFR 16.22(a)(2) forbids. `expected.labelVerdict` stays
  `PASS`: nothing in this pipeline measures body bold, so this case documents that limitation
  with a real rendered image rather than only a comment — see that case's own `notes`.

**TRO-529 / LH-024 added five real-photograph cases**, `case-35` through `case-39`. See
"Real-photograph cases" above for the provenance mechanics. This is the case-by-case list:

- `case-35-clean-match-real-photo-flat-scan` — a flat, straight-on scan. The only asset in the
  corpus that measurably shows the statute's required bold prefix (stroke-width ratio 2.2).
- `case-36-rotation-real-photo-gentle-curve` — a real bottle, warning curved gently around the
  glass. Full warning legible. Bold cannot be measured; there is no stroke-width separation.
- `case-37-rotation-real-photo-severe-curve-partial-crop` — strong curve and shallow depth of
  field. Only warning fragments are legible. Every other required field is out of frame. This
  is the one case in this batch whose `expected.fields.governmentWarning` is `NEEDS_REVIEW`,
  not `MATCH` — TH-R10's "explicit unreadable outcome" half, by design.
- `case-38-glare-real-photo-crown-royal` — a real Crown Royal warning panel, curved gold on
  maroon, with glare. A live trademark appears in frame (Troy's 2026-08-12 call).
- `case-39-rotation-real-photo-coppola-wraparound` — a real Francis Ford Coppola Winery warning
  panel under extreme wrap-around curvature. A live trademark appears in frame.

Every one of the five is a real, physical government-warning panel. Each is hand-transcribed
character for character — never corrected, never completed from memory of the canonical text.
Each case's `notes` field records its measured edit distance against `CANONICAL_WARNING_TEXT`
and the reasoning behind every `"unknown"` bold value. `docs/reference-photo-provenance.md`
records what all six files in `assets/golden/references/` show. It names where each came from
and whether a live trademark appears. That includes the sixth file: a full bottle shot,
`spirits-bottle-01.jpg`. This ticket documents that file but does not adopt it as a case — it
belongs to the parked realistic-corpus backdrop track (LH-028).
