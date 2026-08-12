import { describe, expect, it } from "vitest";
import type { LabelRouterResult } from "../../src/server/router/types";
import {
  buildAllFieldsFlagged,
  buildFlaggedFields,
  buildFlaggedFieldsForEscalatedLabel,
  type FlaggableFieldRow,
} from "./flagged-fields";

describe("buildFlaggedFields", () => {
  it("returns one FlaggedField per row with a non-null reviewReason", () => {
    const rows: FlaggableFieldRow[] = [
      { field: "brand_name", reviewReason: null, reason: "matches" },
      { field: "government_warning", reviewReason: "WARNING_MISMATCH", reason: "wording differs" },
    ];
    expect(buildFlaggedFields(rows)).toEqual([
      { field: "government_warning", reviewReason: "WARNING_MISMATCH", trigger: "wording differs" },
    ]);
  });

  it("returns an empty array when every field matched", () => {
    const rows: FlaggableFieldRow[] = [
      { field: "brand_name", reviewReason: null, reason: "matches" },
      { field: "class_type", reviewReason: null, reason: "matches" },
    ];
    expect(buildFlaggedFields(rows)).toEqual([]);
  });

  it("carries the field's own reason text verbatim as the trigger", () => {
    const rows: FlaggableFieldRow[] = [
      { field: "alcohol_content", reviewReason: "AMBIGUOUS_ABV", reason: "Label's percent and proof don't agree." },
    ];
    expect(buildFlaggedFields(rows)[0].trigger).toBe("Label's percent and proof don't agree.");
  });
});

describe("buildAllFieldsFlagged", () => {
  it("flags every one of the five router fields", () => {
    const flagged = buildAllFieldsFlagged();
    expect(flagged.map((f) => f.field).sort()).toEqual(
      ["alcohol_content", "brand_name", "class_type", "government_warning", "net_contents"].sort(),
    );
  });

  it("gives every flagged field a non-empty trigger", () => {
    expect(buildAllFieldsFlagged().every((f) => f.trigger.length > 0)).toBe(true);
  });
});

function routerField(field: string, reviewReason: string | null, reason = "detail"): LabelRouterResult["fields"][number] {
  return {
    field: field as never,
    verdict: reviewReason ? "NEEDS_REVIEW" : "MATCH",
    labelValue: "x",
    applicationValue: "x",
    evidence: "x",
    confidence: 0.9,
    reason,
    resolvedBy: null,
    reviewReason: reviewReason as never,
  };
}

describe("buildFlaggedFieldsForEscalatedLabel", () => {
  it("uses the per-field reasons when at least one field carries one (the common case)", () => {
    const routerResult: LabelRouterResult = {
      labelVerdict: "REVIEW",
      headlineReason: "AMBIGUOUS_ABV",
      fields: [
        routerField("brand_name", null),
        routerField("class_type", null),
        routerField("alcohol_content", "AMBIGUOUS_ABV", "percent and proof disagree"),
        routerField("net_contents", null),
        routerField("government_warning", null),
      ],
    };
    const flagged = buildFlaggedFieldsForEscalatedLabel(routerResult);
    expect(flagged).toEqual([{ field: "alcohol_content", reviewReason: "AMBIGUOUS_ABV", trigger: "percent and proof disagree" }]);
  });

  it("falls back to flagging every field when a label-level blocker fires with no field individually flagged (the case-11 shape)", () => {
    const routerResult: LabelRouterResult = {
      labelVerdict: "REVIEW",
      headlineReason: "LOW_IMAGE_QUALITY",
      fields: [
        routerField("brand_name", null),
        routerField("class_type", null),
        routerField("alcohol_content", null),
        routerField("net_contents", null),
        routerField("government_warning", null),
      ],
    };
    const flagged = buildFlaggedFieldsForEscalatedLabel(routerResult);
    expect(flagged).toHaveLength(5);
    expect(flagged.every((f) => f.reviewReason === "LOW_IMAGE_QUALITY")).toBe(true);
    expect(flagged.map((f) => f.field).sort()).toEqual(
      ["alcohol_content", "brand_name", "class_type", "government_warning", "net_contents"].sort(),
    );
  });

  it("throws if labelVerdict is REVIEW but headlineReason is null (a router invariant violation, not a normal input)", () => {
    const routerResult: LabelRouterResult = {
      labelVerdict: "REVIEW",
      headlineReason: null,
      fields: [
        routerField("brand_name", null),
        routerField("class_type", null),
        routerField("alcohol_content", null),
        routerField("net_contents", null),
        routerField("government_warning", null),
      ],
    };
    expect(() => buildFlaggedFieldsForEscalatedLabel(routerResult)).toThrow(/router invariant violated/);
  });
});
