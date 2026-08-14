import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError } from "@anthropic-ai/sdk";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../lib/db";
import { applications, dailySpend, fieldResults, labelImages, reviewQueue, verifications } from "../../../lib/db/schema";
import { extractLabel, getDefaultExtractorClient, HaikuExtractionError } from "../../../server/extractor";
import { makeMockMessage, WELL_FORMED_EXTRACTION_BODY } from "../../../server/extractor/test-support";
import { MAX_UPLOAD_BYTES, preprocessImage } from "../../../server/preprocessing";
import { productionComparators } from "../../../server/comparators";
import type { WarningComparatorResult } from "../../../server/router";
import type {
  BoldSignalResult,
  CompareGovernmentWarningFromImageInput,
  CompareGovernmentWarningFromImageResult,
} from "../../../server/warning";
import { deleteLabelImageBlobsWhere, saveLabelImage } from "../../../server/storage/db-image-storage";
import {
  BUDGET_CHECK_UNAVAILABLE_MESSAGE,
  BUDGET_EXHAUSTED_MESSAGE,
  getTodaySpendUsd,
  reserveDailyBudget,
  settleBudgetReservation,
} from "../../../server/budget/daily-budget";
import { haikuCallCostUsd } from "../../../server/budget/anthropic-usage";
import { createFixedWindowLimiter } from "../../../server/rate-limit/fixed-window";
import { checkRateLimitPair } from "../../../server/rate-limit/instances";
import { defaultDeps, handleVerifyRequest, POST as verifyPOST, type VerifyRouteDeps } from "./route";
import { POST as batchStartPOST } from "../batch/start/route";
import type { BatchStartErrorResponse } from "../batch/start/types";
import { BATCH_START_IP_LIMIT, VERIFY_IP_LIMIT } from "../../../server/rate-limit/instances";
import { parseServerTimingHeader, SERVER_TIMING_STAGES } from "./server-timing";
import type { VerifyErrorResponse, VerifySuccessResponse } from "./types";

// This suite makes NO live Anthropic call — every Anthropic response is a
// canned `makeMockMessage` (same pattern as
// `src/server/extractor/index.test.ts`). It DOES use the real local
// Postgres database (`DATABASE_URL`, from `.env.local`) to assert
// persistence — TRO-465's brief calls for this explicitly — and every saved
// image (TRO-518: `label_image_blobs`, in that same database) is deleted in
// `afterEach` alongside its `applications` row.

const createdApplicationIds: number[] = [];

afterEach(async () => {
  const ids = createdApplicationIds.splice(0);
  if (ids.length > 0) {
    // TRO-518: label_image_blobs rows are not reached by the cascade below
    // — see db-image-storage.ts's own deleteLabelImageBlobsWhere comment.
    await deleteLabelImageBlobsWhere(inArray(labelImages.applicationId, ids));
  }
  // Cascades to label_images, verifications, field_results, review_queue
  // (every FK in schema.ts is ON DELETE CASCADE) — one delete per test
  // application is enough to leave the shared worktree DB clean.
  for (const id of ids) {
    await db.delete(applications).where(eq(applications.id, id));
  }
});

async function makeJpeg(width = 1200, height = 1600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 180, g: 180, b: 180 } } })
    .jpeg()
    .toBuffer();
}

