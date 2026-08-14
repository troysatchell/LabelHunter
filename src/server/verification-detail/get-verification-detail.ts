/**
 * Reads one verification's full Detail-view data (TRO-466, PRD §5): the
 * label image, every field's extracted-vs-application comparison, and the
 * label-level "resolved by Sonnet" flag.
 *
 * Read-only and DB-backed. Unlike `src/app/api/verify/route.ts`'s live
 * cascade, this module never calls a model — it only shapes rows that
 * route (or a future batch worker) already persisted (PRD §3.6). The
 * cascade is the architecture (TH-R19): a read path is not a place to add
 * a second one.
 */
import { eq } from "drizzle-orm";
import type { db as defaultDb } from "../../lib/db";
import { applications, fieldResults, labelImages, reviewQueue, verifications } from "../../lib/db/schema";
import { FIELD_NAMES, type FieldName } from "../../lib/db/enums";
import type { RouterFieldKey } from "../router";
import { buildFieldReasonText } from "../router/reason-text";
import type { BoldSignal } from "../warning";
import {
  FIELD_LABELS,
  type GetVerificationDetailResult,
  type VerificationBoldSignalDetail,
  type VerificationFieldDetail,
} from "./types";

/** `BoldSignal`'s own three legal values, restated here as a runtime array
 * — `bold-detect.ts` (TRO-532, out of this ticket's scope to edit) exports
 * only the TYPE, not a runtime list, so this boundary check owns its own
 * copy rather than reaching into that module for one. */
const BOLD_SIGNAL_VALUES: readonly BoldSignal[] = ["bold", "not-bold", "uncertain"];

type ApplicationRow = typeof applications.$inferSelect;

/** The inverse of `src/app/api/verify/route.ts`'s own `ROUTER_FIELD_TO_DB_
 * FIELD_NAME` map. Defined locally rather than imported: that map is
 * private to `route.ts`, and both directions are five fixed pairs between
 * two closed-set enums (`RouterFieldKey`, `FieldName`) that only change
 * together, so re-deriving the reverse here costs nothing and adds no new
 * cross-module coupling. */
const DB_FIELD_NAME_TO_ROUTER_FIELD: Record<FieldName, RouterFieldKey> = {
  BRAND_NAME: "brand_name",
  CLASS_TYPE: "class_type",
  ALCOHOL_CONTENT: "alcohol_content",
  NET_CONTENTS: "net_contents",
  GOVERNMENT_WARNING: "government_warning",
};

/**
 * What the applicant filed, formatted for display (PRD §5). Reads the
 * already-persisted raw-text columns directly —
 * `applications.alcohol_content_raw` / `net_contents_raw` (`schema.ts`)
 * are exactly the strings `src/app/api/verify/route.ts` wrote from the
 * applicant's own form input, so this does no new parsing or judgment,
 * only a field-to-column lookup.
 *
 * `government_warning` has no per-application column at all — see
 * `VerificationFieldDetail.applicationValue`'s doc comment for why, and
 * for what this returns instead.
 */
function applicationValueForField(field: RouterFieldKey, application: ApplicationRow): string {
  switch (field) {
    case "brand_name":
      return application.brandName;
    case "class_type":
      return application.classType;
    case "alcohol_content":
      // Mirrors src/server/router/index.ts's own fallback phrase for an
      // application value the applicant never filed in — alcohol content
      // is optional for some beverage types (PRD §2).
      return application.alcoholContentRaw ?? "(not filed on the application)";
    case "net_contents":
      return application.netContentsRaw ?? "(not filed on the application)";
    case "government_warning":
      return "the statutory warning required by 27 CFR part 16";
  }
}

/**
 * Reads `review_queue.resolver_output`'s free-text `note`, when present.
 * `resolver_output` is an untyped `jsonb` column — no resolver (LH-014) has
 * shipped yet, so there is no fixed contract to trust (standing rule 13:
 * validate at the boundary). This never surfaces any other property from
 * that object — in particular, never a `confidence` number: standing rule
 * 12 says uncertain beats wrong, and the UI never shows a bare confidence
 * percentage anywhere, even one traveling inside a resolver's own output.
 */
function extractResolverNote(resolverOutput: unknown): string | null {
  if (typeof resolverOutput !== "object" || resolverOutput === null) return null;
  const note = (resolverOutput as Record<string, unknown>).note;
  return typeof note === "string" && note.length > 0 ? note : null;
}

