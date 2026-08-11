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
 * How a case's image will be produced. See
 * `docs/superpowers/specs/2026-08-10-golden-label-image-gen-design.md` §2 —
 * the render-first hybrid: a spec-driven renderer guarantees exact text,
 * Imagen adds realism only where exact text does not matter.
 */
export type GoldenSetProvenance = "rendered" | "rendered+degraded" | "ai-generated";

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
  /** Optional context: why this case is shaped the way it is, notes for whoever generates the image. */
  notes?: string;
}

/** The full golden-set manifest: a schema version plus every case. */
export interface GoldenSetManifest {
  /** Manifest schema version, semver, e.g. "1.0.0". Bump on a breaking shape change. */
  version: string;
  cases: GoldenSetCase[];
}
