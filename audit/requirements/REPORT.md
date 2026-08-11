# Requirements Audit — LabelHunter
**Commit:** cbc7088 (clean) · **Date:** 2026-08-11T21:51:53Z · **Docs:** TH (source-TH.md, textutil cache) · **Mode:** compare (`2026-08-11-pm` vs `matrix.baseline.json`)

## Summary

Verdicts: **VERIFIED** 6 · **PARTIAL** 9 · **MISSING** 5 · **IMPLEMENTED-UNVERIFIED** 3 · **N/A** 0 · **BLOCKED** 0 · **ASSUMED** 0. (23 active requirements.)

The most consequential finding: **the only real (non-mocked) evidence of live model behavior — the TH-R2 latency harness's 20 real Haiku calls against the golden set's own flagship reference case — shows every single run landed on REVIEW / LOW_MODEL_CONFIDENCE, never a clean pass.** The measured p50 (4232ms) and p95 (4763ms) genuinely meet the ~5s target, so TH-R2 is real and green. But that run predates TRO-464 (the Sonnet resolver, LH-014), so it is fast-path-only evidence: nobody has yet measured whether the resolver — now merged — actually clears these low-confidence cases, or whether the extractor/router calibration itself needs a pass. Every other piece of behavioral evidence for the core loop (TH-R1, TH-R8, TH-R11) comes from tests with a *mocked* Anthropic call. Re-running the harness is cheap and would close this uncertainty directly. Second, unchanged from this morning: **CP-2 and CP-3 remain the structural blockers** for TH-R9 (the brief's own headline "word-for-word" requirement) and TH-R4 (batch) — TRO-467 moved Backlog → In Progress since this morning but is not yet Done, and every downstream ticket for both waves is otherwise ready. Against that backdrop, the volume of real progress since baseline is substantial: 9 rows upgraded verdict tier (0 downgraded), the test suite grew from 249 to 681 (all green), the golden set went from 0 to 29 real committed images, and the core single-label loop plus its full designed-error-state taxonomy are now genuinely VERIFIED rather than aspirational.

## Coverage and limitations

- **Sweep point is `origin/main` at commit cbc7088, not local `main`.** Local `main` was 17 commits behind `origin/main` (PR #15 merged during this session, mid-audit) and 2 commits ahead with unpushed docs-only commits (`bb76a2f`, `10e81a3`) that touch no code this matrix cites. The sweep ran from a disposable `git worktree add --detach origin/main`, removed after this run. PR #16 (LH-050, review-queue UI, TRO-476) is **open, not merged** — its code is genuinely absent from every row in this matrix; see TH-R22's notes.
- **This sweep wrote to a database.** `pnpm db:migrate` and `pnpm test` ran against `labelhunter_audit_sweep`, a throwaway Postgres database created fresh for this run on the existing `labelhunter-pg` container and dropped immediately after (see Cleanup). No other worktree's database was touched.
- **`pnpm latency:check` did NOT run this sweep.** It makes real, billed Anthropic API calls. TH-R2 and TH-R11 cite the existing dated artifact (`scripts/latency/results/single-label-verify.json`, measured 2026-08-11T17:45:48Z) rather than a fresh run, specifically to avoid spending without being asked — see the Summary finding above for why a fresh run is the single highest-value next measurement.
- **`pnpm test:e2e` did not run** (same reason as the last two sweeps): it boots a real dev server, and the repo's only spec covers `/api/health`, which bears on no row.
- **No live browser click-through this sweep.** TH-R3's "heuristic UX review" and TH-R20's UX-heuristic half rest on reading the UI component code (labeled fields, single submit path, `role="alert"` error panels), not on driving the app in a real browser. `verify_urls.app` stays null — no deployed instance exists yet (TH-R16).
- No dedicated secret scanner ran (unchanged from baseline); TH-R6's evidence is a manual pattern grep plus file reads, not a scanner tool's output.
- 12 of 23 rows carry no live-model or live-browser behavioral evidence at all (everything except the 6 VERIFIED rows and TH-R2/R11's harness citation); those 12 rest on file:line trace plus the green mocked-test suite.
- The Linear ticket dimension resolved OK — 39 issues pulled from project `LabelHunter` only (up from 37 this morning; TRO-505 and TRO-506 are new, both review-flagged findings); no BLOCKED cells.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: label in → per-field verdicts out | TRO-461✅, TRO-464✅, TRO-465✅, TRO-502 | route.ts:166; VerifyForm.tsx:200; route.test.ts:107 | VERIFIED ▲▲ |
| TH-R2 | Single-label ≤~5s p50 | TRO-471✅, TRO-462✅ | latency/results/single-label-verify.json:30-31 | VERIFIED ▲▲ |
| TH-R3 | 73-year-old UX benchmark | TRO-465✅, TRO-466✅, TRO-475, TRO-480 | page.tsx:1; VerifyForm.tsx:95,200 | IMPLEMENTED-UNVERIFIED ▲ |
| TH-R4 | Batch mode (200–300 scale) | TRO-473, TRO-474, TRO-475, TRO-472, TRO-506 | schema.ts:75; worker/.gitkeep | PARTIAL |
| TH-R5 | Standalone, no COLA integration | *(unticketed)* | PRD.md:46; schema.ts:146; grep clean | IMPLEMENTED-UNVERIFIED |
| TH-R6 | No PII / sane secrets posture | TRO-457✅, TRO-482, TRO-484 | PRD.md:46; schema.ts:146; .gitignore:8-9 | PARTIAL |
| TH-R7 | Constrained-network dependency doc | TRO-478, TRO-485 | — | MISSING |
| TH-R8 | Lenient/judgment field matching | TRO-462✅, TRO-463✅, TRO-504✅ | brand.test.ts:24; route.test.ts:169 | VERIFIED ▲▲ |
| TH-R9 | Warning exact word-for-word check | TRO-468, TRO-469 | router/index.ts:236 (contract only); route.ts:166 (null) | MISSING |
| TH-R10 | Imperfect-image handling | TRO-460✅, TRO-477, TRO-497✅ | pipeline.ts:73; label-blockers.ts:20; golden-set/README.md:14 (29 images) | PARTIAL ▲ |
| TH-R11 | Five sample-label fields | TRO-461✅, TRO-463✅, TRO-504✅ | manifest.json:5; route.test.ts:107; latency-results (live, REVIEW every run) | PARTIAL ▲ |
| TH-R12 | Golden test-label image set | TRO-458✅, TRO-497✅, TRO-498, TRO-499, TRO-469, TRO-479, TRO-505✅ | golden-set/README.md:14 (29/29 images, up from 0) | PARTIAL |
| TH-R13 | Public, buildable repo | TRO-456✅ | gh repo view PUBLIC; fresh install+build+test green | VERIFIED |
| TH-R14 | README setup/run instructions | TRO-484 | — | MISSING |
| TH-R15 | Approach/tools/assumptions doc | TRO-485 | — | MISSING |
| TH-R16 | Deployed, reachable URL | TRO-481, TRO-483 | — | MISSING |
| TH-R17 | Rubric: core works completely | TRO-469, TRO-470, TRO-486, TRO-499 | route.test.ts:107; brand.test.ts:24 | PARTIAL ▲ |
| TH-R18 | Rubric: code quality | TRO-456✅ | ci.yml:1; 681/681 tests green (up from 249) | VERIFIED |
| TH-R19 | Rubric: appropriate tech, defended | TRO-456✅, TRO-462✅, TRO-470 | PRD.md:33; prompt.ts:4 | PARTIAL |
| TH-R20 | Rubric: UX + error handling | TRO-465✅, TRO-466✅, TRO-473, TRO-475, TRO-478, TRO-479 | ErrorPanel.tsx:12; route.test.ts:223-291 (5 designed states) | VERIFIED ▲▲ |
| TH-R21 | Rubric: traceability | TRO-486 | factory/tickets.md:8; CLAUDE.md:17 | PARTIAL |
| TH-R22 | Rubric: creative differentiator | TRO-457✅, TRO-464✅, TRO-476 | PRD.md:33 (named); resolver/index.ts:1 (real, tested) | IMPLEMENTED-UNVERIFIED ▲ |
| TH-R23 | Rubric: prioritize core + trade-offs doc | TRO-485 | PRD.md:241 (planned, not written) | PARTIAL |

✅ = ticket Done in Linear. ▲ = verdict upgraded since baseline; ▲▲ = upgraded two tiers.

## Delta

| ID | Baseline verdict | Now | Evidence change |
|---|---|---|---|
| TH-R1 | MISSING | VERIFIED | Full loop wired and tested end to end: VerifyForm → route.ts → routeLabel → DB → ResultsChecklist/DetailView; route.test.ts:107 persists every table |
| TH-R2 | MISSING | VERIFIED | Real 20-run harness: p50=4232ms, p95=4763ms vs. 5000ms target — met, but see Summary's staleness caveat |
| TH-R3 | MISSING | IMPLEMENTED-UNVERIFIED | page.tsx is a real single-flow form now, not a placeholder — no live click-through yet |
| TH-R8 | MISSING | VERIFIED | STONE'S THROW flagship case passes at both unit (brand.test.ts:24) and route/integration level (route.test.ts:169) |
| TH-R10 | MISSING | PARTIAL | 29 real degraded golden images committed (0 at baseline); preprocessing/low-quality-detection code unchanged |
| TH-R11 | MISSING | PARTIAL | Mocked round-trip passes; live harness ran against this exact case but never produced a clean pass (see Summary) |
| TH-R17 | MISSING | PARTIAL | Follows TH-R1/TH-R8/TH-R11 upgrades |
| TH-R20 | MISSING | VERIFIED | 5 distinct designed error states now tested at the route level (400/422/502/503×2), ErrorPanel wired into the UI |
| TH-R22 | MISSING | IMPLEMENTED-UNVERIFIED | PRD.md:33 now explicitly names the differentiator by requirement ID; resolver+queue backend is real and tested (demo UI still unmerged, PR #16) |

Nine upgrades, zero downgrades. TH-R4, TH-R6, TH-R9, TH-R12, TH-R13, TH-R14, TH-R15, TH-R16, TH-R18, TH-R19, TH-R21, TH-R23, TH-R5 hold their baseline tier (TH-R12's evidence strengthened enormously — 0→29 images — without a tier change, since its two remaining sub-obligations, LH-005 and LH-006, are both still open; TH-R13's fresh-install evidence closes a caveat without changing its tier).

## Gaps

See `gaps.md`. Summary: 5 MISSING rows (TH-R7, R9, R14, R15, R16) and 9 PARTIAL rows. Every requirement is ticketed except TH-R5 (unticketed, satisfied by omission — correct). The two structural blockers remain human checkpoints, not code: CP-2 (TRO-467, now In Progress) gates TH-R9; CP-3 (TRO-472, still Backlog) gates Wave 3 / TH-R4.

## Orphan tickets

Four, all PRD §10 process checkpoints — expected, not a finding (unchanged set from the last two sweeps):

- TRO-459 — LH-CP1 walkthrough (Done, cleared 2026-08-10)
- TRO-467 — LH-CP2 walkthrough (**moved Backlog → In Progress since this morning** — still the critical-path blocker for TH-R9)
- TRO-472 — LH-CP3 walkthrough (Backlog, unchanged — the only remaining blocker for Wave 3 / TH-R4)
- TRO-487 — LH-070 final submission gate (Troy-only)

## Blocked / assumed

None. The Linear dimension resolved OK; no ambiguity needed a user ruling this sweep (`interpretations.md` still has no entries — nothing to apply, nothing new to log).

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `shasum -a 256 <TH source docx>` | Matches config — inventory current, compare mode valid | (doc currency) |
| `pnpm install` | exit 0 — fresh install, disposable worktree | TH-R13 |
| `pnpm db:migrate` | exit 0 — applied cleanly against throwaway `labelhunter_audit_sweep` | (DB-write disclosure) |
| `pnpm typecheck` | exit 0 | TH-R13, TH-R18 |
| `pnpm lint` | exit 0 — 0 errors, 1 pre-existing accepted warning | TH-R13, TH-R18 |
| `pnpm test` | exit 0 — 59 files, 681/681 tests passed | TH-R1, TH-R8, TH-R13, TH-R18, TH-R20 |
| `pnpm build` | exit 0 — 6 routes | TH-R13, TH-R18 |
| `pnpm test:e2e` | NOT RUN — dev-server boot; only spec covers /api/health | — |
| `pnpm latency:check` | NOT RUN — would spend real Anthropic API budget; reused dated artifact | TH-R2, TH-R11 |
| `gh repo view troysatchell/LabelHunter` | isPrivate:false, PUBLIC | TH-R13 |
| `grep -rn COLA src/` | 1 match, doc comment only — no integration | TH-R5 |
| `grep` secret-pattern scan | 0 matches | TH-R6 |
| `find golden-set -iname '*.jpg' -o -iname '*.png'` | 29 | TH-R12 |

**Captured output — TH-R1/R8/R13/R18/R20 (`pnpm test`):**
```
 Test Files  59 passed (59)
      Tests  681 passed (681)
   Start at  16:44:48
   Duration  3.17s (transform 1.74s, setup 8.35s, import 8.63s, tests 6.75s, environment 2.67s)
```

**Captured output — TH-R2/R11 (`scripts/latency/results/single-label-verify.json`, not re-run this sweep):**
```
requestedRuns: 20, successfulRuns: 20, failedRuns: 0
verdictCounts: { "REVIEW": 20 }
summaryMs: { p50: 4232, p95: 4763 }  (target p50 ≤ 5000)
measuredAt: 2026-08-11T17:45:48.353Z — predates the Sonnet resolver merge (TRO-464)
```

## Cleanup

The disposable sweep worktree (`/tmp/lh-audit-sweep`, detached at `origin/main`) and its throwaway database (`labelhunter_audit_sweep`) are removed after this report is written — neither persists past this run.
