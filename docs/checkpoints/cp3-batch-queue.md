# CP-3 — Batch queue

**Ticket:** LH-CP3 / TRO-472 · **Blocks (material, not dispatch — see note below):** LH-040,
LH-041, LH-042
**Requirements served:** TH-R4, TH-R20, TH-R2, TH-R19, TH-R21, TH-R23
**PRD sections:** §3.5 batch (the design this document details), §3.6 data model, §3.7 the
warning upgrade ladder (its own open question 6 is decided here), §3.8 the latency budget,
§4 model cost, §12 risks

> **This checkpoint is not acknowledged.** This document is the material for the walkthrough.
> An agent wrote it; an agent cannot clear the gate — only Troy can, in his own words, recorded
> as a comment.
>
> **One difference from CP-1 and CP-2's own banners, stated plainly, in four separate facts.**
>
> 1. Troy's session on 2026-08-11 (commit `c09250e`) grants one specific permission: LH-040,
>    LH-041, and LH-042 may start once this material exists and Troy has been notified.
> 2. That permission does not require Troy's reply first. CP-1 and CP-2's own banners required
>    it — "no agent starts \[the next wave\] until Troy acknowledges." CP-3 does not.
> 3. Troy's acceptance of the *design* is a separate, unchanged requirement. Only Troy can accept
>    it, in his own words, recorded as a comment — the same rule CP-1 and CP-2 stated.
> 4. Dispatch is not a substitute for that acceptance. A ticket starting does not mean Troy
>    reviewed or agreed with what is in this document.

## How to use this document

Read it in order. It takes about 40 minutes.

- **Sections 3, 4, and 6 are the load-bearing ones.** Section 3 answers whether two workers can
  process the same label twice — the question this checkpoint exists to catch, and the one
  Linear finding (TRO-506) already named. Section 4 tests the PRD's own "tuned to Anthropic
  rate limits" claim against Anthropic's actual, live-retrieved limits, and the answer is not
  what the PRD implies. Section 6 decides a question CP-1 explicitly left for this document
  (its open question 6): the per-batch Sonnet escalation cap.
- **Section 8 is a full worked example** — the exact one this ticket's brief names: 200 labels,
  a pool of 5, one failure, one escalation.
- **Section 11 is the "defend it" Q&A.** Read the questions first. Try to answer each one before
  reading the answer.
- **Section 12 lists what only Troy can decide.**

### Numbers and claims in this document

This project is graded on honest evidence (PRD §6). Every claim below carries one of five
labels.

| Label | Meaning |
|---|---|
| **verified** | Retrieved live from a named authoritative source on a stated date. Re-run the fetch and check it. |
| **derived** | Arithmetic over stated inputs. The inputs are named. Check the arithmetic. |
| **target** | A budget the design must hit. It comes from the PRD, not from a run. |
| **proposed** | A starting value chosen by reasoning. A real run (LH-030/LH-031, or production telemetry) replaces it with a measured one. |
| **not measured** | We do not know yet. It stays "not measured" until a real run says otherwise. |

CP-2 added **verified** to CP-1's four labels for a statutory string retrieved from a
government source. This document reuses the label for a different kind of source: Anthropic's
own published rate-limit tables (§4.2), retrieved live and dated. It is stronger than
**derived** — nothing here is computed, it is copied from the source with a date attached — and
weaker than a number measured on this project's own running system, which stays **not
measured** until LH-031's latency harness exists and runs against a real deployment.

---

## 1. The one-sentence version

Every unit of batch work is claimed atomically from a persistent queue table, never inferred
from what has already finished; Sonnet only ever touches a label the router already escalated,
through its own capacity-limited sub-queue; and a batch is *finished* the moment every item
reaches a terminal state, whether that state is success or failure — finished is not a synonym
for "every item passed."

---

## 2. What is actually queuing

### 2.1 The schema has no "pending" state today

Before designing a queue, find out what is already there. `src/lib/db/schema.ts` and
`src/lib/db/enums.ts` are merged and in production use for the single-label path. Read their own
comments first, because they already answer half of "what's queuing."

`verifications` (`src/lib/db/schema.ts:242-271`) carries this comment on its own doc block:

> "The row records a completed result: `verdict` and `resolutionPath` are set at insert time,
> once the cascade has finished for this label."

And `enums.ts`'s `LABEL_VERDICTS` comment is more direct still:

> "A `verifications` row always has one \[verdict\] — there is no 'pending' state, because the
> row exists only once the cascade has produced a result."

That is a deliberate design choice from LH-002, and it is the right one for the single-label
path: a row you can query is a row with an answer. But it means **`verifications` cannot be the
batch queue.** A label with no `verifications` row yet could mean "not started," "currently
being processed by worker 3," or "processing crashed and nobody noticed" — three different
situations a queue must tell apart, and one table that only records success cannot tell them
apart at all.

`batchJobs` (`schema.ts:75-133`) tracks the *job* level — one row per upload, with `status`
(`PENDING` / `RUNNING` / `COMPLETED` / `FAILED`) and six counters (`totalCount`,
`processedCount`, `autoVerifiedCount`, `resolvedBySonnetCount`, `needsHumanCount`,
`failedCount`). `enums.ts`'s own comment on `BATCH_JOB_STATUSES` is explicit about scope:
"`FAILED` is a whole-job failure (e.g. the manifest could not be read) — one bad image inside a
running job fails that item only and shows up in `failedCount`, never this status." That
comment already answers half of §7's partial-failure question. It does not answer the other
half: where does a failed *item*'s reason live, if it never gets a `verifications` row to write
it to?

Nothing in the current schema answers either question. This is not a gap left carelessly — LH-002's
own comment on `labelImages` names it directly: enforcing that an application, image, and batch
job stay consistent "belongs with LH-041's batch worker \[...\], not invented ahead of that
design." LH-041 is this ticket's own worker. This document is that design.

### 2.2 The new table: `batch_queue_items`

**Recommendation, not yet built:** a new table, added by LH-041's own numbered migration (the
next one after `0001_product_schema.sql` — `0002_...` as of this writing; confirm the number
has not moved when LH-041 actually runs `db:generate`, per CLAUDE.md's non-negotiable that
schema changes are numbered migrations, never a direct edit).

| Column | Type | Purpose |
|---|---|---|
| `id` | identity PK | |
| `batch_job_id` | FK → `batch_jobs`, cascade delete | Every item belongs to exactly one batch. Batch-scoped by design — see §9 for the one case this leaves unhandled. |
| `kind` | enum `EXTRACT` \| `RESOLVE` | Which queue this row belongs to. One table, two logical queues — see §2.3 for why one table beats two. |
| `application_id` | FK → `applications`, nullable | Set for `EXTRACT` rows. Null for `RESOLVE` rows — reachable via `verification_id` instead; no denormalized copy. |
| `label_image_id` | FK → `label_images`, nullable | Same rule as `application_id`. |
| `verification_id` | FK → `verifications`, nullable | Set for `RESOLVE` rows once the `EXTRACT` phase has produced a `verifications` row with `verdict = REVIEW`. Null for `EXTRACT` rows — there is no verification yet. |
| `resolver_input` | jsonb, nullable | `RESOLVE` rows only. See §2.3 — this is not optional. |
| `status` | enum `PENDING` \| `CLAIMED` \| `DONE` \| `FAILED` | The claim state machine, §3. |
| `claimed_by` | text, nullable | An opaque worker-instance identifier (process id + hostname, or a UUID assigned at worker startup). Identifies *which worker*, for logs and diagnosis. Not the fencing mechanism — see `claim_token`. |
| `claim_token` | uuid, nullable | Generated fresh on **every** claim, including a reclaim by the same `claimed_by`. The fencing mechanism (§3.1, §3.2) — completion, retry-release, and failure updates all require it to match. |
| `claimed_at` | timestamp, nullable | |
| `lease_expires_at` | timestamp, nullable | Past this time, a `CLAIMED` row is eligible for reclaim by any worker. §3.2. |
| `available_at` | timestamp, not null, default now() | A row is only claimable once this time has passed. Defaults to "now" at insert; a retryable failure pushes it forward by the backoff delay (§5) instead of blocking the worker that hit the failure. |
| `attempts` | integer, not null, default 0 | Incremented on every claim. Compared against a fixed cap (§5.1) to decide retry vs. permanent failure. |
| `last_error` | text, nullable | Set only on `FAILED`. The one place a failed item's reason lives, since it never gets a `verifications` row (§7.3). |
| `created_at`, `updated_at` | timestamp | |

Two indexes carry the actual load:

1. A partial index on `(kind, status, available_at)` — the claim query's own `WHERE` clause,
   almost verbatim (§3.1).
2. An index on `batch_job_id` — the progress-summary query LH-042 runs every poll.

**Two constraints, matching this schema's own existing conventions rather than inventing new
ones.** `label_images_belongs_to_something` (`schema.ts:216-219`) already enforces "exactly the
right columns for this row's role" with a plain `CHECK`; `batch_queue_items` needs the same
shape, one level more specific because it has two roles instead of one:

```sql
CHECK (
  (kind = 'EXTRACT' AND application_id IS NOT NULL AND label_image_id IS NOT NULL
     AND verification_id IS NULL AND resolver_input IS NULL)
  OR
  (kind = 'RESOLVE' AND verification_id IS NOT NULL AND resolver_input IS NOT NULL
     AND application_id IS NULL AND label_image_id IS NULL)
)
```

Two partial unique indexes, one per `kind`, both closing the same class of gap: a retried
enqueue must not create a second row for work already queued.

- `UNIQUE (verification_id) WHERE kind = 'RESOLVE'` — the same one-row-per-verification
  guarantee `review_queue_verification_id_unique` (`schema.ts:348-350`) already gives that
  table, applied here too, so a retried or duplicated `EXTRACT` transaction cannot enqueue two
  `RESOLVE` rows for the same escalation.
- `UNIQUE (batch_job_id, application_id, label_image_id) WHERE kind = 'EXTRACT'` — the matching
  guarantee on the enqueue side. Nothing elsewhere in the schema stops two `EXTRACT` rows for
  the same pairing: `verifications` carries no unique constraint on
  `(applicationId, labelImageId)` either, so two `EXTRACT` rows for one label would not just
  waste a claim slot — each could run its own extraction and insert its own `verifications`
  row, silently doubling that label in every downstream count and in LH-042's results table.
  **Enqueue must be conflict-safe against this index** — `INSERT ... ON CONFLICT
  (batch_job_id, application_id, label_image_id) WHERE kind = 'EXTRACT' DO NOTHING` — so a
  retried batch-creation step (LH-040's own upload handler, retried by a client timeout or a
  partial failure) reuses the existing row instead of duplicating it.

