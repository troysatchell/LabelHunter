import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../lib/db";
import { applications, fieldResults, reviewQueue, verifications } from "../../../lib/db/schema";
import { extractLabel } from "../../../server/extractor";
import { makeMockMessage, WELL_FORMED_EXTRACTION_BODY } from "../../../server/extractor/test-support";
import { MAX_UPLOAD_BYTES, preprocessImage } from "../../../server/preprocessing";
import { productionComparators } from "../../../server/comparators";
import type { WarningComparatorResult } from "../../../server/router";
import type { CompareGovernmentWarningFromImageInput } from "../../../server/warning";
import { saveLabelImage } from "../../../server/storage/local-file-storage";
import { handleVerifyRequest, type VerifyRouteDeps } from "./route";
import type { VerifyErrorResponse, VerifySuccessResponse } from "./types";

// This suite makes NO live Anthropic call and writes NO file into the real
// `var/uploads` — every Anthropic response is a canned `makeMockMessage`
// (same pattern as `src/server/extractor/index.test.ts`), and every saved
// image lands in a per-test scratch directory, deleted in `afterEach`. It
// DOES use the real worktree Postgres database (`DATABASE_URL`, sourced
// from `.factory-env`) to assert persistence — TRO-465's brief calls for
// this explicitly.

let scratchDir: string;
const createdApplicationIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro465-route-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  // Cascades to label_images, verifications, field_results, review_queue
  // (every FK in schema.ts is ON DELETE CASCADE) — one delete per test
  // application is enough to leave the shared worktree DB clean.
  for (const id of createdApplicationIds.splice(0)) {
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
async function warningNeedsReviewStub(): Promise<WarningComparatorResult> {
  return { verdict: "NEEDS_REVIEW", reviewReason: "WARNING_MISMATCH" };
}

function makeDeps(overrides: Partial<VerifyRouteDeps> = {}): VerifyRouteDeps {
  return {
    db,
    preprocessImage,
    extractLabel,
    compareGovernmentWarning: warningNeedsReviewStub,
    saveLabelImage: (bytes, originalFilename) => saveLabelImage(bytes, originalFilename, { baseDir: scratchDir }),
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
      return { verdict: "MATCH" };
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
      compareGovernmentWarning: async () => ({ verdict: "MATCH", note: "Government Warning matches the required text." }),
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
      compareGovernmentWarning: async () => ({
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
        return { verdict: "MATCH" };
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
});
