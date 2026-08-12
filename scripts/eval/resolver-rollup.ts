/**
 * Rolls a Sonnet resolver resolution up into one label-level verdict — the
 * Sonnet-only benchmark arm's own "what would the system have decided"
 * step (LH-030 / TRO-470, PRD §4).
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHAT "SONNET-ONLY" MEANS HERE. The only
 * real Sonnet code path in this repository is `resolveEscalatedLabel`
 * (`src/server/resolver/`) — a function built to re-read and judge fields
 * the deterministic router ALREADY flagged, using the router's own decision
 * table and Haiku's own reading as context (`src/server/resolver/user-message.ts`).
 * There is no "Sonnet reads a label from a blank slate, no Haiku, no
 * router" code path in this codebase, and CLAUDE.md's own non-negotiable
 * (TH-R19, "never wire Sonnet into the per-label happy path") means this
 * ticket does not add one — that would be new production-shaped surface
 * area a benchmark script has no business introducing.
 *
 * `benchmark.ts`'s "Sonnet-only" arm is therefore defined operationally,
 * not hypothetically: every one of the five fields is flagged for Sonnet
 * on every case (`flagged-fields.ts`'s `buildAllFieldsFlagged`), regardless
 * of what the router decided — so the ROUTER's verdict never reaches the
 * final answer at all, and Sonnet alone decides every field. This measures
 * the real question PRD §4 asks: what does it cost, and how much does
 * accuracy change, if Sonnet judges every field on every label instead of
 * only the ~10-15% the cascade selectively escalates? It is not a
 * simulation of a from-scratch Sonnet extractor, and this file's own doc
 * comments say so rather than let a reader assume otherwise.
 *
 * The router's own pure roll-up functions (`rollupLabelVerdict`,
 * `pickHeadlineReason`) are reused directly, so this arm's label-level
 * roll-up rule is identical to production's, not a second hand-written
 * copy that could drift.
 */
import type { ExtractedField } from "../../src/server/extractor/types";
import { pickHeadlineReason, rollupLabelVerdict } from "../../src/server/router";
import type { ApplicationRecord, FieldComparators, FieldVerdict, ReviewReason } from "../../src/server/router/types";
import type {
  CorrectionFieldResolution,
  JudgedFieldResolution,
  ResolvedFieldResult,
  ResolverResolution,
} from "../../src/server/resolver";
import { reconcileWarningChannels } from "../../src/server/warning";
import { ROUTER_FIELD_KEYS } from "./types";
import type { ActualVerdict } from "./verdict-scoring";

/**
 * A field the resolver's own `NEEDS_HUMAN`/`needsHuman` signal escalates,
 * with no router-computed structural reason to attribute it to (there is
 * no router pass in this arm) — a deliberate, documented simplification,
 * not an attempt to reverse-engineer which of the router's eight reasons
 * Sonnet "meant". `benchmark.ts`'s own report notes this arm's
 * `reviewReason` accuracy is informational only for exactly this reason.
 */
const GENERIC_ESCALATION_REASON: ReviewReason = "LOW_MODEL_CONFIDENCE";

function rollUpJudgedField(field: JudgedFieldResolution): { verdict: FieldVerdict; reviewReason: ReviewReason | null } {
  switch (field.disposition) {
    case "RESOLVED_MATCH":
      return { verdict: "MATCH", reviewReason: null };
    case "RESOLVED_MISMATCH":
      return { verdict: "MISMATCH", reviewReason: null };
    case "NEEDS_HUMAN":
      return { verdict: "NEEDS_REVIEW", reviewReason: GENERIC_ESCALATION_REASON };
  }
}

/** The same application-value mapping `src/server/router/index.ts`'s own
 * (unexported) `comparatorApplicationValue` uses for these two fields —
 * reproduced here rather than imported because the source function is not
 * exported and covers a third case (`net_contents`' string form is
 * identical here) this file has no need to duplicate beyond these two. */
