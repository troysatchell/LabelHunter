/**
 * Golden-set end-state assertions (TRO-497 / LH-004): every `rendered` /
 * `rendered+degraded` case's `imagePath` now resolves to a real committed
 * file, scoped so a future `ai-generated` case (LH-005, none exist yet)
 * never fails this check, and every degraded case's `degradations` entry
 * matches what `degrade.ts` actually applied when `build.ts` produced the
 * committed image.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const manifest = loadGoldenSetManifest();

/** ~500KB per the ticket's "keep the repo sane" target. */
const MAX_IMAGE_BYTES = 500 * 1024;

describe("golden-set committed images", () => {
  it("has a real, non-empty file at imagePath for every rendered/rendered+degraded case", () => {
    const renderable = manifest.cases.filter((c) => c.provenance !== "ai-generated");
    expect(renderable.length).toBeGreaterThan(0);

    for (const c of renderable) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      expect(existsSync(fullPath), `${c.caseId}: expected a file at ${c.imagePath}`).toBe(true);
      expect(
        statSync(fullPath).size,
        `${c.caseId}: ${c.imagePath} exists but is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every ai-generated case's verified flag consistent with whether its image exists", () => {
    // No ai-generated case exists in the manifest yet (LH-005's job) — this
    // loop is a no-op today. It still runs both directions of the check so
    // it starts failing loudly, not silently, the moment LH-005 adds one:
    // a verified case must have a real image, and an imageless case must
    // not be verified. Per the loader (src/lib/golden-set/loader.ts), the
    // eval harness may only use a verified ai-generated case.
    const aiGenerated = manifest.cases.filter((c) => c.provenance === "ai-generated");
    for (const c of aiGenerated) {
      const hasImage = existsSync(join(REPO_ROOT, c.imagePath));
      if (c.verified) {
        expect(hasImage, `${c.caseId}: verified ai-generated case must have a real image`).toBe(true);
      }
      if (!hasImage) {
        expect(c.verified, `${c.caseId}: an ai-generated case with no image must not be verified`).toBe(false);
      }
    }
  });

  it("keeps every committed image well under the ~500KB repo-size target", () => {
    const renderable = manifest.cases.filter((c) => c.provenance !== "ai-generated");
    for (const c of renderable) {
      const fullPath = join(REPO_ROOT, c.imagePath);
      if (!existsSync(fullPath)) continue; // covered by the existence test above
      const bytes = statSync(fullPath).size;
      expect(bytes, `${c.caseId}: ${bytes} bytes exceeds the ${MAX_IMAGE_BYTES} byte target`).toBeLessThan(
        MAX_IMAGE_BYTES,
      );
    }
  });
});

describe("golden-set degradations recorded on the manifest (design doc §3)", () => {
  function degradationsOf(caseId: string) {
    return manifest.cases.find((c) => c.caseId === caseId)?.degradations ?? [];
  }

  it("records case-17's glare on the brand region", () => {
    expect(degradationsOf("case-17-glare-front-label")).toEqual([
      { type: "glare", params: { region: "brand", angleDegrees: 25, opacity: 0.85 } },
    ]);
  });

  it("records case-18's glare on the warning region", () => {
    expect(degradationsOf("case-18-glare-warning-block")).toEqual([
      { type: "glare", params: { region: "warning", angleDegrees: -20, opacity: 0.85 } },
    ]);
  });

  it("records case-19's mild, correctable rotation", () => {
    expect(degradationsOf("case-19-rotation-mild-correctable")).toEqual([
      { type: "rotate", params: { angleDegrees: 15 } },
    ]);
  });

  it("records case-20's severe rotation plus blur (rubric V9, blur-to-unreadable)", () => {
    expect(degradationsOf("case-20-rotation-severe-upside-down")).toEqual([
      { type: "rotate", params: { angleDegrees: 180 } },
      { type: "blur", params: { sigma: 18 } },
    ]);
  });

  it("records case-21's low light on the front-label region", () => {
    expect(degradationsOf("case-21-low-light-front-label")).toEqual([
      { type: "low-light", params: { region: "front", brightnessFactor: 0.32 } },
    ]);
  });

  it("records case-22's low light on the warning region", () => {
    expect(degradationsOf("case-22-low-light-warning-block")).toEqual([
      { type: "low-light", params: { region: "warning", brightnessFactor: 0.3 } },
    ]);
  });

  it("carries no degradations for tiny-warning-text or odd-typography cases (render-time print choices, not degrade.ts transforms)", () => {
    const renderTimeOnly = [
      "case-23-tiny-warning-text-standard-bottle",
      "case-24-tiny-warning-text-miniature-bottle",
      "case-25-odd-typography-script-brand",
      "case-26-odd-typography-blackletter-class-type",
    ];
    for (const caseId of renderTimeOnly) {
      expect(degradationsOf(caseId), caseId).toEqual([]);
    }
  });

  it("carries no degradations for any clean 'rendered'-provenance case", () => {
    const cleanCases = manifest.cases.filter((c) => c.provenance === "rendered");
    expect(cleanCases.length).toBeGreaterThan(0);
    for (const c of cleanCases) {
      expect(c.degradations ?? [], c.caseId).toEqual([]);
    }
  });
});
