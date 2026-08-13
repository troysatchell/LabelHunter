/**
 * Shapes shared between the verify API route (`route.ts`, server) and the
 * Verify screen (`src/app/_components/`, client) — TRO-465, PRD §5.
 *
 * Pure types and pure constants only. No server-only import (`pg`, `sharp`,
 * `@anthropic-ai/sdk`) belongs in this file — the client bundle imports it
 * too.
 */
import type { BeverageType } from "../../../lib/db/enums";
import type { FieldVerdict, LabelVerdict, ReviewReason, RouterFieldKey } from "../../../server/router";

export const BEVERAGE_TYPE_OPTIONS: readonly { value: BeverageType; label: string }[] = [
  { value: "beer", label: "Beer" },
  { value: "wine", label: "Wine" },
  { value: "spirits", label: "Spirits" },
];

/** The net-contents units the form offers. Matches what
 * `src/server/router/provisional-numeric.ts` can parse — offering a unit
 * that stand-in cannot read would make every net-contents check needs-review
 * by construction, which is not an honest reason to show a first-time user. */
export const NET_CONTENTS_UNIT_OPTIONS: readonly string[] = ["mL", "L", "fl oz"];

/** Human-readable label for one of the router's five fields (PRD §5's
 * checklist rows). One source of truth — both the API route (for a log
 * line) and the results checklist component read from here. */
export const FIELD_LABELS: Record<RouterFieldKey, string> = {
  brand_name: "Brand name",
  class_type: "Class/type",
  alcohol_content: "Alcohol content",
  net_contents: "Net contents",
  government_warning: "Government warning",
};

/** One checklist row, as the API returns it. */
export interface VerifyFieldResult {
  field: RouterFieldKey;
  fieldLabel: string;
  verdict: FieldVerdict;
  /** What the extractor read on the label. `null` when absent or rejected. */
  labelValue: string | null;
  /** Verbatim label text supporting `labelValue` (PRD §3.2 — evidence, not
   * a bare value). */
  evidence: string;
  /** One line of UI English (TH-R20) — never a bare confidence percentage. */
  reason: string;
  reviewReason: ReviewReason | null;
}

/** A completed verify request's success body. */
export interface VerifySuccessResponse {
  applicationId: number;
  verificationId: number;
  labelVerdict: LabelVerdict;
  headlineReason: ReviewReason | null;
  /** PRD §3.8's explicit "needs review — {reason}" flag, pre-built server
   * side from the same reason text a field row shows. `null` for a clean
   * PASS or a deterministic FAIL — those need no separate flag. */
  headlineMessage: string | null;
  fields: VerifyFieldResult[];
}

/** Which designed error state (TH-R20) the UI shows. Each kind gets its own
 * copy and its own retry affordance — see
 * `src/app/_components/ErrorPanel.tsx`. The array is the source of truth;
 * the type is derived from it — `src/app/_lib/verify-client.ts` uses the
 * array at runtime to check a `kind` value from an HTTP response actually
 * belongs to this set before trusting it.
 *
 * `RATE_LIMITED` and `BUDGET_EXHAUSTED` (TRO-482 / LH-061, PRD §8) are the
 * key-protection guard's own two rejection states — a fixed-window rate
 * limit and the daily spend budget respectively. Both are checked BEFORE
 * the Haiku call, never after (`route.ts`'s own header comment). */
export const VERIFY_ERROR_KINDS = ["VALIDATION", "IMAGE", "EXTRACTION", "SERVICE", "RATE_LIMITED", "BUDGET_EXHAUSTED"] as const;
export type VerifyErrorKind = (typeof VERIFY_ERROR_KINDS)[number];

export interface VerifyErrorResponse {
  error: {
    kind: VerifyErrorKind;
    message: string;
  };
}
