/**
 * Batch screen E2E specs (TRO-479, PRD §3.5/§5/§6, TH-R4, TH-R20).
 *
 * Manifest upload -> pairing preview -> run -> live progress -> results
 * table -> click-through to detail (PRD §5's own line, almost verbatim).
 * Runs against the real app AND the real background worker
 * (`playwright.config.ts`'s `webServer` array) — a queued batch item is
 * processed by the real `pnpm worker` process, claiming from the real
 * Postgres-backed queue, calling the real deterministic router. Only the
 * Anthropic call itself is faked by default (see `verify.spec.ts`'s
 * header comment; same `E2E_LIVE` opt-in applies here).
 */
import { expect, test } from "@playwright/test";
import { buildManifestCsv, readDefaultGoldenImage, uniqueTag } from "../scripts/e2e/fixtures";
import { errorPanel, jpegFile } from "./helpers";

test.describe("Batch — happy path", () => {
  test("manifest + images -> pairing preview -> run -> live progress -> results table -> click through to detail", async ({ page }) => {
    // Default 30s (playwright.config.ts has no override) is tight for a
    // real batch: two real worker claim/process cycles (EXTRACT, then a
    // RESOLVE for the deliberately-escalated row), each polled by the
    // browser every 3s. 90s gives the assertion below real headroom
    // without ever needing a fixed sleep.
    test.setTimeout(90_000);

    // Row A must match the fake extraction's real brand EXACTLY (see
    // src/server/extractor/test-support.ts's WELL_FORMED_EXTRACTION_BODY)
    // for the router to produce PASS — a run-unique tag here would never
    // clear the 0.95 similarity threshold and would land in REVIEW too,
    // indistinguishable from row B (found by running this spec for real:
    // the first version of this test used a unique tag for both rows and
    // both landed in REVIEW). Row A is identified by its own filename
    // ("bottle-a.jpg") below, which is already unique within this batch —
    // it does not also need a unique brand.
    const passBrand = "Old Tom Distillery";
    const reviewBrand = uniqueTag("batch-review");
    const goldenImage = readDefaultGoldenImage();

    // Two rows, the SAME real photo under two filenames — pairing is by
    // filename only (src/server/batch/pairing.ts), so this is a
    // legitimate way to exercise two independent labels without needing
    // two distinct source photos. Row A's application fields match the
    // fake extraction exactly (PASS); row B's brand is deliberately far
    // off (AMBIGUOUS_BRAND -> REVIEW) — the SAME fixed extraction, two
    // different, real, deterministic router outcomes.
    const csv = buildManifestCsv([
      {
        beverageType: "spirits",
        brandName: passBrand,
        classType: "Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "bottle-a.jpg",
      },
      {
        beverageType: "spirits",
        brandName: reviewBrand,
        classType: "Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "bottle-b.jpg",
      },
    ]);

    await page.goto("/batch");
    await page.getByLabel("CSV manifest").setInputFiles([{ name: "manifest.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }]);
    await page.getByLabel("Label images").setInputFiles([jpegFile("bottle-a.jpg", goldenImage), jpegFile("bottle-b.jpg", goldenImage)]);

    await page.getByRole("button", { name: "Preview batch" }).click();

    const preview = page.getByTestId("batch-preview");
    await expect(preview).toBeVisible();
    await expect(page.getByTestId("batch-preview-summary")).toContainText("2 of 2");
    await expect(page.getByTestId("batch-preview-problems")).toHaveCount(0);

    await page.getByRole("button", { name: /Start batch/ }).click();

    const started = page.getByTestId("batch-started");
    await expect(started).toBeVisible();
    await expect(started).toContainText(/processing/i);

    await page.getByRole("button", { name: "View batch progress" }).click();
    await expect(page).toHaveURL(/\/batch\/\d+$/);

    // The live progress summary genuinely updates — polled off the real
    // worker's real completion (BatchProgressBrowser.tsx polls every 3s;
    // Playwright's own auto-retrying `expect` is the "observable event"
    // this waits on, never a fixed sleep).
    await expect(page.getByTestId("batch-stat-processed")).toContainText("2 / 2", { timeout: 60_000 });

    const rowA = page.getByRole("row").filter({ hasText: "bottle-a.jpg" });
    const rowB = page.getByRole("row").filter({ hasText: "bottle-b.jpg" });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // Row A: a clean match -> a real link to its own detail view.
    const rowALink = rowA.getByRole("link");
    await expect(rowALink).toBeVisible();
    await expect(rowALink).toContainText(/matches the application/i);

    // Row B: the deliberately mismatched brand -> needs a person, not a
    // silent pass or a silent fail (TH-R8/TH-R20) — still a real link,
    // since the label itself finished extraction and routing.
    const rowBLink = rowB.getByRole("link");
    await expect(rowBLink).toBeVisible();
    await expect(rowBLink).toContainText(/review/i);

    // Click through to the detail view (PRD §5).
    await rowALink.click();
    await expect(page).toHaveURL(/\/verify\/\d+$/);
    await expect(page.getByTestId("label-verdict-banner")).toContainText(/matches the application/i);
    await expect(page.getByTestId("detail-field-brand_name")).toContainText(passBrand);
  });
});

test.describe("Batch — designed error states (TH-R20)", () => {
  test("a malformed CSV (missing a required column) is rejected before any batch starts", async ({ page }) => {
    const csv = buildManifestCsv(
      [
        {
          beverageType: "spirits",
          brandName: uniqueTag("batch-malformed"),
          classType: "Straight Bourbon Whiskey",
          alcoholContentPercent: 45,
          netContentsValue: 750,
          netContentsUnit: "mL",
          imageFilename: "bottle.jpg",
        },
      ],
      // beverage_type dropped — a real, structural "missing required
      // column" failure (src/server/batch/manifest.ts), not a value-level
      // row error.
      ["brand_name", "class_type", "alcohol_content_percent", "net_contents_value", "net_contents_unit", "image_filename"],
    );

    await page.goto("/batch");
    await page.getByLabel("CSV manifest").setInputFiles([{ name: "manifest.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }]);
    await page.getByLabel("Label images").setInputFiles([jpegFile("bottle.jpg", readDefaultGoldenImage())]);
    await page.getByRole("button", { name: "Preview batch" }).click();

    const alert = errorPanel(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/manifest|missing|column/i);
    await expect(page.getByTestId("batch-preview")).toHaveCount(0);
  });

  test("unpairable rows and images are reported inside a successful preview, never silently dropped", async ({ page }) => {
    const readyBrand = uniqueTag("batch-unpairable-ready");
    const orphanRowBrand = uniqueTag("batch-unpairable-row");

    // Row 1 has a matching image. Row 2 names an image that is never
    // uploaded. A third, unrelated image is uploaded with no CSV row at
    // all — exercises both unmatchedRows and unmatchedImages in one pass.
    const csv = buildManifestCsv([
      {
        beverageType: "spirits",
        brandName: readyBrand,
        classType: "Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "paired.jpg",
      },
      {
        beverageType: "spirits",
        brandName: orphanRowBrand,
        classType: "Straight Bourbon Whiskey",
        alcoholContentPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
        imageFilename: "never-uploaded.jpg",
      },
    ]);

    const goldenImage = readDefaultGoldenImage();
    await page.goto("/batch");
    await page.getByLabel("CSV manifest").setInputFiles([{ name: "manifest.csv", mimeType: "text/csv", buffer: Buffer.from(csv) }]);
    await page
      .getByLabel("Label images")
      .setInputFiles([jpegFile("paired.jpg", goldenImage), jpegFile("orphan-image.jpg", goldenImage)]);
    await page.getByRole("button", { name: "Preview batch" }).click();

    await expect(page.getByTestId("batch-preview")).toBeVisible();
    await expect(page.getByTestId("batch-preview-summary")).toContainText("1 of 2");

    const problems = page.getByTestId("batch-preview-problems");
    await expect(problems).toBeVisible();

    // Each reported problem is checked on its OWN line, not with one
    // regex either phrase could satisfy — an earlier version of this
    // assertion used a single `/no matching image|no CSV row/i` check
    // against the whole panel, which stayed green even when the
    // unmatched-ROW message specifically was broken, because the
    // unmatched-IMAGE message alone still matched the pattern (found by
    // deliberately breaking the row message and watching this test stay
    // green — the exact "confirm it fails for the right reason" step
    // this ticket's brief asks for). Each list item is asserted
    // separately now so a regression in either one is caught on its own.
    const unmatchedRowItem = problems.locator("li", { hasText: "never-uploaded.jpg" });
    await expect(unmatchedRowItem).toContainText(/no uploaded image is named/i);

    const unmatchedImageItem = problems.locator("li", { hasText: "orphan-image.jpg" });
    await expect(unmatchedImageItem).toContainText(/no CSV row names this file/i);
  });
});
