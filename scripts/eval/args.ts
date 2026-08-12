/**
 * CLI argument parsing for the eval harness (LH-030 / TRO-470).
 *
 * Split out from `check.ts`/`benchmark.ts` for the same reason
 * `scripts/latency/args.ts` is split from `measure.ts`: neither script may
 * make a real, paid API call just because a test imported it to check
 * argument parsing. This file has no side effects at import time and calls
 * nothing on its own.
 *
 * Cost discipline (CLAUDE.md: "cap real spend deliberately", the
 * `scripts/latency/args.ts` `MAX_RUNS` precedent):
 *
 *   - No flag at all runs in CHEAP mode — no live API call, ever (see
 *     `check.ts`'s module comment for why this is the default, not
 *     `--live`).
 *   - `--live` is required to spend real money. Its own default sample is
 *     `DEFAULT_SAMPLE_CASE_IDS`, a small, fixed, deliberately-chosen subset
 *     — a genuine full-golden-set sweep needs the separate `--full` flag,
 *     never a `--runs=2000`-style typo away.
 *   - `--case=<id>` runs exactly one named case, for debugging a single
 *     result without paying for the rest of the sample.
 */

/**
 * A fixed, deliberately small subset of the 31-case golden set
 * (`golden-set/manifest.json`), chosen to span every `LabelVerdict` and a
 * spread of `GoldenSetCategory` values without running (and paying for)
 * the whole set on every `--live` invocation:
 *
 *   - case-01: clean-match spirits, PASS — the TH-R11 reference case.
 *   - case-02: clean-match beer, PASS, ABV omitted (the ABV-optional path).
 *   - case-05: abv-mismatch, FAIL.
 *   - case-08: title-case-warning, FAIL — Jenny Park's real catch (TH-R9).
 *   - case-12: missing-warning, REVIEW / MISSING_REQUIRED_FIELD.
 *   - case-14: case-variant-brand, PASS — the STONE'S THROW case (TH-R8).
 *   - case-17: glare, REVIEW / LOW_IMAGE_QUALITY.
 *   - case-25: odd-typography, REVIEW / LOW_MODEL_CONFIDENCE (brand_name).
 *
 * `case-23` (tiny-warning-text) was this list's original LOW_MODEL_CONFIDENCE
 * exemplar; TRO-469 / LH-021 (CP-2 §9.2 finding 1) corrected its own
 * expected reviewReason to `LOW_IMAGE_QUALITY` — `WarningComparatorResult`
 * cannot return `LOW_MODEL_CONFIDENCE` (`docs/checkpoints/cp2-warning-subsystem.md`
 * §6.2), so a tiny-but-legible warning reaching that comparator always
 * routes on image quality, never model confidence. Swapped to `case-25`
 * (a comparator-driven field's own genuine LOW_MODEL_CONFIDENCE path,
 * `field-resolution.ts`'s `resolveComparatorField`) to keep this sample
 * covering every reviewReason family it always intended to.
 *
 * Not a statistically representative sample — eight cases cannot be. It is
 * a cheap, fast smoke set that exercises every reviewReason family and both
 * REVIEW-escalation and no-escalation paths. `--full` is the real evidence
 * run; this default exists so an accidental bare `--live` cannot burn the
 * cost of the whole golden set.
 */
export const DEFAULT_SAMPLE_CASE_IDS: readonly string[] = [
  "case-01-clean-match-spirits",
  "case-02-clean-match-beer-no-abv",
  "case-05-abv-mismatch-application-higher",
  "case-08-title-case-warning-prefix-only",
  "case-12-missing-warning-spirits",
  "case-14-case-variant-brand-stones-throw",
  "case-17-glare-front-label",
  "case-25-odd-typography-script-brand",
];

/**
 * Hard ceiling on how many cases one `--live` invocation may run — the
 * golden set's own size (31 cases today). `--full` already reaches this
 * ceiling by design; this constant exists so a future larger golden set
 * cannot silently make one careless invocation far more expensive than any
 * operator intended, the same backstop role `scripts/latency/args.ts`'s
 * `MAX_RUNS` plays there. No CLI override — raise it here, deliberately, if
 * the golden set genuinely grows past it.
 */
export const MAX_CASES = 40;

