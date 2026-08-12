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
  targetCaseId,
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
  it("passes PNG bytes through unchanged when the response mimeType is already image/png", async () => {
    const pngBytes = await makeSolidImage("png");
    const result = await ensurePngBytes(pngBytes, "image/png");
    expect(result).toBe(pngBytes); // same buffer instance -- no re-encode
  });

  it("transcodes a non-PNG response (e.g. image/jpeg) to real PNG bytes", async () => {
    const jpegBytes = await makeSolidImage("jpeg");
    const result = await ensurePngBytes(jpegBytes, "image/jpeg");
    expect(result).not.toBe(jpegBytes);
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
  });

  it("transcodes to PNG when the response mimeType is missing entirely", async () => {
    const jpegBytes = await makeSolidImage("jpeg");
    const result = await ensurePngBytes(jpegBytes, undefined);
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
  });
});
