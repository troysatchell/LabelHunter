import { describe, expect, it } from "vitest";
import { violationIdentity } from "./identity";

describe("violationIdentity", () => {
  it("is stable when only whitespace differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every( p )");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(   p )");
    expect(a).toBe(b);
  });

  it("is stable across newlines in the node text", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(\n  p\n)");
    expect(a).toBe(b);
  });

  it("differs when the enclosing function differs", () => {
    const a = violationIdentity("r", "src/a.ts", "one", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "two", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when the file differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/b.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when the rule differs", () => {
    const a = violationIdentity("one", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("two", "src/a.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when keyword and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "new Date()");
    const b = violationIdentity("r", "src/a.ts", "fn", "newDate()");
    expect(a).not.toBe(b);
  });

  it("differs when typeof and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "typeof x");
    const b = violationIdentity("r", "src/a.ts", "fn", "typeofx");
    expect(a).not.toBe(b);
  });

  it("differs when return and identifier merge without space", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "return x");
    const b = violationIdentity("r", "src/a.ts", "fn", "returnx");
    expect(a).not.toBe(b);
  });
});
