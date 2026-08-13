import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function argAfter(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
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

  const repoRoot = sh("git rev-parse --show-toplevel", process.cwd());
  const rule = (await load()).default as unknown as Rule;

  const ledgerPath = argAfter("--ledger") ?? join(repoRoot, "factory/review-findings.jsonl");
  const rows = loadLedger(ledgerPath);
  const corpusRows = selectCorpusRows(rows, rule.meta.replayCorpus);
  const { outcomes, report } = replayRule(repoRoot, rule, corpusRows);

  const doc = {
    rule: rule.meta.id,
    version: rule.meta.version,
    report,
    outcomes: outcomes.map((o) => ({ ticket: o.ticket, resolved: o.resolved, hit: o.hit })),
  };

  const outPath =
    argAfter("--out") ?? join(repoRoot, "factory/replay", `${rule.meta.id}.v${rule.meta.version}.json`);
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("replay-cli.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
