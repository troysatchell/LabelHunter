# Golden set

The golden set is a fixed collection of label test cases (TH-R12). Each case pairs a label
image with ground-truth data: what the application form says, what the label actually shows,
and what the Validation Router should decide. Later tickets use it two ways:

- **Eval harness** (PRD §6): scores the Haiku extractor and the Validation Router against
  this ground truth.
- **Demo set**: seeds the deployed instance so evaluators can try the app without uploading
  their own labels (PRD §7).

## Images: rendered and degraded (LH-004, TRO-497)

`golden-set/images/` now holds a real, committed JPEG for every `rendered` and
`rendered+degraded` case. That is 30 of 30 cases. Total size: about 1.14 MB. Largest file:
47.6 KB. Every image stays well under the ~500 KB per-image target.

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

`assets/golden/references/` is still empty. No case in this manifest has provenance
`"rendered+ai-backdrop"` yet.

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
vectors it provides evidence for (`vectors` field). All ten vectors have at least one covering
case today. **V10** (batch of ≥20) is a property of the manifest as a whole, not any single
case. The manifest's 30 cases satisfy the ≥20 count, but no case individually claims V10.
`loader.test.ts` asserts this explicitly, so V10's coverage can't silently drift.

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

## Manifest format

`manifest.json` holds one JSON object: `{ "version": "1.0.0", "cases": [...] }`. Each entry
in `cases` is a `GoldenSetCase` — the TypeScript type is the schema of record, at
`src/lib/golden-set/types.ts`. A case has these parts:

| Field | What it holds |
|---|---|
| `caseId`, `description`, `category`, `beverageType` | Identity: a unique ID, a one-line summary, which of the 12 required test categories the case belongs to, and beer/wine/spirits. |
| `imagePath` | Where the label image lives (see naming convention below). A real committed file for every `rendered` / `rendered+degraded` case (LH-004); still absent for a future `ai-generated` case until LH-005 adds one. |
| `provenance` | How the image was (or will be) produced: `rendered`, `rendered+degraded`, or `ai-generated`. Design doc §2/§5. |
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

## The 12 required test categories (PRD §6)

30 cases across all 12 categories named in the PRD: clean match, ABV mismatch, title-case
warning, reworded warning, missing warning, case-variant brand, glare, rotation, low light,
tiny warning text, odd typography, and conflicting application-vs-label data. Two cases carry
the brief's named examples directly:

- `case-14-case-variant-brand-stones-throw` — Dave Morrison's exact example (TH-R8):
  `STONE'S THROW` on the label, `Stone's Throw` on the application, must MATCH.
- `case-08-title-case-warning-prefix-only` — Jenny Park's exact catch (TH-R9): `Government
  Warning` in title case on the label instead of `GOVERNMENT WARNING`, must FAIL.

Case counts lean toward the categories most likely to need several variants: clean match (5),
abv-mismatch (3), case-variant-brand (3), and conflicting-application-vs-label (3). Every
other category has 2. Clean match is the largest group because it also carries every
format-variant vector (V1, V6, V7) that needs a fully-matching label to isolate cleanly.
