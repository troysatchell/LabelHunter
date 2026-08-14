/**
 * Ground-truth schema for the golden set (TRO-458 / LH-003, TH-R12).
 *
 * The golden set is a fixed collection of label test cases. Each case
 * records two things: what the application form says, and what a careful
 * human reader sees on the label image. The eval harness (a later ticket)
 * compares the Haiku extractor and the Validation Router against this
 * ground truth to score extraction accuracy and verdict accuracy (PRD §6).
 *
 * Field names and verdict vocabulary match PRD §3.2 (extractor output:
 * value/evidence/confidence) and §3.3 (field verdict MATCH/MISMATCH/
 * NEEDS_REVIEW, label verdict PASS/FAIL/REVIEW, the `ReviewReason` enum).
 *
 * `imagePath` resolves to a real committed file for every `rendered` /
 * `rendered+degraded` case (TRO-497 / LH-004). A future `ai-generated` case
 * (LH-005, none exist yet) starts imageless until that ticket adds one. See
 * `golden-set/README.md` for the naming convention.
 */

/** The three beverage types the app supports (PRD §2, §5). */
export type BeverageType = "beer" | "wine" | "spirits";

/** Per-field verdict the Validation Router assigns (PRD §3.3). */
export type FieldVerdict = "MATCH" | "MISMATCH" | "NEEDS_REVIEW";

/** Label-level verdict the Validation Router assigns (PRD §3.3). */
export type LabelVerdict = "PASS" | "FAIL" | "REVIEW";

/**
 * Why the router escalates a label to the Sonnet resolver (PRD §3.3).
 * Present on a case only when `expected.labelVerdict` is `"REVIEW"`.
 */
export type ReviewReason =
  | "LOW_IMAGE_QUALITY"
  | "AMBIGUOUS_BRAND"
  | "AMBIGUOUS_ABV"
  | "AMBIGUOUS_NET_CONTENTS"
  | "WARNING_MISMATCH"
  | "MISSING_REQUIRED_FIELD"
  | "CONFLICTING_EXTRACTION"
  | "LOW_MODEL_CONFIDENCE";

/**
 * The twelve required test categories (PRD §6). Every golden-set case
 * belongs to exactly one. `case-variant-brand` covers the STONE'S THROW
 * judgment call (TH-R8); `title-case-warning` covers Jenny's real catch
 * (TH-R9).
 */
export type GoldenSetCategory =
  | "clean-match"
  | "abv-mismatch"
  | "title-case-warning"
  | "reworded-warning"
  | "missing-warning"
  | "case-variant-brand"
  | "glare"
  | "rotation"
  | "low-light"
  | "tiny-warning-text"
  | "odd-typography"
  | "conflicting-application-vs-label";

/** The five example fields as filed on the application (PRD §2, TH-R11). */
export interface GoldenApplicationFields {
  brandName: string;
  classType: string;
  /**
   * Percent ABV as filed on the application. Omitted where the beverage
   * type makes ABV optional on the application (PRD §2 — e.g. some beers).
   */
  abvPercent?: number;
  netContentsValue: number;
  /** Unit as filed, e.g. "mL", "L", "fl oz". */
  netContentsUnit: string;
}

/** The five example fields as a careful human reader sees them on the label (PRD §2, TH-R11). */
export interface GoldenLabelFields {
  brandName: string;
  classType: string;
  /** True when the label prints an alcohol-content statement at all. */
  abvPresent: boolean;
  /** Verbatim as printed, e.g. "45% Alc./Vol. (90 Proof)". Empty string when `abvPresent` is false. */
  abvText: string;
  /** Percent ABV a correct extractor should parse out of `abvText`. Omitted when `abvPresent` is false. */
  abvPercent?: number;
  /** Proof as printed, when the label states it. Spirits only. */
  proof?: number;
  /** Verbatim as printed, e.g. "750 mL". */
  netContentsText: string;
  netContentsValue: number;
  netContentsUnit: string;
  /** True when the government warning block appears anywhere on the label. */
  governmentWarningPresent: boolean;
  /** Verbatim transcription of the warning block as printed. Empty string when `governmentWarningPresent` is false. */
  governmentWarningText: string;
  /** True when "GOVERNMENT WARNING:" is printed all-caps, as the statute requires (TH-R9). False (including when the warning is absent) otherwise. */
  governmentWarningPrefixAllCaps: boolean;
  /**
   * True when "GOVERNMENT WARNING:" (the prefix, through the colon) prints
   * in bold type, as 27 CFR 16.22(a)(2) requires (TH-R9; TRO-527 / LH-022).
   * False (including when the warning is absent) when it does not.
   * `"unknown"` records a real photograph where a careful human reader
   * cannot tell either way — never `false` there, because `false` would be
   * a fabricated compliance claim against a shipped product. Every case in
   * this manifest is a rendered image this repo controls, so none of them
   * needs `"unknown"` yet; LH-024's hand-transcribed real-label cases will.
   */
  governmentWarningPrefixBold: boolean | "unknown";
  /**
   * True when the warning body (everything after the prefix's colon)
   * prints in bold type. 27 CFR 16.22(a)(2) forbids this — a compliant
   * label is `false` here. Same `false`-including-absent and `"unknown"`
   * rules as `governmentWarningPrefixBold` above (TRO-527 / LH-022).
   */
  governmentWarningBodyBold: boolean | "unknown";
}

