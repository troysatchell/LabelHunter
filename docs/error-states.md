# Designed error states (TRO-478 / LH-052)

TH-R20 asks for a UI that a first-time, non-technical user can operate with
no instructions. Every failure mode must produce a useful outcome. None may
show a raw exception, a stack trace, or a bare error code.

TH-R7 asks for two things: name every outbound network dependency, and
document what the app does when a firewall blocks one. This is the lesson
from the vendor pilot in the interview: a blocked ML endpoint broke half
that vendor's features, with no warning to the user.

This document covers the single-label verify flow (`POST /api/verify`). It
is the error-path walkthrough TH-R20 asks for, and the dependency list
TH-R7 asks for. LH-064 (`docs/approach.md`, not yet written) will fold this
into the submission's trade-offs section. This file is the working source.

## Outbound dependencies (TH-R7)

LabelHunter calls two kinds of host while it runs: one public vendor API
(Anthropic), and its own private database (Postgres). TH-R7's concern is
the first kind: a vendor's cloud ML endpoint, reachable only through a
corporate firewall's domain allow-list. The table below names both kinds,
so the distinction is explicit, not assumed.

| Dependency | When it is called | Required? | If blocked or unreachable |
|---|---|---|---|
| Anthropic API (`api.anthropic.com`) | Every verify request (Haiku extraction). Escalated labels only (Sonnet resolver, LH-014) — never the per-label happy path (TH-R19). | Yes — the core function. | See "Unreachable-endpoint degradation" below. Graceful: a clear message, no crash, no hang, a retry button. |
| Postgres database | Every verify request, once extraction succeeds — persists the application, image, verdict, and field rows. | Yes — nothing persists without it. | 503 SERVICE: "LabelHunter could not save this verification. Try again." (`route.ts`, tested in `route.test.ts`). Not a TH-R7 concern in the same sense — not a public-internet vendor endpoint behind a firewall allow-list. In production it is a same-network Render service; in local dev it is `localhost`. |
| Google Generative Language API (Gemini/Imagen) | Dev-time only: golden-set image generation (`GOOGLE_API_KEY`, `.env.local.example`). | No — build-time tooling, not part of the deployed app. | Irrelevant at runtime. The running app has no code path that calls Google. |

**Design consequence.** LabelHunter makes exactly one outbound call to a
public vendor API while it runs. One function guards it: `extractLabel`
(`src/server/extractor/index.ts`). One degradation path covers every way
that call can fail: a wrong response, a timeout, or an unreachable
endpoint. `src/app/api/verify/route.ts` catches all three around that one
call. This is the dependency TH-R7's firewall scenario is about — the one
address a deployer's network team needs to allow through.

## The four single-label designed states (TH-R20)

Each state below is scoped to one label, verified against the already-shipped
verify flow. Every state: shows plain English, names what happened, and
(where the user can do something about it) offers a next step. None ever
shows a raw exception message, a stack trace, or a bare error code.

### 1. Unreadable image

**Trigger.** The uploaded file has a real image header: a JPEG, PNG, WEBP,
or HEIC signature. Its pixel data is damaged. It may be truncated mid-file,
corrupted in transit, or unreadable for another reason.

This state is distinct from two others. An unsupported format (below) has
no recognizable image header at all. `LOW_IMAGE_QUALITY` (LH-051) is a
different case: the file decodes fine but is blurry, glared, or poorly lit.
That is a judgment call for the router, not a preprocessing rejection.

**What the app does.** `preprocessImage` (`src/server/preprocessing/pipeline.ts`)
attempts to decode the file with `sharp`. A decode failure that matches
neither the pixel-limit nor the unsupported-format signature is classified
`UnreadableImageError` (`src/server/preprocessing/errors.ts`). The route
returns HTTP 422, `kind: "IMAGE"`.

**What the user sees.** Panel title "LabelHunter can't use this photo."
Message: "LabelHunter cannot open this file. It may be damaged. Take a new
photo and try again." A "Try again" button re-submits the form.

**Test.** `src/app/api/verify/route.test.ts` — "an unreadable image
(TRO-478): a valid JPEG header with damaged pixel data." Confirms the
extractor is never called — a damaged file never reaches Haiku.

### 2. Oversized file

**Trigger.** The upload exceeds `MAX_UPLOAD_BYTES` (20 MB,
`src/server/preprocessing/constants.ts`). This ceiling is generous for a
real phone photo. It still bounds the worst-case processing cost.

**What the app does.** `assertUploadSize` runs before any decode attempt
(`src/server/preprocessing/validate.ts`). An oversized file is rejected
cheaply, before `sharp` ever opens it. The route returns HTTP 422,
`kind: "IMAGE"`.

**What the user sees.** Panel title "LabelHunter can't use this photo."
Message: "This file is {size}. The limit is 20.0 MB. Choose a smaller
image." — the actual file size, not a generic ceiling notice.

**Test.** `src/app/api/verify/route.test.ts` — "an oversized file
(TRO-478)." Confirms the extractor is never called.

### 3. API failure or timeout, with a retry affordance

**Trigger.** The verify request fails after it leaves the browser. The
network drops mid-request, the server takes too long, or the response body
never finishes arriving.

**What the app does.** Two independent timeouts bound this end to end:

1. The Anthropic client itself times out after 30 seconds
   (`DEFAULT_CLIENT_TIMEOUT_MS`, `src/server/extractor/index.ts`) — a safety
   net against a hung model call.
2. The browser's own request carries a 45-second `AbortController` timeout
   (`DEFAULT_TIMEOUT_MS`, `src/app/_lib/verify-client.ts`). This is generous
   above the server-side figure. A genuinely slow extraction still returns
   its own honest error first.

