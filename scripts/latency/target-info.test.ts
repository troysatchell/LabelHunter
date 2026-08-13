/**
 * Tests for `target-info.ts` (TRO-539). Pure functions, no I/O, no live
 * call, no real money.
 */
import { describe, expect, it } from "vitest";
import { buildPipelineScope, buildTargetInfo } from "./target-info";

const RENDER_YAML = `
services:
  - type: web
    name: labelhunter-web
    plan: starter
`;

describe("buildPipelineScope", () => {
  it("never claims LH-020/the warning comparator is unmerged — the TRO-539 provenance-trap fix", () => {
    expect(buildPipelineScope("in-process")).not.toMatch(/LH-020 not merged/i);
    expect(buildPipelineScope("http")).not.toMatch(/LH-020 not merged/i);
  });

  it("names the warning comparator and its OCR deadline for both boundaries", () => {
    for (const boundary of ["in-process", "http"] as const) {
      const scope = buildPipelineScope(boundary);
      expect(scope).toMatch(/warning comparator/i);
      expect(scope).toMatch(/OCR/);
      expect(scope).toMatch(/2000ms/);
    }
  });

  it("names TH-R19's cascade rule for both boundaries", () => {
    for (const boundary of ["in-process", "http"] as const) {
      expect(buildPipelineScope(boundary)).toMatch(/TH-R19/);
    }
  });

  it("labels the in-process boundary as NOT a real HTTP round-trip", () => {
    expect(buildPipelineScope("in-process")).toMatch(/Boundary: in-process/);
    expect(buildPipelineScope("in-process")).toMatch(/NOT a real HTTP round-trip/);
  });

  it("labels the http boundary as a real network round-trip, distinct from in-process", () => {
    const scope = buildPipelineScope("http");
    expect(scope).toMatch(/Boundary: http/);
    expect(scope).toMatch(/real multipart POST over the network/);
    expect(scope).not.toMatch(/NOT a real HTTP round-trip/);
  });

  it("produces two different strings for the two boundaries — proves this is derived, not one constant reused", () => {
    expect(buildPipelineScope("in-process")).not.toBe(buildPipelineScope("http"));
  });
});

describe("buildTargetInfo", () => {
  it("in-process mode (url=null): boundary in-process, everything else null", () => {
    expect(buildTargetInfo(null, RENDER_YAML)).toEqual({
      boundary: "in-process",
      host: null,
      url: null,
      renderPlan: null,
    });
  });

  it("http mode against the render.yaml host: boundary http, host/url/plan all populated", () => {
    expect(buildTargetInfo("https://labelhunter-web.onrender.com", RENDER_YAML)).toEqual({
      boundary: "http",
      host: "labelhunter-web.onrender.com",
      url: "https://labelhunter-web.onrender.com",
      renderPlan: "starter",
    });
  });

  it("http mode against localhost: boundary http, host/url set, renderPlan null — never a false Render claim", () => {
    expect(buildTargetInfo("http://localhost:3874", RENDER_YAML)).toEqual({
      boundary: "http",
      host: "localhost:3874",
      url: "http://localhost:3874",
      renderPlan: null,
    });
  });

  it("http mode with renderYamlText unavailable: renderPlan null, does not throw", () => {
    expect(buildTargetInfo("https://labelhunter-web.onrender.com", null)).toEqual({
      boundary: "http",
      host: "labelhunter-web.onrender.com",
      url: "https://labelhunter-web.onrender.com",
      renderPlan: null,
    });
  });

  it("records host WITH a non-default port, url unmodified", () => {
    const info = buildTargetInfo("http://localhost:4874/", RENDER_YAML);
    expect(info.host).toBe("localhost:4874");
    expect(info.url).toBe("http://localhost:4874/");
  });
});
