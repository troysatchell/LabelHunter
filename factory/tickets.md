# LabelHunter — ticket decomposition

Source: `docs/PRD.md` (architecture + scope) × `audit/requirements/inventory.md` (TH-R1..R23).
Mirrored to Linear (team `Troysatchell`, project `LabelHunter`). Local IDs `LH-*` below are
stable keys for this file; the Linear identifier (`TRO-nnn`) is recorded next to each after
creation. Checkpoint tickets **block** their gated wave via Linear relations.

Priorities follow TH-R23: working core (Urgent/High) before ambition (Medium/Low).
Every ticket's DoD includes the factory gate; entries below list only ticket-specific DoD.

## Linear mapping (created 2026-08-10, all blocking relations set; LH-004..006 added
2026-08-10 — golden-set decomposition per the approved image-gen spec)

| LH | TRO | | LH | TRO | | LH | TRO | | LH | TRO |
|---|---|---|---|---|---|---|---|---|---|---|
| LH-001 | TRO-456 | | LH-012 | TRO-462 | | LH-030 | TRO-470 | | LH-052 | TRO-478 |
| LH-002 | TRO-457 | | LH-013 | TRO-463 | | LH-031 | TRO-471 | | LH-053 | TRO-479 |
| LH-003 | TRO-458 | | LH-014 | TRO-464 | | LH-CP3 | TRO-472 | | LH-054 | TRO-480 |
| LH-CP1 | TRO-459 | | LH-015 | TRO-465 | | LH-040 | TRO-473 | | LH-060 | TRO-481 |
| LH-010 | TRO-460 | | LH-016 | TRO-466 | | LH-041 | TRO-474 | | LH-061 | TRO-482 |
| LH-011 | TRO-461 | | LH-CP2 | TRO-467 | | LH-042 | TRO-475 | | LH-062 | TRO-483 |
| LH-004 | TRO-497 | | LH-020 | TRO-468 | | LH-050 | TRO-476 | | LH-063 | TRO-484 |
| LH-005 | TRO-498 | | LH-021 | TRO-469 | | LH-051 | TRO-477 | | LH-064 | TRO-485 |
| LH-006 | TRO-499 | | | | | | | | LH-065 | TRO-486 |
| | | | | | | | | | LH-070 | TRO-487 |

Wave 2b added 2026-08-12 — the bold rule and the real-label corpus:

| LH | TRO | | LH | TRO | | LH | TRO |
|---|---|---|---|---|---|---|---|
| LH-022 | TRO-527 | | LH-025 | TRO-532 | | LH-028 | TRO-531 |
| LH-023 | TRO-528 | | LH-026 | TRO-533 | | | |
| LH-024 | TRO-529 | | LH-027 | TRO-530 | | | |

Wave 2c added 2026-08-12 — fixes from the eval diagnosis:

| LH | TRO | | LH | TRO | | LH | TRO |
|---|---|---|---|---|---|---|---|
| LH-029 | TRO-534 | | LH-033 | TRO-538 | | LH-036 | TRO-541 |
| LH-030b | TRO-535 | | LH-034 | TRO-539 | | LH-037 | TRO-542 |
| LH-031b | TRO-536 | | LH-035 | TRO-540 | | LH-038 | TRO-543 |
| LH-032 | TRO-537 | | | | | | |

---

## Wave 0 — bootstrap

### LH-001 · Scaffold: Next.js + TS + Vitest + Playwright + Drizzle + CI  [Urgent]
TH-R13, TH-R18, TH-R19. Blocks: everything (via LH-CP1, LH-002, LH-003).
pnpm; strict tsconfig; real eslint config (a configless lint is not wired into the gate);
vitest with JSON reporter; playwright; drizzle + pg; `db:migrate` script; scripts:
`typecheck`, `lint`, `build`, `test`, `test:e2e`. Repo layout per PRD §3.6.
**DoD (factory-critical):** convert `planned:` → `detected:` in `factory/config.yaml` with
measured rc/durations; measure green-on-arrival into `factory/quarantine.json`; run EVERY
gate verification check (no-op branch fails; forged break-one/fix-one caught; quarantine not
widenable from branch; worktree.sh twice-in-a-row; CI executed on a real PR) and record
results. **The factory trusts nothing until this lands.** GitHub repo creation/first push is
a hard stop (escalation gate 4).

