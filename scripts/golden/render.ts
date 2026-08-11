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
 * FONTS (TRO-505). Every font below is embedded, not a system-font name.
 * `FONT_FACES_CSS` reads real font files from three pinned npm packages —
 * `@fontsource/inter`, `@fontsource/dancing-script`,
 * `@fontsource/unifrakturmaguntia` (each OFL-1.1) — and inlines them as
 * base64 `data:` URIs inside a `@font-face` block. This is what design doc
 * §2 means by "fonts are committed to the repo": `pnpm-lock.yaml` pins the
 * exact bytes, and `pnpm install` fetches them the same way it fetches
 * every other dependency. Chromium never asks the host OS to substitute a
 * font for this renderer's three styles, so `pnpm golden:build` no longer
 * depends on which fonts a given machine has installed. Before TRO-505,
 * this comment named a KNOWN LIMITATION here: the font stacks named system
 * fonts only (Helvetica/Arial, plus generic `cursive`/`fantasy`
 * fallbacks), so a different OS could pick a different substitution and
 * produce different pixels. TRO-505 closed that gap.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
 * `.classType` and the two `.divider` positions, derived from
 * `LABEL_REGIONS` plus a named visual gap, instead of separate literals.
 * Before this, the CSS below repeated `LABEL_REGIONS`' numbers by hand —
 * nothing enforced that a future edit to `LABEL_REGIONS` would move these
 * in step. `degrade.ts` crops by `LABEL_REGIONS`; a drift here would move
 * the painted pixels without moving the crop, so a region-targeted glare or
 * low-light would land on the wrong content with no error, the same class
 * of bug `assertMatchesOriginalCanvas` guards against in `degrade.ts`. The
 * gap constants reproduce today's literals exactly (210 / 90 / 310 / 500);
 * `render.test.ts`'s determinism test proves this rebuild is pixel-for-
 * pixel identical to before.
 */
const CLASS_TYPE_GAP_PX = 10;
const CLASS_TYPE_TOP = LABEL_REGIONS.brand.y + LABEL_REGIONS.brand.height + CLASS_TYPE_GAP_PX;
const CLASS_TYPE_HEIGHT =
  LABEL_REGIONS.front.y + LABEL_REGIONS.front.height - CLASS_TYPE_TOP;
const CONTENT_DIVIDER_GAP_PX = 10;
const CONTENT_DIVIDER_TOP =
  LABEL_REGIONS.front.y + LABEL_REGIONS.front.height + CONTENT_DIVIDER_GAP_PX;
const WARNING_DIVIDER_GAP_PX = 20;
const WARNING_DIVIDER_TOP = LABEL_REGIONS.warning.y - WARNING_DIVIDER_GAP_PX;

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

const fontPackageRequire = createRequire(import.meta.url);

/**
 * Reads one `@fontsource`-vendored WOFF2 file and returns it as a base64
 * `data:` URI. Called once per distinct font file, at module load (see
 * `FONT_FACES_CSS` below) — not once per case. The font bytes never change
 * per case, so re-encoding them on every one of the 26 renderable cases in
 * `pnpm golden:build` would repeat identical work for no benefit.
 *
 * `require.resolve` goes through the package's own `exports` map in its
 * `package.json` — checked directly (`node_modules/@fontsource/*
 * /package.json`) before this file relied on it, never assumed from the
 * package name. CLAUDE.md rule 13: a font package's exported file path is
 * a boundary to check, not a guess.
 */
function fontFileDataUri(packageSubpath: string): string {
  const absolutePath = fontPackageRequire.resolve(packageSubpath);
  const bytes = readFileSync(absolutePath);
  return `data:font/woff2;base64,${bytes.toString("base64")}`;
}

/**
 * Embedded `@font-face` rules for every font this renderer uses. Committed
 * to the repo via `pnpm-lock.yaml`, not read from the host OS (TRO-505;
 * design doc §2's "fonts are committed to the repo"). Three families, five
 * weights total — the exact set `buildLabelHtml`'s CSS below requests:
 *
 * - Inter (OFL-1.1, `@fontsource/inter`) — the base sans-serif for
 *   brand/class-type/content/warning body text. Weights 400 (content,
 *   warning), 500 (class/type default), 700 (brand default).
 * - Dancing Script (OFL-1.1, `@fontsource/dancing-script`) — the
 *   script-style "odd typography" brand case (case-25). Weight 700, to
 *   match `.brand`'s fixed `font-weight: 700` with a real bold cut of the
 *   font instead of a browser-synthesized one.
 * - UnifrakturMaguntia (OFL-1.1, `@fontsource/unifrakturmaguntia`) — the
 *   blackletter "odd typography" class/type case (case-26). This is the
 *   exact face this file already named as a *system*-font fallback before
 *   TRO-505; it turns out to already ship as its own installable,
 *   OFL-licensed package. Weight 400 — its only static weight.
 *   `CASE_STYLE_OVERRIDES` below renders case-26's class/type at weight
 *   400, not the usual 500, so Chromium never synthesizes a bold cut of a
 *   font that was never designed with one — a synthesized weight would
 *   change glyph metrics in a way `LABEL_REGIONS` was not built to absorb.
 *
 * Every license above was checked two ways before this file used it: the
 * package's own `package.json` `license` field (`npm view <package>
 * license`), and the actual `LICENSE` file text each package ships
 * (confirmed SIL Open Font License 1.1 in every case, not assumed from the
 * metadata field alone).
 */
