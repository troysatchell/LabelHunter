/**
 * Client-side fetch wrapper for the verify form's auto-fill assist
 * (TRO-576). Same shape and discipline as `verify-client.ts`: pure, no
 * React import, unit tested with a fake `fetch`, injected into
 * `VerifyForm.tsx` as a prop.
 *
 * One deliberate difference from the verify client: callers treat every
 * rejection as "the assist is unavailable" and fall back to manual entry.
 * The assist must never block the form — a failure here quiets down to
 * one plain sentence, not an error panel.
 */
import {
  EXTRACT_ERROR_KINDS,
  type ExtractErrorKind,
  type ExtractErrorResponse,
  type ExtractSuccessResponse,
} from "../api/extract/types";

export class ExtractClientError extends Error {
  readonly kind: ExtractErrorKind;

  constructor(kind: ExtractErrorKind, message: string) {
    super(message);
    this.name = "ExtractClientError";
    this.kind = kind;
  }
}

export interface RequestExtractionOptions {
  /** Same ceiling and rationale as `verify-client.ts`: 45s sits above the
   * extractor's own 30s client timeout, so a slow extraction still gets
   * its honest server-side answer before this fires. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 45_000;

function isExtractErrorResponse(payload: unknown): payload is ExtractErrorResponse {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && (EXTRACT_ERROR_KINDS as readonly string[]).includes(kind) && typeof message === "string";
}

/** True only when `payload` has the prefill shape `VerifyForm.tsx`
 * actually applies. Field-level nullability is checked loosely on purpose
 * — the form re-checks each value against its own input before setting
 * it — but the structure itself must be present, or a malformed 200 would
 * crash the assist instead of quietly standing down. */
function isExtractSuccessResponse(payload: unknown): payload is ExtractSuccessResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Partial<ExtractSuccessResponse>;
  return (
    (body.outcome === "prefill" || body.outcome === "unreadable") &&
    typeof body.fields === "object" &&
    body.fields !== null
  );
}

/**
 * Sends the label photo for an extract-only read. Resolves with the
 * prefill; rejects with `ExtractClientError` on every failure mode. The
 * caller treats any rejection as "assist unavailable" and lets the agent
 * type — never a blocking error.
 */
export async function requestExtraction(imageFile: File, options: RequestExtractionOptions = {}): Promise<ExtractSuccessResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const formData = new FormData();
  formData.set("image", imageFile);

  let response: Response;
  try {
    response = await fetchImpl("/api/extract", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    throw new ExtractClientError("SERVICE", "LabelHunter could not reach the server.");
  }

  // The timer stays live through the body read — same standing-rule-23
  // posture as verify-client.ts (its own comment has the history).
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExtractClientError("SERVICE", "LabelHunter received an unexpected response.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (isExtractErrorResponse(payload)) {
      throw new ExtractClientError(payload.error.kind, payload.error.message);
    }
    throw new ExtractClientError("SERVICE", "LabelHunter could not complete this request.");
  }

  if (!isExtractSuccessResponse(payload)) {
    throw new ExtractClientError("SERVICE", "LabelHunter received an unexpected response.");
  }

  return payload;
}
