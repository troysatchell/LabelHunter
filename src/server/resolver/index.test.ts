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

/** Fakes just the Drizzle surface `insertReviewQueueEntry`,
 * `findExistingReviewQueueEntry`, and (TRO-511) `updateReviewQueueEntryResolution`
 * use. `existingRow` defaults to `undefined` — "no review_queue row exists
 * yet for this verification" — so every existing test in this file
 * exercises the pre-flight lookup's "not found" path without having to know
 * about it. `updateResult` controls what the fake UPDATE's `.returning()`
 * resolves to — `undefined` means "matched a row" (the common case for a
 * `"pending"` `existingRow`); pass `null` to simulate the TRO-506-shaped
 * race where a competing caller already won. */
function fakeDb(
  nextId = 42,
  existingRow?: { id: number; resolverOutput: unknown; resolverSkipReason?: unknown },
  updateResult: "matched" | "lost-race" = "matched",
) {
  const values = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: nextId }]),
  });
  const insert = vi.fn().mockReturnValue({ values });
  const findFirst = vi.fn().mockResolvedValue(existingRow);
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(updateResult === "matched" ? [{ id: existingRow?.id ?? nextId }] : []),
    }),
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const db = { insert, update, query: { reviewQueue: { findFirst } } } as unknown as ResolverDb;
  return { db, insert, values, findFirst, update, updateSet };
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

describe("resolveEscalatedLabel — duplicate verificationId never pays for a second Sonnet call", () => {
  it("returns the existing row's resolution without calling the model, when one already exists", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const existingResolution = {
      outcome: "resolved" as const,
      fields: [
        {
          kind: "judged" as const,
          field: "brand_name" as const,
          disposition: "RESOLVED_MATCH" as const,
          correctedValue: "Stone's Throw",
          evidence: "STONE'S THROW",
          reason: "Already resolved on an earlier call.",
          confidence: 0.9,
        },
      ],
    };
    const { db, insert, findFirst } = fakeDb(99, { id: 5, resolverOutput: existingResolution });
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(result.reviewQueueId).toBe(5);
    expect(result.outcome).toBe("resolved");
    expect(result.fields).toEqual(existingResolution.fields);
  });

  it("proceeds normally — calls the model and inserts — when no row exists yet", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db, insert, findFirst } = fakeDb(7);
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(result.reviewQueueId).toBe(7);
  });

  it("throws rather than silently reusing or re-running the model, when the existing row's shape is unrecognized", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    // db:seed.ts's own ad hoc shape, predating this ticket — no outcome/fields.
    const legacyShape = { resolvedAbvPercent: 13.5, note: "...", confidence: 0.93 };
    const { db } = fakeDb(99, { id: 5, resolverOutput: legacyShape });
    const input = makeResolverInput();

    await expect(resolveEscalatedLabel(input, { client, db })).rejects.toThrow(/unrecognized shape|does not match/);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe("resolveEscalatedLabel — fills in a pre-existing bare row (TRO-511)", () => {
  it("updates the pending row's resolverOutput instead of inserting a second row", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db, insert, update, updateSet, findFirst } = fakeDb(999, { id: 5, resolverOutput: null, resolverSkipReason: null });
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0][0];
    expect(setArg.resolverOutput.outcome).toBe("resolved");
    expect(result.reviewQueueId).toBe(5); // the PRE-EXISTING row's id, not a freshly-inserted one
    expect(result.outcome).toBe("resolved");
  });

  it("recovers by re-reading the winning row when the update loses a TRO-506-shaped race, instead of throwing", async () => {
    const client = fakeClient(async () => makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY)));
    const { db, findFirst } = fakeDb(999, { id: 5, resolverOutput: null, resolverSkipReason: null }, "lost-race");
    // The re-read after losing the race finds the OTHER caller's resolution.
    const winningResolution = {
      outcome: "resolved" as const,
      fields: [
        {
          kind: "judged" as const,
          field: "brand_name" as const,
          disposition: "RESOLVED_MATCH" as const,
          correctedValue: "Stone's Throw",
          evidence: "STONE'S THROW",
          reason: "The other worker's call won the race.",
          confidence: 0.88,
        },
      ],
    };
    findFirst.mockResolvedValueOnce({ id: 5, resolverOutput: null, resolverSkipReason: null }); // pre-flight check
    findFirst.mockResolvedValueOnce({ id: 5, resolverOutput: winningResolution, resolverSkipReason: null }); // post-race re-read
    const input = makeResolverInput();

    const result = await resolveEscalatedLabel(input, { client, db });

    expect(client.messages.create).toHaveBeenCalledTimes(1); // this call still happened — the money is spent
    expect(result.reviewQueueId).toBe(5);
    expect(result.fields).toEqual(winningResolution.fields);
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
