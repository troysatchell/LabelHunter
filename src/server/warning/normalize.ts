/**
 * The warning subsystem's transport normalizer (LH-020 / TRO-468, CP-2
 * §5.1–§5.4, TH-R9).
 *
 * This is the EXACT regime, not the judgment regime
 * (`../comparators/normalize.ts`, TH-R8's fuzzy brand/class matcher). No
 * shared helpers between them — CP-1 §Q11, standing rule 11. This file
 * imports nothing from `../comparators/`, and nothing in `../comparators/`
 * should import from here.
 *
 * The governing principle (CP-2 §5.1): "Normalize the transport, never the
 * text." A rule belongs in `normalizeTransport` only when it removes
 * something a camera or an OCR engine added, never something a reader can
 * see printed on the label. `dropped` rules that CP-1's judgment regime
 * uses (apostrophe folding, diacritic stripping, punctuation dropping) are
 * deliberately absent here — CP-2 §5.3 gives the citation-by-citation
 * reason for each.
 */

/** Rule 2 (CP-2 §5.2): these four space characters, and only these four,
 * map to U+0020. Not the general Unicode `\p{Zs}` category — CP-2 names
 * these four specifically, and this function implements exactly what is
 * named, not a broader guess at the same intent. */
const SPACE_CHARACTERS_TO_NORMALIZE = [
  0x00a0, // NO-BREAK SPACE
  0x2007, // FIGURE SPACE
  0x202f, // NARROW NO-BREAK SPACE
  0x2009, // THIN SPACE
] as const;
const SPACE_CHARACTER_PATTERN = new RegExp(
  `[${SPACE_CHARACTERS_TO_NORMALIZE.map((code) => String.fromCharCode(code)).join("")}]`,
  "g",
);

/** Rule 3 (CP-2 §5.2): invisible-by-definition characters. Removing them
 * cannot change what a reader sees, because there is nothing to see. */
const ZERO_WIDTH_AND_SOFT_CHARACTERS = [
  0x200b, // ZERO WIDTH SPACE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (byte-order mark)
  0x00ad, // SOFT HYPHEN
] as const;
const ZERO_WIDTH_AND_SOFT_PATTERN = new RegExp(
  `[${ZERO_WIDTH_AND_SOFT_CHARACTERS.map((code) => String.fromCharCode(code)).join("")}]`,
  "g",
);

/** Rule 4 (CP-2 §5.2): a hyphen immediately followed by a line break is a
 * typesetter's wrap hyphen, not a printed one — CP-2 §5.2's proof: the
 * canonical string contains no hyphen at all (`canonical.test.ts` pins
 * this), so de-hyphenating can only ever shrink a real deviation's
 * distance, never manufacture a false match. Must run before rule 5 —
 * once a line break becomes a space, a wrap hyphen is indistinguishable
 * from a printed one. */
function dehyphenateAtLineBreaks(text: string): string {
  // Matches every line-break form rule 5 (`lineBreaksToSpace`) handles —
  // CRLF, bare LF, and bare CR (the old Mac OS 9 and earlier convention).
  // Missing the bare-CR case here, while rule 5 still collapses it,
  // would leave a `-\r`-hyphenated wrap indistinguishable from a printed
  // hyphen once rule 5 ran — the same failure mode this rule's own
  // ordering-before-rule-5 exists to prevent, just for one line-ending
  // style instead of all of them.
  return text.replace(/-(?:\r\n|\r|\n)/g, "");
}

/** Rule 5 (CP-2 §5.2): every remaining line break becomes one space — the
 * label wraps because the print column is narrow, a layout accident, not
 * statutory content. */
function lineBreaksToSpace(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** Rule 6 (CP-2 §5.2): a reader does not count spaces. Collapses runs of
 * any whitespace to one space and trims the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The six CP-2 §5.2 rules, in the fixed order the design doc specifies.
 * Case-preserving — this function never folds case (CP-2 §3.3 step 2); see
 * `foldCase` for that separate, later step. Idempotent: normalizing an
 * already-normalized string returns it unchanged.
 */
export function normalizeTransport(raw: string): string {
  let text = raw.normalize("NFC"); // rule 1 — NFC, never NFKC (CP-2 §5.2)
  text = text.replace(SPACE_CHARACTER_PATTERN, " "); // rule 2
  text = text.replace(ZERO_WIDTH_AND_SOFT_PATTERN, ""); // rule 3
  text = dehyphenateAtLineBreaks(text); // rule 4 — before rule 5
  text = lineBreaksToSpace(text); // rule 5
  text = collapseWhitespace(text); // rule 6
  return text;
}

/**
 * Full-string case fold (CP-2 §3.3 step 4 / §5.4). Runs AFTER
 * `checkCapitalPositions` (`caps.ts`), never before — folding first would
 * erase the four checked positions before they can be checked (CP-2 §3.3
 * point 1, §5.4's own edit-distance table). Plain `toLowerCase()`: the
 * canonical string is pure ASCII (`canonical.test.ts` pins this), so no
 * broader Unicode case-folding behavior is exercised by anything this
 * function is compared against — and, deliberately, no locale-specific
 * folding (e.g. the judgment regime's German ß → "ss") is added here; that
 * rule belongs to TH-R8's regime, not this one (CP-1 §Q11).
 */
export function foldCase(text: string): string {
  return text.toLowerCase();
}
