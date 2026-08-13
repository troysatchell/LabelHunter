# Standing rules for factory agents

Injected into every agent brief. **Keep this short.** A rule earns its place by having caught a
real failure; noise here degrades every future prompt. When a gate failure could have been
prevented by a better brief, add one line. When an agent simply hit a hard problem, add nothing.
Prefer tightening an existing rule over adding a new one. Prune on sight: a lesson now enforced
by tooling, or superseded by a later entry, gets deleted here, not kept "for the record" — this
file is a working prompt, not an incident archive.

Rules 1–9 are inherited from the ship factory's production run. Rules 10+ are LabelHunter's own.

## Claims

1. **Mark derived claims as derived.** "The eval reports X, which usually means Y" — never "it
   does Y." State the configuration every check ran under; a pass under a config that skips
   the broken path proves nothing.
2. **Never fabricate a number.** Latency, accuracy, and cost figures come from real measured
   runs or are written "not measured" (PRD §6).

## Environment

3. **Always `source .factory-env` before running anything.** Never run with `DATABASE_URL`
   unset or pointing anywhere but your own worktree's database.
4. **NEVER `git stash` in a factory worktree** — `refs/stash` is shared across worktrees, a
   sibling can pop your entry. For before/after diffs, copy files aside or `git show
   HEAD:<path> > TRO-XXX-before.ext` instead.
5. **The scratchpad is shared across concurrent agents.** Prefix every scratch file with your
   ticket ID.

## Tests

6. **Confirm a regression test fails for the right reason.** An import error or typo is not a
   red test.
7. **Put the regression test where the gate executes it** — a `*.test.ts(x)` file the unit
   vitest run loads, not an e2e-only spec.
8. **Never add a fixed sleep to a test. Await an observable event.**
9. **A test with only comments, or no assertions, passes silently.** Every test asserts
   something, or it is `test.fixme()`.

## LabelHunter specifics

10. **The cascade is the architecture, not an optimization** (TH-R19). Haiku extracts every
    label; Sonnet sees only escalations routed by an explicit `ReviewReason`. Never wire Sonnet
    into the per-label happy path; never route on a bare confidence number shown without its
    reason.
