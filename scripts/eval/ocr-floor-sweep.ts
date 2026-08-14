/**
 * OCR_CONFIDENCE_FLOOR sweep (TRO-535 / LH-030b, CP-2 §4.5, §12 open
 * question 7, TH-R9, TH-R17, rubric vector V4).
 *
 * The floor at `src/server/warning/reconcile.ts` decides whether an OCR
 * reading is trusted as a real second channel. Its own comment has always
 * called it "proposed" and named this sweep as the ticket that replaces it
 * with a measured value (CP-2 §12: "LH-030's sweep replaces them with
 * measured values"). This script is that measurement.
 *
 * Replays the OCR channel READ-ONLY against every committed golden-set
 * image, calling the same five functions the verify route's default
 * dependencies call, in the same order: `preprocessImage`,
 * `detectWarningRegion`, `cropForOcr`, `runWarningOcr`, `evaluateCandidate`.
 * Every OCR call runs locally against the committed tesseract.js language
 * data — no network call, no Anthropic API call, no database write. The
 * only file this script writes is its own output artifact.
 *
 * Run: pnpm eval:ocr-floor-sweep -- [--out=<path>] [--force]
 * Writes: scripts/eval/results/ocr-floor-sweep.json by default. Refuses to
 *   overwrite an existing file at that path unless --force is also passed
 *   (TRO-559). Pass --out=<path> instead to write a comparison copy
 *   without touching the committed one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MANIFEST_PATH, loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenSetCase, GoldenSetCategory } from "../../src/lib/golden-set/types";
import { preprocessImage } from "../../src/server/preprocessing";
import {
  capsCheckPasses,
  cropForOcr,
  detectWarningRegion,
  evaluateCandidate,
  runWarningOcr,
  type WordingClassification,
} from "../../src/server/warning";
import { parseArtifactGuardArgs, writeGuardedJsonArtifact } from "./artifact-guard";
import { REPO_ROOT } from "./cascade-runner";
import { assertPathTreeClean, lastCommitTouchingPath } from "./git-provenance";
import { hashManifestFile } from "./manifest-hash";

export interface OcrFloorSweepCaseResult {
  caseId: string;
  category: GoldenSetCategory;
  /** From the golden-set ground truth, not measured here — whether this
   * label actually carries a government warning at all. Two cases
   * (missing-warning) do not: the sweep still runs the OCR channel against
   * them (production runs it unconditionally, concurrently with the Haiku
   * call, before it knows whether a warning is present — see
   * `src/server/warning/index.ts`'s `compareGovernmentWarningFromImage`),
   * but their `distance`/`wording` say nothing about OCR quality on real
   * warning print and must be excluded from the floor decision. */
  governmentWarningPresent: boolean;
  imageWidthPx: number;
  imageHeightPx: number;
  region: { x: number; y: number; width: number; height: number } | null;
  detectionMethod: "classical" | "band-search" | null;
  /** `false` when region detection found no candidate block at all, OR
   * `runWarningOcr` itself returned `null` — the "no candidate" state
   * (TRO-519's timeout path degrades to this same shape). Distinct from a
   * non-null `ocrConfidence` that happens to sit below the floor — that is
   * the "candidate below the floor" state this ticket's whole point is to
   * treat differently (see CP-2 §4.5 amendment in this ticket's CHANGES.md
   * entry). */
  ocrAvailable: boolean;
  ocrConfidence: number | null;
  wording: WordingClassification | null;
  distance: number | null;
  /** Whether the OCR reading's caps positions (GOVERNMENT / WARNING /
   * Surgeon / General) all conform — recorded for completeness; not part
   * of the floor decision, which is about wording-read quality. */
  capsOk: boolean | null;
}

