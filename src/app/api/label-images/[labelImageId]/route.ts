/**
 * GET /api/label-images/:labelImageId — serves one uploaded label image's
 * bytes (TRO-466, PRD §5's Detail view: "label image side-by-side with
 * extracted vs application values per field").
 *
 * Every image `src/server/preprocessing/pipeline.ts` produces is re-encoded
 * to JPEG regardless of the original upload's format (`OUTPUT_MEDIA_TYPE`,
 * `constants.ts`) — so this route always answers `Content-Type:
 * image/jpeg`, a fact read from that one shared constant, never sniffed or
 * guessed per file.
 *
 * **Missing-image handling (TRO-518).** `db-image-storage.ts` stores image
 * bytes in Postgres, not on a service's own disk, so the old "Render's
 * filesystem is ephemeral" failure mode this route used to guard against no
 * longer applies. A stored image can still go missing, though — most
 * plausibly a `label_images` row left over from before this ticket, whose
 * `storage_path` is a filesystem-style value (e.g.
 * `"uploads/<uuid>-name.jpg"`) that no `label_image_blobs` row will ever
 * match. That case, and a bad or unknown id, both answer the same designed
 * 404 (TH-R20) — never an unhandled crash. A read failure for any OTHER
 * reason (a database error) answers 500 instead — the row exists and the
 * blob lookup itself failed, so "not found" would not be the true fact.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../../lib/db";
import { labelImages } from "../../../../lib/db/schema";
import { OUTPUT_MEDIA_TYPE } from "../../../../server/preprocessing/constants";
import { LabelImageNotFoundError, readLabelImage as defaultReadLabelImage } from "../../../../server/storage/db-image-storage";

export interface LabelImageRouteDeps {
  db: typeof defaultDb;
  readLabelImage: (storagePath: string) => Promise<Buffer>;
}

const defaultDeps: LabelImageRouteDeps = {
  db: defaultDb,
  readLabelImage: defaultReadLabelImage,
};

function notFound(): Response {
  return new NextResponse("This label image was not found.", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

function readFailed(): Response {
  return new NextResponse("LabelHunter could not read this label image. Try again.", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}

/** TRO-518: `db-image-storage.ts`'s `readLabelImage` throws
 * `LabelImageNotFoundError` for a missing image — the database-shaped
 * replacement for the Node `fs` `ENOENT` code this check used to test. */
function isMissingImageError(error: unknown): boolean {
  return error instanceof LabelImageNotFoundError;
}

export async function handleGetLabelImage(labelImageIdRaw: string, deps: LabelImageRouteDeps = defaultDeps): Promise<Response> {
  const labelImageId = Number(labelImageIdRaw);
  if (!Number.isInteger(labelImageId) || labelImageId <= 0) {
    return notFound();
  }

  const [row] = await deps.db.select().from(labelImages).where(eq(labelImages.id, labelImageId));
  if (!row) return notFound();

  let bytes: Buffer;
  try {
    bytes = await deps.readLabelImage(row.storagePath);
  } catch (error) {
    // See the file comment — a missing image is a designed 404, never an
    // unhandled crash (TH-R20). A different read failure is not the same
    // fact as "not found" — the row exists and something else is wrong,
    // and that is a server error, not a 404.
    if (isMissingImageError(error)) return notFound();
    return readFailed();
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": OUTPUT_MEDIA_TYPE,
      // Private: this is a compliance photo behind the app's own access
      // gate (PRD §8), never meant for a shared/public cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ labelImageId: string }> },
): Promise<Response> {
  const { labelImageId } = await params;
  return handleGetLabelImage(labelImageId);
}
