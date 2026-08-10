# Requirements Audit — LabelHunter
**Commit:** 0cdc0c5 (dirty — see Coverage below) · **Date:** 2026-08-10T23:17:08Z · **Docs:** TH (source-TH.md, textutil cache) · **Mode:** baseline

## Summary

Verdicts: **VERIFIED** 2 · **PARTIAL** 6 · **MISSING** 14 · **IMPLEMENTED-UNVERIFIED** 1 · **N/A** 0 · **BLOCKED** 0 · **ASSUMED** 0. (23 active requirements.)

The single most consequential finding: **TH-R1, the core loop itself, is still MISSING** — `src/app/page.tsx` is a one-line placeholder, and the extractor/router/warning modules are empty scaffold directories. This is expected at this exact project moment (CP-1 cleared 2026-08-10, Wave 1 has not started) rather than a surprise gap, but it means every rubric line that rolls up through TH-R1 (TH-R17 "core requirements," most of TH-R20 "error handling") is also MISSING until Wave 1 lands. What *is* real and solid: the toolchain (typecheck/lint/build/test all green, 35/35 tests), the database schema (clean, no-PII by design, cited to TH-R6 in its own comments), and the golden-set ground truth (29 cases, TH-R12) — but that golden set ships zero actual images yet, so even TH-R12 can only read PARTIAL. One requirement, TH-R5 (no COLA integration), is genuinely unticketed in Linear — satisfied by omission in the architecture, but no ticket names it.

## Coverage and limitations

- `docs/PRD.md` is dirty (55 uncommitted lines inserted, mid-file). One citation (TH-R19, §13 Decision log) is valid against the working tree only — its line number would be ~52 lower against the last commit. Flagged per-row; do not treat that citation as reproducible from `0cdc0c5` alone.
- `pnpm test:e2e` was not run this sweep (boots a real dev server; the one existing spec covers only `/api/health`, which bears on no row here). Not run — recorded as such in `commands_run`, not silently skipped.
- `pnpm db:migrate` was not run — the schema was already migrated by the prior scaffold ticket; there is no new migration this sweep would exercise.
- No dedicated secret-scanner ran. TH-R6's PARTIAL verdict reflects a close read of six files, not a full-repo grep for credential patterns; recommend a real scan before the LH-070 submission gate.
- TH-R13's "buildable from clone" was verified via a fresh `pnpm install` in the existing working tree (`node_modules` was absent at sweep start), not a separate `git clone` to a new directory. Functionally close but not identical — recommend a literal fresh-clone pass before submission (rubric gate G2).
- 14 of 23 rows are read as MISSING. All 14 are ticketed and scheduled in `factory/tickets.md` (visible below) — none is a silent drop. This is a **baseline** sweep taken deliberately early (right after CP-1 cleared), not a submission-readiness sweep; re-run in `compare` mode after each wave lands to see the real delta.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: label in → per-field verdicts out | TRO-461, TRO-464, TRO-465 | src/app/page.tsx:5; src/server/extractor/.gitkeep; src/server/router/.gitkeep | MISSING |
| TH-R2 | Single-label ≤~5s p50 | TRO-462, TRO-471 | — | MISSING |
| TH-R3 | 73-year-old UX benchmark | TRO-465, TRO-466, TRO-475, TRO-480 | src/app/page.tsx | MISSING |
| TH-R4 | Batch mode (200–300 scale) | TRO-473, TRO-474, TRO-475 | src/lib/db/schema.ts:75 (batchJobs table) | PARTIAL |
| TH-R5 | Standalone, no COLA integration | *(unticketed)* | docs/PRD.md:46; src/lib/db/schema.ts:146 | IMPLEMENTED-UNVERIFIED |
| TH-R6 | No PII / sane secrets posture | TRO-457, TRO-482, TRO-484 | src/lib/db/schema.ts:56, :320; .gitignore:9 | PARTIAL |
| TH-R7 | Constrained-network dependency doc | TRO-498, TRO-478, TRO-485 | — | MISSING |
| TH-R8 | Lenient/judgment field matching | TRO-462, TRO-463 | src/server/router/.gitkeep | MISSING |
| TH-R9 | Warning exact word-for-word check | TRO-468, TRO-469 | src/server/warning/.gitkeep | MISSING |
| TH-R10 | Imperfect-image handling | TRO-497, TRO-460, TRO-477 | — | MISSING |
| TH-R11 | Five sample-label fields | TRO-461, TRO-463 | golden-set/manifest.json:5 (ground truth only) | MISSING |
| TH-R12 | Golden test-label image set | TRO-458, TRO-497, TRO-498, TRO-499, TRO-469, TRO-479 | golden-set/manifest.json:1; golden-set/README.md:12; loader.test.ts:1 | PARTIAL |
| TH-R13 | Public, buildable repo | TRO-456 | gh repo view; fresh install+build+test green | VERIFIED |
| TH-R14 | README setup/run instructions | TRO-484 | — | MISSING |
| TH-R15 | Approach/tools/assumptions doc | TRO-485 | — | MISSING |
| TH-R16 | Deployed, reachable URL | TRO-481, TRO-483 | — | MISSING |
| TH-R17 | Rubric: core works completely | TRO-499, TRO-470, TRO-486 | — | MISSING |
| TH-R18 | Rubric: code quality | TRO-456 | .github/workflows/ci.yml:1; typecheck/lint/test green | VERIFIED |
| TH-R19 | Rubric: appropriate tech, defended | TRO-456, TRO-462, TRO-470 | docs/PRD.md:53, :308 (dirty-path caveat) | PARTIAL |
| TH-R20 | Rubric: UX + error handling | TRO-465, TRO-466, TRO-473, TRO-475, TRO-478, TRO-479 | — | MISSING |
| TH-R21 | Rubric: traceability | TRO-486 | this sweep's own artifacts | PARTIAL |
| TH-R22 | Rubric: creative differentiator | TRO-464, TRO-476 | src/lib/db/schema.ts:326 (data model only) | MISSING |
| TH-R23 | Rubric: prioritize core + trade-offs doc | TRO-485 | factory/tickets.md:8 | PARTIAL |

