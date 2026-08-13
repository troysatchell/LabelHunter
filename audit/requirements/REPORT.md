# Requirements Audit — LabelHunter

**Commit:** 06dceb193f6e5 · **Date:** 2026-08-13T20:36:52.000Z · **Docs:** TH (source-TH.md) · **Mode:** compare, label `2026-08-13-postmerge`

## Summary

- **VERIFIED:** 21
- **PARTIAL:** 2
- **IMPLEMENTED-UNVERIFIED:** 0
- **MISSING:** 0

The single most consequential finding left open is TH-R9: the government warning's bold rule is
still captured and never checked. The extractor reads a `bold` signal for every label and the
router still never acts on it, so a warning printed in correct all-caps but not bold still passes
today — a real gap against a statutory requirement, filed Urgent as TRO-569, not yet started
(TRO-532/533 remain Todo). Everything else in this sweep moved. Ten rows flipped to VERIFIED
since the last full sweep (commit e63b00b, `REPORT-2026-08-13-th-full.md`): the README and
approach doc both merged, closing two MISSING rows outright and unblocking five more that were
PARTIAL only for lack of a graded deliverable to live in; the latency figure was re-measured
fresh and unstale (p50 3618ms, 20/20 PASS on the deployed instance); and TRO-570's first human
UX-and-accessibility walkthrough closed the last PARTIAL row that depended on human judgment. One
row (TH-R7) stays PARTIAL for a narrower reason than before — the dependency is now named in
README.md, but the degradation behavior itself is still only linked, not reproduced, in a graded
deliverable.

## Coverage and limitations

- **The TH-R2 and TH-R16 latency figures were NOT re-measured live this sweep.** Both rest on the
  already-committed `scripts/latency/results/single-label-verify-url-mode.json` (measuredAt
  2026-08-13T19:43:22Z). This sweep independently confirmed no commit between that measurement and
  the swept commit (06dceb1) touched the measured code path (`git log 4b004bb..HEAD` over the
  route, router, warning, extractor, and `render.yaml` returns 0 commits) before accepting it as
  current under INT-002. No live `pnpm latency:check` run was made against the deployed instance.
- **No live model run.** `pnpm eval:check` ran in cheap mode, comparing the committed
  `eval-report.json` (mode live, measuredAt 2026-08-13T15:57:01.899Z) against the K=3 band.
  `--live --full` was deliberately not run — it costs real API money, and this sweep confirmed
  directly (not assumed) that nothing under `src/server/extractor`, `router`, `warning`, or
  `comparators` changed since that measurement.
- **Ticket mapping is keyword-derived**, not per-ticket human review, same as the prior sweep. The
  per-row ticket lists are indicative; no orphan list is reported for the same reason the prior
  sweep gave — 108 issues in the LabelHunter project is too coarse a population to assert
  orphanhood confidently by keyword match alone.
- **Database writes:** the six verify commands ran in the isolated `labelhunter_wt_tro_486`
  database provisioned by `scripts/factory/worktree.sh`, never the shared `labelhunter_dev`. The
  TH-R14 fresh-clone check additionally created and dropped its own scratch database
  (`labelhunter_th_r14_freshclone_check`) in the same Postgres container, on a separate scratch
  clone directory that was removed afterward — no state left behind by either operation.
- **Live-deploy probes were read-only GETs** (`/`, `/api/health`, `/api/review-queue`, and a
  GitHub API repo lookup). No `/api/verify` or `/api/batch/*` call was made against the deployed
  instance from this sweep, so no API spend was incurred by this sweep itself.
- **One documentation staleness observation, not a verdict issue:** `docs/approach.md:194-198`
  still states "the largest batch actually measured so far is 32 items, run locally." That
  predates the 36-item batch run against the live deployed instance
  (`scripts/golden/results/seeded-demo-batch-2026-08-13.json`, completed 2026-08-13T19:24:13Z),
  even though the sentence survives in an `approach.md` commit (4b004bb) timestamped after that
  batch completed. This sweep may not edit application docs; it is named here so a future ticket
  fixes the one stale sentence.
- **0 rows are statically traced only this sweep.** TH-R5 (scope/negative claim) moved from
  IMPLEMENTED-UNVERIFIED to VERIFIED after this sweep ran and captured its own `grep` check
  directly, rather than resting on inspection alone.
