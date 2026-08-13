# Handoff — LabelHunter factory, 2026-08-13 (UX walkthrough / Notion reskin / audit session)

Paste the block below into a fresh session. Everything above the line is context for Troy.

**Written by:** the session that ran TRO-570 (UI/accessibility walkthrough), TRO-573
(Troy-directed Notion-style reskin), and a requirements-audit compare sweep that caught TRO-574
merging mid-run. Its lane is empty; this hands the next session something new without collision.

---

You are joining the LabelHunter ticket factory. Read
`.claude/skills/labelhunter-factory/SKILL.md` and
`.claude/skills/labelhunter-factory/references/lessons.md` before you touch anything —
lessons.md runs to rule 35 plus a corollary, most of it written today from real failures.

## What this is

A TTB take-home: AI-powered alcohol label verification, real deadline, live defence. Troy must
be able to explain every decision personally. `docs/PRD.md` is settled architecture (now
including a Notion-style aesthetic, see below), `audit/requirements/inventory.md` holds the 23
graded requirements (TH-R1..R23), `factory/config.yaml` records measured facts.

## Where things stand — very close to submission-ready

- `main` is green at `439b6bc`. The app is deployed, access-gated, and verified working at
  `https://labelhunter-web.onrender.com`. The access code lives only in Render's dashboard.
- **The requirements sweep says 22/23 VERIFIED, 1 PARTIAL.** Read
  `audit/requirements/REPORT.md` first — it's the fastest way to see where the project actually
  stands. The one open row is **TH-R9** (the government warning's bold rule: captured and typed,
  never checked downstream — a correctly-worded, correctly-capitalized, non-bold
  `GOVERNMENT WARNING:` prefix still passes). **Already claimed**: TRO-532 (In Progress, owned
  by `run-w6-factory-mvp-path`) with TRO-533 to follow. Don't duplicate this — check with that
  session before touching anything bold-related.
- **The UI changed today.** TRO-573 (Troy-directed, in-session) replaced the USWDS-influenced
  look with a Notion-style one: white page, warm near-black text (`#37352f`), thin soft borders,
  larger radius, one quiet accent blue. **Dark mode is gone** — no `prefers-color-scheme`
  branching, light-only by deliberate design. `docs/PRD.md` §5 names this as the settled
  direction now; don't "fix" the UI back toward USWDS thinking that's still current.
- Every color pair in the new palette is checked by a permanent automated test
  (`src/app/globals-contrast.test.ts`), not just measured once by hand — if you touch
  `globals.css`, that test will catch a contrast regression.
- TRO-570 (UI/accessibility walkthrough, first one ever run) found zero accessibility
  violations, zero broken keyboard paths, zero color-only verdicts. TRO-573's reskin was
  re-verified against the same bar (axe-core, 0 violations across all 8 screens) before merging.

## Claimed — do NOT touch these without checking first

| Session | Territory |
|---|---|
| `run-w6-factory-mvp-path` | TRO-532, TRO-533 (TH-R9 bold-detection) |
| primary orchestrator (assignee: Troy in Linear) | TRO-508, TRO-516 |
| whoever owns TRO-486 | Still shows In Progress in Linear as of this handoff — likely just gap-fix cleanup, confirm before assuming it's free |

`ListAgents` and `SendMessage` reach the other sessions; message them by the `from=` socket on
any cross-session message. **Confirm before assuming any territory freed up** — three different
sessions corrected my assumptions today, cheaply, because I asked first.

## Open, unclaimed, and genuinely optional

Nothing graded is blocking. Everything left is factory-tooling backlog or polish:

- **PR #82 (TRO-572)** — worktree.sh concurrency lock, open, owned by `labelhunter-d0` per
  earlier context. Check its CI/merge status before assuming it needs anything.
- **Dependabot PRs #76–#79** — action-version bumps for the SHAs TRO-562 just pinned. Mechanical,
  low-risk, nobody's claimed them.
