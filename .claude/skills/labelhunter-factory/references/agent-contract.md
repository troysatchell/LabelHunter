# The coding sub-agent contract

Fill this in and hand it to the agent verbatim. Substitute `{{...}}`. Append the current
contents of `lessons.md` under *Standing rules*, then the ticket's PRD section(s) and the full
text of every TH-R entry it advances (from `audit/requirements/inventory.md`).

---

## Brief

You are implementing one LabelHunter ticket — or, where the orchestrator has batched tickets
sharing a root cause, the whole batch on one branch. Nothing outside it.

**Tickets:** {{TICKET_IDS}} — {{TICKET_TITLES}}
**Requirements advanced:** {{TH_R_IDS}} (full text appended below — these are what your work is
graded against; the acceptance evidence lines are your targets)
**Worktree:** `{{WORKTREE_PATH}}` — already provisioned. Work only here.
**Branch:** `{{BRANCH}}` — already checked out. Do not switch branches.
**Database:** yours exclusively; `DATABASE_URL` is in `.factory-env`. `source .factory-env`
first.

### Start by reading

1. The ticket body and its PRD section(s) — the PRD's architecture decisions (cascade shape,
   ReviewReason enum, exact-compare warning, USWDS-adjacent aesthetic) are **settled**; do not
   redesign them, implement them.
2. The TH-R entries appended below — each has an `Acceptance evidence` line; that is the bar.
3. `CHANGES.md` conventions and the repo's existing code style.

### What you must produce

1. **The implementation.** Smallest change that satisfies the ticket. If the ticket's premise
   turns out to be wrong, say so with evidence — do not implement a wrong design because it
   was written down.
2. **Tests written first for router/normalizer/comparator work** (PRD §6 mandates TDD there —
   pure functions, named cases like STONE'S THROW and the title-case warning), and **a
   regression/acceptance test for everything else that fails before your change and passes
   after.** Confirm it fails for the *right reason*. It must live in a `*.test.ts(x)` file the
   unit run executes — an e2e-only spec satisfies the gate's grep while never running.
3. **A `CHANGES.md` entry** naming {{TICKET_ID}}: what changed, how to run it, how to roll it
   back.
4. **Commits with real messages.** Conventional prefixes, one logical change per commit.

### Rules you may not break

- **Never weaken a test to get green.** No `.skip`, no `.todo`, no deleted assertions, no
  widening `factory/quarantine.json`. The gate checks your diff for all of these.
- **Never touch files outside the ticket's scope.** Drive-bys become new tickets — report them.
- **Never run tests with `DATABASE_URL` unset or pointing anywhere but your worktree DB.**
- **No secrets anywhere in the tree.** API keys live in env config only (TH-R6).
- **No fabricated numbers.** Latency, accuracy, cost figures shown anywhere must come from a
  real measured run (PRD §6). If you cannot measure it, write "not measured".
- **Model calls follow the PRD:** Haiku (`claude-haiku-4-5`) extracts, Sonnet
  (`claude-sonnet-5`) resolves escalations only. Never wire Sonnet into the per-label happy
  path — the cascade *is* the architecture (TH-R19).

### Claim provenance

In your report and PR body, mark **observed** vs **derived** vs **not verified**. State the
configuration every check ran under. A pass under a config that skips the broken path proves
nothing.

### Working style

**Keep going.** Do not stop to ask whether to continue or which equivalent approach to pick.
Run `scripts/factory/gate.sh --fast` as your inner loop and fix what it reports.

Stop and report **only** if: the ticket does not reproduce / its premise is wrong; the work
needs credentials, a browser login, a deploy secret, or an irreversible action; it changes
what the PRD says users see; it touches the access-code/rate-limit/budget protections; or it
has clearly outgrown one ticket. These go to the orchestrator's escalation queue — the run
continues elsewhere.

### Definition of done for you

`scripts/factory/gate.sh` verdict `pass`, run from your worktree. The orchestrator re-runs it
independently; your self-report is a claim, that run is the result.

### Your final message

- What you built and the load-bearing decisions (`file:line`).
- The TH-R IDs advanced, each with the evidence that its acceptance line is now satisfiable.
- The regression test path, and confirmation you saw it fail first for the right reason.
- Gate result.
- Anything you could not verify, and what verifying it would take.
- Any *new* problem you noticed but did not fix — described precisely; it becomes a ticket.

---

## PR body template

```markdown
## {{TICKET_IDS}} — {{TITLES}}

<!-- One `Closes` line PER ticket — GitHub only auto-closes what it sees named. -->
Closes {{TICKET_ID_1}}. Advances {{TH_R_IDS_1}}.

### What this builds
{{the change, and the design decision it implements}}

### Evidence
| Check | Result | Ran under |
|---|---|---|
| Regression test | {{path}} — red before, green after | {{command}} |
| Gate | {{verdict}} | `scripts/factory/gate.sh` |
| Measurement | {{before → after, or "n/a — no measurable target"}} | {{conditions}} |

**Observed:** {{what was actually run and seen}}
**Derived:** {{what is inferred, and from what}}
**Not verified:** {{what this PR does not establish}}

### Rollback
{{how to undo}}
```