### LH-002 · Database schema + migrations  [Urgent]
TH-R6, TH-R22 groundwork. Blocked by LH-001.
Tables per PRD §3.6: `applications`, `label_images`, `batch_jobs`, `verifications`,
`field_results`, `review_queue`. No PII anywhere. Numbered migrations; seed script for dev.

### LH-003 · Golden set core: spec schema + renderer + clean base labels  [High]
TH-R12. Blocked by LH-001. Design: `docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md`.
Render-first: hand-authored ground-truth specs (`assets/golden/specs/*.json`, schema per
design §3) drive an HTML/CSS→PNG renderer (`scripts/golden/render.ts`, Playwright, committed
fonts, fixed viewport). Base labels cover: 3 clean matches (OLD TOM bourbon + beer + wine),
5 warning variants (exact/title-case/reworded/missing/tiny), judgment cases (STONE'S THROW,
ABV format, net-contents format, different brand), conflicting application-vs-label data.
Exact warning text is guaranteed by the renderer, never by an image model. `build.ts`
orchestrates. Images committed. Reviewed at CP-2.

### LH-004 · Golden set: degradation pass  [High]
TH-R12, TH-R10. Blocked by LH-003.
`scripts/golden/degrade.ts` (sharp): rotate, perspective, glare overlay, low-light, blur.
Derives imperfect-image variants from clean bases so ground truth carries over unchanged.
Covers rubric V9 (blur-to-unreadable) + bonus X1 set. Parameters recorded in each spec's
`degradations` list.

### LH-005 · Golden set: Imagen backdrops + wild labels  [Medium]
TH-R12. Blocked by LH-003.
`scripts/golden/imagen.ts` (Gemini API image generation): ~6 bottle/scene backdrops that
sharp composites rendered labels onto, and ~5 fully generated wild labels. Transcribe each
wild label's actually-rendered text into its spec; `verified: true` only after human check
(fold into CP-2 review). `GOOGLE_API_KEY` in `.env.local` only — provisioned by Troy
2026-08-10; `worktree.sh` passes it through to ticket worktrees, so no key hard stop remains.
Dev-time dependency only; runtime has no Google surface (TH-R7 note goes in approach.md via
LH-064).

### LH-006 · Golden set: verify gate + manifest + CI smoke  [High]
TH-R12, TH-R17. Blocked by LH-004, LH-005.
`scripts/golden/verify.ts`: every image has a spec, every spec's images exist, manifest
current, rubric vectors V1–V10 each covered by ≥1 asset, `ai-generated` specs `verified` or
excluded from eval. `manifest.json` is the consumer interface for eval/latency harnesses.
CI: verify.ts + one headless render smoke; no network, no image-API calls.

### LH-CP1 · ⛔ CHECKPOINT 1: cascade router + prompts walkthrough  [Urgent]
Blocks LH-010..LH-015. Prepare and present to Troy: Haiku extraction prompt + JSON schema
(value/evidence/confidence per field), confidence thresholds, ReviewReason routing rules,
Sonnet resolver prompt, plus the "defend it" Q&A. Explicit acknowledgment required.

## Wave 1 — single-label pipeline (gated by CP-1)

### LH-010 · Image preprocessing  [High]
TH-R10. Blocked by LH-CP1, LH-001. Resize ≤2576px, EXIF rotation, format validation,
oversized-file rejection with designed error state.

### LH-011 · Haiku extractor  [Urgent]
TH-R1, TH-R11. Blocked by LH-CP1, LH-002.
`claude-haiku-4-5`, vision, structured output (strict JSON schema). Every field carries
`value` + `evidence` (verbatim label text) + `confidence`. One call per label. A bare value
with no evidence string is unacceptable (provenance is a compliance feature).

