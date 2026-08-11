/**
 * Integration tests for the production comparator set (LH-013 / TRO-463) —
 * the ONE import site the verify pipeline (LH-015, TRO-465, in flight on a
 * sibling branch) wires into the router.
 *
 * These run the REAL comparators through the router's own `routeLabel`
 * (LH-012 / TRO-462, unchanged), proving TH-R11's acceptance evidence: the
 * OLD TOM DISTILLERY example verifies end-to-end across brand, class/type,
 * ABV, and net contents (the fifth field, the government warning, is
 * LH-020's own subsystem — CLEAN_WARNING_RESULT stands in for it here, the
 * same way the router's own tests do).
 */
import { describe, expect, it } from "vitest";
import { routeLabel } from "../router";
import { CLEAN_WARNING_RESULT, makeApplication, makeExtraction, makePreprocessing } from "../router/test-support";
import { productionComparators } from "./index";

describe("productionComparators — shape", () => {
  it("supplies all four comparator-driven fields", () => {
    expect(Object.keys(productionComparators).sort()).toEqual(
      ["alcohol_content", "brand_name", "class_type", "net_contents"].sort(),
    );
  });
});

describe("productionComparators — TH-R11: the OLD TOM DISTILLERY example, end to end", () => {
  it("PASSes a clean label across brand, class/type, ABV, and net contents", () => {
    const result = routeLabel(makeExtraction(), makeApplication(), productionComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    expect(result.labelVerdict).toBe("PASS");
    expect(result.headlineReason).toBeNull();
    expect(result.fields.every((row) => row.verdict === "MATCH")).toBe(true);
  });
});

describe("productionComparators — TH-R8: the STONE'S THROW flagship case, end to end", () => {
  it("MATCHes a label brand in a different case than the application files (golden-set case-14)", () => {
    const extraction = makeExtraction({
      brand_name: { value: "STONE'S THROW", evidence: "STONE'S THROW", confidence: 0.95, alternates: [] },
      class_type: { value: "STRAIGHT BOURBON WHISKEY", evidence: "STRAIGHT BOURBON WHISKEY", confidence: 0.95, alternates: [] },
    });
    const application = makeApplication({ brandName: "Stone's Throw", classType: "Straight Bourbon Whiskey" });

    const result = routeLabel(extraction, application, productionComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    const brandRow = result.fields.find((row) => row.field === "brand_name");
    const classRow = result.fields.find((row) => row.field === "class_type");
    expect(brandRow?.verdict).toBe("MATCH");
    expect(classRow?.verdict).toBe("MATCH");
    expect(result.labelVerdict).toBe("PASS");
  });
});

describe("productionComparators — a genuine ABV mismatch fails the label (golden-set case-05/06 shape)", () => {
  it("MISMATCHes and rolls up to FAIL at high confidence", () => {
    const extraction = makeExtraction({
      alcohol_content: { value: "40% Alc./Vol. (80 Proof)", evidence: "40% Alc./Vol. (80 Proof)", confidence: 0.95, alternates: [] },
    });
    const result = routeLabel(extraction, makeApplication({ alcoholContentPercent: 45 }), productionComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    const abvRow = result.fields.find((row) => row.field === "alcohol_content");
    expect(abvRow?.verdict).toBe("MISMATCH");
    expect(result.labelVerdict).toBe("FAIL");
  });
});

describe("required-fields.ts — beer's alcohol_content VERIFY cell, closed by this ticket (27 CFR 7.65(a))", () => {
  it("PASSes a beer label that omits ABV on both the label and the application (golden-set case-02)", () => {
    const extraction = makeExtraction({
      beverage_type: { value: "beer", evidence: "Imperial Stout", confidence: 0.9, alternates: [] },
      alcohol_content: { value: null, evidence: "", confidence: 0, alternates: [] },
    });
    const application = makeApplication({ beverageType: "beer", alcoholContentPercent: undefined });

    const result = routeLabel(extraction, application, productionComparators, CLEAN_WARNING_RESULT, makePreprocessing());

    const abvRow = result.fields.find((row) => row.field === "alcohol_content");
    expect(abvRow?.verdict).toBe("MATCH"); // not required, and absent — a clean pass, not MISSING_REQUIRED_FIELD.
    expect(result.labelVerdict).toBe("PASS");
    expect(result.headlineReason).toBeNull();
  });
});
