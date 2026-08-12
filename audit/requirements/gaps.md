# Gaps — 2026-08-12 (compare vs 2026-08-11-pm)

12 of 23 requirements are not yet VERIFIED.

## TH-R2 — Single-label ≤~5s p50  ·  PARTIAL

**Tickets:** TRO-471, TRO-514, TRO-519

**What would close it:** Two steps close this. Step 1: fix TRO-519 — race the OCR channel against an explicit deadline, and degrade to { available: false } on timeout, which reconcileWarningChannels already handles. Step 2: re-run pnpm latency:check against the wired route, commit the fresh artifact, and update the CHANGES.md p50 figure to match it. Without step 1 the p95 is unbounded, so step 2 alone is not enough.

**Notes:** Verdict held at PARTIAL. Every cited line exists and reads as claimed. I checked the tracer's ordering claim with git, not by inference: commit c5e49f8 wired the warning comparator into the route at 2026-08-11T22:30:19-05:00, and commit 5a16263 committed the latency artifact at 2026-08-11T21:17:48-05:00. The measurement therefore predates the wiring, and the artifact's own pipelineScope field says so independently. I confirmed the missing OCR deadline by reading src/server/warning/index.ts. I read TRO-519 in Linear; it is real, Urgent, and still in Backlog. I did not run pnpm latency:check, because it makes billed API calls. Two additions the tracer left out. First, the changelog gap is one-directional: CHANGES.md line 3364 records p50 4232 ms and never records 3690 ms. Second, evidence that partly offsets the risk: CHANGES.md line 188 records 11 of 11 E2E specs passing against a product

---

## TH-R4 — Batch mode (200–300 scale)  ·  PARTIAL

**Tickets:** TRO-473, TRO-474, TRO-475, TRO-472, TRO-518, TRO-506, TRO-522

**What would close it:** Two changes close this. First, replace local-file-storage.ts with a shared object store behind its existing interface, so the worker reads what the web service wrote (TRO-518, already ticketed, Urgent). Second, run one real batch at 200-300 items and record the measured result, or state the untested scale in the docs. Wiring `pnpm test:e2e` into CI (TRO-522) would then keep the whole chain honest on every push.

**Notes:** The batch subsystem is real code. The last sweep found only a schema table and a .gitkeep. Citation check: one line number was wrong. The sentence "measured against a real multi-hundred-image upload; a future ticket can" sits on line 38 of start-batch.ts, not line 39. I corrected the entry. Every other citation opened at the cited line and said what the entry claims. I reproduced the tracer's own runs against the throwaway database labelhunter_audit_0812. The batch server suites gave 22 files, 249 tests, all passed. The four batch UI suites gave 4 files, 33 tests, all passed. Both numbers match the tracer exactly. I also proved the suites need a real database. I pointed DATABASE_URL at a database name that does not exist. src/server/batch-start then failed 7 of its 14 tests. So the green run is Postgres evidence, not a mock. The verdict stays PARTIAL for one confirmed defect. The web ser

---

## TH-R6 — No PII / sane secrets posture  ·  PARTIAL

**Tickets:** TRO-457, TRO-484, TRO-482

**What would close it:** Two small, independent pieces, both already ticketed and both Backlog. (a) TRO-484 (LH-063, README) adds a short "Data handling" section: what the database stores (label and application fields only), what it never stores (no PII, no reviewer identity), where uploaded images live (local disk, gitignored), and where the API key lives (Render env config, never the repo). That closes the acceptance clause. (b) TRO-482 (LH-061) builds the access-code gate PRD §8 already designs; it should land before the deployment is public.

**Notes:** CITATION CHECK. I opened all six original cited lines plus pool.ts:44. All exist and all say what the row claims. I corrected one factual detail inside a supports string: commit 8fa8999 appends to .gitignore at lines 35-36, not 33-34. Two note claims needed correction. (1) Secret scan. The tracer wrote "1 match, the declared fake". That count reproduces under no pattern I tried. The prior sweep's strict pattern sk-ant-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{30,} across .ts/.tsx/.md/.json/.yaml/.yml/.cjs/.mjs returns 0 matches, because the fake key contains hyphens. A loose "sk-ant" grep over the same file types, excluding audit/requirements (the audit's own output), returns 3 matches: playwright.config.ts:59 (the declared fake), CHANGES.md:923 (prose about a red-before-green test), and scripts/deploy/render-yaml.test.ts:256 (an assertion that render.yaml contains no key). None is a credential

