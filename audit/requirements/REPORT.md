# Requirements Audit — LabelHunter

**Commit:** 8fa8999 (clean, 1 ahead of `origin/main` — unpushed) · **Date:** 2026-08-12T18:05Z · **Docs:** TH (source-TH.md, textutil cache, sha256 unchanged) · **Mode:** compare (`2026-08-12-bold` vs `matrix.after-2026-08-11-pm.json`)

## Summary

Verdicts: **VERIFIED** 10 · **PARTIAL** 9 · **IMPLEMENTED-UNVERIFIED** 1 · **MISSING** 3 · **ASSUMED** 0 · **N/A** 0 · **BLOCKED** 0. (23 active requirements.)

Three rulings were taken from Troy on 2026-08-12 and recorded in `interpretations.md` as INT-001, INT-002, and INT-003. They are binding on every later sweep. Applying them cleared both ASSUMED rows: TH-R9 → PARTIAL, TH-R23 → PARTIAL, and lifted TH-R10 → VERIFIED.

Nine rows moved up, one moved down, and the one that moved down matters most.

**The headline: label-verdict accuracy is 65.6%, not the extraction accuracy the repo usually quotes.** The live eval run (`scripts/eval/results/eval-report.json`, 2026-08-12T13:26:45Z, mode `live`, `claude-haiku-4-5`) reads fields correctly 154 times out of 160 — **96.25% extraction**. But only **21 of 32 cases** land on the expected label verdict — **65.6%**. Extraction is strong; the router's verdict calibration is the weak link, and no ticket currently owns it.

**TH-R2 dropped VERIFIED → PARTIAL, and the reason is honest rather than regressive.** The latency artifact measures a pipeline that no longer ships. `scripts/latency/results/single-label-verify.json` was measured 2026-08-12T02:17:14Z; the warning comparator was wired into the route at commit c5e49f8, roughly an hour later. The artifact's own `pipelineScope` field says so: *"No OCR/warning-subsystem comparator."* Every one of its 20 runs also returned REVIEW / LOW_MODEL_CONFIDENCE — never a clean pass. The p50 of 4232 ms is real, and it measures the wrong thing. Compounding it, TRO-519 (Urgent, open) leaves the OCR channel with no deadline, so p95 on the shipping pipeline is currently unbounded.

**TH-R9 rose MISSING → PARTIAL.** The brief's headline requirement now has real code on the live path (TRO-514) and 198 green tests across `src/server/warning`. It is not VERIFIED because INT-001 rules that at least one FAIL case must run through the real image pipeline. Today the two FAIL cases run against simulated dual-channel text; only the PASS case uses a real photograph. The image needed is already committed at `golden-set/images/case-08-title-case-warning-prefix-only.jpg`, so one test closes it.

**Three MISSING rows are the submission blockers, and none is a code problem.** TH-R14 (README), TH-R15 (approach.md), TH-R16 (deployed URL). TRO-481 shipped `render.yaml` — repo-side config only; grep for `onrender.com` across the repo returns 0 matches, so no deployed host exists to open.

## Coverage and limitations

