/**
 * Shared write-path guard for one-off, ticket-owned evidence snapshots under
 * `scripts/eval/` (TRO-559).
 *
 * WHAT THIS IS FOR. A script whose committed output is ONE ticket's frozen
 * measurement — `scripts/eval/ocr-floor-sweep.ts` (TRO-535 / LH-030b) and
 * `scripts/eval/tro-546-case22-ocr-region-check.ts` (TRO-546) today. Running
 * either script again, with no flags, used to silently overwrite that
 * committed evidence with numbers from a different code or image state.
 * This happened in production on 2026-08-13: a TRO-546 diagnostic agent
 * re-ran the OCR sweep and replaced TRO-535's committed artifact in place.
 * Nothing in the tree explained the gap. This module closes that gap:
 * refuse to overwrite an existing artifact unless the caller says so
 * explicitly.
 *
 * WHAT THIS IS DELIBERATELY NOT FOR. `check.ts`/`benchmark.ts`/`variance.ts`
 * (`--live` mode) write a ROLLING "last real run" report by design, not one
 * ticket's frozen snapshot. Each already self-describes its own
 * `measuredAt`/`manifestContentHash`/`caseIds`. Each is gated behind a
 * real, paid API call. Each already has an established, working refresh
 * history. `variance.ts` additionally already has its own bespoke
 * narrower-report warning (`warnIfNarrowingCommittedReport`) that this
 * module does not replace. `scripts/eval/baseline.json` is TRO-561's
 * explicit-flag, archive-then-replace re-baseline protocol
 * (`archiveExistingBaseline`), a different and already-safe mechanism. See
 * the CHANGES.md TRO-558/TRO-559 entry for the full per-writer accounting.
 * Every `scripts/eval/` writer is either converted to this module or
 * listed there with a reason it is safe as-is.
 *
 * SHAPE CHOSEN: refuse-by-default at the writer's existing conventional
 * path, not a dated/SHA-stamped filename. Every existing reference to e.g.
 * `scripts/eval/results/ocr-floor-sweep.json` (CP-2, CHANGES.md,
 * `reconcile.ts`, `tro-546-case22-ocr-region-check.ts`'s own module
 * comment) stays correct with no new "latest" pointer convention invented.
 * A bare `pnpm eval:ocr-floor-sweep` still works unchanged on a clean
 * checkout. It only refuses once a file already exists at that path. That
 * is the exact failure mode this ticket exists to close.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ArtifactGuardArgs {
  readonly out: string | null;
  readonly force: boolean;
}

const OUT_FLAG = /^--out=(.*)$/;
const FORCE_FLAG = "--force";

/**
 * Pulls `--out=<path>` and `--force` out of `argv`. Uses the same "pull my
 * own flags out, leave the rest for the next parser" convention
 * `parseVarianceArgs` (`args.ts`) already uses for `--repeats=<k>` and
 * `--establish-baseline`. Does not itself skip the `--` token pnpm
 * forwards. Callers that hand `rest` to `parseEvalArgs` get that handled
 * there — the same layering `parseVarianceArgs` already relies on. A
 * caller with no further parser (both current callers) must check `rest`
 * itself and reject anything left over. Otherwise an unrecognized or
 * misspelled flag is silently ignored.
 */
export function parseArtifactGuardArgs(argv: readonly string[]): { guard: ArtifactGuardArgs; rest: string[] } {
  const outMatches = argv.filter((a) => OUT_FLAG.test(a));
  if (outMatches.length > 1) {
    throw new Error(`artifact-guard: --out may be passed at most once, got ${outMatches.length}.`);
  }
  const force = argv.includes(FORCE_FLAG);
  const rest = argv.filter((a) => a !== FORCE_FLAG && !OUT_FLAG.test(a));
  const out = outMatches.length === 1 ? OUT_FLAG.exec(outMatches[0])![1] : null;
  if (out === "") {
    throw new Error("artifact-guard: --out requires a non-empty path, e.g. --out=scratch/compare.json.");
  }
  return { guard: { out, force }, rest };
}

function refusalError(target: string): Error {
  return new Error(
    `artifact-guard: refusing to overwrite existing file at "${target}". Pass --force to overwrite it ` +
      `deliberately, or --out=<path> to write a separate copy without touching the committed one.`,
  );
}

/**
 * Resolves the path a guarded write will actually target: `guard.out`
 * (resolved against `repoRoot` when relative) if the caller passed
 * `--out=<path>`, otherwise `defaultPath`. Throws when a file already
 * exists at that resolved path and `guard.force` is not set — a fast,
 * friendly pre-check. The actual guarantee against clobbering is enforced
 * atomically in `writeGuardedJsonArtifact` below, which closes the race
 * window between this check and the real write.
 *
 * The error message always names both escape hatches — never a silent
 * failure.
 */
export function resolveGuardedOutputPath(params: { repoRoot: string; defaultPath: string; guard: ArtifactGuardArgs }): string {
  const target = params.guard.out !== null ? path.resolve(params.repoRoot, params.guard.out) : params.defaultPath;
  if (existsSync(target) && !params.guard.force) {
    throw refusalError(target);
  }
  return target;
}

/**
 * Writes `content` as pretty-printed, newline-terminated JSON to the path
 * `resolveGuardedOutputPath` resolves. Creates the parent directory if
 * needed, matching every converted writer's existing `mkdirSync(...,
 * {recursive: true})` behavior. Returns the path actually written, so a
 * caller's own log line can name it.
 */
export function writeGuardedJsonArtifact(params: {
  repoRoot: string;
  defaultPath: string;
  guard: ArtifactGuardArgs;
  content: unknown;
}): string {
  if (params.content === undefined) {
    // JSON.stringify(undefined) returns the JS value undefined, not a
    // string. String-concatenating it below would write the literal text
    // "undefined" instead of JSON. Fail loudly instead of writing that.
    throw new Error("artifact-guard: content must not be undefined — refusing to write invalid JSON.");
  }
  const target = resolveGuardedOutputPath({ repoRoot: params.repoRoot, defaultPath: params.defaultPath, guard: params.guard });
  mkdirSync(path.dirname(target), { recursive: true });
  const payload = JSON.stringify(params.content, null, 2) + "\n";
  if (params.guard.force) {
    writeFileSync(target, payload);
    return target;
  }
  // "wx" creates the file exclusively and fails on EEXIST. So a file
  // created between the existsSync check above and this write still
  // cannot be clobbered. The actual guarantee lives here, not in the
  // check above.
  try {
    writeFileSync(target, payload, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw refusalError(target);
    }
    throw err;
  }
  return target;
}
