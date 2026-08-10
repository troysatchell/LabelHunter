import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * `_meta` is a scaffold-only table: it exists to prove the migration
 * pipeline (drizzle-kit generate/migrate) works end-to-end against a real
 * Postgres database. It is not part of the product data model.
 *
 * The real schema — `applications`, `label_images`, `batch_jobs`,
 * `verifications`, `field_results`, `review_queue` (PRD §3.6) — lands in
 * ticket LH-002 (TRO-457) and extends this file.
 */
export const meta = pgTable("_meta", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