That timer must stay live for the whole request. This includes the response
body read, not just the wait for `fetch()` to return headers.

This ticket fixes a bug in that timer. The old code cleared the timer in a
`finally` block right after `fetch()` resolved. Once headers arrived, no
timeout protected the body read at all — a response whose body never
finished streaming would hang forever. The sibling file
`review-queue-client.ts` had the identical bug, fixed for TRO-476. This
ticket applies the same fix to `verify-client.ts` (standing rule 23).

**What the user sees.** Panel title "Something went wrong." Message:
"LabelHunter took too long to respond. Check your connection and try
again." (timeout) or "LabelHunter could not reach the server. Check your
connection and try again." (network failure). A "Try again" button
re-submits the same form values. Nothing typed is lost.

**Tests.**
- `src/app/_lib/verify-client.test.ts` — "keeps the timeout live through the
  response body read, not just until fetch() resolves (TRO-478)." Red before
  this ticket's fix: the manufactured slow body read resolved successfully
  instead of aborting, because the timer had already been cleared. Green
  after.
- `src/app/_components/VerifyForm.test.tsx` — "shows the SERVICE error panel
  on an API failure/timeout (TRO-478), and 'Try again' resubmits."

### 4. Unreachable-endpoint degradation (TH-R7)

**Trigger.** The Anthropic API is unreachable from wherever the app runs —
a firewall blocks the outbound domain, DNS resolution fails, or the
connection is refused. This is TH-R7's exact scenario: "our firewall
blocked connections to their ML endpoints."

**What the app does.** The Anthropic SDK raises `APIConnectionError` for
this case (or `APIConnectionTimeoutError` for a connect-level timeout).
This is a different class from `HaikuExtractionError`, which means a
response arrived but failed validation.

`src/app/api/verify/route.ts`'s extraction `catch` block only special-cases
`HaikuExtractionError`. Every other failure — including a connection
error — falls to the same designed `SERVICE` state. No raw SDK error name
or cause reaches the response body.

No partial record is written. The database transaction only starts after a
successful extraction. An unreachable endpoint leaves nothing half-saved.

**What the user sees.** Panel title "Something went wrong." Message:
"LabelHunter could not reach the verification service. Try again." A "Try
again" button re-submits.

**The trade-off this design makes, stated plainly.** LabelHunter does not
try to tell these apart: the Anthropic API is down, a firewall blocks it,
or the network is unreachable for some other reason. All three look
identical from inside one HTTP client. A first-time user cannot act
differently on any of them anyway. One honest state, and one retry button,
covers all three.

If a deployer's network permanently blocks `api.anthropic.com`, every
verify request fails this way. The app degrades to "unavailable." It never
gives a silent wrong answer.

This is the TH-R7 trade-off: LabelHunter has exactly one outbound
dependency on a public vendor API (the table above). There is exactly one
address to allow through the firewall. There is exactly one honest failure
state for when that has not been done.

**Test.** `src/app/api/verify/route.test.ts` — "the Anthropic endpoint is
unreachable (TRO-478, TH-R7)." Uses the real `APIConnectionError` class, not
a generic stand-in `Error`, and asserts no SDK-internal detail
(`APIConnectionError`, `ECONNREFUSED`, `ENOTFOUND`) leaks into the response,
and that no application/verification row is left behind.

## The four batch-scoped states, built in LH-042

LH-052's ticket text named four batch-pipeline states — malformed CSV,
unpairable rows, partial batch failure, and a rate-limit backoff notice —
and deferred all four, unbuilt, to whoever built the batch UI once LH-040
and LH-041 landed. LH-042 (TRO-475) is that ticket. All four are real and
tested, not just described:

1. **Malformed CSV.** `POST /api/batch/preview` and `POST /api/batch/start`
   both return 422, `kind: "MALFORMED_CSV"`, for a manifest that fails to
   parse structurally (missing a required column, a row with the wrong
   cell count). `BatchUploadForm.tsx` shows the server's own plain-English
   message inline. Test: `src/app/api/batch/start/route.test.ts` —
   "returns 422 MALFORMED_CSV for a manifest missing a required column."
2. **Unpairable rows.** A row with no matching image, an image with no
   matching row, or a row that fails field-level validation is data inside
   a successful preview, not a request failure (`unmatchedRows`/
   `unmatchedImages`/`invalidRows`) — the preview screen lists each one by
   name and reason before the user decides whether to start the batch.
   Test: `src/app/_components/BatchUploadForm.test.tsx` — "reports
   unmatched rows, unmatched images, and invalid rows — never silently
   dropped."
3. **Partial batch failure.** One bad image fails only that label, never
   the job (PRD §3.5) — `src/server/batch-start/start-batch.ts`'s own
   per-pairing try/catch, and (once a batch is running) LH-041's own
   non-retryable-failure path. The progress screen shows a count and, per
   row, the stored `batch_queue_items.last_error` as the reason (CP-3
   §7.3). Test: `src/server/batch-progress/get-batch-progress.test.ts` —
   "includes a FAILED EXTRACT item... with its stored last_error as status
   detail."
4. **Rate-limit backoff notice.** LH-041's own real backoff state (an item
   released back to `PENDING` with `available_at` pushed into the future
   after a retryable failure, CP-3 §5.2) is read, not recomputed —
   `src/server/batch-progress/get-batch-progress.ts`'s `rateLimitBackoff`
   field. The notice never claims to know the retry was specifically a
   rate limit rather than some other transient error; that distinction is
   not observable from the queue rows alone. Test:
   `src/server/batch-progress/get-batch-progress.test.ts` — "reports
   rateLimitBackoff.active only when a PENDING item is genuinely waiting
   out a scheduled retry."

See `CHANGES.md`'s TRO-475 entry for the full build.
