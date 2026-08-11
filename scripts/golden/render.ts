/**
 * Golden-set label renderer (TRO-497 / LH-004, design doc §2 `render.ts`).
 *
 * Turns one golden-set case's `label` ground truth into a clean, exact-text
 * label image. The renderer draws the label's literal fields — brand,
 * class/type, ABV line, net contents, and the government warning — with no
 * paraphrasing and no reformatting. Whatever string a case's spec carries is
 * the string this renderer puts on the image, byte for byte. That is the
 * whole point of the render-first design (design doc §1): an image model
 * can mangle exact text; this renderer never does.
 *
 * Uses Playwright's bundled Chromium (already a repo dependency for
 * `pnpm test:e2e`) to lay out HTML/CSS and screenshot it — the design
 * doc's own choice for this file. Chromium's text layout wraps the
 * government warning paragraph for free; a hand-rolled SVG line-breaker
 * would not. No network call: the HTML is fully inline, with no remote
 * fonts or images.
 *
 * KNOWN LIMITATION: font stacks below name system fonts (Helvetica/Arial,
 * plus generic `cursive`/`fantasy` fallbacks for the two odd-typography
 * cases), not fonts committed to the repo. Design doc §2 says "Fonts are
 * committed to the repo" — this renderer does not do that yet. Practical
 * effect: `pnpm golden:build` is deterministic on one machine (proven by
 * `render.test.ts`'s determinism test — same content, same browser, same
 * OS font substitution, same pixels every run), but re-running it on a
 * different OS could pick different font-substitution results. Committing
 * real font files and wiring `@font-face` would close this gap; deferred
 * here rather than picking a font quickly without checking its license.
 */
import { chromium, type Page } from "@playwright/test";
import type { GoldenSetCase } from "../../src/lib/golden-set/types";

/**
 * Fixed canvas size for every rendered label. Never changes per case —
 * `degrade.ts`'s region math (`LABEL_REGIONS` below) depends on it staying
 * constant.
 */
