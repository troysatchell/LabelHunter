# Requirements Audit — LabelHunter
**Commit:** 9b34ced (clean) · **Date:** 2026-08-11T15:00:16Z · **Docs:** TH (source-TH.md, textutil cache) · **Mode:** compare (`status-2026-08-11` vs `matrix.baseline.json`)

## Summary

Verdicts: **VERIFIED** 2 · **PARTIAL** 13 · **MISSING** 7 · **IMPLEMENTED-UNVERIFIED** 1 · **N/A** 0 · **BLOCKED** 0 · **ASSUMED** 0. (23 active requirements.)

The most consequential finding: **the two unrun human checkpoints, CP-2 and CP-3, are now the critical path.** Wave 1's engine room landed since baseline — preprocessing (LH-010), the Haiku extractor (LH-011), and the validation router (LH-012) are merged, reviewed, and tested (the suite grew from 35 tests to 249, all green) — which moved seven rows from MISSING to PARTIAL and left zero regressions. But TH-R9 (the exact warning check, a headline brief requirement) cannot start until Troy runs the CP-2 walkthrough, and all of Wave 3 batch work (TH-R4) waits only on CP-3; every code prerequisite for both is already Done. The second finding worth acting on: the golden set still has **zero images** (TH-R12) while LH-004/005/006 sit unblocked in Backlog — that gap now also holds back behavioral verification of the extractor (TH-R11) and imperfect-image handling (TH-R10). TH-R5 (no COLA integration) remains the only unticketed requirement, satisfied by omission and re-confirmed by grep.

## Coverage and limitations

- `pnpm test:e2e` did not run (same reason as baseline: boots a real dev server; the one spec covers only `/api/health`, which bears on no row). Rows TH-R18/TH-R20 lean only on unit evidence.
- `pnpm install` did not run — node_modules was already present and current (the green build/test proves the dependency additions since baseline resolve). Baseline ran a fresh install, so conditions differ on that one command; TH-R13's verification does not lean on it, but "buildable from a literal fresh clone" remains unproven — run one before the LH-070 submission gate.
- `pnpm db:migrate` did not run — `drizzle/migrations/` is unchanged since baseline (0000 + 0001). This sweep touched no database: `pnpm test` is pure unit tests with no `DATABASE_URL` reference.
- No dedicated secret scanner ran (unchanged from baseline). TH-R6's PARTIAL reflects file reads, not a credential-pattern scan.
- 19 of 23 rows are statically traced only (everything except the 2 VERIFIED rows carries no behavioral verification; the 13 PARTIALs and TH-R5 rest on file:line evidence plus the green suite).
- The Linear dimension resolved OK — 37 issues pulled from project LabelHunter only; no BLOCKED cells.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: label in → per-field verdicts out | TRO-461✅, TRO-464, TRO-465, TRO-502 | extractor/index.ts:73; router/index.ts:122; page.tsx:5 | PARTIAL ▲ |
| TH-R2 | Single-label ≤~5s p50 | TRO-462✅, TRO-471 | — | MISSING |
| TH-R3 | 73-year-old UX benchmark | TRO-465, TRO-466, TRO-475, TRO-480 | page.tsx:1 (still placeholder) | MISSING |
| TH-R4 | Batch mode (200–300 scale) | TRO-473, TRO-474, TRO-475 | schema.ts:75; worker/.gitkeep | PARTIAL |
| TH-R5 | Standalone, no COLA integration | *(unticketed)* | docs/PRD.md:46; schema.ts:146; grep clean | IMPLEMENTED-UNVERIFIED |
| TH-R6 | No PII / sane secrets posture | TRO-457✅, TRO-482, TRO-484 | schema.ts:56; .gitignore:9 | PARTIAL |
| TH-R7 | Constrained-network dependency doc | TRO-478, TRO-485 | — | MISSING |
| TH-R8 | Lenient/judgment field matching | TRO-462✅, TRO-463, TRO-504 | router/index.ts:122; test-support.ts:10 | PARTIAL ▲ |
| TH-R9 | Warning exact word-for-word check | TRO-468, TRO-469 | warning/.gitkeep; router/types.ts:116 (contract only) | MISSING |
| TH-R10 | Imperfect-image handling | TRO-460✅, TRO-477, TRO-497 | preprocessing/pipeline.ts:73; errors.ts:24; label-blockers.ts:20 | PARTIAL ▲ |
| TH-R11 | Five sample-label fields | TRO-461✅, TRO-463, TRO-504 | golden-case.test.ts:22; manifest.json:5 | PARTIAL ▲ |
| TH-R12 | Golden test-label image set | TRO-458✅, TRO-497, TRO-498, TRO-499, TRO-469, TRO-479 | manifest.json:1; golden-set/README.md:12 | PARTIAL |
| TH-R13 | Public, buildable repo | TRO-456✅ | gh repo view PUBLIC; build+test green | VERIFIED |
| TH-R14 | README setup/run instructions | TRO-484 | — | MISSING |
| TH-R15 | Approach/tools/assumptions doc | TRO-485 | — | MISSING |
| TH-R16 | Deployed, reachable URL | TRO-481, TRO-483 | — | MISSING |
| TH-R17 | Rubric: core works completely | TRO-469, TRO-470, TRO-486, TRO-499 | golden-case.test.ts:22 | PARTIAL ▲ |
| TH-R18 | Rubric: code quality | TRO-456✅ | ci.yml:1; 249/249 tests green | VERIFIED |
| TH-R19 | Rubric: appropriate tech, defended | TRO-456✅, TRO-462✅, TRO-470 | PRD.md:53, :308; extractor/index.ts:9 | PARTIAL |
| TH-R20 | Rubric: UX + error handling | TRO-465, TRO-466, TRO-473, TRO-475, TRO-478, TRO-479 | preprocessing/errors.ts:24; reason-text.ts:27 | PARTIAL ▲ |
| TH-R21 | Rubric: traceability | TRO-486 | factory/tickets.md:8 | PARTIAL |
| TH-R22 | Rubric: creative differentiator | TRO-457✅, TRO-464, TRO-476 | router/index.ts:122; schema.ts:326 | PARTIAL ▲ |
| TH-R23 | Rubric: prioritize core + trade-offs doc | TRO-485 | factory/tickets.md:8 | PARTIAL |

