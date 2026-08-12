/**
 * Verdict accuracy: did the system's final label-level and field-level
 * verdicts match the golden set's `expected` block (LH-030 / TRO-470,
 * TH-R17)?
 *
 * Deliberately separate from extraction accuracy (`extraction-scoring.ts`)
 * — see that file's module comment for why. `scoreVerdict` takes an
 * `ActualVerdict`, not a `LabelRouterResult` directly, so ONE scorer serves
 * both the real cascade's router output (`check.ts`) and the Sonnet-only
 * arm's synthetic rolled-up verdict (`resolver-rollup.ts`, `benchmark.ts`)
 * — the same comparison, two different sources, matching the benchmark's
 * own requirement to score both arms the identical way.
 *
 * A golden-set case whose `expected.labelVerdict` is `"REVIEW"` is scored
 * as CORRECT when the system also lands on REVIEW with the matching
 * reason — the manifest's own design (several cases' `notes`, e.g.
 * case-12/13/17/18) treats "the system correctly escalates" as the right
 * answer for a case a human still needs to look at, not something a
 * verdict scorer should expect to resolve further to PASS/FAIL.
 */
import type { GoldenExpectedResult, GoldenSetCase } from "../../src/lib/golden-set/types";
import type { FieldVerdict, LabelVerdict, ReviewReason, RouterFieldKey } from "../../src/server/router/types";
import type { VerdictCaseScore, VerdictFieldScore } from "./types";

/** The system's actual verdict for one case, in the minimal shape
 * `scoreVerdict` needs — both callers (the real router's output, and the
 * Sonnet-only arm's rolled-up result) can build this without carrying
 * their own source-specific fields along. */
export interface ActualVerdict {
  labelVerdict: LabelVerdict;
  headlineReason: ReviewReason | null;
  fields: readonly { field: RouterFieldKey; verdict: FieldVerdict }[];
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
 * required fields — a caller bug (an incomplete pipeline result), not a
 * scoring judgment call to paper over.
 */
export function scoreVerdict(caseSpec: GoldenSetCase, actual: ActualVerdict): VerdictCaseScore {
  const expected = caseSpec.expected;
  const actualByField = new Map(actual.fields.map((f) => [f.field, f.verdict]));

  const fields: VerdictFieldScore[] = (
    Object.keys(EXPECTED_FIELD_TO_ROUTER_FIELD) as (keyof GoldenExpectedResult["fields"])[]
  ).map((expectedKey) => {
    const routerField = EXPECTED_FIELD_TO_ROUTER_FIELD[expectedKey];
    const expectedVerdict = expected.fields[expectedKey].verdict;
    const actualVerdict = actualByField.get(routerField);
    if (actualVerdict === undefined) {
      throw new Error(
        `scoreVerdict: case "${caseSpec.caseId}" — actual.fields has no entry for "${routerField}", required by the golden set's expected.fields.${expectedKey}`,
      );
    }
    return { field: routerField, expectedVerdict, actualVerdict, correct: expectedVerdict === actualVerdict };
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
