import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_COUNT } from "../../../../server/batch/constants";
import { handleBatchPreviewRequest } from "./route";
import type { BatchPreviewErrorResponse, BatchPreviewSuccessResponse } from "./types";

const HEADER =
  "beverage_type,brand_name,class_type,alcohol_content_percent,net_contents_value,net_contents_unit,image_filename";

function csvFile(content: string, name = "manifest.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

function imageFile(name: string, bytes = "fake-image-bytes"): File {
  return new File([bytes], name, { type: "image/jpeg" });
}

function requestWith(formData: FormData): Request {
  return new Request("http://localhost/api/batch/preview", { method: "POST", body: formData });
}

describe("handleBatchPreviewRequest", () => {
  it("returns a 200 pairing preview for a clean multi-file-drop upload", async () => {
    const csvText = [
      HEADER,
      "spirits,Highland Peak Distillery,Straight Bourbon Whiskey,45,750,mL,bottle-01.jpg",
      "wine,Rolling Hills,Cabernet Sauvignon,13.5,750,mL,bottle-02.jpg",
    ].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", imageFile("bottle-01.jpg"));
    fd.append("images", imageFile("bottle-02.jpg"));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchPreviewSuccessResponse;
    expect(body.totalRows).toBe(2);
    expect(body.readyCount).toBe(2);
    expect(body.matched).toHaveLength(2);
    expect(body.unmatchedRows).toEqual([]);
    expect(body.unmatchedImages).toEqual([]);
    expect(body.invalidRows).toEqual([]);
  });

  it("returns a 200 pairing preview for a clean zip upload", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const zipped = zipSync({ "can-01.jpg": new TextEncoder().encode("fake-jpeg-bytes") });
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.set("imagesZip", new File([zipped], "images.zip", { type: "application/zip" }));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchPreviewSuccessResponse;
    expect(body.readyCount).toBe(1);
    expect(body.matched[0].image.filename).toBe("can-01.jpg");
  });

  it("reports unmatched rows and unmatched images as part of a 200 preview, never as a request failure", async () => {
    const csvText = [
      HEADER,
      "beer,Hopyard Co,IPA,5,355,mL,missing.jpg",
    ].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", imageFile("orphan.jpg"));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(200);
    const body = (await response.json()) as BatchPreviewSuccessResponse;
    expect(body.readyCount).toBe(0);
    expect(body.unmatchedRows).toHaveLength(1);
    expect(body.unmatchedImages).toHaveLength(1);
  });

  it("returns 422 MALFORMED_CSV for a manifest missing a required column, with a plain-English message", async () => {
    const badCsv = "brand_name,class_type\nHopyard Co,IPA\n";
    const fd = new FormData();
    fd.set("manifest", csvFile(badCsv));
    fd.append("images", imageFile("a.jpg"));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(422);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("MALFORMED_CSV");
    expect(body.error.message).not.toMatch(/undefined|NaN|\[object/);
  });

  it("returns 422 MALFORMED_ZIP for a corrupt zip upload", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.set("imagesZip", new File(["not actually a zip file"], "images.zip", { type: "application/zip" }));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(422);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("MALFORMED_ZIP");
  });

  it("returns 400 VALIDATION when no manifest file is present", async () => {
    const fd = new FormData();
    fd.append("images", imageFile("a.jpg"));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION when no images are present at all", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION when the combined image count (multi-file + zip) exceeds the limit", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    // MAX_IMAGE_COUNT individual files, plus one more inside the zip, tips
    // the COMBINED total over the limit even though neither source alone
    // does.
    for (let i = 0; i < MAX_IMAGE_COUNT; i++) {
      fd.append("images", imageFile(`img-${i}.jpg`, "x"));
    }
    const zipped = zipSync({ "extra.jpg": new TextEncoder().encode("x") });
    fd.set("imagesZip", new File([zipped], "images.zip", { type: "application/zip" }));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
    expect(body.error.message).toMatch(/too many images/i);
  });

  it("never leaks a raw exception into the response body", async () => {
    // A manifest field that is not a File at all still exercises the
    // route's outer error handling rather than throwing uncaught.
    const fd = new FormData();
    fd.set("manifest", "not-a-file");
    fd.append("images", imageFile("a.jpg"));

    const response = await handleBatchPreviewRequest(requestWith(fd));
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.message).not.toMatch(/Error:|at handleBatchPreviewRequest|\.ts:\d/);
  });

  it("rejects an oversized request from its Content-Length header alone, before request.formData() ever runs (review finding)", async () => {
    // A real multi-gigabyte body would make this test itself slow and
    // memory-heavy for no benefit — Node's own Request implementation
    // respects an explicitly-set Content-Length header independent of
    // the real (here, tiny) body (confirmed empirically), so the
    // rejection is provable without allocating anything large.
    const request = new Request("http://localhost/api/batch/preview", {
      method: "POST",
      headers: { "content-length": "3000000000" }, // 3 GB, declared only
      body: "tiny-body-does-not-matter",
    });

    let formDataWasCalled = false;
    const originalFormData = request.formData.bind(request);
    request.formData = async () => {
      formDataWasCalled = true;
      return originalFormData();
    };

    const response = await handleBatchPreviewRequest(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as BatchPreviewErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
    expect(body.error.message).toMatch(/too large/i);
    expect(formDataWasCalled).toBe(false);
  });

  it("does not reject a request with no Content-Length header (e.g. chunked bodies) at this check", async () => {
    const csvText = [HEADER, "beer,Hopyard Co,IPA,5,355,mL,can-01.jpg"].join("\n");
    const fd = new FormData();
    fd.set("manifest", csvFile(csvText));
    fd.append("images", imageFile("can-01.jpg"));
    const request = requestWith(fd);
    expect(request.headers.get("content-length")).toBeNull(); // confirms this case is real, not assumed

    const response = await handleBatchPreviewRequest(request);
    expect(response.status).toBe(200);
  });
});
