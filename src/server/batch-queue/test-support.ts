/**
 * Shared test fixtures for the batch-queue test suites (LH-041 / TRO-474).
 *
 * Not a `*.test.ts` file itself — vitest only collects files matching that
 * pattern (`vitest.config.ts`), so this module carries no test cases and
 * never runs on its own (same convention as `../resolver/test-support.ts`).
 *
 * Every fixture writes through the real worktree Postgres database
 * (`../../lib/db`'s `db`, `DATABASE_URL` from `.factory-env`) — this
 * ticket's whole point is proving the claim/completion-guard SQL against
 * real Postgres locking, not a mock. `cleanupBatchJobFixture` deletes the
 * one `batch_jobs` row; every FK in `../../lib/db/schema.ts` is
 * `onDelete: "cascade"`, so that one delete cleans applications, label
 * images, verifications, field results, review-queue rows, and batch queue
 * items in one shot.
 */
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db as defaultDb } from "../../lib/db";
import { applications, batchJobs, batchQueueItems, labelImages, verifications } from "../../lib/db/schema";
import type { BatchQueueItemKind } from "../../lib/db/enums";
import { saveLabelImage } from "../storage/local-file-storage";

type Db = typeof defaultDb;

/** A real, small JPEG — for tests that exercise `readLabelImage` +
 * `resizeStoredOriginalTo*Variant` (extract-worker/resolve-worker), not
 * just DB round-tripping. */
export async function makeTestJpeg(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 180, b: 180 } } }).jpeg().toBuffer();
}

export interface BatchJobFixtureOverrides {
  status?: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  totalCount?: number;
}

/** Inserts one `batch_jobs` row. Defaults to `RUNNING` — the claim query
 * (CP-3 §3.1) only ever claims from a running batch, so most tests want
 * that state from the start rather than a separate "start" step. */
export async function createBatchJobFixture(db: Db = defaultDb, overrides: BatchJobFixtureOverrides = {}): Promise<number> {
  const [row] = await db
    .insert(batchJobs)
    .values({
      status: overrides.status ?? "RUNNING",
      totalCount: overrides.totalCount ?? 1,
      startedAt: new Date(),
    })
    .returning({ id: batchJobs.id });
  return row.id;
}

export interface ApplicationAndImageFixture {
  applicationId: number;
  labelImageId: number;
}

/** Inserts one `applications` row + one `label_images` row belonging to
 * `batchJobId`. `storagePath` is a placeholder, not a real file on disk —
 * same convention as `../resolver/queue.test.ts`'s own fixture — fine for
 * every test that does not exercise `readLabelImage`. */
export async function createApplicationAndImageFixture(db: Db = defaultDb, batchJobId: number, filename: string): Promise<ApplicationAndImageFixture> {
  const [application] = await db
    .insert(applications)
    .values({
      batchJobId,
      beverageType: "spirits",
      brandName: "TRO-474 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      batchJobId,
      applicationId: application.id,
      storagePath: `test-fixtures/${filename}`,
      originalFilename: filename,
      widthPx: 1000,
      heightPx: 1200,
    })
    .returning();

  return { applicationId: application.id, labelImageId: labelImage.id };
}

export interface ApplicationOverrides {
  abvPercent?: number | null;
  netContentsValue?: number | null;
  netContentsUnit?: string | null;
}

/**
 * Same as `createApplicationAndImageFixture`, but writes a REAL JPEG to
 * `scratchDir` via the real `saveLabelImage`/`readLabelImage` pair — for
 * tests that exercise the extract/resolve workers' own image pipeline, not
 * just DB round-tripping. `overrides` lets a test build a deliberately
 * malformed `applications` row (e.g. a null `netContentsValue`) to prove
 * the worker rejects it rather than silently coercing it.
 *
 * `brandName`/`classType` default to a value unique to this ticket, NOT
 * `../extractor/test-support.ts`'s `WELL_FORMED_EXTRACTION_BODY` brand
 * ("Old Tom Distillery") — `src/app/api/verify/route.test.ts` already
 * documents why, at its own "brand name unique to this test" comment
 * (line 329): vitest runs test FILES in parallel by default, and more than
 * one file in this repo persists an `applications` row with that shared
 * brand name, then queries by it. A test in THIS ticket that genuinely
 * needs a comparator MATCH against `WELL_FORMED_EXTRACTION_BODY` passes
 * `{ brandName: "Old Tom Distillery", classType: "Straight Bourbon Whiskey" }`
 * explicitly as an override, scoping the shared-value exposure to only the
 * handful of call sites that actually need it, rather than every call in
 * this whole suite.
 */
