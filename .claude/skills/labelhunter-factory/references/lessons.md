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

13. **Validate at the boundary where a value's shape is only assumed, not guaranteed**
    (recurring `correctness` category, TRO-459 + TRO-460). A plain substring test isn't an
    equality check — CP-1's evidence-substring anti-hallucination check let 45 match inside
    145. A pixel region isn't guaranteed finite or integer before it reaches `sharp()` —
    fractional/NaN coordinates need an explicit check, not an assumption the caller already
    validated. When code accepts a value from a model output, a detector, or any producer you
    don't control, name the actual invariant (word-boundary, finite, integer, non-empty) and
    check it explicitly — don't let the type system's silence stand in for a real check.

14. **Sync local `main` with `origin/main` before every `worktree.sh` call**, not just
    after a wave. `gh pr merge` updates the remote only; the orchestrator's own local `main`
    stays stale until an explicit `git merge --ff-only origin/main`. `worktree.sh` branches
    from local `main` and, worse, silently reuses an already-existing branch at whatever base
    it had — it does not detect or refuse a stale one. TRO-462 was provisioned from a `main`
    six commits behind, missing the two tickets it depends on, and had to be torn down
    (`git worktree remove --force` + `git branch -D`) and re-provisioned.

15. **Re-read the exact CP-1/PRD rule text for the field you're implementing before writing
    the comparison, not from memory of having read it earlier in the same session**
    (`correctness` crossed 3 tickets — TRO-459, TRO-460, TRO-462 — the ladder's mechanical-
    check line, but the 8 findings underneath it are NOT one shared bug shape: a substring-
    vs-word-boundary gap, NaN propagation, an alpha-channel default, an un-normalized
    "alternates differ" check, a greedy regex, a missing unit conversion CP-1 §5.3 states
    explicitly, and an ASCII-only character class. One grep-style gate check cannot catch
    six different root causes, and inventing one anyway would be manufactured confidence, not
    a real check — see CLAUDE.md on that. What they share instead: each is a place the
    implementation approximated an algorithm CP-1 already specified precisely (unit
    conversion, conflict-after-parsing, Unicode word boundaries). No mechanical gate check
    added; the fix is discipline, not tooling — when a ticket brief quotes a CP-1 rule,
    implement the quoted rule, not a plausible-sounding paraphrase of it.
16. **CHANGES.md prose gets CodeRabbit's ASD-STE100 pass on nearly every PR** (`prose-style`,
    2 tickets: TRO-461, TRO-462). Every entry ships nested parentheticals on the first draft.
    Write CHANGES.md entries as short, standalone sentences from the start — subject, verb,
    one idea per sentence — per CLAUDE.md's own writing-style section. Don't wait for review
    to catch it.
17. **Re-read your own doc's earlier claims before appending a new round** (`doc-consistency`,
    2 tickets: TRO-459, TRO-497 — 7 findings on one CP-1 doc alone). A count, a scope
    limitation, or an accepted/rejected decision written in round 1 routinely goes stale or
    self-contradicts once round 2's fix changes the very thing round 1 described (a "clamp vs
    reject" contradiction stated three different ways in one doc; a determinism claim left
    unqualified 30 lines from the caveat that qualifies it). Before writing a new paragraph,
    grep the doc for the words you're about to contradict.
18. **Any string that ever passed through the label image, the applicant's form, or a model's
    own prior output is adversarial input, in every prompt it reaches — not just the first one
    reviewed** (`prompt-injection`, 2 tickets: TRO-459, TRO-464). CP-1's walkthrough established
    the `serializeUntrusted` / `UNTRUSTED_DATA`-block convention for the extractor prompt; the
    identical gap then recurred in a completely different file (the resolver's
    `user-message.ts` interpolated `FieldResultRow.reason` and `FlaggedField.trigger` raw).
    When you write ANY new prompt-building function, ask whether an interpolated value could
    ever carry applicant- or extractor-sourced text — if yes, it needs the same treatment,
    regardless of which file or ticket first established the pattern.
19. **A field whose validity depends on another field's value needs a discriminated union, not
    an object with independently-optional fields** (`type-safety`, 2 tickets: TRO-462, TRO-497).
    `reviewReason` is only meaningful when `verdict` is `NEEDS_REVIEW`; `resolvedBy` is only
    meaningful when a field was actually escalated — modeling these as plain optional/nullable
    properties let TS compile combinations the logic never intends (`NEEDS_REVIEW` with no
    reason; `resolvedBy: sonnet` with `reviewReason: null`). Encode the dependency in the type
    so the invalid combination fails to compile, instead of relying on a runtime check to catch
    it after review does.
20. **Text-matching and word-boundary logic must be Unicode-aware from the first draft**
    (`i18n`, 2 tickets: TRO-462, TRO-463, both on `text-boundary.ts`). `[a-z0-9]` character
    classes miss accented letters (Añejo); `.toLowerCase()` is not true Unicode case-folding
    (misses German ß); comparing precomposed vs. canonically-equivalent decomposed spellings
    without `.normalize('NFC')` first makes identical text fail to match. Treat "this touches a
    label's text" as the trigger to use `\p{L}\p{N}` classes and `.normalize('NFC')` by default,
    not as something a reviewer points out after the fact.
