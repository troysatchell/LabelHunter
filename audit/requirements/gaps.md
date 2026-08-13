# Requirements gaps — LabelHunter (2026-08-13, commit 876a295)

10 rows are not VERIFIED: 2 MISSING, 8 PARTIAL. Six of the ten resolve on two
documents. One row (TH-R2) is new to this list — a staleness downgrade, not a
build gap. Ordered by leverage, not by ID.

## Unticketed requirements

None. Every gap below already has a Linear ticket in project LabelHunter.

## The two documents that unblock six rows

### TH-R15 — MISSING
- **Quote:** "Brief documentation of approach, tools used, assumptions made"
- **Source:** source-TH.md, L64 (Deliverables)
- **Meaning in code:** Docs section covering approach, tool choices, and assumptions.
- **Ticket:** TRO-485 (LH-064 · approach.md) — Backlog
- **What is missing:** `docs/approach.md` does not exist. `ls docs/` and `git ls-files docs` both confirm it.
- **Suggested scope:** Assemble, do not discover. Every section already exists somewhere: (1) **Approach** — `docs/PRD.md` §3.1 "The cascade (the load-bearing decision)" (lines 53-68). (2) **Tools used** — PRD §3.6 "Stack & data model" (lines 132-138): Next.js/TypeScript on Render, Postgres + Drizzle, Haiku 4.5 extraction / Sonnet 5 resolver. (3) **Assumptions log** — `audit/requirements/interpretations.md`'s three rulings (INT-001, INT-002, INT-003), transcribed near-verbatim, plus TH-R5's negative-scope note (no COLA integration, by design). (4) **Trade-offs & limitations** (this is also TH-R23's written half) — lift `docs/error-states.md`'s "Outbound dependencies" section (lines 17-37) and its trade-off paragraph (line 154 on), `docs/deploy.md`'s "Known limitations" section (lines 84-142, especially the unverified-live-deploy and migration-ordering-gap caveats), and PRD §2's "Explicitly bounded" list (lines 38-49: bold-detection as a low-confidence signal, no COLA, no PII, single access code instead of per-user auth). (5) **Measured figures** — cite `scripts/eval/baseline.json`'s committed K=3 band (extraction 87.22%-87.78%, cascade-verdict 80.56%-83.33%, N=36) and the deployed latency artifact's p50/p95. **Cite the band, never a single point value** — TRO-561 exists specifically because an earlier version of this practice pinned to one end of a measured spread. (6) **Differentiators** (TH-R22) — name the cascade, the dual-channel warning reconciliation, the confidence-triaged review queue, and the variance-band eval harness itself explicitly; none of the four is currently named "differentiator" in any document an evaluator will read. **HAZARD CAVEAT:** if this document names the deployed URL (`https://labelhunter-web.onrender.com`), it must carry the PR #43 warning below — the instance has no auth in front of it yet.

### TH-R14 — MISSING
- **Quote:** "README with setup and run instructions"
- **Source:** source-TH.md, L63 (Deliverables)
- **Meaning in code:** README covers setup + run from scratch.
- **Ticket:** TRO-484 (LH-063 · README) — Backlog
- **What is missing:** No README at the repo root, tracked or untracked. `git ls-files | grep -i readme` returns exactly one path, `golden-set/README.md`, which documents the test corpus.
- **Suggested scope:** One file, roughly an hour: (1) what LabelHunter is (PRD §1, one paragraph). (2) Prerequisites — Node ≥22, pnpm 10.27.0 (`package.json:6-9`), a Postgres container, `ANTHROPIC_API_KEY` — lift `.env.local.example`'s exact `docker run` command and `DATABASE_URL` shape verbatim. (3) Run commands — `pnpm install`, `cp .env.local.example .env.local`, `pnpm db:migrate`, `pnpm dev` (`package.json`'s scripts block). (4) **Deployed URL + access-code note — HAZARD, apply precisely:** PR #43 (TRO-482, key protection: access-code gate + rate limits + daily budget) is **OPEN, mergedAt null** (`gh pr view 43`, confirmed this sweep). The live instance has **no auth in front of it right now**, makes real billed Anthropic API calls, and batch mode accepts 200-300 label uploads per request. Publishing the bare URL before PR #43 merges is a real, live financial/abuse risk — gate that section on the merge landing, or if the README must ship sooner, publish it with an explicit, visible "currently unauthenticated" warning rather than silently omitting the gap. (5) Architecture diagram + model/cost notes — PRD §3.1's cascade diagram plus `scripts/eval/baseline.json`'s `costUsd` block. (6) Data-handling posture — see TH-R6 below, same PR #43 caveat.

## Rows that ship when those two documents ship

### TH-R7 — PARTIAL
- **Quote:** "our network blocks outbound traffic to a lot of domains, so keep that in mind if you're thinking about cloud APIs."
- **Source:** source-TH.md, L22 (Marcus Williams interview)
- **What is missing:** Nothing factual. The dependency table, the blocked-endpoint behaviour and the tests all exist in `docs/error-states.md`, which admits itself (line 14) that this content belongs in the not-yet-written approach doc.
- **Suggested scope:** Ships when TH-R15 ships. Copy the dependency table (lines 25-29) and the "Design consequence" / "Unreachable-endpoint degradation" sections (lines 31-37, 130-168) across; change nothing else.

