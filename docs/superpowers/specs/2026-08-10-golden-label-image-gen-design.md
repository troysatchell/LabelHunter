# Design: Golden Label Image-Gen Pipeline

**Date:** 2026-08-10
**Status:** approved (brainstorm session with Troy)
**Serves:** TH-R12 (test-label set), TH-R10 (imperfect images), rubric F2 and Appendix A vectors V1–V10, PRD §6 golden set
**Decision:** render-first hybrid. A spec-driven renderer produces exact-text labels. Imagen adds realism at the edges. Approach chosen over AI-gen-first because image models mangle long exact text, and a mangled warning silently flips ground truth.

## 1. Goal

Ship a committed set of ~26 beverage-label images with trusted ground truth. The eval
harness, the demo, and the rubric vectors all consume this one set.

Success criteria:

1. Every rubric vector V1–V10 has at least one covering asset.
2. Every image has a ground-truth spec. The spec states the expected verdict per field.
3. One command regenerates the set. CI verifies consistency without network calls.

## 2. Layout

```
assets/golden/
  specs/*.json      # ground truth, hand-authored
  images/*.png      # committed output
  manifest.json     # generated index: spec ↔ images ↔ vectors
scripts/golden/
  render.ts         # spec → HTML/CSS label → PNG (Playwright)
  degrade.ts        # PNG → rotated / glared / dimmed / blurred PNG (sharp)
  imagen.ts         # Gemini API: backdrops + wild labels
  verify.ts         # consistency + coverage checks (CI gate)
  build.ts          # orchestrator: specs in, images + manifest out
```

Rules:

- Images are committed. CI runs `verify.ts` plus one headless render smoke (§7). CI never
  calls an image API.
- `GOOGLE_API_KEY` lives in `.env.local` only, documented in `.env.local.example`.
- Fonts are committed to the repo. Rendering uses a fixed viewport. Regeneration must not
  drift.

## 3. Spec schema

One JSON file per label. The spec is the ground truth the eval harness trusts.

| Field | Content |
|---|---|
| `id` | slug, matches filenames |
| `beverageType` | `spirits` \| `beer` \| `wine` |
| `provenance` | `rendered` \| `rendered+degraded` \| `ai-generated` |
| `label` | brand, classType, alcoholContent, netContents, warning |
| `label.warning` | `variant`: `exact` \| `title-case` \| `reworded` \| `missing` \| `tiny`; `text`: the literal string on the label |
| `application` | the paired application record; conflicts with `label` where the case demands |
| `degradations` | list: `rotate` \| `perspective` \| `glare` \| `low-light` \| `blur` (with parameters) |
| `expected` | per-field verdict in the PRD 3-state model, plus overall verdict and `reviewReason` where routed |
| `vectors` | rubric vectors this asset covers, e.g. `["V2"]` |
| `verified` | boolean; required `true` before eval uses an `ai-generated` spec |

Independence rule: the statutory warning constant lives in `src/server/warning`. Specs carry
their own literal copy. One test asserts the two literals match where `variant: exact`. The
generator and the verifier never share a code path.

## 4. Coverage matrix

~18 base labels → ~26 images.

| Group | Cases | Vectors |
|---|---|---|
| Clean matches | bourbon (OLD TOM per brief), one beer, one wine | V1 |
| Warning variants | exact, title-case, reworded, missing, tiny text | V1, V2, V3, V4 |
| Judgment matching | STONE'S THROW vs Stone's Throw; `45% Alc./Vol. (90 Proof)` vs `45%`; `750 mL` vs `750ml`; genuinely different brand | V5, V6, V7, V8 |
| Conflicting data | application and label disagree on one field | — |
| Degradations | rotation, glare, low light on clean bases; blur to unreadable | V9, bonus X1 |
| Wild labels | ~5 fully Imagen-generated; ground truth transcribed by hand | realism evidence |
| Batch set | ≥20 of the above + CSV pairing file | V10 |

`verify.ts` fails when any vector V1–V10 has no covering asset.

## 5. Imagen usage

Gemini API image generation does two jobs only:

1. **Backdrops.** ~6 bottle/scene photographs. `sharp` composites rendered labels onto them.
2. **Wild labels.** ~5 complete labels generated from prompts. We transcribe the text that
   actually rendered into each spec. A human check sets `verified: true`.

Estimated cost: under $5 for the full set. This is a dev-time dependency only — the running
app has no Google surface. `docs/approach.md` records this for TH-R7.

## 6. QA gates

- `verify.ts` checks: every image has a spec, every spec's images exist, manifest is current,
  vector coverage is complete, `ai-generated` specs are `verified` or excluded from eval.
- CP-2 (existing unskippable checkpoint) reviews the golden set. The set lands with or
  before CP-2.
- Never weaken a spec to make an eval pass (CLAUDE.md non-negotiable applies).

## 7. Testing

- **Vitest:** spec-schema validation; warning-variant templating; the exact-literal match
  test from §3.
- **CI smoke:** render one label headlessly, then run `verify.ts`. No network.
- **Consumers:** the eval harness and latency harness (PRD §6, separate tickets) read
  `manifest.json`.

## 8. Out of scope

- Real bottle photographs (PRD risk table lists them as a mitigation; add later if CP-2
  review finds the set unconvincing).
- Bold-weight detection on the warning (documented limitation, PRD §7).
- Any runtime image generation in the app.
