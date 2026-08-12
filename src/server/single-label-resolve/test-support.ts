/**
 * Shared test fixtures for the single-label resolve queue test suites
 * (TRO-511). Not a `*.test.ts` file itself — vitest only collects files
 * matching that pattern, so this module carries no test cases and never
 * runs on its own (same convention as `../batch-queue/test-support.ts` and
 * `../resolver/test-support.ts`).
 *
 * Every fixture writes through the real worktree Postgres database
 * (`../../lib/db`'s `db`, `DATABASE_URL` from `.factory-env`). Unlike the
 * batch-queue fixtures, nothing here sets `batchJobId` — every row is a
 * genuine single-label-originated row, `batchJobId: null` throughout,
 * exactly what `src/app/api/verify/route.ts` itself produces.
 */
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { db as defaultDb } from "../../lib/db";
import { applications, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import type { ReviewReason } from "../../lib/db/enums";
import { saveLabelImage } from "../storage/local-file-storage";
import { buildResolverInputSnapshot } from "../batch-queue/resolver-snapshot";
import type { ResolverInputSnapshotV1 } from "../batch-queue/resolver-snapshot";
import { makeExtraction } from "../router/test-support";
import { makeFlaggedFields, makeRouterResult } from "../resolver/test-support";

type Db = typeof defaultDb;

/** A real, small JPEG — for tests that exercise `readLabelImage` +
 * `resizeStoredOriginalToSonnetVariant`, not just DB round-tripping. */
export async function makeTestJpeg(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 180, b: 180 } } }).jpeg().toBuffer();
}

/** A timestamp `secondsAgo` seconds in Postgres's OWN past — same reasoning
 * as `../batch-queue/test-support.ts`'s own `dbPastTimestamp`: the claim
 * query's `lease_expires_at < now()` check runs entirely in Postgres's
 * clock, so a backdated lease should come from that same clock. */
export async function dbPastTimestamp(db: Db = defaultDb, secondsAgo: number): Promise<Date> {
  const [{ ts }] = await db.execute<{ ts: string }>(sql`SELECT (now() - (${secondsAgo} * interval '1 second')) AS ts`).then((r) => r.rows);
  return new Date(ts);
}

export interface ApplicationAndImageFixture {
  applicationId: number;
  labelImageId: number;
}

/** Inserts one `applications` row + one `label_images` row, both with
 * `batchJobId: null` — a single-label verification. `storagePath` is a
 * placeholder, not a real file on disk; fine for any test that does not
 * exercise `readLabelImage`. */
export async function createApplicationAndImageFixture(db: Db = defaultDb, filename: string): Promise<ApplicationAndImageFixture> {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "TRO-511 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: `test-fixtures/${filename}`,
      originalFilename: filename,
      widthPx: 1000,
      heightPx: 1200,
    })
    .returning();

  return { applicationId: application.id, labelImageId: labelImage.id };
}

/** Same as `createApplicationAndImageFixture`, but writes a REAL JPEG to
 * `scratchDir` via the real `saveLabelImage` — for tests that exercise the
 * worker's own image-rebuild step, not just DB round-tripping. */
export async function createApplicationAndSavedImageFixture(
  db: Db = defaultDb,
  filename: string,
  scratchDir: string,
): Promise<ApplicationAndImageFixture> {
  const bytes = await makeTestJpeg();
  const saved = await saveLabelImage(bytes, filename, { baseDir: scratchDir });

  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "TRO-511 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();

  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: saved.storagePath,
      originalFilename: filename,
      widthPx: 1200,
      heightPx: 1600,
    })
    .returning();

  return { applicationId: application.id, labelImageId: labelImage.id };
}

/** Inserts one `verifications` row (`verdict: REVIEW`, `batchJobId: null`). */
export async function createVerificationFixture(db: Db = defaultDb, applicationId: number, labelImageId: number): Promise<number> {
  const [row] = await db
    .insert(verifications)
    .values({
      applicationId,
      labelImageId,
      verdict: "REVIEW",
      resolutionPath: "EXTRACTOR_ONLY",
    })
    .returning({ id: verifications.id });
  return row.id;
}