export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 800;

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Named pixel regions on the rendered canvas. These MUST stay in sync with
 * the `top`/`left`/`width`/`height` values baked into `buildLabelHtml`'s
 * `<style>` block below — every element is absolutely positioned so these
 * numbers are exact, never measured from font metrics. `degrade.ts` targets
 * a region-specific effect (glare, low light) by name, never by guessing
 * coordinates.
 *
 * - `brand` — just the brand-name line (case-17's glare narrows to this;
 *   case-21's low light does not, see `front` below).
 * - `front` — brand + class/type together, the union `brand` sits inside.
 *   Case-21's "front label" low light dims both fields at once, matching
 *   its expected result (both `brandName` and `classType` go NEEDS_REVIEW).
 * - `content` — the ABV line and the net-contents line. No committed case
 *   currently degrades this region; it is named for completeness and for
 *   any future case that does.
 * - `warning` — the government warning block. Sized to the printed
 *   paragraph itself (roughly 4 wrapped lines at the default warning font
 *   size, with margin) rather than to whatever canvas space is left —
 *   a region-targeted effect (glare, low light) must actually cross the
 *   text, not the blank space below it.
 */
export const LABEL_REGIONS: Record<
  "brand" | "front" | "content" | "warning",
  PixelRect
> = {
  brand: { x: 60, y: 60, width: 880, height: 140 },
  front: { x: 60, y: 60, width: 880, height: 240 },
  content: { x: 60, y: 340, width: 880, height: 140 },
  warning: { x: 60, y: 520, width: 880, height: 200 },
};

/**
 * Escapes text for HTML *text content* only — `&`, `<`, `>`. Every
 * interpolation in `buildLabelHtml` lands inside a `<div>`'s text content,
 * never inside a quoted attribute, so `"` and `'` need no escaping here.
 * Leaving them untouched matters beyond minimalism: a brand name like
 * `STONE'S THROW` (case-14, TH-R8) must appear in the rendered HTML byte
 * for byte, not as `STONE&#39;S THROW` — the exact-text guarantee (design
 * doc §1) is meant to be checked with a plain substring comparison, not an
 * HTML-entity-aware one.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BASE_FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const SCRIPT_FONT_STACK =
  '"Brush Script MT", "Apple Chancery", "Snell Roundhand", cursive';
const BLACKLETTER_FONT_STACK = '"Blackletter", "UnifrakturMaguntia", fantasy';
const DEFAULT_WARNING_FONT_SIZE_PX = 24;
const TINY_WARNING_FONT_SIZE_PX = 9;

interface StyleOverride {
  readonly brandFontFamily?: string;
  readonly classTypeFontFamily?: string;
  readonly warningFontSizePx?: number;
}

/**
 * Per-case rendering variants for the two categories whose "imperfection"
 * is a print choice, not a photo condition. Design doc §4 lists only
 * rotate/perspective/glare/low-light/blur as `degrade.ts` transforms — tiny
 * print and an unusual font are baked into the label at render time
 * instead, the same way a real print shop would set them. Keyed by exact
 * `caseId`, never a substring or category match, so a future case never
 * silently inherits a style meant for a different one.
 */
const CASE_STYLE_OVERRIDES: Record<string, StyleOverride> = {
  "case-23-tiny-warning-text-standard-bottle": {
    warningFontSizePx: TINY_WARNING_FONT_SIZE_PX,
  },
  "case-24-tiny-warning-text-miniature-bottle": {
    warningFontSizePx: TINY_WARNING_FONT_SIZE_PX,
  },
  "case-25-odd-typography-script-brand": {
    brandFontFamily: SCRIPT_FONT_STACK,
  },
  "case-26-odd-typography-blackletter-class-type": {
    classTypeFontFamily: BLACKLETTER_FONT_STACK,
  },
};

function styleFor(caseId: string): Required<StyleOverride> {
  const override = CASE_STYLE_OVERRIDES[caseId] ?? {};
  return {
    brandFontFamily: override.brandFontFamily ?? BASE_FONT_STACK,
    classTypeFontFamily: override.classTypeFontFamily ?? BASE_FONT_STACK,
    warningFontSizePx: override.warningFontSizePx ?? DEFAULT_WARNING_FONT_SIZE_PX,
  };
}

/** The slice of a `GoldenSetCase` the renderer reads. Keeps this module decoupled from the full case shape. */
export type RenderableCase = Pick<GoldenSetCase, "caseId" | "label">;

/**
 * Builds the full HTML document for one case's clean label render. A pure
 * function — no I/O, no browser — so its exact-text guarantee is testable
 * directly: the government warning text this function embeds is the case
 * spec's literal string, escaped for HTML but otherwise untouched.
 */
export function buildLabelHtml(renderCase: RenderableCase): string {
  const { caseId, label } = renderCase;
  const style = styleFor(caseId);

  const abvLine = label.abvPresent
    ? `<div class="line">${escapeHtml(label.abvText)}</div>`
    : "";
  const netContentsLine = `<div class="line">${escapeHtml(label.netContentsText)}</div>`;
  const warningHtml = label.governmentWarningPresent
    ? escapeHtml(label.governmentWarningText)
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${CANVAS_WIDTH}px;
    height: ${CANVAS_HEIGHT}px;
    background: #ffffff;
  }
  .canvas {
    position: relative;
    width: ${CANVAS_WIDTH}px;
    height: ${CANVAS_HEIGHT}px;
    background: #ffffff;
  }
  .brand {
    position: absolute;
    left: ${LABEL_REGIONS.brand.x}px;
    top: ${LABEL_REGIONS.brand.y}px;
    width: ${LABEL_REGIONS.brand.width}px;
    height: ${LABEL_REGIONS.brand.height}px;
    display: flex;
    align-items: center;
    font-family: ${style.brandFontFamily};
    font-size: 60px;
    font-weight: 700;
    color: #111111;
  }
  .classType {
    position: absolute;
    left: 60px;
    top: 210px;
    width: 880px;
    height: 90px;
    display: flex;
    align-items: center;
    font-family: ${style.classTypeFontFamily};
    font-size: 34px;
    font-weight: 500;
    color: #333333;
  }
  .divider {
    position: absolute;
    left: 60px;
    width: 880px;
    height: 2px;
    background: #cccccc;
  }
  .content {
    position: absolute;
    left: ${LABEL_REGIONS.content.x}px;
    top: ${LABEL_REGIONS.content.y}px;
    width: ${LABEL_REGIONS.content.width}px;
    height: ${LABEL_REGIONS.content.height}px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 10px;
    font-family: ${BASE_FONT_STACK};
    font-size: 30px;
    color: #111111;
  }
  .warning {
    position: absolute;
    left: ${LABEL_REGIONS.warning.x}px;
    top: ${LABEL_REGIONS.warning.y}px;
    width: ${LABEL_REGIONS.warning.width}px;
    height: ${LABEL_REGIONS.warning.height}px;
    font-family: ${BASE_FONT_STACK};
    font-size: ${style.warningFontSizePx}px;
    line-height: 1.5;
    color: #111111;
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="brand">${escapeHtml(label.brandName)}</div>
    <div class="classType">${escapeHtml(label.classType)}</div>
    <div class="divider" style="top: 310px;"></div>
    <div class="content">
      ${abvLine}
      ${netContentsLine}
    </div>
    <div class="divider" style="top: 500px;"></div>
    <div class="warning">${warningHtml}</div>
  </div>
</body>
</html>`;
}

/** A live, reusable Chromium page for rendering many cases in one process (`build.ts`) without relaunching the browser per case. */
export interface LabelRenderer {
  readonly page: Page;
  close(): Promise<void>;
}

export async function createLabelRenderer(): Promise<LabelRenderer> {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
  });
  return {
    page,
    close: () => browser.close(),
  };
}

/**
 * Renders one case to a lossless PNG buffer. Pass an existing `page` (from
 * `createLabelRenderer`) to reuse a browser across many calls; omit it to
 * launch and close a throwaway browser for a single render (tests, ad hoc
 * use). The viewport is reset to the fixed canvas size on every call, so a
 * caller-supplied page can never silently drift `LABEL_REGIONS` out of
 * alignment with the actual screenshot.
 */
export async function renderLabelImage(
  renderCase: RenderableCase,
  page?: Page,
): Promise<Buffer> {
  const html = buildLabelHtml(renderCase);

  if (page) {
    await page.setViewportSize({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    await page.setContent(html, { waitUntil: "load" });
    return page.screenshot({ type: "png" });
  }

  const renderer = await createLabelRenderer();
  try {
    await renderer.page.setContent(html, { waitUntil: "load" });
    return await renderer.page.screenshot({ type: "png" });
  } finally {
    await renderer.close();
  }
}
