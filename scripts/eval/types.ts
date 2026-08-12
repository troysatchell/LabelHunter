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
import type { FieldVerdict, ReviewReason, RouterFieldKey } from "../../src/server/router/types";

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
  verdict: VerdictCaseScore;
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
}

export interface EvalReportSummary {
  extractionAccuracy: AccuracySummary;
  /** Per-`ExtractionFieldKey` breakdown — TH-R17's "field by field". */
  extractionAccuracyByField: Record<ExtractionFieldKey, AccuracySummary>;
  labelVerdictAccuracy: AccuracySummary;
  /** Per-`RouterFieldKey` breakdown of field-verdict accuracy. */
  fieldVerdictAccuracyByField: Record<RouterFieldKey, AccuracySummary>;
  reviewReasonAccuracy: AccuracySummary;
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

/** The committed regression floor (`scripts/eval/baseline.json`).
 * Deliberately narrower than `EvalReport` — a baseline is a comparison
 * target, not a full evidence record; the full record for the run that
 * produced it lives in the paired `eval-report.json`. */
export interface EvalBaseline {
  ticket: string;
  establishedAt: string;
  manifestVersion: string;
  caseIds: string[];
  summary: EvalReportSummary;
}
