/**
 * PRD §3.7's warning-check-outcome segmentation (TRO-469 / LH-021, TH-R9).
 * Restated precisely by CP-2 §8.4 (`docs/checkpoints/cp2-warning-subsystem.md`,
 * quoted below) as four mutually exclusive, exhaustive classes — this file
 * implements that restatement, not a remembered paraphrase of PRD §3.7's
 * looser original text.
 *
 * CP-2 §8.4's table, transcribed:
 *
 *   Clean pass            | both channels agree with the statute; and a
 *                            single-channel PASS at confidence >= 0.90     | no
 *   True mismatch (FAIL)  | wording deviation at distance >= 3;
 *                            capitalization failure                       | No — no matter
 *                                                                            how frequent
 *   Resolution-suspect    | LOW_IMAGE_QUALITY; channels disagree;
 *   (REVIEW)                near-miss band                                | Yes. This rate
 *                                                                            drives the ladder
 *   Not found (REVIEW)    | MISSING_REQUIRED_FIELD                        | No. Report it
 *                                                                            beside the rate,
 *                                                                            never inside it
 *
 * And its written denominator: "suspect rate = resolution-suspect /
 * (clean pass + true mismatch + resolution-suspect + not found)" — i.e.
 * every class shares ONE denominator, the total number of checks run, not
 * a filtered subset. `total` below IS that sum, by construction.
 *
 * ONE DELIBERATE EXTENSION BEYOND CP-2 §8.4'S OWN TABLE, documented here
 * because it is a judgment call, not a mechanical transcription.
 *
 * §8.4 builds its table directly from §6.1's table, which enumerates what
 * `WarningComparatorResult` (the LH-020 comparator's own return type) can
 * produce. But `resolveGovernmentWarningField`
 * (`src/server/router/field-resolution.ts`) — the ROUTER function that
 * wraps the comparator and is what actually decides the
 * `government_warning` field's final `reviewReason` — has two more paths
 * §6.1 never covers, because they sit outside the comparator entirely:
 *
 *   1. `input.overrideRejected` -> `CONFLICTING_EXTRACTION` (a pre-
 *      comparator, extractor-level structural rejection).
 *   2. A present, un-rejected warning with no comparator result at all
 *      (defensive; "should not happen") -> `LOW_MODEL_CONFIDENCE`.
 *
 * CP-2 §6.2 already names both reviewReasons as ones the comparator's own
 * union "cannot return" — so their absence from §8.4's table is that same
 * fact, carried forward, not a fresh decision. But both are still real,
 * reachable values on the `government_warning` `FieldResultRow` in a real
 * run, and both mean exactly what CP-2 §8.4 says resolution-suspect means:
 * "the check ran and could not confidently resolve it, one way or the
 * other." Excluding them would leave this function unable to classify a
 * real, valid router output — and would either crash the eval harness on
 * a real gate run (uncertain beats wrong, CLAUDE.md standing rule 12 —
 * applied here to this harness's own code, not just the product) or
 * silently miscount a real resolution-suspect case as something else. So
 * this function's `RESOLUTION_SUSPECT_REASONS` set is `WARNING_MISMATCH`
 * and `LOW_IMAGE_QUALITY` (§8.4's own named rows) PLUS `CONFLICTING_
 * EXTRACTION` and `LOW_MODEL_CONFIDENCE` (real for this field, just via
 * `resolveGovernmentWarningField`'s own two extra branches, not the
 * comparator). Flagged in TRO-469's PR body for Troy's own review.
 */
import type { ReviewReason } from "../../src/server/router/types";
import type { VerdictCaseScore, WarningSegmentationSummary, WarningSegmentCount } from "./types";

type WarningSegmentClass = "CLEAN" | "TRUE_MISMATCH" | "RESOLUTION_SUSPECT" | "NOT_FOUND";

/** See this file's module comment for exactly which two of these four
 * reasons come from CP-2 §8.4's own table (`LOW_IMAGE_QUALITY`,
 * `WARNING_MISMATCH`) versus this ticket's own documented extension
 * (`CONFLICTING_EXTRACTION`, `LOW_MODEL_CONFIDENCE`). */
const RESOLUTION_SUSPECT_REASONS: ReadonlySet<ReviewReason> = new Set([
  "LOW_IMAGE_QUALITY",
  "WARNING_MISMATCH",
  "CONFLICTING_EXTRACTION",
  "LOW_MODEL_CONFIDENCE",
]);

/** One case's `government_warning` outcome — the minimal shape
 * `classifyWarningOutcome` needs, factored out so it never has to reach
 * back into a whole `VerdictCaseScore`. */
interface WarningFieldOutcome {
  verdict: "MATCH" | "MISMATCH" | "NEEDS_REVIEW";
  reviewReason: ReviewReason | null;
}

/**
 * Classifies one case's `government_warning` outcome into one of the four
 * CP-2 §8.4 classes. Throws on a shape `resolveGovernmentWarningField`'s
 * own contract cannot produce — a harness wiring bug (the wrong field's
 * reviewReason got threaded through, most likely), not a real outcome to
 * silently bucket somewhere (standing rule 13: validate at the boundary).
 */
