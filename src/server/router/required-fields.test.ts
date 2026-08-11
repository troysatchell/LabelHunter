import { describe, expect, it } from "vitest";
import { isFieldRequired, REQUIRED_FIELD_TABLE } from "./required-fields";

describe("REQUIRED_FIELD_TABLE — CP-1 §5.3's table, implemented exactly as given", () => {
  it("requires brand, class/type, net contents, and the warning for every beverage type", () => {
    for (const beverageType of ["beer", "wine", "spirits"] as const) {
      const row = REQUIRED_FIELD_TABLE[beverageType];
      expect(row.brand_name).toBe("required");
      expect(row.class_type).toBe("required");
      expect(row.net_contents).toBe("required");
      expect(row.government_warning).toBe("required");
    }
  });

  it("requires alcohol_content for spirits (27 CFR 5.65) and does not require it for beer (27 CFR 7.65(a), federal law)", () => {
    expect(REQUIRED_FIELD_TABLE.spirits.alcohol_content).toBe("required");
    expect(REQUIRED_FIELD_TABLE.beer.alcohol_content).toBe("not_required");
  });

  it("marks wine's alcohol_content VERIFY — the real rule (27 CFR 4.36(a)) is conditional on ABV and class/type wording, which this table cannot express as a flat cell", () => {
    expect(REQUIRED_FIELD_TABLE.wine.alcohol_content).toBe("verify");
  });
});

describe("isFieldRequired — the fail-safe reading of a VERIFY cell", () => {
  it("treats 'required' as required", () => {
    expect(isFieldRequired("required")).toBe(true);
  });

  it("treats 'not_required' as not required", () => {
    expect(isFieldRequired("not_required")).toBe(false);
  });

  it("treats 'verify' (an unsettled regulatory claim) as required — fails safe", () => {
    expect(isFieldRequired("verify")).toBe(true);
  });
});
