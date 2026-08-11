/**
 * Reads one review-queue item's full review/detail data (TRO-476, PRD §5,
 * TH-R22): the reason, every field's extracted-vs-application comparison,
 * and the Sonnet resolver's suggestion when one exists. Read-only and
 * DB-backed, same posture as `list.ts` — see that file's comment on why
 * this is not the same module as `src/server/verification-detail`
 * (LH-016/TRO-466, still an open PR, not merged as of this ticket).
 *
 * Does NOT show the label image. PRD §5's review-queue line ("needs-human
 * items with reason; approve/reject records disposition") does not ask for
 * one, and the route that serves image bytes
 * (`src/app/api/label-images/[labelImageId]/route.ts`) is also LH-016's,
 * also unmerged — building it here would duplicate a sibling ticket's
 * still-open work. Flagged in this ticket's report, not silently worked
 * around.
 */
import { eq } from "drizzle-orm";
import type { db as defaultDb } from "../../lib/db";
import { applications, fieldResults, reviewQueue, verifications } from "../../lib/db/schema";
import { FIELD_NAMES, type FieldName } from "../../lib/db/enums";
import { buildFieldReasonText } from "../router/reason-text";
import { FIELD_NAME_LABELS, type GetReviewQueueItemResult, type ResolverSuggestedField, type ReviewQueueFieldDetail } from "./types";

type ApplicationRow = typeof applications.$inferSelect;

/**
 * What the applicant filed, formatted for display. Reads the already-
 * persisted raw-text columns directly — `applications.alcohol_content_raw`
 * / `net_contents_raw` (`schema.ts`) are exactly the strings
 * `src/app/api/verify/route.ts` wrote from the applicant's own form input,
 * so this does no new parsing or judgment, only a column lookup. The
 * fallback phrase and the government-warning phrase below match
 * `src/server/router/index.ts`'s own wording exactly (lines 227 and 252,
 * both already merged) — one sentence, not a second copy invented here.
 */
function applicationValueForField(field: FieldName, application: ApplicationRow): string {
  switch (field) {
    case "BRAND_NAME":
      return application.brandName;
    case "CLASS_TYPE":
      return application.classType;
    case "ALCOHOL_CONTENT":
      return application.alcoholContentRaw ?? "(not filed on the application)";
    case "NET_CONTENTS":
      return application.netContentsRaw ?? "(not filed on the application)";
    case "GOVERNMENT_WARNING":
      return "the statutory warning text (27 CFR part 16)";
  }
}

/**
 * Reads `resolver_output`'s free-text `note`, when present. `resolver_
 * output` is an untyped `jsonb` column (standing rule 13: validate at the
 * boundary) — this reads only the one property it needs and never trusts
 * the rest of the shape, so even a resolution this module's stricter
 * `summarizeResolverOutput` below rejects can still surface its note.
 * Never surfaces a `confidence` number (standing rule 12).
 */
function extractResolverNote(resolverOutput: unknown): string | null {
  if (typeof resolverOutput !== "object" || resolverOutput === null) return null;
  const note = (resolverOutput as Record<string, unknown>).note;
  return typeof note === "string" && note.length > 0 ? note : null;
}

const JUDGED_FIELD_VALUES = new Set(["brand_name", "class_type"]);
const CORRECTION_FIELD_VALUES = new Set(["alcohol_content", "net_contents", "government_warning"]);

/**
 * A best-effort, DISPLAY-ONLY check — deliberately looser than
 * `src/server/resolver/queue.ts`'s `isResolvedFieldResult`. That function
 * gates a real-money decision (whether to trust a stored row enough to skip
 * calling Sonnet again) and throws on the first defect. This function only
 * decides whether one field is legible enough to show a human reviewer who
 * is already looking at the label and the application directly — a
 * confidence out of `[0, 1]` range, for example, is a real defect
 * `isResolvedFieldResult` is right to reject outright, but is not a reason
 * to hide an otherwise-readable `correctedValue`/`evidence`/`reason` from
 * the one person best placed to judge it. `confidence` is never read here
 * at all (standing rule 12).
 */
