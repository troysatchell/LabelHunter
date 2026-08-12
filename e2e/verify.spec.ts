/**
 * Verify screen E2E specs (TRO-479, PRD §5/§6, TH-R12, TH-R20).
 *
 * Runs against a real, live Next.js instance (`playwright.config.ts`'s
 * `webServer`) — a real browser, real HTTP requests, real preprocessing,
 * real deterministic router and comparators, real Postgres persistence.
 * The one thing standing in for the real world is the Anthropic API
 * itself (`scripts/e2e/fake-anthropic-server.ts`, wired in by default —
 * see that file and `playwright.config.ts` for why and how to opt into a
 * real, paid run with `E2E_LIVE=1`).
 *
 * The happy-path case uploads a real, committed golden-set image
 * (`golden-set/images/case-01-clean-match-spirits.jpg`, TH-R12) — its
 * warning block was OBSERVED to OCR cleanly against the real tesseract.js
 * pipeline during this ticket's own development (not merely assumed), so
 * asserting a full, real PASS across every field — including the
 * warning, whose OCR channel runs for real against this real image, never
 * faked — is sound, not a guess.
 */
import { expect, test } from "@playwright/test";
import { buildCorruptImage, buildFailureTriggerImage, buildOversizedFile, readDefaultGoldenImage, uniqueTag } from "../scripts/e2e/fixtures";
import { WELL_FORMED_EXTRACTION_BODY } from "../src/server/extractor/test-support";
import { errorPanel, fillVerifyForm, jpegFile, submitVerifyFormAndWait } from "./helpers";

test.describe("Verify — happy path", () => {
  test("uploads a real golden-set label, fills the application fields, and renders a real per-field checklist", async ({ page }) => {
    await page.goto("/");

    await fillVerifyForm(page, {
      image: jpegFile("case-01-clean-match-spirits.jpg", readDefaultGoldenImage()),
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    const banner = page.getByTestId("label-verdict-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/matches the application/i);

    // Every row is real — the evidence text ties straight back to the
    // fake server's canned extraction (itself case-01's own verified
    // ground truth, golden-set/manifest.json), never a hand-typed
    // duplicate of what the UI happens to show.
    const brandRow = page.getByTestId("checklist-row-brand_name");
    await expect(brandRow).toBeVisible();
    await expect(brandRow).toContainText(WELL_FORMED_EXTRACTION_BODY.brand_name.evidence);
    await expect(brandRow).toContainText("Match");

    const classRow = page.getByTestId("checklist-row-class_type");
    await expect(classRow).toContainText(WELL_FORMED_EXTRACTION_BODY.class_type.evidence);
    await expect(classRow).toContainText("Match");

    const abvRow = page.getByTestId("checklist-row-alcohol_content");
    await expect(abvRow).toContainText(WELL_FORMED_EXTRACTION_BODY.alcohol_content.evidence);
    await expect(abvRow).toContainText("Match");

    const netRow = page.getByTestId("checklist-row-net_contents");
    await expect(netRow).toContainText(WELL_FORMED_EXTRACTION_BODY.net_contents.evidence);
    await expect(netRow).toContainText("Match");

    // The warning field is the one row whose MATCH depends on a second,
    // fully real channel (tesseract.js OCR against the real uploaded
    // photo, TH-R9) agreeing with the fake VLM transcription — not only
    // on the fake server's canned response.
    const warningRow = page.getByTestId("checklist-row-government_warning");
    await expect(warningRow).toBeVisible();
    await expect(warningRow).toContainText("Match");

    // Click through to the Detail view (PRD §5).
    const detailLink = page.getByRole("link", { name: "See the label photo and full comparison" });
    await expect(detailLink).toBeVisible();
    await detailLink.click();

    await expect(page).toHaveURL(/\/verify\/\d+$/);
    await expect(page.getByTestId("label-verdict-banner")).toContainText(/matches the application/i);
    await expect(page.getByTestId("detail-field-brand_name")).toBeVisible();
    await expect(page.getByRole("img", { name: /label submitted/i })).toBeVisible();
  });
});

test.describe("Verify — designed error states (TH-R20)", () => {
  test("an unreadable image (valid JPEG header, damaged pixel data) shows the IMAGE error state, not a crash", async ({ page }) => {
    await page.goto("/");
    await fillVerifyForm(page, {
      image: jpegFile("damaged.jpg", await buildCorruptImage()),
      beverageType: "spirits",
      brandName: uniqueTag("verify-unreadable"),
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    const alert = errorPanel(page);
    await expect(alert).toBeVisible();
    // Tolerant of TRO-480's concurrent copy pass — anchored on the one
    // fact that must survive any rewording: this is an unreadable-file
    // problem, not a generic failure.
    await expect(alert).toContainText(/damaged|cannot open|can.?t use this photo/i);
    // Never a bare error code or stack trace (TH-R20).
    await expect(alert).not.toContainText(/error:|TypeError|at Object/i);
  });

  test("an oversized file shows the IMAGE error state with the actual size and the limit", async ({ page }) => {
    await page.goto("/");
    await fillVerifyForm(page, {
      image: jpegFile("huge.jpg", buildOversizedFile()),
      beverageType: "spirits",
      brandName: uniqueTag("verify-oversized"),
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    const alert = errorPanel(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/20(\.0)? ?MB/i);
  });

  test("an API failure shows the SERVICE error state with a retry affordance that actually recovers", async ({ page }) => {
    await page.goto("/");

    const brandName = uniqueTag("verify-retry");
    await fillVerifyForm(page, {
      image: jpegFile("trigger.jpg", await buildFailureTriggerImage()),
      beverageType: "spirits",
      brandName,
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    const alert = errorPanel(page);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/could not reach|took too long|try again|went wrong/i);

    const retryButton = page.getByRole("button", { name: "Try again" });
    await expect(retryButton).toBeVisible();

    // Prove the affordance genuinely recovers, not merely that a button
    // exists: swap in a real, working photo — "Try again" re-reads
    // whatever the file input currently holds (VerifyForm.tsx's own
    // `runSubmit`) — then retry.
    await page.getByLabel("Label photo").setInputFiles([jpegFile("case-01-clean-match-spirits.jpg", readDefaultGoldenImage())]);
    await retryButton.click();

    await expect(page.getByTestId("label-verdict-banner")).toBeVisible({ timeout: 20_000 });
    await expect(errorPanel(page)).toHaveCount(0);
    await expect(page.getByTestId("checklist-row-brand_name")).toBeVisible();
  });
});
