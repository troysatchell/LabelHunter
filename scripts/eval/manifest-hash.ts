/**
 * Content hash of `golden-set/manifest.json` (TRO-538 / LH-033).
 *
 * `EvalReport`, `EvalBaseline`, and the benchmark report each already stamp
 * a `manifestVersion` string, but that string does not move with the file's
 * real content: seven straight commits that edited `golden-set/manifest.json`
 * all left `version` at `"1.0.0"`, including the commit that changed
 * case-23/case-24's own expected `reviewReason`
 * (`docs/diagnostics/2026-08-12-verdict-miss-triage.md` §5 S5). A comparison
 * gated on that string alone (`baseline-compare.ts`'s own manifest-version
 * check) cannot catch a stale baseline when the manifest changed under it.
 *
 * A hash over the raw file bytes needs no canonicalization rule (key order,
 * whitespace) the way a hash over a re-serialized, parsed object would — the
 * file on disk already is one canonical byte sequence, so this file never
 * parses the manifest at all.
 *
 * `hashManifestFile` hashes the file's raw `Buffer`, not a decoded string
 * (CodeRabbit finding, TRO-538 triage). Reading with a `"utf8"` encoding
 * first would decode to a JS string and re-encode it before hashing — for
 * a clean, valid-UTF-8 file those bytes round-trip identically (checked:
 * Node's `Buffer.toString("utf8")` does NOT strip a leading BOM, so that
 * specific case round-trips fine too). The real gap: Node's UTF-8 decoder
 * replaces any INVALID byte sequence with the U+FFFD replacement
 * character on decode, so a file with even one malformed byte would
 * silently hash something different from what is actually on disk — and
 * the whole point of this function is to catch every byte-level change
 * with no exceptions. Hash the bytes the file actually contains.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Hashes already-read manifest content. Pure — no filesystem access — so a
 * test can hash fixture bytes (or a mutated copy of the real manifest)
 * with no disk I/O at all. Accepts a `Buffer` or a `string`, string only
 * for tests that build fixture content as text — `hashManifestFile` below
 * is production's only real caller, and it always passes a `Buffer`.
 */
export function hashManifestContent(rawContent: Buffer | string): string {
  return createHash("sha256").update(rawContent).digest("hex");
}

/** Reads `manifestPath` and hashes its raw bytes — the entry point
 * production callers (`check.ts`, `benchmark.ts`) use. Pass
 * `DEFAULT_MANIFEST_PATH` (`../../src/lib/golden-set/loader.ts`) so the
 * hashed file is always the exact file `loadGoldenSetManifest()` parsed. */
export function hashManifestFile(manifestPath: string): string {
  return hashManifestContent(readFileSync(manifestPath));
}