function fakeAnthropicClient(create: () => Promise<Anthropic.Message>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

/** An Anthropic client that always returns `body` as the extraction JSON —
 * the same `makeMockMessage` shape `extractLabel`'s own tests use. */
function clientReturning(body: unknown): Anthropic {
  return fakeAnthropicClient(async () => makeMockMessage(JSON.stringify(body)));
}

interface FormOverrides {
  image?: File;
  beverageType?: string;
  brandName?: string;
  classType?: string;
  alcoholContentPercent?: string;
  netContentsValue?: string;
  netContentsUnit?: string;
}

async function buildFormData(overrides: FormOverrides = {}): Promise<FormData> {
  const fd = new FormData();
  // `Buffer`'s TS type does not satisfy `BlobPart`'s strict
  // `ArrayBufferView<ArrayBuffer>` generic (Buffer's own `.buffer` is typed
  // `ArrayBufferLike`), even though Node's real `File`/`Blob` accept a
  // `Buffer` at runtime without issue — a type-only mismatch, not a
  // behavioral one.
  const image = overrides.image ?? new File([(await makeJpeg()) as unknown as BlobPart], "front-label.jpg", { type: "image/jpeg" });
  const fields: Record<string, string> = {
    beverageType: overrides.beverageType ?? "spirits",
    brandName: overrides.brandName ?? "Old Tom Distillery",
    classType: overrides.classType ?? "Straight Bourbon Whiskey",
    alcoholContentPercent: overrides.alcoholContentPercent ?? "45",
    netContentsValue: overrides.netContentsValue ?? "750",
    netContentsUnit: overrides.netContentsUnit ?? "mL",
  };
  fd.set("image", image);
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/**
 * `government_warning` is out of scope for most of this file's tests —
 * they exercise brand/class/ABV/net-contents wiring (LH-013) and the
 * router's own precedence rules, not the warning subsystem (LH-020, wired
 * into this route by TRO-514). This stub keeps every other test's warning
 * field a stable NEEDS_REVIEW/WARNING_MISMATCH row: never MATCH, never
 * MISMATCH, so it can never silently flip an unrelated test's labelVerdict
 * into PASS or FAIL behind that test's back. The "government warning
 * wiring" describe block below overrides `compareGovernmentWarning`
 * explicitly to exercise the real MATCH/MISMATCH/failure behavior.
 */
/** TRO-533 — every fake `compareGovernmentWarning` in this file returns
 * `{ comparator, boldSignal }` now, not a bare `WarningComparatorResult`.
 * This helper builds that shape so each test states only the comparator
 * result it actually cares about; `boldSignal` defaults to `null` (the
 * "no crop was produced" state), which is fine for every test that is not
 * itself testing the bold-signal wiring. */
function warningOutcome(
  comparator: WarningComparatorResult,
  boldSignal: BoldSignalResult | null = null,
): CompareGovernmentWarningFromImageResult {
  return { comparator, boldSignal };
}

async function warningNeedsReviewStub(): Promise<CompareGovernmentWarningFromImageResult> {
  return warningOutcome({ verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" });
}

function makeDeps(overrides: Partial<VerifyRouteDeps> = {}): VerifyRouteDeps {
  return {
    db,
    preprocessImage,
    extractLabel,
    compareGovernmentWarning: warningNeedsReviewStub,
    saveLabelImage,
    comparators: productionComparators,
    ...overrides,
  };
}

async function post(formData: FormData, deps: VerifyRouteDeps): Promise<Response> {
  const request = new Request("http://localhost/api/verify", { method: "POST", body: formData });
  return handleVerifyRequest(request, deps);
}

describe("POST /api/verify — happy path", () => {
  it("routes a well-formed submission, returns a checklist, and persists every table", async () => {
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    expect(body.fields).toHaveLength(5);
    const byField = new Map(body.fields.map((row) => [row.field, row]));
    expect(byField.get("brand_name")?.verdict).toBe("MATCH");
    expect(byField.get("class_type")?.verdict).toBe("MATCH");
    expect(byField.get("alcohol_content")?.verdict).toBe("MATCH");
    expect(byField.get("net_contents")?.verdict).toBe("MATCH");
    // Never a bare confidence percentage anywhere in the reason text (TH-R20).
    for (const row of body.fields) {
      expect(row.reason).not.toMatch(/\d+(\.\d+)?%/);
      expect(row.reason.length).toBeGreaterThan(0);
    }

    // The warning comparator (LH-020) is wired into this route for real
    // now (TRO-514) — `makeDeps()`'s default `compareGovernmentWarning` is
    // a deliberately neutral NEEDS_REVIEW stub, not evidence the wiring is
    // missing. This test's own focus is the other four fields; see the
    // "government warning wiring" describe block below for MATCH/MISMATCH/
    // failure coverage of the real behavior.
    expect(byField.get("government_warning")?.verdict).toBe("NEEDS_REVIEW");
    expect(body.labelVerdict).toBe("REVIEW");
    expect(body.headlineMessage).toMatch(/^Needs review — /);

    const [applicationRow] = await db.select().from(applications).where(eq(applications.id, body.applicationId));
    expect(applicationRow.brandName).toBe("Old Tom Distillery");

    const [verificationRow] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.id, body.verificationId));
    expect(verificationRow.verdict).toBe("REVIEW");
    expect(verificationRow.resolutionPath).toBe("EXTRACTOR_ONLY");

    const persistedFields = await db.select().from(fieldResults).where(eq(fieldResults.verificationId, body.verificationId));
    expect(persistedFields).toHaveLength(5);

    const [queueRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, body.verificationId));
    expect(queueRow.reason).toBe(body.headlineReason);
    expect(queueRow.disposition).toBeNull();

    // TRO-511: the route now snapshots {schemaVersion, extraction, router,
    // flaggedFields} into resolverInput at insert time — the same shape
    // batch_queue_items.resolver_input carries (CP-3 §2.3) — so a
    // background worker can call resolveEscalatedLabel for this row later
    // without ever re-running Haiku. resolverOutput stays null until that
    // worker actually runs; this route never calls Sonnet inline (TH-R19).
    const snapshot = queueRow.resolverInput as { schemaVersion: string; extraction: unknown; router: unknown; flaggedFields: unknown[] };
    expect(snapshot).not.toBeNull();
    expect(snapshot.schemaVersion).toBe("1");
    expect(snapshot.extraction).toBeTruthy();
    expect(snapshot.router).toBeTruthy();
    expect(Array.isArray(snapshot.flaggedFields)).toBe(true);
    expect(snapshot.flaggedFields.length).toBeGreaterThan(0);
    expect(queueRow.resolverOutput).toBeNull();
  });

  it("brand_name never reports a silent MISMATCH — a real disagreement is a judgment call, routed to REVIEW (CP-1 §5.3, PRD §3.3)", async () => {
    const extraction = {
      ...WELL_FORMED_EXTRACTION_BODY,
      brand_name: { value: "Totally Different Brand", evidence: "TOTALLY DIFFERENT BRAND", confidence: 0.95, alternates: [] },
    };
    const deps = makeDeps({ anthropicClient: clientReturning(extraction) });
    const response = await post(await buildFormData({ brandName: "Old Tom Distillery" }), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const brandRow = body.fields.find((row) => row.field === "brand_name");
    expect(brandRow?.verdict).toBe("NEEDS_REVIEW");
    expect(body.fields.some((row) => row.verdict === "MISMATCH")).toBe(false);
  });

  it("brand_name MATCHes a case/apostrophe-normalized read, with a note (TH-R8's named STONE'S THROW case, real comparators post-LH-013)", async () => {
    const extraction = {
      ...WELL_FORMED_EXTRACTION_BODY,
      brand_name: { value: "STONE'S THROW", evidence: "STONE'S THROW", confidence: 0.95, alternates: [] },
    };
    const deps = makeDeps({ anthropicClient: clientReturning(extraction) });
    const response = await post(await buildFormData({ brandName: "Stone's Throw" }), deps);

    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const brandRow = body.fields.find((row) => row.field === "brand_name");
    expect(brandRow?.verdict).toBe("MATCH");
    expect(brandRow?.reason).toMatch(/normalized/i);
  });

  it("alcohol_content DOES report a MISMATCH on a genuine numeric disagreement — real comparators (LH-013), unlike this ticket's earlier provisional stand-in", async () => {
    const extraction = {
      ...WELL_FORMED_EXTRACTION_BODY,
      alcohol_content: { value: "40% Alc./Vol.", evidence: "40% Alc./Vol.", confidence: 0.95, alternates: [] },
    };
    const deps = makeDeps({ anthropicClient: clientReturning(extraction) });
    // Application still declares 45% (buildFormData's default) — a real disagreement.
    const response = await post(await buildFormData(), deps);

    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const abvRow = body.fields.find((row) => row.field === "alcohol_content");
    expect(abvRow?.verdict).toBe("MISMATCH");
    // The label-level verdict still isn't a clean FAIL: `makeDeps()`'s
    // default warning stub is NEEDS_REVIEW (TRO-514's own dedicated tests
    // below cover a real MATCH/MISMATCH warning result) — REVIEW outranks
    // FAIL in the rollup.
    expect(body.labelVerdict).toBe("REVIEW");
  });

  it("a missing required field outranks the warning gap as the headline reason", async () => {
    const extraction = {
      ...WELL_FORMED_EXTRACTION_BODY,
      brand_name: { value: null, evidence: "", confidence: 0, alternates: [] },
    };
    const deps = makeDeps({ anthropicClient: clientReturning(extraction) });
    const response = await post(await buildFormData(), deps);

    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    expect(body.headlineReason).toBe("MISSING_REQUIRED_FIELD");
    const [queueRow] = await db.select().from(reviewQueue).where(eq(reviewQueue.verificationId, body.verificationId));
    expect(queueRow.reason).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("POST /api/verify — Server-Timing header (TRO-539, PRD §3.8)", () => {
  it("returns one dur= metric per PRD §3.8 stage on a 200 response", async () => {
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const header = response.headers.get("server-timing");
    expect(header).not.toBeNull();
    const parsed = parseServerTimingHeader(header ?? "");
    for (const stage of SERVER_TIMING_STAGES) {
      expect(parsed[stage], `expected a numeric "${stage}" entry in Server-Timing: ${header}`).toBeDefined();
      expect(parsed[stage]).toBeGreaterThanOrEqual(0);
    }
  });

  it("omits the header on a non-200 (error) response — an early error means a stage never ran", async () => {
    const garbage = new File([Buffer.from("this is not an image, just padded text bytes")], "photo.jpg", {
      type: "image/jpeg",
    });
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });

    const response = await post(await buildFormData({ image: garbage }), deps);
    expect(response.status).toBe(422);
    expect(response.headers.get("server-timing")).toBeNull();
  });
});

describe("POST /api/verify — designed error states (TH-R20)", () => {
  it("malformed input (missing image): 400 VALIDATION, no live call attempted", async () => {
    const fd = await buildFormData();
    fd.delete("image");
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });

    const response = await post(fd, deps);
    expect(response.status).toBe(400);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("VALIDATION");
    expect(body.error.message).toBe("Add a label photo before you verify.");
  });

  it("an unsupported file type (garbage bytes, no recognizable image format): 422 IMAGE, with the preprocessing module's own human-readable message", async () => {
    const garbage = new File([Buffer.from("this is not an image, just padded text bytes")], "photo.jpg", {
      type: "image/jpeg",
    });
    const deps = makeDeps({ anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) });

    const response = await post(await buildFormData({ image: garbage }), deps);
    expect(response.status).toBe(422);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("IMAGE");
    expect(body.error.message).toMatch(/cannot read this file type/i);
  });

  it("an unreadable image (TRO-478): a valid JPEG header with damaged pixel data — 422 IMAGE, distinct from an unsupported format and from LOW_IMAGE_QUALITY (LH-051's readable-but-blurry case)", async () => {
    // Same technique as pipeline.test.ts's own UnreadableImageError case: a
    // real JPEG, truncated — sharp reads enough of the header to recognize
    // the format, then fails to decode the (now-missing) pixel data. This is
    // the genuine "damaged file" state; the test above is a different state
    // (no recognizable format at all).
    const real = await makeJpeg(400, 300);
    const truncated = real.subarray(0, Math.floor(real.length / 2));
    const corrupt = new File([truncated as unknown as BlobPart], "photo.jpg", { type: "image/jpeg" });
    const create = vi.fn(async () => makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)));
    const deps = makeDeps({ anthropicClient: { messages: { create } } as unknown as Anthropic });

    const response = await post(await buildFormData({ image: corrupt }), deps);
    expect(response.status).toBe(422);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("IMAGE");
    expect(body.error.message).toMatch(/cannot open this file/i);
    expect(body.error.message).not.toMatch(/file type/i);
    // A damaged file never reaches the extractor.
    expect(create).not.toHaveBeenCalled();
  });

  it("an oversized file (TRO-478): over the upload size ceiling — 422 IMAGE, rejected before Haiku ever sees it", async () => {
    // Deliberately not a real image — assertUploadSize runs before any
    // decode attempt (pipeline.ts), so a garbage buffer this large is enough
    // to prove the ceiling is enforced end to end through the route, not
    // just in the preprocessing unit tests.
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    const hugeFile = new File([oversized as unknown as BlobPart], "photo.jpg", { type: "image/jpeg" });
    const create = vi.fn(async () => makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)));
    const deps = makeDeps({ anthropicClient: { messages: { create } } as unknown as Anthropic });

    const response = await post(await buildFormData({ image: hugeFile }), deps);
    expect(response.status).toBe(422);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("IMAGE");
    expect(body.error.message).toMatch(/choose a smaller image/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("extraction failure (malformed model response): 502 EXTRACTION, the honest 'could not read the label' state — never a fake verdict", async () => {
    const deps = makeDeps({ anthropicClient: fakeAnthropicClient(async () => makeMockMessage("{not valid json")) });

    // A brand name unique to this test (TRO-514, same fix TRO-478 already
    // applied below for the same reason) — not the shared "Old Tom
    // Distillery" default other tests in this file, and other files run in
    // parallel against this same worktree database, also use and
    // successfully persist. Querying by the shared name raced against those
    // unrelated concurrent tests' own rows: this exact test failed
    // intermittently in the full suite (not standalone) with `rows.length`
    // 1 instead of 0, confirmed not a defect in this ticket's own change.
    const brandName = "TRO-514 Extraction Failure Probe";
    const response = await post(await buildFormData({ brandName }), deps);
    expect(response.status).toBe(502);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("EXTRACTION");
    expect(body.error.message).toBe("LabelHunter could not read this label. Take a clearer photo and try again.");

    const rows = await db.select().from(applications).where(eq(applications.brandName, brandName));
    // No verification row was left behind by a failed extraction.
    expect(rows).toHaveLength(0);
  });

  it("a transport-level failure (network down / timeout): 503 SERVICE, with a retry-worthy message", async () => {
    const deps = makeDeps({
      extractLabel: async () => {
        throw new Error("network down");
      },
    });

    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toMatch(/could not reach the verification service/i);
  });

  it("the Anthropic endpoint is unreachable (TRO-478, TH-R7 — a firewall block, DNS failure, or refused connection): 503 SERVICE, no partial record left behind", async () => {
    // `APIConnectionError` is the real class the Anthropic SDK throws for a
    // connect-level failure (client.d.ts) — the exact shape a blocked
    // outbound domain produces, per TH-R7's constrained-network scenario.
    // Distinct from the generic `Error` above: this pins the actual failure
    // type, not a stand-in.
    const deps = makeDeps({
      extractLabel: async () => {
        throw new APIConnectionError({ message: "Connection error." });
      },
    });

    // A brand name unique to this test, not the shared "Old Tom Distillery"
    // default other tests in this file (and other files, run in parallel
    // against this same worktree database) also use and successfully
    // persist — querying by the shared name below would otherwise race
    // against unrelated concurrent tests' own rows.
    const brandName = "TRO-478 Unreachable Endpoint Probe";
    const response = await post(await buildFormData({ brandName }), deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toMatch(/could not reach the verification service/i);
    // No raw SDK detail (class name, "Connection error.", a stack frame)
    // leaks into the response a first-time user sees (TH-R20).
    expect(JSON.stringify(body)).not.toMatch(/APIConnectionError|Connection error\.|ECONNREFUSED|ENOTFOUND/);

    const rows = await db.select().from(applications).where(eq(applications.brandName, brandName));
    expect(rows).toHaveLength(0);
  });

  it("a storage failure surfaces as a designed SERVICE state, not a raw 500", async () => {
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      saveLabelImage: async () => {
        throw new Error("disk full");
      },
    });

    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toMatch(/could not save this photo/i);
  });

  it("a database failure after a successful extraction surfaces as a designed SERVICE state", async () => {
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      db: { transaction: async () => { throw new Error("connection reset"); } } as unknown as VerifyRouteDeps["db"],
    });

    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toMatch(/could not save this verification/i);
  });
});

