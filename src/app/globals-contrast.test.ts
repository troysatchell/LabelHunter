/**
 * Guards the Notion-style palette (TRO-573) against a future contrast
 * regression the way TRO-480 and TRO-570 checked it by hand: read the real
 * custom-property values out of `globals.css` and run the same WCAG formula
 * `src/lib/utils/contrast.ts` exposes. A future palette edit that breaks a
 * pair fails here, not in a live screenshot months later.
 *
 * Also asserts the file is light-only (TRO-573 drops dark mode) — this is
 * the one check that is false against `globals.css` before this ticket's
 * change, since the file still carries a `prefers-color-scheme: dark`
 * block at HEAD~1.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, WCAG_AA_TEXT, WCAG_AA_UI } from "../lib/utils/contrast";

const CSS_PATH = path.join(__dirname, "globals.css");
const css = fs.readFileSync(CSS_PATH, "utf8");

/** Pulls `--name: #hex;` declarations out of the file's one `:root { }`
 * block. Deliberately simple — this repo's own custom properties are all
 * plain 6-digit hex, never `rgb()`/`hsl()`/a variable reference, so a real
 * CSS parser would be more machinery than the file needs. */
function readRootColorTokens(cssText: string): Record<string, string> {
  const rootMatch = /:root\s*\{([^}]*)\}/.exec(cssText);
  if (!rootMatch) {
    throw new Error("globals.css has no :root block");
  }
  const tokens: Record<string, string> = {};
  const declPattern = /(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = declPattern.exec(rootMatch[1])) !== null) {
    tokens[match[1]] = match[2].toUpperCase();
  }
  return tokens;
}

describe("globals.css color palette (TRO-573)", () => {
  it("is light-only -- no prefers-color-scheme: dark block", () => {
    // Matches an actual `@media (prefers-color-scheme: dark)` rule, not the
    // bare string -- this file's own header comment names
    // "prefers-color-scheme" while explaining why the file has none, and a
    // loose string match would break the moment that wording shifted.
    expect(css).not.toMatch(/@media\b[^{]*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/);
  });

  const tokens = readRootColorTokens(css);
  const require_ = (name: string): string => {
    const value = tokens[name];
    if (!value) throw new Error(`globals.css :root has no ${name}`);
    return value;
  };

  it("body text clears the AA text floor against both backgrounds", () => {
    expect(contrastRatio(require_("--color-text"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(require_("--color-text"), require_("--color-bg-alt"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it("muted text clears the AA text floor", () => {
    expect(contrastRatio(require_("--color-text-muted"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it("the functional border (inputs, buttons, cards) clears the AA UI-component floor", () => {
    expect(contrastRatio(require_("--color-border"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_UI);
  });

  it("white button text clears the AA text floor against the button background", () => {
    expect(contrastRatio("#FFFFFF", require_("--color-button-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio("#FFFFFF", require_("--color-button-bg-hover"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it("the focus ring clears the AA UI-component floor against the page background", () => {
    expect(contrastRatio(require_("--color-focus-ring"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_UI);
  });

  it("each verdict color clears the AA text floor against its own tint background", () => {
    expect(contrastRatio(require_("--color-match"), require_("--color-match-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(require_("--color-mismatch"), require_("--color-mismatch-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(require_("--color-review"), require_("--color-review-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it("each verdict color also clears the AA text floor against the plain page background", () => {
    // Verdict text appears on tint backgrounds today, but nothing stops a
    // future layout from putting it directly on --color-bg (e.g. an icon
    // label) -- both floors get checked so that case is covered too.
    expect(contrastRatio(require_("--color-match"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(require_("--color-mismatch"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    expect(contrastRatio(require_("--color-review"), require_("--color-bg"))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });
});
