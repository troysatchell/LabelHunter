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
import type { ExtractedGovernmentWarning } from "../extractor/types";
import type { PixelRegion } from "../preprocessing/region";
import {
  compareGovernmentWarningFromImage,
  OCR_TIMEOUT_MS,
  runWarningOcr,
  toVlmWarningCandidate,
  type CompareGovernmentWarningFromImageDeps,
  type RunWarningOcrDeps,
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
});

/**
 * TRO-519, at this module's own public entry point. `ocr.test.ts` proves
 * `runWarningOcr` itself degrades to `null` on a timeout; this proves the
 * REAL production wiring built from it — `compareGovernmentWarningFromImage`
 * -> `runOcrChannel` -> `runWarningOcr` — degrades all the way through to a
 * `WarningComparatorResult` within a bounded time, not just that the
 * innermost function does. Only `createWorker` is faked (never resolving —
 * the hung-worker shape, not a real sleep, lessons.md rule 8); region
 * detection, cropping, and `runWarningOcr` itself are all the real
 * production code.
 */
describe("compareGovernmentWarningFromImage — OCR channel timeout (TRO-519)", () => {
  const FAKE_REGION: PixelRegion = { x: 0, y: 0, width: 10, height: 10 };

  it("degrades to single-channel MATCH, not an indefinite hang, when the real runWarningOcr's own createWorker never resolves", async () => {
    vi.useFakeTimers();
    try {
      const neverResolvingCreateWorker: RunWarningOcrDeps["createWorker"] = vi.fn(
        () => new Promise(() => {}),
      ) as unknown as RunWarningOcrDeps["createWorker"];

      const fakeDeps: CompareGovernmentWarningFromImageDeps = {
        detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
        crop: vi.fn().mockResolvedValue(Buffer.from([])),
        ocr: (crop) => runWarningOcr(crop, { createWorker: neverResolvingCreateWorker }),
      };

      // A clean, confident VLM read: once OCR degrades to unavailable, CP-2
      // §4.5's single-channel table makes the expected verdict unambiguous
      // (exact match, confidence >= 0.90 -> MATCH), so this test proves
      // more than "it eventually returns something" without depending on
      // reconcile.ts's own internals (out of this ticket's scope).
      const resultPromise = compareGovernmentWarningFromImage(
        { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
        fakeDeps,
      );

      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.verdict).toBe("MATCH");
    } finally {
      vi.useRealTimers();
    }
  });
});