✅ = ticket Done in Linear. ▲ = verdict upgraded since baseline.

## Delta

| ID | Baseline verdict | Now | Evidence change |
|---|---|---|---|
| TH-R1 | MISSING | PARTIAL | extractLabel (extractor/index.ts:73) + routeLabel (router/index.ts:122) merged; UI and resolver still absent |
| TH-R8 | MISSING | PARTIAL | Router escalation machinery live; comparators still placeholders (test-support.ts:10 says STONE'S THROW would NOT match) |
| TH-R10 | MISSING | PARTIAL | preprocessImage (pipeline.ts:73) + designed errors + isLowImageQuality (label-blockers.ts:20) landed |
| TH-R11 | MISSING | PARTIAL | Extractor round-trips the OLD TOM reference case (golden-case.test.ts:22); no live extraction yet |
| TH-R17 | MISSING | PARTIAL | Follows its constituents TH-R1/TH-R11 |
| TH-R20 | MISSING | PARTIAL | Error taxonomy (errors.ts:24) + per-row UI reason text (reason-text.ts:27) exist; no UI yet |
| TH-R22 | MISSING | PARTIAL | The cascade/triage differentiator is now merged code, not a plan; still not surfaced anywhere |

Seven upgrades, zero downgrades. Both VERIFIED rows re-verified under this sweep's commands. Non-verdict corrections: TH-R5's tickets cell is now `[]` (checked, none found) instead of the baseline's `["BLOCKED"]` sentinel, per report-format.md's definition of those two states; TH-R7 drops TRO-498 from its ticket list (that ticket cites only TH-R12); TH-R21's evidence now cites `factory/tickets.md` instead of the audit's own output directory (disallowed as evidence).

## Gaps

See `gaps.md`. Summary: 7 MISSING rows (TH-R2, R3, R7, R9, R14, R15, R16) and 13 PARTIAL rows. Every one is ticketed except TH-R5 (unticketed, but satisfied by omission). The two structural blockers are human checkpoints, not code: CP-2 (TRO-467) gates TH-R9; CP-3 (TRO-472) gates Wave 3 / TH-R4.

## Orphan tickets

Four, all PRD §10 process checkpoints — expected, not a finding:

- TRO-459 — LH-CP1 walkthrough (Done, cleared 2026-08-10)
- TRO-467 — LH-CP2 walkthrough (Backlog — **now the critical-path blocker for TH-R9**)
- TRO-472 — LH-CP3 walkthrough (Backlog — **the only remaining blocker for Wave 3 / TH-R4**)
- TRO-487 — LH-070 final submission gate (Troy-only)

## Blocked / assumed

None. The Linear dimension resolved OK; no ambiguity needed a ruling this sweep (the baseline's interpretations carry forward unchanged — there are none on file).

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `shasum -a 256 <TH source docx>` | Matches config — inventory current, compare mode valid | (doc currency) |
| `pnpm typecheck` | exit 0 | TH-R13, TH-R18 |
| `pnpm lint` | exit 0 | TH-R13, TH-R18 |
| `pnpm test` | exit 0 — 23 files, 249/249 tests passed | TH-R13, TH-R18 |
| `pnpm build` | exit 0 — routes: /, /_not-found, /api/health | TH-R13, TH-R18 |
| `gh repo view troysatchell/LabelHunter` | isPrivate:false, PUBLIC | TH-R13 |
| `grep -rn COLA src/` | no matches | TH-R5 |
| `pnpm install` | NOT RUN — node_modules current; fresh-clone check still owed before LH-070 | TH-R13 |
| `pnpm test:e2e` | NOT RUN — dev-server boot; only spec covers /api/health | TH-R18, TH-R20 |
| `pnpm db:migrate` | NOT RUN — no new migration; sweep stayed database-silent | TH-R6 |

**Captured output — TH-R13/TH-R18 (`pnpm test`):**
```
 Test Files  23 passed (23)
      Tests  249 passed (249)
   Start at  09:55:03
   Duration  1.34s (transform 1.37s, setup 0ms, import 2.84s, tests 1.11s, environment 2ms)
```
