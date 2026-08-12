/**
 * Tests for the canonical government-warning text (LH-020 / TRO-468, CP-2
 * §2). Written before `canonical.ts` exists — TDD, PRD §6.
 *
 * Two separate claims, two separate tests:
 * 1. The constant has the exact shape and value CP-2 §2.2 retrieved from
 *    eCFR on 2026-08-11 (length, hash, ASCII-only).
 * 2. The constant matches a COMMITTED FIXTURE of that same retrieval
 *    (`fixtures/ecfr-16-21.xml`) — not itself. CP-2 §2.7/§9.3: "a separate
 *    test must assert that constant against a committed fixture... Without
 *    the second half, a wrong constant would render a wrong label, match
 *    it, and pass." This second test is what makes the first test more
 *    than a tautology — it can fail if someone edits the constant without
 *    re-deriving it from the source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CANONICAL_WARNING_PARAGRAPHS, CANONICAL_WARNING_TEXT } from "./canonical";

/** eCFR's `<EXTRACT>` element holds one `<P>` per statutory paragraph (CP-2
 * §2.4). This mirrors CP-2 Appendix B's own extraction script exactly — a
 * second, independent copy would be the drift risk this test exists to
 * remove. */
function paragraphsFromFixture(xml: string): string[] {
  const extractMatch = xml.match(/<EXTRACT>([\s\S]*?)<\/EXTRACT>/);
  if (!extractMatch) throw new Error("test fixture bug: no <EXTRACT> element in ecfr-16-21.xml");
  const paragraphMatches = [...extractMatch[1].matchAll(/<P>([\s\S]*?)<\/P>/g)];
  if (paragraphMatches.length === 0) throw new Error("test fixture bug: no <P> elements inside <EXTRACT>");
  return paragraphMatches.map((m) => m[1].replace(/\s+/g, " ").trim());
}

describe("CANONICAL_WARNING_PARAGRAPHS — CP-2 §2.2, verified 2026-08-11", () => {
  it("holds exactly the two statutory paragraphs, verbatim", () => {
    expect(CANONICAL_WARNING_PARAGRAPHS).toEqual([
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects.",
      "(2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
    ]);
  });
});

describe("CANONICAL_WARNING_TEXT — the joined string CP-2 §2.4 derives from the two paragraphs", () => {
  it("joins the two paragraphs with a single space", () => {
    expect(CANONICAL_WARNING_TEXT).toBe(CANONICAL_WARNING_PARAGRAPHS.join(" "));
  });

  it("is 283 characters, matching CP-2 §2.2's measured length", () => {
    expect(CANONICAL_WARNING_TEXT).toHaveLength(283);
  });

  it("hashes to the SHA-256 CP-2 §2.2 recorded — 35e1f5d3...f99fbc", () => {
    expect(createHash("sha256").update(CANONICAL_WARNING_TEXT).digest("hex")).toBe(
      "35e1f5d39ee341ac7c114f8159956cb0cc1981b94e4ffeee194ff5060bf99fbc",
    );
  });

  it("contains no non-ASCII character — CP-2 §2.2: no apostrophe, no quotation mark, no diacritic", () => {
    for (const char of CANONICAL_WARNING_TEXT) {
      expect(char.charCodeAt(0)).toBeLessThan(128);
    }
  });

  it("contains no hyphen — CP-2 §5.2's de-hyphenation safety proof depends on this", () => {
    expect(CANONICAL_WARNING_TEXT).not.toContain("-");
  });
});

describe("CANONICAL_WARNING_PARAGRAPHS vs the committed eCFR fixture — CP-2 §2.7/§9.3's drift check", () => {
  it("equals the paragraphs extracted from the committed retrieval, not a second hardcoded copy", () => {
    const fixturePath = join(import.meta.dirname, "fixtures", "ecfr-16-21.xml");
    const xml = readFileSync(fixturePath, "utf8");
    expect(paragraphsFromFixture(xml)).toEqual([...CANONICAL_WARNING_PARAGRAPHS]);
  });

  it("fixture is the real retrieval — section 16.21, title 27, issue date 2026-07-06", () => {
    const fixturePath = join(import.meta.dirname, "fixtures", "ecfr-16-21.xml");
    const xml = readFileSync(fixturePath, "utf8");
    expect(xml).toContain('N="16.21"');
    expect(xml).toContain("Mandatory label information");
  });
});
