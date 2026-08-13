# LabelHunter — Handoff PRD

**Project:** AI-Powered Alcohol Label Verification prototype (TTB take-home)
**Status:** DRAFT — pending Troy's review
**Date:** 2026-08-10 · **Deadline:** ~1 week from kickoff (exact date TBD — pin at factory start)
**Stakes:** Real interview take-home with a hard deadline and a live defense. Troy must be able
to personally explain every major decision in this document.
**Source of truth:** `audit/requirements/inventory.md` (TH-R1..R23, extracted and quote-verified
against the brief). Every ticket the factory creates MUST cite the TH-R IDs it advances.

---

## 1. Mission

Build and deploy a working prototype that lets a TTB compliance agent verify that an alcohol
label matches its application — in seconds instead of minutes, singly or in batches of hundreds —
with AI doing the reading and routine matching, deterministic code doing the checking, and humans
doing only the judgment calls the system flags.

The brief buries its requirements in stakeholder interviews on purpose ("we also value how you
fill in gaps independently"). The scoring surface is the rubric (TH-R17..R23) plus the interview
requirements: 5-second results (TH-R2), batch (TH-R4), judgment-not-string-matching (TH-R8),
exact warning enforcement (TH-R9), and a UI Sarah's mother could use (TH-R3).

## 2. Scope

**Committed core (in priority order — TH-R23 demands a working core before ambition):**

1. Single-label verify: application form + image → per-field verdicts (TH-R1, TH-R11)
2. Cascade pipeline with deterministic validation (TH-R2, TH-R8, TH-R19)
3. Warning subsystem with exact comparison (TH-R9)
4. Batch: CSV manifest + images → queued jobs → per-item verdicts + summary (TH-R4)
5. Persistence + human review queue (differentiator, TH-R22)
6. Imperfect-image handling: graceful `LOW_IMAGE_QUALITY` review outcomes; never a confident
   wrong verdict (TH-R10)
7. Deployed, evaluator-accessible instance (TH-R16) + docs deliverables (TH-R13..R15)

**Explicitly bounded:**

- **Bold detection on the warning (TH-R9):** attempted via Sonnet vision judgment, reported as
  low-confidence signal (`formatting.bold: true/false/uncertain`), and documented as a
  prototype limitation. Caps check is deterministic and hard-enforced.
- **Field set:** the 5 example fields + a beverage-type selector (beer/wine/spirits) that
  adjusts rules (e.g., ABV optionality where TTB allows). Bottler address / country of origin
  are OUT — noted in docs as v2.
- **No COLA integration** (TH-R5). **No sensitive data** (TH-R6). No auth/user accounts —
  a single shared access code protects the deployment (§8).
- **No elaborate agent swarm.** One extraction call, deterministic validation, one resolver
  call when needed. Polish over machinery.

## 3. Architecture

### 3.1 The cascade (the load-bearing decision)

```
Upload (single or batch)
   ↓
Image preprocessing (EXIF rotation; keep original full-res for OCR;
  ≤1568px variant for Haiku — its vision cap; warning-region crop at
  near-native DPI; ≤2576px variant reserved for Sonnet escalation)
   ↓
Haiku Extractor            — claude-haiku-4-5, vision, structured output
   ↓
Validation Router          — deterministic TypeScript, no LLM
   ├── PASS    → done (verdict recorded)
   ├── REVIEW  → Sonnet Resolver — claude-sonnet-5, sees image + extraction + reason
   └── INVALID → Sonnet Resolver (re-extract + resolve)
                     ↓
              resolved | needs-human → review queue
```

Framing (use this language in docs and interview): **high-throughput extraction + selective
escalation**, not "cheap model vs expensive model." Sonnet is a *resolution mechanism*, not a
mandatory second opinion. Never run Sonnet on every label.

### 3.2 Haiku Extractor

- Structured output (strict JSON schema). Every field carries `value`, `evidence` (verbatim
  text seen on label), `confidence` (0–1). Provenance is a compliance feature: a bare `45`
  with no evidence string is unacceptable.
- One call per label. Prompt is a HUMAN CHECKPOINT deliverable (§10).

### 3.3 Validation Router (deterministic, fully unit-tested)

- Normalizers per field (case, punctuation, whitespace, unicode).
- Brand/class-type compare: normalized fuzzy match — `STONE'S THROW` ≡ `Stone's Throw` →
  MATCH with note (TH-R8). Distance beyond threshold → REVIEW, never silent FAIL.
- ABV: parse `45% Alc./Vol. (90 Proof)`; cross-check ABV↔proof arithmetic; compare to
  application; beverage-type rules applied.
- Net contents: format + value + unit comparison.
- Warning subsystem (§3.4).
- Output: per-field `MATCH | MISMATCH | NEEDS_REVIEW` + confidence + one-line reason;
  label-level `PASS | FAIL | REVIEW`. Routing to Sonnet driven by an explicit enum:

```ts
type ReviewReason =
  | "LOW_IMAGE_QUALITY" | "AMBIGUOUS_BRAND" | "AMBIGUOUS_ABV"
  | "AMBIGUOUS_NET_CONTENTS" | "WARNING_MISMATCH" | "MISSING_REQUIRED_FIELD"
  | "CONFLICTING_EXTRACTION" | "LOW_MODEL_CONFIDENCE";
```

The UI always shows the reason ("Government Warning differs from expected text"), never a bare
"AI confidence: 71%".

### 3.4 Warning subsystem (TH-R9 — its own component, HUMAN CHECKPOINT)

- Canonical text (27 CFR part 16): `GOVERNMENT WARNING: (1) According to the Surgeon General,
  women should not drink alcoholic beverages during pregnancy because of the risk of birth
  defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or
  operate machinery, and may cause health problems.` (Verify verbatim against ttb.gov during
  implementation — a ticket, not an assumption.)
- Dual path: VLM transcription + OCR (tesseract.js — pure WASM, no native deps on Render) both
  produce warning candidates → normalization → **exact comparison** against canonical.
- Verdicts: exact match → PASS. Wording deviation → FAIL. `Government Warning` title-case
  (Jenny's real catch) → FAIL with caps reason. Candidates disagree or OCR confidence low →
  REVIEW with `WARNING_MISMATCH`/`LOW_IMAGE_QUALITY`.
- Rationale for the record: "the system compared against the statutory string" is defensible;
  "Sonnet thought it looked right" is not.

### 3.5 Batch (TH-R4 — HUMAN CHECKPOINT)

- Input: CSV manifest (application fields + `image_filename` column) + images (zip or
  multi-file drop). Deterministic pairing by filename; unmatched rows/images reported before
  the job starts, not silently dropped.
- Postgres-backed job queue; worker pool (concurrency ~5, tuned to Anthropic rate limits with
  backoff). Never `for image: await extract(image)` serially.
- Sonnet workers consume only the review sub-queue.
- Progress: polling endpoint driving a live summary — `processed / auto-verified /
  resolved-by-Sonnet / needs-human / avg + p95 latency`. Partial failure semantics: one bad
  image fails that item, never the job.

### 3.6 Stack & data model

- **Next.js (TypeScript)** app on **Render** web service + **background worker** process;
  **Render Postgres** + **Drizzle**. One repo, one deploy pipeline.
- Tables: `applications`, `label_images`, `batch_jobs`, `verifications` (label-level),
  `field_results` (per-field verdict/evidence/confidence/reason), `review_queue` (reason,
  resolver output, human disposition). No PII anywhere (TH-R6).

### 3.7 Resolution strategy & warning upgrade ladder

Haiku 4.5 is standard-resolution vision (1568px long edge); Sonnet 5 is high-res (2576px).
The warning block is small print, so it is the field most exposed to the Haiku cap. The
telemetry below decides — with evidence, not vibes — whether and how far to upgrade.

**The metric:** per eval run and per batch, segment warning-check outcomes into:

- **True mismatch (FAIL)** — label text genuinely differs from canonical. Working as
  intended. NOT an upgrade signal, no matter how frequent.
- **Resolution-suspect (REVIEW)** — `LOW_IMAGE_QUALITY`, or VLM and OCR candidates disagree
  (`CONFLICTING_EXTRACTION`). This rate drives the ladder.

**The ladder (apply in order; re-measure on the golden set after each step):**

| Suspect rate | Action |
|---|---|
| ≤ 10% | Healthy — keep Haiku + warning crop. |
| 10–25% | Fix the crop pipeline first (detection, DPI, framing); re-measure before any model change. |
| > 25% persistent after crop fix | Field-level upgrade: warning crop always goes to Sonnet; Haiku keeps the other four fields. |
| Still failing, or other fields degrade too | Full extractor upgrade to Sonnet 5 single-tier; re-run the latency (5s) and cost benchmarks before accepting. |

The eval harness (§6) reports this segmentation on every run, so the upgrade decision is a
number in CI output, not a judgment call mid-week.

### 3.8 Latency budget (TH-R2)

The 5-second promise applies to what the agent is waiting on: **a verdict or an explicit
flag.** Stage budgets below are targets to be validated by the latency harness (§6) —
never quoted as achieved numbers until measured.

| Stage (single-label flow) | Budget (p50) |
|---|---|
| Preprocess — sharp variants + warning crop, EXIF | ~0.3s |
| tesseract.js OCR on the warning crop (runs in parallel with Haiku) | ~0.5s |
| Haiku extraction (structured output, ≤1568px) | ~2.5s |
| Validation Router (deterministic) | <10ms |
| **Fast path total (~85–90% of labels)** | **~3s p50 · ≤5s p95** |

- OCR runs on the **warning crop only**, concurrently with the Haiku call — never serially,
  never on the full image (full-image tesseract.js is a 1–3s tax we don't pay).
- **Escalation is asynchronous.** On a REVIEW route the agent still gets their answer inside
  the budget: per-field verdicts plus an explicit "needs review — {reason}" flag. The Sonnet
  resolution lands in the review queue seconds later, usually before the item is opened.
  Time-to-verdict-or-flag is the 5s clock — items needing deeper judgment were never
  5-second items by eye either.
- Batch mode is throughput-bound, not latency-bound: the 5s requirement is the interactive
  single-label promise; batch reports items/minute and per-item averages.
- Ladder interaction (§3.7): the bottom rung (full-Sonnet extraction, ~3–5s) consumes most
  of the headroom — which is exactly why that rung requires re-running the latency benchmark
  before acceptance.

## 4. Model usage & cost

| Role | Model | Est. cost/label |
|---|---|---|
| Extractor | `claude-haiku-4-5` ($1/$5 per MTok) | ~$0.005 |
| Resolver (escalations only) | `claude-sonnet-5` ($3/$15; intro $2/$10 thru 8/31) | ~$0.02 × ~10–15% of labels |

- Structured outputs (`output_config.format`) on both; adaptive thinking default on Sonnet.
- **Spend cap:** $25 projected build+eval spend → factory pauses and notifies Troy (default —
  confirm at review). Per-deployment runtime cap enforced in app (daily request budget).
- Benchmark ticket: cascade vs Sonnet-only on the golden set — measured, in the approach doc
  (TH-R19 evidence). Keep the cascade regardless per Troy; the benchmark is the evidence.

## 5. UX (TH-R3, TH-R20)

- **Verify screen:** one obvious primary flow — upload image, enter/select application fields,
  big "Verify" button. Result renders as a checklist (Jenny's paper checklist, digitized):
  per-field ✓ / ✗ / ⚠ rows with evidence and reason. Large type, high contrast, no hidden
  actions (half the team is over 50; Sarah's mother is the benchmark).
- **Detail view:** label image side-by-side with extracted vs application values per field,
  match badges, "Resolved by Sonnet" annotations, warning expected-vs-detected diff.
- **Batch screen:** manifest upload → pairing preview → run → live progress summary → results
  table (Label / Brand / ABV / Net / Warning / Status) → click-through to detail.
- **Review queue:** needs-human items with reason; approve/reject records disposition.
- **Designed error states (not toasts):** unreadable image, oversized file, malformed CSV,
  unpairable rows, API failure/timeout (retry affordance), partial batch failure, rate-limit
  backoff notice. Each has a ticket and a test.
- Aesthetic (revised TRO-573, Troy-directed 2026-08-13; supersedes the prior USWDS-influenced
  line): Notion-style clean — white page, warm near-black text, thin soft borders, generous
  whitespace, one quiet accent color, light-only (no dark mode, no `prefers-color-scheme`
  branching). Still no purple-gradient AI slop. TH-R3's bar is unchanged by this — large type,
  high contrast, no hidden actions, judged against the 73-year-old/Dave benchmark — every color
  pair is checked against WCAG AA by `src/app/globals-contrast.test.ts`, not eyeballed.

## 6. Testing & evidence (TH-R12, TH-R17, TH-R20)

- **TDD for the Router** — every normalizer/comparator is a pure function with unit tests
  written first. The STONE'S THROW case and Jenny's title-case catch are named test cases.
- **Golden set:** ~20–30 generated labels (AI image gen per the brief) with ground-truth JSON:
  clean match, ABV mismatch, title-case warning, reworded warning, missing warning, case-variant
  brand, glare, rotation, low light, tiny warning text, odd typography, conflicting
  application-vs-label data. Assets committed to the repo; doubles as the demo set.
- **Eval harness:** extraction accuracy + verdict accuracy vs ground truth; runs in CI; also
  produces the cascade-vs-Sonnet-only benchmark.
- **Latency harness:** measured p50/p95 for the single-label flow (target p50 ≤ 5s) and batch
  throughput; output captured as evidence for TH-R2. **Never fabricate the demo numbers —**
  the stats page shows real measurements.
- **E2E:** Playwright over verify, batch, and review-queue happy paths + key error states.

## 7. Deliverables (TH-R13..R16)

- GitHub repo (public or evaluator-shared) with all source.
- README: setup, run, deployed URL + access code, architecture diagram, model/cost notes.
- `docs/approach.md`: approach, tools used, assumptions log, trade-offs & limitations
  (TH-R15, TH-R23) — includes the bold-detection limitation and cascade benchmark results.
- Deployed URL on Render, seeded with the golden set so evaluators can demo in one click.

## 8. Deployment & key protection

- Render: web service + worker + Postgres, deploy from main via `render.yaml`.
- The public URL fronts Troy's Anthropic key: shared access code gate (in README for
  evaluators), per-IP + global rate limits, daily spend budget with a friendly "budget
  exhausted" state. (Deploy was NOT selected as a human checkpoint — factory deploys
  autonomously after gates pass; flag if you want this changed.)

## 9. Factory process

- **Skill:** `build-factory` in the labelhunter repo. Toolchain: Node/TS, Vitest, Playwright,
  Drizzle, Render CLI.
- **Source of work:** this PRD → ticket decomposition. Every ticket carries `TH-R` IDs.
- **Tracker:** existing Linear team (Ship's), **new project "LabelHunter"** — scope check per
  requirements-audit before any ticket mapping.
- **Evidence gate (definition of done per ticket):** typecheck + lint + unit/E2E green +
  eval harness not regressed + latency budget respected.
- **Definition of DONE for the factory:** `requirements-audit baseline` sweep shows every
  TH-R entry `VERIFIED` (or `N/A`/documented-descope with reason) + deliverables checklist
  complete. The sweep artifacts are part of the submission prep, not an afterthought.
- **Isolation:** worktrees per ticket; review triage before merge.
- **Milestones (relative — pin dates when deadline confirmed):**
  - D1–2: scaffold, schema, single-label pipeline skeleton, CI. ⛔ CHECKPOINT 1 before router/prompt work.
  - D3: warning subsystem (⛔ CHECKPOINT 2 first), golden set v1, eval harness.
  - D4: batch queue (⛔ CHECKPOINT 3 first), review queue UI.
  - D5: UX polish, error states, latency tuning, benchmark.
  - D6: deploy hardening, docs, requirements-audit sweep, gap fixes.
  - D7: buffer + Troy's final review + submission.

## 10. HUMAN CHECKPOINTS (blocking, unskippable — per standing preference)

Three tickets the factory MUST NOT start until it has notified Troy and received explicit
acknowledgment. Each checkpoint = 30–60 min walkthrough of the design + a short "defend it"
Q&A so interview answers are rehearsed, not discovered.

| # | Gate before | Covers |
|---|---|---|
| CP-1 | Cascade router + prompts | Haiku extraction prompt/schema, confidence thresholds, ReviewReason routing rules, Sonnet resolver prompt |
| CP-2 | Warning subsystem | Canonical text sourcing, OCR choice, normalization rules, exact-compare, bold/caps handling & limitation wording |
| CP-3 | Batch queue + workers | Queue design, concurrency, rate-limit strategy, partial-failure semantics |

Plus a **final submission gate**: README/approach-doc final wording and the submit decision
are always Troy's (default applied since autonomy question was skipped).

## 11. Autonomy defaults (Troy skipped the question — confirm or amend at review)

- Auto-merge PRs when evidence gate + review triage pass: **allowed**.
- Auto-deploy to Render after merge: **allowed** (deploy not selected as checkpoint).
- LLM spend: **pause + notify at $25 projected**.
- Final submission + README claims: **always Troy**.
- Overnight runs: **allowed**, but never across an unacknowledged HUMAN CHECKPOINT.

## 12. Risks

| Risk | Mitigation |
|---|---|
| OCR weak on stylized label art | OCR only targets the warning block (plain print); VLM path is primary; disagreement → REVIEW |
| Bold detection unreliable | Scoped as low-confidence signal + documented limitation (§2) |
| Generated test labels unrealistic | Mix AI-generated with a few real bottle photos; golden set reviewed at CP-2 |
| Anthropic rate limits mid-batch | Worker backoff + concurrency cap; measured in latency harness |
| Graders abuse public URL | Access code + rate limits + daily budget (§8) |
| Week slips | Scope ladder in §2 is the cut order, bottom-up (imperfect-image polish first) |

## 13. Decision log

| Decision | Choice | Round |
|---|---|---|
| Stakes | Real interview take-home, live defense | R1 |
| Pipeline | Vision extract + code compare → refined to Haiku→Router→Sonnet cascade | R1/R3 |
| Stack | Next.js full-stack TS | R1 |
| Scope | All four features committed (batch, persistence+queue, imperfect images, bold+caps) | R1 |
| Deadline | ~1 week (exact date TBD) | R2 |
| Verdicts | 3-state + confidence + reason | R2 |
| Deploy | Render (web + worker + Postgres) | R2 |
| Factory | build-factory + requirements-audit as DoD gate | R2 |
| Models | Tiered: Haiku extractor, Sonnet resolver | R3 (Troy's architecture) |
| DB | Render Postgres + Drizzle | R3 |
| Batch input | CSV manifest + images | R3 |
| Fields | 5 example fields + beverage type | R3 |
| Checkpoints | CP-1 router/prompts, CP-2 warning, CP-3 batch queue | R4 |
| Tracker | Existing Linear team, new "LabelHunter" project | R4 |
| Name | LabelHunter | R4 |
| Autonomy | Defaults per §11 (unconfirmed) | R4 (skipped) |

## 14. Open items

1. **Exact submission deadline** (date + time) — pins the milestone calendar.
2. Confirm §11 autonomy defaults.
3. Linear project creation + team scope check (factory setup step).
4. Anthropic API key provisioning for the deployed instance (Troy provides at deploy ticket).
