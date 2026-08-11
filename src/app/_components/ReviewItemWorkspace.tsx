"use client";

/**
 * Ties the review/detail view to the approve/reject action and to what
 * happens next (TRO-476, PRD §5). Kept intentionally thin, and not
 * unit-tested directly — the same division `src/app/page.tsx` and (once
 * merged) `verify/[verificationId]/page.tsx` already use: every real
 * behavior here (`ReviewItemDetail`'s rendering, `ReviewActions`'
 * fetch/submit/error handling) is tested on its own. The one thing this
 * file adds is `useRouter`, a client-only hook with no mockable seam this
 * codebase has an established pattern for yet — a reason to keep this
 * file small, not a reason to skip testing its parts.
 */
import { useRouter } from "next/navigation";
import type { ReviewQueueItemDetail } from "../../server/review-queue";
import { ReviewActions } from "./ReviewActions";
import { ReviewItemDetail } from "./ReviewItemDetail";

export interface ReviewItemWorkspaceProps {
  item: ReviewQueueItemDetail;
}

export function ReviewItemWorkspace({ item }: ReviewItemWorkspaceProps) {
  const router = useRouter();

  return (
    <>
      <ReviewItemDetail item={item} />
      {/* No buttons on an item a reviewer opens after it is already
          resolved (TH-R3 — no dead actions that would just fail). The
          status line above already says what happened. */}
      {!item.disposition && <ReviewActions reviewQueueId={item.id} onResolved={() => router.push("/review-queue")} />}
    </>
  );
}
