// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewItemDetail } from "./ReviewItemDetail";
import type { ReviewQueueItemDetail } from "../../server/review-queue";

const BASE_ITEM: ReviewQueueItemDetail = {
  id: 42,
  verificationId: 10,
  applicationId: 20,
  reason: "AMBIGUOUS_BRAND",
  reasonText: "A reviewer must check the brand name or class and type against the label.",
  labelVerdict: "REVIEW",
  brandName: "Old Tom Distillery",
  classType: "Straight Bourbon Whiskey",
  beverageType: "spirits",
  createdAt: new Date("2026-08-11T14:03:00.000Z"),
  disposition: null,
  disposedAt: null,
  resolverNote: null,
  resolverFields: null,
  labelImage: {
    url: "/api/label-images/7",
    width: 1000,
    height: 1200,
    originalFilename: "old-tom.jpg",
  },
  fields: [
    {
      field: "BRAND_NAME",
      fieldLabel: "Brand name",
      verdict: "NEEDS_REVIEW",
      labelValue: "Old Tom Distillry",
      evidence: "OLD TOM DISTILLRY",
      applicationValue: "Old Tom Distillery",
      reason: "A reviewer must check the brand name or class and type against the label.",
    },
    {
      field: "ALCOHOL_CONTENT",
      labelValue: "45%",
      fieldLabel: "Alcohol content",
      verdict: "MATCH",
      evidence: "45% ALC/VOL",
      applicationValue: "45%",
      reason: "Matches the application.",
    },
  ],
};

describe("ReviewItemDetail", () => {
  it("renders the reason banner and the per-field comparison, extracted vs application", () => {
    render(<ReviewItemDetail item={BASE_ITEM} />);

    expect(screen.getByTestId("review-item-reason")).toHaveTextContent(
      "A reviewer must check the brand name or class and type against the label.",
    );

    const brandRow = screen.getByTestId("review-field-BRAND_NAME");
    expect(brandRow).toHaveTextContent("Brand name");
    expect(brandRow).toHaveTextContent("OLD TOM DISTILLRY");
    expect(brandRow).toHaveTextContent("Old Tom Distillery");
  });

  it("renders the label image the reviewer is ruling on, sized from persisted dimensions (TRO-575)", () => {
    render(<ReviewItemDetail item={BASE_ITEM} />);
    const image = screen.getByRole("img", { name: "The label submitted with this application" });
    expect(image).toHaveAttribute("src", "/api/label-images/7");
    // Persisted pixel dimensions let the browser reserve layout space
    // before the bytes arrive — no layout shift when the image loads.
    expect(image).toHaveAttribute("width", "1000");
    expect(image).toHaveAttribute("height", "1200");
  });

  it("does not render a resolver section when resolverOutput is null — the normal case today", () => {
    render(<ReviewItemDetail item={BASE_ITEM} />);
    expect(screen.queryByTestId("resolver-suggestion")).not.toBeInTheDocument();
  });

  it("renders the resolver's free-text note when present", () => {
    render(<ReviewItemDetail item={{ ...BASE_ITEM, resolverNote: "Re-read at higher zoom; this is a genuine match." }} />);
    expect(screen.getByTestId("resolver-suggestion")).toHaveTextContent("Re-read at higher zoom; this is a genuine match.");
  });

  it("renders each structured resolver field suggestion, never a confidence number", () => {
    render(
      <ReviewItemDetail
        item={{
          ...BASE_ITEM,
          resolverFields: [
            {
              field: "brand_name",
              kind: "judged",
              disposition: "RESOLVED_MATCH",
              correctedValue: "Old Tom Distillery",
              evidence: "OLD TOM DISTILLRY",
              reason: "The extractor misread one letter; the label matches the application.",
            },
          ],
        }}
      />,
    );
    const section = screen.getByTestId("resolver-suggestion");
    expect(section).toHaveTextContent("Old Tom Distillery");
    expect(section).toHaveTextContent("The extractor misread one letter; the label matches the application.");
    expect(section.textContent).not.toMatch(/confidence/i);
  });

  it("shows an already-resolved status line instead of hiding a disposed item's outcome", () => {
    render(<ReviewItemDetail item={{ ...BASE_ITEM, disposition: "APPROVED", disposedAt: new Date("2026-08-11T15:00:00.000Z") }} />);
    expect(screen.getByTestId("review-item-disposition")).toHaveTextContent("This item was already approved");
  });
});
