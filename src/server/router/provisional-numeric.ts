/**
 * SUPERSEDED. LH-013 (TRO-463) replaced this file's production callers with
 * the real grammar: `../comparators/abv.ts` (ABV parsing, ABV<->proof
 * arithmetic, cited against 27 CFR 5.1) and `../comparators/net-contents.ts`
 * (net-contents parsing, closing TRO-504 item 3's multi-candidate scan).
 * `field-resolution.ts` and `overrides.ts` both import from those modules
 * now, not from here.
 *
 * The only remaining caller is `test-support.ts`'s `placeholderComparators`
 * — LH-012's (TRO-462) own router-level integration fixtures, deliberately
 * naive on purpose (see that file's docstring). This file stays only to
 * back that one placeholder; do not add a new production caller, and do not
 * extend it into real parsing logic. It is not itself part of the exact-
 * compare government-warning path.
 */

const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/;
const PROOF_PATTERN = /(\d+(?:\.\d+)?)\s*proof/i;

export interface ParsedAbv {
  percent: number | null;
  proof: number | null;
}

/** Reads a percent and/or a proof number out of free text, e.g.
 * `"45% Alc./Vol. (90 Proof)"` -> `{ percent: 45, proof: 90 }`. Either or
 * both may be `null` when the text does not contain that pattern. */
export function provisionalParseAbv(text: string): ParsedAbv {
  const percentMatch = text.match(PERCENT_PATTERN);
  const proofMatch = text.match(PROOF_PATTERN);
  return {
    percent: percentMatch ? Number(percentMatch[1]) : null,
    proof: proofMatch ? Number(proofMatch[1]) : null,
  };
}

/** The net-contents units this stand-in recognizes. TTB's real accepted set
 * (and its standards of fill) is CP-1 §5.3's own **VERIFY** — LH-013's job. */
export type ProvisionalNetContentsUnit = "ml" | "l" | "fl oz";

const UNIT_ALIASES: Record<string, ProvisionalNetContentsUnit> = {
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

export interface ParsedNetContents {
  value: number;
  unit: ProvisionalNetContentsUnit;
}

// Longest key first: a caller checks these in order and stops at the first
// match, so a shorter alias that is also a PREFIX of a longer one (e.g.
// "l" is a prefix of "liter") must be tried last, or "liter" would never
// win.
const UNIT_ALIAS_KEYS_LONGEST_FIRST = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);

/**
 * Matches `normalizedBlob` against the known unit set at its START only —
 * either the whole blob is a unit, or the unit is followed by a space (a
 * word boundary). A plain "does this blob equal a unit" check breaks on
 * real evidence, where the unit is rarely the last word on the line (e.g.
 * `"750 mL Alcohol 45%"` — the earlier, open-ended capture in
 * `provisionalParseNetContents` used to swallow "Alcohol" into the
 * candidate unit text and then fail to match anything at all).
 */
function matchUnitAtStart(normalizedBlob: string): ProvisionalNetContentsUnit | null {
  for (const key of UNIT_ALIAS_KEYS_LONGEST_FIRST) {
    if (normalizedBlob === key || normalizedBlob.startsWith(`${key} `)) {
      return UNIT_ALIASES[key];
    }
  }
  return null;
}

/** Reads a number and a recognized unit out of free text, e.g.
 * `"750 mL"` -> `{ value: 750, unit: "ml" }`. Returns `null` when no number
 * is found, or the unit is outside the small stand-in set above. Text after
 * the unit (e.g. a second field's reading, concatenated in the same
 * evidence string) does not stop the match — only text after the number
 * and before the unit does. */
export function provisionalParseNetContents(text: string): ParsedNetContents | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z. ]+)/);
  if (!match) return null;
  const value = Number(match[1]);
  const normalizedBlob = match[2]
    .toLowerCase()
    .replace(/\./g, "")
    .trim()
    .replace(/\s+/g, " ");
  const unit = matchUnitAtStart(normalizedBlob);
  if (!unit) return null;
  return { value, unit };
}

/** Provisional mL-per-unit table. Not a TTB-cited standard of fill. */
const ML_PER_UNIT: Record<ProvisionalNetContentsUnit, number> = {
  ml: 1,
  l: 1000,
  "fl oz": 29.5735,
};

export function convertNetContentsToMl(parsed: ParsedNetContents): number {
  return parsed.value * ML_PER_UNIT[parsed.unit];
}

/** Normalizes a free-typed unit string (e.g. from an application form) to
 * the stand-in unit set, or `null` when it is not one this stand-in knows. */
export function normalizeProvisionalUnit(unit: string): ProvisionalNetContentsUnit | null {
  const rawUnit = unit.toLowerCase().replace(/\./g, "").trim().replace(/\s+/g, " ");
  return UNIT_ALIASES[rawUnit] ?? null;
}
