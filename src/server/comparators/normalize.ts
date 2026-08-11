/**
 * The real fuzzy-match normalizer (LH-013 / TRO-463, CP-1 §5.3
 * `AMBIGUOUS_BRAND`). Six fixed steps, in the exact order CP-1 gives:
 *
 *   1. Unicode NFKC
 *   2. casefold
 *   3. fold apostrophe variants (`'`, `` ` ``, `´`) to `'`
 *   4. strip diacritics
 *   5. collapse internal whitespace, trim ends
 *   6. drop punctuation except internal apostrophes and hyphens
 *
 * This is the JUDGMENT regime (TH-R8): brand_name and class_type only. It
 * never runs on the government warning — the exact regime is LH-020's own
 * subsystem, and CP-1 §Q11 is explicit that the two stay apart in code, with
 * no shared helpers. Do not import this module from a warning comparator.
 *
 * This is also NOT the same function as `../router/text-boundary.ts`'s
 * `normalizeForBoundaryMatch` — that one is a narrower, deliberately weaker
 * check (CP-1 §4.4 rule 2's anti-hallucination boundary test) that keeps an
 * accented and unaccented spelling distinct on purpose. This pipeline is the
 * real, full judgment normalizer CP-1 §5.3 names for MATCH-vs-REVIEW.
 */

/**
 * Step 2, the one non-ASCII mapping this pipeline adds beyond
 * `toLowerCase()`: German ß folds to "ss" (TRO-504 item 2 — `Straße` and
 * `STRASSE` name the same word; German's all-caps convention has
 * traditionally had no uppercase ß, so `toLowerCase()` alone never bridges
 * this pair). This is NOT full Unicode default case folding — it is the one
 * gap TRO-504 names, not a general case-folding library.
 */
function caseFold(text: string): string {
  return text.toLowerCase().replace(/[ßẞ]/g, "ss");
}

/**
 * Step 3: the three variants CP-1 §5.3 names (straight apostrophe,
 * backtick, acute accent) fold to the straight apostrophe. Implemented
 * exactly as quoted — not expanded to cover every Unicode apostrophe-like
 * character.
 *
 * Known, measured gap: U+2019 RIGHT SINGLE QUOTATION MARK ("Stone’s Throw",
 * a stylized apostrophe a real vision-model extraction may emit) is NOT one
 * of the three named variants, so it is not folded here — step 6 drops it
 * as ordinary punctuation instead. Measured effect: `"Stone’s Throw"`
 * against `"Stone's Throw"` scores ~0.923 similarity (`brand.ts`'s
 * `similarity.ts`), just under the 0.95 MATCH threshold — this pair routes
 * to NEEDS_REVIEW rather than a clean MATCH. See `normalize.test.ts`'s
 * pinning test for this file's own record of the gap, and this ticket's
 * final report for the open recommendation to CP-1's owner.
 */
function foldApostropheVariants(text: string): string {
  return text.replace(/[`´]/g, "'");
}

/**
 * Step 4: strips diacritics (accents) by decomposing to NFD — splitting a
 * precomposed accented letter into a base letter plus one or more combining
 * marks — then removing every combining mark (`\p{M}`, the Unicode "Mark"
 * category). This is also what makes a combining-mark accent (an NFD string
 * the caller passed in directly, rather than one this function decomposed)
 * normalize identically to its precomposed form: both paths converge on the
 * same NFD-then-strip result (TRO-504 item 1's underlying concern, for this
 * pipeline's own purpose — see `../router/text-boundary.ts` for the same
 * concern inside the narrower anti-hallucination boundary check).
 */
function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Steps 5 (and the final tidy-up after step 6): collapse runs of
 * whitespace to one space, trim the ends. */
function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Step 6: drops punctuation other than an apostrophe or a hyphen — and,
 * since the rule says "internal", also drops a leading or trailing
 * apostrophe/hyphen (the ones that are not internal to anything). Removing a
 * character outright (never replacing it with a space) is what keeps
 * `"Old Tom, Distillery"` from becoming two words fused wrong; a run of
 * whitespace this can leave behind (e.g. where a comma sat between two
 * words) is cleaned up by the final `collapseWhitespace` pass below.
 */
function dropPunctuationExceptApostropheAndHyphen(text: string): string {
  const kept = text.replace(/\p{P}/gu, (mark) => (mark === "'" || mark === "-" ? mark : ""));
  return kept.replace(/^['-]+|['-]+$/g, "");
}

/**
 * The full 6-step pipeline (plus a final whitespace tidy), CP-1 §5.3's
 * fixed order — with one documented, necessary exception: apostrophe
 * folding (step 3) runs BEFORE NFKC (step 1), not after.
 *
 * Why: Unicode NFKC's own compatibility decomposition maps U+00B4 ACUTE
 * ACCENT (`´`, one of the three named variants) to SPACE + COMBINING ACUTE
 * ACCENT — verified directly: `"´".normalize("NFKC")` returns `" ́"`,
 * not `"´"`. Run NFKC first, as CP-1's list literally orders it, and the
 * acute-accent character step 3 is supposed to fold is already gone by the
 * time step 3 runs — it silently becomes a stray space instead of an
 * apostrophe (a real bug this ticket's own tests caught: `"Stone´s Throw"`
 * normalized to `"stone s throw"`). Folding the three variants to `'`
 * first, then running NFKC on the result, reaches the documented INTENT
 * (`´` becomes `'`) without changing NFKC's behavior on anything else —
 * apostrophes and backticks are NFKC-stable either way. `escapeRegExp`-style
 * over-thinking this would be its own bug; this is the minimal reordering
 * that makes the stated rule actually work.
 */
export function normalizeForFuzzyMatch(text: string): string {
  let out = foldApostropheVariants(text); // 3, moved ahead of 1 — see above
  out = out.normalize("NFKC"); // 1
  out = caseFold(out); // 2
  out = stripDiacritics(out); // 4
  out = collapseWhitespace(out); // 5
  out = dropPunctuationExceptApostropheAndHyphen(out); // 6
  return collapseWhitespace(out); // tidy: step 6 can leave a doubled space
}