describe("POST /api/verify — government warning wiring (TRO-514, TH-R9)", () => {
  it("starts the warning comparator before the Haiku extraction call resolves (PRD §3.8 / CP-2 §4.4 — concurrent, not serial)", async () => {
    const callOrder: string[] = [];
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });

    // The real `extractLabel` (this file's default), fed by a fake
    // Anthropic client whose response stays pending until this test
    // releases it — the same `fakeAnthropicClient` helper every other test
    // in this file uses, just deliberately held open here.
    const anthropicClient = fakeAnthropicClient(async () => {
      callOrder.push("extractLabel:called");
      await extractionGate;
      callOrder.push("extractLabel:resolved");
      return makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY));
    });

    let markWarningCalled!: () => void;
    const warningCalled = new Promise<void>((resolve) => {
      markWarningCalled = resolve;
    });
    const compareGovernmentWarning: VerifyRouteDeps["compareGovernmentWarning"] = async () => {
      callOrder.push("compareGovernmentWarning:called");
      // The concurrency requirement itself: this must run BEFORE
      // extractLabel's own promise has resolved, never after. Written as
      // an assertion here (not just below) so a serial implementation
      // fails inside the very call this test is timing, not only via the
      // `warningCalled` promise never settling.
      expect(callOrder).not.toContain("extractLabel:resolved");
      markWarningCalled();
      return warningOutcome({ verdict: "MATCH" });
    };

    const deps = makeDeps({ anthropicClient, compareGovernmentWarning });
    const responsePromise = post(await buildFormData(), deps);

    // Observable event, not a sleep (standing rule 8): waits only until the
    // comparator has actually been invoked. Under the old serial code
    // (`await extractLabel(...)` before calling the warning comparator),
    // this promise never resolves, because extractLabel is held open by
    // `extractionGate` and nothing has released it yet — the test times
    // out instead of passing, which is still a correct "fails for the
    // right reason" outcome for a concurrency regression.
    await warningCalled;
    expect(callOrder).toContain("compareGovernmentWarning:called");
    expect(callOrder).not.toContain("extractLabel:resolved");

    releaseExtraction();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);
    expect(callOrder).toContain("extractLabel:resolved");
  });

  it("a compliant warning (MATCH) contributes to a clean PASS label verdict", async () => {
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH", note: "Government Warning matches the required text." }),
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const warningRow = body.fields.find((row) => row.field === "government_warning");
    expect(warningRow?.verdict).toBe("MATCH");
    // Every other field in WELL_FORMED_EXTRACTION_BODY already MATCHes the
    // default application (the existing happy-path test above) — a
    // compliant warning is the only thing standing between that fixture
    // and a clean PASS. This is the ticket's headline proof: TH-R9's
    // check now actually contributes to the label verdict.
    expect(body.labelVerdict).toBe("PASS");
    expect(body.headlineReason).toBeNull();
  });

  it("a non-compliant warning (MISMATCH) contributes a FAIL label verdict", async () => {
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () =>
        warningOutcome({
          verdict: "MISMATCH",
          note: "Government Warning wording differs from the required text.",
        }),
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    const warningRow = body.fields.find((row) => row.field === "government_warning");
    expect(warningRow?.verdict).toBe("MISMATCH");
    expect(body.labelVerdict).toBe("FAIL");
  });

  it("a warning-comparator failure degrades that field to NEEDS_REVIEW instead of crashing the request (CP-2 §4.4 rule 3)", async () => {
    let wasCalled = false;
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => {
        wasCalled = true;
        throw new Error("region-detect: sharp exploded");
      },
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    // Proves the comparator actually ran and its rejection was caught —
    // not merely that the field happens to default to REVIEW some other
    // way (e.g. the dependency never being called at all).
    expect(wasCalled).toBe(true);
    const warningRow = body.fields.find((row) => row.field === "government_warning");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
    expect(body.labelVerdict).toBe("REVIEW");
  });

  it("a SYNCHRONOUS throw from the warning comparator also degrades gracefully, not just a rejected promise", async () => {
    let wasCalled = false;
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: () => {
        wasCalled = true;
        throw new Error("boom, synchronously, before returning any promise at all");
      },
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    expect(wasCalled).toBe(true);
    const warningRow = body.fields.find((row) => row.field === "government_warning");
    expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
  });

  it("passes the ORIGINAL full-resolution image to the warning comparator, never the resized Haiku variant (CP-2 §8.3)", async () => {
    const originalMarker = Buffer.from("ORIGINAL-FULL-RES-MARKER-not-a-real-jpeg");
    let capturedHaikuVariant: Buffer | undefined;
    let capturedInput: CompareGovernmentWarningFromImageInput | undefined;

    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      preprocessImage: async (upload) => {
        const real = await preprocessImage(upload);
        capturedHaikuVariant = real.haikuVariant;
        return { ...real, original: originalMarker };
      },
      compareGovernmentWarning: async (input) => {
        capturedInput = input;
        return warningOutcome({ verdict: "MATCH" });
      },
    });
    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.originalImage.equals(originalMarker)).toBe(true);
    expect(capturedHaikuVariant).toBeDefined();
    expect(capturedInput!.originalImage.equals(capturedHaikuVariant!)).toBe(false);
  });

  it("persists the bold advisory signal for EVERY verification, not only escalated ones (TRO-533)", async () => {
    const boldSignal: BoldSignalResult = {
      signal: "bold",
      reason: "the prefix's stroke width measures wider than the body's",
      ratio: 2.1,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 5,
      bodyStrokeWidthPx: 2.4,
    };
    const deps = makeDeps({
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, boldSignal),
    });
    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifySuccessResponse;
    createdApplicationIds.push(body.applicationId);
    // This label is a clean PASS, no escalation at all — proves the signal
    // reaches the database on the ordinary happy path, not only via the
    // review_queue's resolverInput snapshot.
    expect(body.labelVerdict).toBe("PASS");

    const [row] = await db.select().from(verifications).where(eq(verifications.id, body.verificationId));
    expect(row.boldSignal).toEqual(boldSignal);
  });

  // TRO-569 (Urgent, Troy-ruled) supersedes the old rule "the bold signal
  // NEVER changes the label verdict, in either direction (TRO-533)" for
  // exactly one edge: a compliant-wording MATCH whose prefix measures
  // "not-bold" now degrades to REVIEW instead of a silent PASS. Jenny
  // Park's requirement: the prefix "has to be in all caps and bold."
  // INT-005: an interpretation may never widen a requirement into
  // something weaker than the brief — the old silent PASS did exactly
  // that. Every other edge the old single test proved still holds: never
  // a hard FAIL, never a change to an existing MISMATCH, never an
  // accusation on "bold" or "uncertain". Split into one test per edge so
  // no single case carries five POST round-trips (a 5054ms CI timeout on
  // 2026-08-14 — vitest's default budget is 5000ms).
  describe("TRO-569 / INT-005 — the not-bold routing rule and its guardrails", () => {
    const bold: BoldSignalResult = {
      signal: "bold",
      reason: "the prefix's stroke width measures wider than the body's",
      ratio: 2.1,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 5,
      bodyStrokeWidthPx: 2.4,
    };
    const notBold: BoldSignalResult = {
      signal: "not-bold",
      reason: "the prefix's stroke width does not measure wider than the body's",
      ratio: 0.9,
      splitFraction: 0.49,
      prefixStrokeWidthPx: 2,
      bodyStrokeWidthPx: 2.2,
    };
    const uncertain: BoldSignalResult = {
      signal: "uncertain",
      reason: "prefix and body stroke-width ranges overlap; no clean separation",
      ratio: null,
      splitFraction: null,
      prefixStrokeWidthPx: null,
      bodyStrokeWidthPx: null,
    };

    // A comparator MISMATCH stays FAIL regardless of the bold signal — a
    // gating implementation would be tempted to let a compliant bold
    // prefix soften a wording failure, or let a not-bold prefix worsen
    // one. Neither is correct: bold-detect.ts's own header comment says
    // this signal must never produce a hard FAIL by itself, and TRO-569
    // only touches the MATCH -> REVIEW edge.
    it("a comparator MISMATCH stays FAIL when the prefix measures bold", async () => {
      const deps = makeDeps({
        anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
        compareGovernmentWarning: async () =>
          warningOutcome({ verdict: "MISMATCH", note: "Government Warning wording differs from the required text." }, bold),
      });
      const response = await post(await buildFormData(), deps);
      const body = (await response.json()) as VerifySuccessResponse;
      createdApplicationIds.push(body.applicationId);
      expect(body.labelVerdict).toBe("FAIL");
    });

    it("a comparator MISMATCH stays FAIL when the prefix measures not-bold — the signal never worsens a wording failure", async () => {
      const deps = makeDeps({
        anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
        compareGovernmentWarning: async () =>
          warningOutcome({ verdict: "MISMATCH", note: "Government Warning wording differs from the required text." }, notBold),
      });
      const response = await post(await buildFormData(), deps);
      const body = (await response.json()) as VerifySuccessResponse;
      createdApplicationIds.push(body.applicationId);
      expect(body.labelVerdict).toBe("FAIL");
    });

    // TRO-569: a MATCH with a "not-bold" prefix signal degrades to REVIEW,
    // with a reason naming the exact check (standing rule 26) — never a
    // silent PASS.
    it("a 'not-bold' signal routes an otherwise-MATCH warning to REVIEW with the named reason", async () => {
      const deps = makeDeps({
        anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
        compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, notBold),
      });
      const response = await post(await buildFormData(), deps);
      const body = (await response.json()) as VerifySuccessResponse;
      createdApplicationIds.push(body.applicationId);
      expect(body.labelVerdict).toBe("REVIEW");
      const warningRow = body.fields.find((row) => row.field === "government_warning");
      expect(warningRow?.verdict).toBe("NEEDS_REVIEW");
      expect(warningRow?.reviewReason).toBe("WARNING_MISMATCH");
      expect(warningRow?.reason).toBe("'GOVERNMENT WARNING' must print in bold type; the measured prefix is not bold.");
    });

    // "bold" and "uncertain" leave a MATCH clean — never accuse on
    // uncertainty (standing rule 12), and never accuse a compliant prefix.
    it("a 'bold' signal leaves a MATCH clean", async () => {
      const deps = makeDeps({
        anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
        compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, bold),
      });
      const response = await post(await buildFormData(), deps);
      const body = (await response.json()) as VerifySuccessResponse;
      createdApplicationIds.push(body.applicationId);
      expect(body.labelVerdict).toBe("PASS");
    });

    it("an 'uncertain' signal leaves a MATCH clean — never accuse on uncertainty", async () => {
      const deps = makeDeps({
        anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
        compareGovernmentWarning: async () => warningOutcome({ verdict: "MATCH" }, uncertain),
      });
      const response = await post(await buildFormData(), deps);
      const body = (await response.json()) as VerifySuccessResponse;
      createdApplicationIds.push(body.applicationId);
      expect(body.labelVerdict).toBe("PASS");
    });
  });
});

