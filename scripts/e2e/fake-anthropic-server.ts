/**
 * A fake stand-in for the Anthropic Messages API (TRO-479, PRD §6's
 * Playwright suite).
 *
 * **Why this exists.** The E2E specs drive a real, running Next.js server
 * and a real background worker (`playwright.config.ts`) — but pointing
 * either at the real `api.anthropic.com` on every E2E run would spend real
 * money on every run (CLAUDE.md: "never fabricate a number" and the $25
 * spend-cap discipline, PRD §4) for a nondeterministic model response the
 * suite cannot assert against reliably. `getDefaultExtractorClient()`
 * (`src/server/extractor/index.ts`) and the resolver's equivalent
 * (`src/server/resolver/index.ts`) both build their client with no
 * explicit `baseURL`, so both fall back to `process.env.ANTHROPIC_BASE_URL`
 * — the Anthropic SDK's own documented override (confirmed in
 * `node_modules/@anthropic-ai/sdk/client.js`). `playwright.config.ts`
 * points the app's and the worker's `webServer` processes at this server
 * by default. Everything else in the cascade — preprocessing, the
 * deterministic router, the comparators, the warning subsystem,
 * persistence — still runs for real; only the one outbound network call
 * to Anthropic is faked. `E2E_LIVE=1` skips this file entirely and runs
 * the real cascade against the real API instead (see
 * `playwright.config.ts`'s own comment) — the same "cheap by default, an
 * explicit flag pays for the real thing" shape `scripts/eval/check.ts`
 * already established for `--live`.
 *
 * **Two response shapes, chosen without any shared, racy "current
 * scenario" state** (this server is one process shared by every spec file
 * running in parallel, `fullyParallel: true`):
 *
 * - The default: a well-formed extraction (Haiku) or resolution (Sonnet).
 *   The extraction body is `WELL_FORMED_EXTRACTION_BODY`
 *   (`src/server/extractor/test-support.ts`) — the SAME fixture the unit
 *   suite already trusts, itself the real, verified ground truth for
 *   `golden-set/images/case-01-clean-match-spirits.jpg`
 *   (`golden-set/manifest.json`'s own case-01 entry, "the TH-R11 reference
 *   example"). Every spec that needs a working extraction uploads that
 *   real, committed image (TH-R12), so the fake response and the real
 *   photo describe the same label.
 * - A simulated service failure (HTTP 500), for the "API failure/timeout"
 *   designed error state (PRD §5, `docs/error-states.md` state 3/4):
 *   returned only for a Haiku request whose image is smaller than
 *   `FAILURE_TRIGGER_MAX_BYTES`. `scripts/e2e/fixtures.ts`'s
 *   `buildFailureTriggerImage` is a deliberately tiny synthetic image, well
 *   under that threshold; no real golden-set photo resized for Haiku comes
 *   anywhere close (case-01 alone is tens of KB — see that file's test).
 *   This lets ONE spec request a failure by choosing which image it
 *   uploads, with no control endpoint and no interference with any other
 *   spec running at the same time.
 *
 * The router is never faked (TH-R19) — this server only replaces the
 * network call the extractor/resolver make. Every E2E spec that reaches a
 * PASS/FAIL/REVIEW verdict does so through the real, deterministic router
 * and comparators, run against whatever this server said, exactly like
 * production runs them against whatever Haiku/Sonnet said.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { HAIKU_EXTRACTOR_MODEL } from "../../src/server/extractor";
import { WELL_FORMED_EXTRACTION_BODY, makeMockMessage } from "../../src/server/extractor/test-support";
import { SONNET_RESOLVER_MODEL } from "../../src/server/resolver";
import { CANONICAL_WARNING_TEXT } from "../../src/server/warning/canonical";

/**
 * Decoded byte-length threshold that separates "this is the deliberate
 * failure-trigger image" from "this is a normal photo". A real photo
 * resized to fit Haiku's 1568px cap (`HAIKU_MAX_LONG_EDGE_PX`) is tens of
 * kilobytes as JPEG at minimum; `buildFailureTriggerImage` produces an 8x8
 * solid-color JPEG, well under 1 KB. 8 KB leaves a wide, safe margin on
 * both sides — see `fake-anthropic-server.test.ts` and
 * `fixtures.test.ts` for both boundaries exercised directly.
 */
