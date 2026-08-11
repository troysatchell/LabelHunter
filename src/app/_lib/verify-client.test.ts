import { afterEach, describe, expect, it, vi } from "vitest";
import { submitVerification, VerifyClientError, type VerifyFormValues } from "./verify-client";
import type { VerifySuccessResponse } from "../api/verify/types";

function values(overrides: Partial<VerifyFormValues> = {}): VerifyFormValues {
  return {
    imageFile: new File([new Uint8Array([1, 2, 3])], "label.jpg", { type: "image/jpeg" }),
    beverageType: "spirits",
    brandName: "Old Tom Distillery",
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: "45",
    netContentsValue: "750",
    netContentsUnit: "mL",
    ...overrides,
  };
}

const SUCCESS_BODY: VerifySuccessResponse = {
  applicationId: 1,
  verificationId: 1,
  labelVerdict: "PASS",
  headlineReason: null,
  headlineMessage: null,
  fields: [],
};

describe("submitVerification — the happy path", () => {
  it("posts multipart form data to /api/verify and returns the parsed body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      const body = init?.body as FormData;
      expect(body.get("brandName")).toBe("Old Tom Distillery");
      expect((body.get("image") as File).name).toBe("label.jpg");
      return new Response(JSON.stringify(SUCCESS_BODY), { status: 200 });
    });

    const result = await submitVerification(values(), { fetchImpl });
    expect(result).toEqual(SUCCESS_BODY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/verify");
  });
});

describe("submitVerification — the default fetchImpl (real production path)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("falls back to globalThis.fetch, bound, when no fetchImpl is injected", async () => {
    const stub = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(SUCCESS_BODY), { status: 200 }));
    globalThis.fetch = stub as unknown as typeof fetch;

    const result = await submitVerification(values());

    expect(result).toEqual(SUCCESS_BODY);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][0]).toBe("/api/verify");
  });
});

describe("submitVerification — designed error states (TH-R20)", () => {
  it("classifies a non-2xx response with a structured error body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { kind: "IMAGE", message: "LabelHunter cannot open this file." } }), { status: 422 }),
    );

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({
      kind: "IMAGE",
      message: "LabelHunter cannot open this file.",
    });
  });

  it("classifies a non-2xx response with no parseable error body as SERVICE", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 500 }));

    await expect(submitVerification(values(), { fetchImpl })).rejects.toBeInstanceOf(VerifyClientError);
    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not trust an error body whose kind is outside VERIFY_ERROR_KINDS — falls back to SERVICE", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { kind: "NOT_A_REAL_KIND", message: "anything" } }), { status: 422 }),
    );

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("does not blindly trust a 200 response missing the fields the checklist needs — SERVICE, not a crash", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ applicationId: 1, verificationId: 1 }), { status: 200 }));

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/unexpected response/i),
    });
  });

  it("does not trust a 200 response whose labelVerdict is outside the real set", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...SUCCESS_BODY, labelVerdict: "MAYBE" }), { status: 200 }),
    );

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("classifies a response body that is not valid JSON as SERVICE", async () => {
    const fetchImpl = vi.fn(async () => new Response("<not json>", { status: 200 }));

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("classifies a network failure (fetch rejects) as SERVICE, with a retry-worthy message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(submitVerification(values(), { fetchImpl })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/could not reach the server/i),
    });
  });

  it("aborts and reports a timeout when the server never responds in time", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await expect(submitVerification(values(), { fetchImpl, timeoutMs: 15 })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/took too long/i),
    });
  });
});
