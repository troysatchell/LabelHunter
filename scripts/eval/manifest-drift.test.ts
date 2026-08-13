import { describe, expect, it } from "vitest";
import { checkManifestDrift } from "./manifest-drift";

// Acceptance evidence for TRO-556: the committed eval report's
// manifestContentHash can drift out of sync with the LIVE
// golden-set/manifest.json after a corpus rebuild, and cheap mode
// (check.ts's runCheap) never reads the live file today — it only compares
// two already-frozen committed files to each other (baseline-compare.ts's
// "stale-baseline" class). checkManifestDrift is the piece that closes that
// gap: it takes the report's committed hash and a freshly-computed live
// hash, and decides whether to warn.
describe("checkManifestDrift", () => {
  it("stays silent (drifted: false) when the report's hash matches the live manifest hash", () => {
    const result = checkManifestDrift("same-hash", "same-hash");
    expect(result.drifted).toBe(false);
    expect(result.message).not.toMatch(/WARNING/);
    expect(result.message).not.toMatch(/MANIFEST DRIFT/);
  });

  it("fires a loud, named WARNING (drifted: true) on a synthetic hash mismatch", () => {
    const result = checkManifestDrift("frozen-report-hash", "live-manifest-hash-right-now");
    expect(result.drifted).toBe(true);
    expect(result.message).toMatch(/MANIFEST DRIFT/);
  });

  it("names both hashes in the drift message so a reader can see exactly what disagreed", () => {
    const result = checkManifestDrift("frozen-report-hash", "live-manifest-hash-right-now");
    expect(result.message).toContain("frozen-report-hash");
    expect(result.message).toContain("live-manifest-hash-right-now");
  });

  it("points a drift message at the re-baseline protocol's own invocation", () => {
    const result = checkManifestDrift("frozen-report-hash", "live-manifest-hash-right-now");
    expect(result.message).toContain("eval:variance -- --live --full --repeats=3 --establish-baseline");
  });

  it("never fails, never blocks — this function only classifies, it does not set an exit code (check.ts's own cheap-mode discipline: a stale corpus warns, it does not fail cheap mode)", () => {
    const result = checkManifestDrift("a", "b");
    expect(result).not.toHaveProperty("exitCode");
    expect(result).not.toHaveProperty("fail");
  });
});
