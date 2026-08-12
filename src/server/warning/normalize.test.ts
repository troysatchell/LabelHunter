/**
 * Tests for the warning subsystem's transport normalizer (LH-020 / TRO-468,
 * CP-2 §5.1–§5.4). Written before `normalize.ts` — TDD, PRD §6.
 *
 * This is the EXACT regime (TH-R9), not the judgment regime
 * (`../comparators/normalize.ts`, TH-R8). No shared helpers between them
 * (CP-1 §Q11, standing rule 11) — this file imports nothing from
 * `../comparators/`.
 *
 * Every invisible/whitespace/combining character below is built with
 * `String.fromCharCode`/`fromCodePoint` from its numeric code point, never
 * typed as a literal character in source — a literal zero-width or
 * combining character is invisible in a diff and unverifiable by eye. The
 * numeric code point is the reviewable, unambiguous form.
 */
import { describe, expect, it } from "vitest";
import { foldCase, normalizeTransport } from "./normalize";

const NBSP = String.fromCharCode(0x00a0); // NO-BREAK SPACE
const FIGURE_SPACE = String.fromCharCode(0x2007);
const NARROW_NBSP = String.fromCharCode(0x202f);
const THIN_SPACE = String.fromCharCode(0x2009);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const ZERO_WIDTH_NO_BREAK_SPACE = String.fromCharCode(0xfeff); // BOM
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const COMBINING_ACUTE_ACCENT = String.fromCharCode(0x0301);
const FULLWIDTH_A = String.fromCodePoint(0xff21);

describe("normalizeTransport — CP-2 §5.2's six rules, in order", () => {
  it("rule 1: Unicode NFC composes a decomposed character (not NFKC)", () => {
    const decomposed = `e${COMBINING_ACUTE_ACCENT}`;
    expect(normalizeTransport(decomposed)).toBe(String.fromCharCode(0x00e9)); // precomposed "é"
  });

  it("rule 1: NFC, not NFKC — a fullwidth character is NOT folded to its ASCII form", () => {
    // CP-2 §5.2: NFKC would fold fullwidth "A" (U+FF21) to ASCII "A", which
    // a reader CAN see the difference between — exactly what §5.1 forbids.
    // NFC leaves compatibility characters alone.
    expect(normalizeTransport(FULLWIDTH_A)).toBe(FULLWIDTH_A);
    expect(normalizeTransport(FULLWIDTH_A)).not.toBe("A");
  });

  it("rule 2: maps the four named space characters to U+0020", () => {
    expect(normalizeTransport(`a${NBSP}b`)).toBe("a b");
    expect(normalizeTransport(`a${FIGURE_SPACE}b`)).toBe("a b");
    expect(normalizeTransport(`a${NARROW_NBSP}b`)).toBe("a b");
    expect(normalizeTransport(`a${THIN_SPACE}b`)).toBe("a b");
  });

  it("rule 3: strips zero-width and soft characters", () => {
    expect(normalizeTransport(`GOVERN${ZERO_WIDTH_SPACE}MENT`)).toBe("GOVERNMENT");
    expect(normalizeTransport(`${ZERO_WIDTH_NO_BREAK_SPACE}GOVERNMENT`)).toBe("GOVERNMENT");
    expect(normalizeTransport(`GOVERN${SOFT_HYPHEN}MENT`)).toBe("GOVERNMENT");
  });

  it("rule 4: de-hyphenates a hyphen immediately followed by a line break", () => {
    expect(normalizeTransport("alcoholic bever-\nages")).toBe("alcoholic beverages");
    expect(normalizeTransport("alcoholic bever-\r\nages")).toBe("alcoholic beverages");
  });

  it("rule 4 also fires on a hyphen followed by a bare CR — every line-break form rule 5 handles", () => {
    expect(normalizeTransport("alcoholic bever-\rages")).toBe("alcoholic beverages");
  });

  it("rule 4 does not fire on a hyphen that is not at a line break", () => {
    expect(normalizeTransport("a well-known fact")).toBe("a well-known fact");
  });

  it("rule 4 runs before rule 5 — a hyphenated wrap is indistinguishable from a printed hyphen otherwise", () => {
    // If line-breaks-to-space ran first, "bever-\nages" would become
    // "bever- ages", and de-hyphenation could no longer tell a wrap hyphen
    // from a printed one (CP-2 §3.3 point 2).
    expect(normalizeTransport("bever-\nages")).toBe("beverages");
    expect(normalizeTransport("bever-\nages")).not.toBe("bever- ages");
  });

  it("rule 5: line breaks become a single space", () => {
    expect(normalizeTransport("line one\nline two")).toBe("line one line two");
    expect(normalizeTransport("line one\r\nline two")).toBe("line one line two");
    expect(normalizeTransport("line one\rline two")).toBe("line one line two");
  });

  it("rule 6: collapses runs of whitespace and trims the ends", () => {
    expect(normalizeTransport("  GOVERNMENT    WARNING  ")).toBe("GOVERNMENT WARNING");
  });

  it("preserves case — this function never folds case (CP-2 §3.3 step 2)", () => {
    expect(normalizeTransport("Government Warning")).toBe("Government Warning");
    expect(normalizeTransport("GOVERNMENT WARNING")).toBe("GOVERNMENT WARNING");
  });

  it("preserves punctuation — colons, parentheses, commas, and periods are not touched", () => {
    const text = "GOVERNMENT WARNING: (1) According to the Surgeon General, women.";
    expect(normalizeTransport(text)).toBe(text);
  });
});

describe("normalizeTransport — CP-2 §5.6 worked examples", () => {
  it("a label that wraps across several lines normalizes to one line", () => {
    const raw =
      "GOVERNMENT WARNING: (1)\nAccording to the\nSurgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    expect(normalizeTransport(raw)).toBe(
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    );
  });

  it("a label that hyphenates 'beverages' at a line wrap rejoins it", () => {
    const raw =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic bever-\nages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";
    expect(normalizeTransport(raw)).toBe(
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    );
  });
});

describe("foldCase — CP-2 §5.4: full-string case fold used AFTER the caps check", () => {
  it("lowercases the whole string", () => {
    expect(foldCase("GOVERNMENT WARNING: According to the Surgeon General")).toBe(
      "government warning: according to the surgeon general",
    );
  });

  it("is idempotent on an already-lowercase string", () => {
    expect(foldCase("already lower")).toBe("already lower");
  });
});
