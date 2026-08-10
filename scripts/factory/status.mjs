#!/usr/bin/env node
// status.mjs — one-screen factory state, DERIVED from sources that are already
// true: worktrees, .factory-env, gate results, the scorecard, `gh pr list`.
// There is deliberately no status file to update — a status file that drifts
// reads as authoritative while being wrong. Linear stays authoritative for
// ticket STATUS; this shows execution state. When they disagree, Linear wins
// and something is wrong — say so, don't reconcile silently.
//
// Usage: node scripts/factory/status.mjs [--json]

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

const repoRoot = sh('git rev-parse --show-toplevel');
if (!repoRoot) { console.error('not a git repository'); process.exit(2); }

// --- worktrees ---------------------------------------------------------------
const worktrees = [];
const wtBlocks = sh('git worktree list --porcelain').split('\n\n').filter(Boolean);
for (const block of wtBlocks) {
  const path = (block.match(/^worktree (.+)$/m) || [])[1];
  if (!path || path === repoRoot) continue;
  const env = {};
  const envPath = join(path, '.factory-env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^export ([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  let gate = null;
  const gatePath = join(path, '.factory', 'gate-result.json');
  if (existsSync(gatePath)) {
    try {
      const g = JSON.parse(readFileSync(gatePath, 'utf8'));
      gate = {
        verdict: g.verdict,
        failed: (g.gates || []).filter((x) => x.status === 'fail').map((x) => x.id),
        ranAt: g.ranAt,
      };
    } catch { gate = { verdict: 'unreadable' }; }
  }
  const branch = (block.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || '(detached)';
  const ahead = Number(sh(`git rev-list --count main..${branch}`) || 0);
  const dirty = sh(`git -C ${JSON.stringify(path)} status --porcelain`) !== '';
  worktrees.push({ path, branch, ticket: env.FACTORY_TICKET || null, ahead, dirty, gate });
}

// --- PRs ---------------------------------------------------------------------
let prs = [];
const prJson = sh('gh pr list --json number,title,headRefName,statusCheckRollup,url 2>/dev/null');
if (prJson) {
  try {
    prs = JSON.parse(prJson).map((p) => {
      const checks = p.statusCheckRollup || [];
      const state = checks.length === 0 ? 'none'
        : checks.some((c) => c.conclusion === 'FAILURE') ? 'failing'
        : checks.every((c) => c.conclusion === 'SUCCESS') ? 'green' : 'pending';
      return { number: p.number, title: p.title, branch: p.headRefName, ci: state, url: p.url };
    });
  } catch { /* gh not authenticated or no remote — fine, derived means optional */ }
}

// --- scorecard ---------------------------------------------------------------
const scorecard = { attempts: 0, tickets: new Set(), firstAttemptPass: 0, firstAttempts: 0, gateFailures: {} };
const scPath = join(repoRoot, 'factory', 'scorecard.jsonl');
if (existsSync(scPath)) {
  for (const line of readFileSync(scPath, 'utf8').split('\n').filter((l) => l.trim())) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    scorecard.attempts++;
    scorecard.tickets.add(row.ticket);
    if (row.attempt === 1) {
      scorecard.firstAttempts++;
      if (row.verdict === 'pass') scorecard.firstAttemptPass++;
    }
    for (const g of row.failedGates || []) scorecard.gateFailures[g] = (scorecard.gateFailures[g] || 0) + 1;
  }
}

const out = {
  worktrees,
  prs,
  scorecard: {
    attempts: scorecard.attempts,
    tickets: scorecard.tickets.size,
    firstAttemptPass: `${scorecard.firstAttemptPass}/${scorecard.firstAttempts}`,
    gateFailures: scorecard.gateFailures,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log('=== labelhunter factory ===\n');
if (!worktrees.length) console.log('worktrees: none');
for (const w of worktrees) {
  const g = w.gate ? `${w.gate.verdict}${w.gate.failed?.length ? ` (${w.gate.failed.join(',')})` : ''}` : 'no gate run';
  console.log(`  ${w.ticket ?? '?'}  ${w.branch}  +${w.ahead} commit(s)${w.dirty ? ' *dirty*' : ''}  gate: ${g}`);
}
console.log('');
if (prs.length) {
  for (const p of prs) console.log(`  PR #${p.number} [${p.ci}] ${p.title}`);
  console.log('');
}
console.log(`scorecard: ${scorecard.attempts} attempt(s) across ${scorecard.tickets.size} ticket(s); first-attempt pass ${out.scorecard.firstAttemptPass}`);
const gf = Object.entries(scorecard.gateFailures).sort((a, b) => b[1] - a[1]);
if (gf.length) {
  console.log(`most-failed gates: ${gf.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  console.log('(the same gate failing repeatedly is a prompt defect, not careless agents)');
}
