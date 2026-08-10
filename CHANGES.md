# Changes

Per-ticket changelog. Every factory PR adds an entry at the top naming its ticket ID(s):
what changed, how to run it, how to roll it back. The gate greps for the ticket ID with
anchored boundaries — `TRO-30` will not match inside `TRO-301`.

## TRO-458 — Align spec schema with the approved image-gen design (2026-08-10)

**What changed.** Troy approved a render-first hybrid design for golden-set images
(`docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md`) and rescoped this
ticket to core-only (degradations → LH-004, Imagen → LH-005, verify gate → LH-006). Per the
ticket's note, aligned the spec schema with design §3 before merging:
- Added `provenance` (`rendered | rendered+degraded | ai-generated`), `verified` (boolean),
  and `vectors` (`audit/rubric.md` Appendix A, V1–V10) to `GoldenSetCase` and to every one of
  the 29 committed cases.
- Loader now enforces `provenance: "ai-generated"` requires `verified: true` — an AI-generated
  image can silently fail to render the exact text its spec claims; the eval harness must not
  trust one until a human confirms it.
- Mapped every case to the rubric vector(s) it evidences and found a real, previously-invisible
  gap: **V7** (net-contents format match, `"750 mL"` vs `"750ml"`) has no covering case. Added
  a test that asserts this gap explicitly (`loader.test.ts`) so it can't silently reappear once
  closed, and documented it in `golden-set/README.md` rather than quietly patching around it.
- 8 new regression tests (unknown provenance, unknown vector, unverified ai-generated case
  rejected, verified one accepted, vector-coverage assertion, ai-generated-implies-verified
  assertion on the real manifest).

**Still not done — the renderer itself.** This ticket's scope was the schema; producing actual
pixels is LH-003's remaining work (or a split-off), tracked against the design doc's §2
component list (`render.ts`/`degrade.ts`/`imagen.ts`/`verify.ts`/`build.ts`). `golden-set/images/`
is still empty.

**How to run it.** `pnpm test -- src/lib/golden-set` — 26 tests, up from 12.

**Rollback.** `git revert` this commit; the manifest and loader return to the pre-alignment
shape (still valid, just missing `provenance`/`verified`/`vectors`).

## TRO-458 — LH-003: Golden set v1 — ground-truth schema, manifest, loader (2026-08-10)

**What changed.** Ground-truth data and tooling for the golden set (TH-R12), scoped to the
parts that do not need an image-generation tool:

- **Ground-truth schema** (`src/lib/golden-set/types.ts`): a `GoldenSetCase` type covering
  the five example fields on both the application and the label (PRD §2, TH-R11), the
  Validation Router's expected per-field and label-level verdicts, and the `ReviewReason`
  enum (PRD §3.3).
- **Manifest** (`golden-set/manifest.json`): 29 complete ground-truth cases across all 12
  required test categories (PRD §6) — clean match (4), ABV mismatch (3), title-case warning
  (2), reworded warning (2), missing warning (2), case-variant brand (3), glare (2), rotation
  (2), low light (2), tiny warning text (2), odd typography (2), conflicting
  application-vs-label data (3). Includes the two named brief examples: `STONE'S THROW` vs
  `Stone's Throw` (TH-R8, `case-14-case-variant-brand-stones-throw`) and Jenny Park's
  title-case catch (TH-R9, `case-08-title-case-warning-prefix-only`).
- **Loader + validator** (`src/lib/golden-set/loader.ts`, TDD'd in
  `loader.test.ts`): `loadGoldenSetManifest()` reads and validates
  `golden-set/manifest.json`; `validateManifest()` checks the shape and collects every
  problem in one pass — missing fields, wrong types, an unknown category, a `reviewReason`
  that doesn't match the label verdict, an `imagePath` whose filename doesn't match its
  `caseId`, and duplicate case IDs. 12 test cases; confirmed red (missing module) before
  `loader.ts` existed, green after.
- **`golden-set/README.md`**: the manifest format, the image naming convention
  (`golden-set/images/<caseId>.jpg`), and the known gap below.