export interface EvalCliArgs {
  /** `false` unless `--live` is passed. The single switch between
   * zero-cost report/baseline comparison and a real, paid API sweep. */
  live: boolean;
  /** `true` only with `--live --full` — run every case in the manifest
   * instead of `DEFAULT_SAMPLE_CASE_IDS`. Ignored (and rejected) without
   * `--live`. */
  full: boolean;
  /** Set by `--case=<id>` — run exactly this one case. Mutually exclusive
   * with `--full`. `null` when not passed. */
  caseId: string | null;
  /** `--update-baseline`: after a `--live` run completes cleanly, promote
   * its numbers into the committed baseline. Requires `--live`. Never
   * implied by a plain `--live` run — see `check.ts`'s module comment for
   * why a baseline update is always an explicit, separate decision. */
  updateBaseline: boolean;
}

const DEFAULT_ARGS: EvalCliArgs = {
  live: false,
  full: false,
  caseId: null,
  updateBaseline: false,
};

/**
 * Parses `process.argv.slice(2)`-shaped CLI args for `check.ts` and
 * `benchmark.ts`. Throws `Error` on an unrecognized argument, or when
 * `--full` and `--case=<id>` are combined (always meaningless, regardless
 * of caller). Deliberately does NOT require `--live` to accompany
 * `--full`/`--case`/`--update-baseline` here — `benchmark.ts` always runs
 * live (it has no cheap mode; a benchmark's only useful output is a real
 * number) and has no use for `--live` on its own command line, so that
 * requirement is `check.ts`-specific business logic, not a universal CLI
 * rule. `check.ts` enforces it itself via `validateCheckArgs` below,
 * immediately after calling this function.
 */
export function parseEvalArgs(argv: readonly string[]): EvalCliArgs {
  let live = DEFAULT_ARGS.live;
  let full = DEFAULT_ARGS.full;
  let caseId: string | null = DEFAULT_ARGS.caseId;
  let updateBaseline = DEFAULT_ARGS.updateBaseline;

  for (const arg of argv) {
    // `pnpm run eval:check -- --live` forwards the literal `--` token into
    // argv under pnpm (npm strips it) — same quirk `scripts/latency/args.ts`
    // already works around. Skip it rather than reject it.
    if (arg === "--") continue;
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--full") {
      full = true;
      continue;
    }
    if (arg === "--update-baseline") {
      updateBaseline = true;
      continue;
    }
    const caseMatch = /^--case=(.+)$/.exec(arg);
    if (caseMatch) {
      caseId = caseMatch[1];
      continue;
    }
    throw new Error(
      `eval args: unrecognized argument "${arg}" (expected --live, --full, --case=<caseId>, or --update-baseline)`,
    );
  }

  if (full && caseId !== null) {
    throw new Error("eval args: --full and --case=<id> are mutually exclusive — pick one sample shape.");
  }

  return { live, full, caseId, updateBaseline };
}

/**
 * `check.ts`-specific validation `parseEvalArgs` itself does not enforce
 * (see that function's own doc comment for why): a bare `pnpm eval:check`
 * is cheap mode, so `--full`/`--case=<id>`/`--update-baseline` — which only
 * mean anything on a real run — must come with an explicit `--live`, never
 * silently ignored. Throws with the same messages the parser used to
 * produce inline, kept here now that they are `check.ts`'s own rule.
 */
export function validateCheckArgs(args: EvalCliArgs): void {
  if (args.updateBaseline && !args.live) {
    throw new Error("eval args: --update-baseline requires --live — a baseline update needs a real, fresh run to promote.");
  }
  if ((args.full || args.caseId !== null) && !args.live) {
    throw new Error("eval args: --full/--case=<id> only affect a --live run — pass --live to select a sample.");
  }
}

/**
 * Resolves the actual case-ID list one `--live` run should cover, given
 * parsed args and the full manifest's case IDs (in manifest order).
 * Throws when `--case=<id>` names a case the manifest does not have —
 * failing loudly here is cheaper than discovering the typo after already
 * calling the API for every other case in a `--full` run.
 */
export function resolveCaseIds(args: EvalCliArgs, allManifestCaseIds: readonly string[]): string[] {
  if (args.caseId !== null) {
    if (!allManifestCaseIds.includes(args.caseId)) {
      throw new Error(
        `eval args: --case="${args.caseId}" is not a golden-set case ID. Available: ${allManifestCaseIds.join(", ")}`,
      );
    }
    return [args.caseId];
  }
  const ids = args.full ? [...allManifestCaseIds] : [...DEFAULT_SAMPLE_CASE_IDS];
  if (ids.length > MAX_CASES) {
    throw new Error(
      `eval args: resolved ${ids.length} case(s), which exceeds the ${MAX_CASES}-case safety cap (each case spends ` +
        `real API money — see this file's MAX_CASES comment). Raise MAX_CASES if the golden set has genuinely grown.`,
    );
  }
  return ids;
}
