/**
 * Client-side fetch wrapper for the verify screen (TRO-465, TH-R20's
 * designed error states). Pure — no React import — so it is unit tested
 * directly with a fake `fetch`, no DOM and no component render needed.
 * `src/app/_components/VerifyForm.tsx` injects this as a prop (default:
 * `submitVerification` itself), the same dependency-injection shape the
 * server side uses (`src/app/api/verify/route.ts`'s `VerifyRouteDeps`).
 */
import type { BeverageType } from "../../lib/db/enums";
import type { VerifyErrorKind, VerifyErrorResponse, VerifySuccessResponse } from "../api/verify/types";

export class VerifyClientError extends Error {
  readonly kind: VerifyErrorKind;

  constructor(kind: VerifyErrorKind, message: string) {
    super(message);
    this.name = "VerifyClientError";
    this.kind = kind;
  }
}

export interface VerifyFormValues {
  imageFile: File;
  beverageType: BeverageType;
  brandName: string;
  classType: string;
  /** Raw text from the number input. `""` when the applicant left it
   * blank — legal for beer/wine (PRD §2). */
  alcoholContentPercent: string;
  netContentsValue: string;
  netContentsUnit: string;
}

export interface SubmitVerificationOptions {
  /** Hard ceiling on the whole request, matching TH-R20's "API failure/
   * timeout with a retry affordance" designed error state. 45s: generous
   * above the Haiku extractor's own 30s client timeout
   * (`src/server/extractor/index.ts`), so a genuinely slow extraction still
   * gets its own honest EXTRACTION/SERVICE response before this fires. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 45_000;

export function buildVerifyFormData(values: VerifyFormValues): FormData {
  const formData = new FormData();
  formData.set("image", values.imageFile);
  formData.set("beverageType", values.beverageType);
  formData.set("brandName", values.brandName);
  formData.set("classType", values.classType);
  formData.set("alcoholContentPercent", values.alcoholContentPercent);
  formData.set("netContentsValue", values.netContentsValue);
  formData.set("netContentsUnit", values.netContentsUnit);
  return formData;
}

function isVerifyErrorResponse(payload: unknown): payload is VerifyErrorResponse {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "object"
  );
}

/**
 * Submits one verify request. Resolves with the checklist on success;
 * rejects with `VerifyClientError` on every failure mode TH-R20 names —
 * network failure, a timeout, a non-2xx response with a structured error
 * body, or a response this client cannot even parse. The caller
 * (`VerifyForm.tsx`) never sees a raw, unclassified error.
 */
export async function submitVerification(
  values: VerifyFormValues,
  options: SubmitVerificationOptions = {},
): Promise<VerifySuccessResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl("/api/verify", {
      method: "POST",
      body: buildVerifyFormData(values),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new VerifyClientError("SERVICE", "LabelHunter took too long to respond. Check your connection and try again.");
    }
    throw new VerifyClientError("SERVICE", "LabelHunter could not reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timeoutId);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VerifyClientError("SERVICE", "LabelHunter received an unexpected response. Try again.");
  }

  if (!response.ok) {
    if (isVerifyErrorResponse(payload)) {
      throw new VerifyClientError(payload.error.kind, payload.error.message);
    }
    throw new VerifyClientError("SERVICE", "LabelHunter could not complete this request. Try again.");
  }

  return payload as VerifySuccessResponse;
}
