/**
 * Golden-set image degradations (TRO-497 / LH-004, design doc §2
 * `degrade.ts`, §4).
 *
 * Takes one clean rendered label (`render.ts`'s output) and derives an
 * imperfect-photo variant: rotate, perspective, glare, low light, or blur.
 * Every transform is a pure function over image bytes plus explicit
 * parameters — no randomness, no clock, no network — so the same input
 * produces the same output bytes every run (`build.ts`'s determinism
 * contract, LH-006's future CI smoke).
 *
 * Ground truth never changes here. A degraded case's `label` fields still
 * describe exactly what is printed on the label; only the photo condition
 * changes. That is the whole point of deriving variants from a clean base
 * (design doc §1) rather than re-authoring a spec per photo defect.
 *
 * Tiny warning text and an unusual brand/class-type font are NOT here.
 * Both are print choices, not photo conditions, and `render.ts` bakes them
 * into the clean base directly (see its `CASE_STYLE_OVERRIDES`). This file
 * covers only the five transforms design doc §4 names.
 */
import sharp from "sharp";
import {
  clampRegionToBounds,
  type PixelRegion,
} from "../../src/server/preprocessing/region";
import type { Degradation, DegradationType } from "../../src/lib/golden-set/types";
import { CANVAS_HEIGHT, CANVAS_WIDTH, LABEL_REGIONS } from "./render";

type RegionName = keyof typeof LABEL_REGIONS;

/**
 * Validates a value is a finite number before it reaches sharp. CLAUDE.md
 * rule 13: a prior ticket shipped a NaN-clamp bug exactly at a sharp
 * boundary like this one, so every numeric degradation parameter is
 * checked explicitly here rather than trusted from a manifest file.
 */
function assertFiniteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `degrade: "${name}" must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertRegionName(value: unknown): RegionName {
  if (typeof value !== "string" || !(value in LABEL_REGIONS)) {
    throw new RangeError(
      `degrade: "region" must be one of ${Object.keys(LABEL_REGIONS).join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as RegionName;
}

function regionFor(name: RegionName): PixelRegion {
  // Named regions are baked-in constants from render.ts's fixed layout, but
  // still run through clampRegionToBounds — the same defensive clamp
  // pipeline.ts uses for a detector-supplied box — so a future canvas-size
  // change can never silently hand sharp an out-of-bounds `.extract()`
  // request.
  return clampRegionToBounds(LABEL_REGIONS[name], CANVAS_WIDTH, CANVAS_HEIGHT);
}

/**
 * A region-targeted transform (`applyGlare`, `applyLowLight`) trusts
 * `LABEL_REGIONS`'s coordinates, which are only valid against the
 * original, unrotated `CANVAS_WIDTH` x `CANVAS_HEIGHT` canvas. Chaining a
 * geometric transform first (`applyRotate`, `applyPerspective`) changes the
 * canvas size and moves every pixel, so a region name would silently land
 * on the wrong content instead of failing. No committed case combines them
 * today, but this check turns a future silent-wrong-pixels bug into a
 * loud, explicit one — CLAUDE.md rule 13's "check explicitly."
 */
async function assertMatchesOriginalCanvas(image: Buffer): Promise<void> {
  const metadata = await sharp(image).metadata();
  if (metadata.width !== CANVAS_WIDTH || metadata.height !== CANVAS_HEIGHT) {
    throw new RangeError(
      `degrade: a region-targeted transform requires an image at the original ` +
        `${CANVAS_WIDTH}x${CANVAS_HEIGHT} canvas size, got ${metadata.width}x${metadata.height} — ` +
        `LABEL_REGIONS coordinates are only valid before any geometric transform (rotate/perspective) has run`,
    );
  }
}

/**
 * Rotates the whole image by `angleDegrees` (positive is clockwise). The
 * canvas expands to fit the rotated content; new corners fill with white,
 * matching the label's own background — never sharp's black default (the
 * same reasoning `pipeline.ts` documents for its own `.flatten()` calls).
 */
export async function applyRotate(
  image: Buffer,
  params: { readonly angleDegrees: unknown },
): Promise<Buffer> {
  const angleDegrees = assertFiniteNumber("angleDegrees", params.angleDegrees);
  return sharp(image).rotate(angleDegrees, { background: "#ffffff" }).toBuffer();
}

/**
 * Gaussian-blurs the whole image. `sigma` follows sharp's own scale
 * (approximately the blur's standard deviation in pixels, sharp requires
 * 0.3–1000); a high sigma pushes the image toward unreadable — rubric V9
 * ("blurry/unreadable label image").
 */
export async function applyBlur(
  image: Buffer,
  params: { readonly sigma: unknown },
): Promise<Buffer> {
  const sigma = assertFiniteNumber("sigma", params.sigma);
  if (sigma < 0.3 || sigma > 1000) {
    throw new RangeError(`degrade: "sigma" must be in [0.3, 1000], got ${sigma}`);
  }
  return sharp(image).blur(sigma).toBuffer();
}

