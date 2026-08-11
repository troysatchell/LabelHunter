/**
 * Validates the shape of a successful (HTTP 200) `/api/verify` response
 * body before the latency harness (TRO-471 / LH-031) trusts it as a real
 * result. Split out from `measure.ts` for the same reason `args.ts` and
 * `cleanup.ts` are: `measure.ts` calls `main()` unconditionally at module
 * scope (a real, live, paid API call per run), so a test importing it
 * would spend real money just to load the module.
 *
 * `route.ts`'s own type system guarantees a well-formed body on every real
 * 200 response today — this cannot fail against the current, unmodified
 * route. It is still a real boundary this repo's own convention treats as
 * untrusted (standing rule 13: "validate at the boundary where a value's
 * shape is only assumed") rather than trusted by a bare `as` cast. Without
 * this check, a malformed 200 body (a future route.ts bug, a partial
 * response, a body a proxy rewrote) would have been reported as a
 * successful run with `undefined` fields baked into the committed
 * evidence file, instead of a clearly failed one.
 */

export interface VerifySuccessBody {
  applicationId: number;
  labelVerdict: string;
  headlineReason: string | null;
}

/**
 * Returns the typed body when `body` matches `VerifySuccessBody`'s shape,
 * `null` otherwise. Never throws — a caller decides what a `null` means
 * (here, a failed run, not a crash).
 */
export function parseVerifySuccessBody(body: unknown): VerifySuccessBody | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.applicationId !== "number") return null;
  if (typeof candidate.labelVerdict !== "string") return null;
  if (candidate.headlineReason !== null && typeof candidate.headlineReason !== "string") return null;
  return {
    applicationId: candidate.applicationId,
    labelVerdict: candidate.labelVerdict,
    headlineReason: candidate.headlineReason as string | null,
  };
}