export const FAILURE_TRIGGER_MAX_BYTES = 8000;

/**
 * A well-formed, schema-valid resolver response that RESOLVES every
 * possible flagged field (all six `ResolverField` values, CP-1 §6.4's
 * schema) to a confident match against case-01's own ground truth
 * (`golden-set/manifest.json`). `deriveResolvedFields`
 * (`src/server/resolver/response.ts`) only requires exactly one matching
 * entry per field the router actually flagged — covering every field here
 * means this one canned body answers any real REVIEW reason an E2E spec's
 * chosen application values might trigger, without this server needing to
 * parse which fields were flagged out of the resolver's own free-text
 * prompt.
 */
const RESOLVER_BODY = {
  overall: "RESOLVED",
  fields: [
    {
      field: "brand_name",
      disposition: "RESOLVED_MATCH",
      corrected_value: "Old Tom Distillery",
      evidence: "OLD TOM DISTILLERY",
      reason: "Sonnet confirms the label reads “Old Tom Distillery.”",
      confidence: 0.92,
    },
    {
      field: "class_type",
      disposition: "RESOLVED_MATCH",
      corrected_value: "Straight Bourbon Whiskey",
      evidence: "STRAIGHT BOURBON WHISKEY",
      reason: "Sonnet confirms the class/type reads “Straight Bourbon Whiskey.”",
      confidence: 0.92,
    },
    {
      field: "alcohol_content",
      disposition: "RESOLVED_MATCH",
      corrected_value: "45% Alc./Vol. (90 Proof)",
      evidence: "45% Alc./Vol. (90 Proof)",
      reason: "Sonnet confirms the alcohol content at higher zoom.",
      confidence: 0.92,
    },
    {
      field: "net_contents",
      disposition: "RESOLVED_MATCH",
      corrected_value: "750 mL",
      evidence: "750 mL",
      reason: "Sonnet confirms the net contents at higher zoom.",
      confidence: 0.92,
    },
    {
      field: "government_warning",
      disposition: "RESOLVED_MATCH",
      corrected_value: CANONICAL_WARNING_TEXT,
      evidence: CANONICAL_WARNING_TEXT,
      reason: "Sonnet confirms the warning text matches the statute word for word.",
      confidence: 0.92,
    },
    {
      field: "beverage_type",
      disposition: "RESOLVED_MATCH",
      corrected_value: "spirits",
      evidence: "Straight Bourbon Whiskey",
      reason: "Sonnet confirms this is a spirits label.",
      confidence: 0.92,
    },
  ],
};

/** An Anthropic-shaped error body for the simulated failure. The exact
 * `error.type` does not need to map to a specific SDK error subclass —
 * `src/app/api/verify/route.ts`'s extraction `catch` block treats every
 * non-`HaikuExtractionError` failure the same way (its own file comment),
 * so any non-2xx status already exercises the real SERVICE designed error
 * state end to end. */
const SERVICE_FAILURE_BODY = {
  type: "error",
  error: {
    type: "api_error",
    message: "fake-anthropic-server: simulated service failure (TRO-479 E2E fixture).",
  },
};

export interface FakeMessagesResponse {
  status: number;
  body: unknown;
}

interface ParsedContentBlock {
  type?: unknown;
  source?: { data?: unknown };
}

interface ParsedMessage {
  content?: unknown;
}

interface ParsedRequestBody {
  model?: unknown;
  messages?: unknown;
}

