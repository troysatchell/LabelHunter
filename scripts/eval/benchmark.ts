/**
 * The cascade-vs-Sonnet-only benchmark (LH-030 / TRO-470, PRD §4, TH-R19).
 *
 * `pnpm eval:benchmark` (optionally `-- --full` or `-- --case=<id>`) —
 * always live, always real money. There is no cheap mode here: unlike
 * `check.ts`'s regression gate, which runs on every push and therefore
 * must be free by default, a benchmark's only useful output is a real
 * number, so every invocation of this script costs API money by design.
 * Not wired into `gate.sh` or CI — PRD §4 already settles the
 * architecture ("Keep the cascade regardless per Troy; the benchmark is
 * the evidence"), so this script's job is to produce evidence for an
 * already-decided question once, not to re-decide it on every push.
 *
 * TWO ARMS, run over the SAME real Haiku extraction per case — reused
 * from the cascade arm's own run (`cascade-runner.ts`'s `CaseRunOutcome.rawExtraction`),
 * never a second Haiku call for the same image, so the only variable
 * between the two arms is what PRD §4 actually asks about:
 *
 *   - cascade: the real production path (`cascade-runner.ts`, identical to
 *     `check.ts`'s own cascade run) — `routeLabel` decides every field;
 *     Sonnet resolves only the fields the router actually escalated.
 *   - sonnet-only: every field routed to the real Sonnet resolver,
 *     regardless of what the router decided. See `resolver-rollup.ts`'s
 *     module comment for the full definition of what "Sonnet-only" means
 *     given this codebase's only real Sonnet code path, and why it is
 *     defined that way rather than as a from-scratch Sonnet extractor.
 *
 * Reports the accuracy delta and the cost delta, both derived from real
 * measured numbers — never estimated. TH-R19 is not up for renegotiation
 * by this script: `recommendation` in the committed report is a fixed
 * string ("keep the cascade regardless," PRD §4's own settled position).
 * If the numbers are surprising, this script still reports them exactly as
 * measured — it does not editorialize the recommendation away from that
 * settled position.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/lib/db/schema";
import { DEFAULT_MANIFEST_PATH, loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase, GoldenSetCategory } from "../../src/lib/golden-set/types";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { productionComparators } from "../../src/server/comparators";
import { resolveEscalatedLabel, SONNET_RESOLVER_MODEL, type ResolverDb } from "../../src/server/resolver";
import type { LabelRouterResult, ReviewReason, RouterFieldKey } from "../../src/server/router/types";
import { cleanupScratchDirAndPool } from "../latency/cleanup";
import { parseEvalArgs, resolveCaseIds } from "./args";
import { buildApplicationRecord, REPO_ROOT, runOneCase, type CaseRunOutcome } from "./cascade-runner";
import { buildAllFieldsFlagged } from "./flagged-fields";
import { hashManifestFile } from "./manifest-hash";
import { rollUpResolverResolution } from "./resolver-rollup";
import { summarizeVerdict, type VerdictSummary } from "./summary";
import { buildMeasuredCost, createUsageCapturingClient, selectSonnetPricing } from "./usage";
import { scoreVerdict, type ActualVerdict } from "./verdict-scoring";
import type { AccuracySummary, EvalCaseFailure, MeasuredCost, VerdictCaseScore } from "./types";

const REPORT_PATH = path.resolve(REPO_ROOT, "scripts/eval/results/benchmark-report.json");

/** Same choice, same reasoning, as `cascade-runner.ts`'s own
 * `DI_CLIENT_OPTIONS` — matches the real resolver's own default client's
 * retry policy (`src/server/resolver/index.ts`'s `DEFAULT_CLIENT_MAX_RETRIES`). */
const DI_CLIENT_OPTIONS = { maxRetries: 0 } as const;

const ALL_ROUTER_FIELDS: readonly RouterFieldKey[] = buildAllFieldsFlagged().map((f) => f.field);
const SONNET_ONLY_PLACEHOLDER_REASON: ReviewReason = "LOW_MODEL_CONFIDENCE";

