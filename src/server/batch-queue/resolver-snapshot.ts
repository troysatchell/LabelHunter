/**
 * The `RESOLVE` queue item's snapshot payload (LH-041 / TRO-474, CP-3
 * §2.3): what the `EXTRACT` worker hands the resolve-worker so it can call
 * `resolveEscalatedLabel` without ever re-running Haiku.
 */
import type { HaikuExtractionResult } from "../extractor/types";
import type { FlaggedField, LabelRouterResult, ReviewReason } from "../resolver/types";

/** The one supported snapshot version as of this ticket (CP-3 §2.3). A
 * `resolver_input` payload at any other version — including a missing one
 * — must be rejected, never guessed at. */
export const RESOLVER_INPUT_SCHEMA_VERSION = "1" as const;

export interface ResolverInputSnapshotV1 {
  schemaVersion: typeof RESOLVER_INPUT_SCHEMA_VERSION;
  extraction: HaikuExtractionResult;
  router: LabelRouterResult;
  flaggedFields: FlaggedField[];
}

/**
 * Derives the resolver's `flaggedFields` from the router's full result
 * (CP-3 §2.3: "which fields to ask about is a routing decision... only the
 * caller holding the full router result can make that call").
 *
 * Two tiers, in order:
 * 1. Every field row the router itself marked `NEEDS_REVIEW` — using that
 *    row's own `reviewReason` when it has one, or the label's
 *    `headlineReason` when it does not (a field can be `NEEDS_REVIEW` with
 *    a `null` reviewReason specifically when a label-level blocker like
 *    `LOW_IMAGE_QUALITY` already explains it — `../router/field-resolution.ts`'s
 *    `resolveComparatorField` absent-branch is exactly this case).
 * 2. If tier 1 finds nothing — a label-level blocker (`LOW_IMAGE_QUALITY`,
 *    `CONFLICTING_EXTRACTION`) can escalate the LABEL without any single
 *    field row individually reading `NEEDS_REVIEW` (e.g. a beverage-type
 *    mismatch or a warning present/transcription disagreement) — flag
 *    every field with the label's `headlineReason`, so
 *    `resolveEscalatedLabel`'s non-empty-`flaggedFields` requirement is
 *    always satisfiable for a genuine `REVIEW` verdict.
 */
export function deriveFlaggedFields(router: LabelRouterResult): FlaggedField[] {
  const fromRows: FlaggedField[] = [];
  for (const row of router.fields) {
    if (row.verdict !== "NEEDS_REVIEW") continue;
    const reviewReason = row.reviewReason ?? router.headlineReason;
    if (reviewReason) {
      fromRows.push({ field: row.field, reviewReason, trigger: row.reason });
    }
  }
  if (fromRows.length > 0) return fromRows;

  if (router.headlineReason) {
    const headlineReason: ReviewReason = router.headlineReason;
    return router.fields.map((row) => ({ field: row.field, reviewReason: headlineReason, trigger: row.reason }));
  }
  return [];
}

/** Builds the snapshot the `EXTRACT` worker stores on a `RESOLVE` row, in
 * the same transaction that writes `verifications`/`field_results`. */
export function buildResolverInputSnapshot(
  extraction: HaikuExtractionResult,
  router: LabelRouterResult,
  flaggedFields: FlaggedField[],
): ResolverInputSnapshotV1 {
  if (flaggedFields.length === 0) {
    // Standing rule 13: validate at the boundary. parseResolverInputSnapshot
    // below — the READ side of this same snapshot — rejects an empty
    // flaggedFields unconditionally; writing one here would only defer that
    // same failure to whichever RESOLVE worker reads this row back later,
    // with a far less useful stack trace pointing at the wrong module.
    // deriveFlaggedFields's own contract guarantees a non-empty result for
    // any genuine REVIEW verdict — an empty array reaching here means a
    // caller (or a future change to deriveFlaggedFields) broke that
    // guarantee, and should fail loudly right here, not downstream.
    throw new Error("buildResolverInputSnapshot: flaggedFields must not be empty — a RESOLVE item with nothing to ask about can never be resolved.");
  }
  return { schemaVersion: RESOLVER_INPUT_SCHEMA_VERSION, extraction, router, flaggedFields };
}

export type ParsedResolverInputSnapshot = { ok: true; snapshot: ResolverInputSnapshotV1 } | { ok: false; reason: string };

/**
 * Validates an unknown `jsonb` value read back from `batch_queue_items.
 * resolver_input`. Rejects — never clamps or guesses — anything that is
 * not exactly `schemaVersion: "1"` with the three required sub-objects
 * present (CP-3 §2.3). Does not deep-validate every field of `extraction`/
 * `router` against their full types: this snapshot was written by this
 * ticket's own trusted `EXTRACT` worker, not arbitrary external input —
 * the one thing that can genuinely drift across a deploy is the SHAPE
 * (`schemaVersion` exists precisely to catch that), not the field values.
 */
export function parseResolverInputSnapshot(value: unknown): ParsedResolverInputSnapshot {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "resolver_input is not an object." };
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== RESOLVER_INPUT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `resolver_input.schemaVersion is ${JSON.stringify(obj.schemaVersion)}, not the one supported version ${JSON.stringify(RESOLVER_INPUT_SCHEMA_VERSION)}.`,
    };
  }
  if (typeof obj.extraction !== "object" || obj.extraction === null) {
    return { ok: false, reason: "resolver_input.extraction is missing or not an object." };
  }
  if (typeof obj.router !== "object" || obj.router === null) {
    return { ok: false, reason: "resolver_input.router is missing or not an object." };
  }
  if (!Array.isArray(obj.flaggedFields) || obj.flaggedFields.length === 0) {
    return { ok: false, reason: "resolver_input.flaggedFields is missing, not an array, or empty." };
  }
  return {
    ok: true,
    snapshot: {
      schemaVersion: RESOLVER_INPUT_SCHEMA_VERSION,
      extraction: obj.extraction as HaikuExtractionResult,
      router: obj.router as LabelRouterResult,
      flaggedFields: obj.flaggedFields as FlaggedField[],
    },
  };
}
