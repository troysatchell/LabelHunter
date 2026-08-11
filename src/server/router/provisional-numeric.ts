/**
 * PROVISIONAL numeric parsing for the alcohol-content and net-contents
 * fields (CP-1 §4.4 rule 2, §5.3 `AMBIGUOUS_ABV` / `AMBIGUOUS_NET_CONTENTS`).
 *
 * This is NOT the real parsing grammar. LH-013 (TRO-463) owns full
 * numeric-grammar-aware ABV parsing, ABV<->proof arithmetic, and net-
 * contents parsing against TTB's standards of fill, cited against ttb.gov.
 * TRO-462's brief allows a minimal stand-in here so the router can run its
 * own structural checks (self-contradiction, tolerance) without waiting on
 * LH-013 — every function below is a deliberately narrow regex reader, not
 * a grammar. LH-013 replaces this file's callers, not necessarily this file
 * itself; do not extend it into real parsing logic.
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

/** Reads a number and a recognized unit out of free text, e.g.
 * `"750 mL"` -> `{ value: 750, unit: "ml" }`. Returns `null` when no number
 * is found, or the unit is outside the small stand-in set above. */
export function provisionalParseNetContents(text: string): ParsedNetContents | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z. ]+)/);
  if (!match) return null;
  const value = Number(match[1]);
  const rawUnit = match[2]
    .toLowerCase()
    .replace(/\./g, "")
    .trim()
    .replace(/\s+/g, " ");
  const unit = UNIT_ALIASES[rawUnit];
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