**What neither constraint checks: that `application_id`, `label_image_id`, and (transitively,
for a `RESOLVE` row) `verification_id` all belong to the *same* `batch_job_id`.** That needs a
trigger or composite foreign keys to enforce at the database level, and LH-002's own comment on
`labelImages` already declined to build that machinery ahead of the code that would need it —
"real complexity that belongs with the code that creates verification rows \[...\], not
invented ahead of that design." The same call applies here, for the same reason: every row this
table holds is written by one trusted writer (the `EXTRACT` worker, which derives all three IDs
from its own claimed batch context), not by arbitrary callers assembling a row from parts. A
prototype-scale batch queue can rely on that; a multi-tenant one could not.

### 2.3 The Sonnet sub-queue reuses `review_queue`, not a second escalation table

PRD §3.5 states this as a rule, not a suggestion: "Sonnet workers consume only the review
sub-queue." The natural reading is a second queue, separate from the extraction queue — and
`batch_queue_items`'s `kind = RESOLVE` rows are exactly that: their own filtered slice of the
same table, claimable only by resolve-workers, with their own concurrency limit (§4.5).

**What a `RESOLVE` row must carry, checked against the already-built resolver's own contract.**
`resolveEscalatedLabel` (`src/server/resolver/index.ts`) takes a `ResolverInput`
(`src/server/resolver/types.ts:87-105`): `verificationId`, `image` (the Sonnet-resolution
preprocessed variant), `extraction` (the full `HaikuExtractionResult`), `application`,
`router` (the full `LabelRouterResult`), and `flaggedFields`. `application` and `image` are
cheap to rebuild from `verificationId` — join to `applications`/`labelImages`, re-run the
sharp preprocessing step for the Sonnet-resolution variant (a resize, not a model call). But
`extraction` and `router` are **not** fully reconstructable from what `field_results` persists
today: `field_results` stores the router's per-field verdict, reason, evidence, and confidence,
which is close to `router` but not `extraction` — Haiku's raw reading, before the router
touched it. A resolve-worker with no snapshot would have only one option: re-run the Haiku
extraction call to rebuild it. That is a second, avoidable model call, on a code path whose
whole point is to avoid unnecessary model calls (TH-R19), and worse, it risks reading the label
*differently* the second time — undermining the very reproducibility that makes this design
defensible in the first place (CP-1 §8, Q1).

**So `resolver_input` (jsonb) is not a convenience column — it is required.** The `EXTRACT`
worker, having just computed `extraction` and `router` in memory to decide the verdict, snapshots
`{ schemaVersion, extraction, router, flaggedFields }` into the `RESOLVE` row it inserts, in the
same transaction that writes the `verifications` and `field_results` rows. The resolve-worker
later deserializes it, rebuilds `application` and `image` cheaply, and calls
`resolveEscalatedLabel` with an input that reads the label exactly once.

**The snapshot needs a version tag, named as a requirement rather than left implicit.** A batch
can sit in the queue for as long as the batch itself takes to drain — long enough for a code
deploy to land between the `EXTRACT` worker that wrote a snapshot and the resolve-worker that
reads it, if `ResolverInput`'s own shape ever changes. **`schemaVersion: "1"` is the one
supported value as of this document** — matching `ResolverInput`'s fields as read above
(`extraction`, `router`, `flaggedFields`, plus `application` and `image` rebuilt rather than
snapshotted) at the time this design was written. A resolve-worker that receives a
`resolver_input` payload at
any other `schemaVersion`, including a missing one, must reject the row — `FAILED`, `last_error`
naming the version mismatch — never guess at a compatible reading. This
is the same "reject, never clamp or guess" boundary this codebase already applies to untyped
input elsewhere (`findExistingReviewQueueEntry`'s own refusal to reuse a `resolverOutput` shape
it cannot validate, `src/server/resolver/queue.ts:173-189`), applied here to a payload this
design introduces.

**What does *not* change.** `resolveEscalatedLabel`, `insertReviewQueueEntry`, and
`findExistingReviewQueueEntry` (`src/server/resolver/{index,queue}.ts`) are already built,
already tested, and already merged. This design calls them as they exist. It does not modify
`review_queue`'s insert timing: a `review_queue` row is still written exactly once, from inside
`resolveEscalatedLabel`, after Sonnet responds — matching the single-label verify route's own
pattern (`src/app/api/verify/route.ts:244-249`) and matching what LH-050's already-shipped
review-queue UI (`src/server/review-queue/list.ts`, `get-item.ts`) already expects to read.
§3.3 explains why this restraint matters, and names the one place a follow-up change is worth
making — as a recommendation, not a requirement of this design.

### 2.4 What LH-041 builds against, and must not touch

| Existing, merged | File | What LH-041 must do |
|---|---|---|
| `resolveEscalatedLabel` | `src/server/resolver/index.ts` | Call it. Do not re-implement its pre-check or its review-queue insert. |
| `extractLabel` | `src/server/extractor/index.ts` | Call it once per `EXTRACT` claim. |
| `routeLabel` | `src/server/router/*` | Call it after extraction, exactly as `verify/route.ts` does. |
| `verifications` / `fieldResults` / `reviewQueue` inserts | `src/app/api/verify/route.ts:192-249` | Mirror this transaction shape for the batch `EXTRACT` worker's success path — same tables, same `resolutionPath: "EXTRACTOR_ONLY"` at insert time (§7.3 explains why that value is correct even for a REVIEW verdict). |
| `listUnresolvedReviewQueue` | `src/server/review-queue/list.ts` | Do not edit for this design. §3.3 names a *future*, optional change here; it is not part of this ticket. |

---

## 3. Atomic claiming — closing the concurrency hole before it opens

### 3.1 The claim, as one statement

A worker never runs two separate queries — "find a row" then "mark it mine." That shape is a
race by construction: two workers can both find the same row before either marks it. The claim
is one statement, using Postgres's own row-locking:

```sql
UPDATE batch_queue_items
SET status = 'CLAIMED',
    claimed_by = $workerId,
    claim_token = gen_random_uuid(),   -- fresh every claim, including a reclaim by $workerId
    claimed_at = now(),
    lease_expires_at = now() + $leaseSeconds * interval '1 second',
    attempts = attempts + 1
WHERE id = (
  SELECT bqi.id FROM batch_queue_items bqi
  JOIN batch_jobs bj ON bj.id = bqi.batch_job_id
  WHERE bqi.kind = $kind
    AND bj.status = 'RUNNING'
    AND bqi.available_at <= now()
    AND (bqi.status = 'PENDING' OR (bqi.status = 'CLAIMED' AND bqi.lease_expires_at < now()))
  ORDER BY bqi.id
  FOR UPDATE OF bqi SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` is the standard Postgres queue pattern: it locks the one candidate row
it picks, and any other worker running the same statement concurrently simply skips past a row
someone else already has locked, rather than blocking on it. Two workers running this statement
at the same instant against the same table cannot land on the same row — Postgres itself
enforces that, not application code. This is the primary defence, and it is structural: nothing
downstream has to trust that two workers behaved correctly, because the database made it
impossible for two workers to both succeed on the same row.

**`bj.status = 'RUNNING'` is not decoration — without it, claiming can start before the batch
has.** §8's own worked example creates all 200 `EXTRACT` rows (`status = 'PENDING'`, step 1)
*before* `batch_jobs.status` flips to `RUNNING` (step 2). A claim query that reads only queue-
item fields cannot tell that apart from a batch that is genuinely running, so a worker polling
continuously could claim item #1 before the warm-up request (step 2, CP-1 §7.3's own
recommendation) has fired — silently defeating the one thing that ordering exists to guarantee.
Joining `batch_jobs` and requiring `RUNNING` makes the step 1 → step 2 → step 3 ordering in §8
an enforced precondition, not a hoped-for convention.

**`claim_token`, not `claimed_by` alone, is what completion checks — and the difference is real,
not pedantic.** `claimed_by` names a worker *instance*, which can live for a batch's entire
duration and claim hundreds of items across it. It is not unique *per claim*. Consider: worker A
claims row X (`claimed_by = 'A'`), the call runs long, the lease passes, and — through whatever
path, a retry loop, a redeploy that reuses a stable identifier, a bug — worker A (still that same
identifier) ends up claiming row X *again*, later, as a genuinely separate episode. A completion
predicate that only checks `claimed_by = 'A'` cannot tell the *first* episode's now-stale result
from the *second* episode's real one — both carry the identical `claimed_by`. `claim_token` is
generated fresh on every claim, first or reclaimed, by the same worker or a different one, so a
stale episode's token never matches the row's current one, however the staleness arose. §3.2's
completion guard requires it alongside `claimed_by`, which stays as the human-facing "which
worker" identifier for logs — additive, not a replacement.

`kind = $kind` is what makes this one query serve two independently-sized pools: extract-workers
run it with `$kind = 'EXTRACT'`, resolve-workers with `$kind = 'RESOLVE'`. Same statement, same
guarantee, two queues.

### 3.2 Lease expiry and worker-crash recovery

A worker that crashes mid-item — the process dies, the container restarts, Render redeploys —
leaves its claimed row `CLAIMED` forever, with no one left to finish it, unless something
reclaims it. `lease_expires_at` is that something: the claim query's own `WHERE` clause already
treats a `CLAIMED` row whose lease has passed as claimable again, by any worker, including a
brand-new one that has never seen this batch before. No separate cleanup job, no dead-worker
detector — the same query that claims new work also recovers abandoned work, because "abandoned"
and "never started" look identical to a worker that only cares whether a row is available now.

**Lease durations, proposed:** 60 seconds for `EXTRACT`, 120 seconds for `RESOLVE`. Both are
generous multiples of PRD §3.8's own *target* (not yet measured) latency for the underlying
call — the extractor's ~2.5s and the resolver's admittedly-slower, not-yet-measured call
(CP-1 §7.3). A lease that is too short reclaims a merely-slow worker's item while it is still
correctly in progress, which is exactly the race §3.3 discusses. A lease that is too long only
delays recovery from a genuinely dead worker, which costs seconds inside a batch that runs for
minutes. The asymmetry favours generous.

**Completing a claim needs the same guard the claim itself has — a requirement, not a detail.**
§3.1's `UPDATE ... FOR UPDATE SKIP LOCKED` stops two workers from *starting* the same item. On
its own, that says nothing about *finishing* it. Walk the same lease-expiry scenario §3.3 walks
for the Sonnet case, but for the `EXTRACT` side: worker A claims a row, the call runs long, the
lease passes, worker B reclaims the same row and completes it correctly. If worker A's
now-stale call finally does return, and worker A writes its `verifications` row without
checking anything first, it can insert a **second** `verifications` row for a label B already
finished — real data duplication, not merely wasted money, because `verifications` carries no
unique constraint on `(applicationId, labelImageId)` to stop it.