- **TH-R21's VERIFIED verdict is a judgment call, flagged as such in the matrix's own notes field**
  rather than a mechanical re-trace — see the Blocked/assumed section below for the reasoning and
  the fallback if a reviewer reads the row's acceptance line more strictly.

## Matrix

| ID | Requirement (short) | Ticket(s) | Evidence | Verdict |
|---|---|---|---|---|
| TH-R1 | Core loop: application data + label image -> AI reads the label -> per-field match/mismatch | TRO-461, TRO-462, TRO-463, TRO-465 | `src/app/api/verify/route.ts:313` | **VERIFIED** |
| TH-R2 | Single-label verify completes in ~5s wall-clock | TRO-471, TRO-539, TRO-568 | `scripts/latency/results/single-label-verify-url-mode.json:33` | **VERIFIED** |
| TH-R3 | UI usable by a 73-year-old first-time user with no instructions | TRO-480, TRO-570, TRO-465 | `CHANGES.md:138` (TRO-570 walkthrough) | **VERIFIED** |
| TH-R4 | Batch upload of N labels -> N per-item verdicts with progress/summary | TRO-473, TRO-474, TRO-475, TRO-483, TRO-571 | `src/app/_components/BatchUploadForm.tsx:296`, `scripts/golden/results/seeded-demo-batch-2026-08-13.json:1` | **VERIFIED** |
| TH-R5 | Standalone; no COLA/registry integration | — | `src/server/router/required-fields.ts:21` (grep, 1 hit, a citation not a client) | **VERIFIED** |
| TH-R6 | No PII persisted; sane baseline security; documented posture | TRO-457, TRO-482, TRO-484, TRO-565, TRO-567, TRO-566 | `README.md:151`, `src/lib/db/schema.ts:61` | **VERIFIED** |
| TH-R7 | Docs name every outbound dependency and its degradation behavior | TRO-478, TRO-485 | `README.md:172` (list only, no degradation content) | **PARTIAL** |
| TH-R8 | Fuzzy/judgment field matching, not strict string equality | TRO-463, TRO-536 | `src/server/comparators/brand.ts:25` | **VERIFIED** |
| TH-R9 | Government warning: exact word-for-word, all-caps, bold | TRO-468, TRO-469, TRO-527, TRO-532, TRO-533, TRO-537, TRO-546, TRO-569 | `src/server/warning/index.test.ts:202`; bold still uncaptured downstream | **PARTIAL** |
| TH-R10 | Imperfect images: correct extraction or explicit low-confidence outcome | TRO-477, TRO-497, TRO-542, TRO-543 | `src/server/router/golden-image-quality.test.ts:1` | **VERIFIED** |
| TH-R11 | All five example fields extract and verify end-to-end | TRO-461, TRO-458 | `src/server/router/types.ts:35` | **VERIFIED** |
| TH-R12 | Test-label image set present and exercised | TRO-458, TRO-497, TRO-498, TRO-499, TRO-529 | `golden-set/README.md:3` | **VERIFIED** |
| TH-R13 | Public/shareable, buildable-from-clone repo | TRO-456, TRO-562 | `.github/workflows/ci.yml:47`; GitHub API `visibility: public` | **VERIFIED** |
| TH-R14 | README with setup and run instructions | TRO-484 | `README.md:1` (197 lines; fresh-clone check performed) | **VERIFIED** |
| TH-R15 | Brief doc of approach, tools, assumptions | TRO-485 | `docs/approach.md:1` (274 lines, all four sections present) | **VERIFIED** |
| TH-R16 | Deployed URL reachable; core flow works there | TRO-481, TRO-482, TRO-483, TRO-568 | `scripts/latency/results/single-label-verify-url-mode.json:30` (20/20 PASS on live) | **VERIFIED** |
| TH-R17 | Core requirements correct and complete | TRO-459, TRO-470 | all 6 verify commands green | **VERIFIED** |
| TH-R18 | Code quality and organization | TRO-456, TRO-508, TRO-548 | `eslint.config.mjs:13`, typecheck/lint/build/test green | **VERIFIED** |
| TH-R19 | Technical choices appropriate for scope, defended in docs | TRO-459, TRO-470, TRO-485 | `docs/approach.md:16`, `docs/approach.md:99` | **VERIFIED** |
| TH-R20 | UX and error handling: every failure mode has a designed state | TRO-478, TRO-479, TRO-570 | `docs/error-states.md:39`; live-triggered by TRO-570 | **VERIFIED** |
| TH-R21 | Attention to requirements: buried interview asks visibly addressed | TRO-486, TRO-569, TRO-533 | `docs/approach.md:258` (judgment call — see notes) | **VERIFIED** |
| TH-R22 | Creative problem-solving beyond the literal ask | TRO-464, TRO-476, TRO-470 | `docs/approach.md:243` | **VERIFIED** |
| TH-R23 | Working core prioritized; trade-offs documented | TRO-485, TRO-487, TRO-531 | `docs/approach.md:138` | **VERIFIED** |

