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
    ["font-size", /^\s*font-size:\s*([^;]+);/gm],
    ["gap", /^\s*gap:\s*([^;]+);/gm],
    ["border-radius", /^\s*border-radius:\s*([^;]+);/gm],
  ])("has no raw rem literal anywhere in a %s value outside :root", (_prop, pattern) => {
    // The whole value through the semicolon, not just its first token — a
    // mixed value (`var(--space-row) 0.85rem`) or a rem inside calc() must
    // fail too (CodeRabbit finding, TRO-578 review round 1).
    const offenders = [...body.matchAll(pattern)].filter((m) => /\d\s*rem/.test(m[1])).map((m) => m[0].trim());
    expect(offenders, `raw rem values found: ${offenders.join("; ")}`).toHaveLength(0);
  });

  it("defines every token family the declarations reference — in :root itself", () => {
    // Definitions must live in the :root block; a component-local custom
    // property must not satisfy this (CodeRabbit finding, TRO-578 review
    // round 1).
    const rootStart = cssText.indexOf(":root");
    const rootBlock = cssText.slice(rootStart, cssText.indexOf("}", rootStart));
    for (const family of ["--space-", "--font-", "--radius-"]) {
      const used = new Set([...body.matchAll(new RegExp(`var\\((${family}[a-z-]+)\\)`, "g"))].map((m) => m[1]));
      for (const token of used) {
        expect(rootBlock, `token ${token} is used but not defined in :root`).toMatch(
          new RegExp(`${token}:\\s*[0-9.]+rem`),
        );
      }
      expect(used.size, `no ${family}* tokens are used at all`).toBeGreaterThan(0);
    }
  });

  it("reserves weight 700 for the page title and the verdict banner", () => {
    // Both named owners hold a 700, and the total count is exactly two —
    // naming the owners keeps a swap (two DIFFERENT 700s) from passing the
    // bare count (CodeRabbit finding, TRO-578 review round 1).
    for (const owner of [".page__title", ".label-verdict-banner"]) {
      const start = body.indexOf(`${owner} {`);
      expect(start, `${owner} rule not found`).toBeGreaterThanOrEqual(0);
      const block = body.slice(start, body.indexOf("}", start));
      expect(block, `${owner} must own a font-weight: 700`).toMatch(/font-weight:\s*700/);
    }
    const sevenHundreds = body.match(/font-weight:\s*700/g) ?? [];
    expect(sevenHundreds).toHaveLength(2);
  });
});
