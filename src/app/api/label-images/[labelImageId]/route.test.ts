import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { applications, labelImages } from "../../../../lib/db/schema";
import { OUTPUT_MEDIA_TYPE } from "../../../../server/preprocessing/constants";
import { deleteLabelImageBlobsWhere, readLabelImage, saveLabelImage } from "../../../../server/storage/db-image-storage";
import { handleGetLabelImage, type LabelImageRouteDeps } from "./route";

// No live Anthropic call. This DOES use the real worktree Postgres
// database to look up a real label_images row, since that lookup is this
// route's whole job, and (TRO-518) to save/read the image bytes themselves
// — both through the same database, no scratch directory involved. Run
// this file only with DATABASE_URL pointed at the worktree's own database:
// provisioning resets that database's schema.

const createdApplicationIds: number[] = [];

afterEach(async () => {
  const ids = createdApplicationIds.splice(0);
  if (ids.length > 0) {
    // TRO-518: label_image_blobs rows are not reached by the cascade below
    // — see db-image-storage.ts's own deleteLabelImageBlobsWhere comment.
    await deleteLabelImageBlobsWhere(inArray(labelImages.applicationId, ids));
  }
  for (const id of ids) {
    await db.delete(applications).where(eq(applications.id, id));
  }
});

function makeDeps(overrides: Partial<LabelImageRouteDeps> = {}): LabelImageRouteDeps {
  return {
    db,
    readLabelImage,
    ...overrides,
  };
}

async function seedLabelImage(bytes: Buffer): Promise<number> {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      // "TRO-466 Test Fixture", not "Old Tom Distillery" (TRO-513): no
      // assertion in this file reads brandName, and this suite runs
      // alongside every other `*.test.ts` file sharing this worktree's
      // database — see src/app/api/verify/route.test.ts for where the
      // canonical example stays load-bearing.
      brandName: "TRO-466 Test Fixture",
      classType: "Straight Bourbon Whiskey",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();
  createdApplicationIds.push(application.id);

  const saved = await saveLabelImage(bytes, "front-label.jpg");
  const [labelImage] = await db
    .insert(labelImages)
    .values({
      applicationId: application.id,
      storagePath: saved.storagePath,
      originalFilename: "front-label.jpg",
      widthPx: 1200,
      heightPx: 1600,
    })
    .returning();
  return labelImage.id;
}

describe("GET /api/label-images/:labelImageId", () => {
  it("serves the saved bytes with the pipeline's fixed JPEG content type", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const labelImageId = await seedLabelImage(bytes);

    const response = await handleGetLabelImage(String(labelImageId), makeDeps());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(OUTPUT_MEDIA_TYPE);
    // This is a compliance photo behind the app's own future access gate
    // (PRD §8) — pinned private, never a shared/public cache.
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it("returns a designed 404, not a crash, for a label image id that does not exist", async () => {
    const response = await handleGetLabelImage("999999999", makeDeps());
    expect(response.status).toBe(404);
  });

  it("returns a designed 404 for a non-numeric id, without ever querying the database", async () => {
    let queried = false;
    const deps = makeDeps({
      db: {
        select: () => {
          queried = true;
          throw new Error("should not be called");
        },
      } as unknown as LabelImageRouteDeps["db"],
    });

    const response = await handleGetLabelImage("not-a-number", deps);
    expect(response.status).toBe(404);
    expect(queried).toBe(false);
  });

  it("returns a designed 404 (never an unhandled crash) when the database row exists but the stored image does not", async () => {
    const labelImageId = await seedLabelImage(Buffer.from("bytes"));
    // TRO-518: `local-file-storage.ts`'s old ephemeral-disk data loss (the
    // bug this ticket fixed) no longer applies — Postgres storage does not
    // lose data on a deploy or restart. The CONTRACT this test guards still
    // matters, though: a `label_images` row can still outlive its blob (a
    // row left over from before this ticket, whose `storage_path` is a
    // filesystem-style value no `label_image_blobs` row will ever match; or
    // a blob deleted independently of its metadata row). Deleting the blob
    // row directly, while the label_images row survives, reproduces exactly
    // that shape without depending on the retired disk-loss mechanism.
    const [row] = await db.select({ storagePath: labelImages.storagePath }).from(labelImages).where(eq(labelImages.id, labelImageId));
    await deleteLabelImageBlobsWhere(eq(labelImages.id, labelImageId));

    const response = await handleGetLabelImage(String(labelImageId), makeDeps());
    expect(response.status).toBe(404);
    // Sanity: the label_images row genuinely still exists (this is "blob
    // gone, metadata intact," not an accidental full cascade delete).
    const [stillThere] = await db.select().from(labelImages).where(eq(labelImages.id, labelImageId));
    expect(stillThere.storagePath).toBe(row.storagePath);
  });

  it("returns 500, not a 404, when the image read fails for a reason other than a missing image", async () => {
    const labelImageId = await seedLabelImage(Buffer.from("bytes"));
    const response = await handleGetLabelImage(
      String(labelImageId),
      makeDeps({
        readLabelImage: () => Promise.reject(new Error("connection terminated unexpectedly")),
      }),
    );
    expect(response.status).toBe(500);
  });
});
