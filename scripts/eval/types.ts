/**
 * Shared types for the eval harness (LH-030 / TRO-470, TH-R17, TH-R19,
 * PRD §6).
 *
 * This file defines two accuracy questions. Extraction accuracy asks: did
 * Haiku read the label's fields correctly? It checks each field against
 * the golden set's ground-truth `label` block. Verdict accuracy asks: did
 * the Validation Router's final verdicts match expectations? It checks the
 * label-level and field-level verdicts against the golden set's `expected`
 * block. These two questions measure different things. A regression in one
 * can hide behind health in the other — see `check.ts`'s module comment.
 *
 * This file holds pure data shapes only. No type here may import from a
 * module that makes a network call.
 */
import type { GoldenSetCategory, LabelVerdict } from "../../src/lib/golden-set/types";
import type { ExtractedField, ExtractedImageQuality } from "../../src/server/extractor/types";
import type {
  FieldVerdict,
  LowImageQualityTrigger,
  ReviewReason,
  RouterFieldKey,
  WarningComparatorChannel,
} from "../../src/server/router/types";

/** The router's five field keys, in one place — `response-validation.ts`,
 * `flagged-fields.ts`, and `resolver-rollup.ts` each need this exact list
 * and previously each defined their own local copy (a PR review finding:
 * three independent copies of the same five-element array can drift). No
 * production module exports this as a runtime array — `RouterFieldKey` is
 * a type only (`src/server/router/types.ts`) — so this is the eval
 * harness's own single source, not a duplicate of one that already exists
 * elsewhere. */
export const ROUTER_FIELD_KEYS: readonly RouterFieldKey[] = [
  "brand_name",
  "class_type",
  "alcohol_content",
  "net_contents",
  "government_warning",
];

/** The five fields extraction accuracy scores. Named to match the golden
 * set's own `GoldenLabelFields` keys (`brandName`, not `brand_name`) — this
 * is a ground-truth comparison, not a router-field comparison, even though
 * four of the five names line up with `RouterFieldKey`. */
export type ExtractionFieldKey = "brandName" | "classType" | "abv" | "netContents" | "governmentWarning";

/** One field's extraction-accuracy result for one case. `expected`/`actual`
 * are human-readable summaries for the committed report, not raw values —
 * a reviewer reading the JSON should not need to cross-reference the
 * manifest to see what disagreed. */
export interface ExtractionFieldScore {
  field: ExtractionFieldKey;
  correct: boolean;
  expected: string;
  actual: string;
  /** Haiku's own self-reported confidence for this field (0.00-1.00),
   * captured from the SAME `HaikuExtractionResult` `correct` was already
   * scored against — no second API call, no database read (TRO-538 /
   * LH-033). CP-1 §4.5 step 1: "Record `confidence` and correctness for
   * every field." Feeds `EvalReportSummary.extractionReliabilityDiagram`
   * (step 2's reliability diagram). */
  confidence: number;
  /** One line, ASD-STE100 style, explaining the result. */
  detail: string;
}

export interface ExtractionCaseScore {
  caseId: string;
  category: GoldenSetCategory;
  fields: ExtractionFieldScore[];
}

/** One field's verdict-accuracy result for one case. Reused for both the
 * cascade arm (the router's real output) and the Sonnet-only arm (a
 * synthetic verdict rolled up from the resolver's per-field dispositions,
 * `resolver-rollup.ts`) — same comparison, two different inputs. */
export interface VerdictFieldScore {
  field: RouterFieldKey;
  expectedVerdict: FieldVerdict;
  actualVerdict: FieldVerdict;
  correct: boolean;
  /** Haiku's own self-reported extraction confidence for this field — the
   * SAME source `ExtractionFieldScore.confidence` uses (TRO-538 / LH-033),
   * even on the cascade (post-resolution) verdict score: this number always
   * answers "how confident was the EXTRACTION," never "how confident was
   * whichever stage (router or resolver) produced the final `actualVerdict`
   * on this row." */
  confidence: number;
  /** The real system's own `reviewReason` for this field, carried through
   * unscored (the golden set has no per-field expected reviewReason — see
   * `verdict-scoring.ts`'s `ActualFieldOutcome`). Non-null exactly when
   * `actualVerdict` is `NEEDS_REVIEW` — the same invariant
   * `field-resolution.ts`'s `resolveComparatorField`/
   * `resolveGovernmentWarningField` already hold on every real router
   * field. TRO-469 / LH-021: the input `warning-segmentation.ts` needs to
   * segment the `government_warning` field's outcomes (PRD §3.7); every
   * other field carries it too, for the same reason `category` is on every
   * `VerdictCaseScore` even though only some callers read it. */
  actualReviewReason: ReviewReason | null;
}