function toDisplaySuggestion(value: unknown): ResolverSuggestedField | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const field = obj.field;
  const evidence = typeof obj.evidence === "string" ? obj.evidence : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  const correctedValue = typeof obj.correctedValue === "string" ? obj.correctedValue : null;
  if (typeof field !== "string" || evidence === null || reason === null) return null;

  if (obj.kind === "judged" && JUDGED_FIELD_VALUES.has(field) && typeof obj.disposition === "string") {
    return { field, kind: "judged", disposition: obj.disposition, needsHuman: null, correctedValue, evidence, reason };
  }
  if (obj.kind === "correction" && CORRECTION_FIELD_VALUES.has(field) && typeof obj.needsHuman === "boolean") {
    return { field, kind: "correction", disposition: null, needsHuman: obj.needsHuman, correctedValue, evidence, reason };
  }
  return null;
}

/**
 * Reads `resolver_output`'s field-by-field suggestions for display, or
 * `null` when there is nothing legible to show — including the normal case
 * today, `resolver_output === null` (see this module's file comment).
 * Skips an individual malformed field rather than rejecting the whole
 * object (see `toDisplaySuggestion`'s comment for why that posture differs
 * from `queue.ts`'s own, stricter reader).
 */
function summarizeResolverOutput(resolverOutput: unknown): ResolverSuggestedField[] | null {
  if (typeof resolverOutput !== "object" || resolverOutput === null) return null;
  const fieldsRaw = (resolverOutput as Record<string, unknown>).fields;
  if (!Array.isArray(fieldsRaw)) return null;

  const fields = (fieldsRaw as unknown[])
    .map(toDisplaySuggestion)
    .filter((f: ResolverSuggestedField | null): f is ResolverSuggestedField => f !== null);
  return fields.length > 0 ? fields : null;
}

export async function getReviewQueueItem(db: typeof defaultDb, id: number): Promise<GetReviewQueueItemResult> {
  const [queueRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id));
  if (!queueRow) return { found: false };

  const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, queueRow.verificationId));
  const [applicationRow] = verificationRow
    ? await db.select().from(applications).where(eq(applications.id, verificationRow.applicationId))
    : [];

  // Defensive, not expected: every FK above is NOT NULL with ON DELETE
  // CASCADE (schema.ts) — a review-queue row pointing at a missing
  // verification or application means the schema's own cascade rules were
  // bypassed, not a normal user state.
  if (!verificationRow || !applicationRow) return { found: false };

  const fieldRows = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, verificationRow.id));
  const fieldRowByName = new Map(fieldRows.map((row) => [row.fieldName, row]));

  const fields: ReviewQueueFieldDetail[] = FIELD_NAMES.map((fieldName) => {
    const row = fieldRowByName.get(fieldName);
    // Defensive: route.ts inserts all five field_results rows in the same
    // transaction as the verification, so every verification should carry
    // all five. A missing one is a data anomaly, reported plainly rather
    // than silently dropped.
    if (!row) {
      return {
        field: fieldName,
        fieldLabel: FIELD_NAME_LABELS[fieldName],
        verdict: "NEEDS_REVIEW",
        labelValue: null,
        evidence: "",
        applicationValue: applicationValueForField(fieldName, applicationRow),
        reason: "No result was recorded for this field.",
      };
    }
    return {
      field: fieldName,
      fieldLabel: FIELD_NAME_LABELS[fieldName],
      verdict: row.verdict,
      labelValue: row.extractedValue,
      evidence: row.evidence,
      applicationValue: applicationValueForField(fieldName, applicationRow),
      reason: row.reason,
    };
  });

  return {
    found: true,
    item: {
      id: queueRow.id,
      verificationId: verificationRow.id,
      applicationId: applicationRow.id,
      reason: queueRow.reason,
      reasonText: buildFieldReasonText("NEEDS_REVIEW", queueRow.reason, undefined),
      labelVerdict: verificationRow.verdict,
      brandName: applicationRow.brandName,
      classType: applicationRow.classType,
      beverageType: applicationRow.beverageType,
      createdAt: queueRow.createdAt,
      disposition: queueRow.disposition,
      disposedAt: queueRow.disposedAt,
      resolverNote: extractResolverNote(queueRow.resolverOutput),
      resolverFields: summarizeResolverOutput(queueRow.resolverOutput),
      fields,
    },
  };
}
