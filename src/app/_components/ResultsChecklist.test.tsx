// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResultsChecklist } from "./ResultsChecklist";
import type { VerifySuccessResponse } from "../api/verify/types";

const PASS_RESULT: VerifySuccessResponse = {
  applicationId: 1,
  verificationId: 1,
  labelVerdict: "PASS",
  headlineReason: null,
  headlineMessage: null,
  fields: [
    {
      field: "brand_name",
      fieldLabel: "Brand name",
      verdict: "MATCH",
      labelValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      reason: "Matches the application.",
      reviewReason: null,
    },
  ],
};

const REVIEW_RESULT: VerifySuccessResponse = {
  applicationId: 2,
  verificationId: 2,
  labelVerdict: "REVIEW",
  headlineReason: "MISSING_REQUIRED_FIELD",
  headlineMessage: "Needs review — This field is required. The label did not show it.",
  fields: [
    {
      field: "brand_name",
      fieldLabel: "Brand name",
      verdict: "NEEDS_REVIEW",
      labelValue: null,
      evidence: "",
      reason: "This field is required. The label did not show it.",
      reviewReason: "MISSING_REQUIRED_FIELD",
    },
  ],
};

describe("ResultsChecklist", () => {
  it("renders a PASS banner and a match row with the evidence text", () => {
    render(<ResultsChecklist result={PASS_RESULT} />);

    expect(screen.getByTestId("label-verdict-banner")).toHaveTextContent("This label matches the application.");
    const row = screen.getByTestId("checklist-row-brand_name");
    expect(row).toHaveTextContent("Brand name");
    expect(row).toHaveTextContent("OLD TOM DISTILLERY");
    expect(row).toHaveTextContent("Matches the application.");
    // Never a bare confidence percentage anywhere in a row (TH-R20).
    expect(row.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("renders the REVIEW banner using the server's own headline message, and a needs-review row for an absent field", () => {
    render(<ResultsChecklist result={REVIEW_RESULT} />);

    expect(screen.getByTestId("label-verdict-banner")).toHaveTextContent(
      "Needs review — This field is required. The label did not show it.",
    );
    const row = screen.getByTestId("checklist-row-brand_name");
    expect(row).toHaveTextContent("Not found on the label.");
    expect(row).toHaveTextContent("This field is required. The label did not show it.");
  });

  it("renders a FAIL banner in plain language", () => {
    render(<ResultsChecklist result={{ ...PASS_RESULT, labelVerdict: "FAIL" }} />);
    expect(screen.getByTestId("label-verdict-banner")).toHaveTextContent("This label does not match the application.");
  });

  it("renders a mismatch row with the mismatch status text and styling hook", () => {
    render(
      <ResultsChecklist
        result={{
          ...PASS_RESULT,
          labelVerdict: "FAIL",
          fields: [{ ...PASS_RESULT.fields[0], verdict: "MISMATCH", reason: "Does not match the application." }],
        }}
      />,
    );
    const row = screen.getByTestId("checklist-row-brand_name");
    expect(row).toHaveTextContent("Does not match.");
    expect(row).toHaveTextContent("Does not match the application.");
    expect(row.className).toContain("checklist-row--mismatch");
  });
});
