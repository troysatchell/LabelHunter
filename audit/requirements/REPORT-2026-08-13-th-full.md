# Requirements Audit — LabelHunter (full sweep)
**Commit:** e63b00bd3962 · **Date:** 2026-08-13T18:45:45.115807+00:00 · **Docs:** TH (source-TH.md) · **Mode:** compare, label `2026-08-13-th-full`

## Summary

- **VERIFIED:** 11
- **PARTIAL:** 9
- **IMPLEMENTED-UNVERIFIED:** 1
- **MISSING:** 2

The most consequential finding is TH-R9: the bold half of the government-warning rule is
captured and never checked. The extractor asks the model for it and validates the answer, and
the golden set carries bold ground truth, but no router or comparator reads the value — so a
warning printed in correct all-caps but not bold passes today, which the brief describes as a
rejection. This had been masked: the inventory's own interpretation field allowed the rule to be
satisfied by being "explicitly documented as a limitation", an allowance that appears nowhere in
the source quote and had been inherited silently by every prior sweep. Troy struck it (INT-005)
and the row drops to PARTIAL. Beyond that the core is in good shape: the cascade, fuzzy field
matching, batch mode, imperfect-image handling and designed error states are all verified
behaviourally against 2238 passing unit tests, 12 e2e tests in a real browser, and a live gated
deployment. The two MISSING rows are the README and approach doc, both written and in open PRs,
blocked only on a docs-only gate decision.

## Coverage and limitations

- **The TH-R2 latency re-measurement was NOT run.** The committed p50 3834 ms / p95 4458 ms predate TRO-546's change to `region-detect.ts`, which sits on the measured path. TRO-568 (merged today) unblocked the harness; the run itself is owned by another session and still pending. TH-R2 rests on a stale figure and is scored PARTIAL for that reason.
- **No live model run.** `pnpm eval:check` ran in cheap mode, comparing committed artifacts against the K=3 band. The underlying live figures come from `eval-report.json` (mode live, 2026-08-13T15:57Z). `--live --full` was deliberately not run: it costs real API money and INT-002 holds the artifact current.
- **Ticket mapping is keyword-derived**, not per-ticket human review. Per-row ticket lists are indicative; the orphan list is unreliable at that resolution and is therefore reported as empty rather than fabricated.
- **Database writes:** the verify suites were run in a worktree byte-identical to `origin/main` (`git diff origin/main` returned 0 files) against its **own isolated database**, never the shared `labelhunter_dev`. Nothing outside that scratch database was written.
- **Live-deploy probes were read-only GETs.** No `/api/verify` call was made from this sweep, so no API spend was incurred.
- **Tree was dirty at sweep time** (3 path(s)): udit/requirements.config.yaml, audit/requirements/interpretations.md, audit/requirements/inventory.md. No citation points into a dirty path.
- **1 row is statically traced only** (TH-R5, IMPLEMENTED-UNVERIFIED) — a scope/negative requirement with no behavioural check that could confirm it.

## Matrix

