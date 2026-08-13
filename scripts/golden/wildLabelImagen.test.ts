/**
 * Tests for the wild-label generation path added to `imagen.ts` (LH-027 /
 * TRO-530). Every test here uses a fake `WildLabelGenerator` — no network
 * call, matching `imagen.test.ts`'s existing convention for job 1. The
 * real network call only happens when a human runs `pnpm golden:imagen --
 * --wild` by hand (see `mainWild`'s own doc comment).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  computeWildLabelCostUsd,
  extractWildLabelUsage,
  generateAllWildLabels,
  generateWildLabelOne,
  type WildLabelGenerationOutput,
  type WildLabelGenerator,
} from "./imagen";
import { WILD_LABEL_PROMPT_VERSION, type WildLabelRequest } from "./wildLabelPrompt";

const SAMPLE_REQUEST: WildLabelRequest = {
  caseId: "case-fixture-wild-label",
  beverageType: "spirits",
  brandName: "Fixture Distillers",
  classType: "Straight Bourbon Whiskey",
  abvText: "45% Alc./Vol. (90 Proof)",
  netContentsText: "750 mL",
  warningText: "GOVERNMENT WARNING: fixture text.",
  designBrief: "Design direction: plain fixture label for tests.",
};

async function makeSolidPng(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 12, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
}

function fakeUsage(overrides: Partial<{ promptTokenCount: number; imageOutputTokenCount: number; otherOutputTokenCount: number }> = {}) {
  return {
    promptTokenCount: 256,
    imageOutputTokenCount: 1120,
    otherOutputTokenCount: 256,
    ...overrides,
  };
}

describe("extractWildLabelUsage", () => {
  it("sums the IMAGE-modality token count out of candidatesTokensDetails", () => {
    const usage = extractWildLabelUsage({
      promptTokenCount: 256,
      candidatesTokenCount: 1376,
      candidatesTokensDetails: [
        { modality: "IMAGE", tokenCount: 1120 },
        { modality: "TEXT", tokenCount: 256 },
      ],
    });
    expect(usage).toEqual({ promptTokenCount: 256, imageOutputTokenCount: 1120, otherOutputTokenCount: 256 });
  });

  it("treats any non-IMAGE remainder as otherOutputTokenCount even with no matching detail entries", () => {
    const usage = extractWildLabelUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 1120,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    });
    expect(usage.otherOutputTokenCount).toBe(0);
  });

  // A missing or internally-inconsistent usageMetadata must never silently
  // read as "spent $0" -- CLAUDE.md's "never fabricate a number" applies to
  // a fabricated ZERO exactly as much as to a fabricated positive one. Every
  // case below throws instead of defaulting, so a genuinely degraded real
  // response aborts the run rather than writing a file with an
  // under-reported cost (CodeRabbit finding, round 1).
  it("throws when usageMetadata is entirely absent", () => {
    expect(() => extractWildLabelUsage(undefined)).toThrow(/usageMetadata/);
  });

  it("throws when promptTokenCount is missing", () => {
    expect(() =>
      extractWildLabelUsage({
        candidatesTokenCount: 1120,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
      }),
    ).toThrow(/promptTokenCount/);
  });

  it("throws when candidatesTokenCount is missing", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 256,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
      }),
    ).toThrow(/candidatesTokenCount/);
  });

  it("throws when candidatesTokensDetails carries no IMAGE modality entry", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 256,
        candidatesTokenCount: 256,
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 256 }],
      }),
    ).toThrow(/IMAGE/);
  });

  it("throws when candidatesTokensDetails is entirely absent", () => {
    expect(() =>
      extractWildLabelUsage({ promptTokenCount: 256, candidatesTokenCount: 1376 }),
    ).toThrow(/IMAGE/);
  });

  it("throws when an IMAGE detail's tokenCount is itself missing", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 256,
        candidatesTokenCount: 1376,
        candidatesTokensDetails: [{ modality: "IMAGE" }],
      }),
    ).toThrow(/IMAGE/);
  });

  it("throws when candidatesTokenCount is internally inconsistent (less than the IMAGE token count alone)", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 0,
        candidatesTokenCount: 100,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 9000 }],
      }),
    ).toThrow(/inconsistent/);
  });

  // Real Gemini token counts are always non-negative integers -- a
  // fractional or negative count is itself a signal of bad data, not a
  // value this function should silently accept and feed into a cost
  // calculation (CodeRabbit finding, round 2).
  it("throws when promptTokenCount is negative", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: -1,
        candidatesTokenCount: 1120,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
      }),
    ).toThrow(/non-negative integer/);
  });

  it("throws when promptTokenCount is a non-integer", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 12.5,
        candidatesTokenCount: 1120,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
      }),
    ).toThrow(/non-negative integer/);
  });

  it("throws when candidatesTokenCount is negative", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 0,
        candidatesTokenCount: -1,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 0 }],
      }),
    ).toThrow(/non-negative integer/);
  });

  it("throws when an IMAGE detail's tokenCount is negative", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 0,
        candidatesTokenCount: 100,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: -5 }],
      }),
    ).toThrow(/non-negative integer/);
  });

  it("throws when an IMAGE detail's tokenCount is a non-integer", () => {
    expect(() =>
      extractWildLabelUsage({
        promptTokenCount: 0,
        candidatesTokenCount: 100,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 99.9 }],
      }),
    ).toThrow(/non-negative integer/);
  });
});

describe("computeWildLabelCostUsd", () => {
  it("computes exact real cost from real gemini-3.1-flash-image standard-tier pricing", () => {
    // $0.50 / 1M input, $60.00 / 1M image output, $3 / 1M text/thinking output
    // (confirmed live against ai.google.dev/gemini-api/docs/pricing, 2026-08-13).
    const cost = computeWildLabelCostUsd(fakeUsage());
    const expected = (256 / 1_000_000) * 0.5 + (1120 / 1_000_000) * 60 + (256 / 1_000_000) * 3;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeCloseTo(0.068096, 6);
  });

  it("returns 0 for all-zero usage", () => {
    expect(computeWildLabelCostUsd({ promptTokenCount: 0, imageOutputTokenCount: 0, otherOutputTokenCount: 0 })).toBe(0);
  });

  it("scales linearly with image output tokens", () => {
    const single = computeWildLabelCostUsd({ promptTokenCount: 0, imageOutputTokenCount: 1120, otherOutputTokenCount: 0 });
    const double = computeWildLabelCostUsd({ promptTokenCount: 0, imageOutputTokenCount: 2240, otherOutputTokenCount: 0 });
    expect(double).toBeCloseTo(single * 2, 10);
  });
});

describe("generateWildLabelOne", () => {
  it("writes a PNG and a sidecar with prompt, usage, and real computed cost", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "wild-label-test-out-"));
    try {
      const png = await makeSolidPng();
      const generate: WildLabelGenerator = async (): Promise<WildLabelGenerationOutput> => ({
        image: png,
        usage: fakeUsage(),
      });

      const result = await generateWildLabelOne(SAMPLE_REQUEST, generate, outDir);

      expect(result.caseId).toBe("case-fixture-wild-label");
      expect(result.costUsd).toBeCloseTo(0.068096, 6);

      const writtenImage = readFileSync(result.imagePath);
      expect(writtenImage.length).toBeGreaterThan(0);
      const decoded = await sharp(writtenImage).metadata();
      expect(decoded.format).toBe("png");

      const meta = JSON.parse(readFileSync(result.metaPath, "utf8"));
      expect(meta.caseId).toBe("case-fixture-wild-label");
      expect(meta.prompt).toContain("Fixture Distillers");
      expect(meta.usage).toEqual(fakeUsage());
      expect(meta.costUsd).toBeCloseTo(0.068096, 6);
      expect(meta.generationMetadata.promptVersion).toBe(WILD_LABEL_PROMPT_VERSION);
      expect(meta.generationMetadata.model).toBeTruthy();
      expect(() => new Date(meta.generationMetadata.generatedAt).toISOString()).not.toThrow();
      expect(new Date(meta.generationMetadata.generatedAt).toISOString()).toBe(meta.generationMetadata.generatedAt);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe caseId before ever calling generate (no wasted Gemini spend)", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "wild-label-test-unsafe-"));
    let calls = 0;
    const generate: WildLabelGenerator = async () => {
      calls++;
      return { image: await makeSolidPng(), usage: fakeUsage() };
    };
    try {
      const unsafeRequest: WildLabelRequest = { ...SAMPLE_REQUEST, caseId: "../../../../etc/passwd" };
      await expect(generateWildLabelOne(unsafeRequest, generate, outDir)).rejects.toThrow(/safe filename slug/);
      expect(calls).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses to write outside outDir even given a maliciously-constructed caseId", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "wild-label-test-contain-"));
    try {
      // Passes assertSafeSlug (letters/digits/hyphen/underscore only) but
      // could still resolve outside outDir if resolveWithinDir were ever
      // skipped -- the same second, independent containment layer
      // imagen.test.ts already proves for the backdrop path.
      const png = await makeSolidPng();
      const generate: WildLabelGenerator = async () => ({ image: png, usage: fakeUsage() });
      const request: WildLabelRequest = { ...SAMPLE_REQUEST, caseId: "case-fixture-wild-label" };
      const result = await generateWildLabelOne(request, generate, outDir);
      expect(path.dirname(result.imagePath)).toBe(path.resolve(outDir));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("generateAllWildLabels", () => {
  it("generates every request in the list and returns one result per request", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "wild-label-test-all-"));
    try {
      const png = await makeSolidPng();
      const seenPrompts: string[] = [];
      const generate: WildLabelGenerator = async (prompt: string) => {
        seenPrompts.push(prompt);
        return { image: png, usage: fakeUsage() };
      };
      const requests: WildLabelRequest[] = [
        SAMPLE_REQUEST,
        { ...SAMPLE_REQUEST, caseId: "case-fixture-wild-label-2", brandName: "Second Fixture Co." },
      ];

      const results = await generateAllWildLabels(generate, outDir, requests);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.caseId)).toEqual(["case-fixture-wild-label", "case-fixture-wild-label-2"]);
      expect(seenPrompts[1]).toContain("Second Fixture Co.");
      expect(readdirSync(outDir).length).toBe(4); // 2 PNGs + 2 sidecars
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