async function sweepOneCase(caseSpec: GoldenSetCase): Promise<OcrFloorSweepCaseResult> {
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, caseSpec.imagePath));
  const preprocessed = await preprocessImage(imageBytes);

  const base = {
    caseId: caseSpec.caseId,
    category: caseSpec.category,
    governmentWarningPresent: caseSpec.label.governmentWarningPresent,
    imageWidthPx: preprocessed.width,
    imageHeightPx: preprocessed.height,
  };

  const detection = await detectWarningRegion(preprocessed.original, (crop) => runWarningOcr(crop));
  if (!detection) {
    return {
      ...base,
      region: null,
      detectionMethod: null,
      ocrAvailable: false,
      ocrConfidence: null,
      wording: null,
      distance: null,
      capsOk: null,
    };
  }

  const crop = await cropForOcr(preprocessed.original, detection.region);
  const ocrResult = await runWarningOcr(crop);
  if (!ocrResult) {
    return {
      ...base,
      region: detection.region,
      detectionMethod: detection.method,
      ocrAvailable: false,
      ocrConfidence: null,
      wording: null,
      distance: null,
      capsOk: null,
    };
  }

  const evaluation = evaluateCandidate(ocrResult.text);
  return {
    ...base,
    region: detection.region,
    detectionMethod: detection.method,
    ocrAvailable: true,
    ocrConfidence: ocrResult.confidence,
    wording: evaluation.wording,
    distance: evaluation.distance,
    capsOk: capsCheckPasses(evaluation.caps),
  };
}

function printCaseLine(result: OcrFloorSweepCaseResult): void {
  const region = result.region ? `${result.detectionMethod} ${JSON.stringify(result.region)}` : "no region found";
  const ocr = result.ocrAvailable
    ? `confidence ${result.ocrConfidence?.toFixed(2)}, wording ${result.wording}, distance ${result.distance}`
    : "no OCR candidate";
  console.log(`  ${result.caseId}: ${region} | ${ocr}`);
}

async function main(): Promise<void> {
  const { guard, rest } = parseArtifactGuardArgs(process.argv.slice(2));
  if (rest.length > 0) {
    console.error(`ocr-floor-sweep.ts: unrecognized argument(s): ${rest.join(" ")}`);
    console.error("This script only accepts --out=<path> and --force.");
    process.exit(2);
  }
  // TRO-564: fail before doing any OCR work, not after, when golden-set/ has
  // an uncommitted change — otherwise the artifact's goldenSetCommitSha
  // below would cite the last clean commit while actually having measured
  // different (uncommitted) images.
  assertPathTreeClean(REPO_ROOT, "golden-set");

  const manifest = loadGoldenSetManifest();
  console.log(`ocr-floor-sweep.ts: sweeping ${manifest.cases.length} golden-set case(s), OCR channel only, no API call.`);

  const results: OcrFloorSweepCaseResult[] = [];
  for (const caseSpec of manifest.cases) {
    const result = await sweepOneCase(caseSpec);
    results.push(result);
    printCaseLine(result);
  }

  const warningBearing = results.filter((r) => r.governmentWarningPresent && r.ocrAvailable);
  const confidences = warningBearing.map((r) => r.ocrConfidence!).sort((a, b) => a - b);

  const artifact = {
    ticket: "TRO-535 / LH-030b (re-measured TRO-558)",
    measuredAt: new Date().toISOString(),
    manifestVersion: manifest.version,
    // Provenance fields (TRO-558), the same two `scripts/eval/baseline.json`
    // (TRO-561) already carries for the same reason: a committed
    // measurement without the golden-set state it was measured against has
    // no way to be checked for staleness later.
    goldenSetCommitSha: lastCommitTouchingPath(REPO_ROOT, "golden-set"),
    manifestContentHash: hashManifestFile(DEFAULT_MANIFEST_PATH),
    method:
      "Read-only replay of the OCR channel (preprocessImage -> detectWarningRegion -> " +
      "cropForOcr -> runWarningOcr -> evaluateCandidate) against every committed golden-set " +
      "image, in the same order the verify route's default dependencies call them. No " +
      "Anthropic API call. No database write. The only file this script writes is this one.",
    caseCount: results.length,
    warningBearingCaseCount: warningBearing.length,
    warningBearingConfidencesSorted: confidences,
    results,
  };

  const defaultPath = path.resolve(REPO_ROOT, "scripts/eval/results/ocr-floor-sweep.json");
  const outPath = writeGuardedJsonArtifact({ repoRoot: REPO_ROOT, defaultPath, guard, content: artifact });
  console.log("");
  console.log(`ocr-floor-sweep.ts: ${warningBearing.length}/${results.length} case(s) are warning-bearing with a usable OCR candidate.`);
  console.log(`ocr-floor-sweep.ts: sorted confidences over those cases: ${confidences.join(", ")}`);
  console.log(`ocr-floor-sweep.ts: wrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
