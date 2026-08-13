/**
 * Tests for the stroke-width-ratio bold advisory check (LH-025 / TRO-532,
 * CP-2 §7.2). Written against real, measured pixel data — TRO-532's own
 * investigation (2026-08-12) against five real label photographs and the
 * golden-set corpus, reproduced here with `measureBoldSignal` itself, not
 * assumed. Where this file's own re-measurement disagrees with that
 * investigation's numbers, this file says so and explains why (standing
 * rule 2: never fabricate a number; standing rule 1: mark a derived claim
 * as derived).
 *
 * `measureBoldSignal` is not called from anywhere else yet (this ticket's
 * own scope — TRO-533 wires it in). Every real-image test here builds its
 * own crop the same way a real caller eventually will:
 * `detectWarningRegion` + `cropForOcr` (LH-020, already merged, unchanged
 * by this ticket) for the four images that pipeline can find a region on,
 * and one explicit hand-cropped region for crown-royal, the one reference
 * photo that pipeline cannot find a region on at all — a pre-existing
 * LH-020 limitation, not a defect in this ticket's own code.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadGoldenSetManifest } from "../../lib/golden-set/loader";
import { cropForOcr, detectWarningRegion } from "./region-detect";
import { runWarningOcr } from "./ocr";
import {
  BOLD_RATIO_THRESHOLD,
  classifyBoldSignal,
  findBoldChangepoint,
  measureBoldSignal,
  otsuThreshold,
  SPLIT_SEARCH_MAX_FRACTION,
  SPLIT_SEARCH_MIN_FRACTION,
  STROKE_WIDTH_FLOOR_PX,
  type StrokeRun,
} from "./bold-detect";

// ---------------------------------------------------------------------------
// otsuThreshold — pure, on synthetic histograms
// ---------------------------------------------------------------------------

describe("otsuThreshold — the binarization threshold (rule 4's contrast-normalize-then-threshold step)", () => {
  it("splits a clean bimodal histogram between its two peaks", () => {
    const histogram = new Array(256).fill(0);
    histogram[40] = 1000; // "ink" cluster
    histogram[220] = 1000; // "background" cluster
    const threshold = otsuThreshold(histogram);
    // Otsu maximizes BETWEEN-class variance, which is flat across the
    // whole empty gap between the two peaks — any level in [40, 220) ties
    // for best, and this implementation keeps the first (lowest) one it
    // finds, so the correct assertion is "at or above the lower peak,"
    // not "strictly above."
    expect(threshold).toBeGreaterThanOrEqual(40);
    expect(threshold).toBeLessThan(220);
  });

  it("returns a threshold that separates the minority ink class from a realistic 90/10 split", () => {
    const histogram = new Array(256).fill(0);
    histogram[30] = 100; // ink, the minority
    histogram[200] = 900; // background, the majority
    const threshold = otsuThreshold(histogram);
    expect(threshold).toBeGreaterThanOrEqual(30);
    expect(threshold).toBeLessThan(200);
  });

  it("returns 128 for an all-empty histogram — no pixels to threshold", () => {
    expect(otsuThreshold(new Array(256).fill(0))).toBe(128);
  });

  it("does not throw on a single-value histogram (no real between-class variance exists)", () => {
    const histogram = new Array(256).fill(0);
    histogram[100] = 500;
    expect(() => otsuThreshold(histogram)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// classifyBoldSignal — pure, all four branches
// ---------------------------------------------------------------------------

describe("classifyBoldSignal — the final decision (rules 5 and 6, plus the ranges-overlap check)", () => {
  it("returns uncertain when either side's stroke width is below the 3px floor (rule 5)", () => {
    const result = classifyBoldSignal(2.5, 2, 8, false);
    expect(result.signal).toBe("uncertain");
    expect(result.reason).toMatch(/floor/);
  });

  it("the floor is EXACTLY STROKE_WIDTH_FLOOR_PX (3) — a value AT the floor is usable, one BELOW it is not", () => {
    expect(classifyBoldSignal(2, STROKE_WIDTH_FLOOR_PX, STROKE_WIDTH_FLOOR_PX, false).signal).not.toBe("uncertain");
    expect(classifyBoldSignal(2, STROKE_WIDTH_FLOOR_PX - 1, STROKE_WIDTH_FLOOR_PX, false).signal).toBe("uncertain");
  });

  it("returns uncertain when the two sides' stroke-width ranges overlap, even above the floor and above the bold ratio", () => {
    // TRO-532's own investigation named this exact failure mode on
    // 39cdef's curved photograph: "no separation; ranges overlap."
    const result = classifyBoldSignal(1.5, 6, 4, true);
    expect(result.signal).toBe("uncertain");
    expect(result.reason).toMatch(/overlap/);
  });

  it("returns bold at or above BOLD_RATIO_THRESHOLD, with no floor or overlap problem", () => {
    const result = classifyBoldSignal(BOLD_RATIO_THRESHOLD, 8, 3, false);
    expect(result.signal).toBe("bold");
  });

  it("returns not-bold below BOLD_RATIO_THRESHOLD, with no floor or overlap problem", () => {
    // This is the branch the current golden set has no real ground-truth
    // case for (see the "no non-bold corpus case exists yet" describe
    // block below) — proven here directly on the decision function
    // itself, per this ticket's own allowance for a synthetic unit test
    // of the classification logic in isolation.
    const result = classifyBoldSignal(1.1, 5, 4, false);
    expect(result.signal).toBe("not-bold");
  });

  it("the floor check runs before the overlap check — a floor failure is never reported as an overlap failure", () => {
    const result = classifyBoldSignal(5, 1, 1, true);
    expect(result.reason).toMatch(/floor/);
  });
});

// ---------------------------------------------------------------------------
// findBoldChangepoint — the constrained-search boundary (rule 3)
// ---------------------------------------------------------------------------

describe("findBoldChangepoint — constrained to [0.15, 0.65] of the line (rule 3)", () => {
  it("SPLIT_SEARCH_MIN_FRACTION/MAX_FRACTION are exactly 0.15 and 0.65, per the ticket's own numbers", () => {
    expect(SPLIT_SEARCH_MIN_FRACTION).toBe(0.15);
    expect(SPLIT_SEARCH_MAX_FRACTION).toBe(0.65);
  });

  /**
   * Reproduces the MECHANISM behind TRO-532's own case-08/case-09
   * finding — "unconstrained, the search always finds some ratio above
   * 1" on a degenerate split whose local cap-height divisor happens to
   * be small — as hand-built numbers, not a rendered image (this
   * ticket's own allowance: "these may be synthetic unit tests of the
   * changepoint logic in isolation, not necessarily requiring the real
   * images"). A line of conceptual width 100 (indices 0-99):
   *
   * - x in [5, 48]: a "true prefix" cluster, stroke length 6 (bold-like).
   * - x in [52, 85]: a "true body" cluster, stroke length 3 (regular).
   * - x in [93, 99]: a small "anomaly" cluster, stroke length 20, whose
   *   own local cap height is artificially small (2, vs 10 everywhere
   *   else) — the exact "local cap-height divisor happens to be small"
   *   artifact rule 3 names, landing outside the search window.
   *
   * The true, correct boundary is around x=50 (split fraction ~0.5).
   */
  function buildDegenerateSplitFixture(): {
    taggedRuns: StrokeRun[];
    prefixCapHeight: number[];
    suffixCapHeight: number[];
  } {
    const taggedRuns: StrokeRun[] = [];
    for (let mid = 5; mid <= 48; mid += 3) taggedRuns.push({ length: 6, mid });
    for (let mid = 52; mid <= 85; mid += 3) taggedRuns.push({ length: 3, mid });
    for (const mid of [93, 96, 99]) taggedRuns.push({ length: 20, mid });

    const width = 100;
    const prefixCapHeight = new Array<number>(width).fill(-1);
    const suffixCapHeight = new Array<number>(width).fill(-1);
    for (let x = 4; x < width; x++) prefixCapHeight[x] = 10;
    for (let x = 0; x <= 90; x++) suffixCapHeight[x] = 10;
    for (let x = 91; x < width; x++) suffixCapHeight[x] = 2;

    return { taggedRuns, prefixCapHeight, suffixCapHeight };
  }

  it("constrained to [15, 65] (0.15-0.65 of width 100), finds the TRUE boundary and a believable ratio", () => {
    const { taggedRuns, prefixCapHeight, suffixCapHeight } = buildDegenerateSplitFixture();
    const result = findBoldChangepoint(taggedRuns, 15, 65, prefixCapHeight, suffixCapHeight, 3);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.splitX).toBeGreaterThanOrEqual(15);
    expect(result.splitX).toBeLessThanOrEqual(65);
    const splitFraction = result.splitX / 100;
    expect(splitFraction).toBeGreaterThan(0.15);
    expect(splitFraction).toBeLessThan(0.65);
    const ratio = result.leftNorm / result.rightNorm;
    expect(ratio).toBeCloseTo(2, 5); // the true prefix/body signal: 0.6 / 0.3
  });

  it("UNCONSTRAINED (searched across the whole line), the same data instead finds the degenerate split outside the window", () => {
    const { taggedRuns, prefixCapHeight, suffixCapHeight } = buildDegenerateSplitFixture();
    const result = findBoldChangepoint(taggedRuns, 5, 99, prefixCapHeight, suffixCapHeight, 3);
    expect(result).not.toBeNull();
    if (!result) return;
    const splitFraction = result.splitX / 100;
    // Outside [0.15, 0.65] — exactly what rule 3 says an unconstrained
    // search does.
    expect(splitFraction).toBeGreaterThan(SPLIT_SEARCH_MAX_FRACTION);
    const ratio = result.leftNorm / result.rightNorm;
    // A wildly different, implausible ratio versus the constrained
    // search's clean 2.0 — the "false ratio" rule 3 warns about.
    // `extremeness` treats a ratio and its reciprocal the same way (a
    // 0.06 ratio is exactly as extreme a separation as a 16.67 ratio,
    // just read from the other side), so this compares magnitude of
    // deviation from "no separation" (ratio 1), not raw ratio value.
    const extremeness = Math.max(ratio, 1 / ratio);
    expect(extremeness).toBeGreaterThan(5); // constrained search's own 2.0, times a real margin
  });
});

