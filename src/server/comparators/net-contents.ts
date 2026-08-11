/**
 * The real net-contents grammar and comparator (LH-013 / TRO-463, CP-1
 * §5.3 `AMBIGUOUS_NET_CONTENTS`, TH-R11).
 *
 * Replaces `../router/provisional-numeric.ts`'s `provisionalParseNetContents`
 * as this system's net-contents parser — that file's own docstring names
 * this ticket as its replacement's owner. `../router/field-resolution.ts`
 * and `../router/overrides.ts` import from here now, not from the stand-in.
 *
 * TRO-504 item 3, closed here: the stand-in stopped at the FIRST number in
 * the text and gave up if that number's trailing text was not a recognized
 * unit — `"90 Proof 750 mL"` returned `null` instead of finding `750 mL`.
 * `parseNetContents` below scans every number in the text, in order, and
 * returns the first one a recognized unit follows.
 *
 * Accepted units (mL, L, fl oz) match the golden set and the router's
 * predecessor. TTB's net-contents standards of fill (27 CFR 5.203 for
 * spirits, 27 CFR 4.72 for wine — both metric; malt beverages are not
 * subject to the same federal metric standard) are a broader regulatory
 * question this comparator does not enforce: comparing the label's stated
 * quantity to the application's is a different check than validating that
 * quantity against the legal standards-of-fill list, and the second check
 * is not this ticket's scope. Not independently re-verified beyond
 * confirming the unit vocabulary itself is the one already in use.
 */
import type { ExtractedField } from "../extractor/types";
import type { ComparatorContext, ComparatorResult } from "../router/types";

export type NetContentsUnit = "ml" | "l" | "fl oz";

export interface ParsedNetContents {
  value: number;
  unit: NetContentsUnit;
}

const UNIT_ALIASES: Record<string, NetContentsUnit> = {
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  "fl oz": "fl oz",
  floz: "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
};

// Longest key first: a shorter alias that is also a PREFIX of a longer one
// (e.g. "l" is a prefix of "liter") must be tried last, or "liter" would
// never win.
const UNIT_ALIAS_KEYS_LONGEST_FIRST = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);

/**
 * Matches `normalizedBlob` against the known unit set at its START only —
 * either the whole blob is a unit, or the unit is followed by a space (a
 * word boundary). A blob that runs two fields' text together (e.g.
 * `"ml alcohol"`) still matches "ml", because real evidence rarely puts the
 * unit last on the line.
 */
function matchUnitAtStart(normalizedBlob: string): NetContentsUnit | null {
  for (const key of UNIT_ALIAS_KEYS_LONGEST_FIRST) {
    if (normalizedBlob === key || normalizedBlob.startsWith(`${key} `)) {
      return UNIT_ALIASES[key];
    }
  }
  return null;
}

function normalizeUnitBlob(blob: string): string {
  return blob
    .toLowerCase()
    .replace(/\./g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// A comma-grouped integer part (US convention: exactly 3 digits per group,
// e.g. "1,000" or "12,345") with an optional plain decimal tail. This
// deliberately does NOT accept a comma as a decimal separator: "1,5" has no
// valid 3-digit group after the comma, so the grouping alternative fails to
// consume it, and the plain `\d+` branch matches only "1" — a US label's
// decimal point is always a period, never a comma, so a comma-decimal
// (European convention) is not silently misread as a US decimal.
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * Reads a number and a recognized unit out of free text, e.g. `"750 mL"` ->
 * `{ value: 750, unit: "ml" }`. Tries EVERY number in the text, left to
 * right, and returns the first whose immediately following text starts with
 * a recognized unit — not only the first number in the string (TRO-504 item
 * 3): `"90 Proof 750 mL"` skips "90" (followed by "Proof", not a net-
 * contents unit) and finds "750 mL". Returns `null` when no number is
 * followed by a recognized unit anywhere in the text.
 */
export function parseNetContents(text: string): ParsedNetContents | null {
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const numberText = match[0];
    const afterNumber = text.slice((match.index ?? 0) + numberText.length);
    // The trailing alphabetic/punctuation run right after this number, up
    // to (not including) the next digit — so a second number-unit pair
    // later in the same evidence string does not get glued into this blob.
    const trailingBlob = afterNumber.match(/^\s*([a-zA-Z. ]*)/)?.[1] ?? "";
    const unit = matchUnitAtStart(normalizeUnitBlob(trailingBlob));
    if (unit) {
      return { value: Number(numberText.replace(/,/g, "")), unit };
    }
  }
  return null;
}

const ML_PER_UNIT: Record<NetContentsUnit, number> = {
  ml: 1,
  l: 1000,
  "fl oz": 29.5735,
};

export function convertNetContentsToMl(parsed: ParsedNetContents): number {
  return parsed.value * ML_PER_UNIT[parsed.unit];
}

/** Normalizes a free-typed unit string (e.g. from an application form) to
 * the accepted unit set, or `null` when it is not one this grammar knows. */
export function normalizeNetContentsUnit(unit: string): NetContentsUnit | null {
  return UNIT_ALIASES[normalizeUnitBlob(unit)] ?? null;
}

/** A conversion-rounding allowance for comparing across units (CP-1 §5.3,
 * "proposed") — not yet measured against a real standard of fill. */
export const NET_CONTENTS_COMPARE_TOLERANCE_FRACTION = 0.005;

/**
 * MATCH when the label's quantity equals the application's, after unit
 * conversion, within `NET_CONTENTS_COMPARE_TOLERANCE_FRACTION`; MISMATCH
 * otherwise (golden-set case-27). NEEDS_REVIEW when either side does not
 * parse — never a fabricated verdict over a value this comparator cannot
 * read (TH-R10).
 */
export function compareNetContents(
  extracted: ExtractedField,
  applicationValue: string | number,
  _context: ComparatorContext,
): ComparatorResult {
  if (extracted.value === null) {
    return { verdict: "NEEDS_REVIEW", note: "No label value to compare." };
  }

  const labelParsed = parseNetContents(extracted.value);
  const applicationParsed = typeof applicationValue === "string" ? parseNetContents(applicationValue) : null;
  if (!labelParsed || !applicationParsed) {
    return { verdict: "NEEDS_REVIEW", note: "Could not read a net-contents value and unit to compare." };
  }

  const labelMl = convertNetContentsToMl(labelParsed);
  const applicationMl = convertNetContentsToMl(applicationParsed);
  // Equal quantities always MATCH, checked before the fraction — dividing
  // by `applicationMl` when it is 0 is defined as Infinity below so a REAL
  // difference against a zero-stated application is never silently
  // accepted, but that same Infinity would otherwise also fire when the
  // label states 0 too, where there is no difference at all (CodeRabbit
  // finding).
  const fractionDiff =
    labelMl === applicationMl ? 0 : applicationMl === 0 ? Infinity : Math.abs(labelMl - applicationMl) / applicationMl;

  if (fractionDiff <= NET_CONTENTS_COMPARE_TOLERANCE_FRACTION) {
    return { verdict: "MATCH" };
  }
  return {
    verdict: "MISMATCH",
    note: `Label states ${extracted.value.trim()}; application states ${applicationValue}.`,
  };
}
