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
 * `local-file-storage.ts`'s own module comment documents a known,
 * accepted limitation: Render's filesystem is ephemeral, so a deploy or
 * restart can lose a saved file while its `label_images` row survives.
 * That case, and a bad or unknown id, both answer the same designed 404
 * (TH-R20) — never an unhandled crash.
 */
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db as defaultDb } from "../../../../lib/db";
import { labelImages } from "../../../../lib/db/schema";
import { OUTPUT_MEDIA_TYPE } from "../../../../server/preprocessing/constants";
import { readLabelImage as defaultReadLabelImage } from "../../../../server/storage/local-file-storage";

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
  } catch {
    // The database row survives a lost file (see the file comment) — a
    // missing file is a designed 404, never an unhandled crash (TH-R20).
    return notFound();
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
