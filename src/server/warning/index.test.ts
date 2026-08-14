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
  OCR_TIMEOUT_MS,
  runWarningOcr,
  toVlmWarningCandidate,
  type BoldSignalResult,
  type CompareGovernmentWarningFromImageDeps,
  type RunWarningOcrDeps,
} from "./index";
import { CANONICAL_WARNING_TEXT } from "./canonical";
import { OCR_CONFIDENCE_FLOOR } from "./reconcile";

/** A hand-built, well-formed `BoldSignalResult` (TRO-533) — used only to
 * prove `compareGovernmentWarningFromImage` carries whatever
 * `deps.measureBoldSignal` returns straight through to `result.boldSignal`,
 * untouched and separate from `result.comparator`. */
const FAKE_BOLD_SIGNAL: BoldSignalResult = {
  signal: "bold",
  reason: "the prefix's stroke width measures wider than the body's",
  ratio: 2.1,
  splitFraction: 0.49,
  prefixStrokeWidthPx: 5,
  bodyStrokeWidthPx: 2.4,
};

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
      measureBoldSignal: vi.fn(),
      buildRetryVariant: vi.fn(),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ present: false, transcription: null }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.comparator.verdict).toBe("NEEDS_REVIEW");
    // No crop was ever produced — no region, so nothing to measure.
    expect(result.boldSignal).toBeNull();
  });

  it("never rejects when a dependency promise itself rejects — degrades to single-channel instead", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockRejectedValue(new Error("sharp blew up on a corrupt buffer")),
      crop: vi.fn(),
      ocr: vi.fn(),
      measureBoldSignal: vi.fn(),
      buildRetryVariant: vi.fn(),
    };
    // The VLM channel is otherwise a clean, confident exact match — this
    // proves a rejected OCR-side dependency degrades to single-channel
    // (CP-2 §4.4 rule 3) rather than rejecting the whole Promise.all and
    // discarding an already-good VLM read.
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.comparator.verdict).toBe("MATCH");
  });
});

describe("compareGovernmentWarningFromImage — wiring, with fast injected fakes", () => {
  const FAKE_REGION: PixelRegion = { x: 0, y: 0, width: 10, height: 10 };

  it("MATCH when both the VLM promise and the OCR path agree with canonical", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(Buffer.from([])),
      ocr: vi.fn().mockResolvedValue({ text: CANONICAL_WARNING_TEXT, confidence: 92 }),
      measureBoldSignal: vi.fn().mockResolvedValue(FAKE_BOLD_SIGNAL),
      buildRetryVariant: vi.fn(),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: Promise.resolve(extractedWarning()), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.comparator.verdict).toBe("MATCH");
    // The bold signal reaches the caller untouched, and it is measured off
    // the SAME crop `deps.ocr` reads (TRO-533) — never a second crop.
    expect(result.boldSignal).toEqual(FAKE_BOLD_SIGNAL);
    const cropBufferSeenByOcr = (fakeDeps.crop as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(fakeDeps.measureBoldSignal).toHaveBeenCalledWith(await cropBufferSeenByOcr);
    // TRO-583: a successful first OCR attempt never touches the retry path.
    expect(fakeDeps.buildRetryVariant).not.toHaveBeenCalled();
    expect(fakeDeps.ocr).toHaveBeenCalledTimes(1);
  });

  it("falls back to single-channel when region detection finds nothing", async () => {
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue(null),
      crop: vi.fn(),
      ocr: vi.fn().mockResolvedValue(null),
      measureBoldSignal: vi.fn(),
      buildRetryVariant: vi.fn(),
    };
    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );
    expect(result.comparator.verdict).toBe("MATCH"); // single-channel, VLM exact match, confidence >= 0.90
    expect(fakeDeps.crop).not.toHaveBeenCalled(); // nothing to crop — no region was found
    expect(fakeDeps.measureBoldSignal).not.toHaveBeenCalled(); // nothing to measure either
    // TRO-583: no crop ever existed to retry with — region detection
    // failing outright is a distinct, earlier failure this ticket does not
    // retry (see runOcrChannel's own comment on this scope decision).
    expect(fakeDeps.buildRetryVariant).not.toHaveBeenCalled();
    expect(result.boldSignal).toBeNull();
  });
});

/**
 * TRO-583's own regression tests: the failure-triggered retry runs exactly
 * once, feeds reconcile the retry's read when it succeeds, and never fires
 * at all on a successful first read (the happy path stays byte-identical).
 * `result.comparator.channel` is the load-bearing assertion throughout —
 * `"dual"` only ever comes out of `reconcileDualChannel`
 * (`reconcile.ts`, untouched by this ticket), so a test asserting `"dual"`
 * after a FAILED first attempt is proof the SECOND (retry) reading is what
 * actually reached reconciliation, not a coincidence of the VLM channel
 * alone.
 */