/**
 * Approximates a keystone/perspective camera angle with a 2D affine shear.
 * sharp has no true 4-corner projective warp; a real perspective transform
 * needs a per-pixel remap this repo has no dependency for, and the ticket's
 * bar ("add a dependency only if genuinely needed") is not met by a
 * synthetic test fixture. `shear` is the horizontal shear factor (e.g. 0.15
 * leans the top edge right relative to the bottom). No committed golden-set
 * case currently uses this transform; it is implemented and unit-tested as
 * a capability per design doc §4, ready for the next case that needs it.
 */
/**
 * Bound on `shear`'s magnitude. A shear this large already skews a label
 * far past anything a real camera angle produces; sharp's `.affine()` has
 * no upper limit of its own, and an unbounded shear on a wide canvas would
 * silently balloon the output width toward `.affine()`'s internal limits —
 * rule 13's "in-bounds" half, not just "finite".
 */
const MAX_SHEAR_MAGNITUDE = 3;

export async function applyPerspective(
  image: Buffer,
  params: { readonly shear: unknown },
): Promise<Buffer> {
  const shear = assertFiniteNumber("shear", params.shear);
  if (Math.abs(shear) > MAX_SHEAR_MAGNITUDE) {
    throw new RangeError(
      `degrade: "shear" must be in [-${MAX_SHEAR_MAGNITUDE}, ${MAX_SHEAR_MAGNITUDE}], got ${shear}`,
    );
  }
  return sharp(image)
    .affine([1, shear, 0, 1], { background: "#ffffff" })
    .toBuffer();
}

/**
 * Composites a bright diagonal streak over a named region, simulating
 * glare: a soft-edged white band, rotated about the region's own center,
 * wide enough to clear every corner after rotation. Built from an SVG
 * `<rect>` plus a Gaussian blur filter for the soft edge (not a linear
 * gradient rotated about the SVG origin — that anchors at a corner, not
 * the region's center, and only ever grazes one edge of the box). Same
 * input, same pixels, every run.
 */
