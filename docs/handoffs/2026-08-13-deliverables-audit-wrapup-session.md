# Handoff — LabelHunter factory, 2026-08-13 evening (v2)

Paste the block below into a fresh session. Everything above the line is context for Troy.

**Written by:** the deliverables/audit session (TRO-486 sweep, TRO-484 README, TRO-485
approach.md, TRO-483 seeded demo — all four now merged). Supersedes the earlier version of
this file; that one was written mid-afternoon and is stale on ticket ownership, PR status, and
the sweep numbers. This version reflects `main` at `6c1b6cb` / origin `33fbcf3`.

---

You are joining the LabelHunter ticket factory. **Three other sessions are already running.**
Read `.claude/skills/labelhunter-factory/SKILL.md` and `references/lessons.md` before you
touch anything — lessons.md runs to rule 34, nearly all of it written today from real failures
this exact factory hit.

## What this is

A TTB take-home: AI-powered alcohol label verification, real deadline, live defence. Troy
must be able to explain every decision personally. `docs/PRD.md` is settled architecture,
`audit/requirements/inventory.md` holds the 23 graded requirements (TH-R1..R23), and
`factory/config.yaml` records measured facts.

## Where things stand

- `main` is green. The app is **deployed, access-gated, verified working, and seeded** at
  `https://labelhunter-web.onrender.com` — the URL and access code are now published in
  `README.md` itself (both independently verified against the live gate before publishing,
  not assumed from a merge). The code lives **only** in Render's dashboard
  (`render.yaml` declares `ACCESS_CODE` `sync: false`) and in that README — never anywhere
  else in the repo.