### LH-012 · Validation router core  [Urgent]
TH-R2, TH-R8, TH-R19. Blocked by LH-CP1, LH-011.
Deterministic TS, no LLM. Per-field `MATCH | MISMATCH | NEEDS_REVIEW` + confidence + one-line
reason; label-level `PASS | FAIL | REVIEW`; routing via the explicit `ReviewReason` enum
(PRD §3.3). UI-facing reason strings, never bare confidence percentages. TDD.

### LH-013 · Field comparators  [Urgent]
TH-R8, TH-R11. Blocked by LH-012.
Normalizers (case/punctuation/whitespace/unicode) per field. Brand/class fuzzy compare —
STONE'S THROW ≡ Stone's Throw → MATCH with note (named test case); beyond threshold →
REVIEW, never silent FAIL. ABV: parse `45% Alc./Vol. (90 Proof)`, ABV↔proof arithmetic
cross-check, beverage-type rules (beer/wine/spirits selector adjusts ABV optionality). Net
contents: format + value + unit. TDD — every comparator a pure function, tests first.

### LH-014 · Sonnet resolver + review-queue insertion  [High]
TH-R1, TH-R22. Blocked by LH-012.
`claude-sonnet-5`, sees image + extraction + ReviewReason. Outcomes: resolved | needs-human →
`review_queue` with reason and resolver output. Never runs on the happy path.

### LH-015 · Verify screen + results checklist  [Urgent]
TH-R1, TH-R3, TH-R20. Blocked by LH-012.
One obvious primary flow: upload, application fields (5 example fields + beverage-type
selector), big Verify button. Results as Jenny's digitized checklist: ✓/✗/⚠ rows with
evidence + reason. Large type, high contrast, no hidden actions. USWDS-influenced, no AI slop.

### LH-016 · Detail view  [High]
TH-R3, TH-R20. Blocked by LH-015.
Label image side-by-side with extracted vs application per field, match badges, "Resolved by
Sonnet" annotations, warning expected-vs-detected diff.

## Wave 2 — warning subsystem (gated by CP-2)

### LH-CP2 · ⛔ CHECKPOINT 2: warning subsystem walkthrough  [Urgent]
Blocks LH-020, LH-021. Present: canonical text sourcing (verified verbatim against ttb.gov —
a ticket task, not an assumption), OCR choice (tesseract.js), normalization rules,
exact-compare, caps enforcement, bold-as-low-confidence-signal + limitation wording. Golden
set reviewed here too. Explicit acknowledgment required.

### LH-020 · Warning subsystem  [Urgent]
TH-R9. Blocked by LH-CP2, LH-012.
Own component. Dual path: VLM transcription + tesseract.js OCR → candidates → normalization →
**exact comparison** against canonical 27 CFR part 16 text. Exact → PASS; wording deviation →
FAIL; `Government Warning` title-case → FAIL with caps reason (named test); candidates
disagree / OCR low-confidence → REVIEW (`WARNING_MISMATCH` / `LOW_IMAGE_QUALITY`). Caps check
deterministic and hard-enforced; bold reported as `formatting.bold: true/false/uncertain`,
documented limitation.

### LH-021 · Warning cases in golden set + eval  [High]
TH-R9, TH-R12, TH-R17. Blocked by LH-020, LH-003. Ground-truth warning variants wired into
the eval harness; the Jenny title-case catch is a named case.

## Wave 2b — the bold rule + real-label corpus (added 2026-08-12)

27 CFR 16.22(a)(2) carries four rules. LH-020 and LH-021 closed the wording rule and the
capitalization rule. The two bold rules had no coverage and no ground-truth field. Measured
2026-08-12: every one of the 32 cases renders the prefix and the body at the same weight, so
the corpus scores a prefix/body stroke-width ratio of 1.00. A real compliant label scores 2.2.

