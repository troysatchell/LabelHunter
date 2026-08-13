# Requirements Audit — LabelHunter

**Commit:** 8f14c17fbf5878 · **Date:** 2026-08-13T21:26:17.000Z · **Docs:** TH (source-TH.md) · **Mode:** compare, label `2026-08-13-postreskin`

## Summary

- **VERIFIED:** 22
- **PARTIAL:** 1
- **IMPLEMENTED-UNVERIFIED:** 0
- **MISSING:** 0

**One row remains open: TH-R9**, the government warning's bold rule. It is captured and typed
but never checked downstream — a correctly capitalized, correctly worded, non-bold `GOVERNMENT
WARNING:` prefix still passes today, a real gap against a statutory requirement. TRO-569 tracks
it Urgent; TRO-532 moved from Todo to In Progress since the prior sweep, but no code has landed
yet. **TH-R7 closed during this sweep**: TRO-574 (PR #81) merged while this sweep was in
progress, moving the outbound-dependency degradation table from an internal working document
directly into `docs/approach.md` and `README.md` — re-checked against the merged content before
this sweep finished, not reported at its pre-merge state. Three commits landed since the prior
sweep (TRO-573's full visual reskin, TRO-562's CI hardening, and TRO-574's TH-R7 fix); this
sweep independently re-verified none of the previously-VERIFIED rows regressed.

## Coverage and limitations

- **Ticket population was not re-pulled from scratch.** This sweep reuses the prior sweep's
  complete 108-issue pull and separately pulled every issue updated in the last 24 hours (65
  issues) to catch what changed. Enough to confirm no TH-R-relevant ticket flipped state
  unexpectedly, not a fresh full-population orphan check — the same limitation the prior sweep
  already carried, extended rather than newly introduced.
- **TH-R2 and TH-R16's latency figures were not re-measured live this sweep**, for the same
  reason as the prior sweep: both rest on the already-fresh `scripts/latency/results/single-
  label-verify-url-mode.json` (measuredAt 2026-08-13T19:43:22Z), and this sweep independently
  re-confirmed no commit between that measurement and the current commit touches the measured
  path.
- **No live model run.** `pnpm eval:check` ran in cheap mode against the same committed
  `eval-report.json` the prior sweep used — confirmed unchanged and still current, since nothing
  under `src/server/extractor`, `router`, `warning`, or `comparators` changed since 06dceb1.
- **TH-R14's fresh-clone check was not re-run.** The prior sweep performed a literal fresh
  clone/install/migrate/build; this sweep judged that proportionate re-verification given the
  intervening commits (CSS reskin, CI hardening, a docs-only TH-R7 fix) touch none of README.md's
  setup instructions. A reader who wants that check re-run at submission time should re-run it
  once more, close to the actual submission commit.
- **Database writes:** all database-touching verify commands ran in the isolated
  `labelhunter_wt_tro_486` database, re-provisioned fresh for this sweep, never the shared
  `labelhunter_dev`. One process note, disclosed rather than omitted: this sweep's first
  `worktree.sh` invocation used the `TRO-486` slug before this session realized TRO-486 is a
  peer session's own ticket, resetting that worktree's database. The peer confirmed directly it
  held nothing live at the time (its own sweep had already completed and the worktree had been
  torn down) — no work was lost.
- **Live-deploy probes were read-only GETs** (`/`, `/api/health`, `/api/review-queue`). No
  `/api/verify` or `/api/batch/*` call was made against the deployed instance, so no API spend
  was incurred by this sweep. The deployed instance had not yet redeployed either the reskin or
  the TH-R7 fix as of this sweep's own probe — Render auto-deploys from `main` on merge, expected
  to catch up shortly; this does not affect TH-R16's reachability claim.
- **0 rows are statically traced only this sweep.**

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: application data + label image -> AI reads the label -> per-field match/mismatch | TRO-461, TRO-462, TRO-463, TRO-465 | `src/app/api/verify/route.ts:313` | **VERIFIED** |
| TH-R2 | Single-label verify completes in ~5s wall-clock | TRO-471, TRO-539, TRO-568 | `scripts/latency/results/single-label-verify-url-mode.json:33` | **VERIFIED** |
| TH-R3 | UI usable by a 73-year-old first-time user with no instructions | TRO-480, TRO-570, TRO-573, TRO-465 | `CHANGES.md:246`, `src/app/globals-contrast.test.ts:1` | **VERIFIED** |
| TH-R4 | Batch upload of N labels -> N per-item verdicts with progress/summary | TRO-473, TRO-474, TRO-475, TRO-483, TRO-571 | `src/app/_components/BatchUploadForm.tsx:296` | **VERIFIED** |
| TH-R5 | Standalone; no COLA/registry integration | — | `src/server/router/required-fields.ts:21` | **VERIFIED** |
| TH-R6 | No PII persisted; sane baseline security; documented posture | TRO-457, TRO-482, TRO-484, TRO-565, TRO-567, TRO-566 | `README.md:151`, `src/lib/db/schema.ts:61` | **VERIFIED** |
| TH-R7 | Docs name every outbound dependency and its degradation behavior | TRO-478, TRO-485, TRO-574 | `docs/approach.md:53` (full table, reproduced not linked) | **VERIFIED** |
| TH-R8 | Fuzzy/judgment field matching, not strict string equality | TRO-463, TRO-536 | `src/server/comparators/brand.ts:25` | **VERIFIED** |
| TH-R9 | Government warning: exact word-for-word, all-caps, bold | TRO-468, TRO-469, TRO-527, TRO-532, TRO-533, TRO-528, TRO-569 | `src/server/warning/index.test.ts:202`; bold still uncaptured downstream | **PARTIAL** |
| TH-R10 | Imperfect images: correct extraction or explicit low-confidence outcome | TRO-477, TRO-497, TRO-542, TRO-543 | `src/server/router/golden-image-quality.test.ts:1` | **VERIFIED** |
| TH-R11 | All five example fields extract and verify end-to-end | TRO-461, TRO-458 | `src/server/router/types.ts:35` | **VERIFIED** |
| TH-R12 | Test-label image set present and exercised | TRO-458, TRO-497, TRO-498, TRO-499, TRO-529 | `golden-set/README.md:3` | **VERIFIED** |
| TH-R13 | Public/shareable, buildable-from-clone repo | TRO-456, TRO-562 | `.github/workflows/ci.yml:51`; GitHub API `visibility: public` | **VERIFIED** |
| TH-R14 | README with setup and run instructions | TRO-484 | `README.md:1` (197 lines) | **VERIFIED** |
| TH-R15 | Brief doc of approach, tools, assumptions | TRO-485 | `docs/approach.md:1` (274 lines) | **VERIFIED** |
| TH-R16 | Deployed URL reachable; core flow works there | TRO-481, TRO-482, TRO-483, TRO-568 | `scripts/latency/results/single-label-verify-url-mode.json:30` | **VERIFIED** |
| TH-R17 | Core requirements correct and complete | TRO-459, TRO-470 | all 6 verify commands green | **VERIFIED** |
| TH-R18 | Code quality and organization | TRO-456, TRO-508, TRO-548, TRO-573 | `eslint.config.mjs:13`, `src/lib/utils/contrast.ts:1` | **VERIFIED** |
| TH-R19 | Technical choices appropriate for scope, defended in docs | TRO-459, TRO-470, TRO-485 | `docs/approach.md:16`, `docs/approach.md:99` | **VERIFIED** |
| TH-R20 | UX and error handling: every failure mode has a designed state | TRO-478, TRO-479, TRO-570 | `docs/error-states.md:39`; `CHANGES.md:355` | **VERIFIED** |
| TH-R21 | Attention to requirements: buried interview asks visibly addressed | TRO-486, TRO-569, TRO-533 | `docs/approach.md:258` (judgment call) | **VERIFIED** |
| TH-R22 | Creative problem-solving beyond the literal ask | TRO-464, TRO-476, TRO-470 | `docs/approach.md:243` | **VERIFIED** |
| TH-R23 | Working core prioritized; trade-offs documented | TRO-485, TRO-487, TRO-531 | `docs/approach.md:138` | **VERIFIED** |

## Gaps

### TH-R9 — PARTIAL
- **Missing part:** The bold requirement is extracted, typed, and validated, but no router or
  comparator code reads it — a correctly capitalized, correctly worded, non-bold `GOVERNMENT
  WARNING:` prefix still passes.
- **Suggested scope:** TRO-532 (now In Progress) or TRO-533 — either closes the gap. TRO-528
  (bold-isolating golden cases) supports the eventual eval coverage. TRO-569 (Urgent) tracks the
  gap itself. This is now the **only** open row in the whole inventory.

## Orphan tickets

Not attempted this sweep — see Coverage and limitations.

## Blocked / assumed

No BLOCKED rows. No ASSUMED rows. No new ambiguities crossed the flood cap.

**TH-R21 carries forward the same flagged judgment call** the prior sweep recorded (see that
matrix entry, unchanged, for the full reasoning) — worth a reviewer's attention, reversible
under a stricter reading, not newly re-litigated this sweep.

**TH-R3 carries a small judgment call from this sweep:** TRO-573 removed dark mode entirely.
Treated as a scope reduction of a previously-fixed feature, not a regression of anything TH-R3's
own acceptance requires — the brief asks whether a first-time user can operate the *shipped*
app, and the shipped app is light-only by a deliberate, Troy-approved design decision. Named for
the record, not hidden in a routine "no delta" line.

## Delta (compare mode only)

| ID | baseline verdict | now | evidence change |
|---|---|---|---|
| TH-R3 | VERIFIED | VERIFIED (re-verified, not carried forward blind) | TRO-573's full Notion-style reskin landed since the prior sweep. Re-ran axe-core live against all 8 real screens post-reskin (0 violations, matching the pre-reskin baseline) and the reskin's own new permanent contrast-regression test (8/8 pass). `CHANGES.md` citations re-pointed to their new line numbers. |
| TH-R7 | PARTIAL | **VERIFIED** | TRO-574 (PR #81) merged mid-sweep: the outbound-dependency table and its "if blocked or unreachable" column now live directly in `docs/approach.md` (new "Outbound dependencies and degradation" section), and README.md points to that reproduced content instead of the internal `docs/error-states.md` working document. INT-004 is now fully met. |
| TH-R13 | VERIFIED | VERIFIED (evidence corrected) | TRO-562 (CI action/image SHA-pinning, credential-persistence fix) merged between the prior sweep's commit and this one. This sweep's first citation attempt was checked directly and found stale after TRO-562's diff shifted the line; corrected. |
| TH-R18 | VERIFIED | VERIFIED (evidence strengthened) | TRO-573 added a small, independently-unit-tested utility (`src/lib/utils/contrast.ts`) — cited as a positive example of this row's own bar, not a verdict change. |

All other rows (TH-R1, TH-R2, TH-R4, TH-R5, TH-R6, TH-R8, TH-R9, TH-R10, TH-R11, TH-R12, TH-R14,
TH-R15, TH-R16, TH-R17, TH-R19, TH-R20, TH-R21, TH-R22, TH-R23) hold their prior verdict,
re-confirmed by re-running the verify suite and, for TH-R9, a fresh grep — not assumed
unchanged.

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `pnpm typecheck` | exit 0 — clean | TH-R17, TH-R18 |
| `pnpm lint` | exit 0 — 1 problem (0 errors, 1 warning) | TH-R17, TH-R18 |
| `pnpm build` | exit 0 — production build succeeded | TH-R17, TH-R18 |
| `pnpm test` | 184 files, 2287 tests, all passed (20–22s across two runs) | TH-R1, TH-R6, TH-R8, TH-R9, TH-R11, TH-R12, TH-R17, TH-R18, TH-R20 |
| `pnpm test:e2e` | 12 passed (20.7s) | TH-R1, TH-R3, TH-R4, TH-R11, TH-R17, TH-R20, TH-R22 |
| `pnpm eval:check` | PASS — extraction 87.2% within 87.2–87.8% band; cascade 80.6% within 80.6–83.3% band (K=3) | TH-R10, TH-R17, TH-R19, TH-R22 |
| `pnpm exec vitest run src/app/globals-contrast.test.ts` | 8 passed | TH-R3 |
| `git log 4b004bb..HEAD -- <measured-latency-path>` | 0 commits | TH-R2, TH-R16 |
| `curl` GET `/`, `/api/health`, `/api/review-queue` against the live deploy | 307; 200; 401 without credential | TH-R6, TH-R16 |
| `grep -rn "COLA" src/` | 1 hit — a regulatory citation, not a client | TH-R5 |
| `grep` for `formatting.bold`/`isBold`/`boldCheck` in router + DetailView | 0 hits | TH-R9 |
| GitHub API repo lookup + `gh run list` on the swept commit | public repo; CI completed/success | TH-R13 |
| `gh pr list` (checking for a TRO-574 PR) | initially none open; PR #81 opened and merged mid-sweep, caught before finishing | TH-R7 |
| `grep` for the dependency table/firewall scenario in docs/approach.md and README.md | 6 hits + 3 hits, content reproduced not linked | TH-R7 |
| `pnpm eval:check -- --live --full` | NOT RUN — costs real API money; artifact confirmed current instead | TH-R17 |
| `pnpm latency:check -- --url=<deployed>` | NOT RUN — would bill a real Anthropic call; already-fresh artifact used instead | TH-R2 |