export interface VerdictCaseScore {
  caseId: string;
  category: GoldenSetCategory;
  expectedLabelVerdict: LabelVerdict;
  actualLabelVerdict: LabelVerdict;
  labelVerdictCorrect: boolean;
  expectedReviewReason: ReviewReason | null;
  actualReviewReason: ReviewReason | null;
  /** `true` when `expectedLabelVerdict` is not `"REVIEW"` (no reason to
   * check) or when the actual headline reason matches. A REVIEW case whose
   * label verdict is right but reason is wrong is a real, separate miss —
   * TH-R9/TH-R10 both care which reason the UI shows, not only PASS/FAIL. */
  reviewReasonCorrect: boolean;
  /** TRO-535 / LH-030b: which reconciliation table decided the
   * `government_warning` field's comparator verdict — `"dual"`,
   * `"single"`, or `null` when the real comparator never ran at all (e.g.
   * the warning was absent, so `resolveGovernmentWarningField` never
   * consults a comparator result — see `WarningComparatorResult`'s own doc
   * comment, `src/server/router/types.ts`). Always present, never
   * `undefined` — `verdict-scoring.ts`'s `scoreVerdict` normalizes an
   * absent `ActualVerdict.warningChannel` to `null`.
   * `warning-segmentation.ts`'s `singleChannelPass` reads this field
   * directly. */
  warningChannel: WarningComparatorChannel | null;
  /** TRO-542: which CP-1 §5.3 rule made the ROUTER's `isLowImageQuality`
   * fire — `LabelRouterResult.lowImageQualityTrigger`, scored at the same
   * ROUTER stage as `warningChannel` above. `null` when it did not fire,
   * or when this score has no router pass of its own (the Sonnet-only
   * benchmark arm, or a resolver-merged cascade end state — see
   * `ActualVerdict.lowImageQualityTrigger`'s own doc comment for why
   * those two never set it). Always present, never `undefined` —
   * `verdict-scoring.ts`'s `scoreVerdict` normalizes an absent value to
   * `null`, the same convention `warningChannel` uses. This is the field
   * that answers TRO-542's own acceptance evidence: "quote the recorded
   * trigger for case-20." */
  lowImageQualityTrigger: LowImageQualityTrigger | null;
  fields: VerdictFieldScore[];
}

/** count/correct/rate for one scored population — the same shape for a
 * whole run, one category, or one field, so summary code has one type to
 * build and callers do not need to guess which meaning a bare number
 * carries. */
export interface AccuracySummary {
  readonly total: number;
  readonly correct: number;
  /** `correct / total`, or `0` when `total` is `0` — division by zero is a
   * real input (an empty sample), not a bug; `0` is the honest answer
   * ("nothing to be right about"), not `NaN` printed into a report. */
  readonly rate: number;
}

/** Which arm of the pipeline produced one case's verdict-accuracy score —
 * only meaningful inside the cascade-vs-Sonnet-only benchmark
 * (`benchmark.ts`); `check.ts`'s own regression gate only ever runs the
 * cascade arm. */
export type PipelineArm = "cascade" | "sonnet-only";

/** Real, measured USD cost for one API call, derived from `usage.ts`'s
 * `computeCostUsd` applied to a real `Anthropic.Usage` — never a flat
 * per-label estimate (CLAUDE.md: "never fabricate a number"). */
export interface MeasuredCost {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly usd: number;
}

/** One golden-set case's full result under the real cascade: Haiku
 * extraction, the router's verdict, and — only when the router actually
 * escalated the case — one real resolver call. Cost/latency are always
 * real-measured; `null` only when that stage genuinely did not run (the
 * router did not escalate, so there is no resolver cost to report). */