**Known gap, stated plainly: no label images.** `golden-set/images/` is empty. Every
`imagePath` in the manifest names a file that does not exist. Generating 29 label images
needs an AI image-generation tool or a camera; this ticket's agent had neither, and a
placeholder file with a `.jpg` extension would silently pass a file-existence check while
being useless for testing — worse than an honest gap. A follow-up ticket (LH-021 depends on
this landing) must generate or source each image at the path its case already names; the
case's `label` field is the spec for what the image must show.

**How to run it.** `pnpm test -- src/lib/golden-set` runs the loader tests directly. Load the
manifest from application code with `loadGoldenSetManifest()` (no arguments needed — it
resolves `golden-set/manifest.json` relative to the repo root).

**Rollback.** `git revert` this ticket's commits. Nothing outside `golden-set/` and
`src/lib/golden-set/` depends on this yet.

## FACTORY — merge-changes.mjs (2026-08-10)

**What changed.** Three tickets in a row (TRO-456 twice, TRO-457) hit the same `CHANGES.md`
merge conflict — every branch adds an entry at the top, so every concurrent merge collides on
the same lines. Per the recurrence-ladder rule in `references/lessons.md` ("3 = build the
mechanical fix"), added `scripts/factory/merge-changes.mjs --check`: parses the file into
whole entries (never line-by-line), checks per-entry fence balance, duplicate headings, and
(with `--expect TICKET`) that a specific ticket's entry survived intact. Wired into `gate.sh`
G7 alongside the existing ticket-ID grep. Negative-tested: a synthetic file with a spliced
fence and one with a duplicated heading both correctly fail; a well-formed file passes.

**How to run it.** `node scripts/factory/merge-changes.mjs --check CHANGES.md` (add
`--expect TRO-nnn` to also confirm one ticket's entry). Runs automatically as part of the gate.

**Rollback.** `git revert` this commit; G7 falls back to the grep-only check.

## TRO-456 — PR review round 2: CodeRabbit findings, 4 fixed (2026-08-10)

**What changed.** GitHub-App CodeRabbit reviewed PR #1 and requested changes. All four inline
findings were real defects in code this PR added; all four are fixed here.
- `playwright.config.ts` (major): read `PORT`/`APP_PORT` straight from `process.env` with no
  `.env.local` loader. A factory worktree works by accident (`.factory-env` exports the
  variable into the shell); a plain checkout following this PR's own "How to run it"
  instructions would silently fall back to port 3000. Added the same `dotenv` load
  `drizzle.config.ts` already uses.
- `src/lib/db/index.ts` (major): the `pg.Pool` had no `error` listener. An idle client that
  loses its connection emits `error` on the pool; with nothing listening, Node treats it as
  unhandled and can crash the process. Added a listener that logs and lets the pool recover.
- `src/lib/db/index.ts` (trivial): `connectionTimeoutMillis` defaulted to 0 (no timeout) on an
  unreachable database. Set to 10s.
- `src/lib/utils/format.ts` (minor): the third rounding-boundary bug in this function — `999.5`
  rounded to `"1000ms"` while `formatDuration(1000)` itself renders `"1.00s"`, because the
  millisecond branch decided its unit on the unrounded value. Rounds once now, before any
  branch. A standing lesson on this pattern is in `references/lessons.md`.

**How to run it.** `pnpm test` — one new case (`formatDuration(999.5)`). No other setup change.

**Rollback.** `git revert` this commit; each fix is independent of the others and of the
original scaffold commits.

## TRO-456 — LH-001: Scaffold Next.js + TS + Vitest + Playwright + Drizzle + CI (2026-08-10)

**What changed.** Stood up the working application scaffold (TH-R13, TH-R18, TH-R19) that
every later LabelHunter ticket builds on:
- **App shell:** Next.js 16 (App Router, TypeScript, strict mode) under `src/app/`, with a
  placeholder home page and a DB-free liveness route at `src/app/api/health`.
- **Toolchain:** pnpm (`packageManager` pinned), Node >=22. `pnpm typecheck` (`tsc --noEmit`),
  `pnpm lint` (real flat-config ESLint — `eslint.config.mjs`, Next's recommended rules +
  `@typescript-eslint`, plus two project rules: no `any`, no unused vars — verified it
  actually catches violations, not a vacuous config), `pnpm build` (`next build`).
- **Tests:** Vitest (`vitest.config.ts`) with one real unit test suite
  (`src/lib/utils/format.test.ts`, 4 cases) proving the runner executes real code. Playwright
  (`playwright.config.ts`) with one e2e spec (`e2e/health.spec.ts`) that builds, boots the app,
  and asserts a 200 from `/api/health`.
- **Database:** Drizzle + `pg`, `drizzle.config.ts`, a scaffold-only `_meta` table
  (`src/lib/db/schema.ts`) and its generated migration (`drizzle/migrations/0000_meta_healthcheck.sql`).
  `pnpm db:generate` / `pnpm db:migrate` (`drizzle-kit generate` / `drizzle-kit migrate`).
  Migration applied to and verified against this worktree's own Postgres database (queried
  directly, not just exit-code-trusted). Ticket LH-002 (TRO-457) extends `schema.ts` with the
  real product tables.
- **Repo layout for later tickets:** `src/server/{router,extractor,resolver,warning}/` and
  `src/worker/` reserved (each has a `.gitkeep` naming the ticket that owns it) per PRD §3.6 —
  no subsystem logic implemented here.
- **`.env.local.example`** documents the required env vars for a plain clone (`DATABASE_URL`,
  `PORT`, and the not-yet-wired `ANTHROPIC_API_KEY`).

**A real toolchain bug found and fixed, in scope for this ticket:** `pnpm run <script> --
<args>` forwards the literal `--` token into the script's argv (unlike `npm`, which strips
it). Vitest's CLI then treats that leading `--` as "everything after this is a positional
test-name filter," so `--reporter=json --outputFile=<path>` — exactly how `scripts/factory/gate.sh`
and `.github/workflows/ci.yml` invoke `pnpm test` — is silently ignored: tests still run, but
no JSON report is ever written. Fixed by routing the `test` script through
`scripts/run-tests.cjs`, a small wrapper that strips one leading `--` before handing argv to
vitest. Confirmed the exact gate invocation (`pnpm test -- --reporter=json
--outputFile=<absolute path>`) now writes a valid report. The same pnpm quirk broke
`pnpm start -- -p <port>` in `playwright.config.ts`'s `webServer.command`; fixed by passing the
port via the `env` option instead (`next start`/`next dev` both honor `PORT`).