| ID | Requirement (short) | Evidence | Verdict |
|---|---|---|---|
| TH-R1 | The core loop: app accepts application data + label artwork image, use | `src/app/api/verify/route.ts:313 +8` | **VERIFIED** |
| TH-R2 | Single-label verification completes in ~5 seconds wall-clock from subm | `scripts/latency/results/single-label-verify-url-mode.json:37 +7` | **PARTIAL** |
| TH-R3 | UI is a single obvious primary flow: large controls, minimal navigatio | `src/app/page.tsx:12 +8` | **PARTIAL** |
| TH-R4 | Batch mode: upload/submit many label applications at once; each proces | `src/app/_components/BatchUploadForm.tsx:296 +9` | **VERIFIED** |
| TH-R5 | Standalone app; no COLA/registry integration; application data is ente | `docs/PRD.md:46 +5` | **IMPLEMENTED-UNVERIFIED** |
| TH-R6 | No PII or sensitive data persisted; sane baseline security (no exposed | `src/lib/db/schema.ts:61 +10` | **PARTIAL** |
| TH-R7 | Design consciously addresses constrained-network deployment: minimal,  | `docs/error-states.md:17 +8` | **PARTIAL** |
| TH-R8 | Field matching applies judgment, not strict string equality: case/punc | `src/server/comparators/brand.ts:25 +7` | **VERIFIED** |
| TH-R9 | Government warning verified word-for-word against the statutory text;  | `src/server/warning/canonical.ts:21 +11` | **PARTIAL** |
| TH-R10 | Stretch (speaker: "maybe out of scope for a prototype"): tolerate angl | `src/server/router/golden-image-quality.test.ts:1 +8` | **VERIFIED** |
| TH-R11 | Handles a distilled-spirits label carrying at least: Brand Name, Class | `src/server/router/types.ts:35 +7` | **VERIFIED** |
| TH-R12 | Repo ships a test-label image set (generated or sourced) exercising th | `golden-set/README.md:3 +6` | **VERIFIED** |
| TH-R13 | Public/shareable repo containing all source. | `.github/workflows/ci.yml:47 +4` | **VERIFIED** |
| TH-R14 | README covers setup + run from scratch. | `docs/PRD.md:240 +1` | **MISSING** |
| TH-R15 | Docs section covering approach, tool choices, and assumptions. | `docs/PRD.md:241 +1` | **MISSING** |
| TH-R16 | Live deployment reachable by evaluators; core flow works there, not ju | `render.yaml:32 +6` | **PARTIAL** |
| TH-R17 | Rubric line — core loop (TH-R1, TH-R11) works correctly and completely | `src/app/api/verify/route.ts:313 +3` | **VERIFIED** |
| TH-R18 | Rubric line — clean structure, sensible modules, no slop. | `eslint.config.mjs:13 +7` | **VERIFIED** |
| TH-R19 | Rubric line — stack sized to a prototype, not over- or under-engineere | `docs/PRD.md:241 +5` | **PARTIAL** |
| TH-R20 | Rubric line — TH-R3 plus explicit failure states: bad image, API failu | `docs/error-states.md:39 +9` | **VERIFIED** |
| TH-R21 | Rubric line — the buried interview requirements (5s, batch, fuzzy vs s | `src/server/comparators/brand.ts:23 +7` | **PARTIAL** |
| TH-R22 | Rubric line — at least one differentiated, well-judged idea beyond the | `docs/PRD.md:33 +5` | **VERIFIED** |
| TH-R23 | Two obligations: (a) prioritization — ship the working core before str | `docs/PRD.md:27 +5` | **PARTIAL** |

## Gaps

### TH-R2 — PARTIAL
- **Missing part:** The figure is good news — 3834ms p50 against a 5000ms bar, measured over real HTTP against the deployed instance. It just cannot carry VERIFIED at this commit. INT-002 is unconditional: "An artifact that predates a change to the measured path is stale, and a stale artifact never supports VERIFIED." Thirteen [...]
- **Suggested scope:** One command plus one commit, and TRO-568 already removed the blocker. Set ACCESS_CODE in the environment and run `pnpm latency:check -- --url https://labelhunter-web.onrender.com` (measure.ts now sends the x-access-code header, scripts/latency/access-code.ts), then commit the regenerated [...]

### TH-R3 — PARTIAL
- **Missing part:** INT-006 (Troy, 2026-08-13): backlogged for a real UX/accessibility pass. Troy has not reviewed the UI himself and flagged accessibility as the reason it matters.
- **Suggested scope:** Walk the CURRENT screens as a first-time user and assess for accessibility, not only for function. Three user-facing surfaces post-date the last walkthrough: the access-code screen (never walked at all), review-queue paging, and two new error states. Automated evidence stays green; what is missing is the human [...]

### TH-R6 — PARTIAL
- **Missing part:** Data-model half: fully met and behaviorally supported (`pnpm test` — 179 files, 2238 tests, ALL PASSED — includes src/server/auth/access-code.test.ts and src/proxy.test.ts). No table holds a person's name, email, address, or identifier; the review queue records the decision without the decider. Secrets posture is [...]
- **Suggested scope:** Ship LH-063 / TRO-484 (README), whose ticket text already names "data-handling posture (TH-R6)" as required content. The smallest change that closes this row specifically: create README.md with a short "Data handling" section stating (a) the app persists only label/application compliance fields and uploaded [...]

### TH-R7 — PARTIAL
- **Missing part:** INT-004 (Troy, 2026-08-13): INT-003's graded-deliverable standard extends here. The implementation half is fully met; only the prose placement is outstanding.
- **Suggested scope:** Move the outbound-dependency list and its degradation behaviour from docs/error-states.md into docs/approach.md (or README.md). The content already exists in full and needs no new research. TRO-485/PR #68 already assigns it there, so this closes when that merges.

### TH-R9 — PARTIAL
- **Missing part:** INT-005 (Troy, 2026-08-13): the inventory's Meaning-in-code previously allowed the bold rule to be satisfied by being 'explicitly documented as a limitation'. That allowance is absent from the source quote and has been struck. Word-for-word and all-caps remain verified against real photographs; BOLD IS CAPTURED [...]
- **Suggested scope:** Give the captured bold signal a verdict consequence. The extractor already returns bold: true|false|uncertain (schema.ts:80, prompt.ts:50, response.ts:178) and the golden set carries bold ground truth (TRO-527). Nothing reads it. TRO-532 (LH-025 stroke-width bold advisory) and TRO-533 (LH-026 surface the bold [...]

### TH-R14 — MISSING
- **Missing part:** There is no `README.md` at the repo root on origin/main. `git ls-files` returns exactly one README anywhere in the tree, `golden-set/README.md`, which is a golden-set design document. A fresh-clone walkthrough cannot succeed because there is nothing to walk through. MID-FLIGHT, NOT UNWRITTEN: PR #66 (branch [...]
- **Suggested scope:** Merge PR #66. The document is written and reviewed; the only remaining cost is Troy's ruling on the G6 docs-only gate — grant the one-off exception (the `factory/gate-exceptions.json` mechanism TRO-553 built already exists) or decide docs-only tickets take a different check. One follow-up edit after merge: that [...]

### TH-R15 — MISSING
- **Missing part:** `docs/approach.md` does not exist on origin/main (`ls docs/` returns deploy.md, error-states.md, PRD.md, prd-brainstorm-questions.md, reference-photo-provenance.md, and four subdirectories). INT-003 already settled that the raw material sitting in `docs/PRD.md`, `docs/error-states.md` and `docs/deploy.md` does [...]
- **Suggested scope:** Merge PR #68. The 259-line document is already written against `audit/requirements/gaps.md`'s assembly instructions; nothing further needs authoring. Same single blocker as TH-R14 — Troy's call on the G6 regression-test gate for a docs-only branch. One check to make before merging, because it is the specific [...]

### TH-R16 — PARTIAL
- **Missing part:** HALF ONE HOLDS, HALF TWO DOES NOT. Holds — the URL loads. The instance is live and answering right now: `/` returns 307 to `/access-code`, `/access-code` returns 200, `/api/health` returns 200. The access-code gate in front of it is deliberate (docs/PRD.md:248), not a defect. Does not hold — "single-label verify [...]
- **Suggested scope:** Two steps, neither needing new code. (1) Re-run the deployed-target harness ONCE with the credential set: `ACCESS_CODE=<live value> pnpm latency:check -- --url=https://labelhunter-web.onrender.com --runs=20`, then commit the fresh artifact. TRO-568 (merged at e63b00b, `scripts/latency/access-code.ts`) added the [...]

### TH-R19 — PARTIAL
- **Missing part:** approach'` returns nothing at HEAD e63b00b. No document in the repo is the approach doc. WHAT IS PRESENT AND STRONG. The technical choices are sized to a prototype and defended in three independent places. (1) Scope-appropriate stack: package.json lists exactly nine runtime dependencies (Next, React/React-DOM, [...]
- **Suggested scope:** Write `docs/approach.md` (TRO-485 / LH-064). No code change closes this — every input already exists and needs assembling, not discovering: PRD §3.1 (lines 53-74) for the cascade rationale, PRD §3.6 (lines 132-138) for the stack, PRD §3.7 (lines 140-163) for the upgrade ladder, package.json's nine-dependency list [...]

### TH-R21 — PARTIAL
- **Missing part:** WHAT IS ADDRESSED, each traced to code. (1) 5 seconds — a dedicated latency harness measures the exact function the route calls, against a live model, and refuses to mock (scripts/latency/measure.ts:2-16); the budget is broken into per-stage targets at PRD §3.8. (2) Batch — a real Postgres-backed queue with a [...]
- **Suggested scope:** Two small, independent changes. (1) Surface the bold signal (TRO ticket LH-026 already exists): render `formatting.bold` as an advisory line in `src/app/_components/DetailView.tsx` next to the warning row, worded as a signal that never changes the verdict — roughly the same shape as the existing `resolved-by- [...]

### TH-R23 — PARTIAL
- **Missing part:** approach'` returns nothing. Genuinely good trade-offs content exists and is unusually candid — docs/deploy.md:84 'Known limitations' openly marks the live deploy itself as unverified, and docs/error-states.md:154 states the network-failure trade-off plainly and names what the app deliberately does not [...]
- **Suggested scope:** TRO-485 / LH-064, writing only — no code change closes this. Add a 'Trade-offs and limitations' section to `docs/approach.md` (and a short version in the README from TRO-484) by lifting content that already exists: docs/error-states.md:154-169 (the one-error-state network trade-off), docs/deploy.md:84-142 (known [...]

## Orphan tickets

None reported. Ticket mapping was keyword-derived (see Coverage), which is too coarse to distinguish a genuine orphan from a mapping miss. Reporting an orphan list at that confidence would be technically true and useless.

## Blocked / assumed

No BLOCKED and no ASSUMED rows. Three ambiguities surfaced below the flood cap and were ruled by Troy rather than assumed: **INT-004** (TH-R7), **INT-005** (TH-R9), **INT-006** (TH-R3).

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `pnpm typecheck` | exit 0 — tsc --noEmit clean | TH-R18 |
| `pnpm lint` | exit 0 — 1 problem (0 errors, 1 warning) | TH-R18 |
| `pnpm build` | exit 0 — production build succeeded | TH-R18 |
| `pnpm test` | 179 files, 2238 tests, all passed (17.29s) | TH-R1, TH-R8, TH-R9, TH-R11, TH-R17, TH-R20 |
| `pnpm test:e2e` | 12 passed (12.8s) | TH-R1, TH-R3, TH-R4, TH-R20 |
| `pnpm eval:check` | PASS — extraction 87.2% within 87.2-87.8% band; cascade 80.6% within 80.6-83.3% band (K=3) | TH-R17, TH-R19 |
| `curl GET https://labelhunter-web.onrender.com/ and /api/review-queue` | 307 -> /access-code; 401 without credential; 200 with x-access-code header | TH-R6, TH-R16 |
| `pnpm latency:measure -- --url=<deployed>` | NOT RUN | TH-R2 |
| `pnpm eval:check -- --live --full` | NOT RUN | TH-R17 |
