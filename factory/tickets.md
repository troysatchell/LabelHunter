# LabelHunter — ticket decomposition

Source: `docs/PRD.md` (architecture + scope) × `audit/requirements/inventory.md` (TH-R1..R23).
Mirrored to Linear (team `Troysatchell`, project `LabelHunter`). Local IDs `LH-*` below are
stable keys for this file; the Linear identifier (`TRO-nnn`) is recorded next to each after
creation. Checkpoint tickets **block** their gated wave via Linear relations.

Priorities follow TH-R23: working core (Urgent/High) before ambition (Medium/Low).
Every ticket's DoD includes the factory gate; entries below list only ticket-specific DoD.

## Linear mapping (created 2026-08-10, all blocking relations set)

| LH | TRO | | LH | TRO | | LH | TRO | | LH | TRO |
|---|---|---|---|---|---|---|---|---|---|---|
| LH-001 | TRO-456 | | LH-012 | TRO-462 | | LH-030 | TRO-470 | | LH-052 | TRO-478 |
| LH-002 | TRO-457 | | LH-013 | TRO-463 | | LH-031 | TRO-471 | | LH-053 | TRO-479 |
| LH-003 | TRO-458 | | LH-014 | TRO-464 | | LH-CP3 | TRO-472 | | LH-054 | TRO-480 |
| LH-CP1 | TRO-459 | | LH-015 | TRO-465 | | LH-040 | TRO-473 | | LH-060 | TRO-481 |
| LH-010 | TRO-460 | | LH-016 | TRO-466 | | LH-041 | TRO-474 | | LH-061 | TRO-482 |
| LH-011 | TRO-461 | | LH-CP2 | TRO-467 | | LH-042 | TRO-475 | | LH-062 | TRO-483 |
| | | | LH-020 | TRO-468 | | LH-050 | TRO-476 | | LH-063 | TRO-484 |
| | | | LH-021 | TRO-469 | | LH-051 | TRO-477 | | LH-064 | TRO-485 |
| | | | | | | | | | LH-065 | TRO-486 |
| | | | | | | | | | LH-070 | TRO-487 |

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

### LH-003 · Golden set v1: test labels + ground truth  [High]
TH-R12. Blocked by LH-001.
20–30 labels (AI-generated per the brief, mixed with a few real bottle photos) with
ground-truth JSON: clean match, ABV mismatch, title-case warning, reworded warning, missing
warning, case-variant brand, glare, rotation, low light, tiny warning text, odd typography,
conflicting application-vs-label data. Committed to the repo; doubles as the demo set.
Reviewed at CP-2.

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

## Wave E — evidence harnesses

### LH-030 · Eval harness  [Urgent]
TH-R17, TH-R19. Blocked by LH-003, LH-013.
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
TH-R16. Blocked by LH-060, LH-003. Golden set preloaded so evaluators demo in one click;
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
