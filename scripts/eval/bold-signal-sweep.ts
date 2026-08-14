/**
 * Bold advisory signal accuracy sweep (LH-026 / TRO-533, CP-2 §7.2/§7.3,
 * TH-R9, TH-R17).
 *
 * TRO-532 (LH-025) built `measureBoldSignal` — a pixel measurement, not a
 * model call — and TRO-533 wires it into the verify pipeline as an
 * advisory signal that never changes a verdict. That signal was a promise
 * ("bold detection attempted") until it was scored against real ground
 * truth. This script is that measurement.
 *
 * Mirrors `ocr-floor-sweep.ts`'s own shape exactly: replays the SAME
 * pipeline stages the real verify route runs (`preprocessImage` ->
 * `detectWarningRegion` -> `cropForOcr` -> `measureBoldSignal`), read-only,
 * against every committed golden-set image. No Anthropic API call, no
 * database write. The only file this script writes is its own output
 * artifact.
 *
 * Ground truth: `golden-set/manifest.json`'s `label.governmentWarningPrefixBold`
 * (TRO-527 / LH-022) — `true`, `false`, or `"unknown"`. A case scores only
 * when the label actually carries a government warning AND ground truth is
 * a real boolean call, not `"unknown"` — the same reasoning
 * `golden-set/README.md`'s "Real-photograph cases" section gives for why
 * `"unknown"` exists at all: a false reading against a case with no
 * supportable ground truth would be a fabricated accuracy figure, not a
 * measurement. `governmentWarningPrefixBold: true` maps to the expected
 * signal `"bold"`; `false` maps to `"not-bold"`. A measured `"uncertain"`
 * scores as incorrect either way — it is a real miss for THIS accuracy
 * question ("did the signal call it right"), even though `uncertain` is
 * the intended, honest answer when the measurement itself cannot commit
 * (bold-detect.ts's own header comment). Scoring it as correct would hide
 * exactly the coverage gap this sweep exists to report.
 *
 * Run: pnpm eval:bold-signal-sweep -- [--out=<path>] [--force]
 * Writes: scripts/eval/results/bold-signal-sweep.json by default. Refuses
 *   to overwrite an existing file at that path unless --force is also
 *   passed (the same `artifact-guard.ts` convention `ocr-floor-sweep.ts`
 *   already follows, TRO-559). Pass --out=<path> instead to write a
 *   comparison copy without touching the committed one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MANIFEST_PATH, loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase, GoldenSetCategory } from "../../src/lib/golden-set/types";
import { preprocessImage } from "../../src/server/preprocessing";
import { cropForOcr, detectWarningRegion, measureBoldSignal, runWarningOcr, type BoldSignal } from "../../src/server/warning";
import { parseArtifactGuardArgs, writeGuardedJsonArtifact } from "./artifact-guard";
import { REPO_ROOT } from "./cascade-runner";
import { assertPathTreeClean, lastCommitTouchingPath } from "./git-provenance";
import { hashManifestFile } from "./manifest-hash";

/** The expected `BoldSignal` for a scoreable case's ground truth — `null`
 * when this case cannot be scored at all (no warning present, or ground
 * truth is `"unknown"`). */
function expectedSignalFor(caseSpec: GoldenSetCase): BoldSignal | null {
  if (!caseSpec.label.governmentWarningPresent) return null;
  const groundTruth = caseSpec.label.governmentWarningPrefixBold;
  if (groundTruth === "unknown") return null;
  return groundTruth ? "bold" : "not-bold";
}

export interface BoldSignalSweepCaseResult {
  caseId: string;
  category: GoldenSetCategory;
  governmentWarningPresent: boolean;
  /** `true`, `false`, or `"unknown"` — the golden-set's own ground truth,
   * carried through verbatim for a reader to cross-check. */
  groundTruthPrefixBold: boolean | "unknown";
  /** `null` when this case is not scoreable (see `expectedSignalFor`). */
  expectedSignal: BoldSignal | null;
  measuredSignal: BoldSignal | null;
  measuredReason: string | null;
  measuredRatio: number | null;
  region: { x: number; y: number; width: number; height: number } | null;
  detectionMethod: "classical" | "band-search" | null;
  /** `null` when this case is not scoreable. Otherwise `measuredSignal ===
   * expectedSignal` — a measured `"uncertain"` is always `false` here, per
   * this file's own header comment. */
  correct: boolean | null;
}

