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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

    // A stray empty ABV "line" div would pass a plain .includes() check on
    // netContentsText, so count the .line divs directly: exactly one,
    // holding net contents, proves the ABV line was skipped rather than
    // rendered empty.
    const lines = html.match(/<div class="line">[\s\S]*?<\/div>/g) ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(noAbv!.label.netContentsText);
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

describe("buildLabelHtml font embedding (TRO-505)", () => {
  // Resolves and reads each @fontsource file itself, independently of
  // render.ts's own `fontFileDataUri` helper. This catches a wrong subpath
  // or a stale/truncated encoding in render.ts — it does not just repeat
  // render.ts's own claim about itself back at it.
  const fontRequire = createRequire(import.meta.url);

  function expectedDataUri(packageSubpath: string): string {
    const bytes = readFileSync(fontRequire.resolve(packageSubpath));
    return `data:font/woff2;base64,${bytes.toString("base64")}`;
  }

  it("embeds each font family's real @fontsource file bytes as a base64 data URI", () => {
    const html = buildLabelHtml(renderableCases[0]);

    const expected: Record<string, string> = {
      "Inter 400": expectedDataUri("@fontsource/inter/files/inter-latin-400-normal.woff2"),
      "Inter 500": expectedDataUri("@fontsource/inter/files/inter-latin-500-normal.woff2"),
      "Inter 700": expectedDataUri("@fontsource/inter/files/inter-latin-700-normal.woff2"),
      "Dancing Script 700": expectedDataUri(
        "@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff2",
      ),
      "UnifrakturMaguntia 400": expectedDataUri(
        "@fontsource/unifrakturmaguntia/files/unifrakturmaguntia-latin-400-normal.woff2",
      ),
    };

    for (const [label, dataUri] of Object.entries(expected)) {
      expect(
        html.includes(dataUri),
        `${label}: rendered HTML must embed this exact font file as a data URI`,
      ).toBe(true);
    }
  });

  it("never references a pre-TRO-505 system font (no OS font substitution to fall back to)", () => {
    const html = buildLabelHtml(renderableCases[0]);
    const preTro505SystemFonts = [
      "Helvetica Neue",
      "Brush Script MT",
      "Apple Chancery",
      "Snell Roundhand",
      '"Blackletter"',
    ];
    for (const systemFont of preTro505SystemFonts) {
      expect(
        html.includes(systemFont),
        `must not reference pre-TRO-505 system font ${systemFont}`,
      ).toBe(false);
    }
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

  it(
    "renders the same case to identical decoded pixels across two independent browser instances",
    async () => {
      // The test above reuses one `renderer.page` for both renders, so it
      // only proves determinism within a single Chromium process. `pnpm
      // golden:build` launches a fresh browser every run
      // (`createLabelRenderer` in `build.ts`'s `main`), so the guarantee
      // that actually matters is determinism across separate browser
      // instances, not just across two calls on one page.
      const testCase = renderableCases.find(
        (c) => c.caseId === "case-01-clean-match-spirits",
      );
      expect(testCase).toBeDefined();

      const first = await renderLabelImage(testCase!, renderer.page);
      const second = await renderLabelImage(testCase!); // launches its own browser

      const firstRaw = await sharp(first).raw().toBuffer();
      const secondRaw = await sharp(second).raw().toBuffer();

      expect(firstRaw.equals(secondRaw)).toBe(true);
    },
    60_000,
  );

  it(
    "renders the two embedded-font odd-typography cases to identical decoded pixels across two independent browser instances (TRO-505)",
    async () => {
      // The determinism test above only exercises the base Inter @font-face
      // path (case-01). These two cases are the ones that actually load the
      // newly-vendored Dancing Script and UnifrakturMaguntia @font-face
      // rules — the specific paths a font-substitution regression would hit
      // first, and the ones the pre-TRO-505 KNOWN LIMITATION named directly.
      const scriptCase = renderableCases.find(
        (c) => c.caseId === "case-25-odd-typography-script-brand",
      );
      const blackletterCase = renderableCases.find(
        (c) => c.caseId === "case-26-odd-typography-blackletter-class-type",
      );
      expect(scriptCase).toBeDefined();
      expect(blackletterCase).toBeDefined();

      for (const testCase of [scriptCase!, blackletterCase!]) {
        const first = await renderLabelImage(testCase, renderer.page);
        const second = await renderLabelImage(testCase); // launches its own browser

        const firstRaw = await sharp(first).raw().toBuffer();
        const secondRaw = await sharp(second).raw().toBuffer();

        expect(
          firstRaw.equals(secondRaw),
          `${testCase.caseId}: must render identically across two independent browser instances`,
        ).toBe(true);
      }
    },
    60_000,
  );
});