/**
 * A `db` for the Sonnet-only arm's resolver calls that never touches
 * Postgres. `resolveEscalatedLabel` always writes one `review_queue` row
 * per call (CP-1 §6's design) — real for the cascade arm, which reuses a
 * real `verifications` row `handleVerifyRequest` already created, but the
 * Sonnet-only arm creates no such row (there is no router pass, so there
 * is nothing for `handleVerifyRequest` to have run). This benchmark has no
 * use for that persisted row — it reads `resolution.outcome`/`.fields`
 * directly off the return value — so faking the two calls
 * `resolveEscalatedLabel` actually makes (`findExistingReviewQueueEntry`'s
 * `db.query.reviewQueue.findFirst`, `insertReviewQueueEntry`'s
 * `db.insert(reviewQueue).values(...).returning(...)`) avoids inventing
 * placeholder `applications`/`labelImages`/`verifications` rows just to
 * satisfy a foreign key this benchmark does not need.
 */
function buildFakeResolverDb(): ResolverDb {
  return {
    query: { reviewQueue: { findFirst: async () => undefined } },
    insert: () => ({ values: () => ({ returning: async () => [{ id: -1 }] }) }),
  } as unknown as ResolverDb;
}

/**
 * A synthetic `LabelRouterResult` for the Sonnet-only arm's resolver call —
 * there is no real router pass in this arm, so there is no real "WHAT THE
 * CODE DECIDED" table to show Sonnet. `reason` on every field says exactly
 * that, in plain language, rather than presenting fabricated router output
 * as if a real decision produced it.
 */
function buildSonnetOnlyRouterInput(): LabelRouterResult {
  return {
    labelVerdict: "REVIEW",
    headlineReason: SONNET_ONLY_PLACEHOLDER_REASON,
    fields: ALL_ROUTER_FIELDS.map((field) => ({
      field,
      verdict: "NEEDS_REVIEW",
      labelValue: null,
      applicationValue: "(not evaluated — Sonnet-only benchmark)",
      evidence: "",
      confidence: 0,
      reason: "Sonnet-only benchmark: every field routed to Sonnet, not escalation-selected.",
      resolvedBy: null,
      reviewReason: SONNET_ONLY_PLACEHOLDER_REASON,
    })),
  };
}

interface ArmResult {
  verdict: VerdictCaseScore;
  cost: MeasuredCost;
}

/**
 * The cascade arm's own per-case result (TRO-538 / LH-033) — TWO verdict
 * scores, under different names, never one replacing the other:
 * `routerVerdict` (the Validation Router's own output, scored BEFORE any
 * resolver call) and `cascadeVerdict` (the cascade's END STATE — identical
 * to `routerVerdict` when nothing escalated, the router+resolver merge when
 * it did — `cascade-runner.ts`'s `mergeResolutionIntoActualVerdict`).
 * `cascadeVerdict` is the number this benchmark compares against the
 * Sonnet-only arm's `ArmResult.verdict`, which is inherently post-resolution
 * already (that arm has no router pass at all).
 */
interface CascadeArmCaseResult {
  routerVerdict: VerdictCaseScore;
  cascadeVerdict: VerdictCaseScore;
  cost: MeasuredCost;
}

interface BenchmarkCaseResult {
  caseId: string;
  category: GoldenSetCategory;
  cascadeEscalated: boolean;
  cascade: CascadeArmCaseResult;
  sonnetOnly: ArmResult;
}

interface ArmSummary extends VerdictSummary {
  totalCostUsd: number;
  /** Names this arm's pipeline stage in plain English (TRO-538 / LH-033) —
   * a reader should not have to infer from the field name alone whether a
   * number is pre- or post-resolution. */
  stage: string;
}