**How to run it.** `pnpm install`, then `cp .env.local.example .env.local` and point
`DATABASE_URL` at a running Postgres (or, in a factory worktree, `source .factory-env` — it's
already provisioned). `pnpm db:migrate` to apply migrations, then `pnpm dev` (or `pnpm build &&
pnpm start`) to run the app. `pnpm test` for unit tests, `pnpm test:e2e` for Playwright,
`pnpm typecheck` / `pnpm lint` / `pnpm build` for the rest of the gate.

**Rollback.** `git revert` this ticket's commits on `feat/lh-scaffold` (or delete the branch
before merge). No product code depends on this yet — reverting only removes the scaffold
itself. The worktree's database (`labelhunter_wt_tro_456`) can be dropped and recreated; the
`_meta` table is scaffold-only and holds no data of consequence.

**Known limits / not done here (see final ticket report for detail).** The broader gate
self-verification suite named in `factory/config.yaml`'s `verification:` block (no-op branch
fails, forged break-one/fix-one caught, quarantine-not-widenable-from-branch, `worktree.sh`
run twice in a row, a real CI run on an opened PR) was **not** run from this ticket — it needs
the orchestrator (this agent was told not to edit `factory/config.yaml`, `scripts/factory/gate.sh`,
or `.github/workflows/ci.yml`). This ticket ran `scripts/factory/gate.sh` (no flags) itself and
reports that verdict verbatim.