export interface CascadeCaseResult {
  caseId: string;
  category: GoldenSetCategory;
  extraction: ExtractionCaseScore;
  /** RENAMED from `verdict` (TRO-538 / LH-033) — the Validation Router's
   * OWN verdict, scored from the `/api/verify` response body BEFORE any
   * resolver call, on every case, escalated or not. This is the number CP-1
   * §4.5 step 3's "auto-verified rate" (the share of labels finished
   * without a resolver call) is built from — see `cascadeVerdict` below for
   * the number that number is NOT. */
  routerVerdict: VerdictCaseScore;
  /** NEW (TRO-538 / LH-033) — the cascade's END STATE. Identical to
   * `routerVerdict` when the router did not escalate this case (nothing to
   * merge). When it did escalate, this is the router's own field rows with
   * every RESOLVER-FLAGGED field overridden by the resolver's own
   * disposition, rolled up fresh — see `cascade-runner.ts`'s
   * `mergeResolutionIntoActualVerdict` for the merge rule, the per-field
   * mapping it reuses from `resolver-rollup.ts`, and its own doc comment
   * for the open design decision on the router's label-level blocker.
   * `benchmark.ts` compares THIS number against the Sonnet-only arm's —
   * never `routerVerdict`, which measures an earlier pipeline stage. */
  cascadeVerdict: VerdictCaseScore;
  haikuCost: MeasuredCost;
  /** `null` when the router did not escalate this case (Sonnet never runs
   * then, TH-R19) OR when it escalated but the real resolver call itself
   * failed (`resolverError` names the failure then). */
  resolverCost: MeasuredCost | null;
  /** The resolver's own outcome, reported for evidence, never scored
   * against a golden answer — the manifest has no ground truth for what
   * Sonnet's resolution should say (see `check.ts`'s module comment). `null`
   * on no escalation OR a failed resolver call — check `resolverError` to
   * tell the two apart. */
  resolverOutcome: "resolved" | "needs-human" | null;
  /** Non-null only when the router escalated this case AND the real
   * resolver call itself threw (a transient API failure, most likely) —
   * this case's extraction and verdict scores are still real and valid;
   * only the resolver evidence is missing for it. `null` on no escalation
   * and on a successful resolver call alike. */
  resolverError: string | null;
  /** Wall-clock time for the resolver call alone, in milliseconds. `null`
   * when the case did not escalate, or the call itself failed before
   * producing a duration worth reporting — not the whole case's total time
   * (Haiku extraction, preprocessing, and DB I/O are not included), a
   * narrower, more precisely named number than "total" would suggest. */
  resolverDurationMs: number | null;
  /** NEW (TRO-538 / LH-033) — the whole `image_quality` object Haiku's
   * extraction produced for this case: `legible`, `issues`, `confidence`
   * (`src/server/extractor/types.ts`'s `ExtractedImageQuality`). Recorded
   * as evidence, not scored — no table in the schema keeps this today
   * (`src/lib/db/schema.ts`), so the committed report is the only place
   * this value survives past the run that produced it. */
  imageQuality: ExtractedImageQuality;
  /** NEW (TRO-538 / LH-033) — `beverage_type`'s raw extractor reading,
   * recorded as evidence, never scored: no golden label prints its
   * category word, so no label ground truth exists to score against (see
   * `docs/diagnostics/2026-08-12-verdict-miss-triage.md` §3C, and this
   * ticket's own "Do NOT add beverage_type to the extraction-accuracy
   * denominator"). Case-11's diagnosis needs these recorded values, not a
   * score. Derived from `ExtractedField` via `Pick`, not a hand-copied
   * shape, so a change to the extractor's own field type cannot silently
   * drift out of sync with this report type (CodeRabbit finding, TRO-538
   * triage). */
  beverageType: Pick<ExtractedField, "value" | "evidence" | "confidence">;
}

/** One class's count in the PRD §3.7 / CP-2 §8.4 warning-check-outcome
 * segmentation — the same total/rate shape as `AccuracySummary`, with
 * `count` in place of `correct`/`total`: a segment is a mutually-exclusive
 * bucket of a fixed partition, not a right-vs-wrong score. */
export interface WarningSegmentCount {
  readonly count: number;
  /** `count / total`, sharing ONE denominator across all four classes —
   * CP-2 §8.4's own written formula: "suspect rate = resolution-suspect /
   * (clean pass + true mismatch + resolution-suspect + not found)". `0` on
   * an empty run, never `NaN` (same convention as `AccuracySummary.rate`). */
  readonly rate: number;
}

/**
 * PRD §3.7's warning-check-outcome segmentation, restated precisely by CP-2
 * §8.4 (`docs/checkpoints/cp2-warning-subsystem.md`) as four mutually
 * exclusive, exhaustive classes over the `government_warning` field's own
 * ACTUAL verdict. An operational/incidence metric ("a number in CI output,
 * not a judgment call mid-week") — not an accuracy score against ground
 * truth; the golden set carries no per-field expected `reviewReason` to
 * score against (see `VerdictFieldScore.actualReviewReason`'s own doc
 * comment). Computed by `warning-segmentation.ts`'s
 * `segmentWarningCheckOutcomes`; TRO-469 / LH-021.
 */
