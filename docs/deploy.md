# Deploy (TRO-481 / LH-060)

TH-R16 asks for one thing: a deployed URL an evaluator can open and test. This
document is the runbook for that deploy.

`render.yaml` (repo root) sets up the deploy automatically. It wires the web
service, the background worker, and the database, so a first deploy needs no
further code change. One step stays manual: Troy must give Render his real
Anthropic key by hand. Deploying that key to a third-party platform is a
hard stop — the factory does not do this on its own
(`.claude/skills/labelhunter-factory/references/escalation.md`, item 4). The
steps below cover that manual step, and nothing this repo can automate.

## What `render.yaml` automates

| Resource | Type | What it runs |
|---|---|---|
| `labelhunter-web` | `web` | `pnpm build`, then `pnpm start` (`next start`). Migrates the database first (`preDeployCommand: pnpm db:migrate`). Health check: `/api/health`. |
| `labelhunter-worker` | `worker` | `pnpm worker` (`scripts/batch-worker/run.ts`, LH-041/TRO-474) — the batch extract and resolve pools. |
| `labelhunter-db` | Postgres | Holds `applications`, `label_images`, `batch_jobs`, `verifications`, `field_results`, `review_queue` (PRD §3.6). |

Both services deploy from `main`, and only from a commit whose GitHub Actions
checks already passed (`autoDeployTrigger: checksPass`) — the same green-CI
bar this repo's merge policy already requires.

## Before you start

You need:

1. A Render account (Troy's own — this is the hard stop above).
2. This GitHub repo connected to that account (`github.com/troysatchell/LabelHunter`).
3. Your Anthropic API key, ready to paste. `render.yaml` never stores it — it
   marks it `sync: false`, Render's convention for "the operator fills this
   in by hand, once, in the dashboard."

## First deploy

1. In the Render dashboard, create a new **Blueprint** and point it at this
   repo's `main` branch. Render reads `render.yaml` and shows a preview of
   the three resources above before creating anything.
2. Apply it. Render prompts for every `sync: false` env var each service
   declares:
   - `ANTHROPIC_API_KEY` — paste the same real key on both `labelhunter-web`
     and `labelhunter-worker`. Both read it (the extractor and resolver run
     in each).
   - `GOOGLE_API_KEY` — only `labelhunter-web` asks for this one. It is safe
     to leave blank: no code the deployed app runs reads it (see "Known
     limitations" below).
3. Render builds and deploys both services, running `pnpm db:migrate` before
   `labelhunter-web` starts serving. Watch each service's own log tab for
   this first run.
4. Once `labelhunter-web` shows healthy, open its URL and confirm
   `<url>/api/health` returns `{"status":"ok", ...}`. This is the same path
   Render itself polls to decide the deploy is healthy.
5. Run the check TH-R16 actually asks for: open the app, submit one
   single-label verify (a golden-set image plus its application fields), and
   confirm a real verdict renders. Do this again after any deploy that
   touches the extractor, router, or warning subsystem.

After this first connection, every future push to `main` — including one
that only edits `render.yaml` itself — redeploys both services automatically.
No repeat of the steps above is needed.

## Tuning the worker without a redeploy

`labelhunter-worker`'s pool sizes (`BATCH_WORKER_CONCURRENCY`,
`BATCH_RESOLVE_WORKER_CONCURRENCY`, `BATCH_WORKER_SHUTDOWN_TIMEOUT_MS`) are
plain env vars in `render.yaml`, not secrets. Edit any of them directly in
the Render dashboard and restart the worker — no code change, no new deploy.
`scripts/batch-worker/run.ts`'s own header comment explains why this lever
exists: the real deployed Anthropic key's rate-limit tier was not measured
when these defaults were chosen.

## Rolling back

**This file.** `git revert` the TRO-481 commits on `main`. Render redeploys
the reverted `render.yaml` on the next push, same as any other change.

**A bad app deploy.** In the Render dashboard, open the service's Deploys
tab and redeploy a previous successful build. This does not undo a database
migration that already ran — Drizzle migrations are forward-only here, same
as every other ticket in this repo.

## Known limitations

Marked plainly so nobody mistakes a default for a verified fact.

- **Not verified: the live deploy itself.** Everything above this line is
  either read directly from Render's own documented Blueprint spec, or
  confirmed by running this repo's actual build and start commands locally
  (see the TRO-481 entry in `CHANGES.md`). No Render account was available
  to this ticket to run a real deploy end to end. Troy's first walk through
  the steps above is the real test.
- **Batch image storage now survives the web/worker split (TRO-518,
  fixed).** `src/server/storage/local-file-storage.ts` used to save an
  uploaded label image to a directory on disk — a directory that belonged
  to whichever single process wrote it. `labelhunter-web` and
  `labelhunter-worker` are two separate Render services with two separate
  disks, so `labelhunter-worker` could never read back an image
  `labelhunter-web` saved. `db-image-storage.ts` replaces that module:
  `saveLabelImage`/`readLabelImage` now write and read through
  `label_image_blobs`, a Postgres table both services already reach
  through the one `DATABASE_URL` `render.yaml` gives them — no new
  external dependency, no new credential, no new account. See
  `CHANGES.md`'s TRO-518 entry for the full option A (Postgres) vs.
  option B (S3-compatible bucket) comparison and the size/scale/quota
  numbers behind picking A.

  **Not verified: a real batch run against two actually-deployed Render
  services.** TRO-518's own test suite proves two INDEPENDENT database
  connections (two separate `pg.Pool`s against the same `DATABASE_URL`,
  never two references to one shared pool) read back what one wrote —
  the property that matters here, since `web` and `worker` share nothing
  but that connection string. No Render account was available to run an
  actual batch against two real deployed services end to end.
  `scripts/golden/batchFixture.ts` builds a small, cheap batch upload from
  the golden set for exactly that check, once a real deploy exists
  (TRO-483) — run it and confirm every item completes, not just that the
  job starts.
- **Plan tiers are a default, not a Troy-confirmed budget decision.**
  `render.yaml`'s own comment explains the reasoning (a `worker` service has
  no free tier at all; a free Postgres database expires in 30 days). Change
  `plan:` in the file, or in the dashboard, if that default is wrong for
  your budget.
- **A deploy that adds a migration has a narrow ordering gap.** Render
  deploys `labelhunter-web` and `labelhunter-worker` independently. Nothing
  in `render.yaml` guarantees `labelhunter-web`'s `preDeployCommand`
  (`pnpm db:migrate`) finishes before `labelhunter-worker` starts polling
  for work on the same deploy. Render's Blueprint spec has no documented
  field for "wait for this other service's deploy step first" — this is not
  a setting this ticket left off, it is not one Render currently offers. On
  a deploy with no schema change, this never matters. On a deploy that adds
  one, a worker that starts first could query a table or column the
  migration has not added yet. `run.ts`'s own error handling does not crash
  the worker on a single failed claim (`onLoopError` logs it and the pool
  keeps polling), so a real failure here should read as a handful of logged
  errors during the deploy window, not a stuck worker — derived from
  reading that handler, not measured against a real migration race. Closing
  this gap needs either a migration step Render can run once, ahead of
  both services (Render has no such primitive today), or a worker-side
  readiness check that holds claims until the schema is current. Neither is
  built here.

## Reference

- `render.yaml` — the Blueprint itself, repo root.
- `scripts/deploy/render-yaml.test.ts` — regression test for its shape: every
  build/start/migrate command matches a real `package.json` script, and every
  secret-shaped env var is `sync: false` with no literal value.
- `.env.local.example` — the full list of environment variables a plain
  local checkout needs, with the same names `render.yaml` references.
