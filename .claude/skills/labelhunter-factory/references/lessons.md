# Standing rules for factory agents

Injected into every agent brief. **Keep this short.** A rule earns its place by having caught a
real failure; noise here degrades every future prompt. When a gate failure could have been
prevented by a better brief, add one line. When an agent simply hit a hard problem, add nothing.

Seeded 2026-08-10 at factory build time: rules 1–9 are inherited from the ship factory's
production run (they are paid-for, not speculative); rules 10+ will be LabelHunter's own.

## Claims

1. **Mark derived claims as derived.** "The eval reports X, which usually means Y" — never "it
   does Y." State the configuration every check ran under; a pass under a config that skips
   the broken path proves nothing.
2. **Never fabricate a number.** Latency, accuracy, and cost figures come from real measured
   runs or are written "not measured" (PRD §6). This project is graded on honest evidence.

## Environment

3. **Always `source .factory-env` before running anything.** Tests must only ever touch your
   worktree's own database. Never run with `DATABASE_URL` unset or pointing elsewhere.
4. **NEVER `git stash` in a factory worktree.** `refs/stash` is shared across every worktree;
   a sibling can pop your entry within minutes. For before/after comparisons, decide the
   method *before* you start: copy files aside, or `git show HEAD:<path> > TRO-XXX-before.ext`.
5. **The scratchpad is shared across concurrent agents.** Prefix every scratch file with your
   ticket ID.

## Tests

6. **Confirm a regression test fails for the right reason.** An import error or a typo is not
   a red test — it proves nothing about the behaviour you claim to have handled.
7. **Put the regression test where the gate executes it** — a `*.test.ts(x)` file the unit
   vitest run loads. An e2e-only spec satisfies the gate's added-case grep while never
   running.
8. **Never add a fixed sleep to a test. Await an observable event.** To assert an absence,
   poll for the window and assert the value never changes, tied to a real constant.
9. **A test with only comments (or no assertions) passes silently.** Every test asserts
   something, or it is `test.fixme()`.

## LabelHunter specifics

10. **The cascade is the architecture, not an optimization** (TH-R19, PRD §3.1). Haiku
    extracts every label; Sonnet sees only escalations routed by an explicit `ReviewReason`.
    Never wire Sonnet into the per-label happy path; never make routing depend on a bare
    confidence number shown to the user without its reason.
11. **Two matching regimes coexist deliberately** (TH-R8 vs TH-R9): judgment (normalized
    fuzzy, STONE'S THROW ≡ Stone's Throw → MATCH with note) for brand/class fields, and
    exact statutory comparison for the government warning (title-case prefix → FAIL with the
    caps reason). Do not let one regime's helpers leak into the other.
12. **Uncertain beats wrong** (TH-R10). A low-quality image produces `LOW_IMAGE_QUALITY` →
    review, never a confident verdict. The UI always shows the reason, never a bare
    confidence percentage.

## Log

*Append dated entries as the factory learns. One line each, with the ticket that taught it.*

- 2026-08-10 — seeded at factory build; gate still UNVERIFIED (pre-scaffold). The scaffold
  ticket must run the verification checks before anything merges on gate evidence.
- 2026-08-10 (TRO-456) — **A sub-agent that backgrounds its own final gate run and waits for
  it never comes back with the result.** Twice, the scaffold agent kicked off
  `scripts/factory/gate.sh` as a background process "because CodeRabbit takes a few minutes,"
  then ended its turn saying it would report back — and never did; the orchestrator had to run
  the gate itself both times to get a real verdict. This is rule 22 from the inherited ship
  lessons, confirmed live: run the gate in the **foreground** and read the result before
  finishing the report. A slow step is not a reason to background it — it's a reason to wait
  on it synchronously.
- 2026-08-10 (TRO-456) — **An agent's own uncommitted work is invisible to the next gate run.**
  The scaffold agent made real, correct CodeRabbit-driven fixes (Cache-Control header, a
  rounding regression test) but never `git commit`ed them — they only existed as working-tree
  changes. The orchestrator's merge picked them up by accident (via `git status`), not by
  design. **Before trusting a gate verdict or opening a PR, run `git status --short` in the
  worktree and confirm it's clean** — an agent's final report claiming a fix is not evidence
  the fix was committed.
- 2026-08-10 (TRO-456) — **`git merge main` into a ticket branch conflicts on `CHANGES.md`
  every time**, exactly as predicted: this repo has no `merge-changes.mjs` (documented in
  `build-factory`'s `operation.md` but never generated as an actual script here). Resolved by
  hand twice in one ticket — keep both entries, newest-relevant on top, drop only the
  conflict-marker lines. If this recurs on a third ticket, generate the real merge tool instead
  of resolving by hand again (recurrence-ladder rule: 3 = build the mechanical fix).
- 2026-08-10 (TRO-456) — **In a unit-selection function, round the value ONCE before any branch
  decision, not inside each branch.** Three separate rounding-boundary bugs surfaced in
  `formatDuration` across two review rounds — the minutes/seconds remainder hitting 60, the
  seconds display rounding up to "60.0s", and finally 999.5ms rounding to "1000ms" while
  `formatDuration(1000)` itself renders "1.00s". Same root cause every time: a branch decided
  which unit to use based on the *unrounded* value, so the displayed rounding and the branch
  boundary disagreed right at the edge. The fix pattern is the same each time — round first,
  branch on the rounded value. Apply this on sight to any new format/threshold function; don't
  wait for a reviewer to find each boundary one at a time.
- 2026-08-10 (TRO-459) — **A security fix stated as fact needs the same verification as any
  other claim — even from the orchestrator.** "JSON.stringify neutralizes the injection" was
  written into a design doc, sounded right, and was wrong: `JSON.stringify` escapes quotes,
  backslashes, and control characters, but not `<`, `>`, or `/` — a value containing
  `</UNTRUSTED_DATA>` survives, literally, in the serialized output. CodeRabbit caught it by
  actually running `JSON.stringify` against the attack string; the fix (Unicode-escape
  `<`/`>`/`/` after stringifying) was then verified the same way before being written down
  again. Any claim about what a stdlib function escapes, sanitizes, or neutralizes gets an
  actual `node -e` run before it goes in a document someone will build a security boundary on —
  "this is how JSON.stringify works" is exactly the kind of confident-sounding claim the
  claim-provenance rule (CLAUDE.md) exists to catch, and it applies to the orchestrator's own
  writing, not just agents'.
- 2026-08-10 (Wave 0 retro) — **The orchestrator's own scorecard discipline slipped once
  dispatched agents started running their own gate loops.** TRO-456 and TRO-459 have a
  scorecard row for every attempt, as the loop requires. TRO-457 and TRO-458 do not — both had
  their own agent iterating through several gate re-runs and CodeRabbit rounds semi-autonomously
  (see the "background-wait" and "still-alive-after-final-report" lessons above), and rows only
  got appended for the attempts the orchestrator happened to run itself. `status.mjs`'s
  first-attempt-pass number for this wave is real but under-representative — it counts 2
  tickets, not 4. Going forward: when a dispatched agent's own worktree shows more commits or
  gate runs than the orchestrator initiated, backfill scorecard rows from `.factory/gate-result.json`
  history (or at minimum one row summarizing the total attempts) before treating the ticket as
  closed — don't let the record be thinner than the work.