---

## TH-R7 — Constrained-network dependency doc  ·  PARTIAL

**Tickets:** TRO-478, TRO-468, TRO-485, TRO-519

**What would close it:** Small and concrete. Add one row to docs/error-states.md's outbound table for the OCR language data: tesseract.js, loaded from the committed tessdata/eng.traineddata.gz, no runtime network call, proven by src/server/warning/ocr-startup.test.ts. Add one line naming what a stuck OCR worker does, once TRO-519 gives it a deadline and a degrade path. Then TRO-485 (LH-064, approach.md) folds the finished section into the submission doc.

**Notes:** CITATION CHECK. I opened all ten cited lines. All ten exist and all support their claim. I tightened one supports string: ocr.ts:83 sets langPath, and by itself proves configuration, not the absence of a network call; the network-blocked test carries that proof. I re-ran both commands the row leans on, DATABASE_URL pointed at labelhunter_audit_0812. (1) pnpm test -- src/app/api/verify/route.test.ts --reporter=verbose: "Test Files 1 passed (1) / Tests 20 passed (20)", including the named unreachable-endpoint case. (2) pnpm test -- src/server/warning/ocr-startup.test.ts --reporter=verbose: "Test Files 1 passed (1) / Tests 2 passed (2)", both cases named, including the negative control. Both reproduce; only the per-test millisecond figures differ, as expected. I also tested the gap claim instead of trusting it: grep for tesseract, ocr and tessdata across docs/error-states.md returns 0 match

---

## TH-R9 — Warning exact word-for-word check  ·  ASSUMED

**Tickets:** TRO-467, TRO-468, TRO-469, TRO-514, TRO-517, TRO-533

**What would close it:** Two small changes close this without a ruling. First, add one real-image test that runs compareGovernmentWarningFromImage against golden-set/images/case-08-title-case-warning-prefix-only.jpg and asserts MISMATCH, mirroring index.test.ts's existing case-01 test. That proves the fail path on the live pipeline and answers TH-R9-a in code. Second, land TRO-533's PRD correction and copy CP-2 §7.3's paragraph into a graded deliverable, correcting "reports" to match what the UI actually shows. TRO-519's OCR timeout is a separate reliability fix and does not gate this row.

**Notes:** Downgraded from VERIFIED to ASSUMED. The code is real and the tests are green. The verdict is not yet earned.

Two citations were wrong, and I corrected both. src/server/warning/index.ts: the quoted stale comment sits on line 19, not line 21. docs/checkpoints/cp2-warning-subsystem.md: "LabelHunter checks neither rule" sits on line 848, not line 846. I opened the other fifteen cited lines. All fifteen exist and say what the row claims. I added five evidence rows for findings the traced row buried in prose.

I re-ran both commands. `DATABASE_URL=<labelhunter_audit_0812> pnpm exec vitest run src/server/warning src/server/comparators` printed "Test Files  17 passed (17) / Tests  198 passed (198) / Start at 13:12:10". The route suite printed 1 file / 20 tests green. The full suite printed "Test Files  137 passed (137) / Tests  1524 passed (1524)". No output tail was invented.

Why ASSUMED, no

---

## TH-R14 — README setup/run instructions  ·  MISSING

**Tickets:** TRO-484

**What would close it:** Write README.md at the repo root: prerequisites, `pnpm install`, `.env.local` shape, `pnpm db:migrate`, `pnpm dev`, the test commands, the deployed URL plus access code, a short architecture summary, and the TH-R6 data-handling posture. One file, one ticket (TRO-484).