## Gaps

See `gaps.md` for the full PM handoff. Summary: 14 MISSING rows (TH-R1, R2, R3, R7, R8, R9, R10, R11, R14, R15, R16, R17, R20, R22) and 6 PARTIAL rows (TH-R4, R6, R12, R19, R21, R23) — every one already has a ticket in `factory/tickets.md`'s Wave plan except TH-R5, which is unticketed.

## Orphan tickets

Four tickets map to no specific TH-R quote — all are PRD §10 process checkpoints, not brief-cited requirements, so this is expected, not a finding:

- TRO-459 — LH-CP1 · CHECKPOINT 1 walkthrough (Done, cleared 2026-08-10)
- TRO-467 — LH-CP2 · CHECKPOINT 2 walkthrough
- TRO-472 — LH-CP3 · CHECKPOINT 3 walkthrough
- TRO-487 — LH-070 · Final submission gate

## Blocked / assumed

None this sweep — the Linear ticket dimension resolved `OK` on the first query (no `BLOCKED` rows; TH-R5's `tickets: ["BLOCKED"]` cell is the schema's sentinel for "genuinely unticketed," recorded per report-format.md, not a provider failure). No `ASSUMED` rows — no ambiguity crossed the flood cap; nothing needed a ruling.

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `shasum -a 256 <TH source docx>` | Matches config — inventory current, no re-extraction needed | (doc currency) |
| `pnpm install` | exit 0 (node_modules was absent) | TH-R13 |
| `pnpm typecheck` | exit 0 | TH-R18 |
| `pnpm lint` | exit 0 | TH-R18 |
| `pnpm build` | exit 0 — "Compiled successfully," 3 routes | TH-R13, TH-R18 |
| `pnpm test` | exit 0 — Test Files 3 passed (3), Tests 35 passed (35) | TH-R18 |
| `gh repo view troysatchell/LabelHunter --json visibility,isPrivate` | isPrivate:false, PUBLIC | TH-R13 |
| `pnpm test:e2e` | NOT RUN — boots a dev server; existing spec covers only /api/health | TH-R18, TH-R20 |
| `pnpm db:migrate` | NOT RUN — no new migration this sweep | TH-R6 |

**Captured output — TH-R13/TH-R18 (`pnpm test`):**
```
 Test Files  3 passed (3)
      Tests  35 passed (35)
   Start at  18:14:09
   Duration  259ms (transform 55ms, setup 0ms, import 221ms, tests 11ms, environment 0ms)
```
