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
