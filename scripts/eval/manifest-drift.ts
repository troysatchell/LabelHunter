/**
 * Manifest drift detection for `eval:check` cheap mode (TRO-556).
 *
 * THE GAP THIS CLOSES. `baseline-compare.ts`'s `"stale-baseline"` problem
 * class compares the committed REPORT's `manifestContentHash`
 * (`scripts/eval/results/eval-report.json`) against the committed
 * BASELINE's `manifestContentHash` (`scripts/eval/baseline.json`) — two
 * frozen files checked against each other (`manifest-hash.ts`, TRO-538).
 * That catches drift BETWEEN the two files, but not drift between EITHER
 * file and the real `golden-set/manifest.json` on disk right now. A corpus
 * rebuild (a golden-set PR that regenerates images or edits cases) can
 * silently leave both frozen files pointing at a manifest that no longer
 * exists. Before this ticket, cheap mode never read the live manifest file
 * and had no way to notice: it passed while the accuracy evidence described
 * images that no longer existed.
 *
 * `checkManifestDrift` closes that gap by taking the report's committed
 * hash and a hash computed fresh, right now, from the live manifest file
 * (`check.ts`'s `runCheap` calls `hashManifestFile(DEFAULT_MANIFEST_PATH)`
 * before calling this function) — and decides whether to warn.
 *
 * A WARNING, NEVER A FAIL. Cheap mode runs on every push, on every ticket's
 * gate, regardless of whether that ticket touched `golden-set/`. Failing
 * the gate here would block every corpus ticket the moment a manifest edit
 * lands, before anyone has had the chance to run the re-baseline protocol —
 * the same "gate cries wolf" failure `check.ts`'s own stale-baseline
 * handling exists to avoid, on a new axis. So this function only
 * classifies; it never sets an exit code. The caller (`check.ts`) decides
 * to print the result with `console.warn`, never `console.error`, and never
 * touches `process.exitCode` for it.
 *
 * Pure — no I/O. `check.ts` reads the report and hashes the live manifest
 * file; this function only compares the two strings it is given.
 */
export interface ManifestDriftCheck {
  /** `true` when the report's committed hash disagrees with the live
   * manifest's hash, computed right now. */
  readonly drifted: boolean;
  /** Always set, on both outcomes — a caller prints this on every run so a
   * reader can tell "checked, no drift" apart from "not checked at all". */
  readonly message: string;
}

const REBASELINE_HINT = "pnpm eval:variance -- --live --full --repeats=3 --establish-baseline";

/**
 * Compares `reportManifestContentHash` (from the committed
 * `eval-report.json`) against `liveManifestContentHash` (a fresh SHA-256 of
 * `golden-set/manifest.json`'s current bytes, computed by the caller via
 * `hashManifestFile`). Named "MANIFEST DRIFT" in the warning message so it
 * reads distinctly from `baseline-compare.ts`'s own "stale-baseline"
 * warning line in the same console output — the two catch different gaps.
 */
export function checkManifestDrift(reportManifestContentHash: string, liveManifestContentHash: string): ManifestDriftCheck {
  const drifted = reportManifestContentHash !== liveManifestContentHash;
  if (!drifted) {
    return {
      drifted: false,
      message: "manifest content hash matches golden-set/manifest.json's live content — no drift detected.",
    };
  }
  return {
    drifted: true,
    message:
      `MANIFEST DRIFT — the committed eval report's manifestContentHash ("${reportManifestContentHash}") does not match ` +
      `golden-set/manifest.json's LIVE content hash ("${liveManifestContentHash}"), computed just now. The corpus moved ` +
      `since this report was measured; the committed accuracy evidence may describe images that no longer exist. ` +
      `Run the re-baseline protocol: ${REBASELINE_HINT}.`,
  };
}