interface BenchmarkReport {
  ticket: string;
  measuredAt: string;
  manifestVersion: string;
  /** SHA-256 of `golden-set/manifest.json`'s raw content (TRO-538 / LH-033,
   * `manifest-hash.ts`) — see `EvalReport.manifestContentHash`'s own doc
   * comment for why this moves with content, unlike `manifestVersion`. */
  manifestContentHash: string;
  caseIds: string[];
  haikuModel: string;
  sonnetModel: string;
  /** The cascade arm, compared post-resolution (`cascade.stage` says so
   * explicitly) — `cascade.labelVerdictAccuracy` here is built from every
   * case's `cascadeVerdict`, never `routerVerdict`. See
   * `cascadeRouterStageVerdictAccuracy` below for the number this is NOT. */
  cascade: ArmSummary;
  sonnetOnly: ArmSummary;
  /** INFORMATIONAL ONLY, not one of the two arms this report's `notes`
   * describe comparing (TRO-538 / LH-033) — the cascade arm's INTERIM
   * router-only verdict accuracy, scored before any resolver call. Kept for
   * continuity with every earlier committed benchmark report, which had no
   * other number to report. Do not compare this against `sonnetOnly` — that
   * comparison is the exact router-vs-cascade stage mismatch TRO-538 fixed;
   * see `docs/diagnostics/2026-08-12-verdict-miss-triage.md` §5 S5 and §8. */
  cascadeRouterStageVerdictAccuracy: AccuracySummary;
  /** `sonnetOnly.labelVerdictAccuracy.rate - cascade.labelVerdictAccuracy.rate`,
   * in percentage points — both sides post-resolution as of TRO-538 / LH-033
   * (previously `cascade` here was the router-only number; see `cascade.stage`). */
  labelVerdictAccuracyDeltaPercentagePoints: number;
  costDeltaUsd: number;
  /** `sonnetOnly.totalCostUsd / cascade.totalCostUsd`, or `null` when the cascade arm spent nothing (avoids dividing by zero). */
  costDeltaMultiplier: number | null;
  /** PRD §4's already-settled position — reported, not re-derived from the numbers above. */
  recommendation: string;
  notes: string[];
  cases: BenchmarkCaseResult[];
  failures: EvalCaseFailure[];
}