function correctionApplicationValue(
  field: "alcohol_content" | "net_contents",
  application: ApplicationRecord,
): string | number | undefined {
  return field === "alcohol_content"
    ? application.alcoholContentPercent
    : `${application.netContentsValue} ${application.netContentsUnit}`;
}

/**
 * Real property of reusing the production single-channel rule, worth
 * naming explicitly: with no OCR channel, `reconcileWarningChannels` can
 * only ever return MATCH or NEEDS_REVIEW for this field — never MISMATCH
 * (`reconcile.ts`'s own `reconcileSingleChannel` comment: "a single-channel
 * FAIL is never allowed, only REVIEW... we never accuse on one channel").
 * A reworded or wrong-case warning in the Sonnet-only arm therefore always
 * escalates rather than hard-failing, exactly as it would for any other
 * single-channel VLM-only reading in production. This is a real,
 * meaningful difference from the cascade arm's warning field, where the
 * REAL warning subsystem also has an OCR channel and CAN reach MISMATCH —
 * not a benchmark artifact to explain away.
 */
function rollUpGovernmentWarning(field: CorrectionFieldResolution): { verdict: FieldVerdict; reviewReason: ReviewReason | null } {
  if (field.correctedValue === null) {
    // `response.ts`'s `deriveResolvedFields` rejects a "decided"
    // (non-needsHuman) field whose `corrected_value` is null before this
    // code ever sees it — this is a contract violation, not a normal
    // input. A silent `?? ""` fallback here would feed the real warning
    // comparator an empty transcription and let it produce a verdict that
    // LOOKS real but rests on nothing — the exact "confident invention"
    // shape this repo's boundaries reject elsewhere (PR review finding).
    throw new Error(
      "rollUpGovernmentWarning: a decided (non-needsHuman) government_warning resolution has a null correctedValue — resolver contract violated.",
    );
  }
  const result = reconcileWarningChannels(
    { transcription: field.correctedValue, prefixCasing: "NOT_VISIBLE", confidence: field.confidence },
    // No OCR channel in this simulation — Sonnet's own transcription is the
    // only reading there is (see this file's module comment). `NOT_VISIBLE`
    // on `prefixCasing` skips the model-self-report cross-check
    // (`reconcile.ts`'s `applyPrefixCasingCrossCheck`) rather than feeding
    // it a fabricated classification the resolver's schema does not
    // actually produce.
    { available: false },
  );
  return result.verdict === "NEEDS_REVIEW"
    ? { verdict: "NEEDS_REVIEW", reviewReason: result.reviewReason }
    : { verdict: result.verdict, reviewReason: null };
}

function rollUpCorrectionField(
  field: CorrectionFieldResolution,
  application: ApplicationRecord,
  comparators: FieldComparators,
): { verdict: FieldVerdict; reviewReason: ReviewReason | null } {
  if (field.needsHuman) {
    return { verdict: "NEEDS_REVIEW", reviewReason: GENERIC_ESCALATION_REASON };
  }
  if (field.field === "government_warning") {
    return rollUpGovernmentWarning(field);
  }

  const applicationValue = correctionApplicationValue(field.field, application);
  if (applicationValue === undefined) {
    // The application never filed this field (e.g. ABV omitted on a beer
    // application) — nothing to compare Sonnet's reading against. Mirrors
    // the router's own "not required, nothing to check" MATCH path
    // (`field-resolution.ts`'s `resolveComparatorField`) rather than
    // inventing a REVIEW with no comparison behind it.
    return { verdict: "MATCH", reviewReason: null };
  }

  const extracted: ExtractedField = {
    value: field.correctedValue,
    evidence: field.evidence,
    confidence: field.confidence,
    alternates: [],
  };
  const comparatorResult = comparators[field.field](extracted, applicationValue, { beverageType: application.beverageType });
  return {
    verdict: comparatorResult.verdict,
    reviewReason: comparatorResult.verdict === "NEEDS_REVIEW" ? GENERIC_ESCALATION_REASON : null,
  };
}

