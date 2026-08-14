import { describe, expect, it } from "vitest";
import { WILD_LABEL_PROMPT_VERSION, WILD_LABEL_REQUESTS, buildWildLabelPrompt, type WildLabelRequest } from "./wildLabelPrompt";

const REQUEST: WildLabelRequest = {
  caseId: "case-fixture",
  beverageType: "spirits",
  brandName: "Fixture Distillers",
  classType: "Straight Bourbon Whiskey",
  abvText: "45% Alc./Vol. (90 Proof)",
  netContentsText: "750 mL",
  warningText: "GOVERNMENT WARNING: fixture text.",
  designBrief: "Design direction: plain fixture label.",
};

describe("buildWildLabelPrompt", () => {
  it("interpolates every requested field", () => {
    const prompt = buildWildLabelPrompt(REQUEST);
    expect(prompt).toContain('"Fixture Distillers"');
    expect(prompt).toContain('"Straight Bourbon Whiskey"');
    expect(prompt).toContain('"45% Alc./Vol. (90 Proof)"');
    expect(prompt).toContain('"750 mL"');
    expect(prompt).toContain("GOVERNMENT WARNING: fixture text.");
    expect(prompt).toContain("Design direction: plain fixture label.");
  });

  it("omits the alcohol content line entirely when abvText is empty", () => {
    const prompt = buildWildLabelPrompt({ ...REQUEST, abvText: "" });
    expect(prompt).not.toContain("Alcohol content line");
  });

  it("states no bottle, no can, no scene -- artwork only", () => {
    const prompt = buildWildLabelPrompt(REQUEST);
    expect(prompt).toContain("no bottle, no can, no shadow, and no background scene");
  });

  it("includes the fictional-brand guardrail on every request, not just some", () => {
    for (const request of WILD_LABEL_REQUESTS) {
      const prompt = buildWildLabelPrompt(request);
      expect(prompt, request.caseId).toContain("fictional brand created for software testing only");
      expect(prompt, request.caseId).toContain("Do not depict, reference, or imitate any real");
    }
  });

  it("never leaves an interpolation placeholder unresolved", () => {
    const prompt = buildWildLabelPrompt(REQUEST);
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toMatch(/\{.*\}/);
  });

  it("exposes a stable prompt version for generationMetadata", () => {
    expect(WILD_LABEL_PROMPT_VERSION).toBe("v1");
  });
});

describe("WILD_LABEL_REQUESTS", () => {
  it("has about 5 requests, per the ticket", () => {
    expect(WILD_LABEL_REQUESTS.length).toBeGreaterThanOrEqual(5);
    expect(WILD_LABEL_REQUESTS.length).toBeLessThanOrEqual(6);
  });

  it("has a unique caseId for every request", () => {
    const ids = WILD_LABEL_REQUESTS.map((r) => r.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("varies beverage type across the set -- not all one type", () => {
    const types = new Set(WILD_LABEL_REQUESTS.map((r) => r.beverageType));
    expect(types.size).toBeGreaterThan(1);
  });

  it("varies the design brief across the set -- no two requests share layout/typeface/color direction", () => {
    const briefs = WILD_LABEL_REQUESTS.map((r) => r.designBrief);
    expect(new Set(briefs).size).toBe(briefs.length);
  });

  it("produces a distinct compiled prompt for every request", () => {
    const prompts = WILD_LABEL_REQUESTS.map((r) => buildWildLabelPrompt(r));
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("never names a real, well-known brand in any request's fields", () => {
    // A cheap, honest guard, not a legal review: the obvious real spirits/
    // beer/wine brand names this repo's own golden-set cases already use
    // as counter-examples (case-14..16's STONE'S THROW variants are
    // themselves fictional) must never appear in a wild-label brand name.
    const realBrandNames = ["Jack Daniel", "Jim Beam", "Budweiser", "Guinness", "Absolut", "Grey Goose", "Crown Royal"];
    for (const request of WILD_LABEL_REQUESTS) {
      for (const real of realBrandNames) {
        expect(request.brandName, request.caseId).not.toContain(real);
      }
    }
  });
});