**Notes:** I repeated every check and the row holds. `git ls-files | grep -i readme` returns exactly one path, golden-set/README.md, which documents the test-image corpus. `ls -la` at the repo root shows no README file, tracked or untracked. Linear shows TRO-484 ("LH-063 · README") in Backlog with updatedAt 2026-08-10T20:08:34Z, so it has not moved since the baseline sweep. Empty evidence is correct: nothing exists to cite, and the tracer said why. citation-checked

---

## TH-R15 — Approach/tools/assumptions doc  ·  MISSING

**Tickets:** TRO-485

**What would close it:** Write docs/approach.md to the contents PRD.md:241-242 already names: approach, tools used, assumptions log, trade-offs and limitations, the bold-detection limitation, and the measured cascade benchmark numbers from scripts/eval/results/benchmark-report.json. One document closes TH-R15 and the written half of TH-R23.

**Notes:** Both cited lines exist and say what the row claims, with one trim. The tracer's supports text for PRD.md:241 ran the quote through line 242; I cut it back to what line 241 itself carries and named line 242 here. `ls docs/` and `git ls-files docs` both confirm docs/approach.md does not exist. Linear shows TRO-485 ("LH-064 · approach.md") in Backlog with updatedAt 2026-08-10T20:08:38Z. Unchanged since baseline. citation-checked

---

## TH-R16 — Deployed, reachable URL  ·  MISSING

**Tickets:** TRO-481, TRO-483, TRO-518

**What would close it:** Not a code gap. Troy follows docs/deploy.md "First deploy": create the Render Blueprint from main, paste the Anthropic key into both services, wait for labelhunter-web to report healthy, then open <url>/api/health and run one single-label verify on the deployed instance. Record the URL in the README (TRO-484) and in audit/requirements.config.yaml's verify_urls.app, which is still null. TRO-518 must land before TRO-483 (seeded demo) can honestly demo a batch; single-label verify needs neither.

**Notes:** CITATION CHECK. I opened all four cited lines. All exist and all say what the row claims, with one exception I rewrote: factory/config.yaml:69 records the git remote, and cannot support a claim about every URL in the repo. I ran the narrower search myself: grep for "onrender.com" across the whole repo, excluding node_modules and .git, returns 0 matches. No deployed host exists to open. I re-ran the regression test: pnpm test -- scripts/deploy/render-yaml.test.ts gives "Test Files 1 passed (1) / Tests 23 passed (23)". Reproduces. I verified the Linear quote the tracer flagged as checkable but uncitable. TRO-481's merge comment reads, verbatim: "Advances: TH-R16 (deployed URL, evaluator-testable prototype) — repo-side config only; the live deploy itself is still your step (docs/deploy.md)." Statuses confirmed live: TRO-481 Done, TRO-483 Backlog, TRO-518 Backlog and Urgent. audit/requiremen

---

## TH-R17 — Rubric: core works completely  ·  PARTIAL

**Tickets:** TRO-465, TRO-514, TRO-468, TRO-475, TRO-470, TRO-518, TRO-516

**What would close it:** Close TRO-518 with a shared object store so batch works across the Render web/worker split. Settle the six expected-REVIEW golden cases and case-28/29 under TRO-516, then re-run `pnpm eval:check` so the accuracy figure means one thing. No new scope beyond those two tickets; the code for every functional entry already exists.

**Notes:** Every cited line exists and supports its claim, with three quote boundaries trimmed. The tracer ran three of its supports quotes across a line break (verify/route.ts:2-3, verify/route.ts:31-32, brand.ts:3-4). The anchor line numbers are right, so I kept them and named the continuation lines instead. The batch/start entry cited line 3 but quoted line 2's text; the ticket and TH-R IDs the claim needs are on line 3, so I re-pointed the quote rather than the line. I added local-file-storage.ts:69 so the deployment gap rests on code, not only on a doc that describes code. Two other small fixes: the deploy.md bullet spans lines 94-110, not 94-109, and TRO-516's title names two cases while its body covers the six REVIEW-expected cases plus case-28/29 — I read the ticket to confirm the tracer's six-case claim is fair. I re-ran both test commands. The targeted core-loop run reproduced exactly: 31