- **TRO-566** (Backlog, High) — batch workers don't cover the daily budget correctly. Real, but
  not a graded-requirement blocker (TH-R6 is already VERIFIED on other grounds).
- **TRO-508, TRO-548, TRO-556, TRO-554, TRO-555, TRO-564, TRO-563** — all factory-tooling or
  golden-set-hygiene backlog, all Backlog/Medium-or-lower, none TH-R-blocking.

## The protocol, learned (and re-learned) the hard way today

1. **Announce before every merge**, not as it lands.
2. **Serialise CodeRabbit captures** — one at a time across all sessions, announced. Account-wide
   rate limit + CI green is enough to proceed (rule 34) after one retry; don't loop on it.
3. **`CHANGES.md` conflicts are REBUILT, never union-merged** (rule 26b).
4. **After merging `origin/main`: `pnpm install` AND `pnpm db:migrate`** (rule 27).
5. **A PR with no CI runs at all is a merge-conflict symptom** — check `mergeable`/
   `mergeStateStatus` before assuming Actions is down (rule 35's corollary: `mergeable: true`
   alone doesn't mean CI passed — check `statusCheckRollup` too).
6. **Housekeeping may land direct on main; anything a ticket produces goes through
   worktree → gate → PR → CI → triage** (rule 33).
7. **`worktree.sh` reuses a worktree by ticket slug and resets its database — check Linear
   before invoking it, not after.** I violated this rule myself today: ran
   `worktree.sh TRO-486 ...` for an unrelated audit task without checking that TRO-486 was a
   peer session's own ticket first, and reset their database. No harm done (they'd already torn
   it down), caught immediately, apologized, and the peer confirmed no work was lost — but the
   lesson is: check `ListAgents`/Linear status *before* picking a ticket-slug for `worktree.sh`,
   not after running it. If you need an isolated DB for something that isn't itself a ticket
   (an ad hoc audit, a one-off script), reuse a worktree you already own, or pick a slug you're
   certain nothing else maps to — don't grab a real, active ticket ID as a convenience name.
8. **A CHANGES.md/PRD entry gets an ASD-STE100 pass before it ships**, not after CodeRabbit asks
   for it (still the single most recurring finding category — 10 of 11 findings on TRO-573 were
   this).
9. **A requirements-audit sweep can go stale mid-run.** A PR merged while this session's own
   compare sweep was in progress (TRO-574, closing TH-R7). Re-check `gh pr list`/`git fetch`
   right before finalizing a report, not only at the start — a sweep that reports a gap as open
   five minutes after it closed is worse than one that took five more minutes to be right.

## Standards that are not negotiable here

- **Evidence, not assertion.** Every claim is marked observed / derived / not verified.
- **Never fabricate a number.** Latency, accuracy, cost come from a real measured run.
- **Verify a review finding against the code before acting on it.**
- **Every audit evidence citation must actually open and say what the note claims** — a stale
  line number after an unrelated file changed is a false citation even if the underlying claim
  is true. Caught and fixed two of these today (`CHANGES.md` line shifts after a new entry
  prepended above an old one; `.github/workflows/ci.yml` line shift after TRO-562's diff).

## What is Troy's alone

The `verified: true` flags on the remaining unconfirmed golden cases, whether to spend on a
clean throughput benchmark at PRD scale, and the final submission gate. Ask; do not decide these.

## Suggested first move for a fresh session

1. Read `audit/requirements/REPORT.md` (fast, tells you exactly where the project stands).
2. `ListAgents`, then message active peers to confirm current territory — it moves fast.
3. If nothing urgent is free (likely, given TH-R9 is the only real gap and it's claimed): help
   with review triage on any open PR, or ask Troy directly what he wants prioritized toward
   submission — polish, a fresh live latency/eval run at submission time, or the README/
   approach.md final read-through before it ships.
