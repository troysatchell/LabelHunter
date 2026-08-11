import { describe, expect, it } from "vitest";
import {
  ResolverResponseError,
  deriveResolvedFields,
  parseResolverResponse,
  validateResolverResult,
} from "./response";
import { makeFlaggedFields, makeMockMessage, WELL_FORMED_RESOLVER_BODY } from "./test-support";
import type { RawResolverResponse } from "./types";

describe("validateResolverResult — well-formed response", () => {
  it("maps every field to the typed raw result", () => {
    const result = validateResolverResult(WELL_FORMED_RESOLVER_BODY);
    expect(result.overall).toBe("RESOLVED");
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].field).toBe("alcohol_content");
    expect(result.fields[0].disposition).toBe("RESOLVED_MATCH");
  });
});

describe("validateResolverResult — malformed responses fail loudly", () => {
  it("throws when overall is not one of the enum values", () => {
    const body = { ...WELL_FORMED_RESOLVER_BODY, overall: "MAYBE" };
    expect(() => validateResolverResult(body)).toThrow(ResolverResponseError);
    expect(() => validateResolverResult(body)).toThrow(/overall.*expected one of RESOLVED, NEEDS_HUMAN/);
  });

  it("throws when a field's disposition is not one of the enum values", () => {
    const body: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [{ ...WELL_FORMED_RESOLVER_BODY.fields[0], disposition: "MOSTLY_MATCH" as never }],
    };
    expect(() => validateResolverResult(body)).toThrow(/disposition.*expected one of/);
  });

  it("throws when a field's confidence is the wrong type", () => {
    const body = {
      overall: "RESOLVED",
      fields: [{ ...WELL_FORMED_RESOLVER_BODY.fields[0], confidence: "high" }],
    };
    expect(() => validateResolverResult(body)).toThrow(/confidence.*expected a number/);
  });

  it("throws when fields is missing entirely", () => {
    const { fields: _dropped, ...withoutFields } = WELL_FORMED_RESOLVER_BODY;
    let error: unknown;
    try {
      validateResolverResult(withoutFields);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ResolverResponseError);
    expect((error as ResolverResponseError).problems.join("\n")).toMatch(/fields.*expected an array/);
  });

  it("collects every problem in one pass, not just the first", () => {
    const body = {
      overall: "MAYBE",
      fields: [{ ...WELL_FORMED_RESOLVER_BODY.fields[0], confidence: "high" }],
    };
    let error: unknown;
    try {
      validateResolverResult(body);
    } catch (e) {
      error = e;
    }
    const problems = (error as ResolverResponseError).problems;
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join("\n")).toMatch(/overall/);
    expect(problems.join("\n")).toMatch(/confidence/);
  });
});

