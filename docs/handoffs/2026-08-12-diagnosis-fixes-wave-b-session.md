# Handoff: Wave 2c diagnosis fixes, key protection, Wave B — 2026-08-12

Written for a fresh session that will resume the factory. Everything below is committed,
pushed, or recorded in Linear. Nothing important lives only in the last conversation.

---

## 1. Start here — the facts that change what you do

**Do not merge TRO-482 (PR #43) without Troy's explicit security read.** It is built, gated,
and clean — access code + rate limits + a Postgres-backed daily spend budget. It carries a
mandatory security-semantics hold (`escalation.md` rule 7). The orchestrator held it on
purpose. Do not treat "gate passes" as license to merge this one.

**TRO-544 (PR #45) was never independently gated or merged — a correction to an earlier,
wrong claim in this same session.** The orchestrator told Troy mid-session that it was
merged. It was not. The agent's own self-report is clean (real measured throughput, real
review triage), but nobody has run `scripts/factory/gate.sh` on it independently, and it is
still `OPEN` on GitHub. Do this first.

**TRO-543 (PR #46) is gated clean and pushed, but has an unexplained merge conflict, and its
CI never triggered on the last push.** `origin/main`'s tip commit was already merged into the
branch once (verified: the SHA matched). A second `git merge origin/main` still produced a
real `CHANGES.md`/`factory/scorecard.jsonl` conflict — the orchestrator aborted the merge
attempt rather than force it through under time pressure, so nothing is broken, but this is
genuinely unexplained, not just routine. Separately, `gh run list --branch
feat/lh-038-verdict-variance` returned zero rows after the last push — the CI workflow never
ran at all, possibly a GitHub Actions concurrency backlog from this session's own volume
(dozens of runs). Check both before merging.

**Local `main` in the primary checkout goes stale silently — fast-forward it after every PR
merge, not just `git fetch`.** This session lost real time to `gate.sh`'s `scope` check
reporting 40-43 files for tickets whose real footprint was 23-25, because local `main` sat 6
PRs behind `origin/main` for a long stretch. Full writeup, and the fix, in
`.claude/skills/labelhunter-factory/references/lessons.md` territory — see the auto-memory
entry `factory-local-main-staleness` for the complete mechanism. The one-line fix:
`git fetch origin && git merge --ff-only origin/main` in the **primary checkout**, right after
every `gh pr merge`, before gating the next ticket.

**TRO-543's Part 2 (the real paid verdict-variance sweep) needs Troy's go-ahead before
dispatch.** The ticket's own acceptance criteria require it explicitly. Cost estimate, derived
from real per-call costs: 8 cases × 5 repeats ≈ $0.19–0.63; 32 cases × 3 repeats (full corpus)
≈ $0.45–1.50. Ask before spending it.

---

## 2. What is committed — 8 PRs merged this session

| PR | Ticket | Contents |
|---|---|---|
| #37 | TRO-536 | Normalizer drops the apostrophe at step 6 (case-15 fix) |
| #38 | TRO-537 | Real-image government-warning FAIL test (closes TH-R9's PARTIAL, INT-001) |
| #39 | TRO-534 | `beverage_type` cross-check vocabulary guard (case-11 fix) |
| #40 | TRO-535 | `OCR_CONFIDENCE_FLOOR` measured sweep, 60 → 50 |
| #41 | TRO-519 | OCR channel timeout (`OCR_TIMEOUT_MS`, 2000ms) — confirmed does NOT reproduce under `pnpm build && pnpm start`, but the gap was real regardless |
| #42 | TRO-538 | Cascade end-state scoring — `routerVerdict`/`cascadeVerdict` split, fixes the benchmark stage-mismatch bug |
| #44 | TRO-518 | Batch image storage moved from local disk to Postgres `bytea` (survives Render's web/worker split) |
| — | — | (PR #43/TRO-482 and #45/TRO-544 and #46/TRO-543 are still open — see §1 and §3) |

All 6 Wave-A merges (#37–#42) and both Wave-B merges (#44, and #45 once it lands) needed at
least one `origin/main` conflict-resolution round; TRO-538 needed four, the last one a **real**
code conflict (not just the append-only-file pattern) in `scripts/eval/{types,verdict-scoring,
cascade-runner}.ts` where TRO-535's and TRO-538's own independent additions to the same import
lines and the same insertion point needed manual reconciling — both landed correctly, verified
by running the affected test files, not just trusting the merge.

**A genuine integration gap was found and fixed while resolving that conflict, not by either
original ticket's own tests** (neither could have caught it alone): `mergeResolutionIntoActualVerdict`
(TRO-538) never received TRO-535's warning-channel provenance, so the cascade end state would
have silently reported `warningChannel: null` even when `government_warning` passed through
the router unresolved. Fixed: `routerWarningChannel` added as a required 5th parameter,
3 new tests. Same pattern hit TRO-543 later (built against the pre-split `CascadeCaseResult.verdict`
field) — fixed there too, with a design decision recorded: variance tracks `cascadeVerdict`
(the real end state), not `routerVerdict`.

---

## 3. Open PRs — not merged, exact state

| PR | Ticket | Gate | Mergeable | What's needed |
|---|---|---|---|---|
| #43 | TRO-482 | Pass (orchestrator-verified) | Not checked recently | **Troy's security read**, then merge |
| #45 | TRO-544 | Not yet run by the orchestrator | `UNKNOWN` | Independent gate run, then merge |
| #46 | TRO-543 | Pass (orchestrator-verified) | `CONFLICTING` (unexplained — see §1) | Investigate the conflict, confirm CI actually runs, then merge |

---

## 4. Real measured numbers — quote the latest, not an earlier session's figure

Numbers moved twice in one session as fixes compounded. All three are honest for the code that
existed when measured; only the last is current.

| Stage | Router-verdict accuracy | Cascade-vs-Sonnet-only delta |
|---|---|---|
| Before this session (known bug: router-vs-cascade stage mismatch) | 65.6% (21/32) | −24.1pp (comparing two different pipeline stages — the bug) |
| TRO-538 alone, isolated branch | 68.8% (22/32) | −29.0pp |
| **Full Wave A merged (current, `main` HEAD)** | **75.0% (24/32)** | **−34.4pp** |

`scripts/eval/results/eval-report.json` `measuredAt: 2026-08-12T22:15:52.776Z`;
`benchmark-report.json` `measuredAt: 2026-08-12T22:30:58.027Z`. Both are real `--live --full`
runs against the merged code, re-run specifically because regenerating the artifacts without
re-measuring would have left stale numbers in `CHANGES.md`.

**TRO-544's real local batch throughput** (32-item golden-set batch, local dev workstation,
not deployed): 50.48 items/minute, 1.19s/item average, 56.3% auto-verified (18/32), Sonnet
escalation cap hit (8/8). Artifact: `scripts/batch-throughput/results/local-batch-run.json`
(on TRO-544's own branch, not yet merged).

**TRO-543's free retrospective figure** (zero cost, independently re-derived from committed
artifacts, not just copied from the ticket brief): across the 29 case IDs common to all five
committed cascade runs, 28 are stable (identical verdict and reason every time); case-17 is
the one exception, 3 REVIEW / 2 PASS. This bounds the error bar on every single-run accuracy
figure this project has quoted so far.

---

## 5. New tickets filed this session

- **TRO-546** — case-22's `government_warning` field passes on a single channel when the golden
  set expects `NEEDS_REVIEW`. Independently surfaced by **three** unrelated tickets (TRO-534,
  TRO-535, TRO-538) converging on the same defect the same day — the kind of corroboration that
  justifies a real ticket rather than a scattered note.
- **TRO-547** (raised Medium → High mid-session) — `BatchProgressBrowser.test.tsx`'s "never has
  two polls in flight" test is flaky under load. Hit **5** times today: TRO-535's CI, TRO-538's
  CI, TRO-544's own local gate runs (2 of 3), and the post-merge CI run on `main` itself after
  TRO-538 merged. Every occurrence passed standalone or on an immediate rerun. Matches the
  established TRO-513 signature. Raised to High specifically because the `main`-branch
  occurrence erodes trust in the gate's own signal for everyone, not just one PR author.

---

## 6. Open decisions, and who owns them

| Decision | Owner | Notes |
|---|---|---|
| Security read on TRO-482 before merge | Troy | Access code + rate limits + spend budget; escalation.md rule 7 |
| Go-ahead on TRO-543's real paid variance sweep | Troy | Cost estimate in §1/§4; PR #46 stays Part-1-only until then |
| Gate + merge TRO-544 (PR #45) | Next session | Never independently gated — do this first, it's the simplest of the three open PRs |
| Resolve TRO-543's unexplained conflict, confirm CI runs | Next session | Not routine — investigate before force-resolving |
| Dispatch TRO-516 (corpus corrections) | Next session | Unblocked now — both its blockers (TRO-538, TRO-535) landed |
| Dispatch TRO-539 (deployed latency) | Next session | Unblocked now — TRO-519 landed |
| README / approach.md (TRO-484/485) | Deliberately held | Wanted TRO-482's access-code landing and TRO-538's final numbers stable first, to avoid drafting against figures that move again |

---

## 7. Corrections made this session, so they are not repeated

- **A false "merged" claim was made and is corrected here.** The orchestrator told Troy
  mid-session that TRO-544 was merged. It was not — it was only dispatched and self-reported
  clean. Caught while preparing this handoff, by checking `gh pr list` directly rather than
  trusting the earlier summary. **The lesson: before writing "merged" anywhere, check `gh pr
  view <n> --json state,mergedAt` — do not infer it from "the agent finished and I moved on."**
- **A test's own justification was wrong on first attempt, caught by running the test.** While
  fixing `manifest-hash.ts` to hash raw bytes instead of a UTF-8-decoded string, the first
  written test claimed a BOM would be dropped on decode — false in Node (`Buffer.toString('utf8')`
  round-trips a BOM fine). Verified before committing to the claim: the real gap is that Node's
  UTF-8 decoder replaces *invalid* byte sequences with U+FFFD on decode. Test and code comment
  both corrected to state only what was actually checked.
- **Local `main` staleness** — see §1 and the `factory-local-main-staleness` memory entry.

---

## 8. Cost incurred

Real live-model spend this session, all logged, none fabricated: TRO-535's floor sweep and
full re-eval (~$0.32), TRO-538's two full re-runs of `eval:check`/`eval:benchmark` after
merging (~$0.27 + ~$0.75), TRO-534/536/537's small single-case live checks (a few cents each),
TRO-519 (no model spend, pure timeout logic), TRO-518 (no model spend, storage-only), TRO-544's
real 32-item batch run (~$0.24), TRO-543's four 1×1 mechanical proofs (~$0.02 total, no real
sweep run). Render: unchanged, still $24.50/month prorated from 2026-08-12, nothing new
provisioned this session.