## Gaps

### TH-R7 — PARTIAL
- **Missing part:** README.md now names the one outbound dependency (Anthropic API), but the
  "what happens when it is blocked" content is still only linked to `docs/error-states.md`, an
  internal working document — never reproduced in a graded deliverable. INT-004 requires the
  content itself to be in README.md or docs/approach.md, not a pointer to it.
- **Suggested scope:** Copy (not link) the outbound-dependency table and its "if blocked or
  unreachable" column from `docs/error-states.md:17-37` into `docs/approach.md`. The content
  already exists verbatim and is already correct; this is a short, mechanical addition, not new
  research.

### TH-R9 — PARTIAL
- **Missing part:** The government warning's bold requirement is extracted, typed, and validated,
  but no router or comparator code reads it — a correctly capitalized, correctly worded, non-bold
  `GOVERNMENT WARNING:` prefix still passes. `docs/approach.md` now names this plainly ("a real
  gap, not a soft one") rather than understating it, and TRO-569 tracks it as Urgent.
- **Suggested scope:** TRO-532 (LH-025, stroke-width bold advisory) or TRO-533 (LH-026, surface the
  bold signal) — either closes the gap. Both are Todo, unstarted as of this sweep.

## Orphan tickets

None reported. Ticket mapping is keyword-derived (see Coverage and limitations), which is too
coarse to distinguish a genuine orphan from a mapping miss at 108 tickets in the project.

## Blocked / assumed

No BLOCKED rows. No new ambiguities crossed the flood cap this sweep — INT-001 through INT-006
already govern every ambiguity this sweep encountered.

**TH-R21 is a flagged judgment call**, not an ASSUMED verdict (its ambiguity was already ruled
implicitly by the row's own wording, not newly encountered) but worth a reviewer's attention: the
baseline sweep's suggested two specific closing actions (a bold-signal UI advisory; a requirements
table in the README) were not literally taken. This sweep instead judged the row's actual
acceptance wording — "every TH-R entry addressed in code or explicitly documented as descoped" —
satisfied at the whole-inventory level, since every row today is VERIFIED or PARTIAL-with-an-
explicit-ticketed-gap, and `docs/approach.md` itself points a reader to this audit trail rather
than hiding the two open rows. If a reviewer reads the acceptance line more strictly (requiring
the two originally suggested UI/README actions specifically), the row reverts to PARTIAL until
those ship. No code or docs were changed to force this reading either way.

## Delta (compare mode only)

| ID | baseline verdict | now | evidence change |
|---|---|---|---|
| TH-R2 | PARTIAL | **VERIFIED** | Fresh, unstale latency artifact (measuredAt 2026-08-13T19:43:22Z, p50 3618ms, 20/20 PASS) replaces the stale figure; confirmed no further path changes since. |
| TH-R3 | PARTIAL | **VERIFIED** | TRO-570's first human UX-and-accessibility walkthrough (CHANGES.md:138-354) satisfies INT-006's requirement for a real walkthrough of the current screens, including access-code and paging, with a rigorous accessibility pass (axe-core, contrast, keyboard, structure) finding zero violations. |
| TH-R5 | IMPLEMENTED-UNVERIFIED | **VERIFIED** | This sweep ran and captured the `grep -rn "COLA" src/` check directly, accepting it as the behavioral artifact the baseline sweep's own notes said would suffice. |
| TH-R6 | PARTIAL | **VERIFIED** | README.md's new "What LabelHunter stores, and does not store" section (line 151) supplies the missing documentation half; the data-model half was already met. |
| TH-R7 | PARTIAL | PARTIAL (no change) | README.md now names the dependency, but the degradation-behavior content still isn't reproduced in a graded deliverable — re-confirmed by reading `docs/approach.md` in full, not carried forward blind. |
| TH-R9 | PARTIAL | PARTIAL (no change) | Re-confirmed via a fresh grep this sweep: bold is still uncaptured downstream. `docs/approach.md` now names the gap correctly (corrected in 4b004bb); TRO-569 filed Urgent since the baseline sweep. |
| TH-R14 | MISSING | **VERIFIED** | PR #66 merged README.md (197 lines). A literal fresh-clone check (install, migrate, build against a scratch database) was performed and succeeded this sweep. |
| TH-R15 | MISSING | **VERIFIED** | PR #68 merged docs/approach.md (274 lines), read in full and confirmed to cover approach, tools, assumptions, and trade-offs. |
| TH-R16 | PARTIAL | **VERIFIED** | The fresh latency artifact proves single-label verify succeeds on the deployed instance (20/20 PASS); the seeded-demo batch independently corroborates at scale; README.md now publishes the URL and access code. |
| TH-R19 | PARTIAL | **VERIFIED** | docs/approach.md's "The cascade" and "Tools used" sections now carry the scope-justification content the baseline sweep already found strong but had nowhere graded to live. |
| TH-R21 | PARTIAL | **VERIFIED** | Judgment call — see Blocked/assumed above. All four buried interview requirements now trace VERIFIED, and docs/approach.md points readers to this audit trail. |
| TH-R23 | PARTIAL | **VERIFIED** | docs/approach.md's new "Trade-offs and limitations" section (line 138) supplies the missing written half in a graded deliverable; the prioritization half was already met. |

All other rows (TH-R1, TH-R4, TH-R8, TH-R10, TH-R11, TH-R12, TH-R13, TH-R17, TH-R18, TH-R20,
TH-R22) hold their prior verdict — VERIFIED in every case, re-confirmed by re-running the verify
suite rather than assumed unchanged.

## Verification performed

| Command | Result | Bears on |
|---|---|---|
| `pnpm typecheck` | exit 0 — clean | TH-R17, TH-R18 |
| `pnpm lint` | exit 0 — 1 problem (0 errors, 1 warning) | TH-R17, TH-R18 |
| `pnpm build` | exit 0 — production build succeeded | TH-R17, TH-R18 |
| `pnpm test` | 182 files, 2267 tests, all passed (18.17s) | TH-R1, TH-R6, TH-R8, TH-R9, TH-R11, TH-R12, TH-R17, TH-R18, TH-R20 |
| `pnpm test:e2e` | 12 passed (13.4s) | TH-R1, TH-R3, TH-R4, TH-R11, TH-R17, TH-R20, TH-R22 |
| `pnpm eval:check` | PASS — extraction 87.2% within 87.2–87.8% band; cascade-verdict 80.6% within 80.6–83.3% band (K=3), cheap mode | TH-R10, TH-R17, TH-R19, TH-R22 |
| `git log 4b004bb..HEAD -- <measured-latency-path>` | 0 commits — artifact confirmed unstale | TH-R2, TH-R16 |
| `curl` GET `/`, `/api/health`, `/api/review-queue` against the live deploy | 307 → /access-code; 200; 401 without credential | TH-R6, TH-R16 |
| `grep -rn "COLA" src/` | 1 hit — a regulatory citation, not a client | TH-R5 |
| `grep` for `formatting.bold`/`isBold`/`boldCheck` in router + DetailView | 0 hits | TH-R9 |
| Fresh `git clone` + install + scratch-DB migrate + build | install exit 0; migrate succeeded; build exit 0 | TH-R14 |
| GitHub API repo lookup + `gh run list` on the swept commit | public repo; CI completed/success on 06dceb1 | TH-R13 |
| `pnpm eval:check -- --live --full` | NOT RUN — costs real API money; artifact confirmed current instead | TH-R17 |
| `pnpm latency:check -- --url=<deployed>` | NOT RUN — would bill a real Anthropic call; already-fresh artifact used instead | TH-R2 |
