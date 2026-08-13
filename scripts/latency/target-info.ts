/**
 * What a `scripts/latency/measure.ts` run actually measured, and against
 * what (TRO-539, PRD §3.8, TH-R2).
 *
 * **The provenance trap this file closes.** The harness's `pipelineScope`
 * field used to be a string literal hard-coded into `measure.ts`'s report
 * builder. Commit `c5e49f8` wired the warning comparator into the live
 * route but never touched that literal, so the next run would have written
 * accurate NEW timings under a STALE description of what it measured —
 * "No OCR/warning-subsystem comparator" would have stayed in the artifact
 * forever, regardless of what the route actually did by then. `buildPipelineScope`
 * below takes the run's own measurement boundary as an argument and is
 * called fresh every run, so the description can never again silently
 * outlive the code it describes. The same discipline applies to
 * `buildTargetInfo`: the Render plan it reports comes from reading
 * `render.yaml` and comparing hostnames at measurement time, never from a
 * constant.
 */
import { deriveRenderPlanForHost } from "./render-target";

/** "in-process": this run called `handleVerifyRequest` directly (the
 * default, no `--url`) — no real HTTP round-trip. "http": this run sent a
 * real multipart POST over the network to a `--url` target. Always
 * derived from which code path a given run actually took, never a
 * default a caller could forget to set. */
export type MeasurementBoundary = "in-process" | "http";

const SHARED_PIPELINE_DESCRIPTION =
  "Preprocess (sharp) -> Haiku extraction (claude-haiku-4-5, real API call) concurrently with " +
  "the government-warning comparator (region detection + tesseract.js OCR on the warning crop, " +
  "bounded by a 2000ms OCR deadline, TRO-519) -> deterministic Validation Router -> DB writes " +
  "(TRO-518: label image bytes land in Postgres, not disk). LH-014's Sonnet resolver has merged " +
  "to main, but route.ts never calls it inline -- every run is the fast path only; Sonnet " +
  "resolution, when it happens, runs asynchronously off the review queue, never inside this " +
  "request (TH-R19).";

/**
 * Describes the pipeline this run measured, including which boundary it
 * measured it at. Called once per run with that run's OWN `boundary` —
 * never a fixed string — so a `--url` run against a deployed instance can
 * never be captioned "in-process", and vice versa (TRO-539's own
 * acceptance bar).
 */
export function buildPipelineScope(boundary: MeasurementBoundary): string {
  if (boundary === "in-process") {
    return (
      SHARED_PIPELINE_DESCRIPTION +
      " Boundary: in-process -- this run called handleVerifyRequest directly, the same function " +
      "route.ts's POST calls, NOT a real HTTP round-trip. Excludes a real browser's upload time " +
      "and the Next.js HTTP framing layer."
    );
  }
  return (
    SHARED_PIPELINE_DESCRIPTION +
    " Boundary: http -- this run sent a real multipart POST over the network to the target URL " +
    "recorded in this artifact's own target field, and measured wall-clock from just before that " +
    "request to the full response body received, including the Next.js HTTP framing layer and " +
    "the real network path -- but still excludes a real browser's own upload/render time. " +
    "CAVEAT: the pipeline description above is this repo's OWN claim about what code the target " +
    "runs -- an http --url target can in principle be any server. This script never independently " +
    "confirms the target is running this exact commit (same caveat as this artifact's own model " +
    "field); it is accurate when --url points at a real deployment of this repo, which is this " +
    "harness's only intended use."
  );
}

/** `true` for a hostname that only ever resolves back to THIS machine —
 * `localhost`, `127.0.0.1`, or the IPv6 loopback in either its bare or
 * bracketed form. Case-insensitive (RFC 4343). Used by `measure.ts` to
 * decide whether a `--url` run's `DATABASE_URL` can be trusted as the
 * SAME database the target itself uses (CodeRabbit local review round 1,
 * major): a real deployed target's own database is never reachable by
 * guessing at a hostname, so only a loopback target is treated as
 * "probably the same database" — see `measure.ts`'s own cleanup-gating
 * comment for the cross-database delete risk this specifically guards
 * against. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export interface TargetInfo {
  boundary: MeasurementBoundary;
  /** The target's host, e.g. `"localhost:3874"` or
   * `"labelhunter-web.onrender.com"`. `null` in in-process mode -- there
   * is no network host, only a direct function call. */
  host: string | null;
  /** The full `--url` value this run was invoked with, unmodified. `null`
   * in in-process mode. */
  url: string | null;
  /** `render.yaml`'s own `plan` value for its `web` service, when `host`
   * matches the hostname Render's naming convention would assign that
   * service -- see this file's header comment and `render-target.ts`.
   * `null` for every in-process run, and for any `--url` run whose host
   * does not match (localhost, a different deployment, a typo). Read
   * from `render.yaml`, never queried live from Render -- no Render API
   * credentials are available to this script. */
  renderPlan: string | null;
}

/**
 * Builds this run's `TargetInfo` from its own inputs: the `--url` value
 * (or `null` for the default in-process mode) and `render.yaml`'s raw
 * text (or `null` if it could not be read). Pure — the caller does the
 * one filesystem read (`readFileSync("render.yaml")`) and passes the
 * text in, so this function stays testable with no I/O of its own.
 */
export function buildTargetInfo(url: string | null, renderYamlText: string | null): TargetInfo {
  if (url === null) {
    return { boundary: "in-process", host: null, url: null, renderPlan: null };
  }
  const parsedUrl = new URL(url);
  const renderPlan = renderYamlText !== null ? deriveRenderPlanForHost(parsedUrl.hostname, renderYamlText) : null;
  return { boundary: "http", host: parsedUrl.host, url, renderPlan };
}
