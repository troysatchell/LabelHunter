/**
 * Tests for `render-target.ts` (TRO-539). Pure functions over synthetic
 * YAML text — no filesystem read, no network, no live call, no real
 * money. `render.yaml` itself has its own regression coverage
 * (`scripts/deploy/render-yaml.test.ts`); this file only checks the
 * hostname-matching/plan-derivation logic these two functions add.
 */
import { describe, expect, it } from "vitest";
import { deriveRenderPlanForHost, findRenderWebService } from "./render-target";

const REAL_SHAPED_YAML = `
services:
  - type: web
    name: labelhunter-web
    plan: starter
    runtime: node
  - type: worker
    name: labelhunter-worker
    plan: starter
databases:
  - name: labelhunter-db
    plan: basic-256mb
`;

describe("findRenderWebService", () => {
  it("finds the type: web service and derives its onrender.com hostname", () => {
    expect(findRenderWebService(REAL_SHAPED_YAML)).toEqual({
      name: "labelhunter-web",
      plan: "starter",
      expectedHost: "labelhunter-web.onrender.com",
    });
  });

  it("returns null when there is no type: web service", () => {
    const yaml = `
services:
  - type: worker
    name: labelhunter-worker
    plan: starter
`;
    expect(findRenderWebService(yaml)).toBeNull();
  });

  it("returns null when services is missing entirely", () => {
    expect(findRenderWebService("databases:\n  - name: labelhunter-db\n")).toBeNull();
  });

  it("returns null on YAML that does not parse", () => {
    expect(findRenderWebService("services: [this is not: valid: yaml: at all")).toBeNull();
  });

  it("returns null on YAML that parses to a non-object (a bare scalar)", () => {
    expect(findRenderWebService("just a plain string")).toBeNull();
  });

  it("returns null when the web service has no plan", () => {
    const yaml = `
services:
  - type: web
    name: labelhunter-web
`;
    expect(findRenderWebService(yaml)).toBeNull();
  });
});

describe("deriveRenderPlanForHost", () => {
  it("returns the plan when hostname matches render.yaml's own web service", () => {
    expect(deriveRenderPlanForHost("labelhunter-web.onrender.com", REAL_SHAPED_YAML)).toBe("starter");
  });

  it("matches case-insensitively (RFC 4343)", () => {
    expect(deriveRenderPlanForHost("LabelHunter-Web.OnRender.Com", REAL_SHAPED_YAML)).toBe("starter");
  });

  it("returns null for a different host — localhost, e.g. a fake-server validation run", () => {
    expect(deriveRenderPlanForHost("localhost:3874", REAL_SHAPED_YAML)).toBeNull();
  });

  it("returns null for an unrelated onrender.com host — proves this is a real match, not a substring guess", () => {
    expect(deriveRenderPlanForHost("some-other-app.onrender.com", REAL_SHAPED_YAML)).toBeNull();
  });

  it("returns null when render.yaml has no web service at all", () => {
    expect(deriveRenderPlanForHost("labelhunter-web.onrender.com", "services: []\n")).toBeNull();
  });

  it("is not hard-coded — two different render.yaml texts for the same host produce two different plans", () => {
    const proPlanYaml = REAL_SHAPED_YAML.replace("plan: starter", "plan: pro");
    expect(deriveRenderPlanForHost("labelhunter-web.onrender.com", proPlanYaml)).toBe("pro");
    expect(deriveRenderPlanForHost("labelhunter-web.onrender.com", REAL_SHAPED_YAML)).toBe("starter");
  });
});
