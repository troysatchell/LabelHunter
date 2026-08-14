// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { acceptsFile, assignDroppedFiles } from "./file-drop";
import { installFileDropTestShims } from "./file-drop-test-shims";

installFileDropTestShims();

function makeFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/heic";
const CSV_ACCEPT = ".csv,text/csv";

function makeInput(accept: string, multiple: boolean): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  return input;
}

describe("acceptsFile", () => {
  it("matches a file whose MIME type is on the accept list", () => {
    expect(acceptsFile(makeFile("label.jpg", "image/jpeg"), IMAGE_ACCEPT)).toBe(true);
    expect(acceptsFile(makeFile("label.webp", "image/webp"), IMAGE_ACCEPT)).toBe(true);
  });

  it("rejects a file whose MIME type is not on the accept list", () => {
    expect(acceptsFile(makeFile("notes.txt", "text/plain"), IMAGE_ACCEPT)).toBe(false);
    expect(acceptsFile(makeFile("manifest.csv", "text/csv"), IMAGE_ACCEPT)).toBe(false);
  });

  it("matches a .csv drop by extension when the OS hands over an empty MIME type", () => {
    // OS drags often carry no MIME type for .csv — the extension entry is
    // what keeps a real-world manifest drop working.
    expect(acceptsFile(makeFile("manifest.csv", ""), CSV_ACCEPT)).toBe(true);
  });

  it("matches extensions case-insensitively", () => {
    expect(acceptsFile(makeFile("MANIFEST.CSV", ""), CSV_ACCEPT)).toBe(true);
  });

  it("accepts everything when the accept list is empty", () => {
    expect(acceptsFile(makeFile("anything.bin", "application/octet-stream"), "")).toBe(true);
  });
});

describe("assignDroppedFiles", () => {
  it("assigns the FIRST accepted file to a single-file input and fires one bubbling change event", () => {
    const input = makeInput(IMAGE_ACCEPT, false);
    const onChange = vi.fn((event: Event) => {
      expect(event.bubbles).toBe(true);
    });
    input.addEventListener("change", onChange);

    const count = assignDroppedFiles(input, [makeFile("one.jpg", "image/jpeg"), makeFile("two.jpg", "image/jpeg")]);

    expect(count).toBe(1);
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0]?.name).toBe("one.jpg");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("assigns every accepted file to a multiple input, filtering the rest, in drop order", () => {
    const input = makeInput(IMAGE_ACCEPT, true);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    const count = assignDroppedFiles(input, [
      makeFile("a.jpg", "image/jpeg"),
      makeFile("notes.txt", "text/plain"),
      makeFile("b.png", "image/png"),
    ]);

    expect(count).toBe(2);
    expect(Array.from(input.files ?? []).map((file) => file.name)).toEqual(["a.jpg", "b.png"]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("leaves an existing selection untouched, and fires no change event, when no dropped file is accepted", () => {
    const input = makeInput(IMAGE_ACCEPT, false);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    assignDroppedFiles(input, [makeFile("kept.jpg", "image/jpeg")]);
    expect(onChange).toHaveBeenCalledTimes(1);

    const count = assignDroppedFiles(input, [makeFile("bad.txt", "text/plain")]);

    expect(count).toBe(0);
    expect(input.files?.[0]?.name).toBe("kept.jpg");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