### TH-R19 — PARTIAL
- **Quote:** "Appropriate technical choices for the scope"
- **Source:** source-TH.md, L71 (Evaluation Criteria)
- **What is missing:** The acceptance line asks for an approach doc that justifies each major choice against scope. The defence is real, measured, and checkpoint-witnessed (CP-1, TRO-459, Done — the cascade router + prompts walkthrough) but no graded deliverable carries it.
- **Suggested scope:** Ships when TH-R15 ships. The cascade's cost/latency justification (`scripts/eval/results/benchmark-report.json:178`) is one of the strongest arguments in the repo and currently invisible to a grader.

### TH-R21 — PARTIAL
- **Quote:** "Attention to requirements"
- **Source:** source-TH.md, L73 (Evaluation Criteria)
- **What is missing:** All 22 TH-R IDs that are meant to be ticketed are referenced in `factory/tickets.md` (corrected count this sweep — the prior sweep's "23" double-counted a bogus prose match; TH-R5 is unticketed by design and correctly has zero references). Full inventory coverage is real. What's missing is a reader-facing statement of what was descoped and why — that story lives only in internal factory files today.
- **Suggested scope:** Ships when TH-R14 and TH-R15 ship. One short "what we did not build, and why" paragraph in `docs/approach.md`, naming TH-R5 (no COLA integration) as the one deliberate descope. Five minutes once the file exists.

### TH-R23 — PARTIAL
- **Quote:** "A working core application with clean code is preferred over ambitious but incomplete features. Document any trade-offs or limitations."
- **Source:** source-TH.md, L75 (Evaluation Criteria)
- **What is missing:** Only the written half. `docs/deploy.md:84` and `docs/error-states.md:154` hold real, good trade-offs content — INT-003 rules that content in an internal document does not satisfy a requirement naming a graded deliverable. The prioritisation half is met: the core loop (TH-R1, TH-R9) shipped well ahead of stretch items like TH-R4's unmeasured-at-scale batch row.
- **Suggested scope:** Ships when TH-R14 and TH-R15 ship. No engineering work closes this row — lift `docs/deploy.md`'s "Known limitations" section and `docs/error-states.md`'s trade-off paragraph verbatim.

### TH-R6 — PARTIAL
- **Quote:** "But for a prototype? Just don't do anything crazy. We're not storing anything sensitive for this exercise."
- **Source:** source-TH.md, L21 (Marcus Williams interview)
- **What is missing:** The acceptance line requires the README to state the data-handling posture. The data-model half is fully met — the schema stores label and application fields only (`schema.ts:167,431`), review-queue dispositions carry no reviewer identity by explicit design (`record-disposition.ts:11`), and `.env.local` is gitignored.
- **Suggested scope:** Ships when TH-R14 ships, same file, one new "Data handling & secrets" section. **PR #43 caveat, apply precisely:** PR #43 (TRO-482) is OPEN and unmerged (confirmed this sweep — migration 0008 that branch needs does not exist on `main`, only 0000-0007 do). Do not describe the deployed instance as access-code protected until #43 actually merges. If the README ships first, state plainly: "a shared access code is planned (PR #43) but not yet live on the deployed URL."

## Rows that need engineering, not writing

### TH-R2 — PARTIAL (new to this sweep)
- **Quote:** "If we can't get results back in about 5 seconds, nobody's going to use it."
- **Source:** source-TH.md, L11 (Sarah Chen interview)
- **What is missing:** Not a build gap — a staleness gap. The deployed-instance latency artifact (p50 3834ms, p95 4458ms, measured 2026-08-13T12:40:42Z) predates four commits that rewrote files its own `pipelineScope` names as the measured path: TRO-502 (router rule-1 evidence check), TRO-546 (warning region-detection threshold), TRO-542 (router quality-trigger naming). None adds or removes a pipeline stage, and the router itself costs sub-5ms of the ~3.4-4.5s total per the artifact's own stage breakdown — a real timing swing is plausible to be small — but INT-002 does not carve out a materiality exception, and this sweep did not re-measure to confirm it.
- **Suggested scope:** Re-run `pnpm latency:check -- --url=https://labelhunter-web.onrender.com --runs=20` (or the documented equivalent) and commit the fresh artifact. **Do not hammer the live public URL repeatedly** — it has no auth yet (PR #43 open) and each run bills real Anthropic API calls; one clean run is enough. Prefer a local dev server or scratch deployment if the live URL's exposure is a concern before PR #43 merges.

### TH-R17 — PARTIAL
- **Quote:** "Correctness and completeness of core requirements"
- **Source:** source-TH.md, L69 (Evaluation Criteria)
- **What is missing:** Cascade-verdict accuracy is 80.56% (29/36), against 87.22% extraction accuracy. Seven cases land on the wrong end-state verdict. TRO-561's K=3 band now bounds this honestly at 80.56%-83.33% rather than a single lucky run — real, measured progress. Six of the seven wrong cases (case-16, 17, 18, 21, 22, 23) share one pattern: a deliberately degraded or ambiguous image reads confidently and cleanly on a single channel, masking an expected REVIEW. Only case-22 has a filed, Troy-gated corpus-decision ticket (TRO-563). The seventh, case-19, traces to a known code gap (TRO-540, deskew, Todo), not a corpus question.
- **Suggested scope:** No single change closes this. (1) Land TRO-516's remaining C-series rulings (case-21, case-23, case-17) and file a TRO-563-style corpus-decision ticket for case-16 and case-18. (2) Work TRO-540 (deskew) for case-19. (3) Re-run the band after each corpus edit, per TRO-561's own re-baseline protocol. Piece (1) is a Troy judgment call each time, not code; piece (2) is the one genuine engineering task on this row.

### TH-R4 — PARTIAL
- **Quote:** "during peak season, we get these big importers who dump 200, 300 label applications on us at once … If there was some way to handle batch uploads, that would be huge."
- **Source:** source-TH.md, L13 (Sarah Chen interview)
- **What is missing:** No batch has ever run at the scale the brief names. The largest real run is 32 items (TRO-544, local workstation, 50.48 items/minute). Everything else in the acceptance line is met: N items in, N per-item verdicts out, progress/summary views present, `MAX_IMAGE_COUNT` set to 1000, and durable Postgres image storage (TRO-518) so the batch survives Render's web/worker split.
- **Suggested scope:** Run one batch of 200+ items and commit the artifact — a measurement gap, not a build gap. **Do not point this run at the public deployed URL** — no auth yet (PR #43 open), and a 200-300 item batch there bills real API money against an unauthenticated endpoint. Use the same local-workstation setup `local-batch-run.json` already used.

## Rows with nothing to fix

### TH-R5 — IMPLEMENTED-UNVERIFIED
- **Quote:** "For this prototype, we're not looking to integrate with COLA directly"
- **Source:** source-TH.md, L20 (Marcus Williams interview)
- **What is missing:** Nothing. A negative scope constraint — no behavioural test can prove the absence of an integration. Re-confirmed this sweep with two fresh static checks: `grep -rn "COLA" src/` returns exactly one hit (a regulatory citation comment, no client code), and a broader sweep for registry-integration patterns returns zero matches anywhere in `src/`.
- **Suggested scope:** None. This row will never reach VERIFIED and should not be worked.

## Orphan tickets

Eighteen tickets map to no brief requirement. All eighteen are factory tooling,
gate policy, changelog/test-fixture hygiene, or explicitly parked/deferred
product tracks — legitimate reasons to exist. Listed so this sweep is not read
as calling them waste.

- TRO-487 "LH-070 · Final submission gate" — the meta-gate for the whole submission; not itself a single requirement.
- TRO-510 "Realistic-corpus pilot-batch hardening" — backlog for the parked AI-backdrop track; TRO-529's real photographs already closed the imperfect-image coverage a different way.
- TRO-520 "CHANGES.md: clarify the no-spend statement" — changelog-prose hygiene.
- TRO-521 "E2E suite: reconsider the test.skip(E2E_LIVE,...) exception" — review-triage of a test design choice.
- TRO-523 "CHANGES.md: ASD-STE100 sentence-length pass" — changelog writing-style hygiene.
- TRO-525 "E2E fixtures test: buildCorruptImage's length assertion" — test-fixture hygiene.
- TRO-526 "E2E fixtures: buildManifestCsv column mapping" — test-fixture hygiene.
- TRO-531 "LH-028 · AI-backdrop track: land the fixes, then park it" — explicitly to be parked; superseded by TRO-529's real photographs for TH-R12's coverage.
- TRO-545 "LH-040b · Make batch the primary workflow on the home page — DEFERRED" — explicitly deferred; TH-R4's acceptance line is already met without it.
- TRO-548 "Factory: gate.sh review step re-reviews the whole branch every run" — build-process cost, no requirement.
- TRO-553 "G6 human-approved exception path" — factory gate policy.
- TRO-554 "Defect-gates engine hardening backlog" — factory tooling backlog.
- TRO-555 "Golden-set loader: warning-absent cases must force formatting flags false" — manifest-loader hardening, protects the corpus rather than adding a case.
- TRO-556 "manifestContentHash drift detection" — evidence-hygiene tooling.
- TRO-557 "worktree.sh: refuse cross-session reuse without --steal" — worktree isolation safety.
- TRO-559 "Measurement scripts overwrite another ticket's committed evidence in place" — evidence hygiene; protects this audit trail rather than the product.
- TRO-560 "Gate's review step silently reuses the previous run's findings" — gate correctness.
- TRO-562 "CI workflow pins no action to a commit SHA / persists credentials" — CI supply-chain hardening; considered against TH-R6 and judged out of scope (not the application's own data-handling posture).

Two further Backlog tickets target real, unbuilt stretch scope and are neither
orphans nor cited evidence: TRO-528 (bold-isolating golden cases, TH-R9/TH-R12)
and TRO-532 (advisory stroke-width bold check, TH-R9) — named here so they
are not silently dropped from the sweep.
