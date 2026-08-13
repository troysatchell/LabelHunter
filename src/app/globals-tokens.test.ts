/**
 * TRO-578: the design-token gate. Every `font-size`, `gap`, and
 * `border-radius` declaration outside `:root` must reference a token
 * (`var(--font-*)`, `var(--space-*)`, `var(--radius-*)`), never a raw rem
 * literal. This is what keeps the twelve-ad-hoc-values drift (the state
 * this ticket cleaned up) from growing back one hardcoded value at a
 * time — a new literal fails the unit suite instead of waiting for a
 * reviewer to notice.
 *
 * Same posture as `globals-contrast.test.ts`: parse the real stylesheet
 * the app ships, assert the invariant mechanically.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = fileURLToPath(new URL("./globals.css", import.meta.url));
const cssText = readFileSync(CSS_PATH, "utf8");

/** The stylesheet minus the `:root` block — token DEFINITIONS live there
 * and are the one legitimate home for raw values. */
function outsideRoot(css: string): string {
  const rootStart = css.indexOf(":root");
  if (rootStart === -1) throw new Error("globals.css has no :root block");
  const rootEnd = css.indexOf("}", rootStart);
  return css.slice(0, rootStart) + css.slice(rootEnd + 1);
}

const body = outsideRoot(cssText);

describe("globals.css — token discipline (TRO-578)", () => {
  it.each([
    ["font-size", /^\s*font-size:\s*[0-9.]+rem/gm],
    ["gap", /^\s*gap:\s*[0-9.]+rem/gm],
    ["border-radius", /^\s*border-radius:\s*[0-9.]+rem/gm],
  ])("has no raw rem literal in any %s declaration outside :root", (_prop, pattern) => {
    const literals = body.match(pattern) ?? [];
    expect(literals, `raw values found: ${literals.map((l) => l.trim()).join("; ")}`).toHaveLength(0);
  });

  it("defines every token family the declarations reference", () => {
    for (const family of ["--space-", "--font-", "--radius-"]) {
      // Every var(--family-x) used in the body has a definition in :root.
      const used = new Set([...body.matchAll(new RegExp(`var\\((${family}[a-z-]+)\\)`, "g"))].map((m) => m[1]));
      for (const token of used) {
        expect(cssText, `token ${token} is used but never defined`).toMatch(new RegExp(`${token}:\\s*[0-9.]+rem`));
      }
      expect(used.size, `no ${family}* tokens are used at all`).toBeGreaterThan(0);
    }
  });

  it("reserves weight 700 for the page title and the verdict banner", () => {
    // The hierarchy rule, mechanically: count 700s. Two owners only.
    const sevenHundreds = body.match(/font-weight:\s*700/g) ?? [];
    expect(sevenHundreds).toHaveLength(2);
  });
});
