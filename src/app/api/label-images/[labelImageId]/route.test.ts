import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../../../lib/db";
import { applications, labelImages } from "../../../../lib/db/schema";
import { OUTPUT_MEDIA_TYPE } from "../../../../server/preprocessing/constants";
import { readLabelImage, saveLabelImage } from "../../../../server/storage/local-file-storage";
import { handleGetLabelImage, type LabelImageRouteDeps } from "./route";

// No live Anthropic call and no write into the real `var/uploads` — every
// saved image lands in a per-test scratch directory (deleted in
// `afterEach`), matching src/app/api/verify/route.test.ts's own pattern.
// This DOES use the real worktree Postgres database to look up a real
// label_images row, since that lookup is this route's whole job.

let scratchDir: string;
const createdApplicationIds: number[] = [];

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "labelhunter-tro466-label-image-route-"));
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  for (const id of createdApplicationIds.splice(0)) {
    await db.delete(applications).where(eq(applications.id, id));
  }
});

function makeDeps(overrides: Partial<LabelImageRouteDeps> = {}): LabelImageRouteDeps {
  return {
    db,
    readLabelImage: (storagePath) => readLabelImage(storagePath, { baseDir: scratchDir }),
    ...overrides,
  };
}

async function seedLabelImage(bytes: Buffer): Promise<number> {
  const [application] = await db
    .insert(applications)
    .values({
      beverageType: "spirits",
      brandName: "Old Tom Distillery",
      classType: "Straight Bourbon Whiskey",
      netContentsValue: 750,
      netContentsUnit: "mL",
    })
    .returning();
  createdApplicationIds.push(application.id);

  const saved = await saveLabelImage(bytes, "front-label.jpg", { baseDir: scratchDir });
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

  it("returns a designed 404 (never an unhandled crash) when the database row exists but the file was lost from disk", async () => {
    const labelImageId = await seedLabelImage(Buffer.from("bytes"));
    // Simulate Render's ephemeral-disk data loss (local-file-storage.ts's
    // own documented limitation): the row survives, the bytes do not.
    await rm(scratchDir, { recursive: true, force: true });

    const response = await handleGetLabelImage(String(labelImageId), makeDeps());
    expect(response.status).toBe(404);
  });
});
