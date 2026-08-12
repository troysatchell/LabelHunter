/**
 * Tests for `resolver-snapshot.ts` (LH-041 / TRO-474, CP-3 §2.3).
 */
import { describe, expect, it } from "vitest";
import { makeFlaggedFields, makeRouterResult } from "../resolver/test-support";
import type { FieldResultRow, LabelRouterResult } from "../router/types";
import { buildResolverInputSnapshot, deriveFlaggedFields, parseResolverInputSnapshot, RESOLVER_INPUT_SCHEMA_VERSION } from "./resolver-snapshot";
import { makeExtraction } from "../router/test-support";

describe("deriveFlaggedFields", () => {
  it("matches the resolver ticket's own fixture on field + reviewReason for a field-specific escalation (AMBIGUOUS_ABV + WARNING_MISMATCH)", () => {
    // Cross-check against LH-014's own test fixture (../resolver/test-support.ts)
    // — if this ticket's derivation logic disagrees on WHICH fields escalate
    // and WHY, that is a real bug worth catching here. `trigger` text is not
    // compared: `makeFlaggedFields()` hand-authors a more detailed sentence
    // for its own illustrative purposes, while this derivation deliberately
    // reuses the router's own `FieldResultRow.reason` — exactly the source
    // `FlaggedField.trigger`'s own doc comment names as the intended one
    // ("../resolver/types.ts": "typically the router's own
    // FieldResultRow.reason for this field, so the model is shown the same
    // sentence a human reviewer would see").
    const router = makeRouterResult();
    const flagged = deriveFlaggedFields(router);
    expect(flagged.map((f) => ({ field: f.field, reviewReason: f.reviewReason }))).toEqual(
      makeFlaggedFields().map((f) => ({ field: f.field, reviewReason: f.reviewReason })),
    );
    // And the trigger really is the router's own per-field reason text, not
    // a hand-written second copy.
    for (const f of flagged) {
      const row = router.fields.find((r) => r.field === f.field);
      expect(f.trigger).toBe(row?.reason);
    }
  });

  it("falls back to the label's headlineReason for a field marked NEEDS_REVIEW with no reviewReason of its own (a label-level blocker, CP-3 §2.3)", () => {
    const rows: FieldResultRow[] = [
      {
        field: "brand_name",
        verdict: "NEEDS_REVIEW",
        labelValue: null,
        applicationValue: "Old Tom Distillery",
        evidence: "",
        confidence: 0.9,
        reason: "The label could not be read clearly enough to compare.",
        resolvedBy: null,
        reviewReason: null, // LOW_IMAGE_QUALITY already explains the whole label — field-level reason stays null
      },
    ];
    const router: LabelRouterResult = { labelVerdict: "REVIEW", headlineReason: "LOW_IMAGE_QUALITY", fields: rows };
    const flagged = deriveFlaggedFields(router);
    expect(flagged).toEqual([{ field: "brand_name", reviewReason: "LOW_IMAGE_QUALITY", trigger: rows[0].reason }]);
  });

  it("flags every field when the label escalated but no single field row is individually NEEDS_REVIEW", () => {
    // A real, reachable case: e.g. CONFLICTING_EXTRACTION fired from
    // beverage-type disagreement or a warning present/transcription
    // mismatch — neither trips any of the 5 comparator-field rows'
    // own verdict, yet the label-level blocker still routes to REVIEW.
    const rows: FieldResultRow[] = (["brand_name", "class_type", "alcohol_content", "net_contents", "government_warning"] as const).map(
      (field) => ({
        field,
        verdict: "MATCH",
        labelValue: "x",
        applicationValue: "x",
        evidence: "X",
        confidence: 0.95,
        reason: "Matches the application.",
        resolvedBy: null,
        reviewReason: null,
      }),
    );
    const router: LabelRouterResult = { labelVerdict: "REVIEW", headlineReason: "CONFLICTING_EXTRACTION", fields: rows };
    const flagged = deriveFlaggedFields(router);
    expect(flagged).toHaveLength(5);
    expect(flagged.every((f) => f.reviewReason === "CONFLICTING_EXTRACTION")).toBe(true);
    expect(new Set(flagged.map((f) => f.field))).toEqual(new Set(rows.map((r) => r.field)));
  });

  it("returns an empty array for a clean PASS (defensive — never called by a correct caller)", () => {
    const rows: FieldResultRow[] = [
      { field: "brand_name", verdict: "MATCH", labelValue: "x", applicationValue: "x", evidence: "X", confidence: 0.95, reason: "Matches.", resolvedBy: null, reviewReason: null },
    ];
    const router: LabelRouterResult = { labelVerdict: "PASS", headlineReason: null, fields: rows };
    expect(deriveFlaggedFields(router)).toEqual([]);
  });
});

describe("buildResolverInputSnapshot / parseResolverInputSnapshot round trip", () => {
  it("round-trips through JSON (as it will through a real jsonb column) unchanged", () => {
    const extraction = makeExtraction();
    const router = makeRouterResult();
    const flaggedFields = makeFlaggedFields();
    const snapshot = buildResolverInputSnapshot(extraction, router, flaggedFields);
    expect(snapshot.schemaVersion).toBe(RESOLVER_INPUT_SCHEMA_VERSION);

    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    const parsed = parseResolverInputSnapshot(roundTripped);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot).toEqual(snapshot);
    }
  });

  it("rejects a missing schemaVersion — never guesses at a compatible reading (CP-3 §2.3)", () => {
    const { schemaVersion: _drop, ...withoutVersion } = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    const parsed = parseResolverInputSnapshot(withoutVersion);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/schemaVersion/);
  });

  it("rejects an unsupported schemaVersion", () => {
    const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    const parsed = parseResolverInputSnapshot({ ...snapshot, schemaVersion: "2" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/schemaVersion/);
  });

  it("rejects a non-object value", () => {
    expect(parseResolverInputSnapshot(null).ok).toBe(false);
    expect(parseResolverInputSnapshot("a string").ok).toBe(false);
    expect(parseResolverInputSnapshot(42).ok).toBe(false);
  });

  it("rejects a snapshot missing extraction, router, or flaggedFields", () => {
    const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    expect(parseResolverInputSnapshot({ ...snapshot, extraction: undefined }).ok).toBe(false);
    expect(parseResolverInputSnapshot({ ...snapshot, router: undefined }).ok).toBe(false);
    expect(parseResolverInputSnapshot({ ...snapshot, flaggedFields: undefined }).ok).toBe(false);
  });

  it("buildResolverInputSnapshot itself rejects an empty flaggedFields — never writes a RESOLVE row nothing can act on", () => {
    expect(() => buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), [])).toThrow(/flaggedFields must not be empty/);
  });

  it("parseResolverInputSnapshot independently rejects a raw value whose flaggedFields is empty — defends the READ side against more than just this module's own writer (a hand-crafted or corrupted row)", () => {
    const snapshot = buildResolverInputSnapshot(makeExtraction(), makeRouterResult(), makeFlaggedFields());
    const parsed = parseResolverInputSnapshot({ ...snapshot, flaggedFields: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/flaggedFields/);
  });
});