const FONT_FACES_CSS = `
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 400;
    src: url(${fontFileDataUri("@fontsource/inter/files/inter-latin-400-normal.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 500;
    src: url(${fontFileDataUri("@fontsource/inter/files/inter-latin-500-normal.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 700;
    src: url(${fontFileDataUri("@fontsource/inter/files/inter-latin-700-normal.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Dancing Script";
    font-style: normal;
    font-weight: 700;
    src: url(${fontFileDataUri("@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "UnifrakturMaguntia";
    font-style: normal;
    font-weight: 400;
    src: url(${fontFileDataUri("@fontsource/unifrakturmaguntia/files/unifrakturmaguntia-latin-400-normal.woff2")}) format("woff2");
  }
`;

/**
 * `BASE_FONT_STACK` keeps a generic `sans-serif` fallback: `Inter` is the
 * base font itself, so there is no more-embedded family left to fall back
 * to if its `@font-face` somehow failed to apply.
 *
 * `SCRIPT_FONT_STACK` and `BLACKLETTER_FONT_STACK` fall back to `"Inter"`,
 * not a generic `cursive`/`fantasy` family. `cursive` and `fantasy` name no
 * real font — only a category — so the OS would still pick the actual face
 * for either one, exactly the substitution risk this file just closed.
 * `Inter` is also embedded above, so even this fallback path stays
 * file-embedded and deterministic. In today's committed HTML this fallback
 * never actually triggers — `render.test.ts`'s "embeds each font family's
 * real @fontsource file bytes" test confirms `buildLabelHtml` requests
 * `Dancing Script` and `UnifrakturMaguntia` directly, and both load — but a
 * future regression that broke one of those two `@font-face` rules would
 * degrade to Inter, not silently to an OS-dependent generic family.
 */
const BASE_FONT_STACK = '"Inter", sans-serif';
const SCRIPT_FONT_STACK = '"Dancing Script", "Inter"';
const BLACKLETTER_FONT_STACK = '"UnifrakturMaguntia", "Inter"';
const DEFAULT_WARNING_FONT_SIZE_PX = 24;
const TINY_WARNING_FONT_SIZE_PX = 9;
const DEFAULT_CLASS_TYPE_FONT_WEIGHT = 500;
const BLACKLETTER_CLASS_TYPE_FONT_WEIGHT = 400;

interface StyleOverride {
  readonly brandFontFamily?: string;
  readonly classTypeFontFamily?: string;
  readonly classTypeFontWeight?: number;
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
    classTypeFontWeight: BLACKLETTER_CLASS_TYPE_FONT_WEIGHT,
  },
};

function styleFor(caseId: string): Required<StyleOverride> {
  const override = CASE_STYLE_OVERRIDES[caseId] ?? {};
  return {
    brandFontFamily: override.brandFontFamily ?? BASE_FONT_STACK,
    classTypeFontFamily: override.classTypeFontFamily ?? BASE_FONT_STACK,
    classTypeFontWeight: override.classTypeFontWeight ?? DEFAULT_CLASS_TYPE_FONT_WEIGHT,
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
  ${FONT_FACES_CSS}
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
    left: ${LABEL_REGIONS.front.x}px;
    top: ${CLASS_TYPE_TOP}px;
    width: ${LABEL_REGIONS.front.width}px;
    height: ${CLASS_TYPE_HEIGHT}px;
    display: flex;
    align-items: center;
    font-family: ${style.classTypeFontFamily};
    font-size: 34px;
    font-weight: ${style.classTypeFontWeight};
    color: #333333;
  }
  .divider {
    position: absolute;
    left: ${LABEL_REGIONS.front.x}px;
    width: ${LABEL_REGIONS.front.width}px;
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
    <div class="divider" style="top: ${CONTENT_DIVIDER_TOP}px;"></div>
    <div class="content">
      ${abvLine}
      ${netContentsLine}
    </div>
    <div class="divider" style="top: ${WARNING_DIVIDER_TOP}px;"></div>
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