11. **Two matching regimes coexist deliberately** (TH-R8 vs TH-R9): judgment/fuzzy (STONE'S
    THROW ≡ Stone's Throw → MATCH with a note) for brand/class fields; exact statutory
    comparison for the government warning. Don't let one regime's helpers leak into the other.
12. **Uncertain beats wrong** (TH-R10). A low-quality image produces `LOW_IMAGE_QUALITY` →
    review, never a confident verdict. The UI always shows the reason, never a bare confidence
    percentage.
13. **Validate at the boundary where a value's shape is only assumed, not guaranteed** — a
    model output, a detector result, anything from a producer you don't control. Name the real
    invariant (word-boundary, finite, integer, non-empty, positive, canonical format) and check
    it explicitly; don't let the type system's silence stand in for a real check. Recurring
    across `correctness` and `boundary-validation` findings — still not gate-checked (TRO-508).
14. **Sync local `main` with `origin/main` before every `worktree.sh` call, not just after a
    wave.** `worktree.sh` branches from local `main` and silently reuses a stale existing branch
    without detecting it — provisioning from behind means missing dependency tickets.
15. **Implement the quoted CP-1/PRD rule text, not a remembered paraphrase of it.** Rewritten
    from memory has produced wrong unit conversions, wrong conflict-after-parsing order, and
    ASCII-only boundaries where CP-1 specifies Unicode. When a brief quotes a rule, re-read the
    quote before writing the comparison.
16. **CHANGES.md prose gets an ASD-STE100 pass on nearly every PR.** Write entries as short,
    standalone, subject-verb sentences from the start (CLAUDE.md's writing-style section) —
    don't wait for review to catch nested parentheticals and run-ons. Still the single most
    recurring finding category; not gate-checked (TRO-508).
17. **Re-read your own doc's earlier claims before appending a new round.** A count, scope
    limitation, or accepted/rejected decision from round 1 routinely goes stale once round 2
    changes the thing round 1 described. Grep the doc for words you're about to contradict.
18. **Any string that passed through the label image, the application form, a model's own
    prior output, or a comparator's derived note/reason text is adversarial input, in every
    prompt it reaches** — not just the first one reviewed, and not only the obviously-raw
    fields. A comparator's `reason` embeds the label reading it was computed from (recurred on
    the resolver's flagged-fields block after the extractor block was already covered). Use the
    extractor prompt's `serializeUntrusted`/`UNTRUSTED_DATA`-block convention for any new
    prompt-building function that interpolates such a value.
19. **A field whose validity depends on another field's value needs a discriminated union, not
    independently-optional fields.** (`reviewReason` only meaningful when `verdict` is
    `NEEDS_REVIEW`, etc.) Encode the dependency in the type so the invalid combination fails to
    compile.
20. **Text-matching and word-boundary logic must be Unicode-aware from the first draft** —
    `\p{L}\p{N}` classes and `.normalize('NFC')` by default whenever code touches label text,
    not `[a-z0-9]` and `.toLowerCase()`.
21. **A finding documented in `CHANGES.md` is not a finding recorded in the ledger.** Every
    message that can cause an agent to run `gate.sh` again — an initial brief, a merge-conflict
    follow-up, a "check for a new PR review" nudge — must say explicitly: record each local-CLI
    finding via `review-ledger.mjs record` *as you triage it*, not only in `CHANGES.md`. A prose
    paragraph doesn't get counted by `review-ledger.mjs report`.
22. **A hardened `pg.Pool` doesn't protect a second `new Pool(...)` created elsewhere.** Reuse
    the existing hardened client from `src/lib/db`. If a script genuinely needs its own
    short-lived pool, copy every hardened setting — the error listener,
    `connectionTimeoutMillis`, and `query_timeout` — not just the constructor call.
    `connectionTimeoutMillis` bounds only connection establishment; an established query
    needs `query_timeout` or it can hang forever (TRO-544 post-merge finding).
23. **An `AbortController` timeout must stay live through the whole request, including the body
    read** — `clearTimeout` in the `finally` after `fetch()` resolves, before `.json()` runs,
    leaves a hanging body parse with no timeout at all. Scope one timer across every `await` in
    the request, clear it only after the last one. (`resource-timeout`, 3 tickets — gate-check
    threshold crossed, not yet built: TRO-508.)
24. **A multi-step cleanup in a `finally` block must not let one step's failure skip the rest,
    and a cleanup failure must be visible** — caught into a named field the caller reports (exit
    code, logged artifact), never a bare `console.warn` with no effect on exit code.
    (`unhandled-error`, 2 tickets: TRO-456, TRO-471.)
25. **No auth or access-control exists anywhere in this app yet — that's LH-061/TRO-482's job**,
    an Urgent ticket with its own security-semantics escalation (escalation.md #7). Don't bolt
    one-off auth onto a single route in response to a review finding; it would be inconsistent
    with every other route and would preempt LH-061's real design. Dismiss with that reference.
    (`access-control`, 2 tickets: TRO-466, TRO-476.)
26. **UI copy must be specific and non-redundant.** A reason string names the exact field/check
    that failed ("Government Warning must print in capital letters", not "needs a closer
    look") — rule 12 already requires a reason; this is about that reason's precision. Alt text
    doesn't repeat what assistive tech already announces (not "The uploaded label photo" — a
    screen reader already says "image"). (`ux-copy`, 2 tickets: TRO-462, TRO-466.)

27. **After merging `origin/main` into a ticket branch, run `pnpm install` even when
    `package.json`/`pnpm-lock.yaml` auto-merge with no conflict markers.** A clean auto-merge
    still doesn't touch `node_modules` on disk — a dependency the merge pulled in from a
    sibling PR (e.g. a new package another ticket added) fails typecheck/build with "Cannot
    find module" until installed. Hit independently on two worktrees resolving the same
    origin/main merge; the third worktree resolving it got the same failure pre-empted only
    because this rule existed by then.

28. **Never background `gate.sh` (or anything else) and wait for its own completion
    notification.** Only the orchestrator's top-level shell receives background-task
    notifications — a sub-agent backgrounding its own process and then waiting gets no signal
    and simply stalls, with real committed work sitting unpushed. Run `gate.sh` in the
    foreground and wait for it to print an actual verdict line before doing anything else. Hit
    twice in one session (TRO-473, TRO-474) — both times the work itself was fine, safely
    committed, just never pushed or reported.
29. **A `try/catch` guards a synchronous throw, not automatically an async one.** Code that runs
    after the `catch` block, or inside a bare `Promise.all`, still needs its own guard — a
    rejected promise there propagates unhandled, or (in `Promise.all`) discards every other
    already-good result alongside it. Check every `await` after error-handling code has actually
    ended, not just the one the `try` block visibly wraps.
    (`unhandled-rejection`, 2 tickets: TRO-468, TRO-476.)
30. **A `test.skip()` is not automatically the "weaken a test to get green" the non-negotiable
    bans — check what it hides before treating the two as the same thing.** The rule exists to
    stop hiding a real bug or a real coverage gap behind a disabled test. It does not cover a
    skip whose condition is "this test's premise cannot exist here" — most concretely, a
    fake-external-service-only test hook (an injected failure trigger, a canned error mode) that
    has no live equivalent *by design*, because no real, security-conscious third-party API
    would ever let a caller force it to fail on demand. Losing that specific artificial trigger
    under a live-API run is not a coverage gap; the behavior it exists to test (e.g., does the
    UI actually recover on a real failure) must still be fully covered by the default/fake path
    the skip does not touch. Confirmed by Troy (TRO-479, 2026-08-12) after the agent correctly
    declined to decide this alone or route around the gate's `.skip(` detection with different
    syntax — same intent, different syntax, is still the thing the rule bans; an honest,
    narrowly-scoped, documented skip is not. When this pattern recurs, cite this rule rather
    than re-litigating the distinction from scratch: does the skip hide a real bug/gap (banned),
    or does it drop only a test-only mechanism with no legitimate real-world counterpart
    (not banned, but still narrow it and say so in `CHANGES.md`)?

31. **The gate's review step re-reviews the whole branch every run, including the previous
    round's own triage prose — findings regenerate forever, so triage runs to a stop rule,
    not to zero.** After a round whose findings change no shipped behavior and no factual
    claim, record every disposition and stop; do not fix-iterate prose, and do not re-run
    the gate just to re-review. (TRO-544: 13 rounds, 45 findings; real substance ended at
    round 12, and the last round was seven comment-shortening requests against stable files.)

## Mechanized (no longer prompt-dependent)

- `gate.sh` refuses (`exit 2`) on an uncommitted worktree before running anything (unless
  called with `--fast`) — a prior "agent's uncommitted work went ungated" failure mode is now
  enforced by tooling, not by asking agents to remember.
- Checkpoint tickets (CP-1/2/3): Linear's GitHub automation auto-completes an issue when an
  attached PR merges, even with no `Closes` line. A checkpoint ticket only actually clears on
  Troy's explicit acknowledgment — if a walkthrough-material PR merge flips it to Done first,
  that's the automation, not the checkpoint; revert the status and wait for the real
  acknowledgment.

## Open backlog

- **TRO-508**: nine review-finding categories (`correctness`, `prose-style`, `test-coverage`,
  `docs`, `boundary-validation`, `doc-consistency`, `false-positive-review`, `type-safety`,
  `resource-timeout`) have crossed the 3-ticket gate-check threshold with no mechanical check
  built. Run `review-ledger.mjs report` before every wave and act on new crossings instead of
  re-logging them here.
