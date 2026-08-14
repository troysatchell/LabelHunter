import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PinDecision } from "./activation";
import { decidePin, resolvePinFacts } from "./activation";
import { fileAtRef, introducedFindings, preExistingFindings } from "./baseline";
import { runRules } from "./engine";
import quantifierRule from "./rules/vacuous-empty-quantifier";
import type { Finding, Rule, RuleResult } from "./types";

const RULES: Rule[] = [quantifierRule];

export interface BuildInput {
  results: RuleResult[];
  baselines: Record<string, Finding[]>;
  pins: Record<string, PinDecision>;
  baseRef: string;
  baseSha: string;
  mergeBase: string;
}

export function buildDocument(input: BuildInput) {
  const rules = input.results.map((result) => {
    const baseline = input.baselines[result.id] ?? [];
    const pin = input.pins[result.id];
    if (!pin) {
      throw new Error(
        `buildDocument: no pin decision for rule '${result.id}' — every RuleResult needs a matching pins entry.`,
      );
    }
    const introduced = introducedFindings(result.findings, baseline);
    const preExisting = preExistingFindings(result.findings, baseline).length;
    let status = result.status;
    if (result.status !== "error") {
      status = introduced.length > 0 ? "fail" : "pass";
    }
    return {
      id: result.id,
      version: result.version,
      status,
      mode: pin.mode,
      pin,
      introduced,
      preExisting,
      advisory: 0,
      exempted: 0,
      error: result.error,
    };
  });

  const failing = rules.filter(
    (r) => r.status === "error" || (r.status === "fail" && r.mode === "blocking"),
  );

  return {
    version: 1,
    ranAt: new Date().toISOString(),
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    mergeBase: input.mergeBase,
    rules,
    notRun: [] as string[],
    exitCode: failing.length > 0 ? 1 : 0,
  };
}

/**
 * Formats the console lines for one report: every introduced finding, plus
 * one line naming the failure detail for any rule with status "error".
 *
 * A rule can error with zero introduced findings — a pin-resolution
 * failure (see `main`) never touches `findings` at all. Printing only per-
 * finding lines then produced a blank report next to an exit code 1, with
 * no clue why the gate failed. The error line is printed even when the
 * same rule also has introduced findings, so neither detail hides the
 * other.
 */
export function formatReportLines(doc: ReturnType<typeof buildDocument>): string[] {
  const lines: string[] = [];
  for (const rule of doc.rules) {
    if (rule.status === "error") {
      lines.push(`  ERROR   ${rule.id}  ${rule.error ?? "unknown error"}`);
    }
    for (const f of rule.introduced) {
      lines.push(`  ${rule.mode === "blocking" ? "FAIL" : "report"}  ${f.file}:${f.line}  ${f.message}`);
    }
  }
  return lines;
}

/**
 * Runs `git` with an argument array, never a shell string.
 *
 * `execSync` hands its whole command string to `/bin/sh -c`, so a `baseRef`
 * value (from `FACTORY_BASE_REF`, or any future caller) interpolated into
 * that string is parsed by the shell — metacharacters in it change what
 * actually runs. `spawnSync` with an argument array passes each value to
 * `git` literally; no shell ever sees it.
 */
function sh(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Lists this branch's changed `.ts`/`.tsx` files, excluding `.d.ts`.
 *
 * `--diff-filter=ACMR` keeps only Added, Copied, Modified, and Renamed
 * paths. Without it, a deleted or renamed-away path reaches `readFileSync`
 * downstream and throws `ENOENT` — `engine.ts` then reports `status:
 * "error"`, which fails the gate on a branch that only deleted a file. A
 * renamed path still analyses correctly: its new name is Added or
 * Renamed, so it stays in the list under its current content.
 */
export function changedTsFiles(repoRoot: string, baseRef: string): string[] {
  return sh(["diff", "--diff-filter=ACMR", `${baseRef}...HEAD`, "--name-only"], repoRoot)
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
}

function main(): void {
  const repoRoot = sh(["rev-parse", "--show-toplevel"], process.cwd());
  const baseRef = process.env.FACTORY_BASE_REF ?? "main";
  const outDir = join(repoRoot, ".factory");
  mkdirSync(outDir, { recursive: true });

  const changed = changedTsFiles(repoRoot, baseRef);

  const ctx = {
    files: changed.map((f) => join(repoRoot, f)),
    repoRoot,
    registries: {},
  };

  const results = runRules(RULES, ctx);

  const baselines: Record<string, Finding[]> = {};
  const pins: Record<string, PinDecision> = {};
  for (const rule of RULES) {
    // Use fileAtRef, never a raw `git show`. A file this branch ADDED does not
    // exist at BASE_REF, and that is the common case, not the edge case.
    // fileAtRef returns null there; a raw git show would throw and take the
    // whole gate down.
    baselines[rule.meta.id] = changed.flatMap((f) => {
      const before = fileAtRef(repoRoot, baseRef, f);
      if (before === null) return [];
      return rule.checkSource(f, before, ctx);
    });
    let facts: { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number | null } = {
      mergeBaseIsAfterActivation: true,
      mainCommitsElapsed: null,
    };
    if (rule.meta.activatedAt) {
      const resolved = resolvePinFacts(repoRoot, baseRef, rule.meta.activatedAt);
      if (resolved.ok) {
        facts = resolved.facts;
      } else {
        // An unresolved pin must never default to a silently non-blocking
        // rule (Important 6). Treat it the same as a crashed check: force
        // status "error", so the gate fails loudly with the real reason,
        // never a quiet, permanent report-only mode.
        const idx = results.findIndex((r) => r.id === rule.meta.id);
        if (idx !== -1) {
          results[idx] = { ...results[idx], status: "error", error: resolved.error };
        }
      }
    }
    pins[rule.meta.id] = decidePin({
      activatedAt: rule.meta.activatedAt,
      mergeBaseIsAfterActivation: facts.mergeBaseIsAfterActivation,
      mainCommitsElapsed: facts.mainCommitsElapsed,
      expiresAfter: rule.meta.pinExpiresAfterMainCommits,
    });
  }

  const doc = buildDocument({
    results,
    baselines,
    pins,
    baseRef,
    baseSha: sh(["rev-parse", baseRef], repoRoot),
    mergeBase: sh(["merge-base", "HEAD", baseRef], repoRoot),
  });

  writeFileSync(join(outDir, "defect-gate.json"), JSON.stringify(doc, null, 2) + "\n");
  for (const line of formatReportLines(doc)) console.log(line);
  process.exit(doc.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("run.ts")) main();
