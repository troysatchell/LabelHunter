import { relations, sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  batchJobStatusEnum,
  batchQueueItemKindEnum,
  batchQueueItemStatusEnum,
  beverageTypeEnum,
  fieldNameEnum,
  fieldVerdictEnum,
  labelVerdictEnum,
  resolutionPathEnum,
  reviewDispositionEnum,
  reviewReasonEnum,
} from "./enums";

// Re-export every enum (types, value lists, and the pgEnum objects
// themselves). Two reasons: callers importing from "./schema" get the full
// vocabulary in one place, and — the load-bearing one — drizzle-kit's
// `generate` command only discovers pgEnum/pgTable objects that are visible
// on the configured schema file's OWN exports. An enum that is merely
// imported and used inside a column definition, but never re-exported,
// silently produces a migration with no `CREATE TYPE` for it: the table
// still references the type by name, so the migration fails on apply.
// Caught by generating this ticket's migration and reading the SQL before
// trusting it, per this repo's "claims carry provenance" rule.
export * from "./enums";

/**
 * `_meta` is a scaffold-only table: it exists to prove the migration
 * pipeline (drizzle-kit generate/migrate) works end-to-end against a real
 * Postgres database. It is not part of the product data model. Kept here
 * (not dropped) — it costs nothing and CI/the gate may still use it as a
 * migration-pipeline healthcheck.
 */
