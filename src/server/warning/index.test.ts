/**
 * Tests for the warning subsystem's top-level orchestrator (LH-020 /
 * TRO-468, CP-2 §4.4). Written before the relevant parts of `index.ts` —
 * TDD, PRD §6.
 *
 * `reconcileWarningChannels` itself (the pure comparator) is fully tested
 * in `reconcile.test.ts`; this file covers `toVlmWarningCandidate`'s
 * defensive boundary check and `compareGovernmentWarningFromImage`'s
 * async wiring — in particular, that it genuinely runs the OCR path
 * concurrently with the (possibly still-pending) VLM promise, per CP-2
 * §4.4's "OCR runs concurrently with the Haiku call, never serially."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadGoldenSetManifest } from "../../lib/golden-set/loader";
import type { ExtractedGovernmentWarning } from "../extractor/types";
import type { PixelRegion } from "../preprocessing/region";
import {
  compareGovernmentWarningFromImage,
  toVlmWarningCandidate,
  type CompareGovernmentWarningFromImageDeps,
} from "./index";
import { CANONICAL_WARNING_TEXT } from "./canonical";

function extractedWarning(overrides: Partial<ExtractedGovernmentWarning> = {}): ExtractedGovernmentWarning {
  return {
    present: true,
    transcription: CANONICAL_WARNING_TEXT,
    prefix_casing: "ALL_CAPS",
    formatting: { bold: "uncertain" },
    evidence: CANONICAL_WARNING_TEXT,
    confidence: 0.97,
    ...overrides,
  };
}

/** A controllable promise for deterministic concurrency assertions —
 * `resolve` is exposed so a test can trigger it at a chosen point. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("toVlmWarningCandidate", () => {
  it("maps a present, transcribed warning to a VlmWarningCandidate", () => {
    const candidate = toVlmWarningCandidate(extractedWarning());
    expect(candidate).toEqual({
      transcription: CANONICAL_WARNING_TEXT,
      prefixCasing: "ALL_CAPS",
      confidence: 0.97,
    });
  });

  it("returns null when transcription is null — the router's MISSING_REQUIRED_FIELD territory, not this one's", () => {
    expect(toVlmWarningCandidate(extractedWarning({ present: false, transcription: null }))).toBeNull();
  });
});

describe("compareGovernmentWarningFromImage — defensive handling", () => {
  it("never crashes on a null transcription; returns a REVIEW rather than a fabricated verdict", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue(null),
      crop: vi.fn(),
      ocr: vi.fn().mockResolvedValue(null),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ present: false, transcription: null }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("never rejects when a dependency promise itself rejects — degrades to single-channel instead", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockRejectedValue(new Error("sharp blew up on a corrupt buffer")),
      crop: vi.fn(),
      ocr: vi.fn(),
    };
    // The VLM channel is otherwise a clean, confident exact match — this
    // proves a rejected OCR-side dependency degrades to single-channel
    // (CP-2 §4.4 rule 3) rather than rejecting the whole Promise.all and
    // discarding an already-good VLM read.
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.verdict).toBe("MATCH");
  });
});

describe("compareGovernmentWarningFromImage — wiring, with fast injected fakes", () => {
  const FAKE_REGION: PixelRegion = { x: 0, y: 0, width: 10, height: 10 };

  it("MATCH when both the VLM promise and the OCR path agree with canonical", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(Buffer.from([])),
      ocr: vi.fn().mockResolvedValue({ text: CANONICAL_WARNING_TEXT, confidence: 92 }),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: Promise.resolve(extractedWarning()), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.verdict).toBe("MATCH");
  });

  it("falls back to single-channel when region detection finds nothing", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue(null),
      crop: vi.fn(),
      ocr: vi.fn().mockResolvedValue(null),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.verdict).toBe("MATCH"); // single-channel, VLM exact match, confidence >= 0.90
    expect(fakeDeps.crop).not.toHaveBeenCalled(); // nothing to crop — no region was found
  });
});

describe("compareGovernmentWarningFromImage — real concurrency (CP-2 §4.4)", () => {
  it("starts the OCR path before the VLM promise resolves, not after", async () => {
    const vlmDeferred = deferred<ExtractedGovernmentWarning>();
    const regionDeferred = deferred<{ region: PixelRegion; method: "classical" }>();
    let detectRegionCalledBeforeVlmResolved = false;

    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockImplementation(async () => {
        detectRegionCalledBeforeVlmResolved = true; // reached before the test resolves vlmDeferred, below
        return regionDeferred.promise;
      }),
      crop: vi.fn().mockResolvedValue(Buffer.from([])),
      ocr: vi.fn().mockResolvedValue({ text: CANONICAL_WARNING_TEXT, confidence: 92 }),
    };

    const resultPromise = compareGovernmentWarningFromImage(
      { extracted: vlmDeferred.promise, originalImage: Buffer.from([]) },
      fakeDeps,
    );

    // Give the microtask queue one turn — enough for compareGovernmentWarningFromImage's
    // synchronous prefix (calling runOcrChannel, which calls detectRegion)
    // to run, without needing the VLM promise to resolve at all.
    await Promise.resolve();
    await Promise.resolve();

    expect(detectRegionCalledBeforeVlmResolved).toBe(true);
    expect(fakeDeps.detectRegion).toHaveBeenCalledTimes(1);

    // Only now resolve both sides, and confirm the whole call still
    // completes correctly — proving this was a real Promise.all, not a
    // fire-and-forget that discarded the OCR path's result.
    regionDeferred.resolve({ region: { x: 0, y: 0, width: 10, height: 10 }, method: "classical" });
    vlmDeferred.resolve(extractedWarning());

    const result = await resultPromise;
    expect(result.verdict).toBe("MATCH");
  });
});

describe("compareGovernmentWarningFromImage — real image, real OCR, real region detection", () => {
  const goldenSetManifest = loadGoldenSetManifest();

  /** Looks up a case by ID so the image path and warning text come from the
   * manifest, not a pasted literal (INT-001, interpretations.md:9-24). */
  function findGoldenCase(caseId: string) {
    const found = goldenSetManifest.cases.find((c) => c.caseId === caseId);
    if (!found) throw new Error(`golden-set manifest is missing ${caseId}`);
    return found;
  }

  it(
    "case-01: PASS end to end, using the real pipeline against a real golden-set image",
    async () => {
      const originalImage = readFileSync("golden-set/images/case-01-clean-match-spirits.jpg");
      const result = await compareGovernmentWarningFromImage({
        extracted: extractedWarning(),
        originalImage,
      });
      expect(result.verdict).toBe("MATCH");
    },
    15_000,
  );

  // INT-001 (audit/requirements/interpretations.md:9-24): at least one FAIL
  // case must run the real pipeline, not simulated channels. This test
  // proves TH-R9's title-case FAIL case with real region detection and
  // real OCR — comparator-level proof alone is not enough.
  //
  // Pass TITLE_CASE, not extractedWarning()'s ALL_CAPS default. This
  // image's prefix is genuinely title case (manifest:
  // governmentWarningPrefixAllCaps: false). The ALL_CAPS default makes
  // applyPrefixCasingCrossCheck (reconcile.ts) downgrade this MISMATCH to
  // NEEDS_REVIEW.
  it(
    "case-08: FAIL — real image, real OCR, real region detection, title-case prefix",
    async () => {
      const goldenCase = findGoldenCase("case-08-title-case-warning-prefix-only");
      const originalImage = readFileSync(goldenCase.imagePath);
      const transcription = goldenCase.label.governmentWarningText;

      const result = await compareGovernmentWarningFromImage({
        extracted: extractedWarning({ transcription, evidence: transcription, prefix_casing: "TITLE_CASE" }),
        originalImage,
      });

      expect(result.verdict).toBe("MISMATCH");
      expect(result.note).toBe("Government Warning must print in capital letters.");
    },
    15_000,
  );

  // INT-001's third acceptance shape (TH-R9): a reworded warning must also
  // fail on the real pipeline. reconcile.test.ts:80-87 already proves the
  // comparator alone. This test proves the pipeline that feeds it, on a
  // real image, with real OCR.
  //
  // INT-001 names only one required case. This one is optional. It is
  // nearly free, and it closes TH-R9's last acceptance case on a real
  // image.
  it(
    "case-10: FAIL — real image, real OCR, real region detection, reworded warning",
    async () => {
      const goldenCase = findGoldenCase("case-10-reworded-warning-clause-one");
      const originalImage = readFileSync(goldenCase.imagePath);
      const transcription = goldenCase.label.governmentWarningText;

      const result = await compareGovernmentWarningFromImage({
        extracted: extractedWarning({ transcription, evidence: transcription, prefix_casing: "ALL_CAPS" }),
        originalImage,
      });

      expect(result.verdict).toBe("MISMATCH");
      expect(result.note).toBe("Government Warning wording differs from the required text.");
    },
    15_000,
  );
});
