/**
 * Tests for the golden-set render smoke check (LH-006 / TRO-499).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./render";
import { runRenderSmoke } from "./renderSmoke";

describe("runRenderSmoke", () => {
  it(
    "renders the first renderable case in the real manifest at the fixed canvas size",
    async () => {
      const result = await runRenderSmoke();

      expect(result.caseId).toBeTruthy();
      expect(result.width).toBe(CANVAS_WIDTH);
      expect(result.height).toBe(CANVAS_HEIGHT);
      expect(result.bytes).toBeGreaterThan(0);
    },
    30_000,
  );

  it("throws a clear error when the manifest has no renderable (non-ai-generated) case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-smoke-test-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: "1.0.0",
          cases: [
            {
              caseId: "case-ai-only",
              description: "Only an ai-generated case, no renderable one.",
              category: "clean-match",
              beverageType: "spirits",
              imagePath: "golden-set/images/case-ai-only.png",
              provenance: "ai-generated",
              verified: true,
              vectors: [],
              application: {
                brandName: "Test Brand",
                classType: "Test Class",
                abvPercent: 45,
                netContentsValue: 750,
                netContentsUnit: "mL",
              },
              label: {
                brandName: "Test Brand",
                classType: "Test Class",
                abvPresent: true,
                abvText: "45% Alc./Vol.",
                abvPercent: 45,
                netContentsText: "750 mL",
                netContentsValue: 750,
                netContentsUnit: "mL",
                governmentWarningPresent: true,
                governmentWarningText: "GOVERNMENT WARNING: test.",
                governmentWarningPrefixAllCaps: true,
              },
              expected: {
                labelVerdict: "PASS",
                fields: {
                  brandName: { verdict: "MATCH", reason: "Matches." },
                  classType: { verdict: "MATCH", reason: "Matches." },
                  abv: { verdict: "MATCH", reason: "Matches." },
                  netContents: { verdict: "MATCH", reason: "Matches." },
                  governmentWarning: { verdict: "MATCH", reason: "Matches." },
                },
              },
            },
          ],
        }),
      );

      await expect(runRenderSmoke(manifestPath)).rejects.toThrow(/no renderable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
