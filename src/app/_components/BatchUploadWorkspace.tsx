"use client";

/**
 * Ties the batch upload form to what happens once a batch actually starts
 * (LH-042 / TRO-475). Kept intentionally thin and not unit-tested directly
 * — the same division `ReviewItemWorkspace.tsx` already uses for the
 * identical reason: `useRouter` is a client-only hook with no mockable
 * seam this codebase has an established pattern for yet. Every real
 * behavior lives in `BatchUploadForm`, tested on its own via its
 * `onStarted` callback prop.
 */
import { useRouter } from "next/navigation";
import { BatchUploadForm } from "./BatchUploadForm";

export function BatchUploadWorkspace() {
  const router = useRouter();
  return <BatchUploadForm onStarted={(batchJobId) => router.push(`/batch/${batchJobId}`)} />;
}
