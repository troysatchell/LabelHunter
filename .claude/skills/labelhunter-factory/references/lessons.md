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
18. **Any string that passed through the label image, the application form, or a model's own
    prior output is adversarial input, in every prompt it reaches** — not just the first one
    reviewed. Use the extractor prompt's `serializeUntrusted`/`UNTRUSTED_DATA`-block convention
    for any new prompt-building function that interpolates such a value.
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
    short-lived pool, copy both settings (the error listener, `connectionTimeoutMillis`), not
    just the constructor call.
23. **An `AbortController` timeout must stay live through the whole request, including the body
    read** — `clearTimeout` in the `finally` after `fetch()` resolves, before `.json()` runs,
    leaves a hanging body parse with no timeout at all. Scope one timer across every `await` in
    the request, clear it only after the last one. (`resource-timeout`, 3 tickets — gate-check
    threshold crossed, not yet built: TRO-508.)

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
