// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailView } from "./DetailView";
import type { VerificationDetail } from "../../server/verification-detail";

const PASS_DETAIL: VerificationDetail = {
  verificationId: 1,
  applicationId: 1,
  labelVerdict: "PASS",
  headlineMessage: null,
  resolvedBySonnet: false,
  resolverNote: null,
  boldSignal: null,
  labelImage: { url: "/api/label-images/1", width: 1200, height: 1600, originalFilename: "front.jpg" },
  fields: [
    {
      field: "brand_name",
      fieldLabel: "Brand name",
      verdict: "MATCH",
      labelValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      applicationValue: "Olde Tom Distillery",
      reason: "Matches the application.",
    },
    {
      field: "government_warning",
      fieldLabel: "Government warning",
      verdict: "NEEDS_REVIEW",
      labelValue: "GOVERNMENT WARNING: (1) text",
      evidence: "GOVERNMENT WARNING: (1) text",
      applicationValue: "the statutory warning required by 27 CFR part 16",
      reason: "A reviewer must check the government warning against the label.",
    },
  ],
};

describe("DetailView", () => {
  it("renders the label image with real pixel dimensions, for side-by-side display (PRD §5)", () => {
    render(<DetailView detail={PASS_DETAIL} />);
    const img = screen.getByRole("img", { name: /label submitted/i });
    expect(img).toHaveAttribute("src", "/api/label-images/1");
    expect(img).toHaveAttribute("width", "1200");
    expect(img).toHaveAttribute("height", "1600");
  });

  it("renders the same verdict banner text ResultsChecklist uses, for the same verdict", () => {
    render(<DetailView detail={PASS_DETAIL} />);
    expect(screen.getByTestId("label-verdict-banner")).toHaveTextContent("This label matches the application.");
  });

  it("renders the persisted headline message for a REVIEW verdict, not a generic fallback", () => {
    render(
      <DetailView
        detail={{
          ...PASS_DETAIL,
          labelVerdict: "REVIEW",
          headlineMessage: "Needs review — A reviewer must check the alcohol content against the label.",
        }}
      />,
    );
    expect(screen.getByTestId("label-verdict-banner")).toHaveTextContent(
      "Needs review — A reviewer must check the alcohol content against the label.",
    );
  });

  it("shows extracted vs application values per field, with a match badge (PRD §5)", () => {
    render(<DetailView detail={PASS_DETAIL} />);
    const row = screen.getByTestId("detail-field-brand_name");
    expect(row).toHaveTextContent("Brand name");
    // Asserts the label-side column renders `labelValue` ("Old Tom
    // Distillery"), not `evidence` ("OLD TOM DISTILLERY") — the fixture's
    // `applicationValue` used to duplicate `labelValue`, so this assertion
    // passed even when the buggy code rendered `evidence` instead
    // (CodeRabbit finding, TRO-466 review round 2).
    expect(row).toHaveTextContent("Old Tom Distillery");
    expect(row).not.toHaveTextContent("OLD TOM DISTILLERY");
    expect(row).toHaveTextContent("Matches the application.");
    expect(row.className).toContain("detail-field--match");
    // Never a bare confidence percentage anywhere (TH-R20, standing rule 12).
    expect(row.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("labels the government warning row's columns as detected-vs-required and shows the statute verbatim", () => {
    // TRO-582 superseded the placeholder citation ("the statutory warning
    // required by 27 CFR part 16") with the statute's own text, sourced
    // from the comparator's canonical string — the reviewer compares
    // against the requirement itself, not a citation to memorize. The
    // word-level marks are display alignment only; the verdict and reason
    // still come from the comparator (standing rule 11 holds).
    render(<DetailView detail={PASS_DETAIL} />);
    const row = screen.getByTestId("detail-field-government_warning");
    expect(row).toHaveTextContent("Detected on the label");
    expect(row).toHaveTextContent("What TTB requires");
    expect(row).toHaveTextContent(
      "According to the Surgeon General, women should not drink alcoholic beverages during pregnancy",
    );
    expect(row).not.toHaveTextContent("On the application");
  });

  it("shows 'Not found on the label' when a field's evidence is empty, matching the checklist's own convention", () => {
    render(
      <DetailView
        detail={{
          ...PASS_DETAIL,
          fields: [{ ...PASS_DETAIL.fields[0], evidence: "", labelValue: null }],
        }}
      />,
    );
    expect(screen.getByTestId("detail-field-brand_name")).toHaveTextContent("Not found on the label.");
  });

  it("shows a 'Resolved by Sonnet' annotation only when resolvedBySonnet is true", () => {
    // Unmount the first render before the second: two mounted trees at once
    // would let `getByText` below match against whichever tree happens to
    // hold the text, rather than proving THIS render is the one that
    // changed (CodeRabbit finding, TRO-466 review round 1).
    const { unmount } = render(<DetailView detail={PASS_DETAIL} />);
    expect(screen.queryByText("Resolved by Sonnet")).not.toBeInTheDocument();
    unmount();

    render(<DetailView detail={{ ...PASS_DETAIL, resolvedBySonnet: true }} />);
    expect(screen.getByText("Resolved by Sonnet")).toBeInTheDocument();
  });

  it("shows the resolver's own note when present, and never a bare confidence number", () => {
    render(
      <DetailView
        detail={{
          ...PASS_DETAIL,
          resolvedBySonnet: true,
          resolverNote: "Re-read the ABV line at higher zoom; matches the application.",
        }}
      />,
    );
    expect(screen.getByText("Re-read the ABV line at higher zoom; matches the application.")).toBeInTheDocument();
    // The test's own name promises "never a bare confidence number" — this
    // asserts it, rather than relying on the fixture simply having no
    // number to leak (CodeRabbit finding, TRO-466 review round 1). Matches
    // the same regex this codebase already uses for the identical claim
    // elsewhere (e.g. ResultsChecklist.test.tsx).
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("renders no resolver-note section when resolverNote is null", () => {
    render(<DetailView detail={{ ...PASS_DETAIL, resolvedBySonnet: true, resolverNote: null }} />);
    expect(screen.queryByTestId("resolver-note")).not.toBeInTheDocument();
  });

  describe("bold advisory line (LH-025/LH-026, TRO-532/TRO-533, TH-R9, TH-R20)", () => {
    it("shows an advisory line on the government warning row for a real BoldSignalResult, stating plainly it never fails a label by itself (TRO-569 / INT-005)", () => {
      render(
        <DetailView
          detail={{
            ...PASS_DETAIL,
            boldSignal: { signal: "bold", reason: "the prefix's stroke width measures wider than the body's" },
          }}
        />,
      );
      const advisory = screen.getByTestId("bold-signal-advisory");
      expect(advisory).toHaveTextContent("finds the prefix bold");
      expect(advisory).toHaveTextContent("The prefix's stroke width measures wider than the body's.");
      expect(advisory).toHaveTextContent("It never fails a label by itself.");
      // Lives on the government_warning row, not some other field's row.
      expect(screen.getByTestId("detail-field-government_warning")).toContainElement(advisory);
    });

    it("shows plain language for a not-bold signal, still never a bare confidence number", () => {
      render(
        <DetailView
          detail={{
            ...PASS_DETAIL,
            boldSignal: { signal: "not-bold", reason: "the prefix's stroke width does not measure wider than the body's" },
          }}
        />,
      );
      const advisory = screen.getByTestId("bold-signal-advisory");
      expect(advisory).toHaveTextContent("does not find the prefix bold");
      expect(advisory.textContent).not.toMatch(/\d+(\.\d+)?%/);
    });

    it("shows plain language, and the specific reason, for an uncertain signal — never a bare confidence number", () => {
      render(
        <DetailView
          detail={{
            ...PASS_DETAIL,
            boldSignal: { signal: "uncertain", reason: "stroke width is below the reliable measurement floor" },
          }}
        />,
      );
      const advisory = screen.getByTestId("bold-signal-advisory");
      expect(advisory).toHaveTextContent("could not measure whether the prefix is bold");
      expect(advisory).toHaveTextContent("Stroke width is below the reliable measurement floor.");
      expect(advisory.textContent).not.toMatch(/\d+(\.\d+)?%/);
    });

    it("renders no advisory line when boldSignal is null — no crop was ever measured for this verification", () => {
      render(<DetailView detail={{ ...PASS_DETAIL, boldSignal: null }} />);
      expect(screen.queryByTestId("bold-signal-advisory")).not.toBeInTheDocument();
    });

    it("never renders the advisory line on a non-warning field's row", () => {
      render(
        <DetailView
          detail={{
            ...PASS_DETAIL,
            boldSignal: { signal: "bold", reason: "the prefix's stroke width measures wider than the body's" },
          }}
        />,
      );
      const brandRow = screen.getByTestId("detail-field-brand_name");
      expect(brandRow.querySelector('[data-testid="bold-signal-advisory"]')).toBeNull();
    });
  });
});
