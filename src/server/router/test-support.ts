/**
 * Placeholder field comparators for this ticket's own tests (LH-012 /
 * TRO-462).
 *
 * These are NOT the real judgment logic. LH-013 (TRO-463) replaces them
 * with real normalization (Unicode NFKC, casefold, apostrophe folding,
 * diacritic stripping), fuzzy brand/class-type matching, ABV parsing, ABV↔
 * proof arithmetic, and net-contents parsing, each verified against a
 * ttb.gov-cited standard. `placeholderTextComparator` only checks exact
 * equality after a trim and a casefold — `STONE'S THROW` vs `Stone's
 * Throw`, TH-R8's named case, would NOT match here; that judgment is
 * exactly what LH-013 is for. `placeholderAbvComparator` and
 * `placeholderNetContentsComparator` reuse this router's own PROVISIONAL
 * numeric parser (`provisional-numeric.ts`) — itself a stand-in, not
 * LH-013's real grammar.
 *
 * Not a `*.test.ts` file — vitest only collects files matching that
 * pattern, so this module carries no test cases and never runs on its own.
 */
import { WELL_FORMED_EXTRACTION_BODY } from "../extractor/test-support";
import type { ExtractedField, HaikuExtractionResult } from "../extractor/types";
import { convertNetContentsToMl, provisionalParseAbv, provisionalParseNetContents } from "./provisional-numeric";
import type {
  ApplicationRecord,
  ComparatorContext,
  ComparatorResult,
  FieldComparator,
  FieldComparators,
  PreprocessingSignal,
  WarningComparatorResult,
} from "./types";

function normalizeTrivially(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Exact match after a trim and a casefold — nothing more. Never returns
 * `MISMATCH` (PRD §3.3: "distance beyond threshold → REVIEW, never silent
 * FAIL" — a placeholder respects this structural rule even though it does
 * no real fuzzy matching).
 */
export const placeholderTextComparator: FieldComparator = (
  extracted: ExtractedField,
  applicationValue: string | number,
  _context: ComparatorContext,
): ComparatorResult => {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }
  const matches = normalizeTrivially(extracted.value) === normalizeTrivially(String(applicationValue));
  return matches
    ? { verdict: "MATCH" }
    : { verdict: "NEEDS_REVIEW", note: "The label and application text differ; a placeholder comparator cannot judge how much." };
};

/**
 * Parses both sides with this router's own provisional ABV grammar and
 * compares the percent. Falls back to `NEEDS_REVIEW` — never `MISMATCH` —
 * when either side does not parse, for the same TH-R8 structural reason as
 * the text placeholder above.
 */
export const placeholderAbvComparator: FieldComparator = (extracted, applicationValue, _context): ComparatorResult => {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }
  const labelPercent = provisionalParseAbv(extracted.value).percent;
  const applicationPercent = typeof applicationValue === "number" ? applicationValue : null;
  if (labelPercent === null || applicationPercent === null) {
    return { verdict: "NEEDS_REVIEW", note: "Could not parse an alcohol percent to compare." };
  }
  return Math.abs(labelPercent - applicationPercent) < 0.001
    ? { verdict: "MATCH" }
    : { verdict: "NEEDS_REVIEW", note: "The label and application alcohol percent differ." };
};

/** Parses both sides with the provisional net-contents grammar, converts to
 * mL, and compares. Same NEEDS_REVIEW-not-MISMATCH placeholder policy. */
export const placeholderNetContentsComparator: FieldComparator = (extracted, applicationValue, _context): ComparatorResult => {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }
  const labelParsed = provisionalParseNetContents(extracted.value);
  const applicationParsed =
    typeof applicationValue === "string" ? provisionalParseNetContents(applicationValue) : null;
  if (!labelParsed || !applicationParsed) {
    return { verdict: "NEEDS_REVIEW", note: "Could not parse net contents to compare." };
  }
  const labelMl = convertNetContentsToMl(labelParsed);
  const applicationMl = convertNetContentsToMl(applicationParsed);
  return Math.abs(labelMl - applicationMl) < 0.5
    ? { verdict: "MATCH" }
    : { verdict: "NEEDS_REVIEW", note: "The label and application net contents differ." };
};

/** The four placeholder comparators, bundled into the shape `routeLabel`
 * expects — convenience for an integration test that exercises the whole
 * router, not a claim that this bundle is production-ready. */
export const placeholderComparators: FieldComparators = {
  brand_name: placeholderTextComparator,
  class_type: placeholderTextComparator,
  alcohol_content: placeholderAbvComparator,
  net_contents: placeholderNetContentsComparator,
};

/**
 * A well-formed extraction, deep-cloned per call so a test can mutate the
 * result safely. Reuses the extractor's own well-formed fixture (LH-011,
 * `../extractor/test-support.ts`) instead of duplicating one — both
 * tickets describe the same `HaikuExtractionResult` shape, and drift
 * between two hand-maintained copies would be its own bug.
 */
export function makeExtraction(overrides: Partial<HaikuExtractionResult> = {}): HaikuExtractionResult {
  const base = structuredClone(WELL_FORMED_EXTRACTION_BODY) as HaikuExtractionResult;
  return { ...base, ...overrides };
}

/** An application record matching `makeExtraction`'s default values — a
 * label that reads clean should route to a clean PASS by default. */
export function makeApplication(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    beverageType: "spirits",
    brandName: "Old Tom Distillery",
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: 45,
    netContentsValue: 750,
    netContentsUnit: "mL",
    ...overrides,
  };
}

/** A preprocessing signal for a normal, decodable, well-sized image. */
export function makePreprocessing(overrides: Partial<PreprocessingSignal> = {}): PreprocessingSignal {
  return { rejected: false, longEdgePx: 1568, ...overrides };
}

/** A clean government-warning comparator result — CP-1 §5.3's PASS row. */
export const CLEAN_WARNING_RESULT: WarningComparatorResult = { verdict: "MATCH" };
