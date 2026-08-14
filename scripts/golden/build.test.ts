/**
 * Tests for build.ts's rendered+ai-backdrop branch (Task 6,
 * docs/superpowers/specs/2026-08-11-realistic-corpus-gemini-design.md).
 * The render-and-degrade path (rendered/rendered+degraded) is exercised
 * end-to-end by `pnpm golden:build` itself and by render.test.ts /
 * degrade.test.ts; this file covers only what's new here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";
import { buildAiBackdropCase } from "./build";
import { createLabelRenderer, type LabelRenderer } from "./render";

function aiBackdropCase(overrides: Partial<GoldenSetCase> = {}): GoldenSetCase {
  return {
    caseId: "case-ai-backdrop-test",
    description: "Test fixture for the rendered+ai-backdrop build path.",
    category: "clean-match",
    beverageType: "spirits",
    imagePath: "golden-set/images/case-ai-backdrop-test.jpg",
    provenance: "rendered+ai-backdrop",
    verified: true,
    vectors: [],
    referenceBottle: "amber-whiskey-01",
    scene: "bar-counter",
    cameraCondition: "steady",
    application: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
    label: {
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      abvPresent: true,
      abvText: "45% Alc./Vol. (90 Proof)",
      abvPercent: 45,
      proof: 90,
      netContentsText: "750 mL",
      netContentsValue: 750,
      netContentsUnit: "mL",
      governmentWarningPresent: true,
      governmentWarningText: "GOVERNMENT WARNING: test text.",
      governmentWarningPrefixAllCaps: true,
      governmentWarningPrefixBold: true,
      governmentWarningBodyBold: false,
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
    ...overrides,
  };
}

describe("buildAiBackdropCase", () => {
  it("throws a clear error when labelPlacement is missing", async () => {
    const caseSpec = aiBackdropCase({ labelPlacement: undefined });
    // The error must fire before any render call, so a dummy renderer
    // (never dereferenced) is safe to pass here.
    const dummyRenderer = { page: undefined, close: async () => {} } as unknown as LabelRenderer;
    await expect(buildAiBackdropCase(caseSpec, dummyRenderer, "/nonexistent")).rejects.toThrow(
      /labelPlacement/,
    );
  });

  it("names the case and the expected path when the backdrop file is missing (TRO-510)", async () => {
    // A mismatched caseId (the manifest entry does not exactly reuse the
    // sidecar's generated case ID) is the documented way to hit this: the
    // backdrop lookup builds its path from caseSpec.caseId, so the wrong
    // caseId means "file not found," not "case not found." Before the fix,
    // this rejects with a bare Node fs ENOENT message that never names the
    // case at all.
    const emptyBackdropsDir = mkdtempSync(path.join(tmpdir(), "build-test-missing-backdrop-"));
    const caseSpec = aiBackdropCase({
      caseId: "case-ai-backdrop-wrong-id",
      labelPlacement: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 1000, y: 0 },
        bottomLeft: { x: 0, y: 800 },
        bottomRight: { x: 1000, y: 800 },
      },
    });
    const renderer = await createLabelRenderer();
    const expectedBackdropPath = path.resolve(emptyBackdropsDir, "case-ai-backdrop-wrong-id.png");
    try {
      let thrown: unknown;
      try {
        await buildAiBackdropCase(caseSpec, renderer, emptyBackdropsDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toMatch(/case "case-ai-backdrop-wrong-id" expects a backdrop photo/);
      // Names the exact path it looked for, not just the case -- proves the
      // message is actionable, not just recognizable.
      expect(message).toContain(expectedBackdropPath);
    } finally {
      await renderer.close();
      rmSync(emptyBackdropsDir, { recursive: true, force: true });
    }
  });

  it("rethrows a non-ENOENT filesystem error unchanged instead of mislabeling it as a missing file (TRO-510)", async () => {
    // A directory at the expected backdrop path (not a missing path)
    // makes readFileSync throw EISDIR, not ENOENT. The "no file exists"
    // message would be actively wrong here -- a file-shaped thing IS
    // there, just not a readable one -- so this must NOT get the
    // caseId-mismatch message; the real error must pass through.
    const backdropsDir = mkdtempSync(path.join(tmpdir(), "build-test-eisdir-"));
    mkdirSync(path.join(backdropsDir, "case-ai-backdrop-wrong-id.png"));
    const caseSpec = aiBackdropCase({
      caseId: "case-ai-backdrop-wrong-id",
      labelPlacement: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 1000, y: 0 },
        bottomLeft: { x: 0, y: 800 },
        bottomRight: { x: 1000, y: 800 },
      },
    });
    const renderer = await createLabelRenderer();
    try {
      let thrown: unknown;
      try {
        await buildAiBackdropCase(caseSpec, renderer, backdropsDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toMatch(/expects a backdrop photo/);
      expect((thrown as NodeJS.ErrnoException).code).toBe("EISDIR");
    } finally {
      await renderer.close();
      rmSync(backdropsDir, { recursive: true, force: true });
    }
  });

  it("composites the rendered label onto the committed backdrop", async () => {
    const backdropsDir = mkdtempSync(path.join(tmpdir(), "build-test-backdrops-"));
    const backdrop = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .png()
      .toBuffer();
    writeFileSync(path.join(backdropsDir, "case-ai-backdrop-test.png"), backdrop);

    const caseSpec = aiBackdropCase({
      labelPlacement: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 1000, y: 0 },
        bottomLeft: { x: 0, y: 800 },
        bottomRight: { x: 1000, y: 800 },
      },
    });

    const renderer = await createLabelRenderer();
    try {
      const image = await buildAiBackdropCase(caseSpec, renderer, backdropsDir);
      const meta = await sharp(image).metadata();
      expect(meta.width).toBe(1000);
      expect(meta.height).toBe(800);

      // Dimensions alone don't prove compositing happened -- a bug that
      // silently returned the backdrop untouched would still pass the two
      // assertions above. labelPlacement covers the entire backdrop here,
      // so a pixel at the center must show the renderer's real label
      // content (at minimum an opaque white card, per render.ts), not the
      // untouched backdrop's solid (5, 5, 5).
      const centerPixel = await sharp(image)
        .extract({ left: 500, top: 400, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      expect([centerPixel[0], centerPixel[1], centerPixel[2]]).not.toEqual([5, 5, 5]);
    } finally {
      await renderer.close();
      rmSync(backdropsDir, { recursive: true, force: true });
    }
  });
});