export interface WarningSegmentationSummary {
  /** Sum of the four classes below, by construction — every scored case
   * lands in exactly one (CP-2 §8.4: "their counts must sum to the number
   * of checks run"). */
  readonly total: number;
  readonly clean: WarningSegmentCount;
  /** Wording deviation (distance >= 3) or a hard capitalization failure —
   * "NOT an upgrade signal, no matter how frequent" (CP-2 §8.4). */
  readonly trueMismatch: WarningSegmentCount;
  /** `LOW_IMAGE_QUALITY`, `WARNING_MISMATCH` (channel disagreement or the
   * near-miss band), `CONFLICTING_EXTRACTION`, or `LOW_MODEL_CONFIDENCE` —
   * every case where the check ran and could not confidently resolve one
   * way or the other. CP-2 §8.4: "This rate drives the ladder." */
  readonly resolutionSuspect: WarningSegmentCount;
  /** `MISSING_REQUIRED_FIELD` — no warning was present to check at all.
   * CP-2 §8.4: "An absent warning is a labelling question, not a
   * resolution question. Report it beside the rate, never inside it." */
  readonly notFound: WarningSegmentCount;
  /**
   * TRO-535 / LH-030b: the subset of `clean` where `warningChannel` is
   * `"single"` — a lone VLM reading, with no OCR channel to disagree with
   * it, decided PASS. CP-2 §8.4 names this the residual false-PASS
   * exposure (§10 Q7): nothing here proves the VLM read the label rather
   * than reciting the statute from memory. NOT a fifth, mutually-exclusive
   * partition member — it overlaps `clean` by construction ("Single-channel
   * passes are counted as clean passes and ALSO reported as their own
   * rate", CP-2 §8.4) — so it is not part of the four-class sum below.
   * Denominator: `total`, the SAME denominator the four classes above
   * share. CP-2 §8.4 states a denominator for the suspect rate only; this
   * rate's denominator is `warning-segmentation.ts`'s own explicit choice,
   * stated there because CP-2 states none for this one.
   */
  readonly singleChannelPass: WarningSegmentCount;
}

/**
 * One confidence-decile bucket of CP-1 §4.5 step 2's reliability diagram:
 * every scored EXTRACTION field (`ExtractionFieldScore`, not
 * `VerdictFieldScore` — CP-1 §4.5 step 1 says "run the EXTRACTOR over the
 * golden set," an extraction-correctness question) grouped by its own
 * Haiku confidence, rounded down to the nearest tenth (TRO-538 / LH-033).
 * `n` rides beside `rate` deliberately: 160 field scores over ten deciles
 * gives some buckets a handful of members (some may be empty), and a rate
 * with no `n` beside it invites over-reading a thin sample as a real trend.
 */
export interface ReliabilityBucket {
  /** 0-9. Bucket `k` covers confidence in `[k/10, (k+1)/10)`, except bucket
   * 9, which is `[0.9, 1.0]` (closed at 1.0 — a field confidence of exactly
   * 1.0 must land somewhere). */
  decile: number;
  n: number;
  correct: number;
  /** `correct / n`, or `0` when `n` is `0` (an empty decile — same
   * empty-population convention as `AccuracySummary.rate`). */
  rate: number;
}

