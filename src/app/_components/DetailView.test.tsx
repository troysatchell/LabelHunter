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
  labelImage: { url: "/api/label-images/1", width: 1200, height: 1600, originalFilename: "front.jpg" },
  fields: [
    {
      field: "brand_name",
      fieldLabel: "Brand name",
      verdict: "MATCH",
      labelValue: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      applicationValue: "Old Tom Distillery",
      reason: "Matches the application.",
    },
    {
      field: "government_warning",
      fieldLabel: "Government warning",
      verdict: "NEEDS_REVIEW",
      labelValue: "GOVERNMENT WARNING: (1) text",
      evidence: "GOVERNMENT WARNING: (1) text",
      applicationValue: "the statutory warning required by 27 CFR part 16",
      reason: "The government warning needs a closer look.",
    },
  ],
};

describe("DetailView", () => {
  it("renders the label image with real pixel dimensions, for side-by-side display (PRD §5)", () => {
    render(<DetailView detail={PASS_DETAIL} />);
    const img = screen.getByRole("img", { name: /label photo/i });
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
    expect(row).toHaveTextContent("Old Tom Distillery");
    expect(row).toHaveTextContent("Matches the application.");
    expect(row.className).toContain("detail-field--match");
    // Never a bare confidence percentage anywhere (TH-R20, standing rule 12).
    expect(row.textContent).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("labels the government warning row's columns as detected-vs-required, not extracted-vs-application", () => {
    render(<DetailView detail={PASS_DETAIL} />);
    const row = screen.getByTestId("detail-field-government_warning");
    expect(row).toHaveTextContent("Detected on the label");
    expect(row).toHaveTextContent("the statutory warning required by 27 CFR part 16");
    // The warning row must never render a fabricated character-level diff
    // against a canonical text this ticket does not source (standing rule
    // 11) — only the already-computed verdict and reason.
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
    render(<DetailView detail={PASS_DETAIL} />);
    expect(screen.queryByText("Resolved by Sonnet")).not.toBeInTheDocument();

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
  });

  it("renders no resolver-note section when resolverNote is null", () => {
    render(<DetailView detail={{ ...PASS_DETAIL, resolvedBySonnet: true, resolverNote: null }} />);
    expect(screen.queryByTestId("resolver-note")).not.toBeInTheDocument();
  });
});
