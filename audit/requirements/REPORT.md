# Requirements Audit — LabelHunter

**Commit:** ea9a6d01cb6ebe · **Date:** 2026-08-14T01:58:00Z · **Docs:** TH (source-TH.md) · **Mode:** compare, label `2026-08-13-final`

> **Note on citations (2026-08-14).** The build-process records left the published repo at
> submission. They stay on the author's machine. Citations below to `CHANGES.md`, `factory/`,
> `scripts/factory/`, and `docs/handoffs/` name those repo-local files, marked *(repo-local)*
> where they carry a verdict. Every other citation points at a file this repo tracks.

## Summary

- **VERIFIED:** 21
- **PARTIAL:** 2
- **IMPLEMENTED-UNVERIFIED:** 0
- **MISSING:** 0

**Two rows are open at the final sweep, and one of them is new.** TH-R2 (the ~5-second
latency bar) drops from VERIFIED to PARTIAL: the measurement that supported it (p50 3618ms,
20/20 PASS, measured 19:43Z) now predates four merged changes to the measured path — the
stroke-width bold measurement (TRO-533), the single-channel reconcile change (TRO-581), the
verify route's spend settling (TRO-580), and tonight's OCR retry (TRO-583, whose own header
names TH-R2). `docs/approach.md` still quotes the stale figure as current. One
`pnpm latency:check -- --url` run at the submission commit closes this; nothing else does.
TH-R9 (the government warning's bold rule) remains PARTIAL but materially narrowed: bold is
now measured from the image's pixels, persisted, displayed as an advisory, and documented
honestly in both graded deliverables — yet it still changes no verdict. The consequence
(route measured not-bold to NEEDS_REVIEW) is TRO-569+528, implementation complete on its
branch per the owning factory session, live re-baseline running, **no PR open yet** per an
independent peer check. Everything else re-verified green at this commit: 2650/2650 unit
tests, 12/12 e2e, typecheck/lint/build clean, eval bands in range, a fresh clone from GitHub
that installs, migrates, and builds, and the deployed instance proven reachable, gated, and
openable with the README-published access code.

## Coverage and limitations

- **The tree moved twice during this sweep.** The sweep began at 04c86bb; TRO-583 (PR #103)
  merged mid-sweep and a peer fast-forwarded the primary checkout. The full suite was re-run
  at ea9a6d0 and every citation re-anchored there — nothing in this report describes 04c86bb
  except where explicitly stated (the fresh-clone check). TRO-569's merge is expected after
  this report; its landing is deliberately NOT in scope — re-verify behaviorally then.
- **A first `pnpm test` run at 04c86bb failed 153 tests — that was this sweep's own error,
  not the repo's.** worktree.sh migrated the database before the worktree was advanced past
  three new migrations. Re-migrating produced 2638/2638 green at 04c86bb and 2650/2650 at
  ea9a6d0. Disclosed so the red run is not mistaken for a repo failure.
- **No live model spend this sweep.** eval:check ran in cheap mode; the latency harness and
  the live eval re-baseline were deliberately NOT RUN (the latter is already running,
  authorized, in the TRO-569 session — a second run would double-spend for the same
  evidence). E2E used the fake Anthropic server.
- **The committed eval artifact carries two recorded caveats:** manifest drift (it predates
  the case-33 corpus rebase by ~2 minutes — check.ts flags this loudly) and it predates
  TRO-581/583's verdict-semantics changes. TH-R10 rests on tests that run the real code at
  HEAD, not on that artifact; TRO-569's in-flight re-baseline refreshes it.
- **TH-R3's human/axe evidence predates five merged UI tickets** (575/576/577/578/582). The
  automated guards those passes installed (contrast test, token gate, one-button test, e2e)
  are all green at this commit; no fresh human or axe pass ran. Named as a judgment call
  below.
- **Database writes:** suite commands ran only in the isolated `labelhunter_wt_tro_486`
  database (ownership stolen from the completed prior audit session per TRO-557's protocol,
  reset on provision); the fresh-clone check used a scratch `labelhunter_fresh_audit`
  database created for it and dropped after. No shared database was touched.
- **Live-deploy probes were read-only GETs**, including one with the README-published access
  code (200 — the credential works). No /api/verify or /api/batch call; no spend. The
  deployed commit is not externally observable; tonight's merges were still rolling out.
- **0 rows are statically traced only.**

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: application + label image -> per-field match/mismatch | TRO-461, 462, 463, 465 | `src/app/api/verify/route.ts:355` | **VERIFIED** |
| TH-R2 | Single-label verify completes in ~5s wall-clock | TRO-471, 539, 568, 519, 583 | `scripts/latency/results/single-label-verify-url-mode.json:3` (stale vs. HEAD) | **PARTIAL** |
| TH-R3 | UI usable by a 73-year-old first-time user, no instructions | TRO-480, 570, 573, 465, 575, 576, 577, 578, 582 | `src/app/globals-contrast.test.ts:1`; `docs/handoffs/2026-08-13-ux-reskin-audit-session.md:42` *(repo-local)* | **VERIFIED** |
| TH-R4 | Batch upload -> N per-item verdicts with progress/summary | TRO-473, 474, 475, 483, 571, 544 | `src/app/_components/BatchUploadForm.tsx:296` | **VERIFIED** |
| TH-R5 | Standalone; no COLA/registry integration | — | `src/server/router/required-fields.ts:21` | **VERIFIED** |
| TH-R6 | No PII persisted; sane baseline security; documented | TRO-457, 482, 484, 565, 567, 566, 580 | `README.md:167`, `src/lib/db/schema.ts:61` | **VERIFIED** |
| TH-R7 | Docs name every outbound dependency + degradation | TRO-478, 485, 574 | `docs/approach.md:53` | **VERIFIED** |
| TH-R8 | Judgment field matching, not strict equality | TRO-463, 536 | `src/server/comparators/brand.ts:25` | **VERIFIED** |
| TH-R9 | Government warning: word-for-word, all-caps, bold | TRO-468, 469, 527, 528, 532, 533, 537, 569, 579, 581, 582, 583 | `src/server/warning/index.ts:323` (bold display-only) | **PARTIAL** |
| TH-R10 | Imperfect images: correct or explicit low-confidence, never confidently wrong | TRO-477, 497, 542, 543, 540, 563, 561 | `src/server/router/golden-image-quality.test.ts:1` | **VERIFIED** |
| TH-R11 | All five example fields verify end-to-end | TRO-461, 458 | `src/server/router/types.ts:35` | **VERIFIED** |
| TH-R12 | Test-label image set present and exercised | TRO-458, 497, 498, 499, 529, 510, 530 | `golden-set/README.md:3` | **VERIFIED** |
| TH-R13 | Public, buildable-from-clone repo | TRO-456, 562 | `.github/workflows/ci.yml:51`; GitHub API public; CI green on ea9a6d0 | **VERIFIED** |
| TH-R14 | README with setup and run instructions | TRO-484 | `README.md:1` + fresh clone/install/migrate/build THIS sweep | **VERIFIED** |
| TH-R15 | Brief doc of approach, tools, assumptions | TRO-485 | `docs/approach.md:6/:131/:143` | **VERIFIED** |
| TH-R16 | Deployed URL reachable; core flow works there | TRO-481, 482, 483, 568, 571 | `README.md:17-18`; live probes incl. published-code 200 | **VERIFIED** |
| TH-R17 | Core requirements correct and complete | TRO-459, 470, 561 | all six verify commands green | **VERIFIED** |
| TH-R18 | Code quality and organization | TRO-456, 508, 548, 573, 578 | `eslint.config.mjs:13`, `src/lib/utils/contrast.ts:1` | **VERIFIED** |
| TH-R19 | Technical choices appropriate for scope | TRO-459, 470, 485 | `docs/approach.md:16` | **VERIFIED** |
| TH-R20 | UX + error handling: every failure mode designed | TRO-478, 479, 570, 575, 582 | `docs/error-states.md:41`, `e2e/verify-fake-only.spec.ts:32` | **VERIFIED** |
| TH-R21 | Attention to requirements | TRO-486, 569, 533 | `docs/approach.md:258/:302` (judgment call) | **VERIFIED** |
| TH-R22 | Creative problem-solving beyond the ask | TRO-464, 476, 470, 576, 582 | `docs/approach.md:287` | **VERIFIED** |
| TH-R23 | Working core prioritized; trade-offs documented | TRO-485, 487, 531 | `docs/approach.md:170`, `README.md:141` | **VERIFIED** |

## Gaps

### TH-R9 — PARTIAL
- **Missing part:** The measured bold signal changes no verdict. A correctly worded,
  correctly capitalized, non-bold `GOVERNMENT WARNING:` prefix still passes silently —
  the signal is measured, persisted, and displayed, and nothing may fold it back into a
  verdict (`src/server/warning/index.ts:323`).
- **Suggested scope:** TRO-569+528 (branch `feat/tro-569-528-bold-review-routing`) — routes
  warning MATCH + measured not-bold to NEEDS_REVIEW with a named reason, respecting CP-2
  §7.2's never-hard-FAIL boundary. Owner session reports implementation complete, live
  re-baseline running, merge expected ahead of TRO-487; independent peer check confirms
  active recent commits but no PR yet. Re-verify against main on merge.

### TH-R2 — PARTIAL (new this sweep)
- **Missing part:** A latency measurement of the pipeline as it now ships. The committed
  measurement is green (p50 3618ms) but predates TRO-533/580/581/583's changes to the
  measured path (INT-002: a stale artifact never supports VERIFIED). `docs/approach.md:253`
  quotes the stale figure as current.
- **Suggested scope:** One `pnpm latency:check -- --url` run (~20 Haiku calls) at the
  submission commit, once Render shows it live; write a dated artifact per TRO-559. No open
  ticket tracks this — fold it into TRO-487's checklist.

## Orphan tickets

First full orphan pass since 2026-08-12 (fresh 113-issue population). Eight tickets map to
no TH requirement; all eight are **factory process tooling** — gate mechanics, worktree
provisioning, review-capture trust, changelog style (TRO-508, 523, 548, 553, 554, 557, 560,
572). This is deliberate meta-work that serves the build process, not scope drift; none
represents product work the brief never asked for. No genuinely unrelated ticket exists in
the population.

## Blocked / assumed

No BLOCKED rows. No ASSUMED rows. No new ambiguity crossed the flood cap.

**Three named judgment calls, all reversible:**
1. **TH-R3:** five UI tickets postdate the last human walkthrough and axe scan; kept
   VERIFIED on the postreskin sweep's precedent (automated re-verification suffices for
   post-walkthrough changes) because every automated guard is green at HEAD. A stricter
   INT-006 reading makes this PARTIAL. Recommend one axe pass + a human skim of the
   autofill flow inside TRO-487.
2. **TH-R21:** the same whole-inventory judgment call as the prior two sweeps, carried with
   its condition re-checked — noting honestly that TH-R2 is now a second PARTIAL row and,
   unlike TH-R9, has no tracking ticket.
3. **TH-R10:** kept VERIFIED on fresh test evidence at HEAD while the committed eval
   artifact carries a manifest-drift warning and predates two verdict-semantics changes;
   TRO-569's authorized re-baseline refreshes it.

## Delta (compare mode only)

| ID | baseline verdict | now | evidence change |
|---|---|---|---|
| TH-R2 | VERIFIED | **PARTIAL** | The latency artifact went stale under INT-002: TRO-533 (bold measurement in the warning channel), TRO-581 (reconcile change), TRO-580 (route spend settling), and TRO-583 (OCR retry — its own header names TH-R2) all merged after the 19:43Z measurement. Regression risk judged low (the Haiku stage dominates at p50 3317.8ms of 3618ms; OCR work is deadline-bounded) — but judged is not measured. |
| TH-R9 | PARTIAL | PARTIAL (gap materially narrowed) | Bold went from captured-and-discarded to measured-from-pixels (TRO-532), persisted + displayed (TRO-533), honestly documented in both graded deliverables, with a real not-bold ground-truth case (TRO-579) and 83.3% measured signal accuracy. TRO-581 makes deterministic single-channel violations FAIL outright (Troy's CP-2 ruling); TRO-582 adds the statute-text word diff; TRO-583 adds OCR retry-once. Remaining: no verdict consequence — TRO-569 in flight. |
| TH-R14 | VERIFIED (carried forward) | VERIFIED (freshly re-run) | The deferred fresh-clone check ran this sweep: clone from GitHub, install, migrate against a throwaway DB, build — all exit 0. |
| TH-R16 | VERIFIED | VERIFIED (evidence strengthened) | Prior sweeps proved the gate rejects; this sweep also proved the README-published access code admits (200 on a gated route) — the evaluator's actual path, end-to-end. |
| TH-R3 | VERIFIED | VERIFIED (evidence re-based) | At the swept commit, CHANGES.md held only 4 entries — later diagnosed as a silent truncation by PR #103's merge, NOT a deliberate change (this report's first draft mis-read it as intentional; corrected). Main repaired at bfa0574 (full 136-entry history restored). The walkthrough/axe citations were re-based to `docs/handoffs/2026-08-13-ux-reskin-audit-session.md:42-44`, which remains the more durable anchor either way. Judgment call re post-walkthrough UI tickets named above. |
| TH-R6 | VERIFIED | VERIFIED (strengthened) | TRO-566 (the row's one open follow-up last sweep) closed Done; TRO-580 closed a real budget under-count. |

All other rows hold their prior verdict, re-verified by re-running the full suite at
ea9a6d0 — including re-anchoring every citation whose line drifted (route.ts 313->355,
warning index.test 202->401, README 151->167, approach.md 138->170 / 243->287 / new :258).

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `pnpm typecheck` | exit 0 — clean | TH-R17, TH-R18 |
| `pnpm lint` | 0 errors, 1 warning (no-img-element, deliberate) | TH-R17, TH-R18 |
| `pnpm build` | exit 0 | TH-R17, TH-R18 |
| `pnpm test` | 200 files / 2650 tests, all passed (44.6s); one earlier red run was this sweep's own migration-ordering error, disclosed above | TH-R1, R3, R6, R8, R9, R11, R12, R17, R18, R20 |
| `pnpm test:e2e` | 12 passed (15.7s), fake model server | TH-R1, R3, R4, R11, R17, R20, R22 |
| `pnpm eval:check` | PASS (87.6% / 81.1% in band) + loud manifest-drift warning | TH-R10, R17, R19, R22 |
| Fresh clone + install + migrate (scratch DB) + build | all exit 0 | TH-R13, TH-R14 |
| Live probes: `/`, `/api/health`, `/api/review-queue` ± access code | 307; 200; 401 without / **200 with** published code | TH-R6, TH-R16 |
| `grep COLA src/` | 1 regulatory-citation comment, no client | TH-R5 |
| GitHub API + `gh run list` | public; CI success on ea9a6d0 | TH-R13 |
| Linear full pull (project LabelHunter) | 113 issues, complete | TH-R21, orphans |
| Peer-session query re TRO-569 | two attributed accounts; not accepted as merged-behavior evidence | TH-R9 |
| `pnpm latency:check -- --url` | **NOT RUN** — bills ~20 Haiku calls; deployed commit unconfirmable mid-rollout. The one command between TH-R2 and VERIFIED | TH-R2 |
| `pnpm eval:variance --establish-baseline` (live) | **NOT RUN** — already running, authorized, in the TRO-569 session; a second run double-spends | TH-R10, TH-R17 |
| axe-core scan of post-575/576/577/578/582 screens | **NOT RUN** — no in-repo tooling; recommended into TRO-487 | TH-R3 |