### LH-022 · Golden-set bold ground truth + renderer bold prefix  [High]
TH-R9, TH-R12. Blocked by nothing. Two required fields on `GoldenLabelFields`
(`governmentWarningPrefixBold`, `governmentWarningBodyBold`), each typed
`boolean | "unknown"`; `render.ts` splits the warning at the first colon and drives each span's
weight from the spec; all 32 cases backfilled; images rebuilt. DoD adds: a test proves the two
spans rejoin byte for byte. The third state exists because a real photograph often supports
neither answer — recording `false` there would be a fabricated compliance claim against a
shipped product (LH-024).

### LH-023 · Bold-isolating golden cases (case-33, case-34)  [Medium]
TH-R9, TH-R12. Blocked by LH-022. One case per bold rule. Both expect PASS, because
LabelHunter does not check bold. They exist to measure a documented limitation, and they become
LH-025's regression fixtures.

### LH-024 · Real-label reference cases + reference provenance record  [High]
TH-R10, TH-R12. Blocked by LH-022. Adopt all five reference warning close-ups as cases by hand
transcription — no generation, no spend. Troy cleared the trademarked images on 2026-08-12, so
the set covers flat scan, gentle curve, strong curve, low contrast, and extreme wrap. That is
Jenny's exact ask (source-TH.md L34) with real photographs instead of `degrade.ts` transforms.
Needs a new `GoldenSetProvenance` value. Ships a provenance record for all six files in
`assets/golden/references/`. Record bold as `"unknown"` wherever the photograph cannot support
an answer — a `false` there is a compliance claim against a named real product, and we cannot
prove it. `verified` stays false until Troy confirms each transcription.

### LH-025 · Stroke-width bold advisory check  [Medium]
TH-R9. Blocked by LH-022, LH-024. Implements the v2 technique CP-2 §7.2 named and never tried.
Measured: 2.2 separation on a flat scan, no separation on three of four bottle photographs,
2 px stroke at the statutory 1 mm minimum. The signal stays advisory and never changes a
verdict. DoD adds: the eval output is identical with the check on and off.

### LH-026 · Surface the bold signal; fix the bold doc drift  [Medium]
TH-R9, TH-R15, TH-R20. Blocked by LH-025. `formatting.bold` is extracted and read by nothing.
PRD §2 credits bold to Sonnet, but `resolver/prompt.ts:44` forbids Sonnet from judging the
warning. Surface the signal, score it, and make CP-2 §7.3, `docs/approach.md`, and the README
carry the same limitation wording.

### LH-027 · Wild AI-generated labels (image-gen design §5, job 2)  [Medium]
TH-R12. Blocked by LH-022. About 5 flat label artworks from prompts, fictional brands only.
Ground truth is transcribed FROM each generated image, so a garbled warning is a valid case
rather than a failed generation. No bottle, no compositing, no warp. `verified: true` needs
Troy. Design doc §5 estimates the full set under $5.

### LH-028 · ⏸ AI-backdrop track: land the fixes, then park it  [Low — backlog]
TH-R10 (stretch). Backlogged by Troy, 2026-08-12. `source-TH.md` never asks for a bottle
photograph: agents review "label artwork" (L9), the sample label is a field list (L52–57), and
the one mention of a bottle is hedged as "maybe out of scope for a prototype" (L34).
`degrade.ts` already covers TH-R10 on flat artwork. Land the detector, prompt, composite, and
bottle-reference fixes so the code is parked correct, then stop. No further Gemini spend.


## Wave 2c — fixes from the 2026-08-12 eval diagnosis (added 2026-08-12)

A live eval run scored label-verdict accuracy at 21/32. A per-case diagnosis classified all eleven
misses: six are the pipeline's fault, five the corpus's. Full evidence in
`docs/diagnostics/2026-08-12-verdict-miss-triage.md` and `docs/diagnostics/2026-08-12-fix-tickets.md`.
True accuracy sits between 71.9% and 81.3%. A stricter count that also grades the ReviewReason
reads 18/32 = 56.25%.

