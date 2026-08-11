/**
 * PROVISIONAL field comparators (TRO-465's stand-in for LH-013 / TRO-463).
 *
 * `routeLabel` (`index.ts`) takes a `FieldComparators` bundle as an argument
 * — it does not build one itself (see `types.ts`'s `FieldComparator` doc
 * comment). LH-013 owns the real bundle: Unicode NFKC normalization,
 * casefold, apostrophe folding, diacritic stripping, then fuzzy brand/class
 * matching (the STONE'S THROW ≡ Stone's Throw case, TH-R8); real ABV
 * parsing and ABV↔proof arithmetic; real net-contents parsing against
 * TTB's standards of fill. None of that lands here.
 *
 * This module is the minimal stand-in the Verify screen's API route
 * (`src/app/api/verify/route.ts`) wires in today, so single-label verify
 * can run end to end before LH-013 merges. It reuses this router's own
 * `provisional-numeric.ts` parser (already a documented stand-in) and adds
 * nothing beyond a trim-and-casefold text comparison.
 *
 * **The swap point.** `src/app/api/verify/route.ts` imports
 * `PROVISIONAL_FIELD_COMPARATORS` from here — the ONE place a
 * `FieldComparators` value reaches `routeLabel` in production code. When
 * LH-013 lands, that one import line changes to the real bundle; nothing
 * else in the route, the UI, or `routeLabel` itself needs to change, since
 * both bundles satisfy the same `FieldComparators` type (`types.ts`).
 *
 * Same policy as `src/server/router/test-support.ts`'s `placeholderComparators`
 * (LH-012's own router tests): never returns `MISMATCH` on its own — PRD
 * §3.3 says "distance beyond threshold → REVIEW, never silent FAIL", and a
 * comparator with no real distance metric cannot tell "close" from "far",
 * so it must not guess FAIL. That file is not reused directly here: it is
 * named and scoped as router-test-only fixtures (it pulls in the
 * extractor's own test fixtures for its `makeExtraction` helper), not a
 * module meant to ship in the production bundle a real user's request runs.
 */
import {
  convertNetContentsToMl,
  provisionalParseAbv,
  provisionalParseNetContents,
} from "./provisional-numeric";
import type { ComparatorContext, ComparatorResult, FieldComparator, FieldComparators } from "./types";

function normalizeTrivially(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Exact match after a trim and a casefold — nothing more. A case-only
 * difference (`STONE'S THROW` vs `Stone's Throw`, straight apostrophe both
 * sides) already matches here; a curly-vs-straight apostrophe, a diacritic,
 * or any real fuzzy distance does NOT — LH-013 replaces this with the real
 * normalization pipeline that handles those.
 */
export const provisionalTextComparator: FieldComparator = (
  extracted,
  applicationValue,
  _context: ComparatorContext,
): ComparatorResult => {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }
  const matches = normalizeTrivially(extracted.value) === normalizeTrivially(String(applicationValue));
  return matches
    ? { verdict: "MATCH" }
    : {
        verdict: "NEEDS_REVIEW",
        note: "The label and application text differ. A provisional comparator cannot judge how much — LH-013 replaces this with real fuzzy matching.",
      };
};

/** Parses both sides with the provisional ABV grammar and compares the
 * percent. Falls back to `NEEDS_REVIEW` — never `MISMATCH` — when either
 * side does not parse. */
export const provisionalAbvComparator: FieldComparator = (extracted, applicationValue, _context): ComparatorResult => {
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
 * mL, and compares. Same NEEDS_REVIEW-not-MISMATCH policy. */
export const provisionalNetContentsComparator: FieldComparator = (extracted, applicationValue, _context): ComparatorResult => {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }
  const labelParsed = provisionalParseNetContents(extracted.value);
  const applicationParsed = typeof applicationValue === "string" ? provisionalParseNetContents(applicationValue) : null;
  if (!labelParsed || !applicationParsed) {
    return { verdict: "NEEDS_REVIEW", note: "Could not parse net contents to compare." };
  }
  const labelMl = convertNetContentsToMl(labelParsed);
  const applicationMl = convertNetContentsToMl(applicationParsed);
  return Math.abs(labelMl - applicationMl) < 0.5
    ? { verdict: "MATCH" }
    : { verdict: "NEEDS_REVIEW", note: "The label and application net contents differ." };
};

/**
 * The bundle `src/app/api/verify/route.ts` passes to `routeLabel` today.
 * NOT the real judgment logic — see the file comment. Swap this one export
 * for LH-013's real bundle when it lands.
 */
export const PROVISIONAL_FIELD_COMPARATORS: FieldComparators = {
  brand_name: provisionalTextComparator,
  class_type: provisionalTextComparator,
  alcohol_content: provisionalAbvComparator,
  net_contents: provisionalNetContentsComparator,
};
