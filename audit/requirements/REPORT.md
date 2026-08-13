# Requirements Audit — LabelHunter

**Commit:** 876a295083a8704ad40d4fc9ce09217b582ecf94 (clean, matches `origin/main`) · **Date:** 2026-08-13T17:00Z · **Docs:** TH (source-TH.md, textutil cache, sha256 unchanged) · **Mode:** compare (`2026-08-13-tro486` vs `matrix.after-2026-08-13.json`)

## Summary

**VERIFIED** 12 · **PARTIAL** 8 · **MISSING** 2 · **IMPLEMENTED-UNVERIFIED** 1 · **ASSUMED** 0 · **N/A** 0 · **BLOCKED** 0. (23 active requirements.)

**One row moved this sweep, and it moved down.** TH-R2 (single-label ≤~5s p50) held VERIFIED at the last two sweeps. Re-running the same INT-002 staleness check this sweep at current HEAD (~99 commits later) finds four commits that rewrote files the latency artifact's own `pipelineScope` names as the measured path — two in the deterministic Validation Router (TRO-502), one in the government-warning region-detection threshold (TRO-546), one in router LOW_IMAGE_QUALITY tracking (TRO-542) — all landing after the artifact's 2026-08-13T12:40:42Z measurement. INT-002 is unconditional: a stale artifact never supports VERIFIED, regardless of how small the real timing effect probably is. TH-R2 is now PARTIAL. This is the single most consequential finding in this sweep — not because the number is likely wrong, but because a VERIFIED row was resting on evidence that had quietly stopped being current, and the same drift could recur on any row that leans on a dated artifact instead of a fresh assertion.

**The build is done; the submission is not.** The same two requirements remain MISSING as the last two sweeps — `README.md` (TH-R14) and `docs/approach.md` (TH-R15) — and neither needs a line of code. Between them they also hold down five other PARTIAL rows: TH-R7, TH-R19, TH-R21 and TH-R23 each trace to real, correct content that lives in an internal document an evaluator will never open, and TH-R6 needs one section in the README once it exists. Six of the eight non-VERIFIED rows resolve on one writing session.

**Label-verdict accuracy improved and is now honestly banded, not a lucky point figure.** TRO-561 (Done) replaced a baseline pinned to the top of a measured variance spread with a real K=3 band: extraction 87.22%–87.78%, cascade-verdict 80.56%–83.33%, over a golden set that grew from 32 to 36 cases this sweep period (TRO-529 added five real bottle photographs). `pnpm eval:check` passes cleanly against that band today. Cascade-verdict accuracy (80.56%) still sits well below extraction accuracy (87.22%) — 7 of 36 cases land on the wrong end-state verdict, six of them sharing one pattern (a deliberately degraded image reads confidently on a single channel). TH-R17 stays PARTIAL.

## Coverage and limitations

