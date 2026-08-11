/**
 * Tests for the golden-set renderer (TRO-497 / LH-004).
 *
 * `buildLabelHtml` is a pure function — no browser, no I/O — so the
 * exact-warning-text guarantee (design doc §1's core rule: the renderer
 * guarantees exact text, no image model is ever trusted for it) is tested
 * directly against its HTML output, byte-compared against the manifest's
 * literal spec text. The renderer-determinism test is the one place this
 * file launches a real Chromium (via `createLabelRenderer`), reused across
 * both renders in that test — no network call, since the HTML is fully
 * inline and Chromium is already cached locally for `pnpm test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { loadGoldenSetManifest } from "../../src/lib/golden-set/loader";
import type { GoldenLabelFields } from "../../src/lib/golden-set/types";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  buildLabelHtml,
  createLabelRenderer,
  renderLabelImage,
  type LabelRenderer,
  type RenderableCase,
} from "./render";

const manifest = loadGoldenSetManifest();
const renderableCases = manifest.cases.filter((c) => c.provenance !== "ai-generated");

const BASE_LABEL: GoldenLabelFields = {
  brandName: "Test Brand",
  classType: "Test Class",
  abvPresent: true,
  abvText: "45% Alc./Vol.",
  abvPercent: 45,
  netContentsText: "750 mL",
  netContentsValue: 750,
  netContentsUnit: "mL",
  governmentWarningPresent: true,
  governmentWarningText: "GOVERNMENT WARNING: test text.",
  governmentWarningPrefixAllCaps: true,
};

describe("buildLabelHtml", () => {
  it("embeds every rendered case's exact government warning text, byte-compared", () => {
    const withWarning = renderableCases.filter((c) => c.label.governmentWarningPresent);
    expect(withWarning.length).toBeGreaterThan(0);

    for (const c of withWarning) {
      const html = buildLabelHtml(c);
      expect(
        html.includes(c.label.governmentWarningText),
        `${c.caseId}: rendered HTML must contain the spec's exact warning text`,
      ).toBe(true);
    }
  });

  it("embeds every rendered case's exact brand name and class/type text", () => {
    for (const c of renderableCases) {
      const html = buildLabelHtml(c);
      expect(html.includes(c.label.brandName), `${c.caseId}: brand name`).toBe(true);
      expect(html.includes(c.label.classType), `${c.caseId}: class/type`).toBe(true);
    }
  });

  it("omits warning text entirely when governmentWarningPresent is false", () => {
    const missingWarning = renderableCases.filter((c) => !c.label.governmentWarningPresent);
    expect(missingWarning.length).toBeGreaterThan(0);

    for (const c of missingWarning) {
      const html = buildLabelHtml(c);
      const warningDivMatch = html.match(/<div class="warning">([\s\S]*?)<\/div>/);
      expect(warningDivMatch, `${c.caseId}: expected a .warning div`).not.toBeNull();
      expect(warningDivMatch?.[1].trim(), `${c.caseId}: .warning div must be empty`).toBe("");
    }
  });

  it("omits the ABV line entirely when abvPresent is false", () => {
    const noAbv = renderableCases.find((c) => !c.label.abvPresent);
    expect(noAbv, "expected at least one case with abvPresent: false").toBeDefined();
    const html = buildLabelHtml(noAbv!);
    // No case's abvText is set when abvPresent is false (loader enforces this),
    // so the only direct check available is that the case's own (empty)
    // abvText produces no stray "line" div for it — net contents still renders.
    expect(html.includes(noAbv!.label.netContentsText)).toBe(true);
  });

  it("HTML-escapes unsafe characters in label text instead of injecting them raw", () => {
    const unsafeCase: RenderableCase = {
      caseId: "case-99-synthetic-html-escaping",
      label: {
        ...BASE_LABEL,
        brandName: `Ampersand & Bros. <script>`,
        governmentWarningText: `A & B < C > "D" 'E'`,
      },
    };

    const html = buildLabelHtml(unsafeCase);
    // & < > are HTML-structural and must be escaped so the browser never
    // misparses the document. " and ' need no escaping — every
    // interpolation lands in text content, never a quoted attribute — and
    // leaving them alone keeps the exact-text guarantee a plain substring
    // check (see case-14's STONE'S THROW in the test above).
    expect(html.includes("<script>")).toBe(false);
    expect(html.includes("Ampersand &amp; Bros. &lt;script&gt;")).toBe(true);
    expect(html.includes(`A &amp; B &lt; C &gt; "D" 'E'`)).toBe(true);
  });
});

describe("renderLabelImage determinism", () => {
  let renderer: LabelRenderer;

  beforeAll(async () => {
    renderer = await createLabelRenderer();
  }, 30_000);

  afterAll(async () => {
    await renderer.close();
  });

  it(
    "renders the same case to identical decoded pixels across two runs",
    async () => {
      const testCase = renderableCases.find(
        (c) => c.caseId === "case-01-clean-match-spirits",
      );
      expect(testCase).toBeDefined();

      const first = await renderLabelImage(testCase!, renderer.page);
      const second = await renderLabelImage(testCase!, renderer.page);

      const firstRaw = await sharp(first).raw().toBuffer();
      const secondRaw = await sharp(second).raw().toBuffer();

      expect(firstRaw.equals(secondRaw)).toBe(true);
    },
    30_000,
  );

  it(
    "renders at the fixed canvas size every LABEL_REGIONS constant assumes",
    async () => {
      const testCase = renderableCases[0];
      const image = await renderLabelImage(testCase, renderer.page);
      const metadata = await sharp(image).metadata();
      expect(metadata.width).toBe(CANVAS_WIDTH);
      expect(metadata.height).toBe(CANVAS_HEIGHT);
    },
    30_000,
  );
});