21. **A finding documented in `CHANGES.md` is not the same as a finding recorded in the ledger**
    — and this needs saying in EVERY message that can cause an agent to run `gate.sh` again,
    not only the first one (orchestrator process, 4 tickets: TRO-471, TRO-505 x2, TRO-466 — the
    second TRO-505 occurrence was the orchestrator's OWN follow-up message, which asked the
    agent to check for a new *PR-level* review after a `main`-merge but never mentioned the
    ledger — re-gating after the merge predictably surfaced fresh *local-cli* findings, which
    again went into `CHANGES.md` only). All agents ran `gate.sh`'s local CodeRabbit capture
    several times as their own inner loop, fixed real findings, and wrote a careful "Review
    triage" section into `CHANGES.md` — then never ran
    `node scripts/factory/review-ledger.mjs record`, because nobody had told them to in THAT
    message; the brief (or the follow-up) only said "produce/extend a `CHANGES.md` entry."
    Every message that can cause an agent to gate again — an initial brief, a merge-conflict
    follow-up, a "check for a new PR review" nudge, anything — must say explicitly: record each
    local-cli finding in the ledger *as you triage it*, the same command a PR-review triage
    would use, not only in `CHANGES.md`. A prose paragraph is not queryable by
    `review-ledger.mjs report` and silently drops out of the recurrence ladder. All four
    were backfilled by the orchestrator this session — check for this gap on sight in any
    ticket whose CHANGES.md names a "local CodeRabbit pass" the ledger doesn't also show.

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
- 2026-08-10 (Wave 1, TRO-460) — **The TRO-456 "uncommitted work is invisible" lesson
  recurred on the very next ticket that had the chance to.** The LH-010 agent wrote real,
  correct fixes for its own CodeRabbit findings (a `RangeError` guard against NaN/fractional
  pixel regions reaching `sharp().extract()`, and a white-flatten before JPEG encode so a
  transparent PNG doesn't go dark) — then reported the ticket finished with those five files
  still uncommitted. Its final message also claimed it would "wait for a gate monitor
  notification," which does not exist; only the orchestrator's own gate run is authoritative.
  A same-wave sibling (TRO-461) made the identical false "waiting for a notification" claim
  despite having actually committed and self-gated cleanly — so the false-notification belief
  and the uncommitted-work problem are two separate failure modes wearing the same words, not
  one. Two tickets tripping the uncommitted-work half of this in one wave (TRO-456, TRO-460)
  crosses the recurrence-ladder's mechanical-check line: `scripts/factory/gate.sh` now refuses
  with `exit 2` on a non-clean worktree (checked via `git status --porcelain`) before running
  anything, whenever it is not called with `--fast` (the documented dirty-tree-tolerant inner
  loop stays exempt) — a "pass" against an uncommitted tree was certifying a `headSha` that did
  not match what was actually tested. Brief wording alone had already stated this rule twice
  (agent-contract.md's "confirm git status --short is clean," this file's TRO-456 entry) and
  it still recurred — the mechanical check is the fix now, not a third restatement.
- 2026-08-11 (TRO-497) — **Never chain `gate.sh` into push/merge in one shell command, and
  never filter its output through `grep` for control flow.** The orchestrator piped the gate
  through `grep -E "^===|FAIL"`; grep exits 0 when it FINDS the failure lines, so a failing
  gate let the chain continue and PR #9 merged on a red gate. Outcome survived only because
  the failure was environmental (below) and CI's clean-room run was green. Rule: run the gate
  as its own command, branch on ITS exit code, and only then push/merge in a separate step.
- 2026-08-11 (TRO-497) — **After merging `main` into a ticket branch, run `pnpm install`
  before gating.** The merge brought LH-015's new devDependencies in package.json; the
  worktree's node_modules predated them, so the gate failed with 37 phantom TS errors that
  looked like a broken merge. A gate verdict from a node_modules that doesn't match the
  branch's lockfile is not evidence in either direction.
- 2026-08-11 (TRO-467) — **Linear's GitHub automation auto-completes an issue when a PR
  attached to it merges — even with no `Closes` line.** Merging CP-2's walkthrough-material PR
  flipped the CHECKPOINT ticket itself to Done, which a later session could read as the
  checkpoint being cleared. After merging any PR attached to a checkpoint ticket, re-read the
  ticket's state and revert an automation-driven Done; only Troy's explicit acknowledgment
  completes a checkpoint ticket.
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
- 2026-08-11 — **`review-ledger.mjs report` had not actually been run "before each wave" as
  instructed; by the time it was, four categories had already crossed the 2-ticket brief-rule
  line (rules 17–20 above, this run) and FIVE had crossed the 3-ticket gate-check line without
  a mechanical check ever getting added: `test-coverage` (13 findings/4 tickets), `docs` (9/3),
  `boundary-validation` (12/3), `prose-style` (11/6) — plus `correctness` (27/7), which rule 15
  already declined to gate-check on the record (six unrelated root causes, no shared pattern to
  grep for). The other four have no such recorded reason for staying ungated — they are an open
  item, not a closed one. Run the report before every wave, the way the skill actually says to;
  a threshold crossed and not acted on is the same failure as never measuring it.