// TRO-482 / LH-061, PRD §8 — key protection. `checkRateLimit`/`reserveBudget`/
// `settleBudget` (`reserveBudget`/`settleBudget` renamed from
// `checkBudget`/`recordSpend` by TRO-566, which replaced the check-then-act
// pair with an atomic reservation) are all OPTIONAL on `VerifyRouteDeps`
// with an always-allow fallback inside `handleVerifyRequest` itself — every
// test ABOVE this point predates this ticket and needed zero changes to
// keep passing (confirmed: this file's pre-existing 20 cases pass
// unmodified). The blocks below are new coverage for the gate itself.
describe("POST /api/verify — rate limit gate (TRO-482)", () => {
  it("rejects with a friendly message and never calls the model when checkRateLimit says no", async () => {
    let extractCalled = false;
    const deps = makeDeps({
      checkRateLimit: () => ({
        allowed: false,
        message: "LabelHunter is getting more requests than it can handle right now. Wait 30 seconds and try again.",
      }),
      extractLabel: async (...args) => {
        extractCalled = true;
        return extractLabel(...args);
      },
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(429);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("RATE_LIMITED");
    expect(body.error.message.toLowerCase()).toMatch(/wait|moment|again/);
    expect(body.error.message).not.toMatch(/\b429\b/);
    expect(extractCalled).toBe(false);
  });

  it("proves the Nth+1 request within a real window is rejected — the real production limiter, not just a stub", async () => {
    // limit: 2 — real createFixedWindowLimiter/checkRateLimitPair, the same
    // production code `../../../server/rate-limit/instances.ts` wires by
    // default, just with a small limit so the test does not need 20+ calls.
    const ipLimiter = createFixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const globalLimiter = createFixedWindowLimiter({ limit: 1000, windowMs: 60_000 });
    const checkRateLimit = (request: Request) => checkRateLimitPair(request, ipLimiter, globalLimiter);

    const first = await post(await buildFormData(), makeDeps({ checkRateLimit, anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) }));
    expect(first.status).toBe(200);
    createdApplicationIds.push(((await first.json()) as VerifySuccessResponse).applicationId);

    const second = await post(await buildFormData(), makeDeps({ checkRateLimit, anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY) }));
    expect(second.status).toBe(200);
    createdApplicationIds.push(((await second.json()) as VerifySuccessResponse).applicationId);

    let thirdCalled = false;
    const third = await post(
      await buildFormData(),
      makeDeps({
        checkRateLimit,
        extractLabel: async (...args) => {
          thirdCalled = true;
          return extractLabel(...args);
        },
      }),
    );
    expect(third.status).toBe(429);
    const thirdBody = (await third.json()) as VerifyErrorResponse;
    expect(thirdBody.error.kind).toBe("RATE_LIMITED");
    expect(thirdCalled).toBe(false);
  });
});

