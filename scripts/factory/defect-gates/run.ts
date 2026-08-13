import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PinDecision } from "./activation";
import { decidePin, resolvePinFacts } from "./activation";
import { fileAtRef, introducedFindings, preExistingFindings } from "./baseline";
import { runRules } from "./engine";
import quantifierRule from "./rules/vacuous-empty-quantifier";
import type { Finding, Rule, RuleResult } from "./types";

const RULES: Rule[] = [quantifierRule as unknown as Rule];

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

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
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
  return sh(`git diff --diff-filter=ACMR ${baseRef}...HEAD --name-only`, repoRoot)
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
}

function main(): void {
  const repoRoot = sh("git rev-parse --show-toplevel", process.cwd());
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
    const withSource = rule as unknown as {
      checkSource: (f: string, t: string, c: unknown) => Finding[];
    };
    // Use fileAtRef, never a raw `git show`. A file this branch ADDED does not
    // exist at BASE_REF, and that is the common case, not the edge case.
    // fileAtRef returns null there; a raw git show would throw and take the
    // whole gate down.
    baselines[rule.meta.id] = changed.flatMap((f) => {
      const before = fileAtRef(repoRoot, baseRef, f);
      if (before === null) return [];
      return withSource.checkSource(f, before, ctx);
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
    baseSha: sh(`git rev-parse ${baseRef}`, repoRoot),
    mergeBase: sh(`git merge-base HEAD ${baseRef}`, repoRoot),
  });

  writeFileSync(join(outDir, "defect-gate.json"), JSON.stringify(doc, null, 2) + "\n");
  for (const rule of doc.rules) {
    for (const f of rule.introduced) {
      console.log(`  ${rule.mode === "blocking" ? "FAIL" : "report"}  ${f.file}:${f.line}  ${f.message}`);
    }
  }
  process.exit(doc.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("run.ts")) main();