async function sweepOneCase(caseSpec: GoldenSetCase): Promise<BoldSignalSweepCaseResult> {
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, caseSpec.imagePath));
  const preprocessed = await preprocessImage(imageBytes);
  const expectedSignal = expectedSignalFor(caseSpec);

  const base = {
    caseId: caseSpec.caseId,
    category: caseSpec.category,
    governmentWarningPresent: caseSpec.label.governmentWarningPresent,
    groundTruthPrefixBold: caseSpec.label.governmentWarningPrefixBold,
    expectedSignal,
  };

  const detection = await detectWarningRegion(preprocessed.original, (crop) => runWarningOcr(crop));
  if (!detection) {
    return {
      ...base,
      measuredSignal: null,
      measuredReason: null,
      measuredRatio: null,
      region: null,
      detectionMethod: null,
      correct: expectedSignal === null ? null : false,
    };
  }

  const crop = await cropForOcr(preprocessed.original, detection.region);
  const measured = await measureBoldSignal(crop);

  return {
    ...base,
    measuredSignal: measured.signal,
    measuredReason: measured.reason,
    measuredRatio: measured.ratio,
    region: detection.region,
    detectionMethod: detection.method,
    correct: expectedSignal === null ? null : measured.signal === expectedSignal,
  };
}

function printCaseLine(result: BoldSignalSweepCaseResult): void {
  const region = result.region ? `${result.detectionMethod} ${JSON.stringify(result.region)}` : "no region found";
  const measured = result.measuredSignal ? `measured ${result.measuredSignal} (ratio ${result.measuredRatio?.toFixed(2) ?? "n/a"})` : "not measured";
  const score = result.correct === null ? "not scored" : result.correct ? "correct" : "WRONG";
  console.log(`  ${result.caseId}: ${region} | ${measured} | expected ${result.expectedSignal ?? "n/a"} | ${score}`);
}

async function main(): Promise<void> {
  const { guard, rest } = parseArtifactGuardArgs(process.argv.slice(2));
  if (rest.length > 0) {
    console.error(`bold-signal-sweep.ts: unrecognized argument(s): ${rest.join(" ")}`);
    console.error("This script only accepts --out=<path> and --force.");
    process.exit(2);
  }
  // TRO-564's own guard, the same pattern ocr-floor-sweep.ts already uses
  // (that file's own comment): fail before doing any measurement work when
  // golden-set/ has an uncommitted change — otherwise the artifact's
  // goldenSetCommitSha below would cite the last clean commit while
  // actually having measured different (uncommitted) images.
  assertPathTreeClean(REPO_ROOT, "golden-set");

  const manifest = loadGoldenSetManifest();
  console.log(`bold-signal-sweep.ts: sweeping ${manifest.cases.length} golden-set case(s), bold signal only, no API call.`);

  const results: BoldSignalSweepCaseResult[] = [];
  for (const caseSpec of manifest.cases) {
    const result = await sweepOneCase(caseSpec);
    results.push(result);
    printCaseLine(result);
  }

  const scoreable = results.filter((r) => r.correct !== null);
  const correct = scoreable.filter((r) => r.correct === true);
  const accuracy = scoreable.length === 0 ? 0 : correct.length / scoreable.length;

  const signalDistribution: Record<string, number> = { bold: 0, "not-bold": 0, uncertain: 0, "not-measured": 0 };
  for (const r of results) signalDistribution[r.measuredSignal ?? "not-measured"]++;

  const artifact = {
    ticket: "TRO-533 / LH-026",
    measuredAt: new Date().toISOString(),
    manifestVersion: manifest.version,
    // Same provenance fields ocr-floor-sweep.ts / baseline.json carry, for
    // the same reason: a committed measurement without the golden-set
    // state it was measured against has no way to be checked for
    // staleness later.
    goldenSetCommitSha: lastCommitTouchingPath(REPO_ROOT, "golden-set"),
    manifestContentHash: hashManifestFile(DEFAULT_MANIFEST_PATH),
    method:
      "Read-only replay of the bold-signal pipeline (preprocessImage -> detectWarningRegion -> " +
      "cropForOcr -> measureBoldSignal) against every committed golden-set image, in the same " +
      "order the verify route's default dependencies call them. Scored against " +
      "golden-set/manifest.json's label.governmentWarningPrefixBold ground truth (TRO-527 / " +
      "LH-022). No Anthropic API call. No database write. The only file this script writes is " +
      "this one.",
    caseCount: results.length,
    scoreableCaseCount: scoreable.length,
    correctCount: correct.length,
    accuracy,
    signalDistribution,
    results,
  };

  const defaultPath = path.resolve(REPO_ROOT, "scripts/eval/results/bold-signal-sweep.json");
  const outPath = writeGuardedJsonArtifact({ repoRoot: REPO_ROOT, defaultPath, guard, content: artifact });
  console.log("");
  console.log(
    `bold-signal-sweep.ts: ${correct.length}/${scoreable.length} scoreable case(s) correct ` +
      `(accuracy ${(accuracy * 100).toFixed(1)}%), out of ${results.length} case(s) total.`,
  );
  console.log(`bold-signal-sweep.ts: wrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
