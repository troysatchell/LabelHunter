# CLAUDE.md

This file provides guidance to Claude Code (or any coding agent) working in this repository.
It applies to every session — the interactive one and every factory sub-agent dispatched by
`.claude/skills/labelhunter-factory/`.

## What this repo is

LabelHunter: an AI-powered alcohol label verification prototype for a TTB (Alcohol and Tobacco
Tax and Trade Bureau) take-home interview. Real stakes, hard ~1-week deadline, live defense —
Troy must be able to personally explain every decision.

**Read before doing anything architectural:**
- `docs/PRD.md` — the settled architecture (Haiku→router→Sonnet cascade, exact-compare
  warning subsystem, 3-state verdicts, USWDS-adjacent UI). These are decisions, not options —
  implement them, don't redesign them.
- `audit/requirements/inventory.md` — TH-R1..R23, the graded requirements. Every ticket cites
  the TH-R IDs it advances; every acceptance-evidence line is a target, not a suggestion.
- `factory/config.yaml` — detected facts and policy decisions for this repo, each dated and
  marked as measured-fact or human-decision.

## Writing style — ASD-STE100 discipline, Zinsser's four principles

Every sentence Claude writes in this repo — code comments, commit messages, PR bodies,
`CHANGES.md` entries, README, `docs/approach.md`, error messages, and UI copy — follows two
stacked disciplines. They are not in tension: one gives structure, the other gives voice.

**This is not a stylistic preference.** TH-R3 requires a UI a 73-year-old first-time user can
operate with no instructions, and TH-R9 requires the government warning to be checked by
*exact, unambiguous* comparison against statutory text. A document that itself tolerates
ambiguity is the wrong document to be building a precision tool from.

### 1. ASD-STE100 (Simplified Technical English) discipline

Borrowed from the aerospace/defense controlled-language standard: remove the two biggest
sources of misreading — words with more than one meaning, and sentences with more than one
possible structure. Full skill: `asd-ste100` (invoke it on any paragraph that reads dense).

| Rule | Do | Don't |
|---|---|---|
| One word, one meaning | Pick one verb for one action and reuse it every time | Rotate synonyms for the same idea ("check"/"verify"/"confirm") |
| Active voice | "The router rejects the field." | "The field is rejected." |
| Simple tense | "The test failed." | "The test has failed." |
| One instruction per sentence | "Open the file. Read line 3." | "Open the file and read line 3, then check it." |
| Sentence length | ≤20 words for instructions, ≤25 for descriptions | Long compound/subordinate-clause sentences |
| Noun clusters | ≤3 words stacked ("fuel pump valve") | 4+ word stacks ("high pressure fuel pump inlet valve assembly") |
| No ellipsis | Keep subject, verb, article explicit | Drop words to save space and create ambiguity |
| Lists for sequences | Numbered/bulleted list for 3+ steps | A sequence buried inside one prose sentence |

Necessary domain terms (TTB, COLA, ABV, cascade, quarantine) stay — define once, use
consistently, never swap in a synonym partway through a document.

### 2. Zinsser's four principles (*On Writing Well*)

STE gives structure; these keep the result readable by a human, not just parseable by a
machine — the warmth a purely mechanical rewrite strips out.

1. **Simplicity.** Strip every sentence to its cleanest components. Cut the word that does no
   work. If a plain word says it, the fancy one is clutter.
2. **Brevity.** Short beats long. A sentence earns its length; it doesn't default to it.
3. **Clarity.** If a sentence can be misread, it will be. Think the thought through before
   writing it down — muddled prose usually means muddled thinking, not a phrasing problem.
4. **Humanity.** Write like one person talking to another. This is a compliance tool for real
   TTB agents (Sarah, Dave, Jenny) — the docs and the UI copy should sound like they respect
   the reader, not like a form letter.

**Where the two disciplines pull differently** (STE is deliberately flat; Zinsser allows more
voice in prose like `docs/approach.md`): keep STE's precision rules (one meaning per word,
active voice, short sentences) always. Let Zinsser's humanity show in word choice and rhythm,
not in reintroducing ambiguity.

**Scope:** this governs prose Claude authors. It does not mean renaming variables or
restructuring code to be "simple" for its own sake — see the general engineering guidelines
below for that line.

## The factory

This repo is worked by an autonomous ticket factory, not just ad hoc sessions.

- **Orchestrator skill:** `.claude/skills/labelhunter-factory/SKILL.md` — the full run loop,
  invoked with "run the factory". Read it before dispatching or gating anything.
- **Source of truth for tickets:** `factory/tickets.md`, mirrored to Linear team
  `Troysatchell`, **project `LabelHunter` only** — that workspace holds other unrelated
  projects; never dispatch outside this one.
- **Evidence gate:** `scripts/factory/gate.sh`. A ticket is done when the gate passes, CI is
  green, and the review is triaged — never on an agent's self-report.
- **Three unskippable human checkpoints** (CP-1 cascade router/prompts, CP-2 warning
  subsystem, CP-3 batch queue) block their waves in Linear. Final submission wording and the
  submit decision are always Troy's.

## Non-negotiables

- **DATABASE_URL discipline.** Every worktree gets its own database via
  `scripts/factory/worktree.sh`. Never run tests with `DATABASE_URL` unset or pointing
  anywhere but your worktree's own database — the schema is reset on every provision.
- **No secrets in the repo.** The Anthropic API key lives in Render env config and local
  `.env.local` (gitignored) only. `.env.local.example` documents the shape, never real values.
- **Never fabricate a number.** Latency, accuracy, and cost figures come from a real measured
  run or are written "not measured." This project is graded on honest evidence (PRD §6).
- **Claims carry provenance.** Mark observed vs. derived. "The migration applied" means you
  queried the database and saw the table — not that a command exited 0.
- **The cascade is the architecture, not an optimization** (TH-R19). Haiku extracts every
  label; Sonnet sees only escalations routed by an explicit `ReviewReason`. Never wire Sonnet
  into the per-label happy path.
- **Never weaken a test, or widen `factory/quarantine.json`, to get a gate green.** Only
  removing a quarantine entry because a test is genuinely fixed is legitimate.
- **Schema changes go in numbered migrations**, never a direct edit to an existing table's
  initial-setup SQL.

## Commands

Populated by the scaffold ticket (TRO-456); see `factory/config.yaml` → `detected.commands`
for the measured, verified set once it lands. Planned shape:

```bash
pnpm install
pnpm dev              # Next.js app + worker, DATABASE_URL from .env.local
pnpm typecheck
pnpm lint
pnpm build
pnpm test             # vitest, JSON reporter for the gate
pnpm test:e2e         # playwright
pnpm db:migrate
```