- **This sweep wrote to a database.** `pnpm db:migrate` and `pnpm test` ran against `labelhunter_audit_0813b`, a throwaway created on the `labelhunter-pg` container for this run. Observed afterward, not assumed from exit code: the audit database holds 8 migration rows and 9 product tables; `labelhunter_dev` held 2 rows before and after, untouched.
- **`pnpm test:e2e` did NOT run** (it boots a dev server). TH-R1, TH-R3 and TH-R20 lean on a dated CI job (TRO-522, `.github/workflows/ci.yml`) that runs the Playwright suite automatically against a fake Anthropic server, plus that ticket's own historical pass count — not a fresh run this sweep.
- **`pnpm latency:check`, `pnpm eval --full` and `pnpm eval:variance` did NOT run** — all three make billed API calls, and this session's lane is docs/audit-only. Their committed artifacts are accepted under INT-002 where the staleness check passes (TH-R10, TH-R11, TH-R22) and rejected where it doesn't (TH-R2, downgraded — see Summary). TH-R17/TH-R19/TH-R22 carry an explicit staleness caveat on the accuracy band itself: TRO-502 and the TRO-506/507/512/524 review-queue commits landed in `src/` after the band's own `codeCommitSha`. TRO-502's own `CHANGES.md` entry argues, via an evidence-presence check across every case in the committed `eval-report.json`, that its change alters zero cases' outcomes — this sweep did not independently re-run a live eval to confirm that. The band is very likely still representative; it was not re-measured after those specific commits.
- **This sweep used a six-agent fan-out**, not single-session tracing. Six clusters (core/UX, latency/batch, matching/warning, golden-set/eval/accuracy, deliverables/docs, process/infra) each re-traced their assigned rows independently against current HEAD, re-opening every citation rather than copying the prior sweep's rows forward. The orchestrator spot-checked 10 citations directly across clusters (TH-R1's corrected eval-report.json line, TH-R2's two downgrade citations plus the git-log staleness check, TH-R6's three schema/comment citations, TH-R9's region-detect regression test, TH-R13's `gh repo view`, TH-R21's corrected grep count) — all ten opened exactly as claimed.
- **No live browser this sweep.** TH-R3's and TH-R20's UX claims rest on component tests, a dated CI e2e job's configuration, and that job's own historical pass count — not a fresh observation.
- **The deployed instance does not expose its running commit.** TH-R16 proves a working prototype is reachable and fast (re-probed directly this sweep: HTTP 200 in 0.40s, `/api/health` ok); it does not prove the deployment serves this exact tree. TH-R16's "verify succeeds" half rests on a 20-run artifact that itself predates 8 later pipeline commits — carried as an explicit `assumption` field on that row (judged non-breaking, not re-measured) rather than folded silently into VERIFIED.
- **Two factories are running in parallel.** This sweep measures merged `main` at 876a295 only; two other sessions were active in the same working tree during this sweep, both confirmed by direct message to be working disjoint lanes (auth/PR #43, factory tooling/lessons). PR #43 (TRO-482, key protection) remains OPEN and unmerged — confirmed via `gh pr view 43` this sweep, not inferred from Linear status alone.
- **106+ evidence citations were opened by the tracing sub-agents**, each confirming file/line existence and content against the claim; the orchestrator additionally re-verified 10 directly (listed above). Several citations moved from the stale draft: `scripts/eval/results/eval-report.json`'s line numbers shifted after TRO-561's rebaseline rewrote the file (TH-R1, TH-R11), and `TH-R21`'s ticket-coverage grep was corrected from a flawed `*`-quantifier count of 23 to a correct `+`-quantifier count of 22.
- **Ticket-mapping corrections made during synthesis.** Six Done tickets clearly advancing a requirement were found via a full reconciliation against all 93 project issues but were not cited by the tracing sub-agents: TRO-459 (CP-1 checkpoint) added to TH-R19; TRO-502 (router rule-1 fix) added to TH-R17; TRO-507, TRO-512, TRO-524 (review-queue hardening) added to TH-R22; TRO-509 (compositor warning-integrity fix) added to TH-R9; TRO-541 (eval-harness sample-map fix) added to TH-R22. Two Backlog tickets targeting unbuilt stretch scope (TRO-528, TRO-532 — bold-detection golden cases and an advisory bold check) are neither cited as evidence (nothing exists yet to cite) nor listed as orphans (they do target real requirement scope) — named here so the sweep does not silently drop them.
- Linear resolved OK: 93 issues pulled from project `LabelHunter` only, fresh this sweep. No BLOCKED cells.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: label in → per-field verdicts | TRO-461, 462, 463, 465, 514, 479, 539 | src/app/api/verify/route.ts:441; VerifyForm.tsx:200; ResultsChecklist.tsx:80 | VERIFIED |
| TH-R2 | Single-label ≤~5s p50 | TRO-471, 514, 519, 539 | scripts/latency/results/single-label-verify-url-mode.json:37; src/server/router/overrides.ts:67; src/server/warning/region-detect.ts:64 | **PARTIAL ▼** |
| TH-R3 | 73-year-old UX benchmark | TRO-465, 466, 475, 476, 479, 480, 522 | VerifyForm.tsx:200; VerifyForm.test.tsx:69; globals.css:82; .github/workflows/ci.yml:278 | VERIFIED |
| TH-R4 | Batch mode (200–300 scale) | TRO-473, 474, 475, 472, 518, 506, 522, 544, 547 | src/server/batch/constants.ts:24; start-batch.ts:138; local-batch-run.json:26 | PARTIAL |
| TH-R5 | Standalone, no COLA integration | *(unticketed by design)* | docs/PRD.md:46; src/server/router/required-fields.ts:21; docs/error-states.md:31 | IMPLEMENTED-UNVERIFIED |
| TH-R6 | No PII / sane secrets posture | TRO-457, 484, 482 | src/lib/db/schema.ts:167; schema.ts:431; record-disposition.ts:11 | PARTIAL |
| TH-R7 | Constrained-network dependency doc | TRO-478, 468, 485, 519 | docs/error-states.md:17; :27; :28 | PARTIAL |
| TH-R8 | Lenient/judgment field matching | TRO-462, 463, 504, 465, 536 | src/server/comparators/brand.ts:57; :64; brand.test.ts:24 | VERIFIED |
| TH-R9 | Warning exact word-for-word check | TRO-467, 468, 469, 514, 517, 537, 527, 535, 546, 533, 563, 558, 509 | route.ts:301; wording-compare.ts:65; index.test.ts:187,214,240 | VERIFIED |
| TH-R10 | Imperfect-image handling | TRO-477, 460, 497, 470, 516, 542, 540, 546, 563, 529 | label-blockers.ts:25; eval-report.json:3776; baseline.json:151,163 | VERIFIED |
| TH-R11 | Five sample-label fields | TRO-458, 461, 469, 470, 515 | golden-set/manifest.json:5; golden-case.test.ts:33; eval-report.json:54 | VERIFIED |
| TH-R12 | Golden test-label image set | TRO-458, 497, 498, 499, 505, 515, 469, 530, 516, 527, 529 | golden-set/README.md:3,14; manifest.json:1; verify.ts:1 | VERIFIED |
| TH-R13 | Public, buildable repo | TRO-456 | package.json:2,12; ci.yml:117; `gh repo view` | VERIFIED |
| TH-R14 | README setup/run instructions | TRO-484 | — | **MISSING** |
| TH-R15 | Approach/tools/assumptions doc | TRO-485 | — | **MISSING** |
| TH-R16 | Deployed, reachable URL | TRO-481, 483, 518, 539 | single-label-verify-url-mode.json:15,27,30; render.yaml:26 | VERIFIED |
| TH-R17 | Rubric: core works completely | TRO-465, 514, 468, 475, 470, 518, 516, 534, 538, 543, 546, 561, 563, 502 | eval-report.json:50,81,141; baseline.json:51; variance-report.json:54 | PARTIAL |
| TH-R18 | Rubric: code quality | TRO-456, 479, 508, 513, 522, 547 | package.json:14,15; ci.yml:88; DetailView.tsx:112 | VERIFIED |
| TH-R19 | Rubric: appropriate tech, defended | TRO-456, 462, 470, 485, 538, 459 | router/index.ts:5; route.ts:13; benchmark-report.json:178 | PARTIAL |
| TH-R20 | Rubric: UX + error handling | TRO-465, 466, 473, 475, 476, 478, 479, 519 | ErrorPanel.tsx:12,27; route.test.ts:289,377 | VERIFIED |
| TH-R21 | Rubric: traceability | TRO-486 | factory/tickets.md:3,365; CLAUDE.md:17 | PARTIAL |
| TH-R22 | Rubric: creative problem-solving | TRO-457, 464, 476, 470, 511, 543, 561, 507, 512, 524, 541 | docs/PRD.md:53,33; review-queue/page.tsx:2; reconcile.ts:2 | VERIFIED |
| TH-R23 | Working core > ambition; trade-offs doc | TRO-485, 484 | factory/tickets.md:8; docs/deploy.md:84; docs/error-states.md:154 | PARTIAL |

## Gaps

| ID | Verdict | The missing part |
|---|---|---|
| TH-R14 | MISSING | No README exists, tracked or untracked. TRO-484 is in Backlog. |
| TH-R15 | MISSING | `docs/approach.md` does not exist. TRO-485 is in Backlog. Blocks TH-R7, TH-R19, TH-R21, TH-R23. |
| TH-R2 | PARTIAL | The deployed-latency artifact predates four commits touching its own declared measured path (TRO-502, TRO-542, TRO-546). Needs a fresh `latency:check` run and commit. |
| TH-R4 | PARTIAL | No batch has run at the brief's 200–300 scale. The largest real run is 32 items, local. |
| TH-R6 | PARTIAL | The README must state the data-handling posture. TRO-482 (key protection) is In Review/PR #43 OPEN, unmerged. |
| TH-R7 | PARTIAL | The dependency table is complete but lives only in `docs/error-states.md`, which says so itself. |
| TH-R17 | PARTIAL | Cascade-verdict accuracy 80.6%, within a real K=3 band but still 7 of 36 cases wrong at end-state. Six share one pattern (single-channel confident read masking an expected REVIEW); one (case-19) is a known deskew gap (TRO-540). |
| TH-R19 | PARTIAL | The technical defence is real, measured, and checkpoint-witnessed (CP-1/TRO-459) but appears in no graded deliverable. |
| TH-R21 | PARTIAL | 22 of 22 ticketable requirements are traced internally (corrected count); no reader-facing descoping statement exists. |
| TH-R23 | PARTIAL | Prioritisation half met. The written trade-offs section is in the wrong documents (INT-003). |

Full detail, with suggested scope per row, in `gaps.md`.

## Orphan tickets

Eighteen tickets in project LabelHunter map to no brief requirement — factory tooling, gate policy, changelog/test-fixture hygiene, or explicitly parked/deferred tracks. Listed in `gaps.md` so this sweep is not read as calling them waste. Two additional Backlog tickets (TRO-528, TRO-532) target real but unbuilt stretch scope on TH-R9/TH-R12 — not orphans, not yet evidenced, named in Coverage and limitations above.

## Blocked / assumed

No BLOCKED cells (Linear resolved fully). One `assumption` this sweep, on TH-R16: the deployed instance's 20-run verify-success artifact predates 8 later pipeline commits, judged non-breaking (edge-case verdict refinements, not a change to whether a clean request completes) but not independently re-measured — see that row's `assumption` field. No `ASSUMED`-tier rows: the three standing rulings (INT-001, INT-002, INT-003) covered every ambiguity this sweep raised.

## Delta vs 2026-08-13 (commit 96d59f4)

| ID | prior verdict | now | evidence change |
|---|---|---|---|
| TH-R2 | VERIFIED | **PARTIAL ▼** | INT-002's staleness check, re-run against ~99 further commits, now finds four commits (TRO-502, TRO-542, TRO-546) that rewrote files the latency artifact's own `pipelineScope` names as measured — none present at the prior sweep's check. The p50/p95 figures are very likely still close to accurate; they no longer certifiably measure the code that ships at this commit. |
| TH-R21 | PARTIAL (23 IDs, described as full coverage) | PARTIAL (22 IDs, corrected) | The prior sweep's own coverage count used a flawed `*`-quantifier grep that double-counted a bogus prose match. The corrected `+`-quantifier count is 22, still full coverage of every requirement meant to be ticketed (TH-R5 is unticketed by design) — a citation correction, not a verdict change. |

No other row changed verdict. TH-R4, TH-R6, TH-R7, TH-R17, TH-R19, TH-R23 held at PARTIAL; TH-R14, TH-R15 held at MISSING; all twelve VERIFIED rows besides TH-R2 held, most strengthened with fresh evidence (golden set 32→36 cases, test suite 1928→2108 tests, TRO-529's real photographs, TRO-546's OCR-channel fix, a dated CI e2e job).

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `CREATE DATABASE labelhunter_audit_0813b` | CREATE DATABASE | (sweep setup) |
| `pnpm db:migrate` | exit 0 — 8 migrations applied to the audit database | TH-R6, TH-R13, TH-R18 |
| `pnpm typecheck` | exit 0 — no diagnostics | TH-R18 |
| `pnpm lint` | exit 0 — 0 errors, 1 pre-existing warning | TH-R18 |
| `pnpm build` | exit 0 — 15 routes | TH-R13, TH-R18 |
| `pnpm test` | exit 0 — **169 files / 2108 tests passed** | TH-R1, R3, R8, R9, R12, R18, R20, R22 |
| `pnpm eval:check` (cheap mode) | PASS — 87.2% extraction / 80.6% cascade-verdict, both within the K=3 band | TH-R10, R11, R17 |
| `curl https://labelhunter-web.onrender.com/` | http=200 in 0.398s | TH-R16 |
| `curl .../api/health` | http=200, `{"status":"ok"}` | TH-R16 |
| `gh repo view --json visibility,url,isPrivate` | PUBLIC, github.com/troysatchell/LabelHunter | TH-R13 |
| `gh pr view 43 --json state,mergedAt` | OPEN, mergedAt null | TH-R6, R14, R15, R16 |
| `git log --since="...12:40:42Z" -- src/server/router/ src/server/warning/` | 4 commits touch the measured latency pipeline after the artifact | TH-R2 (INT-002, downgrade) |
| `grep -o "TH-R[0-9]\+" factory/tickets.md \| sort -u \| wc -l` | 22 — corrected full inventory coverage | TH-R21 |
| `git ls-files \| grep -iE "readme\|approach"` | `golden-set/README.md` only | TH-R14, TH-R15 |
| `pnpm test:e2e` | **NOT RUN** — boots a dev server | TH-R1, R3, R20 |
| `pnpm latency:check` | **NOT RUN** — billed API calls; prior artifact found stale (TH-R2 downgrade) | TH-R2 |
| `pnpm eval -- --full` / `pnpm eval:variance` | **NOT RUN** — billed API calls; committed artifacts accepted under INT-002 with staleness caveats on TH-R17/R19/R22 | TH-R10, R11, R17, R22 |

Captured output for the VERIFIED rows:

```text
pnpm test
 Test Files  169 passed (169)
      Tests  2108 passed (2108)

pnpm build
✓ Compiled successfully
✓ Generating static pages using 13 workers (10/10)
Route (app) — 15 routes

pnpm eval:check
check.ts: extraction accuracy 87.2% is within the measured 87.2%-87.8% band (K=3).
check.ts: cascade-verdict accuracy 80.6% is within the measured 80.6%-83.3% band (K=3).
check.ts: PASS

curl https://labelhunter-web.onrender.com/api/health
{"status":"ok","service":"labelhunter","timestamp":"2026-08-13T16:52:22.311Z"}
```

The suite grew from 160 files / 1928 tests to 169 files / 2108 tests since the last sweep and stayed at 100% pass. The golden set grew from 32 to 36 cases (TRO-529's five real photographs). This is the compare sweep TRO-486 asked for; `gaps.md` carries the PM handoff — concrete, executable scope for TRO-484 (README), TRO-485 (approach.md), and TRO-483 (seeded demo).
