// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BatchResultsTable } from "./BatchResultsTable";
import type { BatchResultRowWire } from "../api/batch/[batchJobId]/types";

function row(overrides: Partial<BatchResultRowWire> = {}): BatchResultRowWire {
  return {
    key: "v-1",
    label: "bottle-01.jpg",
    brandName: "Highland Peak Distillery",
    brand: "MATCH",
    abv: "MATCH",
    net: "MATCH",
    warning: "MISMATCH",
    statusText: "Does not match the application.",
    statusTone: "fail",
    statusDetail: null,
    verificationId: 1,
    ...overrides,
  };
}

describe("BatchResultsTable", () => {
  it("renders a designed empty state when there are no results yet — not a blank table", () => {
    render(<BatchResultsTable results={[]} />);
    expect(screen.getByText(/No labels yet\./)).toBeInTheDocument();
  });

  it("renders one row per label with the Label / Brand / ABV / Net / Warning / Status columns (PRD §5)", () => {
    render(<BatchResultsTable results={[row()]} />);
    const tableRow = screen.getByTestId("batch-result-row-v-1");
    expect(tableRow).toHaveTextContent("bottle-01.jpg");
    expect(tableRow).toHaveTextContent("Does not match the application.");
    expect(screen.getAllByText("✓")).toHaveLength(3); // brand + abv + net are all MATCH in this fixture
    expect(screen.getAllByText("✗")).toHaveLength(1); // warning is MISMATCH
  });

  it("renders the ⚠ NEEDS_REVIEW mark, with its own visually-hidden status text (CodeRabbit finding, local review round 1)", () => {
    render(<BatchResultsTable results={[row({ warning: "NEEDS_REVIEW", statusTone: "review", statusText: "Needs review." })]} />);
    expect(screen.getByText(/⚠/)).toBeInTheDocument();
    expect(screen.getByText("Needs review.", { selector: ".visually-hidden" })).toBeInTheDocument();
  });

  it("shows a click-through link to the single-label detail view when a verificationId is present", () => {
    render(<BatchResultsTable results={[row({ verificationId: 42 })]} />);
    const link = screen.getByRole("link", { name: /View detail for Highland Peak Distillery \(bottle-01\.jpg\)/ });
    expect(link).toHaveAttribute("href", "/verify/42");
  });

  it("never renders a click-through link when there is no verificationId (a queued, processing, or failed row)", () => {
    render(<BatchResultsTable results={[row({ verificationId: null, statusTone: "pending", statusText: "Queued for processing." })]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Queued for processing.")).toBeInTheDocument();
  });

  it("shows '—' for a field mark that is not available yet, never a blank cell", () => {
    render(<BatchResultsTable results={[row({ brand: null, abv: null, net: null, warning: null, verificationId: null, statusTone: "pending", statusText: "Queued for processing." })]} />);
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("shows the stored failure detail as a secondary line for a FAILED row", () => {
    render(
      <BatchResultsTable
        results={[
          row({
            verificationId: null,
            statusTone: "failed",
            statusText: "Could not be processed automatically.",
            statusDetail: "LabelHunter cannot open this file. It may be damaged. Take a new photo and try again.",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Could not be processed automatically.")).toBeInTheDocument();
    expect(screen.getByText(/It may be damaged/)).toBeInTheDocument();
  });

  it("renders every row given, in the order given", () => {
    const rows = [row({ key: "v-1", label: "a.jpg" }), row({ key: "v-2", label: "b.jpg" })];
    render(<BatchResultsTable results={rows} />);
    const cells = screen.getAllByRole("rowheader");
    // Each label cell also carries the brand name as a visible sub-line
    // (see the dedicated brandName test below) — the fixture's own
    // brandName default ("Highland Peak Distillery") appears after the
    // filename in both rows here.
    expect(cells.map((c) => c.textContent)).toEqual(["a.jpgHighland Peak Distillery", "b.jpgHighland Peak Distillery"]);
  });

  it("shows the brand name as a visible sub-line under the filename, not only in the link's aria-label", () => {
    // Regression test: at the 200-300-row scale this table is built for
    // (TH-R4), the camera filename alone gives a reviewer nothing to scan
    // by. The brand name previously reached the DOM only inside a hidden
    // aria-label, and only for rows that already had a verificationId.
    render(<BatchResultsTable results={[row({ label: "IMG_20240815_142233.jpg", brandName: "Old Tom Distillery" })]} />);
    const labelCell = screen.getByRole("rowheader");
    expect(labelCell).toHaveTextContent("IMG_20240815_142233.jpg");
    expect(labelCell).toHaveTextContent("Old Tom Distillery");
  });
});