---

## TH-R19 — Rubric: appropriate tech, defended  ·  PARTIAL

**Tickets:** TRO-456, TRO-462, TRO-470, TRO-485

**What would close it:** Write docs/approach.md and land TRO-485. It must name each major choice — Next.js on Render, Postgres with Drizzle, the Haiku extractor, the deterministic router, the Sonnet resolver, tesseract.js for OCR — and justify each one against prototype scope. Cite the benchmark report's own numbers for the cascade decision, so the defense rests on measurement. No code change closes this. It shares the gap with TH-R15, and one document closes both.

**Notes:** Verdict held at PARTIAL. One line number corrected: "It never calls Sonnet" sits on route.ts line 13, not 14. Every other cited line reads as claimed, and I counted the decision-log rows rather than trusting the figure. I confirmed the gap by listing the tree: no docs/approach.md exists, and docs/ holds only checkpoints, deploy.md, error-states.md, handoffs, prd-brainstorm-questions.md, PRD.md, reference-photo-provenance.md, and superpowers. One correction on wording: the tracer wrote "no README.md exists either". No root README.md exists; golden-set/README.md does. I read TRO-485 in Linear — it is real, priority High, still in Backlog, and its description names TH-R15, TH-R23, and TH-R7. I did not run pnpm eval:benchmark; it makes billed API calls, so the cited artifact stands as a dated record measured 2026-08-12T05:23:34Z. citation-checked

---

## TH-R21 — Rubric: traceability  ·  PARTIAL

**Tickets:** TRO-486

**What would close it:** Two of the three open items close with one document each: README.md (TRO-484) and docs/approach.md (TRO-485). Add one line citing TH-R5 to a ticket description so the tracker dimension is complete as well. TRO-486 (LH-065) exists to re-sweep and confirm; keep it open until the two documents land.

**Notes:** All five cited lines exist and support their claims. I corrected the tracer's counts, which do not reproduce. factory/tickets.md: 46 LINES contain a TH-R reference, and there are 75 individual references across 22 distinct IDs. The tracer reported "46 references," conflating a line count with a reference count. CHANGES.md: 74 lines contain a TH-R reference, and there are 101 individual references across 21 distinct IDs. The tracer's figure of 105 does not reproduce by any counting method I tried, so I replaced it with the measured numbers. The conclusions those counts serve are unaffected and I re-derived them. tickets.md omits only TH-R5. CHANGES.md omits TH-R5 and TH-R14. The union therefore omits only TH-R5, and PRD.md:46 addresses TH-R5 by ID as a deliberate scope constraint. The "71 entries" claim is right: CHANGES.md has 71 `## TRO-` headings, plus four `## FACTORY` headings, 75 in

---

## TH-R23 — Working core > ambition; trade-offs doc  ·  ASSUMED

**Tickets:** TRO-485, TRO-484

**What would close it:** Write docs/approach.md with a trade-offs and limitations section that pulls in what docs/deploy.md:84-110 and docs/error-states.md:154-168 already say, plus the bold-detection limitation and the batch storage break (TRO-518). One document closes TH-R15, the written half of this row, and part of TH-R21.

**Notes:** All four cited lines exist and say what the row claims. I trimmed the PRD.md:241 quote back to its own line, as in TH-R15. I verified the tracer's "new since the last sweep" claim rather than take it: `git cat-file -e cbc7088:docs/deploy.md` and the same check for docs/error-states.md both fail, so neither file existed at the baseline commit. That is the fact the ruling turns on, and it is real. One date correction: docs/error-states.md was first authored 2026-08-11 (commit d67c9a3), not 2026-08-12; it reached main after the baseline sweep. docs/deploy.md is 2026-08-12 (commit 023b088). I kept ASSUMED. The tracer did not resolve the ambiguity itself; it stated the stricter reading, showed the row lands at PARTIAL under it, and raised the question. That is the correct handling, and report-format.md pairs an ASSUMED row with a needs_ruling entry. The prioritization signal is confirmed in L
