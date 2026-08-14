// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { installFileDropTestShims } from "../_lib/file-drop-test-shims";
import { FileDropField } from "./FileDropField";

installFileDropTestShims();

function makeFile(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

interface HarnessProps {
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
  onChange?: () => void;
  onRejected?: () => void;
}

function Harness({ disabled = false, multiple = false, accept = "image/jpeg,image/png", onChange, onRejected }: HarnessProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <FileDropField inputRef={inputRef} disabled={disabled} hint="Or drop the photo here." hintId="harness-drop-hint" onRejected={onRejected}>
      <label htmlFor="harness-input">Test file</label>
      <input
        ref={inputRef}
        id="harness-input"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-describedby="harness-drop-hint"
        onChange={onChange}
      />
    </FileDropField>
  );
}

function dropZone(container: HTMLElement): Element {
  const zone = container.querySelector(".file-drop");
  if (!zone) throw new Error("expected a .file-drop element");
  return zone;
}

describe("FileDropField", () => {
  it("renders the hint with the id the caller ties to the input via aria-describedby", () => {
    render(<Harness />);
    const hint = screen.getByText("Or drop the photo here.");
    expect(hint).toHaveAttribute("id", "harness-drop-hint");
    expect(screen.getByLabelText("Test file")).toHaveAttribute("aria-describedby", "harness-drop-hint");
  });

  it("gives the zone itself no role and no live region — the native input stays the one accessible control", () => {
    const { container } = render(<Harness />);
    const zone = dropZone(container);
    expect(zone).not.toHaveAttribute("role");
    expect(zone).not.toHaveAttribute("aria-live");
  });

  it("highlights on a file drag over, and clears when the drag leaves", () => {
    const { container } = render(<Harness />);
    const zone = dropZone(container);

    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone).toHaveClass("file-drop--active");

    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass("file-drop--active");
  });

  it("ignores a drag that carries no files (a text selection, a link)", () => {
    const { container } = render(<Harness />);
    const zone = dropZone(container);

    fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(zone).not.toHaveClass("file-drop--active");
  });

  it("a drop assigns the accepted file to the input and fires its onChange", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const zone = dropZone(container);

    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [makeFile("dropped.jpg", "image/jpeg")] } });

    const input = screen.getByLabelText("Test file") as HTMLInputElement;
    expect(input.files?.[0]?.name).toBe("dropped.jpg");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(zone).not.toHaveClass("file-drop--active");
  });

  it("a drop with zero accepted files changes nothing", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const zone = dropZone(container);

    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [makeFile("notes.txt", "text/plain")] } });

    const input = screen.getByLabelText("Test file") as HTMLInputElement;
    expect(input.files?.length ?? 0).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tells the caller when a drop carries nothing this input accepts — the one case no caller can see", () => {
    // No file is assigned, so no `change` event fires and no caller
    // handler runs. Without this callback the drop is a silent dead end.
    const onRejected = vi.fn();
    const { container } = render(<Harness onRejected={onRejected} />);

    fireEvent.drop(dropZone(container), { dataTransfer: { types: ["Files"], files: [makeFile("application.pdf", "application/pdf")] } });

    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("does not call onRejected when a drop is accepted", () => {
    const onRejected = vi.fn();
    const { container } = render(<Harness onRejected={onRejected} />);

    fireEvent.drop(dropZone(container), { dataTransfer: { types: ["Files"], files: [makeFile("dropped.jpg", "image/jpeg")] } });

    expect(onRejected).not.toHaveBeenCalled();
  });

  it("adds no live region of its own — a second one in the same form announces one event twice", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  });

  it("does nothing while disabled — no highlight, no assignment, no change event", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness disabled onChange={onChange} />);
    const zone = dropZone(container);

    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(zone).not.toHaveClass("file-drop--active");

    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [makeFile("dropped.jpg", "image/jpeg")] } });
    const input = screen.getByLabelText("Test file") as HTMLInputElement;
    expect(input.files?.length ?? 0).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});