describe("compareGovernmentWarningFromImage — OCR retry (TRO-583)", () => {
  const FAKE_REGION: PixelRegion = { x: 0, y: 0, width: 10, height: 10 };
  const RETRY_VARIANT_BUFFER = Buffer.from("upscaled-variant");
  const ORIGINAL_CROP_BUFFER = Buffer.from("original-crop");

  it("retries once with the variant when the first attempt times out (null), and reconcile receives the retry's read", async () => {
    const ocr = vi
      .fn()
      .mockResolvedValueOnce(null) // first attempt: TRO-519 degraded shape (timeout or thrown error)
      .mockResolvedValueOnce({ text: CANONICAL_WARNING_TEXT, confidence: 92 }); // the retry succeeds
    const buildRetryVariant = vi.fn().mockResolvedValue(RETRY_VARIANT_BUFFER);
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(ORIGINAL_CROP_BUFFER),
      ocr,
      measureBoldSignal: vi.fn().mockResolvedValue(null),
      buildRetryVariant,
    };

    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );

    expect(ocr).toHaveBeenCalledTimes(2);
    expect(buildRetryVariant).toHaveBeenCalledTimes(1);
    expect(buildRetryVariant).toHaveBeenCalledWith(ORIGINAL_CROP_BUFFER); // the SAME crop — no re-crop, no re-detection
    expect(ocr).toHaveBeenNthCalledWith(2, RETRY_VARIANT_BUFFER); // the retry reads the VARIANT, not the original crop again
    expect(result.comparator.verdict).toBe("MATCH");
    expect(result.comparator.channel).toBe("dual"); // proves reconcile ran on the RETRY's reading, not single-channel VLM-only
  });

  it("retries once when the first attempt returns a read below OCR_CONFIDENCE_FLOOR — the exact reading reconcile.ts would otherwise discard to single-channel", async () => {
    const ocr = vi
      .fn()
      .mockResolvedValueOnce({ text: "garbled tiny print", confidence: OCR_CONFIDENCE_FLOOR - 1 })
      .mockResolvedValueOnce({ text: CANONICAL_WARNING_TEXT, confidence: 90 });
    const buildRetryVariant = vi.fn().mockResolvedValue(RETRY_VARIANT_BUFFER);
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(ORIGINAL_CROP_BUFFER),
      ocr,
      measureBoldSignal: vi.fn().mockResolvedValue(null),
      buildRetryVariant,
    };

    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );

    expect(ocr).toHaveBeenCalledTimes(2);
    expect(buildRetryVariant).toHaveBeenCalledTimes(1);
    expect(result.comparator.channel).toBe("dual");
  });

  it("retries at most once — when the retry also fails, degrades to single-channel exactly as the pre-TRO-583 behavior did", async () => {
    const ocr = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null); // both attempts fail
    const buildRetryVariant = vi.fn().mockResolvedValue(RETRY_VARIANT_BUFFER);
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(ORIGINAL_CROP_BUFFER),
      ocr,
      measureBoldSignal: vi.fn().mockResolvedValue(null),
      buildRetryVariant,
    };

    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );

    expect(ocr).toHaveBeenCalledTimes(2); // never a second retry
    expect(buildRetryVariant).toHaveBeenCalledTimes(1);
    expect(result.comparator.verdict).toBe("MATCH"); // single-channel, VLM exact match, confidence >= 0.90
    expect(result.comparator.channel).toBe("single");
  });

  it("does not call buildRetryVariant, and calls ocr exactly once, when the first attempt already succeeds — the happy path is untouched by this ticket", async () => {
    const ocr = vi.fn().mockResolvedValue({ text: CANONICAL_WARNING_TEXT, confidence: 92 });
    const buildRetryVariant = vi.fn();
    const fakeDeps: CompareGovernmentWarningFromImageDeps = {
      detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
      crop: vi.fn().mockResolvedValue(ORIGINAL_CROP_BUFFER),
      ocr,
      measureBoldSignal: vi.fn().mockResolvedValue(null),
      buildRetryVariant,
    };

    const result = await compareGovernmentWarningFromImage(
      { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
      fakeDeps,
    );

    expect(ocr).toHaveBeenCalledTimes(1);
    expect(buildRetryVariant).not.toHaveBeenCalled();
    expect(result.comparator.channel).toBe("dual");
  });

  /**
   * Local CodeRabbit review round 1: an earlier draft bounded only the
   * retry's own `deps.ocr` call and left `deps.buildRetryVariant` itself
   * free to hang forever between the two OCR calls — the ticket's own
   * "never an unbounded hang" instruction does not accept that gap. This
   * test injects a `buildRetryVariant` that never resolves (the hang
   * shape, not a real sleep — lessons.md rule 8) and proves the whole
   * retry phase still degrades within `OCR_TIMEOUT_MS`, never invoking a
   * second `deps.ocr` call at all — it never gets the chance to.
   */
  it("degrades to single-channel within OCR_TIMEOUT_MS, and never calls ocr a second time, when buildRetryVariant itself never resolves", async () => {
    vi.useFakeTimers();
    try {
      const ocr = vi.fn().mockResolvedValue(null); // first attempt fails outright — triggers the retry
      const buildRetryVariant = vi.fn(() => new Promise<Buffer>(() => {})); // never resolves
      const fakeDeps: CompareGovernmentWarningFromImageDeps = {
        detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
        crop: vi.fn().mockResolvedValue(ORIGINAL_CROP_BUFFER),
        ocr,
        measureBoldSignal: vi.fn().mockResolvedValue(null),
        buildRetryVariant,
      };

      const resultPromise = compareGovernmentWarningFromImage(
        { extracted: extractedWarning({ confidence: 0.95 }), originalImage: Buffer.from([]) },
        fakeDeps,
      );

      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
      const result = await resultPromise;

      expect(buildRetryVariant).toHaveBeenCalledTimes(1);
      expect(ocr).toHaveBeenCalledTimes(1); // never reached a second call — buildRetryVariant never handed back a variant
      expect(result.comparator.verdict).toBe("MATCH"); // single-channel, VLM exact match, confidence >= 0.90
      expect(result.comparator.channel).toBe("single");
    } finally {
      vi.useRealTimers();
    }
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
      measureBoldSignal: vi.fn().mockResolvedValue(FAKE_BOLD_SIGNAL),
      buildRetryVariant: vi.fn(),
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
    expect(result.comparator.verdict).toBe("MATCH");
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
      expect(result.comparator.verdict).toBe("MATCH");
      // TRO-533: the bold signal, measured for real off this real image's
      // real crop — not a fake. case-01's manifest ground truth
      // (`governmentWarningPrefixBold: true`) agrees with what
      // `measureBoldSignal` finds here (observed directly, 2026-08-13).
      expect(result.boldSignal).not.toBeNull();
      expect(result.boldSignal?.signal).toBe("bold");
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

      expect(result.comparator.verdict).toBe("MISMATCH");
      expect(result.comparator.note).toBe("Government Warning must print in capital letters.");
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

      expect(result.comparator.verdict).toBe("MISMATCH");
      expect(result.comparator.note).toBe("Government Warning wording differs from the required text.");
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
 *
 * TRO-583: a timed-out first attempt is now a retry trigger, so the
 * bounded-degradation property this test proves must hold across BOTH
 * attempts, not just one — the test advances fake time by
 * `2 * OCR_TIMEOUT_MS` (this ticket's own analytic worst-case bound: one
 * retry, each attempt independently bounded by the same TRO-519 deadline)
 * and asserts `ocr` was actually called twice, not just that a result
 * eventually came back.
 */
describe("compareGovernmentWarningFromImage — OCR channel timeout (TRO-519, TRO-583)", () => {
  const FAKE_REGION: PixelRegion = { x: 0, y: 0, width: 10, height: 10 };

  it("degrades to single-channel MATCH within 2x OCR_TIMEOUT_MS, not an indefinite hang, when the real runWarningOcr's own createWorker never resolves on either attempt", async () => {
    vi.useFakeTimers();
    try {
      const neverResolvingCreateWorker: RunWarningOcrDeps["createWorker"] = vi.fn(
        () => new Promise(() => {}),
      ) as unknown as RunWarningOcrDeps["createWorker"];

      const ocr = vi.fn((crop: Buffer) => runWarningOcr(crop, { createWorker: neverResolvingCreateWorker }));
      const fakeDeps: CompareGovernmentWarningFromImageDeps = {
        detectRegion: vi.fn().mockResolvedValue({ region: FAKE_REGION, method: "classical" }),
        crop: vi.fn().mockResolvedValue(Buffer.from([])),
        ocr,
        measureBoldSignal: vi.fn().mockResolvedValue(null),
        buildRetryVariant: vi.fn().mockResolvedValue(Buffer.from([])),
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

      // First attempt's own deadline.
      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
      // TRO-583's retry fires only after the first attempt is already
      // known to have failed — advance a second, independent deadline for
      // the retry's own `runWarningOcr` call.
      await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
      const result = await resultPromise;

      expect(ocr).toHaveBeenCalledTimes(2); // the original attempt, plus exactly one retry — never more

      expect(result.comparator.verdict).toBe("MATCH");
    } finally {
      vi.useRealTimers();
    }
  });
});
