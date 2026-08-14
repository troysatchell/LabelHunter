# Wild labels (LH-027 / TRO-530)

Design doc §5, job 2 (`docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md`):
about 5 label images generated whole by Gemini, no bottle, no backdrop, no compositing — just
varied label artwork. Fictional brands only.

## Why these cases live here, not in `golden-set/manifest.json`

`src/lib/golden-set/loader.ts`'s `checkCase` refuses to load ANY manifest that contains a
`provenance: "ai-generated"` case with `verified: false`. The check does not skip that one
case — it fails the whole manifest, for every caller (`loadGoldenSetManifest()` has no
override for this repo's ~30 other test files, the eval harness, or the latency harness).

Setting `verified: true` is Troy's decision alone, made after he confirms a transcription
against the real image (this repo's standing rule). This ticket's brief is explicit: leave
`verified: false` on every new case, and do not set it under any circumstance.

Those two facts together mean these 5 cases cannot land in `golden-set/manifest.json` yet
without either breaking the loader for the whole repo, or someone other than Troy setting
`verified: true`. So they stage here instead — the same pattern job 1 (backdrops,
`golden-set/backdrops/`) already established: the generator writes real, committed output; a
human folds it into the manifest later, in the same change that sets `verified: true`.

## What's here

- `case-NN-<slug>.png` — the real, committed image Gemini generated. Nothing else has touched
  it: no crop, no compositing, no warp.
- `case-NN-<slug>.meta.json` — a forensic sidecar: the exact prompt sent, the real per-call
  token usage, the real computed cost, and generation metadata (model, resolution, prompt
  version, timestamp). Written by `scripts/golden/imagen.ts`'s `generateWildLabelOne`.
- `candidates.json` — the 5 candidate `GoldenSetCase` entries, hand-authored by transcribing
  each committed image directly (zoomed in where needed — see each case's own `notes` field).
  `imagePath` here points at this staging directory, not `golden-set/images/` — see "Folding a
  case in" below for the one-line fix that changes at fold-in time.
- `results/wild-eval-report.json` — real, live evidence: every candidate run through the exact
  cascade `scripts/eval/check.ts` uses (`runOneCase`, `scripts/golden/wildLabelEval.ts`).
  Real Haiku extraction, and a real Sonnet resolver call for every case that escalates.

## Generating more (or regenerating)

```bash
pnpm golden:imagen:wild
```

Network, costs real money (~$0.07/image at this model's 1K-resolution standard-tier price —
see `imagen.ts`'s `computeWildLabelCostUsd` for the exact, live-confirmed pricing this is
computed from). Run manually; never wired into CI (design doc §2: "CI never calls an image
API"). Edit `scripts/golden/wildLabelPrompt.ts`'s `WILD_LABEL_REQUESTS` to change what gets
requested — layout, typeface, color, and warning placement vary across the 5 entries there,
each with a real fictional brand.

Scoring the candidates against the real cascade:

```bash
pnpm golden:wild-eval
```

Also network, also costs real money (Haiku, plus Sonnet for any case that escalates). Writes
`results/wild-eval-report.json`. Never touches `scripts/eval/baseline.json` or the committed
`eval-report.json` — this is a standalone, informational run over cases the committed baseline
does not include yet, the same posture `check.ts`'s own `--case=<id>` debug mode documents.

## Ground truth flows FROM the image

Every `label` field in `candidates.json` was transcribed by looking at the committed PNG, not
copied from the prompt that requested it (`WILD_LABEL_REQUESTS`). Two of the five cases show a
real generation defect neither the design brief nor the request text asked for:

- **case-40**: the warning renders with a duplicated word fragment ("alcoholic holic
  beverages"). Legible, but wrong.
- **case-41**: the warning renders as tiny print rotated 90 degrees, with visible additional
  corruption. Genuinely hard to read even zoomed in — the case's own `notes` field says so
  explicitly rather than asserting false confidence.

A wild label whose warning renders garbled is not a failed generation. It is a valid case, and
`expected.labelVerdict` reflects that (REVIEW or, where the deviation is severe enough, FAIL —
see each case's own `expected` block).

**A second, real finding.** `pnpm golden:wild-eval` ran twice: once against a first-pass,
human-only ground truth, and once after correcting it. Three cases — case-40, case-42, and
case-44 — trip CP-2 §4.5's dual-channel disagreement rule. The OCR corroboration channel
disagrees with Haiku's own vision reading on these three, even though Haiku's reading is
independently confirmed correct. CP-2 §4.5's own table routes any such disagreement to
`REVIEW`/`WARNING_MISMATCH`, regardless of which channel is actually right. This happens on
decorative, real-world-style typefaces and paper-texture backgrounds. The renderer's plain
sans-serif corpus never exercises this path. A first-pass ground truth called case-42 and
case-44 a clean PASS, reasoning only "a human can read this correctly." That reasoning misses
CP-2 §4.5's own rule. `candidates.json`'s current `expected` blocks reflect the correction,
backed by `results/wild-eval-report.json`'s real run. This is exactly the kind of
real-artwork-variety evidence the ticket exists to surface (see `../README.md`'s "still not
done" note, and the ticket body's "why" section).

**Scope note: `expected` predicts the ROUTER's decision, not the cascade's post-resolver end
state.** This matches the main manifest's own documented convention
(`src/lib/golden-set/types.ts`'s `GoldenExpectedResult` comment; `scripts/eval/check.ts`'s
module comment on why verdict accuracy is scored at the router level). The committed
`wild-eval-report.json` also reports each case's `cascadeVerdict` — the real, post-resolver
answer a live user of this app would actually see. For case-42 and case-44, the cascade's real
end state is `PASS`: Sonnet correctly resolves the router's dual-channel escalation back to the
right answer. That is the cascade working as designed (TH-R19), not a ground-truth error —
`cascade-runner.ts`'s own documented "honest limit" on warning-field resolution explains why a
router-level `MISMATCH` never survives a resolver merge unchanged, and this repo's eval harness
already treats router/cascade divergence as informational, never a scoring defect.

## Folding a case in (Troy's step — not this ticket's)

Once Troy confirms a case's transcription against its committed image:

1. `git mv golden-set/wild-labels/<caseId>.png golden-set/images/<caseId>.png`
2. In the case's `candidates.json` entry, change `imagePath` from
   `"golden-set/wild-labels/<caseId>.png"` to `"golden-set/images/<caseId>.png"`.
3. Set `verified: true`.
4. Move the whole case object from `candidates.json`'s `cases` array into
   `golden-set/manifest.json`'s `cases` array.
5. Drop the `notes` field's `PENDING FOLD-IN` / `EXPECTED VERDICT CORRECTED` process language —
   the case is now a normal manifest entry, not a staged candidate. Keep any content-relevant
   part of the note (e.g. the transcription-confidence caveat on case-41) if it still helps a
   future reader.
6. Remove the folded case from `candidates.json`. Once every case is folded, this whole
   directory can be deleted (or kept for the next `pnpm golden:imagen:wild` run).
7. Run `pnpm golden:verify` — confirms the image resolves and no vector-coverage check broke.
8. Run the re-baseline protocol (`.claude/skills/labelhunter-factory/references/lessons.md`
   rule 32) — folding a case into the manifest is exactly the kind of golden-set content change
   that rule covers, even though generating and staging the image (this ticket) was not.

## Real spend, this ticket

Every dollar figure below comes from a real API response's own usage data (`.meta.json`
sidecars for image generation; `results/wild-eval-report.json` for eval scoring), never an
estimate. See `CHANGES.md`'s TRO-530 entry for the full, itemized total, including one
discarded probe call and one superseded eval run.
