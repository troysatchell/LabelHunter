// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CANONICAL_WARNING_TEXT } from "../../server/warning/canonical";
import { WarningTranscription } from "./WarningTranscription";

const REWORDED =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, pregnant women should not consume alcoholic beverages due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

describe("WarningTranscription", () => {
  it("marks exactly the words that deviate from the statute (the case-10 paraphrase)", () => {
    render(<WarningTranscription transcription={REWORDED} />);
    const marks = screen.getAllByText((_, el) => el?.tagName === "MARK");
    expect(marks.map((m) => m.textContent)).toEqual(["pregnant", "consume", "due", "to"]);
  });

  it("marks nothing when the transcription is the statute verbatim", () => {
    const { container } = render(<WarningTranscription transcription={CANONICAL_WARNING_TEXT} />);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe(CANONICAL_WARNING_TEXT);
  });

  it("renders the full transcription text, marks included, with single spaces", () => {
    const { container } = render(<WarningTranscription transcription="alpha  beta   gamma" />);
    expect(container.textContent).toBe("alpha beta gamma");
  });
});
