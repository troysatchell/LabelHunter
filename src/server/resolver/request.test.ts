import { describe, expect, it } from "vitest";
import { SONNET_RESOLVER_MODEL, buildResolverRequestParams } from "./request";
import { RESOLVER_JSON_SCHEMA } from "./schema";
import { ResolverInputError } from "./input-validation";
import { makeResolverApplication, makeResolverInput } from "./test-support";

describe("buildResolverRequestParams", () => {
  it("uses the CP-1 §6.6 model", () => {
    expect(SONNET_RESOLVER_MODEL).toBe("claude-sonnet-5");
    const params = buildResolverRequestParams(makeResolverInput());
    expect(params.model).toBe("claude-sonnet-5");
  });

  it("never sets temperature — claude-sonnet-5 returns a 400 for sampling parameters (CHANGES.md TRO-460)", () => {
    const params = buildResolverRequestParams(makeResolverInput());
    expect(params).not.toHaveProperty("temperature");
  });

  it("never sets thinking — adaptive thinking is on by default on claude-sonnet-5 (CP-1 §6.6)", () => {
    const params = buildResolverRequestParams(makeResolverInput());
    expect(params).not.toHaveProperty("thinking");
  });

  it("carries output_config.format with the resolver schema, never the deprecated output_format", () => {
    const params = buildResolverRequestParams(makeResolverInput());
    expect(params).not.toHaveProperty("output_format");
    expect(params.output_config?.format).toEqual({ type: "json_schema", schema: RESOLVER_JSON_SCHEMA });
  });

  it("sets output_config.effort to high, CP-1 §6.6's starting point", () => {
    const params = buildResolverRequestParams(makeResolverInput());
    expect(params.output_config?.effort).toBe("high");
  });

  it("sends the image content block before the text block, matching CP-1 §6.3's draft order", () => {
    const input = makeResolverInput();
    const params = buildResolverRequestParams(input);
    expect(params.messages).toHaveLength(1);
    const content = params.messages[0].content;
    if (typeof content === "string" || !Array.isArray(content)) {
      throw new Error("expected an array of content blocks");
    }
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("text");
    if (content[0].type !== "image" || content[0].source.type !== "base64") {
      throw new Error("expected a base64 image content block");
    }
    expect(content[0].source.data).toBe(input.image.data);
    expect(content[0].source.media_type).toBe(input.image.mediaType);
  });

  it("throws ResolverInputError instead of sending a request built from an implausibly long value", () => {
    const input = makeResolverInput({ application: makeResolverApplication({ brandName: "A".repeat(1000) }) });
    expect(() => buildResolverRequestParams(input)).toThrow(ResolverInputError);
  });
});