The fix is the same shape as the claim itself: **the write that completes an item is
conditioned on still holding it**, not unconditional.

```sql
UPDATE batch_queue_items
SET status = 'DONE'   -- or the PENDING/FAILED release from §5.2
WHERE id = $id AND claim_token = $myClaimToken AND status = 'CLAIMED'
RETURNING id;
```

Run this **first**, inside the same transaction that writes `verifications` / `field_results` /
`review_queue`. Zero rows returned means this worker's own claim episode is no longer the current
one — its lease expired, someone (possibly this same worker, under the same `claimed_by`, on a
later episode) reclaimed the row, and most likely already finished it. The transaction rolls back
without writing anything else, and the worker's own extraction or resolution result is discarded,
not reconciled. That is a real cost — the model call that produced the discarded result was not
free — but it is the same trade this document already makes in §3.3 for the Sonnet case: waste
money rather than risk corrupting data. §7's decision table and §8's worked example both assume
this guard runs on every completion write, for both queue kinds, not only where §3.3 discusses
it explicitly.

**Why `claim_token`, not `claimed_by`, is the predicate here:** §3.1 already makes the case in
full. The short version is that `claimed_by` is stable across a worker's whole lifetime, so it
cannot distinguish this worker's *current* claim on row X from a *stale* one it held earlier on
the same row — `claim_token` can, because a fresh one is minted on every claim.