/**
 * Reads `verifications.bold_signal` (TRO-533) into the Detail view's own
 * narrow `VerificationBoldSignalDetail` shape — `signal`/`reason` only,
 * never the numeric fields (`types.ts`'s own comment on why). `null` for
 * every shape this boundary does not recognize as a well-formed
 * `BoldSignalResult`, matching `extractResolverNote`'s same "an untyped
 * jsonb column is validated at the boundary, never trusted just because
 * the column exists" discipline (standing rule 13) — a column declared
 * `jsonb` in `schema.ts` carries no runtime guarantee about what is
 * actually stored there.
 */
function parsePersistedBoldSignal(value: unknown): VerificationBoldSignalDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { signal, reason } = record;
  if (typeof signal !== "string" || !BOLD_SIGNAL_VALUES.includes(signal as BoldSignal)) return null;
  if (typeof reason !== "string" || reason.length === 0) return null;
  return { signal: signal as BoldSignal, reason };
}

export async function getVerificationDetail(
  db: typeof defaultDb,
  verificationId: number,
): Promise<GetVerificationDetailResult> {
  const [verificationRow] = await db.select().from(verifications).where(eq(verifications.id, verificationId));
  if (!verificationRow) return { found: false };

  const [applicationRow] = await db
    .select()
    .from(applications)
    .where(eq(applications.id, verificationRow.applicationId));
  const [labelImageRow] = await db
    .select()
    .from(labelImages)
    .where(eq(labelImages.id, verificationRow.labelImageId));

  // Defensive, not expected: every FK above is NOT NULL with ON DELETE
  // CASCADE (schema.ts), so an application or image missing here means
  // the two rows were deleted out from under a live verification — a data
  // anomaly the schema's own cascade rules should prevent. Report "not
  // found" rather than crash (standing rule 13: uncertain beats wrong).
  if (!applicationRow || !labelImageRow) return { found: false };

  const fieldRows = await db
    .select()
    .from(fieldResults)
    .where(eq(fieldResults.verificationId, verificationRow.id));
  const fieldRowByName = new Map(fieldRows.map((row) => [row.fieldName, row]));

  const fields: VerificationFieldDetail[] = FIELD_NAMES.map((dbFieldName) => {
    const field = DB_FIELD_NAME_TO_ROUTER_FIELD[dbFieldName];
    const row = fieldRowByName.get(dbFieldName);
    // Defensive: route.ts inserts all five field_results rows in the same
    // transaction as the verification, so every verification should carry
    // all five. A missing one is a data anomaly, not a normal user state —
    // report it plainly rather than silently drop the row.
    if (!row) {
      return {
        field,
        fieldLabel: FIELD_LABELS[field],
        verdict: "NEEDS_REVIEW",
        labelValue: null,
        evidence: "",
        applicationValue: applicationValueForField(field, applicationRow),
        reason: "No result was recorded for this field.",
      };
    }
    return {
      field,
      fieldLabel: FIELD_LABELS[field],
      verdict: row.verdict,
      labelValue: row.extractedValue,
      evidence: row.evidence,
      applicationValue: applicationValueForField(field, applicationRow),
      reason: row.reason,
    };
  });

  const [reviewQueueRow] = await db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.verificationId, verificationRow.id));

  // Mirrors src/app/api/verify/route.ts's own live construction exactly
  // (`buildFieldReasonText("NEEDS_REVIEW", result.headlineReason,
  // undefined)`) — reusing that one function, not a second copy of its
  // wording, is what keeps this sentence identical to the one a REVIEW
  // verdict showed at verify time.
  const headlineMessage =
    verificationRow.verdict === "REVIEW" && reviewQueueRow
      ? `Needs review — ${buildFieldReasonText("NEEDS_REVIEW", reviewQueueRow.reason, undefined)}`
      : null;

  return {
    found: true,
    detail: {
      verificationId: verificationRow.id,
      applicationId: applicationRow.id,
      labelVerdict: verificationRow.verdict,
      headlineMessage,
      resolvedBySonnet: verificationRow.resolutionPath === "EXTRACTOR_RESOLVER",
      resolverNote: extractResolverNote(reviewQueueRow?.resolverOutput ?? null),
      boldSignal: parsePersistedBoldSignal(verificationRow.boldSignal),
      labelImage: {
        url: `/api/label-images/${labelImageRow.id}`,
        width: labelImageRow.widthPx,
        height: labelImageRow.heightPx,
        originalFilename: labelImageRow.originalFilename,
      },
      fields,
    },
  };
}
