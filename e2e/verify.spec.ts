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
import { buildCorruptImage, buildOversizedFile, readDefaultGoldenImage, uniqueTag } from "../scripts/e2e/fixtures";
import { WELL_FORMED_EXTRACTION_BODY } from "../src/server/extractor/test-support";
import { E2E_LIVE, errorPanel, fillVerifyForm, jpegFile, submitVerifyFormAndWait } from "./helpers";

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

    // Every row is real. In the default (fake) mode, the evidence text
    // ties straight back to the fake server's canned extraction (itself
    // case-01's own verified ground truth, golden-set/manifest.json),
    // never a hand-typed duplicate of what the UI happens to show. Under
    // E2E_LIVE=1, a real model reads the real photo for itself — its
    // evidence text is not guaranteed to be byte-for-byte identical to
    // this fixture (case, spacing, or transcription choices can differ
    // even on a correct read), so only the MATCH badge — the fact every
    // field agrees with the application, true under either mode for this
    // genuinely clean-match label — is asserted live (CodeRabbit finding,
    // TRO-479 local review round 2).
    const brandRow = page.getByTestId("checklist-row-brand_name");
    await expect(brandRow).toBeVisible();
    if (!E2E_LIVE) await expect(brandRow).toContainText(WELL_FORMED_EXTRACTION_BODY.brand_name.evidence);
    await expect(brandRow).toContainText("Match");

    const classRow = page.getByTestId("checklist-row-class_type");
    if (!E2E_LIVE) await expect(classRow).toContainText(WELL_FORMED_EXTRACTION_BODY.class_type.evidence);
    await expect(classRow).toContainText("Match");

    const abvRow = page.getByTestId("checklist-row-alcohol_content");
    if (!E2E_LIVE) await expect(abvRow).toContainText(WELL_FORMED_EXTRACTION_BODY.alcohol_content.evidence);
    await expect(abvRow).toContainText("Match");

    const netRow = page.getByTestId("checklist-row-net_contents");
    if (!E2E_LIVE) await expect(netRow).toContainText(WELL_FORMED_EXTRACTION_BODY.net_contents.evidence);
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

  // The "API failure -> retry affordance" case lives in its own file,
  // e2e/verify-fake-only.spec.ts, not here (TRO-521). See that file's
  // header comment for why, and lessons.md rule 30 for why dropping this
  // one scenario under E2E_LIVE is not a coverage gap.
});

test.describe("Verify — helper correctness", () => {
  test("submitVerifyFormAndWait waits for the real result, not Next's own stale route announcer", async ({ page }) => {
    // Regression test for a CodeRabbit finding (TRO-479 local review
    // round 2): submitVerifyFormAndWait's own `.or(...)` wait must ignore
    // Next's always-present route announcer (`__next-route-announcer__`),
    // the same element `errorPanel(page)` already filters out for the
    // same reason. Simulates the exact race directly — an earlier client-
    // side navigation elsewhere in a longer test could leave the
    // announcer non-empty — rather than relying on one happening to occur
    // naturally in this suite's own current specs.
    await page.goto("/");
    await page.evaluate(() => {
      const announcer = document.getElementById("__next-route-announcer__");
      if (announcer) announcer.textContent = "stale text from an earlier client-side navigation";
    });

    await fillVerifyForm(page, {
      image: jpegFile("case-01-clean-match-spirits.jpg", readDefaultGoldenImage()),
      beverageType: "spirits",
      brandName: uniqueTag("verify-announcer-race"),
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    // Deliberately NOT an auto-retrying `expect(...).toBeVisible()` here:
    // that would poll for up to its own default timeout and could paper
    // over `submitVerifyFormAndWait` having returned too early, exactly
    // the vacuous-proof risk this ticket's own break/restore discipline
    // exists to catch (see CHANGES.md). If the wait had resolved against
    // the stale, already-visible announcer instead of the real result,
    // the checklist would not reliably be in the DOM the INSTANT control
    // returns here.
    expect(await page.getByTestId("label-verdict-banner").isVisible()).toBe(true);
  });

  test("errorPanel resolves to the real panel, not a decoy sharing the route announcer's own id, even when both are non-empty at once", async ({ page }) => {
    // Regression test for a CodeRabbit finding (TRO-479 local review
    // round 3): an earlier version of errorPanel() filtered on non-empty
    // text alone, which is only a proxy for "not the announcer" — if the
    // announcer is ALSO non-empty at the same moment a real ErrorPanel is
    // showing, that filter alone cannot tell them apart, and Playwright's
    // strict mode would reject the ambiguity. Excluding the announcer by
    // its own stable id is the precise fix.
    //
    // Next's REAL announcer element turns out to mount/remount on its own
    // schedule (confirmed directly: `document.getElementById(...)`
    // sometimes reports it absent at a point Playwright's own
    // accessibility-tree query finds it moments later) — trying to read
    // or mutate the live one is exactly the kind of timing dependency
    // rule 8 warns against, and an earlier version of this test proved
    // nothing because of it (passed even against the deliberately
    // reverted, buggy errorPanel() — a vacuous proof this ticket's own
    // break/restore discipline exists to catch). This test sidesteps
    // that mystery entirely: it creates its OWN element sharing the
    // announcer's exact id, fully under this test's control, and proves
    // errorPanel() excludes it BY ID — the actual mechanism the fix
    // relies on, independent of whatever Next's real announcer is doing.
    await page.goto("/");
    await fillVerifyForm(page, {
      image: jpegFile("huge.jpg", buildOversizedFile()),
      beverageType: "spirits",
      brandName: uniqueTag("verify-announcer-and-real-error"),
      classType: "Straight Bourbon Whiskey",
      alcoholContentPercent: 45,
      netContentsValue: 750,
      netContentsUnit: "mL",
    });
    await submitVerifyFormAndWait(page);

    await page.evaluate(() => {
      const decoy = document.createElement("div");
      decoy.id = "__next-route-announcer__";
      decoy.setAttribute("role", "alert");
      decoy.textContent = "stale text from an earlier client-side navigation";
      document.body.appendChild(decoy);
    });

    // A single, unambiguous match — not a strict-mode violation — that
    // is the REAL panel, not the decoy.
    const alert = errorPanel(page);
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText(/20(\.0)? ?MB/i);
  });
});
