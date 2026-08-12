/**
 * The §7.1 capitalization check (LH-020 / TRO-468, CP-2 §5.4, §7.1, TH-R9).
 *
 * Deterministic and hard-enforced (the ticket's own words): a capitalization
 * failure at any of the four checked positions is a FAIL at any edit
 * distance — the near-miss band (`wording-compare.ts`, CP-2 §5.5) never
 * applies here, because this function's result never feeds the distance
 * calculation at all. It runs on the transport-normalized, case-PRESERVING
 * candidate (CP-2 §3.3 step 3) — call it before `foldCase`, never after.
 *
 * Two different rules at four positions (CP-2 §5.4's table):
 * - `GOVERNMENT`, `WARNING`: every letter capitalized (27 CFR 16.22(a)(2)).
 * - `Surgeon`, `General`: only the initial letter capitalized (TTB's own
 *   *Checklist of Mandatory Label Information*; its Boot Camp for Brewers
 *   deck names the lower-case form a common real mistake — CP-2 §2.6).
 */

/**
 * One checked position's outcome (CP-2 §7.1's own three-row table):
 * - `"OK"`: the position conforms.
 * - `"WRONG_CASE"`: the word is right, the capitalization is not — a hard
 *   caps failure.
 * - `"WRONG_WORD"`: the word is absent or reworded — NOT a caps failure.
 *   Left for the wording/distance check (CP-2 §7.1: "a wording deviation
 *   reports as a wording deviation rather than a confusing capitalization
 *   complaint").
 */
export type CapPositionStatus = "OK" | "WRONG_CASE" | "WRONG_WORD";

export interface CapsCheckResult {
  government: CapPositionStatus;
  warning: CapPositionStatus;
  surgeon: CapPositionStatus;
  general: CapPositionStatus;
}

/**
 * Strips leading/trailing non-letter, non-number characters from one
 * token — Unicode-aware (`\p{L}\p{N}`, not `[a-z0-9]`; standing rule 20),
 * so `"General,"` compares as `"General"` and `"WARNING:"` compares as
 * `"WARNING"`. This generalizes CP-2 §7.1's specific instruction ("strip a
 * trailing colon from word 2") to all four checked positions, since
 * `Surgeon`/`General` need the same treatment for their own trailing
 * comma and the doc does not specify a narrower rule for them.
 */
function stripEdgePunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** GOVERNMENT/WARNING (27 CFR 16.22(a)(2)): every letter must be capital.
 * Exact match against the all-caps target is itself the "every letter
 * capital" check — if the word matches only after upper-casing, some
 * letter in it was not already capital. */
function checkFullyCapitalizedPosition(word: string, target: string): CapPositionStatus {
  const stripped = stripEdgePunctuation(word);
  if (stripped === target) return "OK";
  if (stripped.toUpperCase() === target) return "WRONG_CASE";
  return "WRONG_WORD";
}

/** Is the first Unicode code point of `word` an uppercase letter? Iterates
 * code points (`[...word]`), not UTF-16 code units, so this is correct for
 * a token that begins with a character outside the Basic Multilingual
 * Plane. Returns false for an empty or non-letter-initial token. */
function hasInitialCapital(word: string): boolean {
  const first = [...word][0];
  if (!first) return false;
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/**
 * Surgeon/General (TTB's own checklist, CP-2 §2.6): only the initial
 * letter must be capital — matches "SURGEON" (all caps) as well as
 * "Surgeon" (title case), since both capitalize the leading letter; only
 * a fully lower-case reading fails. Searches the WHOLE candidate for a
 * token that equals `target` case-insensitively, because a reworded
 * clause may not contain the word at all (CP-2 §7.1's third row) — this
 * is not a fixed-index check the way GOVERNMENT/WARNING is.
 */
function checkInitialCapitalPosition(tokens: readonly string[], target: string): CapPositionStatus {
  const found = tokens
    .map(stripEdgePunctuation)
    .find((token) => token.toUpperCase() === target.toUpperCase());
  if (found === undefined) return "WRONG_WORD";
  return hasInitialCapital(found) ? "OK" : "WRONG_CASE";
}

/**
 * Checks the four CP-2 §5.4 positions against a transport-normalized,
 * case-preserving candidate. Tokenizes on whitespace — `normalizeTransport`
 * has already collapsed all runs of whitespace to single spaces (rule 6),
 * so a plain split is sufficient here.
 */
export function checkCapitalPositions(normalized: string): CapsCheckResult {
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  return {
    government: checkFullyCapitalizedPosition(tokens[0] ?? "", "GOVERNMENT"),
    warning: checkFullyCapitalizedPosition(tokens[1] ?? "", "WARNING"),
    surgeon: checkInitialCapitalPosition(tokens, "Surgeon"),
    general: checkInitialCapitalPosition(tokens, "General"),
  };
}

/** True only when all four positions conform. */
export function capsCheckPasses(result: CapsCheckResult): boolean {
  return result.government === "OK" && result.warning === "OK" && result.surgeon === "OK" && result.general === "OK";
}

/** True when at least one position is a hard caps failure (`WRONG_CASE`).
 * `WRONG_WORD` does NOT count — CP-2 §7.1's third row leaves that to the
 * wording/distance check. */
export function hasAnyCapsFailure(result: CapsCheckResult): boolean {
  return (
    result.government === "WRONG_CASE" ||
    result.warning === "WRONG_CASE" ||
    result.surgeon === "WRONG_CASE" ||
    result.general === "WRONG_CASE"
  );
}

/** Structural equality — CP-2 §4.5's dual-channel agreement rule needs
 * this, not the weaker "both channels produced the same words" test:
 * `foldCase` erases exactly the property this module checks, so a
 * body-only agreement test would call an all-caps and a title-case read
 * "agreeing" (CP-2 §4.5). */
export function capsResultsEqual(a: CapsCheckResult, b: CapsCheckResult): boolean {
  return a.government === b.government && a.warning === b.warning && a.surgeon === b.surgeon && a.general === b.general;
}

/** CP-2 §7.1's cross-check target: does the derived result say the
 * `GOVERNMENT WARNING` prefix is fully capitalized? Compared against the
 * extractor's own `prefix_casing` self-report (`reconcile.ts`) — code is
 * the source of truth; the model's report is a consistency signal only. */
export function isPrefixAllCaps(result: CapsCheckResult): boolean {
  return result.government === "OK" && result.warning === "OK";
}
