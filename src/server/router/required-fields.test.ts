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

  it("requires alcohol_content for spirits, and marks it VERIFY (not settled) for beer and wine", () => {
    expect(REQUIRED_FIELD_TABLE.spirits.alcohol_content).toBe("required");
    expect(REQUIRED_FIELD_TABLE.beer.alcohol_content).toBe("verify");
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