**Gate bug found, not fixed here (out of scope — see final ticket report).**
`scripts/factory/gate.sh`'s lint-detection line (`if ls eslint.config.* .eslintrc* ...`)
always reports `lint: skip` for a project using only one of the two config styles — `ls`
exits non-zero if *either* glob has no match, even when the other matched a real file. This
repo ships a real, working flat config (`eslint.config.mjs`, verified below) but the gate
still shows `skip`. Not edited per this ticket's instructions (gate.sh is the orchestrator's
file); flagging for a fix there.

**CodeRabbit review triage (3 findings, all addressed or explicitly skipped):**
- `src/lib/utils/format.ts` (minor): `formatDuration` could render `119.6s` as `"1m 60s"`
  instead of `"2m 0s"` (rounding minutes/seconds separately let the remainder hit 60). Fixed —
  round the total once, then derive minutes/remainder from that. Added a regression case.
- `src/app/api/health/route.ts` (trivial): add `Cache-Control: no-store` so a proxy/CDN never
  caches a stale liveness result. Fixed; e2e spec now asserts the header.
- `drizzle/migrations/0000_meta_healthcheck.sql` (trivial): suggested `bigint identity` instead
  of `serial` for `_meta.id`. Skipped — `_meta` is a scaffold-only healthcheck table that LH-002
  replaces with the real schema; not worth a churn migration for a table this ticket doesn't
  expect to survive past the next one.

## FACTORY — gate.sh lint-detection fix (2026-08-10)

**What changed.** `scripts/factory/gate.sh`'s lint-config check used
`ls eslint.config.* .eslintrc*`, which fails if *either* glob has no match — so a repo with
only `eslint.config.mjs` (no `.eslintrc*`) always read as "no config found" and G2 stayed
`skip` forever, even with a real, working lint config in place. Found by the TRO-456 scaffold
agent while gating its own branch. Fixed with `compgen -G`, which tests each pattern on its
own.

**How to run it.** No action needed; the next `scripts/factory/gate.sh` run picks it up.

**Rollback.** `git revert` this commit; the check reverts to always-skip, which is safe
(under-detection, not over-detection) but wrong.

## FACTORY — CLAUDE.md and writing-style rules (2026-08-10)

**What changed.** Added `CLAUDE.md` at the repo root. It orients any agent to the PRD, the
requirements inventory, and the factory. It sets one writing rule for all prose Claude writes
here: follow ASD-STE100 (one meaning per word, active voice, short sentences) and Zinsser's
four principles (simplicity, brevity, clarity, humanity). Updated
`.claude/skills/labelhunter-factory/references/agent-contract.md` to list `CLAUDE.md` as the
first required read, matching the reference factory's own pattern.

**How to run it.** Nothing to run. Every future agent session reads `CLAUDE.md` first.

**Rollback.** Delete `CLAUDE.md`; revert the one-line addition to `agent-contract.md`.

## FACTORY — labelhunter factory build (2026-08-10)

**What changed.** Stood up the ticket factory: `factory/` (config, quarantine baseline,
scorecard, review ledger), `scripts/factory/` (gate, worktree provisioner, testdiff,
review-ledger, status), the `labelhunter-factory` orchestrator skill with its references
(agent contract, escalation incl. CP-1/2/3, triage, lessons), CI workflow, and the ticket
decomposition in `factory/tickets.md` mirrored to Linear project **LabelHunter**.

**How to run it.** `node scripts/factory/status.mjs` for state;
`scripts/factory/worktree.sh TRO-<n> <branch>` to provision;
`scripts/factory/gate.sh` inside a worktree to gate. The orchestrator loop is
`.claude/skills/labelhunter-factory/SKILL.md`.

**Rollback.** Delete `factory/`, `scripts/factory/`, `.claude/skills/labelhunter-factory/`,
and `.github/workflows/ci.yml`; archive the Linear project. No application code is touched —
none exists yet.

**Known limits.** The gate is UNVERIFIED pre-scaffold (`factory/config.yaml` → `verification`);
nothing merges on gate evidence until the scaffold ticket runs the verification checks.