/** The Validation Router's expected verdict for one field. */
export interface GoldenFieldExpectation {
  verdict: FieldVerdict;
  /** One-line reason a human reads in the UI (PRD §3.3 — never a bare confidence number). */
  reason: string;
}

/** The full expected Validation Router output for one case. */
export interface GoldenExpectedResult {
  labelVerdict: LabelVerdict;
  /** Required when `labelVerdict` is `"REVIEW"`; absent otherwise. */
  reviewReason?: ReviewReason;
  fields: {
    brandName: GoldenFieldExpectation;
    classType: GoldenFieldExpectation;
    abv: GoldenFieldExpectation;
    netContents: GoldenFieldExpectation;
    governmentWarning: GoldenFieldExpectation;
  };
}

/**
 * The three photographic conditions Gemini generates for the
 * realistic-corpus track (design doc §3,
 * docs/design/2026-08-11-realistic-corpus-gemini-design.md).
 * Baked into the generation prompt itself, not a `degrade.ts` transform —
 * these are properties of the Gemini-generated photo, not a deterministic
 * sharp filter applied afterward.
 */
export type CameraCondition = "steady" | "motion-blur" | "camera-shake";

/**
 * How a case's image will be produced. See
 * `docs/design/2026-08-10-golden-label-image-gen-design.md` §2 —
 * the render-first hybrid: a spec-driven renderer guarantees exact text,
 * Imagen adds realism only where exact text does not matter.
 */
/**
 * `"photographed"` (TRO-529 / LH-024): a real camera photograph of a real,
 * physical label — not code, not a model. This is the fourth PRODUCTION
 * METHOD, distinct from the three above by what held the camera or the
 * pen: `"rendered"`/`"rendered+degraded"` are HTML/CSS a script drew;
 * `"ai-generated"`/`"rendered+ai-backdrop"` are pixels a generative model
 * predicted; `"photographed"` is neither — a person pointed a camera at an
 * actual bottle. Ground truth for a `"photographed"` case comes from a
 * human transcribing what the photograph shows (`verified` stays `false`
 * until Troy confirms the transcription — see `GoldenSetCase.verified`),
 * never from a spec the image is checked against. `governmentWarningPrefixBold`
 * / `governmentWarningBodyBold`'s `"unknown"` state (TRO-527 / LH-022)
 * exists for exactly this provenance: a real photograph often cannot
 * support a bold/not-bold call either way.
 *
 * Committed at its own original filename under `assets/golden/references/`
 * (`docs/reference-photo-provenance.md`) rather than copied into
 * `golden-set/images/<caseId>.<ext>` — that naming convention (this file's
 * own comment on `imagePath`) presumes a file `build.ts` produced FROM the
 * case; a `"photographed"` case's file predates its case and IS the
 * forensic evidence, so keeping its own name is the more honest record.
 * `src/lib/golden-set/loader.ts`'s `checkCase` enforces a different,
 * provenance-scoped `imagePath` convention for this value.
 */
export type GoldenSetProvenance =
  | "rendered"
  | "rendered+degraded"
  | "ai-generated"
  | "rendered+ai-backdrop"
  | "photographed";

/**
 * The five transforms `scripts/golden/degrade.ts` can apply to a clean
 * rendered base (design doc §4, TRO-497 / LH-004). A tiny-print or
 * unusual-font case is a render-time choice, not one of these — see that
 * script's comments.
 */
export type DegradationType =
  | "rotate"
  | "perspective"
  | "glare"
  | "low-light"
  | "blur";

/**
 * One transform applied to a case's clean rendered base, with the exact
 * parameters `degrade.ts` used — recorded here so the degraded image is
 * reproducible from the spec alone (design doc §3's `degradations` field).
 * `params` values are deliberately loose (`number | string`) because each
 * `DegradationType` takes a different parameter shape; `degrade.ts` is the
 * schema of record for what each type expects.
 */
export interface Degradation {
  type: DegradationType;
  params: Record<string, number | string>;
}

/** One 2D point, in the pixel space of a committed backdrop image. */
export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/**
 * The 4 corners of the blank label region a `rendered+ai-backdrop` case's
 * backdrop photo carries, as either `blankRegionDetector.ts` found them or
 * a human recorded them by hand (design doc §5). `build.ts` warps the
 * renderer's label into this exact quad on every rebuild — recording it
 * here, not re-detecting it at build time, is what keeps `build.ts`
 * network-free and deterministic even though the backdrop photo itself
 * was not.
 */