**LH-041's own test suite must cover the lost-lease case directly, not only as a paragraph in this
document.** A worker claims an item, its lease is made to expire mid-call (simulated, not
awaited for real), a second claim reassigns `claimed_by`/`claim_token`, and the first worker's
completion attempt is asserted to affect zero rows and write nothing. This is the regression test
for the exact race this section exists to close — CP-2 named comparable named cases (`STONE'S
THROW`, Jenny's title-case catch) for its own load-bearing checks, and this one earns the same
treatment.

### 3.3 Can two workers double-process the same item?

This is the question this checkpoint exists to catch, and Linear already has a finding on it:
**TRO-506**, filed against `resolveEscalatedLabel` itself, backlog, medium priority, labelled
`review`. Read it before answering this section, because its own recommendation shapes this
answer.

**What TRO-506 found.** `resolveEscalatedLabel` (`src/server/resolver/index.ts:104-125`) checks
for an existing `review_queue` row (`findExistingReviewQueueEntry`) *before* calling Sonnet,
then inserts the result *after* the call returns. Check-then-insert, with no reservation between
the two steps. Two concurrent callers for the same `verificationId` can both pass the check,
both pay for a Sonnet call, and only one insert succeeds — the `review_queue` table's own unique
index on `verificationId` (`schema.ts:348-350`) stops the *data* from duplicating, but by the
time that constraint fires, the second, real-money Sonnet call has already happened. TRO-506's
own words: "it is only unreachable today because no caller resolves the same verification twice
concurrently yet." LH-041 is that caller.

**The primary defence is not in `resolver/queue.ts` — it is in §3.1's claim query.** A
`RESOLVE` row exists once, for one `verificationId`. The atomic claim in §3.1 guarantees at most
one worker holds that row's lease at a time under normal operation. If only one worker ever
holds the lease for a given `verificationId`, only one worker ever calls `resolveEscalatedLabel`
for it, and the TOCTOU window inside that function is never exercised by the batch path at all —
not because the window closed, but because the batch design never lets two callers reach it
concurrently in the first place.

**One asymmetry between the two queue kinds, stated plainly rather than left for a reader to
infer.** For an `EXTRACT` item, §3.2's completion guard genuinely gates everything: the worker
controls the whole transaction, so the guard, the `verifications` insert, and the `review_queue`
insert (when the router says REVIEW) either all commit together or none do. For a `RESOLVE`
item, that is **not** true. `resolveEscalatedLabel` calls Sonnet and then calls
`insertReviewQueueEntry` — the write that actually creates the `review_queue` row — entirely
inside itself, before this worker's own `batch_queue_items` completion guard ever runs. §3.2's
guard, run afterward, protects the `batch_queue_items` row and the `verifications.resolutionPath`
update from a stale worker double-writing them. It does **not** gate the `review_queue` insert,
because that insert already happened, inside a function this design calls but does not
restructure. That gap is exactly what the rest of this section names.

**The residual risk, named precisely rather than waved away.** A lease is a timeout, not a proof
of death. Here is the exact sequence that reopens TRO-506's race, one event at a time:

1. Worker A claims a `RESOLVE` row and calls Sonnet. The call runs long — slow network, a large
   image, adaptive thinking taking its time.
2. The call passes the 120-second lease. Worker A is not dead. It is only slow.
3. Worker B's claim query sees the row as `CLAIMED`, with an expired lease. It reclaims the row.
4. Both workers now hold the same `verificationId`, genuinely concurrently — the exact race
   TRO-506 describes, reopened by lease expiry rather than by a missing claim mechanism.
5. Each worker's own `findExistingReviewQueueEntry` pre-check ran before its own Sonnet call, at
   a moment when no `review_queue` row existed yet for either of them. Neither check stops
   either call.
6. Whichever call finishes first inserts the `review_queue` row. The second insert hits the
   table's own unique constraint and throws, uncaught — `queue.ts`'s own documented behaviour:
   "this function alone does not prevent the WASTE a duplicate call causes."

Money is wasted. Data is not corrupted — the unique constraint still holds. The honest size of
the residual gap: **narrower than "any two workers, any time" — reachable only through lease
expiry during a call that is slow but still alive — but real.**

**Required now, regardless of whether the follow-up below ever ships: the losing caller must
recover, not throw.** Step 6 above ends with "the second insert hits the table's own unique
constraint and throws, uncaught." That throw propagates out of `resolveEscalatedLabel` to
whichever resolve-worker called it — and today, nothing in this design says what that
resolve-worker should do about it. It must not mark its own `RESOLVE` queue item `FAILED`: the
verification genuinely *is* resolved, just by the other worker, and reporting a failure for a
label that was in fact handled would be a false alarm, and a false alarm the batch summary would
then have to explain away. The resolve-worker's own call site — code this design owns, not
`resolver/queue.ts` — must catch the Postgres unique-violation (`23505`) on `verification_id`
specifically, call the already-exported `findExistingReviewQueueEntry` (`resolver/index.ts`'s own
public surface, §2.4's table) to load the row the *other* worker wrote, and complete its
`RESOLVE` queue item using that data: `DONE`, the same `verifications.resolutionPath` update,
the same counter increment the winning outcome implies. This is buildable inside LH-041 today —
it changes no shipped file — and it is required, not optional, because leaving the exception
uncaught would surface as an unexplained item failure for a label that actually succeeded.

**The recommended fix, adopting TRO-506's own suggestion, as a follow-up — not a blocker.**
TRO-506 recommends replacing the check-then-insert with an atomic reservation:
`INSERT INTO review_queue (verification_id, reason) VALUES (...) ON CONFLICT (verification_id)
DO NOTHING RETURNING id`, run *before* the Sonnet call. A returned row means this caller won the
reservation and should proceed; no row returned means someone else already has it, and this
caller should not call Sonnet at all — the recovery paragraph above still applies, just triggered
earlier, before the wasted call rather than after it. This closes even the lease-expiry window,
because the reservation — unlike a lease — is not time-bound; it is a fact in the database the
instant it commits.

**Why this document does not fold that fix into LH-041's required scope.** Adopting it changes
`review_queue`'s own shape mid-flight: a reserved-but-unresolved row would carry
`resolver_output: NULL` for the seconds the Sonnet call is in flight — a state `review_queue`
does not have today. Two things already read this table on the assumption that a row with
`disposition IS NULL` is a row with a *populated* `resolverOutput`: `listUnresolvedReviewQueue`
(`src/server/review-queue/list.ts:77`) filters only on `disposition IS NULL`, with no check on
`resolver_output`, and its own partial index (`review_queue_unresolved_idx`,
`schema.ts:354-356`) is built the same way. `get-item.ts`'s `extractResolverNote` /
`summarizeResolverOutput` degrade gracefully on a non-object `resolverOutput` (return `null`
rather than throw), so a reservation-in-flight row would not *crash* LH-050's already-shipped
UI — but it would render as "no resolver suggestion yet" indistinguishably from §6's
deliberate escalation-cap skip, which is a real state the UI cannot tell apart from "wait a few
seconds and refresh." Making TRO-506's fix land cleanly needs a small, coordinated change to
that list query too. That is a five-line fix, but it touches a file this ticket's brief says
not to touch, on a ticket (LH-050 / TRO-476) that has already merged. A second question the
follow-up ticket must decide, not this document: `review_queue` has no lease or expiry of its
own, so a reservation left behind by a worker that crashes *between* reserving and calling
Sonnet has nothing to reclaim it — the follow-up needs its own answer, whether that is a
lease on the reservation itself or a rule that piggybacks on `batch_queue_items`' own lease
expiry for the same `RESOLVE` item. **Recommendation:** file it as its own small follow-up
ticket, owned jointly by whoever revisits LH-041 and LH-050, rather than pulled into this one.
§12 lists it as an open question with that recommendation and its cost.

**Answering the brief's own question directly:** yes, under lease expiry during a slow-but-alive
worker, two workers can currently reach the point of both calling Sonnet for the same
escalation — a real, if narrow, gap. The claim design in §3.1 is what makes this gap narrow
rather than wide open. The `ON CONFLICT DO NOTHING` reservation is what would close it entirely,
and it is recommended, not required, because closing it fully means touching a shipped file
this ticket does not own.

---

## 4. Worker concurrency — why ~5, tested against real numbers

### 4.1 What the PRD actually says

PRD §3.5, quoted exactly, not restated: "Postgres-backed job queue; worker pool (concurrency
~5, tuned to Anthropic rate limits with backoff). Never `for image: await extract(image)`
serially." This ticket's own brief restates it the same way. Restating it is not the same as
verifying it — so this section checks the claim against Anthropic's actual limits, retrieved
live, not assumed.

### 4.2 Anthropic's published rate limits — verified

**Retrieved 2026-08-11 from `https://platform.claude.com/docs/en/api/rate-limits`.** The page
carries no separate "last updated" date of its own; the retrieval date above is when this
document copied the numbers below. Re-open the URL to check them, or read them programmatically
from the Console's Rate Limits page or the Rate Limits API once a real deployment key exists.

| Tier | Model | RPM | ITPM | OTPM |
|---|---|---:|---:|---:|
| Start | Claude Haiku 4.5 | 1,000 | 2,000,000 | 400,000 |
| Start | Claude Sonnet 5 | 1,000 | 2,000,000 | 400,000 |
| Build | Claude Haiku 4.5 | 5,000 | 5,000,000 | 1,000,000 |
| Build | Claude Sonnet 5 | 5,000 | 5,000,000 | 1,000,000 |
| Scale | Claude Haiku 4.5 | 10,000 | 10,000,000 | 2,000,000 |
| Scale | Claude Sonnet 5 | 10,000 | 10,000,000 | 2,000,000 |

Three facts from the same page matter as much as the table:

1. **Rate limits are set per organization, not per worker or per process.** Five workers or
   fifty draw from one shared budget per model. This is why §4.3's arithmetic sums all workers'
   traffic before comparing it to a limit — comparing one worker's traffic to the whole budget
   would understate real usage five-fold.
2. **Haiku and Sonnet draw from independent buckets.** "Rate limits are applied separately for
   each model." A Sonnet sub-queue genuinely protects Haiku's budget, and vice versa, at the API
   level — not only as a code-organization convenience.
3. **A new organization, or one with limited usage history, may sit below even the Start tier**,
   in an unquantified "Evaluation" tier — the page names this but gives no numbers for it. This
   project's deployed key (PRD §8: "the public URL fronts Troy's Anthropic key") is exactly the
   kind of account this caveat describes. Every number in §4.3 below assumes Start tier or
   better; if the real account sits in Evaluation tier, the actual headroom could be smaller.
   §4.4's recommendation accounts for this.
4. **The published RPM/ITPM/OTPM ceilings are not the only way to get a 429.** The same page
   names two further mechanisms §4.3's steady-state arithmetic cannot see: the token-bucket
   enforcement itself can reject a burst that arrives faster than the bucket refills even while
   the per-minute average stays under the limit ("a rate of 60 requests per minute might be
   enforced as 1 request per second... short bursts... can exceed the limit"), and a separate
   **acceleration limit** can trigger on a sharp increase in usage even under the published
   ceilings, independent of them. Neither has a published number to compute against — both are
   named here so §4.3's conclusion is not read as stronger than it is.

### 4.3 The arithmetic

CP-1 §7.1 already estimated per-call token counts, and it labelled them correctly: "Every token
count below is an assumption, not a measurement." This section's arithmetic inherits that label
— it is **derived from an assumption**, one layer removed from a measurement, and it says so at
every step rather than borrowing false confidence from a table that looks precise.

**Extractor (Haiku), from CP-1 §7.1:** ~2,800 input tokens (~1,600 image + ~1,200
system/user/schema), ~600 output tokens, per label.

**Extractor throughput at 5 concurrent workers,** using PRD §3.8's *target* (not measured)
~2.5s per Haiku call as a per-call duration proxy: each worker completes 60 / 2.5 = 24 calls per
minute; five workers, 120 calls per minute. This ignores preprocessing and database time, so it
over-states throughput slightly — the conservative direction for this arithmetic, since the
question is whether 5 workers could exhaust the budget.

| Axis | 5-worker traffic | Start-tier limit | Utilization |
|---|---:|---:|---:|
| RPM | 120 | 1,000 | 12% |
| ITPM | 120 × 2,800 = 336,000 | 2,000,000 | 17% |
| OTPM | 120 × 600 = 72,000 | 400,000 | 18% |

**Resolver (Sonnet) arrival rate,** using CP-1's own assumed 15% escalation rate applied to the
extractor throughput above: 120 × 15% = 18 resolve calls per minute (arrival, not service
rate — this says nothing about whether a given resolve-pool size keeps up, only how much of the
rate-limit budget the *incoming* work would use if every arriving item were served
instantly).

| Axis | Arrival traffic | Start-tier limit | Utilization |
|---|---:|---:|---:|
| RPM | 18 | 1,000 | 2% |
| ITPM | 18 × 6,500 = 117,000 | 2,000,000 | 6% |
| OTPM | 18 × 2,000 = 36,000 | 400,000 | 9% |

Even CP-1's own stress case — Q7's 40% escalation blowout — arrives at 120 × 40% = 48 calls per
minute: 5% RPM, 16% ITPM, 24% OTPM. Still nowhere near the ceiling.

**The honest conclusion, and the qualifier it needs: at Start tier — the lowest tier Anthropic's
own page quantifies — a 5-worker extraction pool uses under a fifth of the published budget on
every axis, and its resolve sub-queue stays under a quarter even under CP-1's own worst-case,
40% escalation assumption (the single highest figure computed above is 24% OTPM, not the 9–18%
typical of the other rows).** No figure in either table approaches saturating even the lowest
published tier. The PRD's "tuned to Anthropic rate limits" is not literally true against the
numbers Anthropic itself publishes. Anthropic's org-level limits allow far more parallelism than
5, at any tier this document could verify a number for.

**This is a steady-state calculation, not a safety proof, and the two are not the same claim.**
Every number above divides a minute's worth of traffic by a minute's worth of budget. It says
nothing about §4.2's own point 4 — a burst that front-loads five workers' first calls into the
same second, or an organization-level acceleration trigger neither this document nor Anthropic's
published page can size in advance. A 429 under this design is not evidence the arithmetic was
wrong; it is the expected, occasional cost of running real traffic against limits that are
enforced more finely than a per-minute average. That is precisely why §5 exists as its own
section rather than an afterthought: jittered backoff (§5.2) absorbs an individual burst,
`retry-after` (§5.1) tells a worker exactly how long the bucket needs, and the pool-wide cooldown
(§5.3) stops all five workers from re-discovering the same throttle independently. The
recommendation to make concurrency an environment variable (§4.4) is not only about the
Evaluation-tier uncertainty — it is also the lever to pull if 429s from either mechanism in §4.2
point 4 show up in practice and backoff alone is not absorbing them.

### 4.4 So why 5, if not rate limits?

Not rate limits, on the evidence above. Four reasons that are real, none of them measured yet:

1. **The Evaluation-tier caveat (§4.2, point 3).** This project's own deployed key may sit below
   Start tier, unquantified. A number chosen against the published Start-tier table could still
   be wrong for the actual account. The fix is not a bigger safety margin baked into the
   constant — it is making the constant **not a constant**: an environment variable
   (`BATCH_WORKER_CONCURRENCY`, default 5), checkable and changeable without a code deploy once
   the real account's actual limits are visible on its own Console page.
2. **Local compute, not measured.** `sharp` (image preprocessing) and `tesseract.js` (OCR) both
   run CPU-bound work inside the same worker process that also makes the network calls. Five
   Anthropic calls in flight is nowhere near Anthropic's ceiling; five concurrent `sharp` resizes
   plus five concurrent Tesseract recognitions on a single Render instance is a real, different
   ceiling this document cannot quantify without a running instance to load-test. **Not
   measured.**
3. **Cost and blast radius.** CP-1 §7.2's own arithmetic: a cascade-run 300-label batch costs
   about $4 (derived, §6.3 restates this for the escalation-cap discussion). A bug that loops —
   a retry storm, a malformed image that keeps re-queuing, a prompt-injection attempt that
   somehow survives to a retried call — compounds slower at 5 concurrent than at 20. A small
   number is a cheap insurance policy against a class of mistake nobody has to fully anticipate
   in advance.
4. **It is a starting value, and this project already has a pattern for starting values.** 0.85
   and 0.60 (CP-1's confidence thresholds), 0.90 (the warning-transcription floor), 60/100
   (CP-2's OCR confidence floor), the distance-2 near-miss band — every one of these shipped
   **proposed**, with a named ticket (LH-030) that replaces it with a measured value. Worker
   concurrency should ship the same way, not as a constant hand-picked once and forgotten.

**Recommendation:** keep ~5 as the default, make it an environment variable, and let LH-031's
latency harness — once it exists and runs against a real deployment — replace "proposed" with a
measured number, the same way LH-030 is meant to replace the confidence thresholds. Until then,
5 is defensible as a conservative starting point, not as a number "tuned to" a constraint that,
on the evidence in §4.3, is not actually binding.

### 4.5 One pool or two?

PRD §3.5 gives two adjacent but separately-worded rules: "worker pool (concurrency ~5 …)" and,
as its own sentence, "Sonnet workers consume only the review sub-queue." Read literally, this
does not say whether Sonnet workers are *part of* the ~5, or a *separate* pool the "~5" figure
does not count at all. This document could not resolve that ambiguity from the PRD's own text
alone — it is a genuine fork, not a implementation detail, and §12 lists it as an open question.
This document's working recommendation, used throughout §3–§8: **two separate pools** — 5
extract-workers, plus a smaller, independently-sized resolve-worker pool, proposed at 2. "Sonnet
workers consume only the review sub-queue" reads most naturally as describing a distinct set of
workers, not a shared pool that sometimes looks at one queue and sometimes the other. A resolve
pool of 2 is sized against §4.3's own arrival-rate arithmetic (18–48 calls a minute, arriving —
not 18–48 calls a minute *needed in service capacity*, which is a different, not-yet-measured
number) and against Sonnet's own, separate rate-limit bucket (§4.2, point 2) having no reason to
share pressure with Haiku's.

---

## 5. Backoff strategy

### 5.1 What is retryable

| Failure | Retryable? | Why |
|---|---|---|
| 429 `rate_limit_error` | Yes | The API's own `retry-after` header says how long. Token-bucket capacity refills continuously (verified, same page as §4.2), so a short wait is enough — no need to wait for a fixed window boundary. |
| 5xx `api_error`, 529 `overloaded_error` | Yes | Transient, per Anthropic's own documented classification. |
| Network timeout, connection reset | Yes | Transient by nature. |
| A crashed or reclaimed lease (worker died mid-call) | Yes, automatically — §3.2 reclaims it | Not a distinct code path; the claim query itself is the retry mechanism. |
| 400 `invalid_request_error`, 401, 403, 404 | No | Deterministic. The same malformed request fails identically on retry — retrying only delays discovering that. |
| A corrupt or unreadable image (`sharp` throws on decode) | No — fails immediately | A data problem, not a transient one. Retrying wastes attempts without a chance of success. |

An item that fails for a non-retryable reason goes straight to `FAILED` on the first attempt,
with `last_error` naming which of the two non-retryable cases it was — a human reading the
results table should be able to tell "this image was corrupt" from "the API rejected the
request" without opening a log file.

### 5.2 The algorithm

Exponential backoff with jitter, seeded from the API's own `retry-after` header when the
failure carries one:

```text
delay = min(baseDelayMs * 2^(attempts - 1), maxDelayMs) + random jitter
delay = max(delay, retryAfterMs)   # honor the API's own number when it gives one — the
                                    # 429 response's retry-after is in whole seconds
                                    # (verified, §4.2's page); convert to milliseconds
                                    # before this comparison, not after
```

**Proposed starting values, not measured:** `baseDelayMs = 1000`, `maxDelayMs = 30000`,
`maxAttempts = 5`. Five attempts means four waits between them — after attempts 1 through 4,
before attempts 2 through 5 — at 1, 2, 4, and 8 seconds: 15 seconds of scheduled delay before
jitter, not an upper bound on wall-clock time, since jitter and a large `retryAfterMs` can both
push an individual wait higher. Either way, a small fraction of a batch that runs for minutes.

**The worker does not sleep holding the claim, and the release is unconditional, never
partial.** On a retryable failure, in one update: `status → 'PENDING'`, `claimed_by`,
`claimed_at`, and `lease_expires_at` all cleared to `NULL`, `available_at = now() + delay`. The
`attempts` counter is not touched again here — it already incremented once, at claim time
(§3.1's own `UPDATE`). The worker then claims a *different* available item immediately, rather
than sleeping. Sleeping in place would hold a worker-pool slot idle for up to several seconds
doing nothing — exactly the throughput loss TH-R4's "never serial" rule exists to prevent, just
reintroduced one layer up.

### 5.3 A whole-pool cooldown, not just a per-item one

Rate limits are organization-level (§4.2, point 1). If one worker hits a 429, the other four are
drawing from the same exhausted budget and are likely to hit the same wall within seconds — a
per-item backoff alone lets all five keep hammering an already-throttled endpoint. **Recommendation:**
a shared, in-memory "cooldown until" timestamp on the worker-pool coordinator, set whenever any
worker sees a 429, that every worker's claim loop checks before attempting a new claim of that
`kind`. This is a coordination refinement on top of §5.2's per-item backoff, not a replacement
for it — the per-item delay still applies to that one item once the pool-wide cooldown lifts.

**This assumes one worker-pool process, and the assumption is worth stating rather than leaving
implicit.** An in-memory timestamp coordinates workers that share memory — threads or async
tasks inside one process. It coordinates nothing across two separate processes or container
instances, each running its own pool: each would keep its own cooldown clock, oblivious to the
other's, and the organization-level budget would be exactly as exposed as if no cooldown existed
at all. PRD §3.6 names one "background worker" process, singular, which is the deployment this
recommendation fits, and the one this whole document assumes throughout. **If a future
deployment runs more than one worker-pool process against the same organization's rate-limit
budget, the in-memory signal stops being sufficient** — the coordination needs to move somewhere
every process can see: a shared row in Postgres this design already has open (a `cooldown_until`
column, checked and set the same way `available_at` already is, §2.2), or reading Anthropic's own
per-response rate-limit headers (`anthropic-ratelimit-*`, verified present on every response, §4)
and reacting per-process without needing a shared signal at all. Neither is required for the
single-process deployment this document specifies; naming the fork now means a future move to
multiple processes does not silently reopen the exact race this section closes.

### 5.4 This was half-decided already

Both already-merged model clients — `getDefaultExtractorClient`
(`src/server/extractor/index.ts:23,38`) and `getDefaultResolverClient`
(`src/server/resolver/index.ts:32,40`) — set `maxRetries: 0`, not the Anthropic SDK's own
default of 2. Both carry the same reasoning in their own comments, and the extractor's states it
most fully:

> "A batch run holds a worker-pool slot per in-flight extraction (PRD §3.5), and TH-R2's
> 5-second budget applies to the interactive path; an SDK-level retry with exponential backoff
> can silently add several seconds neither budget accounts for, and it would run underneath —
> not coordinated with — the batch worker's own rate-limit backoff once CP-3 builds it. Failing
> fast on a 429/5xx and letting the caller decide whether to retry keeps that one policy in one
> place."

That sentence names this ticket by name and commits it to owning retry policy in exactly one
place: here, not in the SDK client, not scattered across callers. §5.1–§5.3 is that one place.

---

## 6. The Sonnet escalation cap

CP-1 explicitly deferred this decision. Its own open question 6, quoted exactly: "Should the
batch escalation cap be built now or at CP-3? Q7 proposes a 25% per-batch ceiling.
*Recommendation:* CP-3, where the queue is designed. *Cost of choosing wrong:* a pathological
batch spends four times its budget with no warning." This section is that decision.

### 6.1 The threshold

**Decided: 25% of the batch's `totalCount`, proposed — not measured, adopting CP-1 Q7's own
number rather than inventing a new one.** The denominator is `totalCount`, fixed once LH-040's
pairing completes and the job starts — not "items processed so far." A moving denominator would
make the cap's trigger point drift with processing order and speed: a batch could cross 25% of
"processed" at item 25 if only 100 of 300 items have run so far, a very different signal than
25% of the eventual 300. CP-2 §8.4 made exactly this argument for its own suspect-rate metric —
"so the rate has a denominator anyone can audit" — and this design follows the same reasoning
for the same reason.

**A rounding edge, named rather than left for someone to trip over.** `ceil(0.25 * totalCount)`
gives a floor of one, not zero, for any batch with at least one item — a 1-label batch's
"25% cap" is `ceil(0.25) = 1`, an effective 100%; a 2-label batch is 50%; a 3-label batch is
33%. TH-R4's own scale reference is 200–300 labels, where this rounding is invisible — 25% of
300 is a plain 75. It only matters for a batch far smaller than this design was ever asked to
serve, and it is worth one sentence rather than a surprise: the cap guarantees at least one
Sonnet call happens before it engages, never zero.

### 6.2 What happens when it trips

**The check counts Sonnet call attempts, not settled outcomes — a correction from the first
draft, worth stating as one because the difference is load-bearing.** An earlier version of this
section checked `resolvedBySonnetCount + needsHumanCount >= ceil(0.25 * totalCount)`. That
undercounts real spend in exactly the case the cap exists to bound: a `RESOLVE` item that
exhausts every retry (§5.1) increments only `failedCount` — never `resolvedBySonnetCount` or
`needsHumanCount` — so a batch where every Sonnet attempt happens to fail could burn through its
full `maxAttempts` budget on every escalated label, at real dollar cost per attempt, while the
threshold above stays at zero and never trips. The cap must bound *calls*, because calls are what
cost money, not *settled outcomes*.

**The corrected design: a per-batch call-attempt budget, reserved atomically before every Sonnet
call — first attempt and every retry alike.** A new counter, `batchJobs.sonnetCallCount`
(integer, not null, default 0 — its own migration on the existing `batch_jobs` table, alongside
`batch_queue_items`' own), incremented by exactly this statement, run immediately before *any*
call to Sonnet for this batch:

```sql
UPDATE batch_jobs
SET sonnet_call_count = sonnet_call_count + 1
WHERE id = $batchJobId AND sonnet_call_count < $capThreshold
RETURNING sonnet_call_count;
```

A returned row means this attempt has budget and may proceed to call Sonnet. Zero rows means the
budget is exhausted — this attempt does not call Sonnet, regardless of how many of *this item's
own* `maxAttempts` remain. The resolve-worker instead writes a `review_queue` row directly —
`reason` from the router's original `headlineReason`, `resolver_output: NULL` — and increments
`needsHumanCount`, matching PRD §12's own risk mitigation almost verbatim: "further REVIEW labels
go straight to the human queue without a resolver call." The batch's live progress summary
(LH-042) must say so, not leave a human to infer it from a suspiciously high `needsHumanCount`.
`$capThreshold` is `ceil(0.25 * totalCount)`, the same formula §6.1 already decided — only its
meaning changes, from "distinct escalated labels" to "total Sonnet calls, however distributed
across labels and retries."

**This closes the exact race the first draft had, because it is the same atomic-reservation
shape §3.1's claim and §3.3's recommended follow-up both use.** `UPDATE ... WHERE ... RETURNING`
is a single statement Postgres serializes — two resolve-workers racing this check cannot both
read "under budget" and both proceed, the way two workers could race a plain `SELECT` against
`resolvedBySonnetCount + needsHumanCount`. There is no overshoot left to bound; the cap is exact.

**Retries consume additional budget, explicitly, by design — the question CP-1 left unasked.**
Every attempt reserves one unit, whether it is a label's first try or its fourth. This is the
conservative reading: reserving before the call, rather than after a successful one, means a
request that fails before ever reaching Anthropic still spends a unit of budget. That slightly
overcharges the rare pre-flight failure and never undercounts a real charge — the same asymmetry
this document chose everywhere else money and correctness trade off (§5.5's near-miss band is
the same shape of choice, in CP-2's own document).

**This is a different reservation from §3.3's, not a restatement of it — both are worth having,
neither substitutes for the other.** §3.3's `ON CONFLICT DO NOTHING` (recommended follow-up)
answers "has *this specific verification* already been resolved" — a per-verification question.
This section's `sonnet_call_count` reservation answers "does *this batch* still have call budget
left" — a per-batch question, entirely blind to which verification is asking. A batch could
adopt one, the other, or both; adopting this one does not require touching `resolver/queue.ts`
the way §3.3's does, so it is in scope for LH-041 now rather than deferred.

### 6.3 The cost arithmetic

CP-1 §7.2's own numbers, extended: a 300-label batch at the assumed 15% escalation rate, with
every escalation resolving on its first attempt, costs about $4.05 (derived, CP-1 §7.1/§7.2:
300 × $0.006 + 45 × $0.05). **With the atomic reservation above, the cap bounds total Sonnet call
*attempts* for the batch at `ceil(0.25 × 300) = 75`, full stop — regardless of how many distinct
labels those 75 calls cover, and regardless of how many are first attempts versus retries.** The
worst case is therefore 300 × $0.006 + 75 × $0.05 = $1.80 + $3.75 = **$5.55**, and this number
now holds as an actual upper bound, not the no-race estimate an earlier draft of this section
computed under a check that could be raced past it. Uncapped, the same 75 calls could instead be
part of an unbounded retry storm — every one of 300 escalated items exhausting `maxAttempts`
attempts against a persistently failing endpoint costs up to 300 × 5 × $0.05 = $75 in Sonnet
calls alone, on top of the $1.80 of Haiku extraction, with no ceiling from this design. The cap
turns that unbounded, silent overspend into a bounded, visible one, and names the cost of the
items it declines to resolve rather than hiding it.

### 6.4 A type gap this decision exposes

`insertReviewQueueEntry`'s own parameter type
(`src/server/resolver/queue.ts:25-31`, `InsertReviewQueueEntryParams`) requires
`resolverOutput: ResolverResolution` — not optional, not nullable. That function cannot
represent "this item was deliberately never sent to Sonnet." The column it writes to,
`review_queue.resolver_output`, is already nullable at the database level
(`schema.ts:334`, `jsonb("resolver_output")`, no `.notNull()`) — the gap is in the TypeScript
contract, not the schema.

**Requirement for LH-041, not optional:** either widen `insertReviewQueueEntry`'s
`resolverOutput` parameter to `ResolverResolution | null`, or add a small sibling function for
the cap-skip case. Either way, add a `resolver_skip_reason` column (nullable text or a small
enum, e.g. `'ESCALATION_CAP_EXCEEDED'`) — its own numbered migration — so a `NULL`
`resolver_output` means exactly one thing rather than conflating "genuinely never attempted, by
design" with any other null state a future change might introduce. Name the state; do not let
absence stand in for it.

---

## 7. Partial-failure semantics

### 7.1 The decision table

| Situation | Queue-item outcome | `batchJobs` effect | Job-level effect |
|---|---|---|---|
| Extraction succeeds, router **PASS** | `EXTRACT` row → `DONE` | `processedCount++`, `autoVerifiedCount++` | none |
| Extraction succeeds, router **FAIL** | `EXTRACT` row → `DONE` | `processedCount++`, `autoVerifiedCount++` | none — see the note below the table before reading this row as "compliant" |
| Extraction succeeds, router REVIEW, resolver resolves it | `EXTRACT` → `DONE`, `RESOLVE` → `DONE` | `processedCount++` (at `EXTRACT` `DONE`), `resolvedBySonnetCount++` (at `RESOLVE` `DONE`) | none |
| Extraction succeeds, router REVIEW, resolver says needs-human | `EXTRACT` → `DONE`, `RESOLVE` → `DONE` | `processedCount++`, `needsHumanCount++` | none |
| Resolve-worker about to call Sonnet (first attempt or a retry), `sonnet_call_count` reservation returns zero rows (§6.2) | `RESOLVE` → `DONE`, no Sonnet call this attempt or ever for this item | `processedCount++` already counted at `EXTRACT` `DONE`; `needsHumanCount++` | none — batch summary shows the cap message |
| Extraction throws a retryable error, attempts < `maxAttempts` | Row released to `PENDING`, `available_at` pushed forward | no change yet | none |
| Extraction throws a retryable error, attempts = `maxAttempts` | `EXTRACT` → `FAILED`, `last_error` set | `processedCount++`, `failedCount++` | none — other items continue |
| Extraction throws a non-retryable error (corrupt image) | `EXTRACT` → `FAILED` immediately | `processedCount++`, `failedCount++` | none |
| Resolver call throws, attempts < `maxAttempts` | `RESOLVE` row released to `PENDING` | no change yet | none |
| Resolver call throws, attempts = `maxAttempts` | `RESOLVE` → `FAILED` | `failedCount++` **only** — `processedCount` already incremented when this label's `EXTRACT` item reached `DONE` (the row above); incrementing it again here would double-count one label and could push `processedCount` past `totalCount`, which `batch_jobs_processed_count_bounded` (`schema.ts:112-115`) would then reject | none — the `verifications` row from the `EXTRACT` phase still exists with `verdict = REVIEW`; a human can review the extracted fields even without a resolver suggestion |
| Worker process crashes mid-claim | Lease expires, another worker reclaims it (§3.2) | no change | none — invisible to the batch except a latency delay |
| Whole-batch setup fails before `RUNNING` (should not happen — LH-040 validates the manifest first) | n/a | n/a | `batchJobs.status = FAILED` |
| Every queue item for the batch reaches `DONE` or `FAILED` | n/a | n/a | `batchJobs.status = COMPLETED`, `completedAt` set |

**Two different things both got called "cap" before this round, and the table above now keeps
them apart by name.** `maxAttempts` (§5.2) bounds how many times *one item* retries after a
transient failure — a per-item concern, unrelated to money except in aggregate. The escalation
cap (§6) bounds how many Sonnet calls *the whole batch* may attempt, across every item and every
retry — a per-batch spend concern. An item can exhaust its own `maxAttempts` with the batch-wide
cap nowhere near full, and the batch-wide cap can stop an item's Sonnet call before that item's
own `maxAttempts` is anywhere close to exhausted (the new row above). Both are real, both matter,
and conflating them under one word is exactly the ambiguity this table no longer has.

**`processedCount` counts `EXTRACT`-phase conclusions, exactly once per label — never a second
time for whatever the label's own `RESOLVE` phase later does.** It answers "how many labels has
this batch finished reading," not "how many labels are fully settled, escalation included." The
stronger fact — every phase of every label is done — is what job-level `COMPLETED` (§7.2)
requires, checked against the queue items directly, not against this one counter.

**`autoVerifiedCount` bundles PASS and FAIL together, and that reading needs to be stated, not
assumed.** Nothing in `batchJobs`' own schema names a separate counter for "the router
determined this label non-compliant, on its own, no escalation needed" — only
`autoVerifiedCount`, `resolvedBySonnetCount`, `needsHumanCount`, and `failedCount` exist. Read
literally, "auto-verified" means *verified automatically* — decided without Sonnet or a human,
which is true of a router FAIL exactly as it is true of a router PASS — not *verified as
compliant*. That reading is defensible, and this document adopts it rather than inventing a new
column. But it means `autoVerifiedCount` alone cannot answer "how many labels passed," and
LH-042's results summary must not present it as though it can — a batch showing "180
auto-verified" could include labels the router flagged as clearly non-compliant. LH-042 should
compute a PASS/FAIL split from `verifications.verdict` directly, which already carries that
distinction, and reserve `autoVerifiedCount` for what it actually measures: throughput without
escalation, the same "how much needed no second look" question CP-1 §8.4's own segmentation
asks for the warning subsystem.

### 7.2 What "the batch finished" means

**A batch is `COMPLETED` when every one of its queue items has reached a terminal state — `DONE`
or `FAILED` — regardless of how many items failed.** `COMPLETED` is not a claim that every label
passed, or even that every label was read; it is a claim that nothing is still in flight. This
is the concrete answer to the brief's own question, and it follows directly from `enums.ts`'s
own comment on `BATCH_JOB_STATUSES`: a single item's failure is scoped to that item
(`failedCount`), never escalated to the job's own `status`. **A worker crash and restart is not
a job failure either** — it is exactly the situation the persistent, atomically-claimable queue
exists to survive. `batchJobs.status = FAILED` is reserved for the case the job never legitimately
started at all, which LH-040's own pre-flight manifest validation is designed to prevent from
ever reaching a `RUNNING` batch in the first place.

### 7.3 What a failed item looks like downstream

A `FAILED` `EXTRACT` item never produces a `verifications` row — correctly, because
`verifications`' own documented contract (§2.1) is that a row exists only once the cascade
*has* produced a result, and a failed extraction never did. **Recommendation, stated as a
constraint rather than a suggestion:** do not work around this by inserting a placeholder or
error `verifications` row. That would contradict an invariant the existing schema already
states plainly, just to make one query simpler. `batch_queue_items.last_error`, joined on
`batchJobId` + `applicationId`/`labelImageId`, is the single source of truth LH-042's results
table reads for a failed row's status text — a purpose-built column for exactly this purpose,
not a repurposed one.

---

## 8. Worked example — 200 labels, five workers, one failure, one escalation

1. **Upload.** LH-040 pairs a 200-row CSV against 200 images. One `batch_jobs` row is created
   (`status = PENDING`, `totalCount = 200`), with 200 `applications` rows, 200 `label_images`
   rows, and 200 `batch_queue_items` rows (`kind = EXTRACT`, `status = PENDING`).
2. **Start.** `batch_jobs.status → RUNNING`, `startedAt` set. One warm-up request fires first —
   CP-1 §7.3's own recommendation, carried forward here — so the first real claim does not pay
   the structured-output schema's one-time compilation cost (CP-1 §7.3: cached 24 hours once
   paid).
3. **Steady state.** The claim query's own `bj.status = 'RUNNING'` join (§3.1) means none of
   this could start before step 2 set it — the ordering above is enforced, not assumed. Five
   extract-workers each run §3.1's claim query, moving five rows to `CLAIMED`, each with its own
   fresh `claim_token`; 195 remain `PENDING`. As each worker finishes a label, it runs §3.2's
   completion guard — the conditional `UPDATE ... WHERE claim_token = $myClaimToken AND
   status = 'CLAIMED'` — and only on a successful guard does the same transaction write
   `verifications` + `field_results`
   (+ `review_queue` and a new `RESOLVE` `batch_queue_items` row, if the router said REVIEW),
   mark its `EXTRACT` row `DONE`, and update `batchJobs` counters, all atomically. The worker
   then claims the next available row. A guard that returns zero rows — this worker's lease
   already expired and someone else has the item — rolls the whole transaction back instead;
   nothing above gets written twice.
4. **Label #47 fails.** A worker claims it; the Haiku call returns a 529. Retryable (§5.1),
   `attempts = 1`, delay ≈ 1–2 seconds plus jitter (§5.2). The row releases to `PENDING` with
   `available_at` pushed forward; the worker claims a different item immediately rather than
   waiting. Label #47 is retried on a later pass — by this worker or another, it does not
   matter which. Say it fails four more times (`attempts = 5`, the proposed `maxAttempts` from
   §5.2): on the fifth failure, `batch_queue_items` marks it `FAILED`, `last_error` records the
   last error's
   message, `processedCount` and `failedCount` both increment. The batch keeps going. LH-042's
   results table shows label #47 with a failed status and the stored reason — never silently
   dropped (TH-R20).
5. **Label #112 escalates.** A worker extracts it successfully; the deterministic router finds
   a warning near-miss (distance 1–2, CP-2 §5.5's band) and returns `labelVerdict = REVIEW`,
   `headlineReason = WARNING_MISMATCH`. The worker inserts `verifications`
   (`resolutionPath: "EXTRACTOR_ONLY"`, matching `verify/route.ts`'s own pattern — see §7.3 for
   why that value is correct even here) and `field_results`, and inserts a new
   `batch_queue_items` row (`kind = RESOLVE`, `verification_id` = the new row's id,
   `resolver_input` = the snapshotted `{ schemaVersion: "1", extraction, router, flaggedFields }`,
   §2.3). The `EXTRACT` item is marked `DONE`; `processedCount` increments. The escalation itself
   has not resolved yet — that is a separate unit of work.
6. **Resolution.** One of the (proposed) two resolve-workers claims label #112's `RESOLVE` row —
   its own fresh `claim_token`, same as any other claim. Before calling Sonnet, it runs §6.2's
   atomic reservation (`UPDATE batch_jobs SET sonnet_call_count = sonnet_call_count + 1 WHERE
   id = $batchJobId AND sonnet_call_count < $capThreshold RETURNING sonnet_call_count`) — this
   batch is nowhere near its 75-call budget, so the reservation succeeds. The worker rebuilds
   `ResolverInput` from the `schemaVersion: "1"` snapshot, calls `resolveEscalatedLabel`, and —
   inside that already-built function — `findExistingReviewQueueEntry` finds nothing (this is
   the first attempt for this verification), Sonnet runs, and `insertReviewQueueEntry` writes the
   `review_queue` row with the real `resolverOutput`. The worker then runs §3.2's completion
   guard against its `RESOLVE` row, keyed to its own `claim_token`; it succeeds (this worker
   still holds the lease), so in the same transaction it updates `verifications.resolutionPath`
   to `"EXTRACTOR_RESOLVER"` (the value's own evident purpose, per `verify/route.ts:225-227`'s
   comment: "LH-014's resolver updates this once it consumes the review_queue row") and marks
   the `RESOLVE` item `DONE`. `resolvedBySonnetCount` or `needsHumanCount` increments, depending
   on the resolver's own disposition — `processedCount` does not increment again here; it
   already counted this label when the `EXTRACT` item reached `DONE` in step 5.
7. **Completion.** Once all 200 `EXTRACT` items and every `RESOLVE` item they spawned have
   reached `DONE` or `FAILED` — some number of items PASS or FAIL outright, some escalate and
   resolve, label #47 sits `FAILED` with a reason, label #112 sits resolved — `batchJobs.status →
   COMPLETED`, `completedAt` set. `processedCount = 200`: every one of the 200 labels' `EXTRACT`
   phase concluded, label #47's included (§7.1's own point — a failed item still counts as
   processed). `failedCount = 1`. The remaining 199 split across `autoVerifiedCount`,
   `resolvedBySonnetCount`, and `needsHumanCount` however the batch actually resolved — that
   split is a separate, derived summary LH-042 computes for its results table, not a restatement
   of `processedCount`, and label #47's failure reason is one click away.

---

## 9. A gap found outside this ticket, named rather than fixed

Reading the already-shipped single-label verify route (`src/app/api/verify/route.ts:244-249`)
to confirm this design's transaction shape turned up something this ticket does not own but
should not stay quiet about. When a single-label verify produces `labelVerdict = REVIEW`, the
route inserts a `review_queue` row and returns — it never calls `resolveEscalatedLabel`. Nothing
else in this codebase calls it either, outside its own test files. **A REVIEW-verdict
single-label verification's `review_queue` row appears to sit with `resolver_output: NULL`
indefinitely, with no background process that ever calls Sonnet for it, unless a human disposes
of it through LH-050's review-queue UI having never seen a resolver suggestion at all.**

PRD §3.6 names one "background worker" process, singular — not "a batch worker" and, separately,
some other single-label resolution mechanism. That phrasing reads as one shared process, and
this document's `batch_queue_items` design is scoped narrowly to batch-originated work
(`batchJobId` not null) specifically because generalizing it to also drive single-label
resolution is a real design question this ticket's brief does not ask this document to answer,
and CLAUDE.md's own scope discipline says not to answer it unasked.

**This is not fixed here.** It is named precisely, with the file and line that show it, so it
does not read as an oversight later. §12 carries it forward as an open question.

---

## 10. What this document does not decide

- **The exact worker-pool size, as a measured number.** §4.4's ~5 (extract) and ~2 (resolve)
  are proposed defaults, made configurable specifically because they are not measured yet.
  LH-031 measures them for real.
- **Local-compute concurrency limits** (`sharp`, `tesseract.js`, Postgres connection pool size
  under 5–7 concurrent workers). Named as the more likely real ceiling in §4.4; not quantified
  here.
- **The `ON CONFLICT DO NOTHING` hardening to `resolver/queue.ts`.** Recommended in §3.3 as a
  follow-up; not built here, and not required for this design's primary defence to hold.
- **The single-label resolution trigger gap (§9).** Named, not designed around.
- **The batch progress UI and results table's visual design.** LH-042 owns the screen; this
  document supplies the states it must represent (§7.1's table) and the data it reads
  (`batchJobs` counters, `batch_queue_items.last_error`).
- **CSV parsing, filename pairing, and the malformed-CSV error state.** LH-040 owns all three;
  this document assumes a `batch_jobs` row only exists once pairing has already succeeded.
- **Whether "~5" is one pool or two (§4.5).** A genuine ambiguity in the PRD's own wording; this
  document states a recommendation and carries the fork to §12, not a silent resolution.

---

## 11. Defend it — Q&A

Read each question. Answer it yourself. Then read the answer.

---

**Q1. Why 5 workers and not 20, if the rate-limit math in §4.3 shows Anthropic would allow far
more?**

Because rate limits turned out not to be the binding constraint — and finding that out is more
useful than assuming it. The real reasons for a small pool are named in §4.4: this project's
own account may sit in an unquantified, below-Start tier (§4.2's Evaluation-tier caveat);
`sharp` and `tesseract.js` compete for CPU on the same instance as the network calls, and that
ceiling has never been measured; a small pool bounds how fast a bug can compound; and every
other tunable number in this project — confidence thresholds, the OCR floor, the near-miss band
— shipped as a proposed starting value with a named ticket to replace it with a measurement.
Worker concurrency gets the same treatment, not a special exemption because a PRD sentence
already put a number on it.

---

**Q2. What happens if Anthropic rate-limits the whole batch mid-run?**

A worker sees a 429, backs off per §5.2 using the API's own `retry-after` header, and releases
its claim rather than blocking on the sleep. Because the limit is organization-wide (§4.2), the
other workers are likely close behind — §5.3's pool-wide cooldown is what stops all five from
independently re-discovering the same exhausted budget within the next second. The batch does
not fail. It slows down for the cooldown window, then resumes. `batchJobs.status` never reflects
a rate-limit event at all — from the job's point of view, a 429 is indistinguishable from any
other retryable failure, which is the point: one policy, in one place (§5.4), not a special case
for this particular error type.

---

**Q3. Can two workers double-process the same item?**

Under normal operation, no — §3.1's atomic claim (`FOR UPDATE SKIP LOCKED`) makes it structurally
impossible for two workers to hold the same queue row's lease at once. Under lease expiry during
a call that is slow but still alive, yes, narrowly — §3.3 names this precisely rather than
claiming the design closes it completely, because it does not, on its own. The recommended
follow-up (TRO-506's own suggested `ON CONFLICT DO NOTHING` reservation) would close even that
window, and is scoped as a small, separate change because it also touches an already-shipped
UI's read query (§3.3's own reasoning).

---

**Q4. Why a separate Sonnet sub-queue at all? Why not let extract-workers also pick up REVIEW
items when they run out of extraction work?**

Two reasons. First, PRD §3.5 states it as a rule: "Sonnet workers consume only the review
sub-queue" — this document implements the rule that exists, not a more convenient one. Second,
and more concretely: Haiku and Sonnet draw from independent rate-limit buckets (§4.2, point 2).
A shared pool that sometimes calls Haiku and sometimes Sonnet would let a burst of resolve work
crowd out extraction throughput, or vice versa, for no reason tied to either model's actual
capacity — the two queues have different arrival patterns, different per-call costs, and
different failure modes (§5.1's table applies identically to both, but the volumes differ by
roughly 6-to-1 under CP-1's own escalation assumption). Separate, independently-sized pools
means each queue's concurrency can be tuned against its own real load, once LH-031 measures it,
without one queue's tuning accidentally starving the other.

---

**Q5. Why does Sonnet only ever see escalations, never every label — doesn't that risk missing
something Haiku got wrong?**

That is TH-R19's whole architecture, not a batch-specific rule — this document does not change
it, and confirms it holds under concurrency. The resolve sub-queue is fed by exactly one event:
a `verifications` row landing with `verdict = REVIEW`, itself produced only by the deterministic
router (CP-1 §5). No code path in this design lets a worker call `resolveEscalatedLabel` for a
label the router already passed or failed outright — `resolveEscalatedLabel` itself refuses at
runtime if `input.router.labelVerdict !== "REVIEW"` (`ResolverNotEscalatedError`,
`resolver/index.ts:58-66`), so even a bug in this document's own queue-population logic would
fail loudly rather than silently running Sonnet on a PASS.

---

**Q6. What does "the batch finished" mean when some items failed?**

Precisely: every queue item reached a terminal state (§7.2). `COMPLETED` says "nothing is still
running," not "everything succeeded." A batch with 3 failed items out of 300 is `COMPLETED`
with `failedCount = 3` — the same status a batch with zero failures gets. The distinction a
human needs lives in the counters and in `batch_queue_items.last_error`, not in a second status
value, because a second value ("completed with errors") would just be a less precise restatement
of the same counters LH-042 already has to show.

---

**Q7. Why a new table instead of deriving "pending work" from a `LEFT JOIN` against
`verifications`?**

Because a computed view cannot hold a claim. §2.1 shows why `verifications` itself cannot be the
queue: it only records finished work. A `LEFT JOIN … WHERE verifications.id IS NULL` would find
unstarted work, but it has nowhere to write "worker 3 has this one right now, until 10:04:12" —
and without that, two workers running the same join at the same moment would both see the same
"unstarted" row and both start it. `batch_queue_items` exists specifically to hold the one piece
of state a derived view cannot: who has this row, and until when. It also gives failed items a
place to record why (§7.3) — a second, independent reason a view alone does not suffice.

---

**Q8. What is the actual cost exposure of a pathological batch, with the escalation cap in
place?**

About $5.55 for a 300-label batch, worst case — capped at `ceil(0.25 × 300) = 75` Sonnet call
attempts by §6.2's atomic reservation, however those 75 calls split across distinct labels and
retries. Uncapped, an unbounded retry storm (every escalated item exhausting `maxAttempts = 5`
against a persistently failing endpoint) reaches $76.80, not a smaller number an earlier draft of
this document computed by assuming one attempt per escalated label and ignoring retries — both
figures derived in §6.3 and Appendix B from CP-1's own per-label cost assumptions. $5.55 is an
actual bound, not an estimate: §6.2's atomic reservation counts every Sonnet call attempt,
including retries, so there is no longer a race that lets total calls exceed the threshold — an
earlier draft of this section checked settled outcomes instead, which a batch where every attempt
happened to fail could have driven arbitrarily high. The cap does not eliminate the cost of a bad
batch; it bounds it, and it converts silent overspend into a visible count of items the tool
declined to spend further on, with the batch summary saying so (§6.2) — matching PRD §12's own
stated mitigation almost word for word.

---

**Q9. This document reuses `review_queue` for the Sonnet sub-queue instead of adding a second
escalation table. Why?**

Because `review_queue` already has the right shape and the right constraint —
`review_queue_verification_id_unique` (`schema.ts:348-350`) already guarantees at most one row
per verification, which is exactly the property a resolve queue needs. Adding a second table
that also tracks "does this verification need resolving" would create two sources of truth for
the same fact, and nothing good comes from that when they can drift. What `review_queue` lacks —
a claimable, leased, retryable work-item shape — is what `batch_queue_items`'s `kind = RESOLVE`
rows supply, without duplicating what `review_queue` already does correctly.

---

## 12. Open questions for Troy

Real forks. Each has a recommendation and the cost of choosing wrong.

**1. Is "~5" one shared pool, or extract and resolve as two separately-sized pools?**
§4.5 found the PRD's own wording genuinely ambiguous between the two readings.
*Recommendation:* two pools — 5 extract, 2 resolve, both proposed. It matches "Sonnet workers
consume only the review sub-queue" read as naming a distinct set of workers, and it lets each
pool's size be tuned against its own measured load later without touching the other.
*Cost of choosing wrong:* a single shared pool of 5 that must split its attention between two
queues of very different per-item cost and duration could let a burst of slow Sonnet calls
starve extraction throughput — precisely the failure mode a dedicated sub-queue exists to
prevent.

**2. Should the `ON CONFLICT DO NOTHING` reservation hardening (§3.3) land now, alongside
LH-041, or as its own follow-up ticket?**
*Recommendation:* its own ticket, because it also requires a small, coordinated change to
`review_queue/list.ts`, on a UI that already merged (LH-050), and because LH-041 now ships a
required, in-scope stopgap that changes what "deferred" costs: a resolve-worker that loses the
check-then-insert race must catch the conflict and complete idempotently from the winner's row
(§3.3), so the residual gap left open by deferring is "two Sonnet calls get paid for," not "an
item is wrongly reported failed." *Cost of choosing wrong:* deferred, the wasted-money window
from §3.3 stays open — narrow, but real, and still exactly the shape of thing this checkpoint
exists to catch rather than defer indefinitely, even though the required stopgap keeps it from
corrupting a result.

**3. Is 25% the right escalation-cap threshold?**
§6.1 adopts CP-1 Q7's own proposed number rather than inventing a new one; §6.2's rework changed
what the number bounds (Sonnet call attempts, not distinct escalated labels) without changing its
value. *Recommendation:* keep it, and let it become a measured, evidence-backed number the same
way the confidence thresholds and the OCR floor are meant to. *Cost of choosing wrong:* too low,
and a batch with a genuinely hard image set (glare, low light — TH-R10's own territory) burns
through the call budget on retries alone before every escalated label gets even one attempt; too
high, and the cost protection in §6.3 weakens toward the uncapped worst case.

**4. Should the worker-pool sizes be environment variables from day one, or hard-coded
constants with a follow-up ticket to externalize them?**
§4.4 recommends environment variables specifically because of the Evaluation-tier uncertainty in
§4.2. *Recommendation:* environment variables from day one — it costs nothing extra to build
LH-041 that way, and it is the only lever available if the real deployed account's limits turn
out to sit below the published Start tier. *Cost of choosing wrong:* a hard-coded 5 that turns
out to be wrong for the real account needs a code change and a redeploy to fix, mid-interview-
prep, instead of a config change.

**5. Does the single-label REVIEW path (§9) need its own resolution trigger, and if so, should
it reuse this design's worker rather than get a separate mechanism?**
A real gap, found while verifying this design against the already-shipped verify route — not
speculative. *Recommendation:* file it as its own ticket once this one lands; scope it to decide
whether the background worker process PRD §3.6 already names (singular) should poll
`review_queue WHERE resolver_output IS NULL AND batch job is absent` the same way this design's
resolve-workers poll `batch_queue_items`, reusing the claim logic rather than inventing a second
one. *Cost of choosing wrong:* left alone, every single-label REVIEW verdict sits in the review
queue with no resolver suggestion ever offered to the human who eventually opens it — not
incorrect, since a human can still dispose of it, but a quieter, less useful review-queue entry
than the one PRD §5's "Resolved by Sonnet annotations" language promises.

**6. Should a batch's escalation cap apply per batch only, or should there be an
organization-wide daily cap across concurrently running batches too?**
CP-1 Q7 and this document both frame the cap as per-batch, matching PRD §12's own wording
("further REVIEW labels go straight to the human queue"). *Recommendation:* per-batch only, for
the prototype — an organization-wide cap is a real feature but a different one (it needs its
own state, shared across every batch, and its own UI to show remaining budget), and TH-R23 asks
for a working core before that kind of ambition. *Cost of choosing wrong:* two or more large
batches running concurrently could, in principle, each individually stay under their own 25%
cap while their combined Sonnet spend is still large — a scenario this document does not size,
because it has not been asked to.

---

An agent wrote this document. An agent cannot clear this gate — the mechanism that removed
CP-3's block on *dispatch* did not touch who gets to accept its *design* (see this document's
opening banner). Troy must still read it, run the Q&A in §11, and decide the forks in §12.
Say the words. Acknowledgment is what makes this design one Troy is willing to defend live, not
one an agent merely produced. Silence does not do that, whatever the dispatch policy allows to
proceed without it.

---

## Appendix A — walkthrough checklist

Tick these during the session.

- [ ] **What's actually queuing.** Read §2.1–§2.3. Confirm why `verifications` cannot be the
      queue, confirm the `batch_queue_items` columns, and confirm why the Sonnet sub-queue
      reuses `review_queue` instead of a second escalation table.
- [ ] **The atomic claim.** Read §3.1's SQL. Confirm `FOR UPDATE SKIP LOCKED` is the mechanism,
      not an application-level check.
- [ ] **TRO-506.** Read §3.3 in full. Confirm the primary-defence / residual-risk / recommended-
      follow-up structure, and confirm this document does not claim the residual risk is closed.
- [ ] **The rate-limit arithmetic.** Read §4.2 and §4.3. Confirm the Start-tier numbers against
      the live URL if you want to re-verify them yourself. Confirm the honest conclusion: rate
      limits are not what makes 5 the right number.
- [ ] **The real reasons for 5.** Read §4.4. Confirm the environment-variable recommendation.
- [ ] **Backoff.** Read §5.1–§5.4. Confirm the retryable/non-retryable classification and the
      "worker never sleeps holding a claim" rule.
- [ ] **The escalation cap.** Read §6 in full — this settles CP-1's own open question 6. Confirm
      the threshold, the denominator, and the cost arithmetic in §6.3.
- [ ] **Partial-failure semantics.** Read §7.1's table and §7.2. Say out loud, in your own words,
      what "the batch finished" means.
- [ ] **The worked example.** Read §8 end to end. Confirm it uses the design from §2–§7
      consistently, not a shortcut.
- [ ] **The single-label gap.** Read §9. Confirm you understand it is named, not fixed, and why.
- [ ] Run the Q&A in §11. Note any question that did not have a good answer.
- [ ] Decide the six open questions in §12.
- [ ] Say the words.

---

## Appendix B — retrieval log

**The rate-limit table (§4.2).** Retrieved 2026-08-11 via a live fetch of
`https://platform.claude.com/docs/en/api/rate-limits`. The page's own Start/Build/Scale tables
for Claude Haiku 4.5 and Claude Sonnet 5 are reproduced verbatim in §4.2. Re-open the URL to
check them; the page carries no version number or "last updated" date of its own to cite beyond
the retrieval date given here.

**The extraction/resolution throughput arithmetic (§4.3).** Inputs, each named at the point of
use: CP-1 §7.1's assumed per-label token counts (extractor ~2,800 in / ~600 out; resolver
~6,500 in / ~2,000 out — CP-1's own words: "an assumption, not a measurement"), PRD §3.8's
*target* ~2.5s Haiku call duration, and CP-1's own assumed 15% and 40% escalation rates. The
arithmetic itself:

```text
extractor calls/min at N workers  = N * (60 / 2.5)
resolver arrival calls/min        = extractor calls/min * escalation_rate
utilization on any axis           = (calls/min * tokens_or_1) / tier_limit
```

Substituting N=5, escalation_rate=0.15 and 0.40, against the Start-tier limits in §4.2,
reproduces every percentage in §4.3's two tables. This is arithmetic over stated, cited inputs —
**derived**, not measured — and it inherits CP-1's own "assumption, not measurement" label on
the token counts it starts from.

**The escalation-cap cost arithmetic (§6.3).** Same method as CP-1 §7.2's own 300-label-batch
derivation, extended to the capped case: `300 * $0.006 + min(sonnet_call_attempts, ceil(0.25 *
300)) * $0.05`, where `sonnet_call_attempts` counts every reserved call — first attempts and
retries alike (§6.2) — not distinct escalated labels. `ceil(0.25 * 300) = 75` is the hard ceiling
§6.2's atomic reservation enforces, so the capped term is `min(sonnet_call_attempts, 75)`, which
is at most `75` by construction: `$1.80 + $3.75 = $5.55`. Uncapped, an unbounded retry storm —
every one of 300 escalated items exhausting `maxAttempts = 5` — reaches `$1.80 + 300 * 5 *
$0.05 = $76.80`, not the $15.30 figure an earlier draft of this appendix computed by assuming one
attempt per escalated label; that assumption undercounted exactly the retries §5's own backoff
design allows. Every number here is **derived** from CP-1's own per-call cost estimates, which
are themselves derived from published prices over assumed token counts — two layers removed from
a measurement, and labelled that way throughout this document rather than presented as more
certain than they are.

**Existing code cited by file and line, for re-checking:**

- `src/lib/db/schema.ts` — `verifications` (242-271), `batchJobs` (75-133), `reviewQueue`
  (326-364), the unique index on `verificationId` (348-350).
- `src/lib/db/enums.ts` — `LABEL_VERDICTS`, `BATCH_JOB_STATUSES`, `RESOLUTION_PATHS` doc
  comments.
- `src/server/resolver/index.ts` — `DEFAULT_CLIENT_MAX_RETRIES` (line 38) and its full comment
  (lines 25-37), `ResolverNotEscalatedError` (58-66), the pre-check call site (104-125).
- `src/server/resolver/queue.ts` — `insertReviewQueueEntry` (51-64),
  `findExistingReviewQueueEntry` (173-189), the doc comments on both.
- `src/server/resolver/types.ts` — `ResolverInput` (87-105).
- `src/server/extractor/index.ts` — `DEFAULT_CLIENT_MAX_RETRIES` (line 38) and its comment
  (lines 25-37).
- `src/server/review-queue/list.ts` — `listUnresolvedReviewQueue` (49-96), the
  `disposition IS NULL` filter (line 77).
- `src/app/api/verify/route.ts` — the transaction that inserts `verifications`, `fieldResults`,
  and `reviewQueue` (192-249), and the `resolutionPath: "EXTRACTOR_ONLY"` comment (225-227).

**TRO-506**, `https://linear.app/troysatchell/issue/TRO-506/batch-workers-could-double-pay-for-the-same-sonnet-resolution` —
retrieved via the Linear MCP tool, 2026-08-11. Full text quoted and addressed in §3.3.
