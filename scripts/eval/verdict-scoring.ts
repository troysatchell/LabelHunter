/**
 * Verdict accuracy asks one question: did the system's final verdicts
 * match the golden set's `expected` block? It checks both the label-level
 * verdict and each field-level verdict (LH-030 / TRO-470, TH-R17).
 *
 * This file is deliberately separate from extraction accuracy
 * (`extraction-scoring.ts`) — see that file's module comment for why.
 *
 * `scoreVerdict` takes an `ActualVerdict`, not a `LabelRouterResult`,
 * directly. This lets one scorer serve two different callers: the real
 * cascade's router output (`check.ts`), and the Sonnet-only arm's
 * synthetic rolled-up verdict (`resolver-rollup.ts`, `benchmark.ts`). Both
 * callers get the identical comparison — the benchmark's own requirement.
 *
 * A golden-set case can expect `"REVIEW"` as its `labelVerdict`. This
 * scorer marks such a case CORRECT when the system also lands on REVIEW
 * with the matching reason. Several cases' `notes` (e.g. case-12/13/17/18)
 * confirm this is the manifest's own design: "the system correctly
 * escalates" is the right answer for a case a human still needs to look
 * at. This scorer does not expect the system to resolve such a case
 * further, to PASS or FAIL.
 */
import type { GoldenExpectedResult, GoldenSetCase } from "../../src/lib/golden-set/types";
import type { HaikuExtractionResult } from "../../src/server/extractor/types";
import type { LabelVerdict, ReviewReason, RouterFieldKey } from "../../src/server/router/types";
import type { VerdictCaseScore, VerdictFieldScore } from "./types";

/** `RouterFieldKey` -> the matching confidence on `HaikuExtractionResult`
 * (TRO-538 / LH-033) — the SAME per-field confidence
 * `extraction-scoring.ts`'s own `EXTRACTION_FIELD_CONFIDENCE` reads, kept
 * as a second, small, router-field-keyed copy rather than shared: the two
 * tables are keyed by different field-name conventions
 * (`ExtractionFieldKey`'s `brandName` vs `RouterFieldKey`'s `brand_name` —
 * `types.ts`'s own doc comment on `ExtractionFieldKey` names this exact
 * naming split) and importing one from the other's module would blur which
 * question ("did Haiku read this right" vs "did the verdict match") each
 * table serves. */
const ROUTER_FIELD_CONFIDENCE: Record<RouterFieldKey, (extraction: HaikuExtractionResult) => number> = {
  brand_name: (e) => e.brand_name.confidence,
  class_type: (e) => e.class_type.confidence,
  alcohol_content: (e) => e.alcohol_content.confidence,
  net_contents: (e) => e.net_contents.confidence,
  government_warning: (e) => e.government_warning.confidence,
};

/**
 * One field's actual outcome. A discriminated union on `verdict`, not an
 * independently-optional `reviewReason` (standing rule 19: "a field whose
 * validity depends on another field's value needs a discriminated union"):
 * `reviewReason` is forbidden on `MATCH`/`MISMATCH` — a caller cannot
 * construct `{ verdict: "MATCH", reviewReason: "..." }`, a compile error.
 *
 * `reviewReason` on the `NEEDS_REVIEW` branch is `ReviewReason | null`, NOT
 * required-non-null — found running this ticket's own `--live --full`
 * sweep against the real golden set (case-20, a severely degraded image),
 * not a hypothetical. `field-resolution.ts`'s `resolveComparatorField`/
 * `resolveGovernmentWarningField` both have a real, DELIBERATE path to
 * `{ verdict: "NEEDS_REVIEW", reviewReason: null }`: a required field that
 * is absent AND the label already carries a `LOW_IMAGE_QUALITY` blocker
 * (CP-1 §5.3's own carve-out comment: "LOW_IMAGE_QUALITY already explains
 * the whole label") — deliberately suppressing a redundant, misleading
 * `MISSING_REQUIRED_FIELD` on every other field when the one true cause is
 * already named once, at the label level. `FieldResultRow`'s own type
 * (`src/server/router/types.ts`) already permits exactly this: it
 * discriminates `resolvedBy`/`reviewReason` together, never `verdict`/
 * `reviewReason` — this type now matches that real, looser invariant
 * instead of a stricter one this ticket's first draft assumed and a real
 * run disproved.
 */
