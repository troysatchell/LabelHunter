/**
 * Reads one batch job's live progress and results (LH-042 / TRO-475, PRD
 * §3.5, §5, TH-R4). Read-only, DB-backed — the polling endpoint
 * (`src/app/api/batch/[batchJobId]/route.ts`) calls this on every poll.
 *
 * Reads live from `batch_jobs`, `batch_queue_items`, and `verifications` —
 * no separate cached counters of its own that could drift from those rows
 * (the ticket's own instruction). `batch_jobs.processedCount` /
 * `autoVerifiedCount` / `resolvedBySonnetCount` / `needsHumanCount` /
 * `failedCount` are themselves already maintained transactionally, one
 * counter at a time, by the SAME transaction that writes the underlying
 * `verifications`/`batch_queue_items` row (`../batch-queue/extract-worker.ts`,
 * `../batch-queue/resolve-worker.ts`) — reading them here is reading live
 * off `batch_jobs`, exactly as instructed, not maintaining a second copy.
 *
 * `passCount`/`failCount` are the one summary figure this module computes
 * itself, deliberately not read off `batch_jobs`: CP-3 §7.1 states plainly
 * that `autoVerifiedCount` bundles PASS and FAIL together (both are
 * "decided without escalation"), and that this ticket "must not present it
 * as though it can" answer "how many labels passed" — so this module
 * computes that split from `verifications.verdict` directly, the one place
 * that distinction actually lives.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../lib/db";
import type { FieldName, FieldVerdict } from "../../lib/db/enums";
import { applications, batchJobs, batchQueueItems, fieldResults, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { computeAutoVerifiedShare, computeBatchThroughput } from "../../lib/utils/batch-throughput";
import { computeLatencyStats } from "../../lib/utils/latency-stats";
import { buildFieldReasonText } from "../router/reason-text";
import type { BatchProgressSummary, BatchResultRow, BatchResultStatusTone, GetBatchProgressResult } from "./types";

type Db = typeof defaultDb;

function doneRowStatus(
  verdict: "PASS" | "FAIL" | "REVIEW",
  reviewReason: Parameters<typeof buildFieldReasonText>[1],
  disposition: "APPROVED" | "REJECTED" | null,
): { text: string; tone: BatchResultStatusTone } {
  if (disposition === "APPROVED") return { text: "Approved by reviewer.", tone: "pass" };
  if (disposition === "REJECTED") return { text: "Rejected by reviewer.", tone: "fail" };
  if (verdict === "PASS") return { text: "Matches the application.", tone: "pass" };
  if (verdict === "FAIL") return { text: "Does not match the application.", tone: "fail" };
  return { text: reviewReason ? buildFieldReasonText("NEEDS_REVIEW", reviewReason, undefined) : "Needs review.", tone: "review" };
}

/** Reads every batch_queue_items row for this batch that never became — or
 * failed to become — a `verifications` row: a still-`PENDING` or `CLAIMED`
 * `EXTRACT` item, or a `FAILED` one (CP-3 §7.3: a failed `EXTRACT` never
 * produces a `verifications` row, by the schema's own documented contract).
 * A `FAILED` `RESOLVE` item is deliberately NOT included here — its label's
 * `EXTRACT` phase already finished, so it already has a `verifications` row
 * (verdict `REVIEW`) the "done" query below picks up (CP-3 §7.1's own
 * table, the row for "Resolver call throws, attempts = maxAttempts").
 */
async function loadIncompleteOrFailedExtractRows(db: Db, batchJobId: number) {
  return db
    .select({
      id: batchQueueItems.id,
      status: batchQueueItems.status,
      lastError: batchQueueItems.lastError,
      brandName: applications.brandName,
      originalFilename: labelImages.originalFilename,
      applicationId: applications.id,
    })
    .from(batchQueueItems)
    .innerJoin(applications, eq(batchQueueItems.applicationId, applications.id))
    .innerJoin(labelImages, eq(batchQueueItems.labelImageId, labelImages.id))
    .where(
      and(
        eq(batchQueueItems.batchJobId, batchJobId),
        eq(batchQueueItems.kind, "EXTRACT"),
        sql`${batchQueueItems.status} IN ('PENDING', 'CLAIMED', 'FAILED')`,
      ),
    )
    .orderBy(asc(applications.id));
}

async function loadDoneVerificationRows(db: Db, batchJobId: number) {
  return db
    .select({
      verificationId: verifications.id,
      verdict: verifications.verdict,
      brandName: applications.brandName,
      originalFilename: labelImages.originalFilename,
      applicationId: applications.id,
      reviewReason: reviewQueue.reason,
      disposition: reviewQueue.disposition,
    })
    .from(verifications)
    .innerJoin(applications, eq(verifications.applicationId, applications.id))
    .innerJoin(labelImages, eq(verifications.labelImageId, labelImages.id))
    .leftJoin(reviewQueue, eq(reviewQueue.verificationId, verifications.id))
    .where(eq(verifications.batchJobId, batchJobId))
    .orderBy(asc(applications.id));
}

async function loadFieldVerdictsByVerification(db: Db, batchJobId: number): Promise<Map<number, Partial<Record<FieldName, FieldVerdict>>>> {
  const rows = await db
    .select({ verificationId: fieldResults.verificationId, fieldName: fieldResults.fieldName, verdict: fieldResults.verdict })
    .from(fieldResults)
    .innerJoin(verifications, eq(fieldResults.verificationId, verifications.id))
    .where(eq(verifications.batchJobId, batchJobId));

  const byVerification = new Map<number, Partial<Record<FieldName, FieldVerdict>>>();
  for (const row of rows) {
    const existing = byVerification.get(row.verificationId) ?? {};
    existing[row.fieldName] = row.verdict;
    byVerification.set(row.verificationId, existing);
  }
  return byVerification;
}

