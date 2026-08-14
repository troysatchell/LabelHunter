import { describe, expect, it } from "vitest";
import { CANONICAL_WARNING_TEXT } from "../../server/warning/canonical";
import { diffWords } from "./word-diff";

/** The Fairview / case-10 paraphrase: clause (1) reworded. */
const REWORDED =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume alcoholic beverages due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

/** Blue Ridge / case-08: statutory wording, title-case prefix. */
const TITLE_CASE =
  "Government Warning: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

function marked(tokens: ReturnType<typeof diffWords>): string[] {
  return tokens.filter((t) => t.differs).map((t) => t.text);
}

describe("diffWords", () => {
  it("marks nothing when the actual text is the statute verbatim", () => {
    expect(marked(diffWords(CANONICAL_WARNING_TEXT, CANONICAL_WARNING_TEXT))).toEqual([]);
  });

  it("marks exactly the paraphrased words in the case-10 rewording", () => {
    const tokens = diffWords(CANONICAL_WARNING_TEXT, REWORDED);
    // "pregnant" is inserted; "consume" replaces "drink"; "due" "to"
    // replace "during pregnancy because of". "women"/"the risk..." align.
    expect(marked(tokens)).toEqual(["pregnant", "consume", "due", "to"]);
  });

  it("marks nothing for a title-case warning with statutory wording — casing is the caps check's job, not the diff's", () => {
    expect(marked(diffWords(CANONICAL_WARNING_TEXT, TITLE_CASE))).toEqual([]);
  });

  it("does not let trailing punctuation manufacture a difference", () => {
    expect(marked(diffWords("risk of birth defects.", "risk of birth defects"))).toEqual([]);
  });

  it("marks words appended past the end of the required text", () => {
    expect(marked(diffWords("drink responsibly", "drink responsibly every day"))).toEqual(["every", "day"]);
  });

  it("returns every token marked when nothing aligns", () => {
    const tokens = diffWords("alpha beta gamma", "delta epsilon");
    expect(tokens).toEqual([
      { text: "delta", differs: true },
      { text: "epsilon", differs: true },
    ]);
  });

  it("collapses whitespace without inventing tokens", () => {
    const tokens = diffWords("a  b   c", "a b c");
    expect(tokens.every((t) => !t.differs)).toBe(true);
    expect(tokens.map((t) => t.text)).toEqual(["a", "b", "c"]);
  });
});

describe("diffWords — omissions (TRO-582 review round 1)", () => {
  it("surfaces required words dropped with no replacement as an omitted token at the right spot", () => {
    const tokens = diffWords(
      "impairs your ability to drive a car or operate machinery, and may cause health problems.",
      "impairs your ability to drive a car and may cause health problems.",
    );
    const omitted = tokens.filter((t) => t.omitted);
    expect(omitted).toHaveLength(1);
    expect(omitted[0].text).toBe("or operate machinery,");
    // Positioned where the words should be: after "car", before "and".
    const index = tokens.findIndex((t) => t.omitted);
    expect(tokens[index - 1].text).toBe("car");
    expect(tokens[index + 1].text).toBe("and");
  });

  it("surfaces a truncated warning's dropped tail — the common real omission", () => {
    const tokens = diffWords("drive a car or operate machinery, and may cause health problems.", "drive a car");
    const last = tokens[tokens.length - 1];
    expect(last.omitted).toBe(true);
    expect(last.text).toBe("or operate machinery, and may cause health problems.");
  });

  it("does NOT emit an omission marker for a substitution — the replacement's own mark carries the signal", () => {
    // case-10's clause (1): dropped words are all adjacent to insertions.
    const tokens = diffWords(
      "women should not drink alcoholic beverages during pregnancy because of the risk",
      "pregnant women should not consume alcoholic beverages due to the risk",
    );
    expect(tokens.some((t) => t.omitted)).toBe(false);
    expect(tokens.filter((t) => t.differs).map((t) => t.text)).toEqual(["pregnant", "consume", "due", "to"]);
  });
});
