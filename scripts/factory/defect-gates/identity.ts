import { createHash } from "node:crypto";

/**
 * A stable identifier for one violation.
 *
 * Line numbers shift under unrelated edits, so a position-based identifier
 * would make the H \ B comparison report false failures. This mirrors
 * testdiff.mjs, which compares test failures by identity rather than by
 * position — the property that lets the gate catch a forged break-one
 * fix-one swap.
 */
export function violationIdentity(
  ruleId: string,
  repoRelativePath: string,
  enclosingFunctionName: string,
  nodeText: string,
): string {
  const normalised = nodeText.replace(/\s+/g, "");
  return createHash("sha256")
    .update([ruleId, repoRelativePath, enclosingFunctionName, normalised].join("|"))
    .digest("hex");
}