describe("deriveResolvedFields — the judges-only-brand/class rule (CP-1 §6.5)", () => {
  it("keeps the resolver's disposition as authoritative for a judged field (brand_name)", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        {
          field: "brand_name",
          disposition: "RESOLVED_MATCH",
          corrected_value: "Stone's Throw",
          evidence: "STONE'S THROW",
          reason: "The label reads Stone's Throw, matching the application.",
          confidence: 0.95,
        },
      ],
    };
    const flagged = [{ field: "brand_name" as const, reviewReason: "AMBIGUOUS_BRAND" as const, trigger: "t" }];
    const result = deriveResolvedFields(raw, flagged);
    expect(result.fields).toHaveLength(1);
    const field = result.fields[0];
    expect(field.kind).toBe("judged");
    if (field.kind !== "judged") throw new Error("expected a judged field");
    expect(field.disposition).toBe("RESOLVED_MATCH");
  });

  it("discards a correction field's RESOLVED_MATCH/RESOLVED_MISMATCH opinion — only needsHuman survives", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        {
          field: "government_warning",
          // The prompt forbids this (rule 5), but the schema does not
          // (CP-1 open question 12) — this fixture simulates the model
          // getting it wrong anyway, to prove the CODE layer defends
          // regardless of what the model outputs.
          disposition: "RESOLVED_MATCH",
          corrected_value: "GOVERNMENT WARNING: ...",
          evidence: "GOVERNMENT WARNING: ...",
          reason: "Re-transcribed the warning block.",
          confidence: 0.9,
        },
      ],
    };
    const flagged = [{ field: "government_warning" as const, reviewReason: "WARNING_MISMATCH" as const, trigger: "t" }];
    const result = deriveResolvedFields(raw, flagged);
    const field = result.fields[0];
    expect(field.kind).toBe("correction");
    if (field.kind !== "correction") throw new Error("expected a correction field");
    // No property on this object can carry a MATCH/MISMATCH opinion.
    expect(field).not.toHaveProperty("disposition");
    expect(field.needsHuman).toBe(false);
    expect(field.correctedValue).toBe("GOVERNMENT WARNING: ...");
  });

  it("preserves NEEDS_HUMAN on a correction field as real signal, not a discarded opinion", () => {
    const raw: RawResolverResponse = {
      overall: "NEEDS_HUMAN",
      fields: [
        {
          field: "alcohol_content",
          disposition: "NEEDS_HUMAN",
          corrected_value: null,
          evidence: "",
          reason: "Glare obscures the proof numeral even at full resolution.",
          confidence: 0.4,
        },
      ],
    };
    const flagged = [{ field: "alcohol_content" as const, reviewReason: "AMBIGUOUS_ABV" as const, trigger: "t" }];
    const result = deriveResolvedFields(raw, flagged);
    const field = result.fields[0];
    if (field.kind !== "correction") throw new Error("expected a correction field");
    expect(field.needsHuman).toBe(true);
    expect(result.outcome).toBe("needs-human");
  });

  it("recomputes overall as resolved when every flagged field is determinate, regardless of raw.overall", () => {
    const raw: RawResolverResponse = { ...WELL_FORMED_RESOLVER_BODY, overall: "NEEDS_HUMAN" };
    const result = deriveResolvedFields(raw, makeFlaggedFields());
    expect(result.outcome).toBe("resolved");
  });

  it("recomputes overall as needs-human when any flagged field is NEEDS_HUMAN, regardless of raw.overall", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        { ...WELL_FORMED_RESOLVER_BODY.fields[0], disposition: "NEEDS_HUMAN", corrected_value: null },
        WELL_FORMED_RESOLVER_BODY.fields[1],
      ],
    };
    const result = deriveResolvedFields(raw, makeFlaggedFields());
    expect(result.outcome).toBe("needs-human");
  });

  it("throws when a flagged field has no matching response entry", () => {
    const raw: RawResolverResponse = { overall: "RESOLVED", fields: [WELL_FORMED_RESOLVER_BODY.fields[0]] };
    expect(() => deriveResolvedFields(raw, makeFlaggedFields())).toThrow(/no response entry.*government_warning/);
  });

  it("throws when a flagged field has more than one matching response entry", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [WELL_FORMED_RESOLVER_BODY.fields[0], WELL_FORMED_RESOLVER_BODY.fields[0]],
    };
    const flagged = [{ field: "alcohol_content" as const, reviewReason: "AMBIGUOUS_ABV" as const, trigger: "t" }];
    expect(() => deriveResolvedFields(raw, flagged)).toThrow(/2 response entries.*alcohol_content/);
  });

  it("throws when a judged field is RESOLVED_MATCH but corrected_value is null — a decided judgment with no reading behind it", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        { field: "brand_name", disposition: "RESOLVED_MATCH", corrected_value: null, evidence: "x", reason: "x", confidence: 0.9 },
      ],
    };
    const flagged = [{ field: "brand_name" as const, reviewReason: "AMBIGUOUS_BRAND" as const, trigger: "t" }];
    expect(() => deriveResolvedFields(raw, flagged)).toThrow(/brand_name.*disposition is RESOLVED_MATCH but corrected_value is null/);
  });

  it("throws when a judged field is RESOLVED_MISMATCH but corrected_value is null", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        { field: "class_type", disposition: "RESOLVED_MISMATCH", corrected_value: null, evidence: "x", reason: "x", confidence: 0.9 },
      ],
    };
    const flagged = [{ field: "class_type" as const, reviewReason: "AMBIGUOUS_BRAND" as const, trigger: "t" }];
    expect(() => deriveResolvedFields(raw, flagged)).toThrow(/class_type.*disposition is RESOLVED_MISMATCH but corrected_value is null/);
  });

  it("does NOT throw when a judged field is NEEDS_HUMAN with a null corrected_value — that combination is legitimate", () => {
    const raw: RawResolverResponse = {
      overall: "NEEDS_HUMAN",
      fields: [
        { field: "brand_name", disposition: "NEEDS_HUMAN", corrected_value: null, evidence: "x", reason: "Cannot read this.", confidence: 0.2 },
      ],
    };
    const flagged = [{ field: "brand_name" as const, reviewReason: "AMBIGUOUS_BRAND" as const, trigger: "t" }];
    expect(() => deriveResolvedFields(raw, flagged)).not.toThrow();
  });

  it("throws when a correction field's disposition is decided (not NEEDS_HUMAN) but corrected_value is null", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        {
          field: "alcohol_content",
          disposition: "RESOLVED_MATCH", // discarded by the judges-only rule, but still a "decided" signal
          corrected_value: null,
          evidence: "x",
          reason: "x",
          confidence: 0.9,
        },
      ],
    };
    const flagged = [{ field: "alcohol_content" as const, reviewReason: "AMBIGUOUS_ABV" as const, trigger: "t" }];
    expect(() => deriveResolvedFields(raw, flagged)).toThrow(/alcohol_content.*disposition is RESOLVED_MATCH but corrected_value is null/);
  });

  it("ignores a response entry for a field that was not flagged — rule 6, 'do not change a field that is not flagged'", () => {
    const raw: RawResolverResponse = {
      overall: "RESOLVED",
      fields: [
        WELL_FORMED_RESOLVER_BODY.fields[0],
        WELL_FORMED_RESOLVER_BODY.fields[1],
        { field: "brand_name", disposition: "RESOLVED_MISMATCH", corrected_value: "Someone Else", evidence: "x", reason: "x", confidence: 0.9 },
      ],
    };
    const result = deriveResolvedFields(raw, makeFlaggedFields());
    expect(result.fields.map((f) => f.field)).toEqual(["alcohol_content", "government_warning"]);
  });
});