- **README.md and docs/approach.md both exist and are merged** (PRs #66, #68). TH-R14 and
  TH-R15 — MISSING for three straight sweeps — are closed. TH-R2 (latency) has a real,
  current number: p50 3618 ms / p95 4197 ms, 20/20 PASS, measured past the live access-code
  gate after TRO-568 unblocked the harness.
- **The seeded demo landed** (PR #73): all 36 golden-set cases ran as a real batch against the
  live deployed instance. 36/36 processed — 11 PASS, 3 FAIL, 22 REVIEW. An evaluator opening
  the URL from the README now sees real data, not an empty app.
- **A production incident happened and was fixed today.** The batch above stalled at 2/36 for
  ~30 minutes: the worker was OOM-crash-looping (5 concurrent `tesseract.js` OCR workers plus
  `sharp` image decode exceeded the Render "starter" plan's memory ceiling — invisible to
  single-label verify, which never runs more than one at a time). Diagnosed via `render logs`
  (the CLI is authenticated in this environment; read-only use is fine, be careful with
  anything that mutates a live service). Fixed via `render.yaml` concurrency (5→2 extract,
  2→1 resolve). Filed as TRO-571, now Done. Nothing was lost — the batch queue's
  lease-expiry reclaim is correct under a worker restart, just not productive during one.
- **The freshest full requirements sweep** (a peer session, dated files, commit `e63b00b` —
  *before* the README/approach.md/seeded-demo merges above) found **11 VERIFIED / 9 PARTIAL /
  1 IMPLEMENTED-UNVERIFIED / 2 MISSING**. Read
  `audit/requirements/REPORT-2026-08-13-th-full.md` for the full picture, but treat the two
  MISSING rows (TH-R14, TH-R15) as **stale** — both merged since that sweep ran. Nobody has
  re-run a sweep against current `main` yet. **That re-run is probably the single
  highest-leverage thing the next session could do** — it would very likely move TH-R14 and
  TH-R15 to VERIFIED and TH-R2 to VERIFIED with the real number, and give an accurate current
  count instead of one two merges out of date. TRO-486 (the sweep ticket) is still "In
  Progress" in Linear for exactly this reason — its own definition of done ("every TH-R
  VERIFIED or documented descope") isn't met yet, mainly because of the two real gaps below.

## Two real, unticketed-fix gaps found today, both worth knowing before you pick anything

1. **TH-R9's bold-detection gap (TRO-569, Urgent, Backlog).** The government warning's bold
   requirement is captured by the extractor (`formatting.bold`, `true`/`false`/`uncertain`)
   and validated into the response — but **nothing in `src/server/router/` or
   `src/server/warning/` ever reads it**. Verified directly by grep, not assumed. A correctly
   worded, correctly capitalized, non-bold `GOVERNMENT WARNING:` prefix passes today, which
   the brief calls a rejection. This had been masked in every prior sweep by a since-corrected
   inventory interpretation that wrongly allowed "documented as a limitation" to satisfy the
   requirement — Troy struck that (INT-005). **TRO-532 (stroke-width bold advisory check) and
   TRO-533 (surface the bold signal; fix the bold doc drift) are older, already-filed Todo
   tickets that look like they cover the same ground as TRO-569.** Read all three before
   starting any of them — there is likely real overlap, and the primary orchestrator session
   owns that corpus-chain territory (see below).
2. **TH-R17's cascade-verdict accuracy gap.** 7 of 36 golden cases land on the wrong end-state
   verdict; 6 share one pattern (a deliberately degraded image reads confidently on a single
   channel, masking an expected REVIEW). `audit/requirements/gaps.md`'s TH-R17 entry has the
   full case-by-case breakdown. TRO-516 (In Progress) is already working part of this.

## Claimed — do NOT touch these, and do not run `worktree.sh` for them

| Session | Territory |
|---|---|
| deliverables/audit (this one) | **Empty now.** TRO-483/484/485/486 all resolved or merged. Not picking up anything new unless asked. |
| a coordination session | TRO-557 (In Progress) — worktree.sh reuse guard |
| primary orchestrator | TRO-508 (In Progress), TRO-516 (In Progress), the corpus chain (TRO-528/530/532/533/540/563), eval family |
| a UI/accessibility session | TRO-570 (claimed as of this writing — confirm before assuming it's free) |

Confirm before assuming any of those freed up. `ListAgents` and `SendMessage` reach the other
sessions; message them by the `from=` socket on any cross-session message, or by session name
from `ListAgents` if no socket is given. **Session names and sockets both drift across a long
run** — the same peer showed up under three different display names today. If a name from an
earlier message doesn't resolve, re-run `ListAgents` and match by which ticket they mention
owning, not by name alone.

## Open backlog, roughly by leverage

**High/Urgent, unclaimed as of this writing:**
- **TRO-569** (Urgent) — the bold-detection gap above. Check TRO-532/533 overlap and the
  corpus-chain ownership first.
- **TRO-570** (High) — UI/accessibility walkthrough, including the access-code screen (now
  literally the first thing an evaluator sees, never reviewed). May already be claimed —
  confirm.
- **TRO-566** (High) — batch workers never check or record the daily budget, so an admitted
  batch can run past the daily cap. Lives in `src/server/batch/`, likely primary
  orchestrator's territory — confirm before starting.
- **TRO-563** (High) — case-22 corpus decision: strengthen the degradation pixels or correct
  the expected verdict to PASS. Explicitly Troy-gated, not a code-only call.

**Medium, unclaimed:**
- **TRO-562** — CI workflow pins no action to a commit SHA, persists credentials on checkout.
  Self-contained, touches `.github/workflows/ci.yml` plus a test. Nobody owns it. Note: pinning
  freezes security patches too, so the ticket's own text covers the update-path trade-off —
  read it before just pinning blindly.
- **TRO-572** — `worktree.sh` has no lock against two truly concurrent invocations racing the
  DB reset. Related to TRO-557 (In Progress) — check with that session first, may be the same
  fix.
- **TRO-556** — no `manifestContentHash` drift detection on committed eval artifacts.
- **TRO-555** — golden-set loader doesn't force formatting flags false on warning-absent cases.
- **TRO-554, TRO-548** — factory-tooling backlogs (defect-gate hardening, gate.sh review
  re-scoping). Lower urgency than anything above.

**Explicitly parked/deferred — do not pick these up without asking Troy first:**
- TRO-545 (batch-as-primary-workflow, DEFERRED), TRO-531 (AI-backdrop track, park after
  landing fixes), TRO-510 (realistic-corpus pilot-batch hardening — superseded in spirit by
  TRO-529's real photographs).

**Troy's alone — see the section at the bottom, don't start these:**
TRO-487 (final submission gate).

## The protocol, learned the hard way today

1. **Announce before every merge**, not as it lands. As-lands cost a full extra resolve+CI
   cycle — this cost two sessions real time today.
2. **Serialise CodeRabbit captures** — one at a time across all sessions, announced start and
   done. A *spending-cap* error means announce-and-stop, never retry. A *rate limit* or
   transport failure (WebSocket drop, etc.) is retryable — rule 34: CI green plus a
   persistent rate limit is enough to proceed without a completed local capture.
3. **`CHANGES.md` conflicts are REBUILT, never union-merged** (rule 26b): take `origin/main`'s
   file whole, insert your one new entry after the preamble. Union-merging splices two
   entries into each other; G7's structural check catches it, but only after the damage.
   `factory/review-findings.jsonl` and `factory/scorecard.jsonl` are the opposite — union
   both sides, they're line-oriented with nothing to corrupt.
4. **After merging `origin/main`: `pnpm install` AND `pnpm db:migrate`**, every time (rule 27).
   A missing migration surfaces as `SERVICE: could not save this verification` mid-run and
   reads as a corpus regression, not a setup gap.
5. **A PR with no CI runs at all is a merge-conflict symptom, not an Actions outage.** GitHub
   will not run `pull_request` workflows when it cannot compute a merge commit. Check
   `mergeStateStatus` before assuming CI is broken. Expect to resync against `main` multiple
   times in a row late in the day — main moved under every one of today's PRs 2-3 times each
   between push and merge.
6. **Housekeeping may land direct on main; anything a ticket produces goes through
   worktree → gate → PR → CI → triage** (rule 33). A docs-only branch that trips G6 uses
   `factory/gate-exceptions.json` with Troy's own per-ticket approval — never a direct push,
   and never inherited from another ticket's exception. Get Troy's confirmation **directly**,
   even if a peer relays that he already gave it — his name goes in the approval record.
7. **`worktree.sh` reuses a worktree by ticket slug and resets its database.** TRO-557 is
   fixing it; TRO-572 may be the same root cause. Until both land, never provision a ticket
   another session has In Progress.
8. **Verify a review finding against the code before acting on it — every time.** Real
   examples from today: a port-binding finding pointed at the wrong file (README was already
   correct; the real instance was in `.env.local.example`); a PR-#43-status finding was
   simply stale by the time CodeRabbit's capture ran; a self-authored draft claimed "no
   confident wrong verdicts" in one section while a different section of the same document
   already contradicted it. All three were caught by opening the file before editing it, not
   by trusting the finding's own wording.
9. **`render logs` and the `render` CLI are available and authenticated in this environment.**
   Read-only diagnosis (logs, deploy status) is fine and was the only way to catch today's OOM
   incident. Anything that mutates a live Render service (restart, plan change, env var edit)
   is Troy's call — ask first, the same as any other hard-to-reverse production action.

## Standards that are not negotiable here

- **Evidence, not assertion.** Every claim is marked observed / derived / not verified. "The
  migration applied" means you queried the database and saw the table, not that a command
  exited 0.
- **Never fabricate a number.** Latency, accuracy, and cost come from a real run or are
  written "not measured." A batch-throughput estimate was made and shipped wrong today, then
  caught and corrected before merge — that's the standard: not "never make a mistake," but
  "never let a wrong number stand once you know better."
- **Cite a measured accuracy figure as a band (K=3, N=36: extraction 87.2-87.8%,
  cascade-verdict 80.6-83.3%), never a single point value.** TRO-561 exists specifically
  because an earlier practice pinned to one end of a measured spread.
- **An interpretation may narrow a requirement into something testable. It may never widen it
  into something weaker than the brief.** A softened line in the requirements inventory hid
  the TH-R9 bold-detection gap through every prior sweep until Troy struck it today (INT-005).
- **Red-first, for the right reason.** See the test fail, and confirm it failed because of the
  defect rather than a typo or a missing import.

## What is Troy's alone

The `verified: true` flags on golden cases still `false`, whether to spend on a clean batch
throughput benchmark at PRD scale (200-300 items — the only measured run is 32 items, and the
36-item live run today was disrupted by the OOM incident, so its own throughput number is
incident-contaminated and not usable as a clean figure either), the TH-R17 accuracy gap's
resolution path where it requires a corpus judgment call (TRO-563 is explicitly one of these),
and the final submission gate (TRO-487) — wording and the submit decision. Ask; do not decide
these.

## Suggested first move

1. Read `audit/requirements/REPORT-2026-08-13-th-full.md` for the fullest recent picture, with
   the two-MISSING-rows-are-now-stale caveat above in mind.
2. `ListAgents`, then message every peer found to confirm current ownership before touching
   anything — names and sockets drift.
3. Consider re-running the requirements sweep yourself before picking a ticket. It's
   unclaimed, it's high-leverage (the numbers everyone is citing are two merges stale), and
   it directly informs which of the open backlog items above actually matter most right now.
