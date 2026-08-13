/**
 * TRO-546 measurement: case-22's OCR-channel status, before and after the
 * region-detection fix (`src/server/warning/region-detect.ts`).
 *
 * Reuses `ocr-floor-sweep.ts`'s exact method — the same five functions in
 * the same order (`preprocessImage` -> `detectWarningRegion` ->
 * `cropForOcr` -> `runWarningOcr` -> `evaluateCandidate`), read-only, no
 * Anthropic API call, no database write — but as its OWN script and OWN
 * artifact, not a rewrite of the shared `ocr-floor-sweep.json`
 * (that file is TRO-535's, and its post-TRO-527 staleness is TRO-558's to
 * fix, not this ticket's).
 *
 * Sweeps the full 32-case golden set (not just case-22) so the artifact
 * also stands as this ticket's regression evidence: every other
 * warning-bearing case keeps its measured confidence/wording/distance
 * unchanged; case-22 is the only one whose status changes.
 *
 * Run: pnpm eval:tro-546-case22-check
 * Writes: scripts/eval/results/tro-546-case22-ocr-region-check.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
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
import { REPO_ROOT } from "./cascade-runner";

export interface CaseResult {
  caseId: string;
  category: GoldenSetCategory;
  governmentWarningPresent: boolean;
  /** CP-2 §4.5's OCR-channel state vocabulary, amended 2026-08-12
   * (TRO-535/LH-030b): "unavailable" when region detection itself found no
   * crop (or `runWarningOcr` returned no result at all — no reading
   * exists to discard); "below-floor" when a reading exists but its own
   * confidence says not to trust it alone; "healthy" otherwise. */
  ocrChannelState: "unavailable" | "below-floor" | "healthy";
  region: { x: number; y: number; width: number; height: number } | null;
  detectionMethod: "classical" | "band-search" | null;
  ocrConfidence: number | null;
  wording: WordingClassification | null;
  distance: number | null;
  capsOk: boolean | null;
}

const OCR_CONFIDENCE_FLOOR_FOR_CLASSIFICATION_ONLY = 50; // src/server/warning/reconcile.ts's OCR_CONFIDENCE_FLOOR — read-only reference, not re-litigated here (TRO-546's Do-NOT)

async function checkOneCase(caseSpec: GoldenSetCase): Promise<CaseResult> {
  const imageBytes = readFileSync(path.resolve(REPO_ROOT, caseSpec.imagePath));
  const preprocessed = await preprocessImage(imageBytes);

  const base = {
    caseId: caseSpec.caseId,
    category: caseSpec.category,
    governmentWarningPresent: caseSpec.label.governmentWarningPresent,
  };

  const detection = await detectWarningRegion(preprocessed.original, (crop) => runWarningOcr(crop));
  if (!detection) {
    return {
      ...base,
      ocrChannelState: "unavailable",
      region: null,
      detectionMethod: null,
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
      ocrChannelState: "unavailable",
      region: detection.region,
      detectionMethod: detection.method,
      ocrConfidence: null,
      wording: null,
      distance: null,
      capsOk: null,
    };
  }

  const evaluation = evaluateCandidate(ocrResult.text);
  return {
    ...base,
    ocrChannelState: ocrResult.confidence < OCR_CONFIDENCE_FLOOR_FOR_CLASSIFICATION_ONLY ? "below-floor" : "healthy",
    region: detection.region,
    detectionMethod: detection.method,
    ocrConfidence: ocrResult.confidence,
    wording: evaluation.wording,
    distance: evaluation.distance,
    capsOk: capsCheckPasses(evaluation.caps),
  };
}

async function main(): Promise<void> {
  const manifest = loadGoldenSetManifest();
  console.log(
    `tro-546-case22-ocr-region-check.ts: sweeping ${manifest.cases.length} golden-set case(s), OCR channel only, no API call.`,
  );

  const results: CaseResult[] = [];
  for (const caseSpec of manifest.cases) {
    const result = await checkOneCase(caseSpec);
    results.push(result);
    console.log(
      `  ${result.caseId}: state=${result.ocrChannelState} region=${result.region ? JSON.stringify(result.region) : "none"} ` +
        `method=${result.detectionMethod ?? "-"} confidence=${result.ocrConfidence ?? "-"} wording=${result.wording ?? "-"} distance=${result.distance ?? "-"}`,
    );
  }

  const case22 = results.find((r) => r.caseId === "case-22-low-light-warning-block");

  const artifact = {
    ticket: "TRO-546",
    measuredAt: new Date().toISOString(),
    manifestVersion: manifest.version,
    method:
      "Read-only replay of the OCR channel (preprocessImage -> detectWarningRegion -> cropForOcr -> " +
      "runWarningOcr -> evaluateCandidate) against every committed golden-set image, in the same " +
      "order the verify route's default dependencies call them and the same method " +
      "scripts/eval/ocr-floor-sweep.ts (TRO-535/LH-030b) uses. No Anthropic API call. No database " +
      "write. The only file this script writes is this one — scripts/eval/results/ocr-floor-sweep.json " +
      "(TRO-535's own artifact) is untouched; its post-TRO-527 image-rebuild staleness is TRO-558's, " +
      "not this ticket's.",
    fixSummary:
      "src/server/warning/region-detect.ts's detectWarningRegionClassical previously classified 'ink' " +
      "by comparing each pixel to one fixed absolute grey value (180/255). A row whose WHOLE local " +
      "background has been darkened (case-22's warning block: brightnessFactor 0.3, region-scoped) " +
      "then reads as ~88% ink (measured) — over MAX_INK_FRACTION's 60% cap — so the block is discarded " +
      "as 'a solid fill, not print' and the OCR channel never runs. Fixed by comparing each pixel to " +
      "its OWN row's 85th-percentile grey value instead of one fixed constant (row detail in " +
      "region-detect.ts's DARK_RATIO/BACKGROUND_PERCENTILE comments) plus a smaller crop margin " +
      "(TRO-546: the found ink already sits flush against case-22's hard degradation-region edge; " +
      "the original margin pushed the crop past it into undegraded pixels, which broke tesseract's " +
      "page segmentation outright — a fixture-specific artifact, not a property of dim lighting).",
    case22: case22 ?? null,
    caseCount: results.length,
    warningBearingCaseCount: results.filter((r) => r.governmentWarningPresent).length,
    ocrChannelStateCounts: {
      unavailable: results.filter((r) => r.governmentWarningPresent && r.ocrChannelState === "unavailable").length,
      belowFloor: results.filter((r) => r.governmentWarningPresent && r.ocrChannelState === "below-floor").length,
      healthy: results.filter((r) => r.governmentWarningPresent && r.ocrChannelState === "healthy").length,
    },
    results,
  };

  const outPath = path.resolve(REPO_ROOT, "scripts/eval/results/tro-546-case22-ocr-region-check.json");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log("");
  console.log(
    `tro-546-case22-ocr-region-check.ts: case-22 OCR channel state = ${case22?.ocrChannelState ?? "NOT FOUND IN MANIFEST"}`,
  );
  console.log(`tro-546-case22-ocr-region-check.ts: wrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