/**
 * Reads the base64 image payload out of a `MessageCreateParamsNonStreaming`-
 * shaped request body (`src/server/extractor/request.ts`,
 * `src/server/resolver/request.ts` both build the same `image` content-
 * block shape). Loose, defensive parsing (standing rule 13) — this reads
 * an untrusted HTTP request body, not a value this codebase already
 * validated.
 */
export function extractFirstImageBase64(parsed: ParsedRequestBody): string | null {
  if (!Array.isArray(parsed.messages)) return null;
  for (const rawMessage of parsed.messages as ParsedMessage[]) {
    const content = rawMessage?.content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content as ParsedContentBlock[]) {
      if (rawBlock?.type === "image" && typeof rawBlock.source?.data === "string") {
        return rawBlock.source.data;
      }
    }
  }
  return null;
}

/** True when `base64Data` decodes to fewer than `FAILURE_TRIGGER_MAX_BYTES`
 * bytes — see this module's own header comment for why byte length, not
 * image content, is the signal. */
export function isFailureTriggerImage(base64Data: string): boolean {
  return Buffer.byteLength(base64Data, "base64") < FAILURE_TRIGGER_MAX_BYTES;
}

/**
 * The one decision this whole fake server makes: given a parsed request
 * body, which canned response to return. Pure and synchronous — no I/O —
 * so it is unit-tested directly, without a real HTTP round trip.
 */
export function selectResponseForRequest(parsed: ParsedRequestBody): FakeMessagesResponse {
  const model = typeof parsed.model === "string" ? parsed.model : "";

  if (model === SONNET_RESOLVER_MODEL) {
    return { status: 200, body: makeMockMessage(JSON.stringify(RESOLVER_BODY), { model }) };
  }

  const imageBase64 = extractFirstImageBase64(parsed);
  if (imageBase64 !== null && isFailureTriggerImage(imageBase64)) {
    return { status: 500, body: SERVICE_FAILURE_BODY };
  }

  return {
    status: 200,
    body: makeMockMessage(JSON.stringify(WELL_FORMED_EXTRACTION_BODY), {
      model: model || HAIKU_EXTRACTOR_MODEL,
    }),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const INVALID_REQUEST_BODY = {
  type: "error",
  error: { type: "invalid_request_error", message: "fake-anthropic-server: could not parse the request body as JSON." },
};

/** Builds the server without starting it — `fake-anthropic-server.test.ts`
 * could use this for a real-socket test; today's tests exercise
 * `selectResponseForRequest` directly, which needs no socket at all. Kept
 * exported because a server no test can construct is a worse design than
 * one that just happens not to be used that way yet. */
export function createFakeAnthropicServer(): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "text/plain" }).end("fake-anthropic-server: ok");
      return;
    }

    readRequestBody(req).then(
      (raw) => {
        let parsed: ParsedRequestBody;
        try {
          parsed = raw ? (JSON.parse(raw) as ParsedRequestBody) : {};
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(INVALID_REQUEST_BODY));
          return;
        }
        const { status, body } = selectResponseForRequest(parsed);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      },
      (error: unknown) => {
        console.error("[fake-anthropic-server] failed to read a request body:", error);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify(SERVICE_FAILURE_BODY));
      },
    );
  });
}

function main(): void {
  const rawPort = process.env.FAKE_MODEL_PORT;
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port <= 0) {
    console.error(`[fake-anthropic-server] FAKE_MODEL_PORT must be a positive integer; got ${JSON.stringify(rawPort)}.`);
    process.exit(1);
  }

  const server = createFakeAnthropicServer();
  server.listen(port, () => {
    // playwright.config.ts's webServer entry for this process waits on the
    // port itself, not this line — but it is also useful, human-readable
    // evidence in the Playwright run's own log output.
    console.log(`[fake-anthropic-server] listening on port ${port}`);
  });
}

// ESM equivalent of Node's classic `require.main === module` — this file
// runs both as a plain module (imports above, from fixtures.ts and the
// test file) and as the process entry point (`pnpm e2e:fake-model`, via
// tsx) — only the latter should call `main()`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
