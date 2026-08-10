import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  batchJobStatusEnum,
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
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("batch_jobs_status_idx").on(table.status)],
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
    index("label_images_batch_filename_idx").on(
      table.batchJobId,
      table.originalFilename,
    ),
    check(
      "label_images_belongs_to_something",
      sql`${table.applicationId} IS NOT NULL OR ${table.batchJobId} IS NOT NULL`,
    ),
  ],
);

/**
 * One row per label-level verification, single or batch (PRD §3.3).
 * `batchJobId` is null for a single-label verification. The row records a
 * completed result: `verdict` and `resolutionPath` are set at insert time,
 * once the cascade has finished for this label.
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    disposition: reviewDispositionEnum("disposition"),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    index("review_queue_unresolved_idx")
      .on(table.createdAt)
      .where(sql`${table.disposition} IS NULL`),
  ],
);

export const batchJobsRelations = relations(batchJobs, ({ many }) => ({
  applications: many(applications),
  labelImages: many(labelImages),
  verifications: many(verifications),
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