/**
 * A REAL, worker-processable `ResolverInputSnapshotV1` — built from
 * `../resolver/test-support.ts`'s own `makeExtraction`/`makeRouterResult`/
 * `makeFlaggedFields`, the same fixtures `../batch-queue/resolve-worker.test.ts`'s
 * own `escalatedFixture` and this ticket's `worker.test.ts`/
 * `worker-loop.test.ts` already use — not `{}` stand-ins.
 *
 * Found in local review, second round: an earlier version of this function
 * defaulted `extraction`/`router` to empty objects cast through
 * `ResolverInputSnapshotV1["extraction"]`/`["router"]`. That satisfies
 * `parseResolverInputSnapshot`'s own shallow shape check (it only verifies
 * `extraction`/`router` are non-null objects, CP-3 §2.3's own documented
 * scope for that check), but `router.headlineReason` — read by
 * `processSingleLabelResolveClaim` right after parsing — would be
 * `undefined` on an empty object, so any test relying on THIS function's
 * default to reach real processing would fail confusingly far from the
 * actual gap. `enqueuePendingReviewQueueItemFixture`'s own default uses
 * this function, and claim-only tests (this file's `claim.test.ts`) never
 * process a claimed row, so the gap was invisible there — but a future
 * test author reasonably expects a queue module's own default fixture to
 * be usable end to end.
 */
export function placeholderSnapshot(overrides: Partial<ResolverInputSnapshotV1> = {}): ResolverInputSnapshotV1 {
  const router = makeRouterResult();
  const flaggedFields = makeFlaggedFields();
  const built = buildResolverInputSnapshot(makeExtraction(), router, flaggedFields);
  return { ...built, ...overrides };
}

export interface EnqueuePendingReviewQueueItemOverrides {
  reason?: ReviewReason;
  resolverInput?: unknown;
  availableAt?: Date;
}

/** Inserts one bare, pending `review_queue` row — mirrors what
 * `app/api/verify/route.ts` itself writes on a REVIEW verdict (TRO-511):
 * `reason` and `resolverInput` set, `resolverOutput`/`resolverSkipReason`
 * both null. `availableAt` defaults to the column's own `defaultNow()`
 * (omitted entirely when no override is given) — same reasoning as
 * `../batch-queue/test-support.ts`'s own `enqueueExtractItemFixture`
 * comment: the claim query compares `available_at <= now()` entirely in
 * Postgres's own clock. */
export async function enqueuePendingReviewQueueItemFixture(
  db: Db = defaultDb,
  verificationId: number,
  overrides: EnqueuePendingReviewQueueItemOverrides = {},
): Promise<number> {
  const [row] = await db
    .insert(reviewQueue)
    .values({
      verificationId,
      reason: overrides.reason ?? "AMBIGUOUS_BRAND",
      resolverInput: overrides.resolverInput ?? placeholderSnapshot(),
      ...(overrides.availableAt ? { availableAt: overrides.availableAt } : {}),
    })
    .returning({ id: reviewQueue.id });
  return row.id;
}

/** Deletes the fixture application, cascading to its label image,
 * verification, and review_queue row (every FK in `schema.ts` is
 * `onDelete: "cascade"`) — one delete cleans up the whole fixture tree. */
export async function cleanupApplicationFixture(db: Db = defaultDb, applicationId: number): Promise<void> {
  await db.delete(applications).where(eq(applications.id, applicationId));
}

/** Reads a `review_queue` row's raw current state for assertions. */
export async function loadReviewQueueItem(db: Db = defaultDb, id: number) {
  return db.query.reviewQueue.findFirst({ where: (rq, { eq: eqOp }) => eqOp(rq.id, id) });
}
