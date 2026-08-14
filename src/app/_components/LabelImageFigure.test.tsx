// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabelImageFigure } from "./LabelImageFigure";

const IMAGE = {
  url: "/api/label-images/7",
  width: 1000,
  height: 1200,
  originalFilename: "old-tom.jpg",
};

describe("LabelImageFigure", () => {
  it("renders the image with its persisted dimensions and the shared alt sentence", () => {
    render(<LabelImageFigure image={IMAGE} />);
    const img = screen.getByRole("img", { name: "The label submitted with this application" });
    expect(img).toHaveAttribute("src", "/api/label-images/7");
    expect(img).toHaveAttribute("width", "1000");
    expect(img).toHaveAttribute("height", "1200");
  });

  it("captions the figure with the original filename — record metadata, visible", () => {
    render(<LabelImageFigure image={IMAGE} />);
    expect(screen.getByText("old-tom.jpg")).toBeInTheDocument();
  });
});
