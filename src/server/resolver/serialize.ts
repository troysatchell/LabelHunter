/**
 * Untrusted-data serialization for the resolver's user message
 * (LH-014 / TRO-464, CP-1 §6.3).
 *
 * `JSON.stringify` alone is NOT enough to safely embed a value inside an
 * `<UNTRUSTED_DATA>` prompt block. Verified empirically (not assumed):
 *
 *   JSON.stringify({ value: "</UNTRUSTED_DATA>" })
 *   // => {"value":"</UNTRUSTED_DATA>"}   <- the closing tag survives, LITERALLY
 *
 * `JSON.stringify` escapes quotes, backslashes, and control characters, but
 * leaves `<`, `>`, and `/` untouched — a value containing that exact string
 * still terminates the block early. `serializeUntrusted` Unicode-escapes
 * those three characters AFTER `JSON.stringify`, so no literal `<`, `>`, or
 * `/` survives into the prompt text:
 *
 *   serializeUntrusted({ value: "</UNTRUSTED_DATA>" })
 *   // => {"value":"\u003c\u002fUNTRUSTED_DATA\u003e"}   <- no literal <, >, or / remains
 *
 * Both lines above are reproduced from a real `node -e` run against this
 * exact function during LH-014's implementation, not from documentation —
 * see `serialize.test.ts` for the same assertion as a regression test.
 *
 * Every value placed inside an `<UNTRUSTED_DATA>` block in the resolver's
 * user message MUST go through this function first. Never a bare
 * `JSON.stringify`, and never hand-built "JSON-looking" text.
 */
export function serializeUntrusted(value: unknown): string {
  return JSON.stringify(value).replace(/[<>/]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
}