async function runSonnetOnlyArm(caseSpec: GoldenSetCase, cascadeOutcome: CaseRunOutcome, verificationId: number): Promise<ArmResult> {
  const { rawExtraction, rawPreprocessed } = cascadeOutcome;
  if (!rawExtraction || !rawPreprocessed) {
    throw new Error(`benchmark.ts: case "${caseSpec.caseId}" has no captured extraction/preprocessing from the cascade arm to reuse.`);
  }
  const application = buildApplicationRecord(caseSpec);
  // A dedicated client for this one call — usage.ts's own requirement
  // (one client, one call, ever), not a client shared across the whole
  // case loop. maxRetries: 0 matches the real resolver's own default
  // client (src/server/resolver/index.ts) so this measurement reflects
  // one real call, at the same retry policy production actually uses.
  const usageCapture = createUsageCapturingClient(new Anthropic(DI_CLIENT_OPTIONS));
  const resolution = await resolveEscalatedLabel(
    {
      verificationId,
      image: { data: rawPreprocessed.sonnetVariant.toString("base64"), mediaType: rawPreprocessed.mediaType },
      extraction: rawExtraction,
      application,
      router: buildSonnetOnlyRouterInput(),
      flaggedFields: buildAllFieldsFlagged(),
    },
    { client: usageCapture.client, db: buildFakeResolverDb() },
  );
  const usage = usageCapture.takeLastUsage();
  if (!usage) {
    throw new Error(`benchmark.ts: case "${caseSpec.caseId}" — Sonnet-only resolver call completed but no usage was captured — harness bug.`);
  }
  const actualVerdict: ActualVerdict = rollUpResolverResolution(resolution, application, productionComparators);
  return {
    verdict: scoreVerdict(caseSpec, actualVerdict, rawExtraction),
    cost: buildMeasuredCost(SONNET_RESOLVER_MODEL, usage, selectSonnetPricing(new Date())),
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("benchmark.ts: ANTHROPIC_API_KEY is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("benchmark.ts: DATABASE_URL is not set. source .factory-env in a factory worktree, or set it in .env.local.");
  }

  const args = parseEvalArgs(process.argv.slice(2));
  if (args.updateBaseline) {
    // parseEvalArgs accepts --update-baseline syntactically (it is a
    // shared flag with check.ts), but this script has no baseline to
    // update — silently ignoring a typo'd flag would be more confusing
    // than rejecting it (a PR review finding).
    throw new Error("benchmark.ts: --update-baseline is not supported here — only pnpm eval:check has a baseline to update.");
  }
  const manifest = loadGoldenSetManifest();
  const allCaseIds = manifest.cases.map((c) => c.caseId);
  // resolveCaseIds does not consult args.live (see args.ts's own doc
  // comment) — --full/--case=<id> work here without needing --live too.
  const caseIds = resolveCaseIds(args, allCaseIds);
  const casesById = new Map(manifest.cases.map((c) => [c.caseId, c]));

  console.log(`benchmark.ts: running ${caseIds.length} case(s) through BOTH arms (cascade, sonnet-only) against the real API.`);

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error("benchmark.ts: unexpected error on idle Postgres client", err));
  const db = drizzle(pool, { schema });
  const scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro470-benchmark-"));

  const results: BenchmarkCaseResult[] = [];
  const failures: EvalCaseFailure[] = [];
  try {
    for (let i = 0; i < caseIds.length; i++) {
      const caseSpec = casesById.get(caseIds[i])!;
      console.log(`  [${i + 1}/${caseIds.length}] ${caseSpec.caseId}: cascade arm...`);
      const cascadeOutcome = await runOneCase(caseSpec, db, scratchDir);
      if (cascadeOutcome.failure || !cascadeOutcome.result) {
        failures.push(cascadeOutcome.failure ?? { caseId: caseSpec.caseId, error: "cascade arm produced no result" });
        console.log(`    cascade arm FAILED — ${cascadeOutcome.failure?.error}; skipping the sonnet-only arm for this case too.`);
        continue;
      }
      console.log(`    sonnet-only arm...`);
      let sonnetOnly: ArmResult;
      try {
        sonnetOnly = await runSonnetOnlyArm(caseSpec, cascadeOutcome, -(i + 1));
      } catch (cause) {
        failures.push({ caseId: caseSpec.caseId, error: `sonnet-only arm: ${cause instanceof Error ? cause.message : String(cause)}` });
        continue;
      }

      const cascadeResult = cascadeOutcome.result;
      results.push({
        caseId: caseSpec.caseId,
        category: caseSpec.category,
        cascadeEscalated: cascadeResult.resolverCost !== null,
        cascade: {
          routerVerdict: cascadeResult.routerVerdict,
          cascadeVerdict: cascadeResult.cascadeVerdict,
          cost: {
            model: "cascade-total",
            inputTokens: cascadeResult.haikuCost.inputTokens + (cascadeResult.resolverCost?.inputTokens ?? 0),
            outputTokens: cascadeResult.haikuCost.outputTokens + (cascadeResult.resolverCost?.outputTokens ?? 0),
            cacheCreationInputTokens: cascadeResult.haikuCost.cacheCreationInputTokens + (cascadeResult.resolverCost?.cacheCreationInputTokens ?? 0),
            cacheReadInputTokens: cascadeResult.haikuCost.cacheReadInputTokens + (cascadeResult.resolverCost?.cacheReadInputTokens ?? 0),
            usd: cascadeResult.haikuCost.usd + (cascadeResult.resolverCost?.usd ?? 0),
          },
        },
        sonnetOnly,
      });
      console.log(
        `    cascade end state: ${cascadeResult.cascadeVerdict.labelVerdictCorrect ? "correct" : "WRONG"} (escalated: ${cascadeResult.resolverCost !== null}), sonnet-only: ${sonnetOnly.verdict.labelVerdictCorrect ? "correct" : "WRONG"}`,
      );
    }
  } finally {
    const { scratchDirCleanupError, closePoolError } = await cleanupScratchDirAndPool(
      () => rm(scratchDir, { recursive: true, force: true }),
      () => pool.end(),
    );
    if (scratchDirCleanupError) console.warn(`benchmark.ts: failed to remove scratch directory ${scratchDir}: ${scratchDirCleanupError}`);
    if (closePoolError) console.warn(`benchmark.ts: failed to close the database pool: ${closePoolError}`);
  }

  if (args.caseId !== null) {
    console.log(JSON.stringify(results[0] ?? failures[0], null, 2));
    process.exitCode = failures.length > 0 ? 1 : 0;
    return;
  }

  // TRO-538 / LH-033: cascadeVerdictSummary is now built from `cascadeVerdict`
  // (post-resolution end state), NOT `routerVerdict` (the pre-resolution
  // interim number every earlier committed benchmark report actually used —
  // see docs/diagnostics/2026-08-12-verdict-miss-triage.md §5 S5 and §8).
  // cascadeRouterStageSummary is kept, separately, as an informational
  // number only — never the one compared against the Sonnet-only arm.
  const cascadeVerdictSummary = summarizeVerdict(results.map((r) => r.cascade.cascadeVerdict));
  const cascadeRouterStageSummary = summarizeVerdict(results.map((r) => r.cascade.routerVerdict));
  const sonnetOnlyVerdictSummary = summarizeVerdict(results.map((r) => r.sonnetOnly.verdict));
  const cascadeTotalCostUsd = results.reduce((sum, r) => sum + r.cascade.cost.usd, 0);
  const sonnetOnlyTotalCostUsd = results.reduce((sum, r) => sum + r.sonnetOnly.cost.usd, 0);

  const report: BenchmarkReport = {
    ticket: "TRO-470 / LH-030",
    measuredAt: new Date().toISOString(),
    manifestVersion: manifest.version,
    manifestContentHash: hashManifestFile(DEFAULT_MANIFEST_PATH),
    caseIds: [...caseIds].sort(),
    haikuModel: HAIKU_EXTRACTOR_MODEL,
    sonnetModel: SONNET_RESOLVER_MODEL,
    cascade: {
      ...cascadeVerdictSummary,
      totalCostUsd: cascadeTotalCostUsd,
      stage:
        "post-resolution (cascade end state): the router's own verdict, merged with the resolver's per-field " +
        "disposition for every case the router escalated — cascade-runner.ts's mergeResolutionIntoActualVerdict " +
        "(TRO-538 / LH-033).",
    },
    sonnetOnly: {
      ...sonnetOnlyVerdictSummary,
      totalCostUsd: sonnetOnlyTotalCostUsd,
      stage:
        "post-resolution: every field resolved by Sonnet on every case, regardless of what a router would have " +
        "decided — this arm has no router pass at all (resolver-rollup.ts's own module comment).",
    },
    cascadeRouterStageVerdictAccuracy: cascadeRouterStageSummary.labelVerdictAccuracy,
    labelVerdictAccuracyDeltaPercentagePoints:
      (sonnetOnlyVerdictSummary.labelVerdictAccuracy.rate - cascadeVerdictSummary.labelVerdictAccuracy.rate) * 100,
    costDeltaUsd: sonnetOnlyTotalCostUsd - cascadeTotalCostUsd,
    costDeltaMultiplier: cascadeTotalCostUsd > 0 ? sonnetOnlyTotalCostUsd / cascadeTotalCostUsd : null,
    recommendation:
      "Keep the cascade regardless of this benchmark's outcome (PRD §4, TH-R19) — the cascade is the architecture, " +
      "not an optimization up for renegotiation. This benchmark exists to produce the evidence for that decision, not to reopen it.",
    notes: [
      "reviewReasonAccuracy for the sonnet-only arm is informational only, not a meaningful cascade-vs-sonnet-only " +
        "comparison point: this arm has no router pass, so a NEEDS_REVIEW field's reason is a fixed placeholder " +
        "(LOW_MODEL_CONFIDENCE) rather than one of the router's eight structural reasons — see resolver-rollup.ts.",
      "Both arms score against the SAME real Haiku extraction per case (reused, not re-called) — the only variable " +
        "between arms is whether every field or only escalated fields go to Sonnet.",
      "The sonnet-only arm's government_warning field can only ever reach MATCH or NEEDS_REVIEW, never MISMATCH — " +
        "it has no second (OCR) channel to corroborate a deviation against. See resolver-rollup.ts's rollUpGovernmentWarning.",
      "TRO-538 / LH-033: cascade.labelVerdictAccuracy is now scored POST-RESOLUTION (cascadeVerdict), matching the " +
        "sonnet-only arm's own stage. Earlier committed benchmark reports scored the cascade arm's ROUTER-ONLY " +
        "verdict (routerVerdict) against this same sonnet-only number — a stage mismatch. See " +
        "cascadeRouterStageVerdictAccuracy for the router-only number, kept for continuity; do not compare it " +
        "against sonnetOnly.",
      "The cascade arm's government_warning field, when it gets swept into a resolver call for an unrelated " +
        "label-level reason (e.g. CONFLICTING_EXTRACTION on a different field), is re-scored through the SAME " +
        "single-channel-only rollup the sonnet-only arm uses — so a router-level warning MISMATCH cannot survive " +
        "a resolver round-trip as a MISMATCH; it downgrades to NEEDS_REVIEW / WARNING_MISMATCH. See " +
        "cascade-runner.ts's mergeResolutionIntoActualVerdict doc comment.",
    ],
    cases: results,
    failures,
  };

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

  console.log("");
  console.log(`benchmark.ts: ${results.length}/${caseIds.length} case(s) scored on both arms, ${failures.length} failed.`);
  console.log(
    `benchmark.ts: cascade end-state (post-resolution) label-verdict accuracy ${(cascadeVerdictSummary.labelVerdictAccuracy.rate * 100).toFixed(1)}% (${cascadeVerdictSummary.labelVerdictAccuracy.correct}/${cascadeVerdictSummary.labelVerdictAccuracy.total}), cost $${cascadeTotalCostUsd.toFixed(4)}`,
  );
  console.log(
    `benchmark.ts: cascade ROUTER-STAGE (pre-resolution, informational only) label-verdict accuracy ${(cascadeRouterStageSummary.labelVerdictAccuracy.rate * 100).toFixed(1)}% (${cascadeRouterStageSummary.labelVerdictAccuracy.correct}/${cascadeRouterStageSummary.labelVerdictAccuracy.total})`,
  );
  console.log(
    `benchmark.ts: sonnet-only (post-resolution) label-verdict accuracy ${(sonnetOnlyVerdictSummary.labelVerdictAccuracy.rate * 100).toFixed(1)}% (${sonnetOnlyVerdictSummary.labelVerdictAccuracy.correct}/${sonnetOnlyVerdictSummary.labelVerdictAccuracy.total}), cost $${sonnetOnlyTotalCostUsd.toFixed(4)}`,
  );
  console.log(
    `benchmark.ts: accuracy delta ${report.labelVerdictAccuracyDeltaPercentagePoints.toFixed(1)} percentage points (sonnet-only minus cascade end state, both post-resolution)`,
  );
  console.log(
    `benchmark.ts: cost delta $${report.costDeltaUsd.toFixed(4)} (${report.costDeltaMultiplier !== null ? `${report.costDeltaMultiplier.toFixed(1)}x` : "n/a"})`,
  );
  console.log(`benchmark.ts: wrote ${REPORT_PATH}`);

  process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
