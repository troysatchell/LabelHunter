// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ExtractClientError, requestExtraction } from "./extract-client";
import type { ExtractSuccessResponse } from "../api/extract/types";

function makeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], "label.jpg", { type: "image/jpeg" });
}

function goodBody(): ExtractSuccessResponse {
  return {
    outcome: "prefill",
    message: null,
    fields: {
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: null,
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("requestExtraction", () => {
  it("resolves with a well-formed prefill", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(goodBody()));
    await expect(requestExtraction(makeFile(), { fetchImpl })).resolves.toEqual(goodBody());
  });

  it("carries a structured error's kind and message through", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { kind: "BUDGET_EXHAUSTED", message: "The daily budget is spent." } }, 503),
    );
    await expect(requestExtraction(makeFile(), { fetchImpl })).rejects.toMatchObject({
      kind: "BUDGET_EXHAUSTED",
      message: "The daily budget is spent.",
    });
  });

  it("classifies a network failure as SERVICE", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(requestExtraction(makeFile(), { fetchImpl })).rejects.toBeInstanceOf(ExtractClientError);
  });

  it.each([
    ["a non-object body", "plain text"],
    ["a missing outcome", { message: null, fields: goodBody().fields }],
    ["fields as an array", { ...goodBody(), fields: [] }],
    ["a numeric brandName", { ...goodBody(), fields: { ...goodBody().fields, brandName: 42 } }],
    ["a string ABV", { ...goodBody(), fields: { ...goodBody().fields, alcoholContentPercent: "45" } }],
    ["an undefined message", { outcome: "prefill", fields: goodBody().fields }],
  ])("rejects a malformed 200 (%s) as SERVICE instead of passing it to the form", async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    await expect(requestExtraction(makeFile(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("rejects an unparseable body as SERVICE", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(requestExtraction(makeFile(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });
});
