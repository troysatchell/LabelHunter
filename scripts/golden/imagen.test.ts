import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  detectImageMimeType,
  ensurePngBytes,
  enumerateTargets,
  generateOne,
  runGenerationBatch,
  targetCaseId,
  type GenerationTarget,
  type ImageGenerator,
} from "./imagen";

async function makeSolidImage(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
  const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 12, g: 34, b: 56 } } });
  if (format === "jpeg") return image.jpeg().toBuffer();
  if (format === "webp") return image.webp().toBuffer();
  return image.png().toBuffer();
}

function makeTempReferencesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-refs-"));
  writeFileSync(
    path.join(dir, "amber-whiskey-01.json"),
    JSON.stringify({
      bottleId: "amber-whiskey-01",
      referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
      beverageType: "spirits",
      bottleDescription: "tall amber glass whiskey bottle",
      scenes: [{ sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" }],
      cameraConditions: ["steady", "motion-blur"],
    }),
  );
  return dir;
}

describe("enumerateTargets", () => {
  it("produces the cartesian product of scenes x cameraConditions per bottle", () => {
    const dir = makeTempReferencesDir();
    try {
      const targets = enumerateTargets(dir);
      expect(targets).toHaveLength(2);
      expect(targets.map((t) => t.cameraCondition).sort()).toEqual(["motion-blur", "steady"]);
      expect(targets.every((t) => t.bottleId === "amber-whiskey-01")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an empty references directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-empty-"));
    try {
      expect(enumerateTargets(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws before generating anything when two reference files share a bottleId/scene/cameraCondition", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-dup-"));
    const bottle = {
      bottleId: "amber-whiskey-01",
      referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
      beverageType: "spirits",
      bottleDescription: "tall amber glass whiskey bottle",
      scenes: [{ sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" }],
      cameraConditions: ["steady"],
    };
    try {
      // Two files, same bottleId — same (scene, cameraCondition) product.
      writeFileSync(path.join(dir, "a.json"), JSON.stringify(bottle));
      writeFileSync(path.join(dir, "b.json"), JSON.stringify(bottle));
      expect(() => enumerateTargets(dir)).toThrow(/duplicate generation target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when one reference file repeats the same sceneId", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-dup-scene-"));
    try {
      writeFileSync(
        path.join(dir, "amber-whiskey-01.json"),
        JSON.stringify({
          bottleId: "amber-whiskey-01",
          referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
          beverageType: "spirits",
          bottleDescription: "tall amber glass whiskey bottle",
          scenes: [
            { sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" },
            { sceneId: "bar-counter", setting: "a different description, same ID", lighting: "dim light" },
          ],
          cameraConditions: ["steady"],
        }),
      );
      expect(() => enumerateTargets(dir)).toThrow(/duplicate generation target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("targetCaseId", () => {
  it("builds a stable, readable case ID from bottle/scene/condition", () => {
    const id = targetCaseId({
      bottleId: "amber-whiskey-01",
      referencePhotoPath: "/x.jpg",
      scene: { sceneId: "bar-counter", setting: "x", lighting: "y" },
      cameraCondition: "motion-blur",
    });
    expect(id).toBe("case-ai-backdrop-amber-whiskey-01-bar-counter-motion-blur");
  });
});

const STEADY_TARGET = {
  bottleId: "amber-whiskey-01",
  referencePhotoPath: "/fake.jpg",
  scene: { sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" },
  cameraCondition: "steady" as const,
};

async function fakeGeneratorWithBlankRegion(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect width="400" height="300" fill="rgb(20,20,20)" />
    <rect x="100" y="100" width="150" height="80" fill="rgb(240,233,220)" />
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function fakeGeneratorWithNoBlankRegion(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .png()
    .toBuffer();
}

describe("generateOne", () => {
  it("writes a backdrop PNG and a meta.json sidecar with detected placement", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-out-"));
    const generate: ImageGenerator = fakeGeneratorWithBlankRegion;
    try {
      const result = await generateOne(STEADY_TARGET, generate, outDir);

      expect(result.caseId).toBe("case-ai-backdrop-amber-whiskey-01-bar-counter-steady");
      expect(result.detectedQuad).not.toBeNull();

      expect(readFileSync(result.backdropPath).length).toBeGreaterThan(0);

      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));
      expect(meta.referenceBottle).toBe("amber-whiskey-01");
      expect(meta.scene).toBe("bar-counter");
      expect(meta.cameraCondition).toBe("steady");
      expect(meta.generationMetadata.promptVersion).toBe("v1");
      expect(meta.labelPlacement).not.toBeNull();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("reports a null quad when the generated image has no detectable blank region", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-out-"));
    try {
      const result = await generateOne(STEADY_TARGET, fakeGeneratorWithNoBlankRegion, outDir);
      expect(result.detectedQuad).toBeNull();
      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));
      expect(meta.labelPlacement).toBeNull();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("writes only the 4 corners under labelPlacement, detector bookkeeping under a sibling 'detection' key (TRO-510)", async () => {
    // labelPlacement must match the manifest's own LabelPlacementQuad
    // schema exactly (src/lib/golden-set/types.ts) -- a human copies this
    // field straight into a manifest entry. pixelCount/imageWidth/
    // imageHeight are detector bookkeeping, not part of that schema, and
    // must not accrete into manifest.json alongside it.
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-out-"));
    try {
      const result = await generateOne(STEADY_TARGET, fakeGeneratorWithBlankRegion, outDir);
      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));

      expect(Object.keys(meta.labelPlacement).sort()).toEqual(
        ["bottomLeft", "bottomRight", "topLeft", "topRight"].sort(),
      );
      expect(meta.detection.pixelCount).toBe(result.detectedQuad?.pixelCount);
      expect(meta.detection.imageWidth).toBe(result.detectedQuad?.imageWidth);
      expect(meta.detection.imageHeight).toBe(result.detectedQuad?.imageHeight);
      // A fresh generateOne call's metadata IS real provenance -- the flag
      // must be false, not just absent (TRO-510 review).
      expect(meta.generationMetadata.reconstructedFromExistingBackdrop).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

const OTHER_TARGET: GenerationTarget = {
  bottleId: "amber-whiskey-01",
  referencePhotoPath: "/fake.jpg",
  scene: { sceneId: "shelf", setting: "a store shelf", lighting: "cool light" },
  cameraCondition: "steady",
};

describe("runGenerationBatch", () => {
  it("skips a target whose backdrop and sidecar already exist, without calling generate (no re-spend)", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-batch-"));
    try {
      // Pre-populate the target's output files, simulating a prior run.
      await generateOne(STEADY_TARGET, fakeGeneratorWithBlankRegion, outDir);

      let generateCallCount = 0;
      const spyGenerate: ImageGenerator = async () => {
        generateCallCount++;
        return fakeGeneratorWithBlankRegion();
      };

      const summary = await runGenerationBatch([STEADY_TARGET], spyGenerate, outDir, () => {});

      expect(generateCallCount).toBe(0);
      expect(summary.skipped).toEqual([targetCaseId(STEADY_TARGET)]);
      expect(summary.generated).toEqual([]);
      expect(summary.spentUsd).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("logs one target's failure and continues generating the rest of the batch", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-batch-fail-"));
    const failingGenerate: ImageGenerator = async () => {
      throw new Error("simulated transient Gemini failure");
    };
    try {
      const summary = await runGenerationBatch([STEADY_TARGET, OTHER_TARGET], failingGenerate, outDir, () => {});

      expect(summary.failed).toEqual([targetCaseId(STEADY_TARGET), targetCaseId(OTHER_TARGET)]);
      expect(summary.generated).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("does not let the first target's failure stop the second target from generating", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-batch-partial-"));
    let calls = 0;
    const flakyGenerate: ImageGenerator = async () => {
      calls++;
      if (calls === 1) throw new Error("simulated transient Gemini failure");
      return fakeGeneratorWithBlankRegion();
    };
    try {
      const summary = await runGenerationBatch([STEADY_TARGET, OTHER_TARGET], flakyGenerate, outDir, () => {});

      expect(summary.failed).toEqual([targetCaseId(STEADY_TARGET)]);
      expect(summary.generated).toEqual([targetCaseId(OTHER_TARGET)]);
      expect(summary.spentUsd).toBeGreaterThan(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("recovers a target whose backdrop exists but sidecar is missing, without calling generate again (no re-spend) (TRO-510)", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-recover-"));
    try {
      // Simulate a prior run that wrote the backdrop PNG (a real, paid
      // Gemini call) but crashed before the sidecar write.
      const caseId = targetCaseId(STEADY_TARGET);
      const image = await fakeGeneratorWithBlankRegion();
      writeFileSync(path.join(outDir, `${caseId}.png`), image);

      let generateCallCount = 0;
      const spyGenerate: ImageGenerator = async () => {
        generateCallCount++;
        return fakeGeneratorWithBlankRegion();
      };

      const summary = await runGenerationBatch([STEADY_TARGET], spyGenerate, outDir, () => {});

      expect(generateCallCount).toBe(0);
      expect(summary.recovered).toEqual([caseId]);
      expect(summary.generated).toEqual([]);
      expect(summary.spentUsd).toBe(0);

      const meta = JSON.parse(readFileSync(path.join(outDir, `${caseId}.meta.json`), "utf8"));
      expect(meta.caseId).toBe(caseId);
      expect(meta.labelPlacement).not.toBeNull();
      // A recovered sidecar's model/resolution/promptVersion/generatedAt
      // describe THIS run, not whatever run actually produced the existing
      // PNG -- they must not be mistaken for real provenance. The flag
      // marks that distinction explicitly (TRO-510 review).
      expect(meta.generationMetadata.reconstructedFromExistingBackdrop).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("counts a target's spend when the paid call succeeded but a later step (detection) failed (TRO-510)", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-spend-on-failure-"));
    // generate() "succeeds" (a real paid call returned bytes), but the
    // bytes are not a decodable image -- detectBlankRegionQuad throws
    // reading them. generateOne writes the backdrop PNG before calling
    // detectBlankRegionQuad, so the paid call's cost must still be
    // counted even though the target ends up in `failed`.
    const corruptImageGenerate: ImageGenerator = async () => Buffer.from("not a real image");
    try {
      const summary = await runGenerationBatch([STEADY_TARGET], corruptImageGenerate, outDir, () => {});

      expect(summary.failed).toEqual([targetCaseId(STEADY_TARGET)]);
      expect(summary.generated).toEqual([]);
      expect(summary.spentUsd).toBeGreaterThan(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("path and slug safety", () => {
  it("enumerateTargets rejects a bottleId that is not a safe filename slug", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-unsafe-bottle-"));
    try {
      writeFileSync(
        path.join(dir, "evil.json"),
        JSON.stringify({
          bottleId: "../../etc/passwd",
          referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
          beverageType: "spirits",
          bottleDescription: "tall amber glass whiskey bottle",
          scenes: [{ sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" }],
          cameraConditions: ["steady"],
        }),
      );
      expect(() => enumerateTargets(dir)).toThrow(/safe filename slug/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enumerateTargets rejects a sceneId that is not a safe filename slug", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-unsafe-scene-"));
    try {
      writeFileSync(
        path.join(dir, "amber-whiskey-01.json"),
        JSON.stringify({
          bottleId: "amber-whiskey-01",
          referencePhoto: "assets/golden/references/amber-whiskey-01.jpg",
          beverageType: "spirits",
          bottleDescription: "tall amber glass whiskey bottle",
          scenes: [{ sceneId: "../../outside", setting: "a bar counter", lighting: "warm light" }],
          cameraConditions: ["steady"],
        }),
      );
      expect(() => enumerateTargets(dir)).toThrow(/safe filename slug/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enumerateTargets rejects a referencePhoto that resolves outside assets/golden/references/", () => {
    // A read-side counterpart to the write-side tests above: referencePhoto
    // reaches readFileSync in generateWithGemini, so a traversal here would
    // let a malformed bottle reference JSON read an arbitrary file (e.g.
    // .env.local, which holds this repo's real API keys) and send its
    // bytes to Gemini.
    const dir = mkdtempSync(path.join(tmpdir(), "imagen-test-unsafe-photo-"));
    try {
      writeFileSync(
        path.join(dir, "amber-whiskey-01.json"),
        JSON.stringify({
          bottleId: "amber-whiskey-01",
          referencePhoto: "../../.env.local",
          beverageType: "spirits",
          bottleDescription: "tall amber glass whiskey bottle",
          scenes: [{ sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" }],
          cameraConditions: ["steady"],
        }),
      );
      expect(() => enumerateTargets(dir)).toThrow(/resolves outside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generateOne refuses to write outside outDir even given an unvalidated target directly", async () => {
    // enumerateTargets is the normal caller and already rejects an unsafe
    // bottleId/sceneId before this point (tests above), but generateOne is
    // exported on its own and takes a GenerationTarget, not raw reference
    // JSON — nothing stops a future caller from constructing one by hand.
    // This proves the second, independent layer (resolveWithinDir) holds
    // even when the first layer is bypassed entirely.
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-contain-"));
    try {
      const maliciousTarget = {
        bottleId: "x/../../../../../../../../tmp/pwned",
        referencePhotoPath: "/fake.jpg",
        scene: { sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" },
        cameraCondition: "steady" as const,
      };
      await expect(
        generateOne(maliciousTarget, fakeGeneratorWithBlankRegion, outDir),
      ).rejects.toThrow(/resolves outside/);
      // Nothing was written to outDir either -- the check fires before the
      // first writeFileSync call.
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("generateOne rejects an unsafe target before ever calling generate (no wasted Gemini spend)", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "imagen-test-order-"));
    let generateCallCount = 0;
    const spyGenerate: ImageGenerator = async () => {
      generateCallCount++;
      return fakeGeneratorWithBlankRegion();
    };
    try {
      const maliciousTarget = {
        bottleId: "x/../../../../../../../../tmp/pwned",
        referencePhotoPath: "/fake.jpg",
        scene: { sceneId: "bar-counter", setting: "a bar counter", lighting: "warm light" },
        cameraCondition: "steady" as const,
      };
      await expect(generateOne(maliciousTarget, spyGenerate, outDir)).rejects.toThrow(/resolves outside/);
      expect(generateCallCount).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("detectImageMimeType", () => {
  it("derives image/jpeg from actual JPEG content", async () => {
    const bytes = await makeSolidImage("jpeg");
    await expect(detectImageMimeType(bytes, "test reference")).resolves.toBe("image/jpeg");
  });

  it("derives image/png from actual PNG content — a non-JPEG reference photo", async () => {
    const bytes = await makeSolidImage("png");
    await expect(detectImageMimeType(bytes, "test reference")).resolves.toBe("image/png");
  });

  it("derives image/webp from actual WEBP content", async () => {
    const bytes = await makeSolidImage("webp");
    await expect(detectImageMimeType(bytes, "test reference")).resolves.toBe("image/webp");
  });

  it("rejects bytes with no detectable image format", async () => {
    await expect(detectImageMimeType(Buffer.from("not an image"), "test reference")).rejects.toThrow(
      /unsupported or undetectable/,
    );
  });
});

describe("ensurePngBytes", () => {
  it("passes PNG bytes through unchanged when the actual content is already PNG", async () => {
    const pngBytes = await makeSolidImage("png");
    const result = await ensurePngBytes(pngBytes);
    expect(result).toBe(pngBytes); // same buffer instance -- no re-encode
  });

  it("transcodes non-PNG bytes (detected from content) to real PNG bytes", async () => {
    const jpegBytes = await makeSolidImage("jpeg");
    const result = await ensurePngBytes(jpegBytes);
    expect(result).not.toBe(jpegBytes);
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
  });

  it("detects format from the bytes themselves, not a claimed label -- there is no mimeType parameter to spoof", async () => {
    // The whole point of this fix: a prior version trusted a caller-supplied
    // mimeType string instead of checking real content. There is no such
    // parameter to pass a false label through anymore -- WEBP bytes are
    // still correctly detected and transcoded regardless of what any caller
    // might have claimed about them.
    const webpBytes = await makeSolidImage("webp");
    const result = await ensurePngBytes(webpBytes);
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
  });

  it("propagates a clear error when the response bytes have no detectable image format", async () => {
    await expect(ensurePngBytes(Buffer.from("not an image"))).rejects.toThrow(
      /unsupported or undetectable/,
    );
  });
});
