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
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Hashes already-read manifest text. Pure — no filesystem access — so a
 * test can hash a fixture string (or a mutated copy of the real manifest)
 * with no disk I/O at all.
 */
export function hashManifestContent(rawJsonText: string): string {
  return createHash("sha256").update(rawJsonText, "utf8").digest("hex");
}

/** Reads `manifestPath` and hashes its raw content — the entry point
 * production callers (`check.ts`, `benchmark.ts`) use. Pass
 * `DEFAULT_MANIFEST_PATH` (`../../src/lib/golden-set/loader.ts`) so the
 * hashed file is always the exact file `loadGoldenSetManifest()` parsed. */
export function hashManifestFile(manifestPath: string): string {
  return hashManifestContent(readFileSync(manifestPath, "utf8"));
}
