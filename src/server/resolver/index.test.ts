import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ResolverNotEscalatedError, getDefaultResolverClient, resolveEscalatedLabel } from "./index";
import { SONNET_RESOLVER_MODEL } from "./request";
import type { ResolverDb } from "./queue";
import { makeMockMessage, makeResolverInput, WELL_FORMED_RESOLVER_BODY } from "./test-support";
import type { RawResolverResponse } from "./types";

/** Fakes just the surface `resolveEscalatedLabel` uses — never a real Anthropic client in the unit suite. */
function fakeClient(create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>) {
  return { messages: { create: vi.fn(create) } } as unknown as Anthropic;
}

/** Fakes just the Drizzle surface `insertReviewQueueEntry` uses. */
function fakeDb(nextId = 42) {
  const values = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: nextId }]),
  });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as unknown as ResolverDb, insert, values };
}

describe("resolveEscalatedLabel — never on the happy path (TH-R19)", () => {
  it("throws ResolverNotEscalatedError when the router result is PASS", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db } = fakeDb();
    const input = makeResolverInput({ router: { labelVerdict: "PASS", headlineReason: null, fields: [] } });
    await expect(resolveEscalatedLabel(input, { client, db })).rejects.toThrow(ResolverNotEscalatedError);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("throws ResolverNotEscalatedError when the router result is FAIL", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db } = fakeDb();
    const input = makeResolverInput({ router: { labelVerdict: "FAIL", headlineReason: null, fields: [] } });
    await expect(resolveEscalatedLabel(input, { client, db })).rejects.toThrow(/labelVerdict "FAIL", not "REVIEW"/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("throws when flaggedFields is empty, even on a REVIEW result", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db } = fakeDb();
    const input = makeResolverInput({ flaggedFields: [] });
    await expect(resolveEscalatedLabel(input, { client, db })).rejects.toThrow(/empty flaggedFields/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe("resolveEscalatedLabel — resolved outcome", () => {
  it("calls Sonnet once, parses the response, and inserts one review_queue row", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db, insert, values } = fakeDb(7);
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const sentParams = vi.mocked(client.messages.create).mock.calls[0][0];
    expect(sentParams.model).toBe(SONNET_RESOLVER_MODEL);

    expect(result.outcome).toBe("resolved");
    expect(result.reviewQueueId).toBe(7);
    expect(insert).toHaveBeenCalledTimes(1);
    const insertedValues = values.mock.calls[0][0];
    expect(insertedValues.verificationId).toBe(input.verificationId);
    expect(insertedValues.reason).toBe(input.router.headlineReason);
    expect(insertedValues.resolverOutput.outcome).toBe("resolved");
  });
});

describe("resolveEscalatedLabel — needs-human outcome", () => {
  it("still inserts a review_queue row when the resolver cannot decide", async () => {
    const needsHumanBody: RawResolverResponse = {
      overall: "NEEDS_HUMAN",
      fields: [
        { ...WELL_FORMED_RESOLVER_BODY.fields[0], disposition: "NEEDS_HUMAN", corrected_value: null },
        WELL_FORMED_RESOLVER_BODY.fields[1],
      ],
    };
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(needsHumanBody)));
    const { db, insert } = fakeDb(8);
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(result.outcome).toBe("needs-human");
    expect(result.reviewQueueId).toBe(8);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEscalatedLabel — malformed response propagates, no queue insertion", () => {
  it("does not insert a review_queue row when the response fails validation", async () => {
    const client = fakeClient(async () => makeMockMessage("{not json"));
    const { db, insert } = fakeDb();
    await expect(resolveEscalatedLabel(makeResolverInput(), { client, db })).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("getDefaultResolverClient", () => {
  it("returns the same client instance on every call", () => {
    const first = getDefaultResolverClient();
    const second = getDefaultResolverClient();
    expect(first).toBe(second);
  });

  it("sets an explicit timeout and zero retries", () => {
    const client = getDefaultResolverClient();
    expect(client.timeout).toBe(60_000);
    expect(client.maxRetries).toBe(0);
  });
});