/**
 * Rolls up ONE resolved field's disposition into a verdict + reviewReason —
 * exported (TRO-538 / LH-033) so `cascade-runner.ts`'s own merge step
 * (`mergeResolutionIntoActualVerdict`) can reuse the identical per-field
 * mapping this file already uses for the Sonnet-only arm, field by field,
 * WITHOUT going through `rollUpResolverResolution`'s all-five-fields
 * contract — the cascade arm's resolution can cover a strict subset of the
 * five router fields (a field-specific escalation only flags the one field
 * concerned), and `rollUpResolverResolution` throws on exactly that shape
 * (see its own doc comment). One mapping, two callers — never a second,
 * hand-copied switch statement that could drift from this one.
 */
export function rollUpOneField(
  field: ResolvedFieldResult,
  application: ApplicationRecord,
  comparators: FieldComparators,
): { verdict: FieldVerdict; reviewReason: ReviewReason | null } {
  return field.kind === "judged" ? rollUpJudgedField(field) : rollUpCorrectionField(field, application, comparators);
}

/**
 * Rolls a resolver resolution (every field decided by Sonnet — see this
 * file's module comment) up into one `ActualVerdict`, using the router's
 * own `rollupLabelVerdict`/`pickHeadlineReason` for the label-level
 * decision. Throws if `resolution.fields` does not cover all five router
 * fields exactly once — the Sonnet-only arm always flags every field
 * (`flagged-fields.ts`'s `buildAllFieldsFlagged`), so an incomplete OR a
 * duplicated resolution here is a harness bug, not a normal input to paper
 * over. A duplicate entry would otherwise disappear silently into the
 * `Map` below (whichever entry is built last wins, the earlier one is
 * simply discarded) — checked explicitly rather than trusted.
 */
export function rollUpResolverResolution(
  resolution: ResolverResolution,
  application: ApplicationRecord,
  comparators: FieldComparators,
): ActualVerdict {
  const byField = new Map(resolution.fields.map((f) => [f.field, f]));
  if (byField.size !== resolution.fields.length) {
    throw new Error(
      `rollUpResolverResolution: resolution.fields has ${resolution.fields.length} entries but only ${byField.size} distinct fields — duplicate field entries are not allowed.`,
    );
  }
  const reasons = new Set<ReviewReason>();
  const fields: ActualVerdict["fields"] = ROUTER_FIELD_KEYS.map((routerField) => {
    const resolved = byField.get(routerField);
    if (!resolved) {
      throw new Error(
        `rollUpResolverResolution: resolution.fields has no entry for "${routerField}" — the Sonnet-only arm must flag every field.`,
      );
    }
    const { verdict, reviewReason } = rollUpOneField(resolved, application, comparators);
    if (reviewReason) reasons.add(reviewReason);
    // ActualVerdict["fields"] is a discriminated union on `verdict`
    // (TRO-469 / LH-021, verdict-scoring.ts's `ActualFieldOutcome`):
    // `reviewReason` is required exactly when `verdict` is
    // `"NEEDS_REVIEW"`, matching rollUpOneField's own real invariant
    // (every one of its branches pairs "NEEDS_REVIEW" with a non-null
    // reason — see rollUpJudgedField/rollUpCorrectionField/
    // rollUpGovernmentWarning above) — asserted here, not assumed, so a
    // future branch that breaks the pairing fails loudly instead of
    // silently constructing an invalid ActualFieldOutcome.
    if (verdict !== "NEEDS_REVIEW") return { field: routerField, verdict };
    if (!reviewReason) {
      throw new Error(
        `rollUpResolverResolution: field "${routerField}" rolled up to NEEDS_REVIEW with no reviewReason — rollUpOneField's own invariant violated.`,
      );
    }
    return { field: routerField, verdict, reviewReason };
  });

  const labelVerdict = rollupLabelVerdict(
    false, // No label-level blocker concept in this arm — see module comment.
    fields.map((f) => f.verdict),
  );
  return { labelVerdict, headlineReason: pickHeadlineReason(reasons), fields };
}