export async function createApplicationAndSavedImageFixture(
  db: Db = defaultDb,
  batchJobId: number,
  filename: string,
  scratchDir: string,
  overrides: ApplicationOverrides & { brandName?: string; classType?: string } = {},
): Promise<ApplicationAndImageFixture> {
  const bytes = await makeTestJpeg();
  const saved = await saveLabelImage(bytes, filename, { baseDir: scratchDir });

  const [application] = await db
    .insert(applications)
    .values({
      batchJobId,
      beverageType: "spirits",
      brandName: overrides.brandName ?? "TRO-474 Test Fixture",
      classType: overrides.classType ?? "Straight Bourbon Whiskey",
      abvPercent: "abvPercent" in overrides ? overrides.abvPercent : 45,
      netContentsValue: "netContentsValue" in overrides ? overrides.netContentsValue : 750,
      netContentsUnit: "netContentsUnit" in overrides ? overrides.netContentsUnit : "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      batchJobId,
      applicationId: application.id,
      storagePath: saved.storagePath,
      originalFilename: filename,
      widthPx: 1200,
      heightPx: 1600,
    })
    .returning();

  return { applicationId: application.id, labelImageId: labelImage.id };
}

/** Inserts one `verifications` row (`verdict: REVIEW`), the precondition a
 * RESOLVE batch-queue item requires (CP-3 §2.2). */
export async function createVerificationFixture(db: Db = defaultDb, applicationId: number, labelImageId: number, batchJobId: number): Promise<number> {
  const [row] = await db
    .insert(verifications)
    .values({
      applicationId,
      labelImageId,
      batchJobId,
      verdict: "REVIEW",
      resolutionPath: "EXTRACTOR_ONLY",
    })
    .returning({ id: verifications.id });
  return row.id;
}

export interface EnqueueExtractItemOverrides {
  status?: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  availableAt?: Date;
}

/** Inserts one `EXTRACT` `batch_queue_items` row. `availableAt` defaults to
 * the COLUMN's own `defaultNow()` (omitted from `.values()` entirely when
 * no override is given) rather than a JS-side `new Date()` — the claim
 * query compares `available_at <= now()` entirely in Postgres's own clock;
 * stamping a Node-side timestamp risked a real, observed flake against a
 * containerized Postgres whose clock is not guaranteed to be perfectly
 * synced with the test process's. */
export async function enqueueExtractItemFixture(
  db: Db = defaultDb,
  params: { batchJobId: number; applicationId: number; labelImageId: number },
  overrides: EnqueueExtractItemOverrides = {},
): Promise<number> {
  const [row] = await db
    .insert(batchQueueItems)
    .values({
      batchJobId: params.batchJobId,
      kind: "EXTRACT",
      applicationId: params.applicationId,
      labelImageId: params.labelImageId,
      status: overrides.status ?? "PENDING",
      ...(overrides.availableAt ? { availableAt: overrides.availableAt } : {}),
    })
    .returning({ id: batchQueueItems.id });
  return row.id;
}

/** Inserts one `RESOLVE` `batch_queue_items` row. `resolverInput` defaults
 * to a minimal placeholder object — tests that actually process the item
 * (resolve-worker.test.ts) supply a real `ResolverInputSnapshotV1`. */
export async function enqueueResolveItemFixture(
  db: Db = defaultDb,
  params: { batchJobId: number; verificationId: number; resolverInput?: unknown },
  overrides: EnqueueExtractItemOverrides = {},
): Promise<number> {
  const [row] = await db
    .insert(batchQueueItems)
    .values({
      batchJobId: params.batchJobId,
      kind: "RESOLVE",
      verificationId: params.verificationId,
      resolverInput: params.resolverInput ?? { schemaVersion: "1" },
      status: overrides.status ?? "PENDING",
      ...(overrides.availableAt ? { availableAt: overrides.availableAt } : {}),
    })
    .returning({ id: batchQueueItems.id });
  return row.id;
}

/** Deletes the fixture batch job, cascading to every row it owns. */
export async function cleanupBatchJobFixture(db: Db = defaultDb, batchJobId: number): Promise<void> {
  await db.delete(batchJobs).where(eq(batchJobs.id, batchJobId));
}

/** Reads a `batch_queue_items` row's raw current state for assertions. */
export async function loadBatchQueueItem(db: Db = defaultDb, id: number) {
  return db.query.batchQueueItems.findFirst({ where: (bqi, { eq: eqOp }) => eqOp(bqi.id, id) });
}

export type { BatchQueueItemKind };