export const meta = pgTable("_meta", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
 * Product schema (PRD §3.6, ticket LH-002 / TRO-457).
 *
 * No PII anywhere (TH-R6). Every column below is alcohol-label compliance
 * data — brand names, ABV, warning text, image files, verdicts — or a
 * timestamp/status/count. There is no name, email, address, or other
 * identifier for a real person on any table, including `review_queue`:
 * a human's approve/reject disposition is recorded, but not who recorded
 * it — see the note on `reviewQueue` below.
 *
 * Primary keys use `generatedAlwaysAsIdentity()` (Postgres identity
 * columns), the modern replacement for `serial` recommended by Postgres
 * itself since v10; `_meta` above keeps `serial` because it predates this
 * ticket and is scaffold-only.
 *
 * All foreign keys cascade on delete: this is a prototype without a data-
 * retention requirement, and a `verifications` row (for example) is
 * meaningless once its `applications` row is gone.
 */

/** One row per batch upload (PRD §3.5). The batch-progress UI polls this
 * table's counts and `status`. */
export const batchJobs = pgTable(
  "batch_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    status: batchJobStatusEnum("status").notNull().default("PENDING"),
    totalCount: integer("total_count").notNull().default(0),
    processedCount: integer("processed_count").notNull().default(0),
    autoVerifiedCount: integer("auto_verified_count").notNull().default(0),
    resolvedBySonnetCount: integer("resolved_by_sonnet_count")
      .notNull()
      .default(0),
    needsHumanCount: integer("needs_human_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    // The per-batch Sonnet escalation cap (LH-041 / TRO-474, CP-3 §6).
    // Counts every reserved Sonnet call ATTEMPT for this batch — first
    // attempts and retries alike, reserved atomically before the call ever
    // happens (`reserveSonnetCall`, `../../server/batch-queue/escalation-cap.ts`)
    // — never settled outcomes alone. CP-3 §6.2's own correction: counting
    // only `resolvedBySonnetCount + needsHumanCount` cannot bound spend on a
    // batch where every Sonnet attempt happens to fail, since a failed
    // attempt increments neither counter.
    sonnetCallCount: integer("sonnet_call_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // `.$onUpdate()` is a drizzle-orm runtime default: it fills this column
    // on every `db.update()` call that does not set it explicitly. It does
    // NOT add a database trigger (drizzle-kit ignores it — see the drizzle
    // docs note on this API), so a write that bypasses the ORM would not
    // bump it. Every write path in this app goes through Drizzle, so this
    // is enough for the prototype; a real trigger would be the next step
    // if a second DB client ever appears.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("batch_jobs_status_idx").on(table.status),
    // Each counter is independently bounded to [0, totalCount] rather than
    // constrained to sum to totalCount/processedCount — the worker (LH-041)
    // updates one counter at a time, and a sum constraint would reject a
    // legal intermediate state between two separate UPDATEs.
    check("batch_jobs_total_count_non_negative", sql`${table.totalCount} >= 0`),
    check(
      "batch_jobs_processed_count_bounded",
      sql`${table.processedCount} >= 0 AND ${table.processedCount} <= ${table.totalCount}`,
    ),
    check(
      "batch_jobs_auto_verified_count_bounded",
      sql`${table.autoVerifiedCount} >= 0 AND ${table.autoVerifiedCount} <= ${table.totalCount}`,
    ),
    check(
      "batch_jobs_resolved_by_sonnet_count_bounded",
      sql`${table.resolvedBySonnetCount} >= 0 AND ${table.resolvedBySonnetCount} <= ${table.totalCount}`,
    ),
    check(
      "batch_jobs_needs_human_count_bounded",
      sql`${table.needsHumanCount} >= 0 AND ${table.needsHumanCount} <= ${table.totalCount}`,
    ),
    check(
      "batch_jobs_failed_count_bounded",
      sql`${table.failedCount} >= 0 AND ${table.failedCount} <= ${table.totalCount}`,
    ),
    // ceil(0.25 * totalCount) — the escalation-cap threshold (CP-3 §6.1) —
    // is at most totalCount for every totalCount >= 0, so a call count that
    // never exceeds the cap can never exceed totalCount either. Same
    // defensive-bound pattern as every other counter on this table.
    check(
      "batch_jobs_sonnet_call_count_bounded",
      sql`${table.sonnetCallCount} >= 0 AND ${table.sonnetCallCount} <= ${table.totalCount}`,
    ),
  ],
);

/**
 * The application-side data for one label verification: the values a TTB
 * agent enters or uploads, which a Haiku extraction result gets compared
 * against (PRD §3.2/§3.3). `batchJobId` is set when this row came from a
 * batch CSV row; null for a single-label verify.
 *
 * No per-application government-warning field: the warning subsystem
 * (PRD §3.4) always compares extracted text against one fixed statutory
 * string, not a value that varies by application, so there is nothing
 * application-specific to store here.
 */
export const applications = pgTable(
  "applications",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    batchJobId: integer("batch_job_id").references(() => batchJobs.id, {
      onDelete: "cascade",
    }),
    beverageType: beverageTypeEnum("beverage_type").notNull(),
    brandName: text("brand_name").notNull(),
    classType: text("class_type").notNull(),
    // Raw string as entered (e.g. "45% ALC/VOL (90 PROOF)") plus the parsed
    // numeric values, mirroring the extractor's value+evidence shape so the
    // router can compare like with like (PRD §3.3).
    alcoholContentRaw: text("alcohol_content_raw"),
    abvPercent: numeric("abv_percent", { precision: 5, scale: 2, mode: "number" }),
    proof: numeric("proof", { precision: 5, scale: 2, mode: "number" }),
    netContentsRaw: text("net_contents_raw"),
    netContentsValue: numeric("net_contents_value", {
      precision: 10,
      scale: 3,
      mode: "number",
    }),
    netContentsUnit: text("net_contents_unit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("applications_batch_job_id_idx").on(table.batchJobId)],
);

/**
 * Uploaded label image metadata. `applicationId` links a single-label
 * upload straight to its application; `batchJobId` links a batch upload
 * before per-row pairing happens (PRD §3.5 — CSV rows pair to images by
 * filename before the job starts). At least one of the two must be set.
 */
export const labelImages = pgTable(
  "label_images",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    applicationId: integer("application_id").references(
      () => applications.id,
      { onDelete: "cascade" },
    ),
    batchJobId: integer("batch_job_id").references(() => batchJobs.id, {
      onDelete: "cascade",
    }),
    storagePath: text("storage_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("label_images_application_id_idx").on(table.applicationId),
    index("label_images_batch_job_id_idx").on(table.batchJobId),
    // Batch pairing looks up an image by (batch, filename) — PRD §3.5.
    // UNIQUE, not just indexed: two images in the same batch sharing a
    // filename would make that lookup return more than one candidate,
    // which is exactly the "unmatched/ambiguous" case PRD §3.5 requires
    // reporting before the job starts, not silently accepting. NULL
    // `batchJobId` (single-label images) is exempt — Postgres treats each
    // NULL as distinct, so single-label filenames are never deduplicated
    // against each other here.
    uniqueIndex("label_images_batch_filename_unique").on(
      table.batchJobId,
      table.originalFilename,
    ),
    check(
      "label_images_belongs_to_something",
      sql`${table.applicationId} IS NOT NULL OR ${table.batchJobId} IS NOT NULL`,
    ),
    // NOT enforced here: that a verification's application, image, and
    // batch job all belong to the same batch. A DB-level guarantee needs
    // either a trigger or composite foreign keys across all three tables —
    // real complexity that belongs with the code that creates verification
    // rows (LH-041's batch worker, behind the CP-3 batch-queue checkpoint),
    // not invented ahead of that design. Flagged in this ticket's report.
  ],
);

/**
 * A Postgres `bytea` column. drizzle-orm 0.45's `pg-core` has no built-in
 * `bytea` helper (checked against the installed package — no
 * `columns/bytea.*` file, unlike `text`/`jsonb`/etc), so this defines the
 * minimal one `labelImageBlobs` needs below. No `toDriver`/`fromDriver`
 * mapping functions: node-postgres already reads a `bytea` value back as a
 * `Buffer` (confirmed against the installed `pg`/`pg-types`/`postgres-bytea`
 * packages' own source — `postgres-bytea`'s parser returns `Buffer.from(...)`)
 * and already accepts a `Buffer` directly as a query parameter, so `data`
 * and `driverData` are the same `Buffer` on both sides — nothing to convert.
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The bytes for one uploaded label image (TRO-518). Split out from
 * `labelImages` rather than added as a column on it: `labelImages` rows are
 * read on every batch-progress poll and every worker claim (Drizzle
 * relations eager-load the whole row — see `extract-worker.ts`/
 * `resolve-worker.ts`), and none of those reads want a multi-hundred-
 * kilobyte blob riding along for free.
 *
 * Replaces `local-file-storage.ts` (deleted by this ticket), which wrote
 * each image to a directory on the running process's own filesystem.
 * `render.yaml` deploys `web` (writes the image) and `worker` (reads it
 * back) as two separate Render services with two separate disks, so a file
 * `web` wrote was never visible to `worker` once actually deployed. Postgres
 * is the one resource `render.yaml` already gives both services
 * (`DATABASE_URL`, same instance) — storing the bytes here removes the
 * cross-service gap with no new external dependency, no new credential, and
 * no new account (TRO-518's own hard constraint). See `db-image-storage.ts`
 * for the read/write functions and CHANGES.md's TRO-518 entry for the size/
 * scale/quota numbers behind this choice over an S3-compatible bucket.
 */
export const labelImageBlobs = pgTable("label_image_blobs", {
  // Plain `text`, not a Postgres `uuid` column, even though every value
  // this app writes IS a v4 UUID (`db-image-storage.ts`'s `saveLabelImage`
  // generates one with `randomUUID()`). A `uuid`-typed column makes
  // Postgres itself THROW ("invalid input syntax for type uuid") on a
  // lookup for a value that is not valid UUID syntax — and a stale
  // `labelImages.storagePath` value written under the pre-TRO-518
  // filesystem-storage regime (shape: "uploads/<uuid>-name.jpg") is exactly
  // that: not a bare UUID. `readLabelImage` must turn a lookup like that
  // into a clean "not found" (`LabelImageNotFoundError`, TH-R20's designed
  // 404), never an unhandled database error (standing rule 13) — a plain
  // `text` primary key gives that for free, since a non-matching lookup
  // just returns zero rows instead of raising a type error.
  storageKey: text("storage_key").primaryKey(),
  bytes: bytea("bytes").notNull(),
  // Diagnostic only — no code path reads this column back (the same
  // "opaque outside this module" contract `local-file-storage.ts`'s own
  // `storagePath` had). Lets a human reading this table with a Postgres
  // client tell which upload a row came from.
  originalFilename: text("original_filename").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One row per label-level verification, single or batch (PRD §3.3).
 * `batchJobId` is null for a single-label verification. The row records a
 * completed result: `verdict` and `resolutionPath` are set at insert time,
 * once the cascade has finished for this label.
 *
 * Not enforced at the database level: that `applicationId`, `labelImageId`,
 * and `batchJobId` here are mutually consistent (e.g. the image actually
 * belongs to this application, and both belong to this batch, when a batch
 * is set). See the matching note on `labelImages` above — same reason,
 * same call: that guarantee belongs with LH-041's batch worker, not this
 * schema ticket.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    labelImageId: integer("label_image_id")
      .notNull()
      .references(() => labelImages.id, { onDelete: "cascade" }),
    batchJobId: integer("batch_job_id").references(() => batchJobs.id, {
      onDelete: "cascade",
    }),
    verdict: labelVerdictEnum("verdict").notNull(),
    resolutionPath: resolutionPathEnum("resolution_path").notNull(),
    // LH-025/LH-026 (TRO-532/TRO-533), CP-2 §7.2/§7.3, TH-R9. The pixel-
    // measured bold advisory signal (`measureBoldSignal`,
    // `../../server/warning/bold-detect.ts`) for this verification's
    // government warning, stored exactly as that function returns it —
    // `{ signal, reason, ratio, splitFraction, prefixStrokeWidthPx,
    // bodyStrokeWidthPx }`. `null` means the signal was never measured for
    // this verification (no warning-region crop existed — e.g. region
    // detection found nothing), which is a DIFFERENT state from
    // `signal: "uncertain"` (a crop existed; the measurement itself could
    // not commit to bold or not-bold). A plain `jsonb` column, not five
    // separate columns: `BoldSignalResult`'s own shape already carries the
    // "reason is always present; the four numeric fields are null together
    // when no split was found" discipline standing rule 19 asks for, so
    // storing it as-is avoids re-deriving that same discriminated shape a
    // second time in SQL. Read back through a boundary check
    // (`get-verification-detail.ts`'s `parsePersistedBoldSignal`), never
    // trusted as typed just because this column declares `jsonb` — the
    // same "validate at the boundary" rule `reviewQueue.resolverOutput`
    // already follows for an untyped jsonb column.
    //
    // ADVISORY ONLY. This column is written after `routeLabel` has already
    // decided `verdict`, from the SAME `WarningComparatorResult`-adjacent
    // pipeline call but a SEPARATE return value that never reaches
    // `routeLabel` (`src/server/warning/index.ts`'s
    // `CompareGovernmentWarningFromImageResult`). Nothing reads this column
    // to decide a verdict, and nothing may ever be added that does
    // (`bold-detect.ts`'s own header comment; standing rule 10).
    boldSignal: jsonb("bold_signal"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("verifications_application_id_idx").on(table.applicationId),
    index("verifications_label_image_id_idx").on(table.labelImageId),
    index("verifications_batch_job_id_idx").on(table.batchJobId),
    index("verifications_verdict_idx").on(table.verdict),
  ],
);

/**
 * One row per field per verification (PRD §3.2/§3.3). `evidence` is
 * required, not optional: a bare extracted value with no verbatim source
 * text is a compliance gap, not a data-entry nicety (PRD §3.2). When a
 * field is absent from the label, `evidence` records that explicitly
 * (e.g. "not found on label") rather than being left null.
 */
export const fieldResults = pgTable(
  "field_results",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    verificationId: integer("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "cascade" }),
    fieldName: fieldNameEnum("field_name").notNull(),
    extractedValue: text("extracted_value"),
    evidence: text("evidence").notNull(),
    confidence: numeric("confidence", {
      precision: 3,
      scale: 2,
      mode: "number",
    }).notNull(),
    verdict: fieldVerdictEnum("verdict").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One result per field per verification — a second row for the same
    // (verification, field) pair is a bug, not a valid re-check.
    uniqueIndex("field_results_verification_field_unique").on(
      table.verificationId,
      table.fieldName,
    ),
    check(
      "field_results_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

/**
 * One row per needs-human item (PRD §3.3/§3.4, TH-R22). `resolverOutput`
 * is null until the Sonnet resolver has run; `disposition` is null until a
 * human acts.
 *
 * TH-R6: this table records what a human decided (approve/reject) and
 * when, but never who — no reviewer name, email, or ID column. Adding one
 * would put a real person's identity in a compliance-data table for no
 * product requirement that asks for it; the disposition alone is enough
 * for the review-queue UI (PRD §5) and this prototype's scope (TH-R6).
 *
 * **The single-label resolution trigger (TRO-511, CP-3 §9/§12 open question
 * 5).** `resolverInput` and the six columns after it exist for exactly one
 * caller: `src/app/api/verify/route.ts`. That route inserts a row here
 * immediately on a REVIEW verdict — unchanged, so a human still sees "needs
 * review" the moment the request returns (PRD §5) — but now ALSO snapshots
 * `{ schemaVersion, extraction, router, flaggedFields }` into `resolverInput`
 * (the same shape `batch_queue_items.resolver_input` carries for the batch
 * path, CP-3 §2.3), so a background worker can call `resolveEscalatedLabel`
 * for it later without ever re-running Haiku. `claimedBy`/`claimToken`/
 * `claimedAt`/`leaseExpiresAt`/`availableAt`/`attempts` mirror
 * `batch_queue_items`'s own claim columns (CP-3 §2.2/§3.1) — the same
 * atomic-claim shape, applied to this table instead of a second one,
 * because "batch job is absent" (CP-3 §12 Q5's own recommended predicate)
 * is exactly `resolverInput IS NOT NULL`: only this one route ever sets it,
 * so a batch-originated row (created by `insertReviewQueueEntry` /
 * `insertSkippedReviewQueueEntry`, never by a bare pre-insert) can never
 * collide with the single-label claim query. No separate `status` enum is
 * needed the way `batch_queue_items` has one: this table's own
 * `resolverOutput`/`resolverSkipReason` columns already say "done" the
 * moment either is set, and the claim query's `WHERE` clause already
 * excludes both.
 */
export const reviewQueue = pgTable(
  "review_queue",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    verificationId: integer("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "cascade" }),
    reason: reviewReasonEnum("reason").notNull(),
    resolverOutput: jsonb("resolver_output"),
    // Set only when this row was filed WITHOUT a Sonnet call — today, only
    // the batch escalation cap (LH-041 / TRO-474, CP-3 §6.2/§6.4). `NULL`
    // `resolverOutput` is otherwise ambiguous: "Sonnet has not run for this
    // yet" (the ordinary pending state) vs. "Sonnet was deliberately never
    // going to run for this" (the cap). This column names the second state
    // instead of letting absence stand in for it (CP-3 §6.4).
    resolverSkipReason: text("resolver_skip_reason"),
    // TRO-511 — see this table's own doc comment above. Null for every
    // batch-originated row; set at insert time by the single-label verify
    // route for every REVIEW-verdict row it files.
    resolverInput: jsonb("resolver_input"),
    // TRO-506/TRO-512 (CP-3 §3.3, §12 open question 2). The resolver's
    // atomic reservation: the instant one caller's exclusive right to call
    // Sonnet for this verification runs out. Set by
    // `../../server/resolver/reservation.ts` BEFORE the model call, cleared
    // when a resolution lands or when the call fails.
    //
    // A dedicated column, not a second use of `claimToken`/`leaseExpiresAt`
    // above: those belong to the single-label resolve worker's claim
    // (TRO-511), which is still holding them while it calls
    // `resolveEscalatedLabel`. Writing them here would replace that
    // worker's own live claim token and turn its retry and failure writes
    // into silent no-ops.
    resolverReservedUntil: timestamp("resolver_reserved_until", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    // The single-label resolve worker's own diagnostic breadcrumb (mirrors
    // `batch_queue_items.lastError`) — set on a retryable failure's latest
    // attempt or a permanent one; never blocks the row from still being
    // visible and human-actionable in the review-queue UI.
    lastError: text("last_error"),
    disposition: reviewDispositionEnum("disposition"),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    // Millisecond precision, unlike every other timestamp in this schema
    // (TRO-507). This column is the review queue's paging sort key, and a
    // page cursor is built from the JavaScript `Date` the driver hands
    // back — which carries milliseconds and nothing finer. Postgres's own
    // default microsecond precision made a cursor unable to name one exact
    // position: the truncated cursor compared as "before" the very row it
    // came from, so the next page served that row again, forever. Observed
    // as a repeating page in `src/app/api/review-queue/route.test.ts`.
    // Storing exactly what a cursor can carry removes the mismatch instead
    // of papering over it in the query.
    //
    // Re-verified in the local review round 6, because "is this migration
    // needed at all" is the cheapest thing to get wrong. Method: revert
    // this worktree's column to the default microsecond precision, run
    // `npx vitest run src/server/review-queue src/app/api/review-queue`,
    // then restore it. Reverted, that route test failed, and it failed with
    // the exact repeat: one queue id came back on page after page, and the
    // walk never reached the next row. Restored, all 56 tests passed. The
    // migration stands. The only way to drop it is to make the cursor carry
    // microseconds, which means teaching the driver to hand this column
    // back as text instead of a `Date`.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // A verification needs human review at most once — one queue entry
    // per verification, not per escalation attempt.
    uniqueIndex("review_queue_verification_id_unique").on(
      table.verificationId,
    ),
    index("review_queue_reason_idx").on(table.reason),
    // The review-queue UI's default view is "what's still unresolved" —
    // a partial index keeps that scan cheap as the table grows.
    //
    // Both keys, `createdAt` then `id`, since migration 0007 (TRO-507).
    // The list query's keyset page boundary is a row comparison on the
    // PAIR, `(created_at, id) > (cursor_created_at, cursor_id)`, and its
    // `ORDER BY` uses the same pair. A `createdAt`-only index served the
    // pair with the leading column alone, and Postgres re-checked the
    // whole comparison as a filter and then sorted (measured, see
    // `../../server/review-queue/list.ts`). Both keys let the index answer
    // the boundary and the order together.
    index("review_queue_unresolved_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.disposition} IS NULL`),
    // TRO-511's own claim query's WHERE clause, almost verbatim — mirrors
    // `batch_queue_items_claim_idx`'s reasoning (CP-3 §2.2): keeps the scan
    // cheap without a separate status column to filter on. Every
    // batch-originated row has `resolverInput IS NULL` and is excluded by
    // this partial index's own predicate, the same way it is excluded from
    // the claim query itself.
    index("review_queue_pending_resolve_idx")
      .on(table.availableAt)
      .where(sql`${table.resolverOutput} IS NULL AND ${table.resolverSkipReason} IS NULL AND ${table.resolverInput} IS NOT NULL`),
    // A disposition and its timestamp are one fact recorded in two
    // columns — either both are set (resolved) or neither is (pending).
    check(
      "review_queue_disposition_disposed_at_consistency",
      sql`(${table.disposition} IS NULL) = (${table.disposedAt} IS NULL)`,
    ),
    // A row cannot simultaneously carry a real Sonnet resolution AND a
    // reason Sonnet was skipped — the two writers (`insertReviewQueueEntry`,
    // `insertSkippedReviewQueueEntry`, `../../server/resolver/queue.ts`)
    // are mutually exclusive by construction; this constraint makes that
    // invariant a database fact, not just a code convention.
    check(
      "review_queue_resolver_output_skip_reason_exclusive",
      sql`NOT (${table.resolverOutput} IS NOT NULL AND ${table.resolverSkipReason} IS NOT NULL)`,
    ),
    check("review_queue_attempts_non_negative", sql`${table.attempts} >= 0`),
  ],
);

/**
 * The batch job queue (LH-041 / TRO-474, CP-3 §2.2). One table serves two
 * logical queues, discriminated by `kind`: `EXTRACT` rows drive the Haiku
 * extraction + router pass for one (application, label image) pairing;
 * `RESOLVE` rows drive the Sonnet resolver for one escalated verification.
 * A worker never infers "what's pending" from another table (`verifications`
 * only ever records a FINISHED cascade, CP-3 §2.1) — this table is the one
 * place that also knows "claimed, by whom, until when" and "why a claim
 * failed."
 *
 * `kind`'s two shapes are mutually exclusive, enforced below by
 * `batch_queue_items_kind_shape` — an `EXTRACT` row is never missing its
 * pairing columns, a `RESOLVE` row is never missing its verification/
 * snapshot columns, and neither ever carries the other's columns.
 *
 * Not enforced at the database level (matching the same call already made
 * for `labelImages`/`verifications`, CP-3 §2.2): that `applicationId`,
 * `labelImageId`, and `verificationId` here belong to the SAME
 * `batchJobId`. Every row is written by one trusted writer (this ticket's
 * own extract-worker, deriving all IDs from its own claimed batch context),
 * not assembled from arbitrary parts.
 */
export const batchQueueItems = pgTable(
  "batch_queue_items",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    batchJobId: integer("batch_job_id")
      .notNull()
      .references(() => batchJobs.id, { onDelete: "cascade" }),
    kind: batchQueueItemKindEnum("kind").notNull(),
    // EXTRACT-only. Null for RESOLVE (see the kind-shape CHECK below).
    applicationId: integer("application_id").references(() => applications.id, { onDelete: "cascade" }),
    labelImageId: integer("label_image_id").references(() => labelImages.id, { onDelete: "cascade" }),
    // RESOLVE-only. Null for EXTRACT.
    verificationId: integer("verification_id").references(() => verifications.id, { onDelete: "cascade" }),
    // RESOLVE-only: the { schemaVersion, extraction, router, flaggedFields }
    // snapshot the EXTRACT worker took at the moment it escalated (CP-3
    // §2.3) — NOT optional, so a resolve-worker never has to re-run Haiku
    // just to rebuild a ResolverInput.
    resolverInput: jsonb("resolver_input"),
    status: batchQueueItemStatusEnum("status").notNull().default("PENDING"),
    // Opaque worker-instance id (logs/diagnosis only — NOT the fencing
    // mechanism; see `claimToken` below). CP-3 §2.2/§3.1.
    claimedBy: text("claimed_by"),
    // Minted fresh on EVERY claim, including a reclaim by the same
    // `claimedBy`. This — not `claimedBy` — is what a completion write
    // must match (CP-3 §3.1/§3.2): `claimedBy` is stable across a worker's
    // whole lifetime and cannot tell a stale claim episode from a current
    // one; a fresh token can.
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Past this time, a CLAIMED row is claimable again by any worker — the
    // same claim query that claims new work also recovers a crashed
    // worker's abandoned work (CP-3 §3.2). No separate cleanup job.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // A row is claimable only once this time has passed. Defaults to now();
    // a retryable failure pushes it forward by the backoff delay (CP-3
    // §5.2) instead of the worker sleeping in place.
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    // Set only on FAILED — the one place a failed item's reason lives,
    // since a failed EXTRACT never produces a `verifications` row to write
    // it to (CP-3 §7.3), and a failed RESOLVE must not overwrite the
    // verification `EXTRACT` already produced.
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The claim query's own WHERE clause, almost verbatim (CP-3 §2.2,
    // §3.1) — partial on the two statuses a claim can ever match, so a
    // growing pile of DONE/FAILED history never bloats the index the claim
    // loop scans on every poll.
    index("batch_queue_items_claim_idx")
      .on(table.kind, table.status, table.availableAt)
      .where(sql`${table.status} IN ('PENDING', 'CLAIMED')`),
    // The progress-summary query LH-042 runs every poll.
    index("batch_queue_items_batch_job_id_idx").on(table.batchJobId),
    check(
      "batch_queue_items_kind_shape",
      sql`(
        (${table.kind} = 'EXTRACT' AND ${table.applicationId} IS NOT NULL AND ${table.labelImageId} IS NOT NULL
          AND ${table.verificationId} IS NULL AND ${table.resolverInput} IS NULL)
        OR
        (${table.kind} = 'RESOLVE' AND ${table.verificationId} IS NOT NULL AND ${table.resolverInput} IS NOT NULL
          AND ${table.applicationId} IS NULL AND ${table.labelImageId} IS NULL)
      )`,
    ),
    check("batch_queue_items_attempts_non_negative", sql`${table.attempts} >= 0`),
    // A retried batch-creation step must reuse the existing EXTRACT row for
    // one (batch, application, image) pairing rather than duplicate it —
    // `verifications` carries no unique constraint on
    // (applicationId, labelImageId) either, so two EXTRACT rows for one
    // label would each run its own extraction and double-count the label
    // downstream (CP-3 §2.2). Enqueue is `INSERT ... ON CONFLICT ...
    // DO NOTHING` against this index.
    uniqueIndex("batch_queue_items_extract_pairing_unique")
      .on(table.batchJobId, table.applicationId, table.labelImageId)
      .where(sql`${table.kind} = 'EXTRACT'`),
    // At most one RESOLVE row per verification — the same one-row-per-
    // verification guarantee `review_queue_verification_id_unique` already
    // gives that table (CP-3 §2.2), so a retried or duplicated EXTRACT
    // transaction cannot enqueue two RESOLVE rows for the same escalation.
    uniqueIndex("batch_queue_items_resolve_verification_unique")
      .on(table.verificationId)
      .where(sql`${table.kind} = 'RESOLVE'`),
  ],
);

/**
 * One row per UTC calendar day: the running total, in real USD, this
 * deployment has spent on Anthropic API calls that day (TRO-482 / LH-061,
 * PRD §8, TH-R6). Backs the daily spend budget guard — `src/server/budget/
 * daily-budget.ts` reads and writes this table; `src/app/api/verify/route.ts`
 * and `src/app/api/batch/start/route.ts` check it before the model call, not
 * after.
 *
 * PERSISTED, not in-memory (unlike the rate limiter, `src/server/rate-limit/`):
 * a process restart (a deploy, a crash, Render recycling the instance) must
 * not silently reset spend to zero and defeat the guard exactly when a
 * traffic spike is causing restarts. One row per day, upserted in place —
 * `spendDate` is the primary key, so "add today's real, measured cost" is
 * one atomic `INSERT ... ON CONFLICT (spend_date) DO UPDATE SET total_usd =
 * total_usd + $1`, safe under concurrent requests.
 *
 * No PII (TH-R6): a dollar figure keyed by calendar date, nothing else.
 */
export const dailySpend = pgTable(
  "daily_spend",
  {
    // UTC calendar day this row totals, as a plain SQL DATE (no time
    // component) — "today" is a single equality check against this column,
    // never a range query. `src/server/budget/daily-budget.ts`'s
    // `todayUtcDateString()` is the one place that decides what "today"
    // means, so every reader and writer agrees.
    spendDate: date("spend_date").primaryKey(),
    // scale 6, not the money-ish 2 or 4: a single Haiku call costs
    // fractions of a cent (real observed figures like $0.008932 elsewhere
    // in this repo's diagnosis docs) — 4 decimal places would silently
    // round that to $0.0089 on every write, compounding real precision
    // loss across hundreds of calls a day. precision 12 leaves headroom to
    // six figures of total daily spend, far past anything this budget
    // guard's own $5-$25 range ever approaches.
    totalUsd: numeric("total_usd", { precision: 12, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("daily_spend_total_usd_non_negative", sql`${table.totalUsd} >= 0`),
  ],
);

export const batchJobsRelations = relations(batchJobs, ({ many }) => ({
  applications: many(applications),
  labelImages: many(labelImages),
  verifications: many(verifications),
  batchQueueItems: many(batchQueueItems),
}));

export const applicationsRelations = relations(
  applications,
  ({ one, many }) => ({
    batchJob: one(batchJobs, {
      fields: [applications.batchJobId],
      references: [batchJobs.id],
    }),
    labelImages: many(labelImages),
    verifications: many(verifications),
    batchQueueItems: many(batchQueueItems),
  }),
);

export const labelImagesRelations = relations(
  labelImages,
  ({ one, many }) => ({
    application: one(applications, {
      fields: [labelImages.applicationId],
      references: [applications.id],
    }),
    batchJob: one(batchJobs, {
      fields: [labelImages.batchJobId],
      references: [batchJobs.id],
    }),
    verifications: many(verifications),
    batchQueueItems: many(batchQueueItems),
  }),
);

export const verificationsRelations = relations(
  verifications,
  ({ one, many }) => ({
    application: one(applications, {
      fields: [verifications.applicationId],
      references: [applications.id],
    }),
    labelImage: one(labelImages, {
      fields: [verifications.labelImageId],
      references: [labelImages.id],
    }),
    batchJob: one(batchJobs, {
      fields: [verifications.batchJobId],
      references: [batchJobs.id],
    }),
    fieldResults: many(fieldResults),
    // review_queue holds the physical FK; this side matches local PK to
    // the foreign FK column, which is Drizzle's documented shape for the
    // non-FK-holding side of a one-to-one relation.
    reviewQueueEntry: one(reviewQueue, {
      fields: [verifications.id],
      references: [reviewQueue.verificationId],
    }),
    batchQueueItems: many(batchQueueItems),
  }),
);

export const fieldResultsRelations = relations(fieldResults, ({ one }) => ({
  verification: one(verifications, {
    fields: [fieldResults.verificationId],
    references: [verifications.id],
  }),
}));

export const reviewQueueRelations = relations(reviewQueue, ({ one }) => ({
  verification: one(verifications, {
    fields: [reviewQueue.verificationId],
    references: [verifications.id],
  }),
}));

export const batchQueueItemsRelations = relations(batchQueueItems, ({ one }) => ({
  batchJob: one(batchJobs, {
    fields: [batchQueueItems.batchJobId],
    references: [batchJobs.id],
  }),
  application: one(applications, {
    fields: [batchQueueItems.applicationId],
    references: [applications.id],
  }),
  labelImage: one(labelImages, {
    fields: [batchQueueItems.labelImageId],
    references: [labelImages.id],
  }),
  verification: one(verifications, {
    fields: [batchQueueItems.verificationId],
    references: [verifications.id],
  }),
}));
