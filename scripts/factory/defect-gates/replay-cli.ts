import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadLedger, replayRule, selectCorpusRows } from "./replay";
import type { Rule } from "./types";

/**
 * CLI entrypoint for the replay harness.
 *
 * Before this file, nothing outside `replay.test.ts` called `replayRule` or
 * `loadLedger`. `factory/replay/vacuous-empty-quantifier.v1.json` was
 * committed as evidence, but no command could regenerate it — the spec's
 * re-measure workflow (§12.1) had no entrypoint. This is that entrypoint.
 *
 * Usage:
 *   pnpm exec tsx scripts/factory/defect-gates/replay-cli.ts <rule-id>
 *   pnpm exec tsx scripts/factory/defect-gates/replay-cli.ts <rule-id> \
 *     --ledger path/to/ledger.jsonl --out path/to/out.json
 */

// Loaders for each rule this CLI knows how to replay. Add an entry here
// when a rule ships a `replayCorpus`. A dynamic import keeps a rule module
// with a broken import from crashing every other rule's replay.
const RULE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  "vacuous-empty-quantifier": () => import("./rules/vacuous-empty-quantifier"),
};

/**
 * Runs `git` with an argument array, never a shell string — matches
 * `run.ts`'s own `sh`. `execSync` hands its whole command string to
 * `/bin/sh -c`; `spawnSync` with an argument array passes each value to
 * `git` literally, so no shell ever parses it.
 */
export function sh(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message || `exit code ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

function argAfter(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * Confirms a dynamically-loaded rule module actually has the shape `Rule`
 * promises before anything reads `.meta` off it.
 *
 * `main` loads a rule through a dynamic import and casts the result — the
 * type system cannot verify that cast at runtime. A malformed module
 * (wrong export name, a rule mid-refactor) previously reached `rule.meta`
 * and threw a bare "Cannot read properties of undefined", with no rule id
 * attached. This names the rule id and the exact missing piece.
 */
export function validateRuleModule(mod: unknown, ruleId: string): Rule {
  if (!mod || typeof mod !== "object") {
    throw new Error(`replay-cli: rule module '${ruleId}' has no default export`);
  }
  const candidate = mod as { meta?: unknown; checkSource?: unknown };
  if (!candidate.meta || typeof candidate.meta !== "object") {
    throw new Error(`replay-cli: rule module '${ruleId}' has no 'meta' object`);
  }
  const meta = candidate.meta as { id?: unknown; replayCorpus?: unknown };
  if (typeof meta.id !== "string") {
    throw new Error(`replay-cli: rule module '${ruleId}' meta.id is not a string`);
  }
  if (!Array.isArray(meta.replayCorpus)) {
    throw new Error(`replay-cli: rule module '${ruleId}' meta.replayCorpus is not an array`);
  }
  if (typeof candidate.checkSource !== "function") {
    throw new Error(`replay-cli: rule module '${ruleId}' has no checkSource function`);
  }
  return mod as Rule;
}

/**
 * True when this file is running as the actual process entrypoint, not
 * merely imported by a test or another module.
 *
 * Checks both `.ts` (the normal `tsx`/`ts-node` dev path) and `.js` (a
 * compiled or bundled build). A `.ts`-only check left a built CLI silently
 * doing nothing at all — no error, no output, a clean exit 0 — because
 * `process.argv[1]` there ends in `.js`.
 *
 * Compares the exact basename, not a suffix. `.endsWith("replay-cli.ts")`
 * also matches "notreplay-cli.ts" — any file whose name happens to end
 * with the same letters, not only this one.
 */
export function isDirectEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  const name = basename(argv1);
  return name === "replay-cli.ts" || name === "replay-cli.js";
}

async function main(): Promise<void> {
  const ruleId = process.argv[2];
  if (!ruleId || ruleId.startsWith("--")) {
    console.error("usage: replay-cli.ts <rule-id> [--ledger path] [--out path]");
    console.error(`known rule ids: ${Object.keys(RULE_LOADERS).join(", ")}`);
    process.exit(2);
  }
  const load = RULE_LOADERS[ruleId];
  if (!load) {
    console.error(`unknown rule id: ${ruleId}`);
    console.error(`known rule ids: ${Object.keys(RULE_LOADERS).join(", ")}`);
    process.exit(2);
  }

  const repoRoot = sh(["rev-parse", "--show-toplevel"], process.cwd());
  const rule = validateRuleModule((await load()).default, ruleId);

  const ledgerPath = argAfter("--ledger") ?? join(repoRoot, "factory/review-findings.jsonl");
  const rows = loadLedger(ledgerPath);
  const corpusRows = selectCorpusRows(rows, rule.meta.replayCorpus);
  const { outcomes, report } = replayRule(repoRoot, rule, corpusRows);

  const doc = {
    rule: rule.meta.id,
    version: rule.meta.version,
    report,
    outcomes: outcomes.map((o) => ({ ticket: o.ticket, file: o.file, resolved: o.resolved, hit: o.hit })),
  };

  const outPath =
    argAfter("--out") ?? join(repoRoot, "factory/replay", `${rule.meta.id}.v${rule.meta.version}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectEntrypoint(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