export type ActualFieldOutcome =
  | { field: RouterFieldKey; verdict: "MATCH" | "MISMATCH" }
  | { field: RouterFieldKey; verdict: "NEEDS_REVIEW"; reviewReason: ReviewReason | null };

/** The system's actual verdict for one case, in the minimal shape
 * `scoreVerdict` needs — both callers (the real router's output, and the
 * Sonnet-only arm's rolled-up result) can build this without carrying
 * their own source-specific fields along. */
export interface ActualVerdict {
  labelVerdict: LabelVerdict;
  headlineReason: ReviewReason | null;
  fields: readonly ActualFieldOutcome[];
}

/** Maps the golden set's `expected.fields` keys (`GoldenExpectedResult`,
 * camelCase, four of five matching English words) to the router's own
 * `RouterFieldKey` (snake_case) — one explicit table, not a naming
 * convention a typo could silently break. */
const EXPECTED_FIELD_TO_ROUTER_FIELD: Record<keyof GoldenExpectedResult["fields"], RouterFieldKey> = {
  brandName: "brand_name",
  classType: "class_type",
  abv: "alcohol_content",
  netContents: "net_contents",
  governmentWarning: "government_warning",
};

/**
 * Scores one case's verdict accuracy against `actual`. Pure — no I/O.
 * Throws if `actual.fields` is missing an entry for one of the five
 * required fields, or names one twice, — a caller bug (an incomplete or
 * malformed pipeline result), not a scoring judgment call to paper over. A
 * duplicate would otherwise disappear silently into the `Map` below
 * (whichever entry is built last wins) instead of being caught here.
 *
 * `extraction` (TRO-538 / LH-033) is the SAME real `HaikuExtractionResult`
 * every caller already has in hand — `cascade-runner.ts`'s captured
 * extraction, reused (not re-called) for the Sonnet-only arm too
 * (`benchmark.ts`). Required, not optional: every `VerdictFieldScore` this
 * function builds needs a real confidence, never a silent default standing
 * in for one.
 */
export function scoreVerdict(caseSpec: GoldenSetCase, actual: ActualVerdict, extraction: HaikuExtractionResult): VerdictCaseScore {
  const expected = caseSpec.expected;
  const actualByField = new Map(actual.fields.map((f) => [f.field, f]));
  if (actualByField.size !== actual.fields.length) {
    throw new Error(
      `scoreVerdict: case "${caseSpec.caseId}" — actual.fields has ${actual.fields.length} entries but only ${actualByField.size} distinct fields — duplicate field entries are not allowed.`,
    );
  }

  const fields: VerdictFieldScore[] = (
    Object.keys(EXPECTED_FIELD_TO_ROUTER_FIELD) as (keyof GoldenExpectedResult["fields"])[]
  ).map((expectedKey) => {
    const routerField = EXPECTED_FIELD_TO_ROUTER_FIELD[expectedKey];
    const expectedVerdict = expected.fields[expectedKey].verdict;
    const actualField = actualByField.get(routerField);
    if (actualField === undefined) {
      throw new Error(
        `scoreVerdict: case "${caseSpec.caseId}" — actual.fields has no entry for "${routerField}", required by the golden set's expected.fields.${expectedKey}`,
      );
    }
    const actualVerdict = actualField.verdict;
    return {
      field: routerField,
      expectedVerdict,
      actualVerdict,
      correct: expectedVerdict === actualVerdict,
      confidence: ROUTER_FIELD_CONFIDENCE[routerField](extraction),
      actualReviewReason: actualField.verdict === "NEEDS_REVIEW" ? actualField.reviewReason : null,
    };
  });

  const expectedReviewReason = expected.reviewReason ?? null;
  const labelVerdictCorrect = expected.labelVerdict === actual.labelVerdict;
  // A reason only has a right answer when the golden set expects REVIEW —
  // on a PASS/FAIL case, `reviewReasonCorrect` reports "no reason to check
  // was violated" (true) rather than comparing two nulls that both happen
  // to be null for unrelated reasons.
  const reviewReasonCorrect =
    expected.labelVerdict !== "REVIEW" || expectedReviewReason === actual.headlineReason;

  return {
    caseId: caseSpec.caseId,
    category: caseSpec.category,
    expectedLabelVerdict: expected.labelVerdict,
    actualLabelVerdict: actual.labelVerdict,
    labelVerdictCorrect,
    expectedReviewReason,
    actualReviewReason: actual.headlineReason,
    reviewReasonCorrect,
    fields,
  };
}
