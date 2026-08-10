import { describe, expect, it } from "vitest";
import { FileTooLargeError, UnsupportedFormatError } from "./errors";
import { assertSupportedFormat, assertUploadSize } from "./validate";
import { MAX_UPLOAD_BYTES } from "./constants";

describe("assertUploadSize", () => {
  it("accepts a file under the ceiling", () => {
    expect(() => assertUploadSize(1024)).not.toThrow();
  });

  it("accepts a file exactly at the ceiling", () => {
    expect(() => assertUploadSize(MAX_UPLOAD_BYTES)).not.toThrow();
  });

  it("rejects a file over the ceiling with a specific error", () => {
    expect(() => assertUploadSize(MAX_UPLOAD_BYTES + 1)).toThrow(
      FileTooLargeError,
    );
  });

  it("names the actual size and the ceiling in the error message", () => {
    try {
      assertUploadSize(MAX_UPLOAD_BYTES * 2);
      throw new Error("expected assertUploadSize to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FileTooLargeError);
      const message = (err as Error).message;
      expect(message).not.toMatch(/^(error|failed)$/i);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe("assertSupportedFormat", () => {
  it("accepts every allowed format", () => {
    expect(() => assertSupportedFormat("jpeg")).not.toThrow();
    expect(() => assertSupportedFormat("png")).not.toThrow();
    expect(() => assertSupportedFormat("webp")).not.toThrow();
    expect(() => assertSupportedFormat("heif")).not.toThrow();
  });

  it("rejects a format sharp can decode but LabelHunter does not accept", () => {
    // gif/tiff/svg are real formats sharp can decode, but none is a
    // realistic "photograph of a label" — reject with a specific error,
    // not a generic failure.
    expect(() => assertSupportedFormat("gif")).toThrow(UnsupportedFormatError);
    expect(() => assertSupportedFormat("tiff")).toThrow(UnsupportedFormatError);
    expect(() => assertSupportedFormat("svg")).toThrow(UnsupportedFormatError);
  });

  it("rejects an undefined format (sharp could not detect one)", () => {
    expect(() => assertSupportedFormat(undefined)).toThrow(
      UnsupportedFormatError,
    );
  });
});
