/**
 * Review queue E2E specs (TRO-479, PRD §5, TH-R22 — the differentiator).
 *
 * Each test seeds its OWN needs-human item through the real product
 * surface — a real Verify submission whose application brand is
 * deliberately far enough from the fake extraction's brand to fail
 * `compareBrandOrClass`'s similarity threshold (CP-1 §5.3, TH-R8: distance
 * beyond the threshold is a REVIEW, never a silent FAIL) — rather than
 * writing a `review_queue` row directly into the database. This proves
 * the real path: an application, a verification, and a review-queue row
 * with `reason: "AMBIGUOUS_BRAND"` all exist because a real cascade run
 * produced them, the same way they would in production.
 *
 * Every item is tagged with a run-unique brand name
 * (`scripts/e2e/fixtures.ts`'s `uniqueTag`) so this test is safe to run
 * repeatedly against the same persistent worktree database, and safe to
 * run in parallel with every other spec file that also writes to the
 * review queue (`playwright.config.ts`'s `fullyParallel: true`) — each
 * test looks up "the row containing MY tag", never "the only row" or "the
 * first row".
 */
import { expect, test, type Page } from "@playwright/test";
import { readDefaultGoldenImage, uniqueTag } from "../scripts/e2e/fixtures";
import { fillVerifyForm, jpegFile, submitVerifyFormAndWait } from "./helpers";

/** Submits one real verify request whose brand deliberately mismatches
 * the fake extraction's "Old Tom Distillery" (see
 * `src/server/extractor/test-support.ts`'s `WELL_FORMED_EXTRACTION_BODY`)
 * — everything else matches, so AMBIGUOUS_BRAND is the only reason the
 * router can produce. Returns the unique brand name the caller uses to
 * find this item again. */
async function createReviewQueueItem(page: Page, tagSeed: string): Promise<string> {
  const brandName = uniqueTag(tagSeed);
  await page.goto("/");
  await fillVerifyForm(page, {
    image: jpegFile("case-01-clean-match-spirits.jpg", readDefaultGoldenImage()),
    beverageType: "spirits",
    brandName,
    classType: "Straight Bourbon Whiskey",
    alcoholContentPercent: 45,
    netContentsValue: 750,
    netContentsUnit: "mL",
  });
  await submitVerifyFormAndWait(page);

  const banner = page.getByTestId("label-verdict-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/needs review/i);

  return brandName;
}

test.describe("Review queue — happy path", () => {
  test("shows a needs-human item with its reason, and Approve records a disposition", async ({ page }) => {
    const brandName = await createReviewQueueItem(page, "rq-approve");

    await page.goto("/review-queue");
    const row = page.getByRole("listitem").filter({ hasText: brandName });
    await expect(row).toBeVisible();

    // The reason is real, specific text — never a bare confidence number
    // (standing rule 12) — and ties back to the exact field the router
    // flagged. `reason-text.ts` is server-authored domain text, not the
    // client component copy TRO-480 (running concurrently) is polishing,
    // so asserting a stable keyword from it is safe, not brittle.
    await expect(row).toContainText(/brand/i);

    await row.getByRole("link", { name: /Review this item/ }).click();
    await expect(page).toHaveURL(/\/review-queue\/\d+$/);

    const reason = page.getByTestId("review-item-reason");
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/brand/i);

    await page.getByRole("button", { name: "Approve" }).click();

    // ReviewActions navigates back to the list once the disposition is
    // recorded (ReviewItemWorkspace.tsx's onResolved) — the durable,
    // non-racy proof that approval worked is that this item no longer
    // appears among the UNRESOLVED rows (listUnresolvedReviewQueue filters
    // WHERE disposition IS NULL), not the transient success banner, which
    // can be replaced by the navigation before an assertion ever observes
    // it.
    await expect(page).toHaveURL(/\/review-queue$/, { timeout: 10_000 });
    await expect(page.getByRole("listitem").filter({ hasText: brandName })).toHaveCount(0);
  });

  test("Reject also records a disposition and removes the item from the unresolved queue", async ({ page }) => {
    const brandName = await createReviewQueueItem(page, "rq-reject");

    await page.goto("/review-queue");
    const row = page.getByRole("listitem").filter({ hasText: brandName });
    await expect(row).toBeVisible();

    await row.getByRole("link", { name: /Review this item/ }).click();
    await expect(page).toHaveURL(/\/review-queue\/\d+$/);

    await page.getByRole("button", { name: "Reject" }).click();

    await expect(page).toHaveURL(/\/review-queue$/, { timeout: 10_000 });
    await expect(page.getByRole("listitem").filter({ hasText: brandName })).toHaveCount(0);
  });
});
