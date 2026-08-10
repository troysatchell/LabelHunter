# Golden set

The golden set is a fixed collection of label test cases (TH-R12). Each case pairs a label
image with ground-truth data: what the application form says, what the label actually shows,
and what the Validation Router should decide. Later tickets use it two ways:

- **Eval harness** (PRD §6): scores the Haiku extractor and the Validation Router against
  this ground truth.
- **Demo set**: seeds the deployed instance so evaluators can try the app without uploading
  their own labels (PRD §7).

## Known gap: no images yet

**This ticket (TRO-458 / LH-003) ships the ground-truth data and the pairing convention. It
does not ship the label images.** `golden-set/images/` is empty. Every `imagePath` in
`manifest.json` points at a file that does not exist yet.

Why: generating the images needs an AI image-generation tool or a camera, and the agent that
wrote this manifest has neither. Writing placeholder files with a `.jpg` extension would be
worse than leaving the directory empty — a placeholder passes a file-existence check while
being useless for extraction testing, which hides the gap instead of naming it.

**What a follow-up needs to do:** generate or source 29 label images (AI image generation
per the brief, TH-R12; a few real bottle photos per PRD §12 risk mitigation), and save each
one at the `imagePath` its case already names in `manifest.json`. The case's `label` field
in the manifest is the spec for what the image must show — brand, class/type, ABV, net
contents, government warning text, and (for the image-defect categories) the specific visual
flaw the `notes` field describes. LH-021 ("Warning cases in golden set + eval") is the ticket
that most directly depends on this landing.

## Manifest format

`manifest.json` holds one JSON object: `{ "version": "1.0.0", "cases": [...] }`. Each entry
in `cases` is a `GoldenSetCase` — the TypeScript type is the schema of record, at
`src/lib/golden-set/types.ts`. A case has five parts:

| Field | What it holds |
|---|---|
| `caseId`, `description`, `category`, `beverageType` | Identity: a unique ID, a one-line summary, which of the 12 required test categories the case belongs to, and beer/wine/spirits. |
| `imagePath` | Where the label image lives (see naming convention below). Not yet a real file — see "Known gap" above. |
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