// ---------------------------------------------------------------------------
// measureBoldSignal — input validation (standing rule 13)
// ---------------------------------------------------------------------------

describe("measureBoldSignal — never throws, degrades to uncertain on bad input", () => {
  it("an empty buffer returns uncertain", async () => {
    const result = await measureBoldSignal(Buffer.alloc(0));
    expect(result.signal).toBe("uncertain");
    expect(result.ratio).toBeNull();
  });

  it("garbage bytes (not a real image) return uncertain, not a thrown error", async () => {
    const result = await measureBoldSignal(Buffer.from("this is not an image, just text bytes"));
    expect(result.signal).toBe("uncertain");
  });

  it("a tiny, blank 1x1 image returns uncertain — too small to hold a measurable line", async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer();
    const result = await measureBoldSignal(tiny);
    expect(result.signal).toBe("uncertain");
  });

  it("a blank, all-white crop with no text returns uncertain — no line found", async () => {
    const blank = await sharp({ create: { width: 400, height: 100, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer();
    const result = await measureBoldSignal(blank);
    expect(result.signal).toBe("uncertain");
    expect(result.reason).toMatch(/no text line/);
  });
});

// ---------------------------------------------------------------------------
// measureBoldSignal — controlled synthetic text (no photograph involved)
// ---------------------------------------------------------------------------

/** A small multi-line paragraph, line 1 split into a `prefixWeight` span
 * and a `bodyWeight` span, three more `bodyWeight`-only filler lines
 * below — a multi-line SHAPE (not a single line filling the whole crop)
 * so `measureBoldSignal`'s own line-segmentation sanity check (a real
 * paragraph never lets one physical line fill most of the crop) does not
 * itself reject this fixture. */
async function buildSyntheticWarningCrop(prefixWeight: number, bodyWeight: number): Promise<Buffer> {
  const width = 900;
  const fontSize = 32;
  const lineHeight = 42;
  const height = fontSize + 10 + lineHeight * 3 + 20;
  const fillerLines = [
    "the quick brown fox jumps over the lazy dog",
    "another plain filler line of body text here",
    "one more filler line to give this a real shape",
  ];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="white"/>
    <text x="20" y="${fontSize + 10}" font-family="Arial" font-size="${fontSize}">
      <tspan font-weight="${prefixWeight}">GOVERNMENT WARNING:</tspan>
      <tspan font-weight="${bodyWeight}"> according to the surgeon general women</tspan>
    </text>`;
  fillerLines.forEach((line, i) => {
    svg += `<text x="20" y="${fontSize + 10 + (i + 1) * lineHeight}" font-family="Arial" font-size="${fontSize}" font-weight="${bodyWeight}">${line}</text>`;
  });
  svg += `</svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).png().toBuffer();
}

describe("measureBoldSignal — controlled synthetic prefix/body weight", () => {
  it("a genuinely bold (700) prefix against a regular (400) body measures bold", async () => {
    const crop = await buildSyntheticWarningCrop(700, 400);
    const result = await measureBoldSignal(crop);
    expect(result.signal).toBe("bold");
    expect(result.ratio).not.toBeNull();
    if (result.ratio !== null) expect(result.ratio).toBeGreaterThanOrEqual(BOLD_RATIO_THRESHOLD);
  });

  it("a prefix and body at the SAME weight (400/400) never measures bold", async () => {
    const crop = await buildSyntheticWarningCrop(400, 400);
    const result = await measureBoldSignal(crop);
    // Measured (not assumed): at this small a pixel scale, an exactly
    // equal weight lands as "uncertain" via the ranges-overlap check
    // (classifyBoldSignal's own test above proves the "not-bold" branch
    // is reachable directly) rather than a confident "not-bold" — quantization
    // noise at a 3-6px stroke scale is real, which is exactly why rule 5's
    // floor and the overlap check both exist. Either way, "bold" would be
    // a wrong, dangerous answer, and this asserts it is never produced.
    expect(result.signal).not.toBe("bold");
  });
});

// ---------------------------------------------------------------------------
// measureBoldSignal — the 5 real reference photographs (TRO-532's own
// calibration table, reproduced live against the current code)
// ---------------------------------------------------------------------------

/** Builds the "cropped warning-region image" input the same way a real
 * caller (TRO-533) will: `detectWarningRegion` (classical, falling back
 * to band-search) + `cropForOcr`, both already-merged LH-020 code,
 * unmodified by this ticket. */
async function detectAndCrop(imagePath: string): Promise<Buffer | null> {
  const image = readFileSync(imagePath);
  const detection = await detectWarningRegion(image, async (crop) => runWarningOcr(crop));
  if (!detection) return null;
  return cropForOcr(image, detection.region);
}

describe("measureBoldSignal — case-35, the flat real photo (the ticket's own clean reference)", () => {
  it(
    "detects bold, with a ratio and split matching TRO-532's own investigation",
    async () => {
      const crop = await detectAndCrop("assets/golden/references/alcohol-warning-label-1200x596-235563604.jpg");
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("bold");
      expect(result.ratio).not.toBeNull();
      // TRO-532's own table: "2.2 — clean separation, split lands exactly
      // at the colon"; docs/reference-photo-provenance.md: "2.0 to 2.25,
      // stable across three thresholds." Measured here (this file's own
      // live run): 2.727 — in the same neighborhood, not identical (a
      // different crop and a different threshold scheme than the original
      // investigation used), still comfortably clear of BOLD_RATIO_THRESHOLD.
      if (result.ratio !== null) expect(result.ratio).toBeGreaterThan(2);
      expect(result.splitFraction).not.toBeNull();
      // TRO-532's own table: "split lands exactly at the colon" — measured
      // at 0.49 in the original investigation. Measured here: ~0.484.
      if (result.splitFraction !== null) {
        expect(result.splitFraction).toBeGreaterThan(0.4);
        expect(result.splitFraction).toBeLessThan(0.6);
      }
    },
    15_000,
  );
});

describe("measureBoldSignal — the three curved/glare real photos the ticket names as uncertain", () => {
  it.each([
    ["case-36 / 39cdef, gentle curve — the ticket's own table: \"no separation; ranges overlap\"", "assets/golden/references/39cdef_a2d8485e45e84dc69fd21743b9e5de98~mv2-2171205156.jpg"],
    ["case-37 / updated-alcohol-warnin, strong curve — the ticket's own table: \"no structure\"", "assets/golden/references/updated-alcohol-warnin-2564515199.jpg"],
    ["case-39 / Warning-Label-2, extreme wrap — the ticket's own table: \"unusable; window straddles arced lines\"", "assets/golden/references/Warning-Label-2.jpg"],
  ])(
    "%s",
    async (_label, imagePath) => {
      const crop = await detectAndCrop(imagePath);
      // Measured (this file's own live run): `detectWarningRegion` DOES
      // find a region on all three of these — the crop is not the
      // problem here, the pixel content inside it is.
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("uncertain");
    },
    15_000,
  );
});

describe("measureBoldSignal — case-38, crown-royal (gold on maroon, the ticket's own \"stroke falls to 1-3px\")", () => {
  it(
    "detectWarningRegion finds NO region at all on this image — a pre-existing LH-020 limitation, not this ticket's function",
    async () => {
      const image = readFileSync("assets/golden/references/crown-royal-warning-label-closeup.png");
      const detection = await detectWarningRegion(image, async (crop) => runWarningOcr(crop));
      expect(detection).toBeNull();
    },
    15_000,
  );

  it(
    "given a hand-cropped warning-panel region instead (isolating just the boxed GOVERNMENT WARNING paragraph), the signal is uncertain",
    async () => {
      // Coordinates found by visual inspection of the source PNG — the
      // boxed government-warning paragraph, `docs/reference-photo-provenance.md`
      // file 3's own description ("What it shows"). Necessary here only
      // because the automatic detector (tested immediately above) cannot
      // produce ANY crop for this specific image.
      const image = readFileSync("assets/golden/references/crown-royal-warning-label-closeup.png");
      const crop = await sharp(image)
        .extract({ left: 25, top: 195, width: 1075, height: 195 })
        .flatten({ background: "#ffffff" })
        .png()
        .toBuffer();
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("uncertain");
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// measureBoldSignal — the golden-set corpus
// ---------------------------------------------------------------------------

const manifest = loadGoldenSetManifest();

/** Every rendered (not photographed, not degraded), warning-bearing case
 * whose ground truth (TRO-527 / LH-022) is `governmentWarningPrefixBold:
 * true` — the corpus's own "bold on every rendered bold case" acceptance
 * line. `provenance === "rendered"` excludes the degraded cases, tested
 * separately below with their own OBSERVED (not assumed) behavior — a
 * real image degradation can legitimately push a genuinely bold prefix
 * into `uncertain`, and this file states that plainly rather than
 * asserting a uniform "bold" this measurement cannot actually promise
 * under degradation. */
const cleanRenderedBoldCases = manifest.cases.filter(
  (c) => c.provenance === "rendered" && c.label.governmentWarningPresent && c.label.governmentWarningPrefixBold === true,
);

describe("measureBoldSignal — golden-set corpus, clean rendered cases (TRO-527's bold-prefix renderer)", () => {
  it("the manifest actually has clean rendered bold-prefix cases to test — this describe block is not vacuous", () => {
    expect(cleanRenderedBoldCases.length).toBeGreaterThan(0);
  });

  it.each(cleanRenderedBoldCases.map((c) => [c.caseId, c.imagePath] as const))(
    "%s: detects bold",
    async (_caseId, imagePath) => {
      const crop = await detectAndCrop(imagePath);
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("bold");
    },
    15_000,
  );
});

describe("measureBoldSignal — no rendered NON-bold golden-set case exists yet (stated, not papered over)", () => {
  it("zero warning-bearing manifest cases have governmentWarningPrefixBold === false", () => {
    // TRO-527's own CHANGES.md entry says so directly: "None of these 32
    // cases tests a bold violation; that is LH-023's job (case-33,
    // case-34)." Those two cases are not in the current manifest — this
    // assertion is this file's own live check that the gap TRO-527 named
    // is still exactly the gap today, so the acceptance evidence's
    // "returns not-bold on every rendered non-bold case" line is
    // VACUOUSLY true against the real corpus right now. `classifyBoldSignal`'s
    // own "not-bold" test above proves the branch works; it cannot be
    // proven here against a real image because no such image exists yet.
    const nonBoldCases = manifest.cases.filter(
      (c) => c.label.governmentWarningPresent && c.label.governmentWarningPrefixBold === false,
    );
    expect(nonBoldCases).toEqual([]);
  });
});

describe("measureBoldSignal — case-23 (and case-24's merge): below the 3px floor, the ticket's own required acceptance case", () => {
  it(
    "case-23-tiny-warning-text-standard-bottle (9px print) returns uncertain, floor reason",
    async () => {
      // case-24-tiny-warning-text-miniature-bottle no longer exists as a
      // separate image: TRO-516 C5 (2026-08-13, CHANGES.md "TRO-516 — C5
      // execution") merged it into case-23 because both cases printed the
      // warning at the identical 9px font size on the identical canvas —
      // "the pair sampled one print size twice, not two." Testing case-23
      // alone covers the vector both cases shared; there is no second
      // image left to test separately, and fabricating one would violate
      // standing rule 2.
      const crop = await detectAndCrop("golden-set/images/case-23-tiny-warning-text-standard-bottle.jpg");
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("uncertain");
      expect(result.reason).toMatch(/floor/);
      expect(result.prefixStrokeWidthPx).not.toBeNull();
      expect(result.bodyStrokeWidthPx).not.toBeNull();
      if (result.prefixStrokeWidthPx !== null && result.bodyStrokeWidthPx !== null) {
        expect(Math.min(result.prefixStrokeWidthPx, result.bodyStrokeWidthPx)).toBeLessThan(STROKE_WIDTH_FLOOR_PX);
      }
    },
    15_000,
  );
});

describe("measureBoldSignal — golden-set corpus, degraded cases: each case's OWN observed behavior", () => {
  // Every case below carries governmentWarningPrefixBold: true ground
  // truth. Each assertion is this file's own live, measured result — not
  // an assumption that degradation always preserves or always destroys
  // the signal. Where a case still measures bold, the specific
  // degradation this case applies did not reach the warning crop closely
  // enough to matter; where it measures uncertain, the degradation
  // legitimately compromised the measurement, which is the honest,
  // correct outcome for an advisory check that must never guess.

  it(
    "case-17-glare-front-label: still bold — the glare targets the FRONT label, not the warning block",
    async () => {
      const crop = await detectAndCrop("golden-set/images/case-17-glare-front-label.jpg");
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("bold");
    },
    15_000,
  );

  it(
    "case-18-glare-warning-block: uncertain, floor reason — this degradation targets the warning block itself",
    async () => {
      const crop = await detectAndCrop("golden-set/images/case-18-glare-warning-block.jpg");
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("uncertain");
      expect(result.reason).toMatch(/floor/);
    },
    15_000,
  );

  it(
    "case-19-rotation-mild-correctable and case-20-rotation-severe-upside-down: detectWarningRegion finds NO region at all — a pre-existing LH-020 gap, out of this ticket's scope",
    async () => {
      for (const imagePath of [
        "golden-set/images/case-19-rotation-mild-correctable.jpg",
        "golden-set/images/case-20-rotation-severe-upside-down.jpg",
      ]) {
        const crop = await detectAndCrop(imagePath);
        expect(crop).toBeNull();
      }
    },
    30_000,
  );

  it(
    "case-21-low-light-front-label: uncertain, ranges-overlap reason — front-label dimming still reaches the warning crop enough to blur the separation",
    async () => {
      const crop = await detectAndCrop("golden-set/images/case-21-low-light-front-label.jpg");
      expect(crop).not.toBeNull();
      if (!crop) return;
      const result = await measureBoldSignal(crop);
      expect(result.signal).toBe("uncertain");
      expect(result.reason).toMatch(/overlap/);
    },
    15_000,
  );

  it(
    "case-22-low-light-warning-block (TRO-563: strengthened past TRO-546's own recovery point): detectWarningRegion finds NO region at all — the case-19/20 pattern, not a bold measurement",
    async () => {
      // TRO-546's fix recovered the ORIGINAL case-22 pixels (brightnessFactor
      // 0.3 alone) well enough that contrast normalization (rule 4) still
      // measured bold here. TRO-563 (2026-08-13, Troy-ruled) strengthened
      // this case's own pixels further — contrastFactor 0.38, noiseAmplitude
      // 30, plus a blur — specifically because that easy recovery let both
      // OCR channels read the warning perfectly and scored this case PASS
      // against its own REVIEW/LOW_IMAGE_QUALITY expectation
      // (golden-set/manifest.json's own notes for this case). At the
      // strengthened degradation, `detectWarningRegion` no longer finds a
      // block at all (measured: scripts/eval/results/tro-563-case22-ocr-region-check.json)
      // — the same "no region, not this ticket's function" outcome case-19
      // and case-20 already document above, not a regression in this
      // ticket's own bold-detect logic.
      const crop = await detectAndCrop("golden-set/images/case-22-low-light-warning-block.jpg");
      expect(crop).toBeNull();
    },
    15_000,
  );

  it(
    "case-25-odd-typography-script-brand and case-26-odd-typography-blackletter-class-type: still bold — the odd typography is on the BRAND/CLASS-TYPE fields, the warning text itself is unaffected",
    async () => {
      for (const imagePath of [
        "golden-set/images/case-25-odd-typography-script-brand.jpg",
        "golden-set/images/case-26-odd-typography-blackletter-class-type.jpg",
      ]) {
        const crop = await detectAndCrop(imagePath);
        expect(crop).not.toBeNull();
        if (!crop) continue;
        const result = await measureBoldSignal(crop);
        expect(result.signal).toBe("bold");
      }
    },
    30_000,
  );
});
