/**
 * `POST /api/extract` (TRO-576). Same DI-based testing shape as
 * `../verify/route.test.ts`: build a Request, inject deps, assert the
 * Response. The guard tests matter most — this endpoint spends real
 * money, so the rate limit and budget must run before any Haiku call,
 * and a captured usage must reach the spend ledger.
 */
import { describe, expect, it, vi } from "vitest";
import { type PreprocessedImage } from "../../../server/preprocessing";
import { UnreadableImageError } from "../../../server/preprocessing/errors";
import { HaikuExtractionError, type HaikuExtractionResult } from "../../../server/extractor";
import { handleExtractRequest, defaultDeps, type ExtractRouteDeps } from "./route";

function makeRequest(withImage = true): Request {
  const formData = new FormData();
  if (withImage) {
    formData.set("image", new File([new Uint8Array([1, 2, 3])], "label.jpg", { type: "image/jpeg" }));
  }
  return new Request("http://localhost/api/extract", { method: "POST", body: formData });
}

function fakePreprocessed(): PreprocessedImage {
  return {
    original: Buffer.from([1]),
    haikuVariant: Buffer.from([1]),
    mediaType: "image/jpeg",
    widthPx: 100,
    heightPx: 100,
  } as unknown as PreprocessedImage;
}

function fakeExtraction(): HaikuExtractionResult {
  return {
    image_quality: { legible: "yes", issues: [], confidence: 0.95 },
    brand_name: { value: "OLD TOM DISTILLERY", evidence: "OLD TOM DISTILLERY", confidence: 0.9, alternates: [] },
    class_type: { value: null, evidence: "", confidence: 0.2, alternates: [] },
    alcohol_content: { value: "45%", evidence: "45%", confidence: 0.9, alternates: [] },
    net_contents: { value: "750 mL", evidence: "750 mL", confidence: 0.9, alternates: [] },
    beverage_type: { value: "spirits", evidence: "", confidence: 0.9, alternates: [] },
    government_warning: {
      present: true,
      transcription: null,
      prefix_casing: "ALL_CAPS",
      formatting: { bold: "true" },
      evidence: "",
      confidence: 0.9,
    },
  };
}

function makeDeps(overrides: Partial<ExtractRouteDeps> = {}): ExtractRouteDeps {
  return {
    preprocessImage: vi.fn(async () => fakePreprocessed()),
    extractLabel: vi.fn(async () => fakeExtraction()),
    ...overrides,
  };
}

describe("handleExtractRequest — guards run before any spend", () => {
  it("returns 429 from the rate limiter without preprocessing or extracting", async () => {
    const deps = makeDeps({ checkRateLimit: () => ({ allowed: false, message: "Too many requests. Wait a moment." }) });
    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.kind).toBe("RATE_LIMITED");
    expect(deps.preprocessImage).not.toHaveBeenCalled();
    expect(deps.extractLabel).not.toHaveBeenCalled();
  });

  it("returns 503 BUDGET_EXHAUSTED without extracting when the daily budget is spent", async () => {
    const deps = makeDeps({ checkBudget: async () => ({ exhausted: true, spentUsd: 5, budgetUsd: 5 }) });
    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.kind).toBe("BUDGET_EXHAUSTED");
    expect(deps.extractLabel).not.toHaveBeenCalled();
  });
});

describe("handleExtractRequest — request and pipeline outcomes", () => {
  it("returns 400 VALIDATION when no image is attached", async () => {
    const deps = makeDeps();
    const response = await handleExtractRequest(makeRequest(false), deps);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.kind).toBe("VALIDATION");
    expect(body.error.message).toBe("Add a label photo first.");
  });

  it("returns 422 IMAGE with the preprocessor's own message on a PreprocessingError", async () => {
    const deps = makeDeps({
      preprocessImage: vi.fn(async () => {
        throw new UnreadableImageError();
      }),
    });
    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.kind).toBe("IMAGE");
    expect(body.error.message).toContain("LabelHunter cannot open this file");
  });

  it("returns 502 EXTRACTION when the Haiku call itself fails, and the message offers the manual path", async () => {
    const deps = makeDeps({
      extractLabel: vi.fn(async () => {
        throw new HaikuExtractionError(["model returned malformed JSON"]);
      }),
    });
    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.kind).toBe("EXTRACTION");
    expect(body.error.message).toContain("fill in the fields yourself");
  });

  it("returns the mapped prefill on success — parsed values, not raw label text", async () => {
    const deps = makeDeps();
    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe("prefill");
    expect(body.fields).toEqual({
      beverageType: "spirits",
      brandName: "OLD TOM DISTILLERY",
      classType: null,
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
  });
});

describe("handleExtractRequest — spend is recorded even when extraction fails validation", () => {
  it("records the captured usage when the model responded but its output failed to parse", async () => {
    // The paid API call happened; a HaikuExtractionError only means the
    // RESPONSE was malformed. The ledger must still fill (CodeRabbit
    // finding, TRO-576 review round 1). The fake extractLabel makes one
    // real call through the usage-capture wrapper — registering usage the
    // way a real call would — then throws the validation error.
    const recordSpend = vi.fn(async (_usd: number) => {});
    const fakeUnderlyingClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "not the schema at all" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };
    const deps = makeDeps({
      recordSpend,
      anthropicClient: fakeUnderlyingClient as never,
      extractLabel: vi.fn(async (_image, options) => {
        await options?.client?.messages.create({} as never);
        throw new HaikuExtractionError(["model returned malformed JSON"]);
      }),
    });

    const response = await handleExtractRequest(makeRequest(), deps);
    expect(response.status).toBe(502);
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(recordSpend.mock.calls[0][0]).toBeGreaterThan(0);
  });
});

describe("defaultDeps — production wiring is really bound (the TRO-482 lesson)", () => {
  it("binds every guard and the ledger writer", () => {
    expect(defaultDeps.checkRateLimit).toBeTypeOf("function");
    expect(defaultDeps.checkBudget).toBeTypeOf("function");
    expect(defaultDeps.recordSpend).toBeTypeOf("function");
  });

  it("binds a real anthropicClient so usage capture has something to read — the exact defect TRO-482 shipped", () => {
    // A getter that constructs lazily; reading it must yield a client
    // object, not undefined.
    expect(defaultDeps.anthropicClient).toBeDefined();
  });
});
