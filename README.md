# LabelHunter

LabelHunter is a prototype that helps a TTB compliance agent verify an alcohol label against
its application. Upload a label image and the matching application data. LabelHunter reads the
label. It checks each field against the application. It reports a match or mismatch for five
fields: brand name, class/type, alcohol content, net contents, and the government warning
statement.

A human agent makes the final call on anything the tool flags. LabelHunter narrows the search.
It does not replace judgment.

Built for a TTB take-home interview brief. `docs/approach.md` covers the design reasoning,
tools, assumptions, and trade-offs in full.

## Try it

**Deployed URL:** not yet published here.

The app deploys to `https://labelhunter-web.onrender.com`. This README does not link it as a
usable evaluation target yet. [PR #43](https://github.com/troysatchell/LabelHunter/pull/43) —
the access-code gate, rate limits, and daily spend budget — has not merged. Until it merges,
the deployed instance has no protection against uninvited use. It also makes real, billed
calls to the Anthropic API. Once PR #43 merges, this section carries the URL and the access
code.

Until then, run LabelHunter locally with the steps below.

## Prerequisites

- Node.js 22 or later
- pnpm 10.27.0 (`corepack enable` picks up the version this repo pins in `package.json`)
- Docker, to run a local Postgres container
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com)) — required for
  the Haiku extractor and Sonnet resolver

## Setup

1. Clone the repo and install dependencies.

   ```bash
   git clone https://github.com/troysatchell/LabelHunter.git
   cd LabelHunter
   pnpm install
   ```

2. Start a local Postgres container.

   ```bash
   docker run --name labelhunter-pg \
     -e POSTGRES_USER=labelhunter \
     -e POSTGRES_PASSWORD=labelhunter_dev_password \
     -e POSTGRES_DB=labelhunter_dev \
     -p 5432:5432 -d postgres:16-alpine
   ```

3. Copy the environment file.

   ```bash
   cp .env.local.example .env.local
   ```

   Open `.env.local` and set `ANTHROPIC_API_KEY`. Leave `DATABASE_URL` as it is — it already
   matches the container above. Leave `GOOGLE_API_KEY` blank. The running app never reads it
   (see "What LabelHunter does not call" below).

4. Run the database migrations.

   ```bash
   pnpm db:migrate
   ```

5. Start the app.

   ```bash
   pnpm dev
   ```

   Open `http://localhost:3000`.

## Running the tests

```bash
pnpm typecheck   # TypeScript, no emit
pnpm lint        # ESLint
pnpm test        # Vitest — unit and integration, no live API calls
pnpm test:e2e    # Playwright — end-to-end, runs against a fake Anthropic server by default
pnpm build       # production build
```

`pnpm test` and `pnpm test:e2e` both need `DATABASE_URL` pointed at a real Postgres database.
The local container above is enough. Neither command calls the real Anthropic API — both use
golden test-label fixtures and a fake model server instead. Two commands make real, billed API
calls and are not part of the default test run: `pnpm eval:check -- --live` and
`pnpm latency:check`. Run them by hand only if you want a fresh accuracy or latency
measurement.

## How it works

LabelHunter reads a label with a cost-tiered cascade instead of running one expensive model
call on every image:

```
Upload (single label or batch)
   ↓
Image preprocessing (rotation, resizing, a crop of the government warning block)
   ↓
Haiku Extractor          — reads every field off the label image
   ↓
Validation Router        — deterministic code, no model call, compares extraction to application
   ├── PASS    → done, verdict recorded
   ├── REVIEW  → Sonnet Resolver looks at the flagged field and the reason
   └── INVALID → Sonnet Resolver re-extracts and resolves
                     ↓
              resolved or needs-human → review queue
```

Every label goes through Haiku first. Only the labels the router flags go to Sonnet. The
router flags three kinds of cases: an ambiguous field, a low-confidence read, or a possible
mismatch. Most labels resolve on Haiku alone. This keeps the common case fast and cheap. The
cases that need it still get a stronger model's judgment. `docs/approach.md` explains why this
design beats a single-model pipeline, with measured cost and accuracy numbers.

The government warning has its own, stricter check. TTB's brief requires a word-for-word match
against the statutory warning text. The other fields use a judgment-based comparison instead.
LabelHunter reads the warning block through two independent channels: a vision read and OCR.
It calls a verdict only when both channels agree. When they disagree, it flags the case for a
human instead. `docs/approach.md` has the full design.

### Model usage and cost

| Role | Model | Approximate cost per label |
|---|---|---|
| Extractor (every label) | `claude-haiku-4-5` | ~$0.005 |
| Resolver (escalated labels only) | `claude-sonnet-5` | ~$0.02, on roughly the fraction of labels the router escalates |

`docs/approach.md` and `scripts/eval/results/` hold the measured figures: extraction accuracy,
verdict accuracy, cost per label, and a cascade-vs-single-model comparison.

## What LabelHunter stores, and does not store

- **Only label and application fields.** The database holds what's on the label and what's on
  the application: brand name, class/type, alcohol content, net contents, government warning
  text, and a beverage-type selector. No applicant name, address, or other personally
  identifying information is ever stored.
- **No reviewer identity.** When a human agent approves or rejects a flagged item, the database
  records the decision. It does not record who made the decision. This is a deliberate design
  choice, not an oversight.
- **The Anthropic API key never enters the repo.** It lives in `.env.local`, which is
  git-ignored. Once deployed, it also lives in Render's environment configuration.
- **Access control is in progress.** A shared access-code gate, per-IP and global rate limits,
  and a daily spend budget are ready and in review
  ([PR #43](https://github.com/troysatchell/LabelHunter/pull/43)). None of it has merged yet.
  Until it does, treat any deployed instance of this app as unprotected.

## What LabelHunter does not call

LabelHunter makes exactly one outbound call to a public vendor API while it runs: the
Anthropic API, for label extraction and resolution. Its own Postgres database is a private,
same-network dependency, not a public vendor endpoint. A `GOOGLE_API_KEY` variable exists in
`.env.local.example` for one reason: generating the test-label image set during development
(`pnpm golden:build`). The deployed, running app never reads it. See `docs/error-states.md`
for the full dependency table and what happens if the Anthropic endpoint is unreachable.

## Repository layout

- `src/app/` — Next.js routes and UI components
- `src/server/` — extraction, validation router, comparators, the warning subsystem, batch
  queue
- `src/lib/db/` — Drizzle schema and database access
- `golden-set/` — the committed test-label image set and its ground truth
- `scripts/` — evaluation, latency measurement, and deployment tooling
- `docs/` — architecture (`PRD.md`), approach and trade-offs (`approach.md`), error states,
  deployment runbook
- `audit/requirements/` — the requirements-traceability sweep, mapping this brief's
  requirements to the code and tickets that satisfy them

## Deploying your own instance

See `docs/deploy.md` for the full runbook. In short: `render.yaml` at the repo root defines a
Render Blueprint (a web service, a background worker, and a Postgres database). Connect this
repo to a Render account. Create a Blueprint from `main`. Paste in your own Anthropic key.
Render never stores it in the repo.