function classifyWarningOutcome(caseId: string, outcome: WarningFieldOutcome): WarningSegmentClass {
  if (outcome.verdict === "MATCH") return "CLEAN";
  if (outcome.verdict === "MISMATCH") return "TRUE_MISMATCH";

  // NEEDS_REVIEW from here down.
  //
  // reviewReason === null is a REAL outcome, not a wiring bug — found
  // running this ticket's own `--live --full` sweep (case-20), not a
  // hypothetical. `resolveGovernmentWarningField`
  // (`src/server/router/field-resolution.ts`) has one deliberate path
  // here: the warning is absent, required, AND the label already carries
  // a `LOW_IMAGE_QUALITY` blocker — CP-1 §5.3's own carve-out suppresses a
  // redundant `MISSING_REQUIRED_FIELD` then, because the true, single
  // cause is already named once, at the label level. That state is
  // DEFINITIONALLY tied to `lowImageQuality === true` by the router's own
  // condition (`input.required && !input.lowImageQuality` is the ONLY
  // guard on the `MISSING_REQUIRED_FIELD` branch), and it means the same
  // thing CP-2 §8.4's resolution-suspect class means: the check could not
  // confidently resolve one way or the other, and a resolution upgrade
  // might. It is NOT the "not found" class — the router explicitly did
  // not conclude the warning is absent, only that it could not tell.
  if (outcome.reviewReason === null) return "RESOLUTION_SUSPECT";

  if (outcome.reviewReason === "MISSING_REQUIRED_FIELD") return "NOT_FOUND";
  if (RESOLUTION_SUSPECT_REASONS.has(outcome.reviewReason)) return "RESOLUTION_SUSPECT";

  throw new Error(
    `segmentWarningCheckOutcomes: case "${caseId}" — government_warning carried reviewReason ` +
      `"${outcome.reviewReason}", which resolveGovernmentWarningField never assigns to this field ` +
      "(src/server/router/field-resolution.ts) — a harness wiring bug, not a real outcome.",
  );
}

/** Pulls the `government_warning` field's actual verdict/reviewReason out
 * of one case's already-scored `fields` array. Throws, naming the case,
 * when it is missing — `scoreVerdict`'s own contract guarantees one entry
 * per `RouterFieldKey` (it throws first if a caller's `ActualVerdict`
 * lacks one), so a `VerdictCaseScore` missing it here is malformed input
 * to this function, not a normal empty case. */
function findWarningOutcome(caseScore: VerdictCaseScore): WarningFieldOutcome {
  const field = caseScore.fields.find((f) => f.field === "government_warning");
  if (!field) {
    throw new Error(
      `segmentWarningCheckOutcomes: case "${caseScore.caseId}" has no government_warning field score.`,
    );
  }
  return { verdict: field.actualVerdict, reviewReason: field.actualReviewReason };
}

function toSegmentCount(count: number, total: number): WarningSegmentCount {
  return { count, rate: total === 0 ? 0 : count / total };
}

/**
 * Segments `cases` (one eval run's, or one batch's, scored verdicts) into
 * PRD §3.7 / CP-2 §8.4's four warning-check-outcome classes. Pure — no I/O.
 * Every rate shares the same denominator, `total` (CP-2 §8.4's own written
 * formula) — see this file's module comment.
 */
export function segmentWarningCheckOutcomes(cases: readonly VerdictCaseScore[]): WarningSegmentationSummary {
  const classes = cases.map((c) => classifyWarningOutcome(c.caseId, findWarningOutcome(c)));
  const total = classes.length;

  const cleanCount = classes.filter((c) => c === "CLEAN").length;
  const trueMismatchCount = classes.filter((c) => c === "TRUE_MISMATCH").length;
  const resolutionSuspectCount = classes.filter((c) => c === "RESOLUTION_SUSPECT").length;
  const notFoundCount = classes.filter((c) => c === "NOT_FOUND").length;

  // TRO-535 / LH-030b: the single-channel-pass rate, CP-2 §8.4's own named
  // residual false-PASS exposure ("Single-channel passes are counted as
  // clean passes and also reported as their own rate... They are the
  // residual false-PASS exposure", §10 Q7). NOT a fifth partition member —
  // it is the subset of `clean` (index-aligned with `classes` above) whose
  // `warningChannel` is `"single"`, so it can overlap `clean` by
  // construction and is excluded from the four-class sum a caller might
  // assert. Denominator: `total` — the SAME denominator every class above
  // shares. CP-2 §8.4 writes a denominator for the suspect rate only
  // (cp2:945-948); this rate's denominator is this function's own explicit
  // choice, stated here because CP-2 states none for it.
  const singleChannelPassCount = cases.filter((c, i) => classes[i] === "CLEAN" && c.warningChannel === "single").length;

  return {
    total,
    clean: toSegmentCount(cleanCount, total),
    trueMismatch: toSegmentCount(trueMismatchCount, total),
    resolutionSuspect: toSegmentCount(resolutionSuspectCount, total),
    notFound: toSegmentCount(notFoundCount, total),
    singleChannelPass: toSegmentCount(singleChannelPassCount, total),
  };
}