describe("POST /api/verify — daily budget gate (TRO-482, reservation shape since TRO-566)", () => {
  it("rejects with a friendly message and never calls the model when the budget is exhausted", async () => {
    let extractCalled = false;
    const deps = makeDeps({
      reserveBudget: async () => ({ reserved: false, reservedUsd: 0, spentUsd: 5, budgetUsd: 5 }),
      extractLabel: async (...args) => {
        extractCalled = true;
        return extractLabel(...args);
      },
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("BUDGET_EXHAUSTED");
    expect(body.error.message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(body.error.message).not.toMatch(/\b503\b/);
    expect(extractCalled).toBe(false);
  });

  it("still allows the request through when the budget is NOT exhausted", async () => {
    const deps = makeDeps({
      reserveBudget: async (estimatedUsd) => ({ reserved: true, reservedUsd: estimatedUsd, spentUsd: 0.5 + estimatedUsd, budgetUsd: 5 }),
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
    });
    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(200);
    createdApplicationIds.push(((await response.json()) as VerifySuccessResponse).applicationId);
  });

  // TRO-566 finding 3 — a ledger read failure must fail closed (no model
  // call) with the DESIGNED 503 response, not an unhandled 500.
  it("returns a designed 503 SERVICE response, not a raw 500, when the budget check itself throws", async () => {
    let extractCalled = false;
    const deps = makeDeps({
      reserveBudget: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      extractLabel: async (...args) => {
        extractCalled = true;
        return extractLabel(...args);
      },
    });
    const response = await post(await buildFormData(), deps);

    expect(response.status).toBe(503);
    const body = (await response.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("SERVICE");
    expect(body.error.message).toBe(BUDGET_CHECK_UNAVAILABLE_MESSAGE);
    // Distinct from the exhausted message — a DB blip is not "come back
    // tomorrow."
    expect(body.error.message).not.toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(extractCalled).toBe(false);
  });
});

describe("POST /api/verify — real spend recording (TRO-482)", () => {
  // Pinned to a date nothing else in the suite ever uses. `daily_spend` is
  // a shared, date-keyed table (schema.ts) — daily-budget.test.ts's own
  // DB-integration tests read/write "today"'s row directly, and
  // vitest.config.ts's maxWorkers: 4 means a DIFFERENT test file can run
  // concurrently with this one. Sharing "today" between files would be a
  // real, if rare, cross-file race (one file's afterEach deleting the row
  // mid-read of another's); a private, far-future date makes this
  // describe block's own row impossible for any other test to touch.
  const ISOLATED_DAY = "2099-01-01";
  const ISOLATED_NOW = new Date(`${ISOLATED_DAY}T00:00:00Z`);

  afterEach(async () => {
    await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
  });

  it("records the REAL, measured cost of a successful Haiku call into the daily ledger", async () => {
    const deps = makeDeps({
      // makeMockMessage's own usage: 100 input tokens, 50 output tokens.
      anthropicClient: clientReturning(WELL_FORMED_EXTRACTION_BODY),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, ISOLATED_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, ISOLATED_NOW),
    });
    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(200);
    createdApplicationIds.push(((await response.json()) as VerifySuccessResponse).applicationId);

    const spent = await getTodaySpendUsd(db, ISOLATED_NOW);
    // HAIKU_4_5_PRICING (scripts/eval/usage.ts): $1/MTok in, $5/MTok out.
    // 100 * (1/1_000_000) + 50 * (5/1_000_000) = 0.00035 — the SAME real
    // formula the eval harness uses, not a re-derived approximation. The
    // REAL settled cost, not the reservation estimate reserveDailyBudget
    // held room for before the call.
    expect(spent).toBeCloseTo(0.00035, 6);
  });

  it("records nothing when the Haiku call itself fails — reserves, then refunds the reservation in full (TRO-566)", async () => {
    const deps = makeDeps({
      anthropicClient: fakeAnthropicClient(async () => {
        throw new APIConnectionError({ message: "network down" });
      }),
      reserveBudget: (estimatedUsd) => reserveDailyBudget(estimatedUsd, db, ISOLATED_NOW),
      settleBudget: (reservedUsd, realUsd) => settleBudgetReservation(reservedUsd, realUsd, db, ISOLATED_NOW),
    });
    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(503);

    const spent = await getTodaySpendUsd(db, ISOLATED_NOW);
    expect(spent).toBe(0);
  });

  it("settles the REAL captured usage when the model responded but its output failed validation (TRO-580)", async () => {
    // The paid API call happened; a HaikuExtractionError only means the
    // RESPONSE failed `parseExtractionResponse`. `usageCapture` already
    // captured its usage the moment the wrapped client answered, before
    // `extractLabel` threw — the reservation must settle for that REAL
    // cost, not refund to 0. Same gap, same fix shape as the extract
    // route's own regression test (TRO-576, `../extract/route.test.ts`):
    // the fake `extractLabel` makes one real call through the usage-
    // capture wrapper, registering usage the way a real call would, then
    // throws the validation error.
    const settleBudget = vi.fn(async (_reservedUsd: number, _realUsd: number) => {});
    const fakeUnderlyingClient = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "not the schema at all" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };
    const deps = makeDeps({
      anthropicClient: fakeUnderlyingClient as never,
      settleBudget,
      extractLabel: vi.fn(async (_image, options) => {
        await options?.client?.messages.create({} as never);
        throw new HaikuExtractionError(["model returned malformed JSON"]);
      }),
    });

    const response = await post(await buildFormData(), deps);
    expect(response.status).toBe(502);
    expect(settleBudget).toHaveBeenCalledTimes(1);
    // Second argument is the REAL settled cost, computed by the SAME
    // pricing function the route itself calls (`haikuCallCostUsd`) — not a
    // duplicated formula in the test — for the exact usage
    // (`makeMockMessage`'s own default: 100 input tokens, 50 output
    // tokens) the fake client reported above. Not the hardcoded 0 a
    // refund-in-full would pass.
    expect(settleBudget.mock.calls[0][1]).toBeCloseTo(haikuCallCostUsd(makeMockMessage("").usage), 10);
  });
});

/**
 * The production wiring itself (TRO-482, merge review round 1).
 *
 * Every other test in this file injects its own `deps`, so every other
 * test would still pass if `defaultDeps` silently lost a guard binding.
 * The route's guards are optional fields with an allow-by-default
 * fallback, so a lost binding does not throw — it serves the request and
 * calls Haiku. That is a fail-open shape, and this block is the only
 * thing that catches it.
 *
 * These tests call the real exported `POST`, with no `deps` argument, so
 * they exercise the same `defaultDeps` object production uses. They make
 * no model call: both guards run before the route reads the request body,
 * so a body-less request is enough.
 *
 * Each test uses its own `x-forwarded-for` value. The per-IP limiter keys
 * on that header (`getClientIp`), so no test can consume another's budget
 * and the block is order-independent.
 */
describe("POST /api/verify — the default (production) wiring is really bound", () => {
  function bareRequest(ip: string): Request {
    return new Request("http://localhost/api/verify", { method: "POST", headers: { "x-forwarded-for": ip } });
  }

  it("enforces the REAL per-IP rate limit through POST — fails if defaultDeps loses checkRateLimit", async () => {
    const ip = "203.0.113.10";
    const statuses: number[] = [];
    // One more than the real limit. Every earlier call is allowed by the
    // limiter and then fails body parsing with a 400, which is the proof
    // the guard let it through rather than the proof of anything else.
    for (let i = 0; i < VERIFY_IP_LIMIT + 1; i += 1) {
      statuses.push((await verifyPOST(bareRequest(ip))).status);
    }

    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(statuses[VERIFY_IP_LIMIT]).toBe(429);

    const rejected = await verifyPOST(bareRequest(ip));
    expect(rejected.status).toBe(429);
    const body = (await rejected.json()) as VerifyErrorResponse;
    expect(body.error.kind).toBe("RATE_LIMITED");
    expect(body.error.message).not.toBe("");
  });

  it("records REAL spend into daily_spend through the production wiring — fails if defaultDeps loses anthropicClient", async () => {
    // The test the merge review asked for, and the one that would have
    // caught the original bug. Before `defaultDeps` bound
    // `anthropicClient`, this route wrapped `undefined` for usage capture,
    // `takeLastUsage()` always answered null, `settleBudget` never ran a
    // real settlement, and `daily_spend` stayed empty forever — so the
    // budget guard read 0 and could never trip. A test that injects its
    // own recorder proves nothing about that; it has to be THIS object.
    //
    // So this runs the real exported `defaultDeps`, spread rather than
    // rebuilt, with exactly one field replaced: the warning comparator,
    // whose real implementation runs OCR. That is not the wiring under
    // test here, and skipping it keeps this test fast. `anthropicClient`,
    // `reserveBudget` and `settleBudget` are all the production bindings.
    //
    // No network call happens: the spy below intercepts the shared
    // client's own `messages.create`, which is the same object
    // `defaultDeps.anthropicClient` resolves to.
    const ISOLATED_DAY = "2099-06-03";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${ISOLATED_DAY}T12:00:00Z`));
    const createSpy = vi
      .spyOn(getDefaultExtractorClient().messages, "create")
      // makeMockMessage's own usage: 100 input tokens, 50 output tokens.
      .mockResolvedValue(makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY)) as never);
    try {
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));

      const request = new Request("http://localhost/api/verify", {
        method: "POST",
        body: await buildFormData(),
        headers: { "x-forwarded-for": "203.0.113.30" },
      });
      const response = await handleVerifyRequest(request, {
        ...defaultDeps,
        compareGovernmentWarning: warningNeedsReviewStub,
      });

      expect(response.status).toBe(200);
      createdApplicationIds.push(((await response.json()) as VerifySuccessResponse).applicationId);
      expect(createSpy).toHaveBeenCalledTimes(1);

      const rows = await db
        .select({ totalUsd: dailySpend.totalUsd })
        .from(dailySpend)
        .where(eq(dailySpend.spendDate, ISOLATED_DAY));

      // The row must EXIST and carry a real, non-zero cost. Before the
      // fix there was no row at all.
      expect(rows).toHaveLength(1);
      expect(rows[0].totalUsd).toBeGreaterThan(0);
      // HAIKU_4_5_PRICING (scripts/eval/usage.ts): $1/MTok in, $5/MTok
      // out. 100 * (1/1_000_000) + 50 * (5/1_000_000) = 0.00035.
      expect(rows[0].totalUsd).toBeCloseTo(0.00035, 6);
    } finally {
      createSpy.mockRestore();
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
      vi.useRealTimers();
    }
  });

  it("enforces the REAL daily budget through POST — fails if defaultDeps loses reserveBudget", async () => {
    // The default `reserveBudget` reads "today" from its own `new Date()`,
    // so this test moves the clock to the same private, far-future date
    // the spend-recording block above uses. That keeps the row this test
    // writes out of the way of daily-budget.test.ts, which reads and
    // writes the real today's row in a concurrent worker.
    const ISOLATED_DAY = "2099-06-01";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${ISOLATED_DAY}T12:00:00Z`));
    try {
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
      // Far above any DAILY_BUDGET_USD this deployment would configure,
      // and the largest value `numeric(12, 6)` accepts — the column must
      // round to an absolute value below 10^6 (schema.ts).
      await db.insert(dailySpend).values({ spendDate: ISOLATED_DAY, totalUsd: 999_999 });

      const response = await verifyPOST(bareRequest("203.0.113.11"));

      expect(response.status).toBe(503);
      const body = (await response.json()) as VerifyErrorResponse;
      expect(body.error.kind).toBe("BUDGET_EXHAUSTED");
      expect(body.error.message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    } finally {
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
      vi.useRealTimers();
    }
  });
});

/**
 * The same wiring question for `POST /api/batch/start` (TRO-482, merge
 * review round 1). That route builds its guard options inline in its own
 * `POST`, so this is the only test that reads that object.
 */
describe("POST /api/batch/start — the default (production) wiring is really bound", () => {
  it("enforces the REAL per-IP rate limit through POST — fails if POST loses checkRateLimit", async () => {
    const ip = "203.0.113.20";
    const bare = () =>
      new Request("http://localhost/api/batch/start", { method: "POST", headers: { "x-forwarded-for": ip } });
    const statuses: number[] = [];
    for (let i = 0; i < BATCH_START_IP_LIMIT + 1; i += 1) {
      statuses.push((await batchStartPOST(bare())).status);
    }

    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(statuses[BATCH_START_IP_LIMIT]).toBe(429);

    const rejected = await batchStartPOST(bare());
    expect(rejected.status).toBe(429);
    const body = (await rejected.json()) as BatchStartErrorResponse;
    expect(body.error.kind).toBe("RATE_LIMITED");
    expect(body.error.message).not.toBe("");
  });

  it("enforces the REAL daily budget through POST — fails if POST loses checkBudget", async () => {
    // Same clock-move and private-date reasoning as the verify budget
    // test above. A date of its own, so the two tests cannot collide.
    const ISOLATED_DAY = "2099-06-02";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${ISOLATED_DAY}T12:00:00Z`));
    try {
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
      await db.insert(dailySpend).values({ spendDate: ISOLATED_DAY, totalUsd: 999_999 });

      const response = await batchStartPOST(
        new Request("http://localhost/api/batch/start", { method: "POST", headers: { "x-forwarded-for": "203.0.113.21" } }),
      );

      expect(response.status).toBe(503);
      const body = (await response.json()) as BatchStartErrorResponse;
      expect(body.error.kind).toBe("BUDGET_EXHAUSTED");
      expect(body.error.message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    } finally {
      await db.delete(dailySpend).where(eq(dailySpend.spendDate, ISOLATED_DAY));
      vi.useRealTimers();
    }
  });
});
