import { describe, expect, it, vi } from "vitest";
import { BatchClientError, fetchBatchProgress, startBatch, submitBatchPreview } from "./batch-client";
import type { BatchPreviewSuccessResponse } from "../api/batch/preview/types";
import type { BatchStartSuccessResponse } from "../api/batch/start/types";
import type { BatchProgressResponse } from "../api/batch/[batchJobId]/types";

const PREVIEW_SUCCESS: BatchPreviewSuccessResponse = {
  totalRows: 2,
  readyCount: 2,
  matched: [],
  unmatchedRows: [],
  unmatchedImages: [],
  invalidRows: [],
};

const START_SUCCESS: BatchStartSuccessResponse = {
  batchJobId: 7,
  totalRows: 2,
  queuedCount: 2,
  unmatchedRows: [],
  unmatchedImages: [],
  invalidRows: [],
  skippedImages: [],
};

const PROGRESS_SUCCESS: BatchProgressResponse = {
  batchJobId: 7,
  status: "RUNNING",
  totalCount: 2,
  processedCount: 1,
  autoVerifiedCount: 1,
  passCount: 1,
  failCount: 0,
  resolvedBySonnetCount: 0,
  needsHumanCount: 0,
  failedCount: 0,
  startedAt: "2026-08-12T00:00:00.000Z",
  completedAt: null,
  latency: null,
  throughput: null,
  autoVerifiedShare: null,
  rateLimitBackoff: { active: false, itemCount: 0 },
  results: [],
};

function fd(): FormData {
  const formData = new FormData();
  formData.set("manifest", new File(["a"], "manifest.csv", { type: "text/csv" }));
  formData.append("images", new File(["b"], "a.jpg", { type: "image/jpeg" }));
  return formData;
}

describe("submitBatchPreview", () => {
  it("posts the given FormData to /api/batch/preview and returns the parsed body", async () => {
    // Assertions run AFTER the await, not inside the mock (CodeRabbit
    // finding, local review round 1) — an assertion failure inside
    // fetchImpl would otherwise throw INSIDE the client's own try/catch
    // around fetch(), which converts it into a generic "network failure"
    // BatchClientError instead of surfacing the real assertion failure.
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(PREVIEW_SUCCESS), { status: 200 }));

    const result = await submitBatchPreview(fd(), { fetchImpl });
    expect(result).toEqual(PREVIEW_SUCCESS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/batch/preview");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("classifies a structured non-2xx error body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "MALFORMED_CSV", message: "Bad manifest." } }), { status: 422 }));
    await expect(submitBatchPreview(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "MALFORMED_CSV", message: "Bad manifest." });
  });

  it("falls back to SERVICE for a non-2xx response with no parseable error body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ oops: true }), { status: 500 }));
    await expect(submitBatchPreview(fd(), { fetchImpl })).rejects.toBeInstanceOf(BatchClientError);
    await expect(submitBatchPreview(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("rejects a 200 body missing the fields the preview screen needs, instead of crashing later", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ totalRows: 2 }), { status: 200 }));
    await expect(submitBatchPreview(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("classifies a network failure as SERVICE with a retry-worthy message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(submitBatchPreview(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE", message: expect.stringMatching(/connection/i) });
  });
});

describe("startBatch", () => {
  it("posts to /api/batch/start and returns the parsed body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(START_SUCCESS), { status: 200 }));
    const result = await startBatch(fd(), { fetchImpl });
    expect(result).toEqual(START_SUCCESS);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/batch/start");
  });

  it("classifies NO_READY_ROWS from a structured 422", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "NO_READY_ROWS", message: "Nothing is ready." } }), { status: 422 }));
    await expect(startBatch(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "NO_READY_ROWS" });
  });

  it("does not trust an error kind outside the real set — falls back to SERVICE", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "NOT_A_REAL_KIND", message: "x" } }), { status: 400 }));
    await expect(startBatch(fd(), { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });
});

describe("fetchBatchProgress", () => {
  it("GETs /api/batch/:id and returns the parsed body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(PROGRESS_SUCCESS), { status: 200 }));
    const result = await fetchBatchProgress(7, { fetchImpl });
    expect(result).toEqual(PROGRESS_SUCCESS);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/batch/7");
    expect(init?.method).toBe("GET");
  });

  it("classifies a 404 as NOT_FOUND", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { kind: "NOT_FOUND", message: "LabelHunter could not find that batch." } }), { status: 404 }));
    await expect(fetchBatchProgress(999, { fetchImpl })).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("rejects a response whose status is outside the real BatchJobStatus set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...PROGRESS_SUCCESS, status: "MAYBE" }), { status: 200 }));
    await expect(fetchBatchProgress(7, { fetchImpl })).rejects.toMatchObject({ kind: "SERVICE" });
  });

  it("classifies a timeout as SERVICE with its own distinct, retry-worthy message — not the plain network-failure one", async () => {
    // A real `fetch` never rejects until the request's own `signal` fires
    // — this mock waits for that same signal, so the timer `runRequest`
    // itself starts (`timeoutMs: 10`) is what actually triggers the
    // rejection, exactly like production. A fetchImpl that throws
    // immediately (this repo's `submitBatchPreview` "network failure"
    // test does that) never sets `controller.signal.aborted`, so it could
    // not tell "our own timeout fired" from "a plain network failure"
    // apart — the bug this test guards against (CodeRabbit finding, local
    // review round 1): every branch previously hardcoded `true`, so a
    // plain network failure always showed the "took too long" message too.
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(fetchBatchProgress(7, { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/too long/i),
    });
  });

  it("classifies a genuine network failure with its OWN distinct message, never the timeout one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchBatchProgress(7, { fetchImpl })).rejects.toMatchObject({
      kind: "SERVICE",
      message: expect.stringMatching(/could not reach the server/i),
    });
  });
});