describe("parseResolverResponse — malformed responses fail loudly", () => {
  it("throws on a refused response", () => {
    const message = makeMockMessage("", { stop_reason: "refusal", content: [] });
    expect(() => parseResolverResponse(message, makeFlaggedFields())).toThrow(ResolverResponseError);
    expect(() => parseResolverResponse(message, makeFlaggedFields())).toThrow(/refus/i);
  });

  it("throws on a response that stopped before end_turn", () => {
    const message = makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY).slice(0, 20), { stop_reason: "max_tokens" });
    expect(() => parseResolverResponse(message, makeFlaggedFields())).toThrow(/max_tokens/);
  });

  it("throws when the response has no text content block", () => {
    const message = makeMockMessage("", { content: [] });
    expect(() => parseResolverResponse(message, makeFlaggedFields())).toThrow(/no text content block/);
  });

  it("throws when the response text is not valid JSON", () => {
    const message = makeMockMessage("{not json");
    expect(() => parseResolverResponse(message, makeFlaggedFields())).toThrow(/not valid JSON/);
  });

  it("parses a well-formed response end to end", () => {
    const message = makeMockMessage(JSON.stringify(WELL_FORMED_RESOLVER_BODY));
    const result = parseResolverResponse(message, makeFlaggedFields());
    expect(result.outcome).toBe("resolved");
    expect(result.fields).toHaveLength(2);
  });
});