export interface LabelPlacementQuad {
  readonly topLeft: Point2D;
  readonly topRight: Point2D;
  readonly bottomLeft: Point2D;
  readonly bottomRight: Point2D;
}

/**
 * Forensic record of how a `rendered+ai-backdrop` case's backdrop photo
 * was generated — which model, at what resolution, with which prompt
 * template version, and when. Not a reproducibility claim (design doc
 * §6/§10): re-running generation will not produce the same bytes. This
 * lets anyone looking at a committed image later understand why it looks
 * the way it does.
 */
export interface GenerationMetadata {
  readonly model: string;
  readonly resolution: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
}

/**
 * A rubric completion vector this case provides evidence for
 * (`audit/rubric.md`, Appendix A: V1–V10). A case may cover zero, one, or
 * several. `V7` and `V10` are not yet covered by any case in this manifest —
 * see `golden-set/README.md`.
 */
export type RubricVector =
  | "V1" | "V2" | "V3" | "V4" | "V5"
  | "V6" | "V7" | "V8" | "V9" | "V10";

/**
 * One golden-set test case: an application record, the label ground truth,
 * the router's expected verdict, and a pointer to the label image.
 */
export interface GoldenSetCase {
  /** Unique, kebab-case, e.g. "case-14-case-variant-brand-stones-throw". */
  caseId: string;
  /** One line, plain language, explains what the case tests. */
  description: string;
  category: GoldenSetCategory;
  beverageType: BeverageType;
  /**
   * Path to the label image, relative to the repo root, e.g.
   * "golden-set/images/case-14-case-variant-brand-stones-throw.jpg". A real
   * committed file for every `rendered` / `rendered+degraded` case
   * (TRO-497 / LH-004); see `golden-set/README.md`. The loader checks the
   * naming convention, never that the file exists — that check lives in
   * `scripts/golden/images.test.ts`, scoped to non-`ai-generated` cases.
   * A `provenance: "photographed"` case (TRO-529 / LH-024) follows a
   * DIFFERENT convention: `"assets/golden/references/<original-filename>"`,
   * not `golden-set/images/<caseId>`. See `GoldenSetProvenance`'s own
   * comment for why, and `loader.ts`'s `checkCase` for the enforced rule.
   */
  imagePath: string;
  /** How the image was (or, for a future ai-generated case, will be) produced. */
  provenance: GoldenSetProvenance;
  /**
   * `true` only once a real image exists AND a human has confirmed it
   * actually shows what this spec claims. Required `true` before the eval
   * harness may use a `provenance: "ai-generated"` case (design doc §3) —
   * an AI-generated image can silently fail to render the exact text its
   * spec asserts. Every case in this manifest is `false`; no images exist
   * yet.
   */
  verified: boolean;
  /** Rubric vectors (`audit/rubric.md` Appendix A) this case is evidence for. May be empty. */
  vectors: RubricVector[];
  application: GoldenApplicationFields;
  label: GoldenLabelFields;
  expected: GoldenExpectedResult;
  /**
   * The `degrade.ts` transforms applied to this case's clean rendered base,
   * in application order. Present only on a `provenance: "rendered+degraded"`
   * case whose imperfection is a photo condition (glare, rotation, low
   * light) rather than a render-time print choice (tiny text, an unusual
   * font) — see `scripts/golden/degrade.ts`'s module comment. Absent or
   * empty otherwise.
   */
  degradations?: Degradation[];
  /**
   * The bottle reference JSON (`assets/golden/references/<id>.json`) this
   * case's backdrop was generated from. Present only on a
   * `rendered+ai-backdrop` case (design doc §6).
   */
  referenceBottle?: string;
  /** The `sceneId` (from the bottle reference's `scenes` list) this case's backdrop used. Present only on a `rendered+ai-backdrop` case. */
  scene?: string;
  /** The photographic condition Gemini generated this case's backdrop under. Present only on a `rendered+ai-backdrop` case. */
  cameraCondition?: CameraCondition;
  /** Where on the backdrop the renderer's label gets composited. Present only on a `rendered+ai-backdrop` case. */
  labelPlacement?: LabelPlacementQuad;
  /** How this case's backdrop was generated — forensic, not reproducible. Present only on a `rendered+ai-backdrop` case. */
  generationMetadata?: GenerationMetadata;
  /** Optional context: why this case is shaped the way it is, notes for whoever generates the image. */
  notes?: string;
}

/** The full golden-set manifest: a schema version plus every case. */
export interface GoldenSetManifest {
  /** Manifest schema version, semver, e.g. "1.0.0". Bump on a breaking shape change. */
  version: string;
  cases: GoldenSetCase[];
}
