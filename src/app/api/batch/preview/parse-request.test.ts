import { describe, expect, it } from "vitest";
import { parseBatchPreviewFormData } from "./parse-request";

function csvFile(name = "manifest.csv", content = "a,b\n1,2\n"): File {
  return new File([content], name, { type: "text/csv" });
}

function imageFile(name: string, bytes = "fake-bytes"): File {
  return new File([bytes], name, { type: "image/jpeg" });
}

describe("parseBatchPreviewFormData", () => {
  it("accepts a manifest plus multi-file image entries", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile());
    fd.append("images", imageFile("a.jpg"));
    fd.append("images", imageFile("b.jpg"));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.name).toBe("manifest.csv");
    expect(result.value.imageFiles.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(result.value.imagesZip).toBeNull();
  });

  it("accepts a manifest plus a zip of images", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile());
    fd.set("imagesZip", new File(["fake-zip-bytes"], "images.zip", { type: "application/zip" }));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imagesZip?.name).toBe("images.zip");
    expect(result.value.imageFiles).toEqual([]);
  });

  it("accepts both a zip and multi-file entries together", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile());
    fd.append("images", imageFile("a.jpg"));
    fd.set("imagesZip", new File(["fake-zip-bytes"], "images.zip", { type: "application/zip" }));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imageFiles).toHaveLength(1);
    expect(result.value.imagesZip).not.toBeNull();
  });

  it("rejects a request with no manifest file", () => {
    const fd = new FormData();
    fd.append("images", imageFile("a.jpg"));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/csv manifest/i);
  });

  it("rejects a request whose manifest field is not a file", () => {
    const fd = new FormData();
    fd.set("manifest", "not-a-file");
    fd.append("images", imageFile("a.jpg"));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/csv manifest/i);
  });

  it("rejects a manifest file over the size ceiling", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile("manifest.csv", "x".repeat(6 * 1024 * 1024)));
    fd.append("images", imageFile("a.jpg"));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too large/i);
  });

  it("rejects a request with no images at all (neither multi-file nor zip)", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile());
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/add label images/i);
  });

  it("treats a zero-byte zip field as absent, falling back to the no-images rejection", () => {
    const fd = new FormData();
    fd.set("manifest", csvFile());
    fd.set("imagesZip", new File([], "empty.zip", { type: "application/zip" }));
    const result = parseBatchPreviewFormData(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/add label images/i);
  });
});