### LH-029 · Guard the beverage_type cross-check  [Urgent]
TH-R9, TH-R17, TH-R19. The router compares a free-form extractor field against a closed enum by
string equality. case-11's label prints `Mead` against a declared `wine`; TTB classes mead as a
wine, so neither record is wrong. The blocker suppresses a real warning MISMATCH one line before
the rollup would return FAIL. Note: the fix does NOT move accuracy — case-11 turns correct and
case-22 turns incorrect.

### LH-030b · Sweep OCR_CONFIDENCE_FLOOR  [Urgent]
TH-R9, TH-R17, rubric V4. Tesseract returns 58 and 56 on the two tiny-print cases; the floor is 60,
so the OCR candidate is discarded and a statutory field passes on one channel. The floor is marked
"proposed" and CP-2 §12 assigned the sweep to LH-030 — the very run being diagnosed. Blocks
TRO-516's C4.

### LH-031b · Drop the apostrophe at normalizer step 6  [High]
TH-R8, TH-R17, rubric V5. `STONES THROW` vs `Stone's Throw` scores 0.923 against a 0.95 threshold.
Measured across all 32 cases, the fix moves exactly two scores and crosses the threshold once.

### LH-032 · Prove the warning FAIL path on a real image  [High]
TH-R9. Ruling INT-001. Both FAIL acceptance cases run on simulated channels today; only the PASS
case uses a real image. One test against the already-committed case-08 image closes it.

### LH-033 · Score the cascade end state; record per-field confidence  [Urgent]
TH-R17, TH-R19. The harness scores the router's interim verdict while the Sonnet-only arm is scored
post-resolution — the benchmark compares two different pipeline stages. The report also records no
confidence, no image_quality, and no beverage_type. **Blocks TRO-516.**

### LH-034 · Re-measure TH-R2 latency  [High]
TH-R2, TH-R15. The committed artifact predates the warning comparator by 73 minutes and says so in
its own `pipelineScope` field. Blocked by TRO-519 for the re-run; the `pipelineScope` string fix is
not blocked.

### LH-035 · Deskew a baked-in tilt before extraction  [Medium]
TH-R10 (stretch). EXIF-only rotation is a no-op on a pixel-baked tilt. Measured: deskew helps the
extraction half only — a perfect OCR read against an invented VLM read still returns REVIEW.

### LH-036 · Correct scripts/eval/args.ts's coverage claim  [Medium]
The comment claims the default sample exercises every ReviewReason family. Measured: it produced one.

### LH-037 · Record which LOW_IMAGE_QUALITY trigger fires  [Medium]
TH-R10 (stretch), TH-R19. Across 32 live cases both confidence-driven branches fired zero times.
CP-1 promises confidence "never decides anything alone"; two of the four triggers pair a self-report
with another self-report.

### LH-038 · Measure verdict variance  [High]
TH-R10, TH-R17, TH-R19. case-17 returns 3 REVIEW and 2 PASS across five committed runs on unchanged
code and an unchanged image. 28 of 29 shared cases are stable. Step 1 costs nothing.

## Wave E — evidence harnesses

### LH-030 · Eval harness  [Urgent]
TH-R17, TH-R19. Blocked by LH-006, LH-013.
Extraction accuracy + verdict accuracy vs ground truth; `pnpm eval:check` compares against a
committed baseline (gate G8 goes live); runs in CI; produces the cascade-vs-Sonnet-only
benchmark (keep the cascade regardless — the benchmark is the evidence, PRD §4).

### LH-031 · Latency harness  [High]
TH-R2. Blocked by LH-015.
Measured p50/p95 for single-label verify (target p50 ≤ 5s, realistic image) + batch
throughput; output captured as evidence; stats page shows real measurements only.

## Wave 3 — batch (gated by CP-3)

### LH-CP3 · ⛔ CHECKPOINT 3: batch queue walkthrough  [Urgent]
Blocks LH-040..LH-042. Present: queue design, worker concurrency (~5, tuned to Anthropic rate
limits with backoff), Sonnet sub-queue, partial-failure semantics. Explicit acknowledgment.

