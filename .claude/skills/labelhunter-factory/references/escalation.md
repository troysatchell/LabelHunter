# Escalation: when the factory stops for Troy

The operating instruction is **keep working; stop only at defined gates**. That only works if
the gates are defined in advance — otherwise it collapses into asking about everything or
about nothing.

## Do NOT stop for these — decide and continue

- A gate failure inside the retry cap. Read the output, fix, re-run.
- Choosing between implementations equivalent in observable behaviour.
- Writing the test, the `CHANGES.md` entry, the PR body, the walkthrough docs.
- Review findings — triage them (`triage.md`). Filing a new ticket is not an escalation.
- Which ticket to take next, when the ordering rules already decide it.
- Ordinary ambiguity a careful engineer resolves by reading the PRD or the code.
- "Should I keep going?" — yes. Between tickets, continue.

## STOP — human gate

### 1. The three PRD checkpoints (CP-1, CP-2, CP-3) — the defining gates of this factory
Blocking and unskippable, per Troy's standing preference (PRD §10):

| Gate | Blocks | Walkthrough covers |
|---|---|---|
| **CP-1** | cascade router + prompt tickets | Haiku extraction prompt/schema, confidence thresholds, ReviewReason routing rules, Sonnet resolver prompt |
| **CP-2** | warning-subsystem tickets | canonical text sourcing, OCR choice, normalization rules, exact-compare, bold/caps handling + limitation wording |
| **CP-3** | batch queue + worker tickets | queue design, concurrency, rate-limit strategy, partial-failure semantics |

Each checkpoint = prepare a 30–60 min walkthrough **plus a "defend it" Q&A** (this is interview
rehearsal — Troy must be able to defend every decision live), notify Troy, wait for **explicit
acknowledgment**. The word of an earlier session, a summary of a plan, or silence is not
acknowledgment. Overnight runs never cross an unacknowledged checkpoint.

### 2. The submission gate — always Troy
Final README and approach-doc wording, and the decision to submit. The factory prepares the
artifacts and the requirements-audit sweep; Troy ships.

### 3. Spend
Projected build+eval LLM spend crossing **$25** (config `policy.spendCap`). Pause dispatching,
report the number and its basis, and wait. (Default from PRD §11 — unconfirmed; treat as firm
until Troy says otherwise.)

### 4. Credentials, secrets, or outward-facing creation
The Anthropic API key for deploy, Render account setup, **creating and first-pushing the
GitHub repo** (TH-R13 — it will be evaluator-visible), installing CodeRabbit, sharing the repo
with evaluators. The factory cannot complete these and should not try.

### 5. Irreversible actions
Dropping tables/columns with data, deleting tracked files beyond a ticket's scope, force-push,
history rewrites, deleting the Render service. Approval does not carry forward — confirm every
time.

### 6. Changes to what evaluators will see, beyond the PRD's design
The PRD's UX decisions are settled and implementable without asking. But a *deviation* from
them — cutting a committed feature (§2's scope ladder is Troy's cut order, invoked only by
him), changing the verdict model, altering the access-code scheme — is Troy's call.

### 7. Security semantics
The access-code gate, rate limits, the daily budget guard (PRD §8). These protect Troy's API
key on a public URL; a subtle mistake is expensive. Human read before merge.

### 8. Three failed gates on one ticket
`blocked` in Linear with the gate output and your best read. Move on; do not raise the cap.

### 9. The ticket is wrong
Premise does not hold, requirement already satisfied, PRD internally contradicts. Report the
disconfirming evidence; do not quietly close or invent work.

### 10. Scope explosion
More than ~40 files or a cross-cutting refactor for "one ticket" — the boundary is wrong or
the fix is a project. Re-scope with Troy.

### 11. A measurement that will not reproduce
Latency numbers that swing with machine load, an eval delta whose conditions can't match the
recorded baseline. Report what is missing rather than shipping a number whose conditions
differ — **never fabricate the demo numbers** (PRD §6).

## How to escalate without stalling the factory

Escalation blocks **that ticket**, not the run. Mark it, move to the next eligible ticket, and
keep going. Batch the questions so Troy answers a queue in one sitting; give each your
recommendation and the cost of choosing wrong. Not a menu with no recommendation.
