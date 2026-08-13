/**
 * `Server-Timing` header encode/decode for `POST /api/verify` (TRO-539,
 * PRD §3.8, TH-R2).
 *
 * PRD §3.8's stage table budgets five stages for the single-label fast
 * path: preprocess, OCR (the warning crop, concurrent with Haiku), Haiku
 * extraction, the Validation Router, and the database writes. Before this
 * ticket, no measurement of a real request could see them separately — the
 * latency harness (`scripts/latency/measure.ts`) only ever reported one
 * wall-clock total. `route.ts` now times each stage and writes the result
 * onto every 200 response as a standard `Server-Timing` header (one entry
 * per stage, `name;dur=<milliseconds>`) — the same header format a
 * browser's own DevTools Network panel already understands natively, so a
 * human can read this off a real request with no extra tooling.
 *
 * `buildServerTimingHeader` (`route.ts`, the producer) and
 * `parseServerTimingHeader` (`scripts/latency/measure.ts`'s `--url` mode,
 * the consumer) share this one file so the two ends cannot silently drift
 * on stage names or the header's exact syntax.
 */

/** PRD §3.8's five budgeted stages, in the table's own order. The single
 * source of truth for the stage name set — `buildServerTimingHeader`
 * iterates it to decide what to write, `parseServerTimingHeader` uses it
 * to decide what to accept back. */
export const SERVER_TIMING_STAGES = ["preprocess", "ocr", "haiku", "router", "db"] as const;

export type ServerTimingStage = (typeof SERVER_TIMING_STAGES)[number];

/** One measured duration, in milliseconds, per `SERVER_TIMING_STAGES`
 * entry. Every field required — a caller with an incomplete set (a stage
 * never reached, e.g. an early error response) should not call
 * `buildServerTimingHeader` at all rather than pass a fabricated 0. */
export type StageTimingsMs = Record<ServerTimingStage, number>;

/**
 * Formats `stages` as a `Server-Timing` header value:
 * `preprocess;dur=12.3, ocr;dur=45.6, haiku;dur=2500.1, router;dur=0.4, db;dur=15.2`.
 * Durations are rounded to one decimal place — sub-0.1ms precision is noise
 * at this harness's multi-second, network-bound scale (the same reasoning
 * `measure.ts`'s own module comment gives for rounding its total to the
 * nearest millisecond).
 */
export function buildServerTimingHeader(stages: StageTimingsMs): string {
  return SERVER_TIMING_STAGES.map((stage) => `${stage};dur=${stages[stage].toFixed(1)}`).join(", ");
}

/**
 * Splits `input` on single-character `delimiter`, except where `delimiter`
 * appears inside a `"`-quoted span — the Server-Timing grammar allows a
 * quoted `desc` parameter (e.g. `haiku;desc="crop, v2";dur=2500.0`), and a
 * naive `String.prototype.split` would cut that description's own comma
 * as if it were a new entry (CodeRabbit local review round 1, major —
 * confirmed against a real header shaped exactly like that example). Also
 * honors a backslash-escaped quote inside a quoted span (RFC 7230
 * `quoted-string`'s own `quoted-pair`, e.g. `desc="a \" b, c"`) — a
 * `\"` neither ends the quoted span nor gets treated as a delimiter
 * boundary marker itself (CodeRabbit local review round 3, minor).
 */
function splitOutsideQuotes(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes && ch === "\\" && i + 1 < input.length) {
      current += ch + input[i + 1];
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const STAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const NUMBER_PATTERN = "[0-9]+(?:\\.[0-9]+)?";
// Two exclusive branches — unquoted OR quoted-with-a-MATCHING-close-quote —
// not two independently optional `"?` markers. The earlier version
// (`^dur\s*=\s*"?(...)"?$`) let each `"?` match independently, so
// `dur="123.4` (an opening quote with no closing one) still matched —
// CodeRabbit local review round 2, minor, confirmed against that exact
// input before this fix. Group 1 is the unquoted value; group 2 is the
// quoted one — the caller checks whichever is defined.
const DUR_PARAM_PATTERN = new RegExp(`^dur\\s*=\\s*(?:(${NUMBER_PATTERN})|"(${NUMBER_PATTERN})")$`);

/**
 * Parses a `Server-Timing` header value back into per-stage milliseconds.
 * Defensive (standing rule 13: validate at a boundary a value's shape is
 * only assumed, not guaranteed) — `headerValue` crossed a real HTTP
 * response. `scripts/latency/measure.ts`'s `--url` mode may read this off
 * a differently-versioned deployment, a proxy that rewrote headers, or (if
 * pointed at the wrong URL) an unrelated server entirely. An entry this
 * function does not recognize as one of `SERVER_TIMING_STAGES`, or cannot
 * parse as a finite non-negative number, is dropped rather than trusted —
 * this function never throws on malformed input, and a caller with an
 * empty result should treat that as "no breakdown available", not crash.
 *
 * Each entry is `name` optionally followed by `;param=value` pairs — this
 * function only looks for `dur` and ignores every other param (`desc`,
 * anything else), taking the FIRST `dur` if more than one is present. A
 * `dur` value may be a bare number or a quoted one (`dur="2500.0"`); both
 * are accepted.
 */
export function parseServerTimingHeader(headerValue: string): Partial<StageTimingsMs> {
  const result: Partial<StageTimingsMs> = {};
  const knownStages: readonly string[] = SERVER_TIMING_STAGES;
  for (const rawEntry of splitOutsideQuotes(headerValue, ",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const params = splitOutsideQuotes(entry, ";").map((p) => p.trim());
    const name = params[0];
    if (!name || !STAGE_NAME_PATTERN.test(name) || !knownStages.includes(name)) continue;

    let dur: number | undefined;
    for (const param of params.slice(1)) {
      const match = DUR_PARAM_PATTERN.exec(param);
      if (match) {
        // Exactly one of the two groups is defined — DUR_PARAM_PATTERN's
        // two branches are mutually exclusive (see its own comment).
        dur = Number(match[1] ?? match[2]);
        break;
      }
    }
    if (dur === undefined || !Number.isFinite(dur) || dur < 0) continue;
    result[name as ServerTimingStage] = dur;
  }
  return result;
}