export interface EvalReportSummary {
  extractionAccuracy: AccuracySummary;
  /** Per-`ExtractionFieldKey` breakdown — TH-R17's "field by field". */
  extractionAccuracyByField: Record<ExtractionFieldKey, AccuracySummary>;
  /** RENAMED from `labelVerdictAccuracy` (TRO-538 / LH-033) — the
   * Validation Router's OWN verdict accuracy, scored BEFORE any resolver
   * call. CP-1 §4.5 step 3's "auto-verified rate" denominator. See
   * `cascadeVerdictAccuracy` below for the number this is NOT — the two
   * are deliberately named apart so a reader cannot confuse a router-stage
   * number with a cascade-end-state one. */
  routerVerdictAccuracy: AccuracySummary;
  /** Per-`RouterFieldKey` breakdown of field-verdict accuracy — scored at
   * the ROUTER stage, same stage as `routerVerdictAccuracy`. */
  fieldVerdictAccuracyByField: Record<RouterFieldKey, AccuracySummary>;
  /** Scored at the ROUTER stage — see `routerVerdictAccuracy`'s own doc
   * comment. */
  reviewReasonAccuracy: AccuracySummary;
  /** PRD §3.7's warning upgrade-ladder segmentation (TRO-469 / LH-021) —
   * scored at the ROUTER stage, same stage as `routerVerdictAccuracy`. */
  warningSegmentation: WarningSegmentationSummary;
  /** NEW (TRO-538 / LH-033) — the cascade's END STATE label-verdict
   * accuracy: `routerVerdictAccuracy` for a non-escalated case, the merged
   * router+resolver verdict for an escalated one (`CascadeCaseResult.cascadeVerdict`).
   * This is the number to compare against the Sonnet-only benchmark arm —
   * see `benchmark.ts`. */
  cascadeVerdictAccuracy: AccuracySummary;
  /** NEW (TRO-538 / LH-033) — CP-1 §4.5 step 2's reliability diagram, built
   * from every scored extraction field's own confidence. Always exactly 10
   * entries (deciles 0-9), even when a decile's `n` is 0. */
  extractionReliabilityDiagram: ReliabilityBucket[];
}

/** The committed evidence artifact `pnpm eval:check -- --live` writes
 * (`scripts/eval/results/eval-report.json`) — this ticket's equivalent of
 * `scripts/latency/results/single-label-verify.json`. Cheap-mode
 * `pnpm eval:check` (no `--live`) reads this file back and never re-derives
 * it. */
export interface EvalReport {
  ticket: string;
  measuredAt: string;
  mode: "live";
  haikuModel: string;
  sonnetModel: string;
  /** `golden-set/manifest.json`'s own `version` field — a report is only
   * comparable to a baseline built from the same manifest schema version. */
  manifestVersion: string;
  /** SHA-256 of `golden-set/manifest.json`'s raw file content at the time
   * this run measured (TRO-538 / LH-033, `manifest-hash.ts`) — moves with
   * every edit, unlike `manifestVersion`, which seven straight
   * manifest-editing commits left at `"1.0.0"`
   * (`docs/diagnostics/2026-08-12-verdict-miss-triage.md` §5 S5). */
  manifestContentHash: string;
  /** Sorted case IDs this report actually ran — `baseline-compare.ts`'s
   * staleness check needs this to know whether a report has at least the
   * coverage a baseline was built from. */
  caseIds: string[];
  requestedFull: boolean;
  summary: EvalReportSummary;
  cases: CascadeCaseResult[];
  /** Real, summed cost across every case this report ran — Haiku always,
   * Sonnet only for escalated cases. */
  totalCostUsd: number;
  failures: EvalCaseFailure[];
}

/** One case the harness could not score — a hard failure (a thrown error,
 * a non-200 route response), not a low-confidence answer. Recorded, never
 * silently dropped from the report (same "uncertain beats wrong" discipline
 * as the router itself, CLAUDE.md standing rule 12). */
export interface EvalCaseFailure {
  caseId: string;
  error: string;
}

/** One repeat's aggregate accuracy for the two metrics the band baseline
 * bands (TRO-561): extraction accuracy and cascade-verdict accuracy — the
 * two headline rates TRO-561's own bug report showed failing on two of
 * three honest re-runs of unchanged code, because the old baseline pinned
 * its floor to a single historical draw instead of a measured range.
 * `repeatIndex` is 1-based, matching `RepeatedVerdict`'s own convention
 * (`variance-analysis.ts`). */
export interface BaselineRepeatAccuracy {
  readonly repeatIndex: number;
  readonly extractionAccuracy: AccuracySummary;
  readonly cascadeVerdictAccuracy: AccuracySummary;
}

/** The observed `[min, max]` range for one banded metric across the
 * baseline's K repeats (TRO-561). `min` is the gate floor
 * (`baseline-compare.ts`'s `compareToBaseline`) — "at or above the band's
 * own bottom," never "at or above the single highest draw the K repeats
 * happened to produce." `spread` restates `max - min` so a reader never
 * has to subtract two rates by hand. */
export interface AccuracyBand {
  readonly min: number;
  readonly max: number;
  readonly spread: number;
}

/** Real, measured USD cost recorded on the baseline band (TRO-561) — the
 * same "never fabricate a number" discipline `MeasuredCost` already
 * enforces per API call, rolled up across the whole K x N sweep that
 * established this baseline. `meanSonnetCallUsd` is `null` when the sweep's
 * router never escalated any case to the resolver (TH-R19: Sonnet only
 * runs on a real escalation) — never a fabricated `0`. */
