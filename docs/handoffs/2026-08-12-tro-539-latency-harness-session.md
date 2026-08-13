# Handoff: TRO-539 latency-harness ticket, done but not yet re-gated post-merge — 2026-08-12

Written for a fresh session picking up where this one left off. Everything below is committed
in the worktree; nothing important lives only in this conversation.

---

## 1. Start here — the one fact that changes what you do

**TRO-539's own work is done and was gate-verified `pass` — but the orchestrator then merged
`origin/main` on top of it, and that merge was never independently re-gated.** Sequence,
confirmed directly from git, not assumed:

- `5fe6ccf` — my last TRO-539 commit. `scripts/factory/gate.sh` verdict `pass` at this exact
  SHA, confirmed via `.factory/gate-result.json` (`headSha` matches, all gates `pass` except
  `review: warn` — advisory only, never blocking).
- `221a147` — a later commit, **not mine**, titled `merge: resolve origin/main into TRO-539
  (append-only unions)`. This is the orchestrator's own post-ticket step: merge in whatever
  else landed on `origin/main` meanwhile (PR #49, `fix/lh-corpus-calibration`, is in the
  ancestry) and re-verify. That script chains `git commit && pnpm install && gate.sh &&
  <scorecard update>` with `&&`. The commit succeeded (verified: `221a147` exists, no
  `MERGE_HEAD`, no `.git/*.lock`, no conflict markers in `CHANGES.md` or
  `factory/review-findings.jsonl` — clean). But `.factory/gate-result.json` still shows
  `headSha: 5fe6ccf`, and `factory/scorecard.jsonl` has no new row for this attempt — meaning
  the `gate.sh` call in that chain got interrupted before it finished (killed mid-run, not a
  hang: I watched it via `ps` twice about a minute apart and it was gone the second time, well
  under the CodeRabbit sub-step's own hard 6-minute `timeout` wrapper).

**Net effect: the worktree is safe (clean merge, no corruption), but there is currently no
recorded gate verdict for the actual branch tip, `221a147`.** First thing to do in a new
session: `cd /Users/troy/repos/labelhunter-wt-tro_539 && source .factory-env && git log
--oneline -3` to confirm you're still looking at the same state, then run
`scripts/factory/gate.sh` fresh (foreground, wait for the verdict line — lessons.md rule 28)
before doing anything else with this branch (push, PR, or handing to the next ticket).

---

## 2. What TRO-539 (LH-034) actually built

Ticket: fix the latency harness's provenance trap, add a per-stage `Server-Timing` breakdown,
add a real-HTTP `--url` mode. Full detail — all four numbered defects/fixes, the new artifact
fields, how to run `--url` mode, the fake-server validation's real numbers, and all four
CodeRabbit review rounds — is written up in **`CHANGES.md`'s TRO-539 entry (top of the file as
of `5fe6ccf`/`221a147`)**. Don't re-derive it from memory; read that entry, it's the source of
truth and it's already ASD-STE100-tightened.

Short version:

- `pipelineScope` in `scripts/latency/measure.ts` is no longer a hard-coded string
  (`scripts/latency/target-info.ts:53`, `buildPipelineScope`) — the provenance-trap defect the
  ticket opened on.
- `POST /api/verify` now returns a `Server-Timing` header on every 200 response, one entry per
  PRD §3.8 stage (`src/app/api/verify/server-timing.ts`, wired into
  `src/app/api/verify/route.ts:238-450`).
- `scripts/latency/measure.ts` gained `--url=<origin>` mode: a real HTTP round-trip instead of
  the in-process call, with its own 30s request timeout, `--cleanup-db`-gated (plus a loopback
  check) database cleanup, and `target`/`renderPlan`/`model`/`validationNote` provenance fields
  that are all derived at measurement time, never hard-coded.
- Zero-cost validation run committed at
  `scripts/latency/results/single-label-verify-fake-server-validation.json` — proves the whole
  `--url` mechanism against `scripts/e2e/fake-anthropic-server.ts`, loudly labeled in its own
  fields as NOT a TH-R2 number.
- Corrected the already-false "4232 ms" figure everywhere it was quoted
  (`audit/requirements/REPORT.md`, the older TRO-471 `CHANGES.md` entry) — the real committed
  artifact number is 3690 ms, and neither figure is a valid current TH-R2 measurement (both
  predate the warning comparator).
- **TH-R2 stays PARTIAL.** This ticket makes the code-side machinery satisfiable; it does not
  and cannot raise the verdict. The real deployed measurement (original ticket steps 5–9)
  is still blocked on Troy: provisioning the real `ANTHROPIC_API_KEY` on Render (a hard-stop
  credential action) and his go-ahead to spend real money on a live run.

**Four local CodeRabbit review rounds, run to convergence** (9 → 9 → 5 → 1 findings): 22 fixed
for real (including a genuine cross-database delete risk in `--cleanup-db`'s own gating — a
loopback hostname alone isn't sufficient in this repo's own multi-worktree-DB pattern), 2
dismissed with concrete evidence recorded. All 24 in `factory/review-findings.jsonl`.

---

## 3. Rules that bit this session, worth re-reading before continuing

- **Never quote 4232 ms as a TH-R2 figure anywhere.** It's a superseded artifact's number,
  fixed this session, but easy to reintroduce from an old draft or a stale doc.
- **Never run a load tool or a real measurement against the real deployed instance without
  Troy's explicit go-ahead** — real money, and it's not this ticket's call.
- **`git stash` is banned in factory worktrees** (shared `refs/stash` across worktrees) — use
  `git show HEAD:<path> > scratch-file` for before/after diffs instead.
- **Foreground `gate.sh`, wait for the verdict line** — don't background it and trust a later
  notification; this session's own investigation above is exactly why (an interrupted
  background-ish run left a stale result file that looked fine at a glance).
- **Local `main` in the primary checkout goes stale** — `git fetch && git merge --ff-only
  origin/main` after every PR merge, not just `git fetch` (see the auto-memory entry
  `factory-local-main-staleness` for the full mechanism — this bit an earlier session hard).

---

## 4. Immediate next steps, in order

1. `cd /Users/troy/repos/labelhunter-wt-tro_539 && git log --oneline -3` — confirm HEAD is
   still `221a147` (or later, if something else landed since).
2. `source .factory-env && scripts/factory/gate.sh` (foreground, full run, not `--fast`) — get
   a real verdict for the current tip. Expect `pass`; if it's not, that's new information, not
   a regression this session caused (all TRO-539-specific work was independently verified
   `pass` at `5fe6ccf` before the merge).
3. If `pass`: proceed with whatever the normal factory flow is from here (push, open PR, or
   hand to the next queued ticket) — this session did not push or open a PR, per the ticket's
   own instructions to leave that to the orchestrator.
4. If anything looks wrong at step 2 that this handoff didn't anticipate, treat it as new
   information and investigate fresh — don't assume it's a TRO-539 regression without checking,
   since the merge pulled in unrelated work from `origin/main` (PR #49) too.