export async function applyGlare(
  image: Buffer,
  params: {
    readonly region: unknown;
    readonly angleDegrees?: unknown;
    readonly opacity?: unknown;
  },
): Promise<Buffer> {
  await assertMatchesOriginalCanvas(image);
  const region = regionFor(assertRegionName(params.region));
  const angleDegrees = assertFiniteNumber(
    "angleDegrees",
    params.angleDegrees ?? 25,
  );
  const opacity = assertFiniteNumber("opacity", params.opacity ?? 0.85);
  if (opacity <= 0 || opacity > 1) {
    throw new RangeError(`degrade: "opacity" must be in (0, 1], got ${opacity}`);
  }

  const { width: w, height: h } = region;
  // A band this wide clears every corner of the region after rotation, for
  // any angle, without extending the SVG canvas beyond the region itself.
  const bandWidth = w + h;
  const bandHeight = h * 0.4;
  const softEdgeStdDeviation = h * 0.06;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <filter id="soften" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="${softEdgeStdDeviation}" />
      </filter>
    </defs>
    <rect
      x="${-(bandWidth - w) / 2}" y="${(h - bandHeight) / 2}"
      width="${bandWidth}" height="${bandHeight}"
      fill="white" opacity="${opacity}"
      filter="url(#soften)"
      transform="rotate(${angleDegrees} ${w / 2} ${h / 2})"
    />
  </svg>`;

  return sharp(image)
    .composite([
      { input: Buffer.from(svg), left: region.x, top: region.y, blend: "screen" },
    ])
    .toBuffer();
}

/** Mid-gray reference point for `contrastFactor` below — the exact
 * midpoint of an 8-bit channel (0-255). */
const MID_GRAY = 128;

/**
 * Deterministic pseudo-random generator (mulberry32), seeded with a fixed
 * constant. Never `Math.random()`, `Date.now()`, or any other real entropy
 * source — same seed, same output sequence, every run. `addSensorNoise`
 * below is the only caller; this keeps that function's grain field inside
 * this file's own determinism contract (module header comment, proven by
 * `degrade.test.ts`'s "byte-identical output" suite).
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return function nextRandom(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed for `addSensorNoise`'s grain field. Determinism, not
 * unpredictability, is the property that matters here, so any constant
 * works — this one has no significance beyond being fixed. */
const NOISE_SEED = 0xc0ffee;

/**
 * Composites a deterministic grayscale grain field over `regionImage`,
 * simulating a real camera sensor's noise floor — visible exactly when the
 * signal is weak, the same low-light condition `contrastFactor` (below)
 * targets. Every byte comes from `mulberry32`, clamped to a valid pixel
 * value, never `Math.random()`. `blend: "overlay"` centers the no-op point
 * at mid-gray: per the CSS/W3C overlay-blend formula, a source value of
 * exactly 128 leaves the backdrop pixel unchanged for any backdrop value,
 * so `amplitude` alone controls how far the grain pushes a pixel either
 * direction.
 */
async function addSensorNoise(
  regionImage: Buffer,
  width: number,
  height: number,
  amplitude: number,
): Promise<Buffer> {
  const nextRandom = mulberry32(NOISE_SEED);
  const channels = 3;
  const noise = Buffer.alloc(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const value = Math.min(
      255,
      Math.max(0, Math.round(MID_GRAY + (nextRandom() * 2 - 1) * amplitude)),
    );
    const offset = pixel * channels;
    noise[offset] = value;
    noise[offset + 1] = value;
    noise[offset + 2] = value;
  }
  return sharp(regionImage)
    .composite([{ input: noise, raw: { width, height, channels }, blend: "overlay" }])
    .toBuffer();
}

/**
 * Darkens a named region in place, simulating underexposure.
 * `brightnessFactor` follows sharp's `modulate` scale: 1 leaves the region
 * unchanged, below 1 darkens it.
 *
 * Two more parameters are optional and off by default — `contrastFactor: 1`,
 * `noiseAmplitude: 0` — so every existing caller (case-22's own low-light
 * degradation, and every test that omits them) takes the exact same code
 * path as before this change, byte for byte.
 *
 * `contrastFactor`, in `(0, 1]`: below 1, pulls the region's pixel values
 * toward `MID_GRAY` BEFORE the exposure scale above runs — simulating a
 * real sensor's noise floor crushing shadow and highlight detail under low
 * light, not just a proportionally darker copy of the same crisp edges
 * (measured gap: `docs/diagnostics/2026-08-12-verdict-miss-triage.md` §3D
 * — a hard-edged gray rectangle with crisp black type, not underexposure).
 *
 * `noiseAmplitude`, in `[0, 128]`: adds `addSensorNoise`'s deterministic
 * grain field at this amplitude.
 */
export async function applyLowLight(
  image: Buffer,
  params: {
    readonly region: unknown;
    readonly brightnessFactor: unknown;
    readonly contrastFactor?: unknown;
    readonly noiseAmplitude?: unknown;
  },
): Promise<Buffer> {
  await assertMatchesOriginalCanvas(image);
  const region = regionFor(assertRegionName(params.region));
  const brightnessFactor = assertFiniteNumber(
    "brightnessFactor",
    params.brightnessFactor,
  );
  if (brightnessFactor <= 0 || brightnessFactor > 1) {
    throw new RangeError(
      `degrade: "brightnessFactor" must be in (0, 1], got ${brightnessFactor}`,
    );
  }
  const contrastFactor = assertFiniteNumber("contrastFactor", params.contrastFactor ?? 1);
  if (contrastFactor <= 0 || contrastFactor > 1) {
    throw new RangeError(`degrade: "contrastFactor" must be in (0, 1], got ${contrastFactor}`);
  }
  const noiseAmplitude = assertFiniteNumber("noiseAmplitude", params.noiseAmplitude ?? 0);
  if (noiseAmplitude < 0 || noiseAmplitude > MID_GRAY) {
    throw new RangeError(`degrade: "noiseAmplitude" must be in [0, ${MID_GRAY}], got ${noiseAmplitude}`);
  }

  let regionPipeline = sharp(image).extract({
    left: region.x,
    top: region.y,
    width: region.width,
    height: region.height,
  });
  // Skipped entirely, not just called with identity coefficients, when
  // contrastFactor is 1 — an extra no-op `.linear()` call could still
  // perturb output bytes by a rounding step libvips does not promise to
  // skip, and case-22's own committed image must stay byte-identical.
  if (contrastFactor !== 1) {
    regionPipeline = regionPipeline.linear(contrastFactor, MID_GRAY * (1 - contrastFactor));
  }
  let darkenedRegion: Buffer = await regionPipeline.modulate({ brightness: brightnessFactor }).toBuffer();

  if (noiseAmplitude > 0) {
    darkenedRegion = await addSensorNoise(darkenedRegion, region.width, region.height, noiseAmplitude);
  }

  return sharp(image)
    .composite([{ input: darkenedRegion, left: region.x, top: region.y }])
    .toBuffer();
}

/**
 * Applies one recorded degradation — a manifest case's `degradations`
 * entry — to `image`, dispatching on `degradation.type`. This is the one
 * function `build.ts` calls; it never calls the individual `apply*`
 * functions directly, so a case's manifest entry is always the single
 * source of truth for what happened to its pixels.
 */
export async function applyDegradation(
  image: Buffer,
  degradation: Degradation,
): Promise<Buffer> {
  switch (degradation.type) {
    case "rotate":
      return applyRotate(image, { angleDegrees: degradation.params.angleDegrees });
    case "blur":
      return applyBlur(image, { sigma: degradation.params.sigma });
    case "perspective":
      return applyPerspective(image, { shear: degradation.params.shear });
    case "glare":
      return applyGlare(image, {
        region: degradation.params.region,
        angleDegrees: degradation.params.angleDegrees,
        opacity: degradation.params.opacity,
      });
    case "low-light":
      return applyLowLight(image, {
        region: degradation.params.region,
        brightnessFactor: degradation.params.brightnessFactor,
        contrastFactor: degradation.params.contrastFactor,
        noiseAmplitude: degradation.params.noiseAmplitude,
      });
    default: {
      const exhaustive: never = degradation.type;
      throw new RangeError(
        `degrade: unknown degradation type ${JSON.stringify(exhaustive as DegradationType)}`,
      );
    }
  }
}