### LH-040 · Batch input: CSV manifest + images + pairing preview  [Urgent]
TH-R4, TH-R20. Blocked by LH-CP3, LH-002.
CSV (application fields + `image_filename`) + zip/multi-drop. Deterministic pairing by
filename; unmatched rows/images reported **before** the job starts, never silently dropped.
Malformed-CSV designed error state.

### LH-041 · Job queue + worker pool  [Urgent]
TH-R4. Blocked by LH-CP3, LH-011.
Postgres-backed queue; worker process (Render worker); concurrency ~5 with backoff; Sonnet
workers consume only the review sub-queue; one bad image fails that item, never the job.
Never serial per-image awaits.

### LH-042 · Batch progress + results UI  [High]
TH-R4, TH-R3, TH-R20. Blocked by LH-040, LH-041.
Polling endpoint → live summary (processed / auto-verified / resolved-by-Sonnet / needs-human /
avg + p95 latency). Results table (Label / Brand / ABV / Net / Warning / Status) →
click-through to detail.

## Wave 4 — review queue, resilience, polish

### LH-050 · Review queue UI  [High]
TH-R22. Blocked by LH-014. Needs-human items with reason; approve/reject records disposition.
The differentiator (TH-R22) — call it out in docs.

### LH-051 · Imperfect-image handling  [High]
TH-R10. Blocked by LH-012, LH-010. Glare/rotation/low-light golden cases produce correct
extraction or explicit `LOW_IMAGE_QUALITY` review — never a confident wrong verdict.

### LH-052 · Designed error states  [High]
TH-R20, TH-R7. Blocked by LH-015. Each with a ticket-named test: unreadable image, oversized
file, malformed CSV, unpairable rows, API failure/timeout (retry affordance), partial batch
failure, rate-limit backoff notice, unreachable-endpoint degradation (TH-R7).

### LH-053 · E2E suite  [High]
TH-R12, TH-R20. Blocked by LH-015, LH-042, LH-050. Playwright: verify, batch, review-queue
happy paths + key error states.

### LH-054 · UX polish pass  [Medium]
TH-R3. Blocked by LH-015, LH-016, LH-042. Sarah's-mother benchmark walkthrough; large type,
contrast, no hunting for buttons; government-adjacent trust aesthetic.

## Wave 5 — deploy + docs + audit

### LH-060 · Render deploy  [Urgent]
TH-R16. Blocked by LH-001, LH-002. `render.yaml`: web + worker + Postgres, deploy from main.
Anthropic key provisioning is a hard stop (Troy provides).

### LH-061 · Key protection  [Urgent]
TH-R6, PRD §8. Blocked by LH-060. Shared access code gate, per-IP + global rate limits, daily
spend budget with friendly exhausted state. Security-semantics escalation gate applies —
human read before merge.

### LH-062 · Seeded demo deployment  [High]
TH-R16. Blocked by LH-060, LH-006. Golden set preloaded so evaluators demo in one click;
deployed single-label verify succeeds for an outside evaluator.

### LH-063 · README  [High]
TH-R14. Blocked by LH-060. Setup + run from scratch, deployed URL + access code, architecture
diagram, model/cost notes, data-handling posture (TH-R6). Final wording is Troy's.

### LH-064 · approach.md  [High]
TH-R15, TH-R23, TH-R7. Blocked by LH-030, LH-031. Approach, tools, assumptions log,
trade-offs & limitations (bold detection, OCR scope, network-constraint posture: every
outbound dependency + degradation behavior), cascade benchmark results. Final wording Troy's.

### LH-065 · requirements-audit sweep + gap fixes  [Urgent]
TH-R21, TH-R17. Blocked by LH-062, LH-063, LH-064, LH-053.
Run `requirements-audit baseline`: every TH-R entry `VERIFIED` or documented descope with
reason. Gaps become tickets and get fixed. Sweep artifacts committed — part of the submission.

### LH-070 · ⛔ Final submission gate  [Urgent]
Blocked by LH-065. Always Troy: final README/approach wording, the submit decision. The
factory prepares; Troy ships.
