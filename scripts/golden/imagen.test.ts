import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { enumerateTargets, generateOne, targetCaseId, type ImageGenerator } from "./imagen";

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