- **This sweep wrote to a database.** `pnpm db:migrate` and `pnpm test` ran against `labelhunter_audit_0812`, a throwaway created for this run on the `labelhunter-pg` container. Verified afterward: the audit database holds 4 migration rows and 8 product tables; `labelhunter_dev` held 2 migration rows before and after, untouched.
- **The environment was broken at sweep start, and the first attempt was aborted because of it.** `pnpm typecheck` failed with 7 `TS2307` errors for `fflate` and `js-yaml`. Both are declared in `package.json` and present in `pnpm-lock.yaml`; `node_modules` was stale. `pnpm install --frozen-lockfile` fixed it in 325 ms, changed no repo file, and typecheck then reported 0 errors. Had the sweep continued, TH-R4 and TH-R18 would have carried false failures backed by real-looking command output.
- **`pnpm latency:check` did NOT run** (real billed API calls). TH-R2 cites the dated artifact and its staleness is the finding.
- **`pnpm test:e2e` did NOT run** (boots a dev server). TH-R1 and TH-R20 cite `CHANGES.md:188`'s recorded 11/11 pass against a production build.
- **No live browser this sweep.** TH-R3 and TH-R20's UX claims rest on reading component code plus the recorded Playwright run, not on driving the app.
- **Sweep point is local `main`, 1 commit ahead of `origin/main`.** Commit 8fa8999 is unpushed, so CI has never run this exact tree.
- **13 ambiguities surfaced, above the skill's ~5 flood cap.** Three were ruled by Troy and recorded in `interpretations.md`; both ASSUMED rows cleared as a result. Seven remain open in `needs_ruling`; none changes a verdict on its own.
- Linear resolved OK: 68 issues pulled from project `LabelHunter` only. No BLOCKED cells.
- 179 evidence citations were mechanically checked — every file exists and every line number is in range. Each cluster was additionally re-opened by an independent checker that corrected wrong line numbers and downgraded verdicts whose evidence did not hold.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: label in → per-field verdicts | TRO-461, TRO-462, TRO-463, TRO-465, TRO-514, TRO-479 | src/app/_components/VerifyForm.tsx:200; src/app/api/verify/route.ts:259; src/app/api/verify/route.ts:233 | VERIFIED |
| TH-R2 | Single-label ≤~5s p50 | TRO-471, TRO-514, TRO-519 | scripts/latency/results/single-label-verify.json:3; scripts/latency/results/single-label-verify.json:11; scripts/latency/results/single-label-verify.json:30 | PARTIAL ▼ |
| TH-R3 | 73-year-old UX benchmark | TRO-465, TRO-466, TRO-475, TRO-476, TRO-479, TRO-480 | src/app/_components/VerifyForm.tsx:200; src/app/_components/VerifyForm.test.tsx:69; src/app/globals.css:82 | VERIFIED ▲ |
| TH-R4 | Batch mode (200–300 scale) | TRO-473, TRO-474, TRO-475, TRO-472, TRO-518, TRO-506, TRO-522 | src/server/batch-start/start-batch.ts:138; src/server/batch-start/start-batch.test.ts:58; src/server/batch-queue/pool.test.ts:86 | PARTIAL |
| TH-R5 | Standalone, no COLA integration | *(unticketed)* | docs/PRD.md:46; src/server/router/required-fields.ts:21; docs/error-states.md:27 | IMPLEMENTED-UNVERIFIED |
| TH-R6 | No PII / sane secrets posture | TRO-457, TRO-484, TRO-482 | src/lib/db/schema.ts:59; src/lib/db/schema.ts:340; src/server/review-queue/record-disposition.ts:11 | PARTIAL |
| TH-R7 | Constrained-network dependency doc | TRO-478, TRO-468, TRO-485, TRO-519 | docs/error-states.md:17; docs/error-states.md:27; docs/error-states.md:29 | PARTIAL ▲ |
| TH-R8 | Lenient/judgment field matching | TRO-462, TRO-463, TRO-504, TRO-465 | src/server/comparators/brand.ts:57; src/server/comparators/brand.ts:64; src/server/comparators/brand.test.ts:24 | VERIFIED |
| TH-R9 | Warning exact word-for-word check | TRO-467, TRO-468, TRO-469, TRO-514, TRO-517, TRO-533 | src/app/api/verify/route.ts:153; src/app/api/verify/route.ts:259; src/server/router/field-resolution.ts:296 | ASSUMED ▲ |
| TH-R10 | Imperfect-image handling | TRO-477, TRO-460, TRO-497, TRO-470, TRO-516 | src/server/router/golden-image-quality.test.ts:7; src/server/router/golden-image-quality.test.ts:13; src/server/router/label-blockers.ts:25 | IMPLEMENTED-UNVERIFIED ▲ |
| TH-R11 | Five sample-label fields | TRO-458, TRO-461, TRO-469, TRO-470, TRO-515 | golden-set/manifest.json:5; scripts/eval/results/eval-report.json:4; scripts/eval/results/eval-report.json:182 | VERIFIED ▲ |
| TH-R12 | Golden test-label image set | TRO-458, TRO-497, TRO-498, TRO-499, TRO-505, TRO-515, TRO-469, TRO-530 | golden-set/README.md:15; golden-set/manifest.json:931; scripts/golden/verify.ts:13 | VERIFIED ▲ |
| TH-R13 | Public, buildable repo | TRO-456 | package.json:2; package.json:12; .github/workflows/ci.yml:74 | VERIFIED |
| TH-R14 | README setup/run instructions | TRO-484 | — | MISSING |
| TH-R15 | Approach/tools/assumptions doc | TRO-485 | docs/PRD.md:241; docs/error-states.md:14 | MISSING |
| TH-R16 | Deployed, reachable URL | TRO-481, TRO-483, TRO-518 | render.yaml:26; docs/deploy.md:88; docs/deploy.md:94 | MISSING |
| TH-R17 | Rubric: core works completely | TRO-465, TRO-514, TRO-468, TRO-475, TRO-470, TRO-518, TRO-516 | src/app/api/verify/route.ts:2; src/app/api/verify/route.ts:31; src/server/comparators/brand.ts:3 | PARTIAL |
| TH-R18 | Rubric: code quality | TRO-456, TRO-479 | package.json:14; package.json:15; .github/workflows/ci.yml:20 | VERIFIED |
| TH-R19 | Rubric: appropriate tech, defended | TRO-456, TRO-462, TRO-470, TRO-485 | src/server/router/index.ts:5; src/app/api/verify/route.ts:13; scripts/eval/results/benchmark-report.json:42 | PARTIAL |
| TH-R20 | Rubric: UX + error handling | TRO-465, TRO-466, TRO-473, TRO-475, TRO-476, TRO-478, TRO-479 | src/app/_components/ErrorPanel.tsx:12; src/app/_components/ErrorPanel.tsx:27; src/app/api/verify/route.test.ts:260 | VERIFIED |
| TH-R21 | Rubric: traceability | TRO-486 | factory/tickets.md:3; factory/tickets.md:8; CHANGES.md:3 | PARTIAL |
| TH-R22 | Rubric: creative problem-solving | TRO-457, TRO-464, TRO-476, TRO-470 | docs/PRD.md:33; src/app/review-queue/page.tsx:2; CHANGES.md:2798 | VERIFIED ▲ |
| TH-R23 | Working core > ambition; trade-offs doc | TRO-485, TRO-484 | factory/tickets.md:8; docs/deploy.md:84; docs/error-states.md:154 | ASSUMED ▼ |
## Delta vs 2026-08-11-pm

