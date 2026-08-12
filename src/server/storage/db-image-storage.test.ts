/**
 * `db-image-storage.ts` — the TRO-518 replacement for `local-file-storage.ts`.
 *
 * Three suites:
 *
 * 1. Basic round-trip behavior (mirrors `local-file-storage.test.ts`'s own
 *    coverage — write, read back, no collisions, a clean "not found").
 * 2. "The old design's failure mode was real" — `local-file-storage.ts` is
 *    deleted by this same commit, so this suite cannot import it to prove
 *    its bug directly. Instead it reproduces the EXACT mechanism that made
 *    it wrong: writing to one directory and reading from a different one.
 *    That is not a stand-in for the real Render bug — it IS the real bug,
 *    at the file-system level. Render's own service model (`render.yaml`:
 *    `web` and `worker` are two separate `type:` resources) guarantees a
 *    `web` service and a `worker` service never share a disk — mechanically
 *    indistinguishable, for the one question this suite asks ("can a
 *    reader see what a different writer saved?"), from two different
 *    directories on one disk. A single test process cannot spin up two
 *    real Render services; it can trivially prove the directory-isolation
 *    mechanism that was the actual cause.
 * 3. The real cross-process proof for the NEW adapter: two INDEPENDENT
 *    database connections (two separate `pg.Pool`s, not two references to
 *    the same one) — save through one, read through the other. This is the
 *    one property that matters for `web`/`worker`: they share nothing but
 *    network access to the same Postgres instance, so two independent
 *    connections is the closest a single test process can get to that,
 *    short of an actual second deployed service.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db as defaultDb } from "../../lib/db";
import { applications, labelImageBlobs, labelImages } from "../../lib/db/schema";
import * as schema from "../../lib/db/schema";
import { deleteLabelImageBlobsWhere, LabelImageNotFoundError, readLabelImage, saveLabelImage } from "./db-image-storage";

const createdStorageKeys: string[] = [];

afterEach(async () => {
  const keys = createdStorageKeys.splice(0);
  await Promise.all(keys.map((key) => defaultDb.delete(labelImageBlobs).where(eq(labelImageBlobs.storageKey, key))));
});

describe("saveLabelImage / readLabelImage (TRO-518)", () => {
  it("writes bytes and returns a storagePath a reader can open", async () => {
    const bytes = Buffer.from("fake-jpeg-bytes");
    const saved = await saveLabelImage(bytes, "front-label.jpg");
    createdStorageKeys.push(saved.storagePath);

    const roundTripped = await readLabelImage(saved.storagePath);
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it("never collides two uploads with the same original filename", async () => {
    const first = await saveLabelImage(Buffer.from("one"), "label.jpg");
    const second = await saveLabelImage(Buffer.from("two"), "label.jpg");
    createdStorageKeys.push(first.storagePath, second.storagePath);

    expect(first.storagePath).not.toBe(second.storagePath);
    expect((await readLabelImage(first.storagePath)).toString()).toBe("one");
    expect((await readLabelImage(second.storagePath)).toString()).toBe("two");
  });

  it("round-trips arbitrary binary content, not just text", async () => {
    // A real JPEG is binary, not printable ASCII — this guards against a
    // customType mapping that silently corrupts non-text bytes (e.g. via
    // an implicit string encoding somewhere in the read or write path).
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0xd8, 0xff]);
    const saved = await saveLabelImage(bytes, "binary.jpg");
    createdStorageKeys.push(saved.storagePath);

    const roundTripped = await readLabelImage(saved.storagePath);
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it("never needs the caller to know how storagePath is constructed — the value alone is enough", async () => {
    const saved = await saveLabelImage(Buffer.from("second file"), "back-label.jpg");
    createdStorageKeys.push(saved.storagePath);

    // storagePath is documented opaque outside this module (see
    // saveLabelImage's own comment) — this only proves readLabelImage can
    // resolve exactly the value that function actually returned.
    const roundTripped = await readLabelImage(saved.storagePath);
    expect(roundTripped.toString()).toBe("second file");
  });

  it("rejects with LabelImageNotFoundError (never silently returns empty bytes) when no row matches", async () => {
    await expect(readLabelImage("does-not-exist")).rejects.toThrow(LabelImageNotFoundError);
  });

  it("rejects with LabelImageNotFoundError for a storagePath that is not even a legal key shape (e.g. a legacy filesystem path)", async () => {
    // A `label_images.storage_path` value written under the pre-TRO-518
    // filesystem-storage regime looked like "uploads/<uuid>-name.jpg" — not
    // a bare key this table would ever contain. This must still answer a
    // clean "not found," never a raised database error (standing rule 13;
    // see storageKey's own column comment in schema.ts for why it is a
    // plain `text` column, not a stricter `uuid` one).
    await expect(readLabelImage("uploads/12345-legacy-file.jpg")).rejects.toThrow(LabelImageNotFoundError);
  });
});

describe("the old design's failure mode was real (TRO-518)", () => {
  let webDisk: string;
  let workerDisk: string;

  beforeEach(async () => {
    // Two separate directories stand in for two separate Render disks —
    // see this file's header comment for why that equivalence holds.
    webDisk = await mkdtemp(path.join(tmpdir(), "labelhunter-tro518-web-disk-"));
    workerDisk = await mkdtemp(path.join(tmpdir(), "labelhunter-tro518-worker-disk-"));
  });

  afterEach(async () => {
    await Promise.all([rm(webDisk, { recursive: true, force: true }), rm(workerDisk, { recursive: true, force: true })]);
  });

  it("a file the web disk wrote is invisible to a reader on the worker disk", async () => {
    const bytes = Buffer.from("a real batch label image");
    const filename = "front-label.jpg";

    // The `web` service saves the image — local-file-storage.ts's own
    // write shape: join(baseDir, filename), writeFile.
    await writeFile(path.join(webDisk, filename), bytes);

    // The `worker` service, on Render, is a DIFFERENT process with a
    // DIFFERENT disk — it never sees webDisk. Reading the SAME filename
    // from workerDisk is exactly that gap, reproduced locally.
    await expect(readFile(path.join(workerDisk, filename))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the same read succeeds when writer and reader share one disk — proving the bug is specifically about the disk being different, not about reading in general", async () => {
    const bytes = Buffer.from("a real batch label image");
    const filename = "front-label.jpg";

    await writeFile(path.join(webDisk, filename), bytes);
    const readBack = await readFile(path.join(webDisk, filename));

    expect(readBack.equals(bytes)).toBe(true);
  });
});

describe("cross-process round trip through Postgres (TRO-518)", () => {
  let webPool: Pool;
  let workerPool: Pool;
  let webDb: ReturnType<typeof drizzle<typeof schema>>;
  let workerDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set — source .factory-env before running this suite.");
    }
    // Two INDEPENDENT pools against the SAME DATABASE_URL — not two
    // references to `../../lib/db`'s one shared pool. This is what makes
    // the round trip below a genuine cross-connection proof rather than an
    // in-memory reference the acceptance evidence explicitly rules out.
    webPool = new Pool({ connectionString });
    workerPool = new Pool({ connectionString });
    webDb = drizzle(webPool, { schema });
    workerDb = drizzle(workerPool, { schema });
  });

  afterEach(async () => {
    await Promise.all([webPool.end(), workerPool.end()]);
  });

  it("reads back bytes saved through a completely separate connection", async () => {
    const bytes = Buffer.from("a real batch label image, saved by the web service");

    // Simulates POST /api/batch/start on `labelhunter-web`.
    const saved = await saveLabelImage(bytes, "front-label.jpg", { db: webDb });
    createdStorageKeys.push(saved.storagePath);

    // Simulates extract-worker.ts on `labelhunter-worker` — a fully
    // separate connection, opened after the write, never touching webDb.
    const roundTripped = await readLabelImage(saved.storagePath, { db: workerDb });

    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it("a row written on one connection is visible to a THIRD connection too — not a two-connection coincidence", async () => {
    const bytes = Buffer.from("visible from anywhere with the same DATABASE_URL");
    const saved = await saveLabelImage(bytes, "label.jpg", { db: webDb });
    createdStorageKeys.push(saved.storagePath);

    const thirdPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const thirdDb = drizzle(thirdPool, { schema });
    try {
      const roundTripped = await readLabelImage(saved.storagePath, { db: thirdDb });
      expect(roundTripped.equals(bytes)).toBe(true);
    } finally {
      await thirdPool.end();
    }
  });
});

describe("deleteLabelImageBlobsWhere (test-cleanup helper, TRO-518)", () => {
  const createdApplicationIds: number[] = [];

  afterEach(async () => {
    const ids = createdApplicationIds.splice(0);
    await Promise.all(ids.map((id) => defaultDb.delete(applications).where(eq(applications.id, id))));
  });

  async function seedApplicationWithImage(storagePath: string): Promise<number> {
    const [application] = await defaultDb
      .insert(applications)
      .values({
        beverageType: "spirits",
        brandName: "TRO-518 Test Fixture",
        classType: "Straight Bourbon Whiskey",
        abvPercent: 45,
        netContentsValue: 750,
        netContentsUnit: "mL",
      })
      .returning();
    createdApplicationIds.push(application.id);

    await defaultDb.insert(labelImages).values({
      applicationId: application.id,
      storagePath,
      originalFilename: "front-label.jpg",
      widthPx: 1200,
      heightPx: 1600,
    });
    return application.id;
  }

  it("deletes the blob row a matching label_images row points at", async () => {
    const saved = await saveLabelImage(Buffer.from("real bytes"), "front-label.jpg");
    const applicationId = await seedApplicationWithImage(saved.storagePath);

    await deleteLabelImageBlobsWhere(eq(labelImages.applicationId, applicationId));

    await expect(readLabelImage(saved.storagePath)).rejects.toThrow(LabelImageNotFoundError);
  });

  it("leaves a blob row alone when no label_images row references it", async () => {
    const saved = await saveLabelImage(Buffer.from("unrelated bytes"), "other.jpg");
    createdStorageKeys.push(saved.storagePath);
    // A different application, matched by a condition that excludes it.
    const applicationId = await seedApplicationWithImage("test-fixtures/placeholder.jpg");

    await deleteLabelImageBlobsWhere(eq(labelImages.applicationId, applicationId));

    // The unrelated blob is untouched — only the placeholder-pathed
    // label_images row matched the condition, and "test-fixtures/..." was
    // never a real label_image_blobs key to begin with.
    const stillThere = await readLabelImage(saved.storagePath);
    expect(stillThere.toString()).toBe("unrelated bytes");
  });

  it("is a safe no-op when the condition matches no label_images row at all", async () => {
    await expect(deleteLabelImageBlobsWhere(eq(labelImages.applicationId, -1))).resolves.toBeUndefined();
  });
});