export interface BaselineCost {
  readonly totalUsd: number;
  readonly meanHaikuCallUsd: number;
  readonly meanSonnetCallUsd: number | null;
}

/**
 * The committed regression floor (`scripts/eval/baseline.json`) — TRO-561's
 * band redesign of the earlier single-point `EvalBaseline` (LH-030 /
 * TRO-470). A single fresh run is one draw from the pipeline's own real
 * call-to-call model variance (TRO-543 / LH-038 measured a 3.2-point spread
 * on unchanged code against unchanged images) — pinning the floor to one
 * historical draw's number means two of three honest re-runs of unchanged
 * code can fail the gate (TRO-561's own bug report: the committed baseline
 * sat at 81.3%, the exact TOP of the measured band). The fix: measure K
 * repeats over the FULL golden set once (the re-baseline protocol,
 * `scripts/eval/variance.ts`'s `--establish-baseline`, extending the
 * existing `eval:variance` sweep rather than a second cascade path), and
 * set the floor at the observed MINIMUM across those K repeats — the
 * band's own bottom, not its top.
 *
 * Bands exactly the two headline rates TRO-561's own bug report named:
 * extraction accuracy and cascade-verdict accuracy (`repeats`,
 * `extractionAccuracyBand`, `cascadeVerdictAccuracyBand`).
 * `routerVerdictAccuracy` and `reviewReasonAccuracy`
 * (`EvalReportSummary`'s other two headline rates) are NOT banded here.
 * `cascadeVerdictAccuracy` is already documented (TRO-538 / LH-033, see
 * `EvalReportSummary.cascadeVerdictAccuracy`'s own comment) as the
 * cascade's real END STATE — the number to trust; `routerVerdictAccuracy`
 * is an earlier, diagnostic-only stage (the auto-verified-rate
 * denominator), and `reviewReasonAccuracy` is scored over a small subset
 * (only the REVIEW-expected cases) — the same "real diagnostic detail, not
 * gated" treatment `baseline-compare.ts`'s own module comment already gives
 * the per-field breakdowns, for the identical small-sample-noise reason.
 * Both stay in every `EvalReportSummary` and print on every run — reported,
 * never silently dropped — just not banded or gated.
 */
export interface EvalBaseline {
  readonly ticket: string;
  readonly establishedAt: string;
  /** K — how many repeats this band was measured from. */
  readonly k: number;
  /** One entry per repeat, `repeatIndex` 1..k. */
  readonly repeats: readonly BaselineRepeatAccuracy[];
  readonly extractionAccuracyBand: AccuracyBand;
  readonly cascadeVerdictAccuracyBand: AccuracyBand;
  /** Every case ID this band's sweep completed every repeat for, mapped to
   * the DISTINCT label verdicts observed across those repeats — e.g.
   * `["PASS"]` for a fully stable case, `["PASS", "REVIEW"]` for one that
   * split (case-17's own known behavior, LH-038 / TRO-543). Reported
   * evidence, not itself gated. */
  readonly perCaseVerdictSets: Readonly<Record<string, readonly LabelVerdict[]>>;
  readonly manifestVersion: string;
  /** SHA-256 of `golden-set/manifest.json`'s raw content when this baseline
   * band was established (TRO-538 / LH-033) — see
   * `EvalReport.manifestContentHash`'s own doc comment. `baseline-compare.ts`
   * rejects a comparison whose current run's hash disagrees with this one,
   * naming it the `"stale-baseline"` problem class — never conflated with
   * an accuracy regression (TRO-561's own Do item 4). */
  readonly manifestContentHash: string;
  /** The commit that last touched `golden-set/` as of this band's
   * measurement (`git log -1 -- golden-set/`) — TRO-561's own requirement:
   * "the corpus SHA point is a design requirement, not decoration." A hash
   * proves WHAT changed; this SHA names WHEN and by which commit, so a
   * reader can find the exact corpus state this band measured without
   * reverse-engineering it from the hash alone. */
  readonly goldenSetCommitSha: string;
  /** Every case ID the sweep that established this band ran (sorted) — the
   * coverage `compareToBaseline`'s `"coverage-mismatch"` problem class
   * checks a fresh run against. */
  readonly caseIds: readonly string[];
  readonly haikuModel: string;
  readonly sonnetModel: string;
  /** `git rev-parse HEAD` of the code that ran this band's sweep. */
  readonly codeCommitSha: string;
  readonly costUsd: BaselineCost;
}
