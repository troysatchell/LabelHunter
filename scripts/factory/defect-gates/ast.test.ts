import ts from "typescript";
import { describe, expect, it } from "vitest";
import { enclosingFunctionName, parse, walk } from "./ast";

/** Finds the first call expression in the fixture and names its enclosing scope. */
function nameOfFirstCall(source: string): string {
  const sourceFile = parse("src/sample.ts", source);
  let found: string | null = null;
  walk(sourceFile, (node) => {
    if (found !== null) return;
    if (ts.isCallExpression(node)) found = enclosingFunctionName(node);
  });
  if (found === null) throw new Error("fixture has no call expression");
  return found;
}

describe("enclosingFunctionName", () => {
  it("names a top-level function declaration", () => {
    expect(nameOfFirstCall(`function one() { call(); }`)).toBe("one");
  });

  it("names an arrow function assigned to a const", () => {
    expect(nameOfFirstCall(`const one = () => { call(); };`)).toBe("one");
  });

  it("falls back to <module> for a call outside any function", () => {
    expect(nameOfFirstCall(`call();`)).toBe("<module>");
  });

  it("qualifies a class method with its class name", () => {
    expect(nameOfFirstCall(`class A { validate() { call(); } }`)).toBe("A.validate");
  });

  it("gives two same-named methods on different classes different identities", () => {
    const a = nameOfFirstCall(`class A { validate() { call(); } }`);
    const b = nameOfFirstCall(`class B { validate() { call(); } }`);
    expect(a).not.toBe(b);
  });

  it("qualifies an object-literal method with the object's own const name", () => {
    expect(nameOfFirstCall(`const A = { validate() { call(); } };`)).toBe("A.validate");
  });

  it("qualifies a nested object-literal method with its property key", () => {
    expect(
      nameOfFirstCall(`const registry = { A: { validate() { call(); } } };`),
    ).toBe("A.validate");
  });

  it("falls back to <anonymous> for a method on an unnamed class expression", () => {
    expect(nameOfFirstCall(`const x = class { validate() { call(); } };`)).toBe(
      "<anonymous>.validate",
    );
  });
});
