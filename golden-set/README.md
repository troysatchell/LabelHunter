# Golden set

The golden set is a fixed collection of label test cases (TH-R12). Each case pairs a label
image with ground-truth data: what the application form says, what the label actually shows,
and what the Validation Router should decide. Later tickets use it two ways:

- **Eval harness** (PRD §6): scores the Haiku extractor and the Validation Router against
  this ground truth.
- **Demo set**: seeds the deployed instance so evaluators can try the app without uploading
  their own labels (PRD §7).

## Known gap: no images yet

**This ticket ships the ground-truth data, the pairing convention, and the ai-generated /
verified provenance rules. It does not yet ship the label images or the renderer that
produces them.** `golden-set/images/` is empty. Every `imagePath` in `manifest.json` points
at a file that does not exist yet.

The image-generation approach is now decided (2026-08-10, approved with Troy):
`docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md` — a render-first hybrid.
An HTML/CSS→PNG renderer (`scripts/golden/render.ts`, Playwright, committed fonts) produces
exact-text label images for every case in this manifest (`provenance: "rendered"` or
`"rendered+degraded"`); Gemini/Imagen is used only for realism at the edges — backdrops and a
handful of fully AI-generated "wild" labels (`provenance: "ai-generated"`, requiring
`verified: true` before the eval harness may use them — see the loader's validation). That
renderer, plus the degradation pass and the Imagen step, are **not built yet** — they are
tracked as their own tickets (LH-004 degradation, LH-005 Imagen, LH-006 verify gate + CI
smoke), all downstream of this one. This ticket's job was the spec schema and the 29 cases;
producing pixels is the next ticket's job.

Writing placeholder files with a `.jpg` extension would be worse than leaving the directory
empty — a placeholder passes a file-existence check while being useless for extraction
testing, which hides the gap instead of naming it.

**Known rubric-vector gap (`audit/rubric.md` Appendix A):** every case is tagged with the
vectors it provides evidence for (`vectors` field). Two vectors currently have **no** covering
case: **V7** (net-contents format match, e.g. `"750 mL"` vs `"750ml"` — no case isolates this
as its distinguishing feature) and **V10** (batch of ≥20 — a property of the manifest as a
whole, not any single case; the manifest's 29 cases already satisfy the ≥20 count, but no case
individually claims V10). `loader.test.ts` asserts these two gaps explicitly so they can't
silently drift — closing V7 means adding a case, not editing the test's exclusion list.

## Manifest format

`manifest.json` holds one JSON object: `{ "version": "1.0.0", "cases": [...] }`. Each entry
in `cases` is a `GoldenSetCase` — the TypeScript type is the schema of record, at
`src/lib/golden-set/types.ts`. A case has five parts:

| Field | What it holds |
|---|---|
| `caseId`, `description`, `category`, `beverageType` | Identity: a unique ID, a one-line summary, which of the 12 required test categories the case belongs to, and beer/wine/spirits. |
| `imagePath` | Where the label image lives (see naming convention below). Not yet a real file — see "Known gap" above. |
| `provenance` | How the (not-yet-existing) image will be produced: `rendered`, `rendered+degraded`, or `ai-generated`. Design doc §2/§5. |
| `verified` | `true` only once a real image exists and a human confirmed it matches its spec. Required `true` for any `ai-generated` case before the eval harness may use it — enforced by the loader, not just documentation. Every case here is `false`; no images exist yet. |
| `vectors` | Which `audit/rubric.md` completion vectors (V1–V10) this case is evidence for. May be empty. See the known-gap note above for V7/V10. |
| `application` | The five example fields as filed on the application (PRD §2, §5, TH-R11). |
| `label` | The same fields as a careful human reader sees them on the label, plus warning-specific detail (`governmentWarningPrefixAllCaps`, presence flags). |
| `expected` | The Validation Router's expected output: a verdict + one-line reason per field, a label-level verdict, and — only when the label-level verdict is `REVIEW` — the `ReviewReason` that routes the label to the Sonnet resolver (PRD §3.3). |

`src/lib/golden-set/loader.ts` reads and checks this shape. Run its tests with
`pnpm test -- src/lib/golden-set`.

## Image naming convention

An image's filename, without the extension, must equal its case's `caseId`:

```
golden-set/images/<caseId>.<jpg|jpeg|png>
```

Example: case `case-14-case-variant-brand-stones-throw` pairs with
`golden-set/images/case-14-case-variant-brand-stones-throw.jpg`. The loader checks this
convention (`validateManifest` in `loader.ts`) even though the file itself doesn't exist yet
— when someone drops the real image in at that exact path, no manifest edit is needed.

This mirrors the batch-upload pairing rule in PRD §3.5: deterministic pairing by filename,
never by upload order or a separate lookup table.

## The 12 required test categories (PRD §6)

29 cases across all 12 categories named in the PRD: clean match, ABV mismatch, title-case
warning, reworded warning, missing warning, case-variant brand, glare, rotation, low light,
tiny warning text, odd typography, and conflicting application-vs-label data. Two cases carry
the brief's named examples directly:

- `case-14-case-variant-brand-stones-throw` — Dave Morrison's exact example (TH-R8):
  `STONE'S THROW` on the label, `Stone's Throw` on the application, must MATCH.
- `case-08-title-case-warning-prefix-only` — Jenny Park's exact catch (TH-R9): `Government
  Warning` in title case on the label instead of `GOVERNMENT WARNING`, must FAIL.

Case counts lean toward the categories most likely to need several variants: clean match (4),
abv-mismatch (3), case-variant-brand (3), and conflicting-application-vs-label (3). Every
other category has 2.