| ID | Change | Why |
|---|---|---|
| TH-R2 | VERIFIED → **PARTIAL** ▼ | Verdict held at PARTIAL. Every cited line exists and reads as claimed. I checked the tracer's ordering claim with git, not by inference: commit c5e49f8 wired the warning comparator into the route at 2 |
| TH-R3 | IMPLEMENTED-UNVERIFIED → **VERIFIED** ▲ | Verdict held at VERIFIED. I opened all thirteen cited lines. Twelve read exactly as claimed. One overreached: globals.css:63 records 5.63:1 and 3.26:1, not the 2.14:1 failure. That figure sits at glob |
| TH-R7 | MISSING → **PARTIAL** ▲ | CITATION CHECK. I opened all ten cited lines. All ten exist and all support their claim. I tightened one supports string: ocr.ts:83 sets langPath, and by itself proves configuration, not the absence o |
| TH-R9 | MISSING → **ASSUMED** ▲ | Downgraded from VERIFIED to ASSUMED. The code is real and the tests are green. The verdict is not yet earned.  Two citations were wrong, and I corrected both. src/server/warning/index.ts: the quoted s |
| TH-R10 | PARTIAL → **IMPLEMENTED-UNVERIFIED** ▲ | Verdict downgraded from the tracer's VERIFIED, and two statements of fact corrected. All eight of the tracer's citations hold. Each line exists and says what the entry claims. Corrected fact 1. The tr |
| TH-R11 | PARTIAL → **VERIFIED** ▲ | Verdict held at VERIFIED, and the upgrade is justified: the prior sweep held this row down because case-01 had never passed a real-model run, and the committed live report now shows it passing on all  |
| TH-R12 | PARTIAL → **VERIFIED** ▲ | All seven of the tracer's citations hold. Each line exists and says what the entry claims. I re-ran `pnpm golden:verify` and got the tracer's exact two lines, then re-ran it again to read the exit cod |
| TH-R22 | IMPLEMENTED-UNVERIFIED → **VERIFIED** ▲ | All six citations hold; I opened every one. Four supports quotes ran past their anchor line, so I trimmed each to the cited line and named the continuation. I re-ran the targeted command and reproduce |
| TH-R23 | PARTIAL → **ASSUMED** ▼ | All four cited lines exist and say what the row claims. I trimmed the PRD.md:241 quote back to its own line, as in TH-R15. I verified the tracer's "new since the last sweep" claim rather than take it: |
## Gate commands (this sweep)

| Command | Result |
|---|---|
| `pnpm db:migrate` | exit 0 — 4 migrations applied to `labelhunter_audit_0812` |
| `pnpm typecheck` | exit 0 — no diagnostics (after the `pnpm install` fix above) |
| `pnpm lint` | exit 0 — 0 errors, 1 pre-existing warning (`DetailView.tsx:112`, `no-img-element`) |
| `pnpm test` | exit 0 — **1524 passed in 137 files** (baseline: 681 in 59) |
| `pnpm build` | exit 0 — **15 routes** (baseline: 6) |

The suite more than doubled since the last sweep and stayed at 100% pass.
