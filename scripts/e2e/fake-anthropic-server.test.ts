/**
 * Real unit tests for the fake Anthropic server's decision logic
 * (TRO-479). This module's canned responses are load-bearing for every
 * E2E spec — a bug here would silently break the whole suite (a spec
 * would just hang or fail with a confusing downstream error, not point
 * back at this file) — so the pure selection logic gets the same
 * red-first regression coverage any other production module in this repo
 * gets, not just an assumption that it works.
 */
import { describe, expect, it } from "vitest";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { WELL_FORMED_EXTRACTION_BODY } from "../../src/server/extractor/test-support";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import {
  extractFirstImageBase64,
  FAILURE_TRIGGER_MAX_BYTES,
  isFailureTriggerImage,
  selectResponseForRequest,
} from "./fake-anthropic-server";

function haikuRequestWithImage(base64Data: string) {
  return {
    model: HAIKU_EXTRACTOR_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Data } },
          { type: "text", text: "read this label" },
        ],
      },
    ],
  };
}

/** `n` decoded bytes of base64, built by round-tripping a real buffer —
 * simpler and less error-prone than hand-computing the base64 padding
 * math for an exact target string length. */
function base64OfLength(byteLength: number): string {
  return Buffer.alloc(byteLength, 1).toString("base64");
}

describe("extractFirstImageBase64", () => {
  it("finds the image block's base64 data inside a real request shape", () => {
    const body = haikuRequestWithImage("abc123");
    expect(extractFirstImageBase64(body)).toBe("abc123");
  });

  it("returns null when there is no messages array", () => {
    expect(extractFirstImageBase64({})).toBeNull();
  });

  it("returns null when no content block is an image", () => {
    const body = { messages: [{ content: [{ type: "text", text: "hello" }] }] };
    expect(extractFirstImageBase64(body)).toBeNull();
  });
});

describe("isFailureTriggerImage", () => {
  it("is true just under the threshold", () => {
    const data = base64OfLength(FAILURE_TRIGGER_MAX_BYTES - 1);
    expect(isFailureTriggerImage(data)).toBe(true);
  });

  it("is false at exactly the threshold", () => {
    const data = base64OfLength(FAILURE_TRIGGER_MAX_BYTES);
    expect(isFailureTriggerImage(data)).toBe(false);
  });

  it("is false well above the threshold, matching a real resized photo's rough size", () => {
    const data = base64OfLength(FAILURE_TRIGGER_MAX_BYTES * 4);
    expect(isFailureTriggerImage(data)).toBe(false);
  });
});

describe("selectResponseForRequest", () => {
  it("returns a well-formed 200 extraction message for a normal-sized Haiku request", () => {
    const normalSizedImage = base64OfLength(FAILURE_TRIGGER_MAX_BYTES * 3);
    const result = selectResponseForRequest(haikuRequestWithImage(normalSizedImage));

    expect(result.status).toBe(200);
    const message = result.body as { model: string; stop_reason: string; content: { type: string; text: string }[] };
    expect(message.model).toBe(HAIKU_EXTRACTOR_MODEL);
    expect(message.stop_reason).toBe("end_turn");
    const textBlock = message.content.find((block) => block.type === "text");
    expect(textBlock).toBeDefined();
    expect(JSON.parse((textBlock as { text: string }).text)).toEqual(WELL_FORMED_EXTRACTION_BODY);
  });

  it("returns a 500 service failure for a Haiku request whose image is under the failure threshold", () => {
    const tinyImage = base64OfLength(FAILURE_TRIGGER_MAX_BYTES - 1);
    const result = selectResponseForRequest(haikuRequestWithImage(tinyImage));

    expect(result.status).toBe(500);
    const body = result.body as { type: string; error: { message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("returns a well-formed 200 resolver message for a Sonnet request, even with a tiny image", () => {
    // The failure trigger only ever applies to the Haiku extractor call —
    // route.ts never calls Sonnet inline (TH-R19), so no E2E spec needs a
    // way to fail the resolver call specifically, and this fake server
    // must not accidentally apply the Haiku-only trigger to it.
    const tinyImage = base64OfLength(FAILURE_TRIGGER_MAX_BYTES - 1);
    const request = { model: SONNET_RESOLVER_MODEL, messages: haikuRequestWithImage(tinyImage).messages };
    const result = selectResponseForRequest(request);

    expect(result.status).toBe(200);
    const message = result.body as { model: string; content: { type: string; text: string }[] };
    expect(message.model).toBe(SONNET_RESOLVER_MODEL);
    const textBlock = message.content.find((block) => block.type === "text");
    const parsed = JSON.parse((textBlock as { text: string }).text) as { overall: string; fields: { field: string }[] };
    expect(parsed.overall).toBe("RESOLVED");
    // Every possible flagged field must be answered exactly once — see
    // this module's own comment on RESOLVER_BODY.
    const fieldNames = parsed.fields.map((f) => f.field);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect(fieldNames).toEqual(
      expect.arrayContaining(["brand_name", "class_type", "alcohol_content", "net_contents", "government_warning", "beverage_type"]),
    );
  });

  it("rejects a request naming a model neither the extractor nor the resolver ever sends", () => {
    // Loud, not silent (standing rule 13): this app is the only caller of
    // this fake server, so an unrecognized model is either a caller bug
    // or real drift from HAIKU_EXTRACTOR_MODEL/SONNET_RESOLVER_MODEL — an
    // earlier version of this function treated it as "must be the
    // extractor" and returned a normal 200, which would have hidden
    // exactly that drift (CodeRabbit finding, TRO-479 local review round 1).
    const normalSizedImage = base64OfLength(FAILURE_TRIGGER_MAX_BYTES * 3);
    const result = selectResponseForRequest({ model: "some-future-model", messages: haikuRequestWithImage(normalSizedImage).messages });

    expect(result.status).toBe(400);
    const body = result.body as { type: string; error: { message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("rejects a request with no model field at all", () => {
    const normalSizedImage = base64OfLength(FAILURE_TRIGGER_MAX_BYTES * 3);
    const result = selectResponseForRequest({ messages: haikuRequestWithImage(normalSizedImage).messages });

    expect(result.status).toBe(400);
  });
});