/** Duration, in milliseconds, of a DONE `EXTRACT` item's own processing:
 * `claimed_at` (when a worker took it) to `updated_at` (bumped by
 * `markDone`'s own write, `../batch-queue/complete.ts`). Filters out any
 * row missing `claimed_at` defensively — every real `DONE` row has one set
 * by the claim query itself (`../batch-queue/claim.ts`), so this should
 * never trigger in practice; standing rule 13 (validate, don't assume). */
async function loadExtractDurationsMs(db: Db, batchJobId: number): Promise<number[]> {
  const rows = await db.execute<{ ms: string | null }>(sql`
    SELECT EXTRACT(EPOCH FROM (updated_at - claimed_at)) * 1000 AS ms
    FROM batch_queue_items
    WHERE batch_job_id = ${batchJobId} AND kind = 'EXTRACT' AND status = 'DONE' AND claimed_at IS NOT NULL
  `);
  return rows.rows.map((row) => Number(row.ms)).filter((ms) => Number.isFinite(ms) && ms >= 0);
}

/** Count of items genuinely waiting out a scheduled retry delay right now —
 * see `BatchRateLimitBackoff`'s own doc comment (`./types.ts`) for why this
 * is how a stateless HTTP route observes LH-041's real, already-built
 * backoff state instead of recomputing it. */
async function loadRateLimitBackoffCount(db: Db, batchJobId: number): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM batch_queue_items
    WHERE batch_job_id = ${batchJobId} AND status = 'PENDING' AND attempts > 0 AND available_at > now()
  `);
  return Number(rows.rows[0]?.count ?? "0");
}

export async function getBatchProgress(db: Db, batchJobId: number): Promise<GetBatchProgressResult> {
  const [job] = await db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
  if (!job) {
    return { found: false };
  }

  const [doneRows, incompleteOrFailedRows, fieldsByVerification, verdictCounts, durationsMs, rateLimitBackoffCount] = await Promise.all([
    loadDoneVerificationRows(db, batchJobId),
    loadIncompleteOrFailedExtractRows(db, batchJobId),
    loadFieldVerdictsByVerification(db, batchJobId),
    db
      .select({ verdict: verifications.verdict, count: sql<string>`count(*)` })
      .from(verifications)
      .where(and(eq(verifications.batchJobId, batchJobId), sql`${verifications.verdict} IN ('PASS', 'FAIL')`))
      .groupBy(verifications.verdict),
    loadExtractDurationsMs(db, batchJobId),
    loadRateLimitBackoffCount(db, batchJobId),
  ]);

  const passCount = Number(verdictCounts.find((row) => row.verdict === "PASS")?.count ?? "0");
  const failCount = Number(verdictCounts.find((row) => row.verdict === "FAIL")?.count ?? "0");

  const doneResultRows: (BatchResultRow & { applicationId: number })[] = doneRows.map((row) => {
    const fields = fieldsByVerification.get(row.verificationId) ?? {};
    const status = doneRowStatus(row.verdict, row.reviewReason, row.disposition);
    return {
      key: `v-${row.verificationId}`,
      label: row.originalFilename,
      brandName: row.brandName,
      brand: fields.BRAND_NAME ?? null,
      abv: fields.ALCOHOL_CONTENT ?? null,
      net: fields.NET_CONTENTS ?? null,
      warning: fields.GOVERNMENT_WARNING ?? null,
      statusText: status.text,
      statusTone: status.tone,
      statusDetail: null,
      verificationId: row.verificationId,
      applicationId: row.applicationId,
    };
  });

  const incompleteOrFailedResultRows: (BatchResultRow & { applicationId: number })[] = incompleteOrFailedRows.map((row) => {
    const status: { text: string; tone: BatchResultStatusTone } =
      row.status === "FAILED"
        ? { text: "Could not be processed automatically.", tone: "failed" }
        : row.status === "CLAIMED"
          ? { text: "Being processed now.", tone: "pending" }
          : { text: "Queued for processing.", tone: "pending" };
    return {
      key: `q-${row.id}`,
      label: row.originalFilename,
      brandName: row.brandName,
      brand: null,
      abv: null,
      net: null,
      warning: null,
      statusText: status.text,
      statusTone: status.tone,
      statusDetail: row.status === "FAILED" ? row.lastError : null,
      verificationId: null,
      applicationId: row.applicationId,
    };
  });

  const results = [...doneResultRows, ...incompleteOrFailedResultRows]
    .sort((a, b) => a.applicationId - b.applicationId)
    .map(({ applicationId: _applicationId, ...row }) => row);

  const progress: BatchProgressSummary = {
    batchJobId: job.id,
    status: job.status,
    totalCount: job.totalCount,
    processedCount: job.processedCount,
    autoVerifiedCount: job.autoVerifiedCount,
    passCount,
    failCount,
    resolvedBySonnetCount: job.resolvedBySonnetCount,
    needsHumanCount: job.needsHumanCount,
    failedCount: job.failedCount,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    latency: computeLatencyStats(durationsMs),
    throughput: computeBatchThroughput({ totalCount: job.totalCount, startedAt: job.startedAt, completedAt: job.completedAt }),
    autoVerifiedShare: computeAutoVerifiedShare(job.autoVerifiedCount, job.processedCount),
    rateLimitBackoff: { active: rateLimitBackoffCount > 0, itemCount: rateLimitBackoffCount },
    results,
  };

  return { found: true, progress };
}
