# Factory Defect-Gates: Detection Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the factory's generic defect-detection engine, prove it end-to-end with one calibrated rule, and wire it into `gate.sh` as G11.

**Architecture:** A generic rule runner in `scripts/factory/defect-gates/` loads rule modules and runs them against the changeset. It fails only on violations the branch introduced. It measures introduction against `BASE_REF` by content identity — the same discipline the quarantine system already uses. Target-specific configuration lives in `factory/rules/`. Engine code never references that configuration directly. A replay harness calibrates each rule against the historical review ledger before the rule is allowed to block.

**Tech Stack:** TypeScript 5.9.3 (compiler API for AST), `tsx` 4.23.12 for execution, vitest for tests, bash for the `gate.sh` integration.

**Spec:** `docs/superpowers/specs/2026-08-12-factory-defect-gates-design.md`

## Scope

This is **plan 1 of 3**.

- **Plan 1 (this one):** engine, identity, base-ref diffing, activation pin, one rule (`vacuous-empty-quantifier`), replay harness, G11 wiring.
- **Plan 2:** the remaining four rules — `weak-numeric-predicate`, `unbounded-resource`, `untrusted-interpolation`, `vacuous-test-assertion` — each following the pattern Task 5 establishes, each with its own replay calibration.
- **Plan 3:** repair orchestration (spec §10). Deferred deliberately: spec §12.3 requires a repair dry-run against replay hits, which cannot run before replay exists.

Plan 1 delivers working software on its own: a blocking G11 with one calibrated rule.

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Layer 1 purity.** No file under `scripts/factory/defect-gates/` may reference a target's domain, directory layout, product semantics, or ticket-ID scheme. The layer test: *could this file move to `ship` unchanged?*
- **Layer 2 location.** Target configuration lives in `factory/rules/*.json`. Engine code reads it by path; it never hard-codes its contents.
- **Directory convention.** This repo puts factory *code* in `scripts/factory/` and factory *data* in `factory/`. The spec's conceptual `factory/defect-gates/` therefore becomes `scripts/factory/defect-gates/` for code, and `factory/rules/` + `factory/replay/` for configuration and evidence.
- **Never fabricate a number.** Latency, accuracy, recall, and count figures come from a real measured run or are written "not measured."
- **Claims carry provenance.** Mark observed vs derived.
- **Never weaken a test, or widen `factory/quarantine.json`, to get a gate green.**
- **NEVER `git stash` in a factory worktree.** `refs/stash` is shared across worktrees.
- **Always `source .factory-env` before running anything.** Never run with `DATABASE_URL` unset.
- **Writing style.** ASD-STE100 discipline plus Zinsser: one word one meaning, active voice, simple tense, one instruction per sentence, ≤20 words for instructions and ≤25 for descriptions.
- **Tests must live where the gate executes them.** `vitest.config.ts` includes `scripts/**/*.test.ts`, so colocated `*.test.ts` files run inside `pnpm test` and therefore inside G4.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/factory/defect-gates/types.ts` | Rule contract, `Finding`, `RuleContext`. No logic. |
| `scripts/factory/defect-gates/identity.ts` | Violation identity hash. Pure. |
| `scripts/factory/defect-gates/baseline.ts` | Materialise `BASE_REF` file content; compute `H \ B`. |
| `scripts/factory/defect-gates/activation.ts` | Activation pin: blocking vs report-only. |
| `scripts/factory/defect-gates/engine.ts` | Load rules, run them, assemble the result document. |
| `scripts/factory/defect-gates/run.ts` | CLI entry point invoked by `gate.sh`. |
| `scripts/factory/defect-gates/ast.ts` | Shared TS-compiler-API helpers: parse, walk, enclosing function. |
| `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.ts` | The first rule. |
| `scripts/factory/defect-gates/replay.ts` | Calibration harness against the review ledger. |
| `factory/rules/` | Layer-2 registries. Empty for this rule; created for later rules. |
| `factory/replay/` | Committed calibration evidence. |

---

### Task 1: Rule contract and engine skeleton

**Files:**
- Create: `scripts/factory/defect-gates/types.ts`
- Create: `scripts/factory/defect-gates/engine.ts`
- Test: `scripts/factory/defect-gates/engine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Rule`, `RuleMeta`, `Finding`, `RuleContext`, `RuleResult` types; `runRules(rules: Rule[], ctx: RuleContext): RuleResult[]`.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runRules } from "./engine";
import type { Finding, Rule, RuleContext } from "./types";

function stubRule(id: string, findings: Finding[]): Rule {
  return {
    meta: {
      id,
      version: 1,
      scope: "changeset",
      severity: "fail",
      repairability: "manual",
      registries: [],
      activatedAt: null,
      pinExpiresAfterMainCommits: 25,
      replayCorpus: [],
    },
    check: () => findings,
  };
}

const ctx: RuleContext = { files: [], repoRoot: "/repo", registries: {} };

describe("runRules", () => {
  it("reports pass for a rule that finds nothing", () => {
    const [result] = runRules([stubRule("quiet", [])], ctx);
    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("reports fail for a rule that finds something", () => {
    const finding: Finding = {
      ruleId: "noisy",
      ruleVersion: 1,
      file: "a.ts",
      line: 1,
      identity: "abc",
      message: "boom",
      repairability: "manual",
      exemptedBy: null,
    };
    const [result] = runRules([stubRule("noisy", [finding])], ctx);
    expect(result.status).toBe("fail");
    expect(result.findings).toHaveLength(1);
  });

  it("reports error, never pass, when a rule throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("rule crashed");
      },
    };
    const [result] = runRules([broken], ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("rule crashed");
  });

  it("runs every rule even when one throws", () => {
    const broken: Rule = {
      ...stubRule("broken", []),
      check: () => {
        throw new Error("nope");
      },
    };
    const results = runRules([broken, stubRule("quiet", [])], ctx);
    expect(results.map((r) => r.status)).toEqual(["error", "pass"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/engine.test.ts
```

Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 3: Write the types**

Create `scripts/factory/defect-gates/types.ts`:

```ts
// Generic rule contract for the factory's defect gate.
// Layer 1: nothing here names a target repository's domain.

export type Repairability = "auto" | "assisted" | "manual";
export type RuleScope = "changeset" | "repo";
export type Severity = "fail" | "advisory";
export type RuleStatus = "pass" | "fail" | "advisory" | "error" | "skipped";

export interface RuleMeta {
  id: string;
  version: number;
  scope: RuleScope;
  severity: Severity;
  repairability: Repairability;
  /** Layer-2 registry file names this rule reads, relative to factory/rules/. */
  registries: string[];
  /** Commit at which the rule became blocking. Null before activation. */
  activatedAt: string | null;
  pinExpiresAfterMainCommits: number;
  /** Ledger row identifiers this rule is calibrated against. */
  replayCorpus: string[];
}

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  file: string;
  line: number;
  identity: string;
  message: string;
  repairability: Repairability;
  exemptedBy: string | null;
}

export interface RuleContext {
  /** Absolute paths the rule must analyse. */
  files: string[];
  repoRoot: string;
  /** Parsed layer-2 registries, keyed by file name. */
  registries: Record<string, unknown>;
}

export interface Rule {
  meta: RuleMeta;
  check(ctx: RuleContext): Finding[];
}

export interface RuleResult {
  id: string;
  version: number;
  status: RuleStatus;
  findings: Finding[];
  error: string | null;
}
```

- [ ] **Step 4: Write the engine**

Create `scripts/factory/defect-gates/engine.ts`:

```ts
import type { Rule, RuleContext, RuleResult } from "./types";

/**
 * Runs every rule and returns one result each.
 *
 * A rule that throws produces status "error", never "pass". A crashed rule
 * that read as clean would repeat the exact defect this subsystem exists to
 * answer: absence must never look like cleanliness.
 */
export function runRules(rules: Rule[], ctx: RuleContext): RuleResult[] {
  return rules.map((rule) => {
    try {
      const findings = rule.check(ctx);
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: findings.length > 0 ? "fail" : "pass",
        findings,
        error: null,
      };
    } catch (cause) {
      return {
        id: rule.meta.id,
        version: rule.meta.version,
        status: "error",
        findings: [],
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/engine.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/factory/defect-gates/types.ts scripts/factory/defect-gates/engine.ts scripts/factory/defect-gates/engine.test.ts
git commit -m "feat(defect-gates): rule contract and engine skeleton

A rule that throws produces status error, never pass. Absence must never
read as cleanliness."
```

---

### Task 2: Violation identity

**Files:**
- Create: `scripts/factory/defect-gates/identity.ts`
- Test: `scripts/factory/defect-gates/identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `violationIdentity(ruleId: string, repoRelativePath: string, enclosingFunctionName: string, nodeText: string): string`.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { violationIdentity } from "./identity";

describe("violationIdentity", () => {
  it("is stable when only whitespace differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every( p )");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(   p )");
    expect(a).toBe(b);
  });

  it("is stable across newlines in the node text", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "fn", "xs.every(\n  p\n)");
    expect(a).toBe(b);
  });

  it("differs when the enclosing function differs", () => {
    const a = violationIdentity("r", "src/a.ts", "one", "xs.every(p)");
    const b = violationIdentity("r", "src/a.ts", "two", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("differs when the file differs", () => {
    const a = violationIdentity("r", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("r", "src/b.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });

  it("keeps token boundaries, so keyword+identifier pairs do not collide", () => {
    // A single space between two word tokens is meaningful. Stripping it makes
    // a constructor call hash the same as a call to a different function.
    for (const [a, b] of [
      ["new Date()", "newDate()"],
      ["typeof x", "typeofx"],
      ["return x", "returnx"],
    ]) {
      expect(violationIdentity("r", "src/a.ts", "fn", a)).not.toBe(
        violationIdentity("r", "src/a.ts", "fn", b),
      );
    }
  });

  it("differs when the rule differs", () => {
    const a = violationIdentity("one", "src/a.ts", "fn", "xs.every(p)");
    const b = violationIdentity("two", "src/a.ts", "fn", "xs.every(p)");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/identity.test.ts
```

Expected: FAIL — cannot resolve `./identity`.

- [ ] **Step 3: Write the implementation**

Create `scripts/factory/defect-gates/identity.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * A stable identifier for one violation.
 *
 * Line numbers shift under unrelated edits, so a position-based identifier
 * would make the H \ B comparison report false failures. This mirrors
 * testdiff.mjs, which compares test failures by identity rather than by
 * position — the property that lets the gate catch a forged break-one
 * fix-one swap.
 */
export function violationIdentity(
  ruleId: string,
  repoRelativePath: string,
  enclosingFunctionName: string,
  nodeText: string,
): string {
  // Collapse runs of whitespace, then drop spaces adjacent to punctuation.
  // The second pass keeps the separator BETWEEN two word tokens, so
  // `new Date()` and `newDate()` stay distinct. A single collapse pass alone
  // fails the newline test; stripping all whitespace collides those two.
  const normalised = nodeText
    .replace(/\s+/g, " ")
    .replace(/\s*([^\w\s])\s*/g, "$1")
    .trim();
  return createHash("sha256")
    .update([ruleId, repoRelativePath, enclosingFunctionName, normalised].join("|"))
    .digest("hex");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/identity.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/factory/defect-gates/identity.ts scripts/factory/defect-gates/identity.test.ts
git commit -m "feat(defect-gates): content-based violation identity

Identity survives line shifts, so H \\ B does not report false failures."
```

---

### Task 3: Base-ref baseline and the H \ B comparison

**Files:**
- Create: `scripts/factory/defect-gates/baseline.ts`
- Test: `scripts/factory/defect-gates/baseline.test.ts`

**Interfaces:**
- Consumes: `Finding` from `./types`.
- Produces:
  - `fileAtRef(repoRoot: string, ref: string, repoRelativePath: string): string | null`
  - `introducedFindings(head: Finding[], base: Finding[]): Finding[]`
  - `preExistingFindings(head: Finding[], base: Finding[]): Finding[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/baseline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileAtRef, introducedFindings, preExistingFindings } from "./baseline";
import type { Finding } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r",
    ruleVersion: 1,
    file: "src/a.ts",
    line: 1,
    identity,
    message: "m",
    repairability: "manual",
    exemptedBy: null,
  };
}

describe("introducedFindings", () => {
  it("returns findings absent from the baseline", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base).map((f) => f.identity)).toEqual(["new"]);
  });

  it("returns nothing when every finding pre-exists", () => {
    const head = [finding("old")];
    const base = [finding("old")];
    expect(introducedFindings(head, base)).toEqual([]);
  });

  it("returns every finding when the baseline is empty", () => {
    const head = [finding("a"), finding("b")];
    expect(introducedFindings(head, []).map((f) => f.identity)).toEqual(["a", "b"]);
  });

  it("ignores a baseline finding that HEAD has fixed", () => {
    const head: Finding[] = [];
    const base = [finding("gone")];
    expect(introducedFindings(head, base)).toEqual([]);
  });
});

describe("preExistingFindings", () => {
  it("returns findings present in both", () => {
    const head = [finding("new"), finding("old")];
    const base = [finding("old")];
    expect(preExistingFindings(head, base).map((f) => f.identity)).toEqual(["old"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/baseline.test.ts
```

Expected: FAIL — cannot resolve `./baseline`.

- [ ] **Step 3: Write the implementation**

Create `scripts/factory/defect-gates/baseline.ts`:

```ts
import { spawnSync } from "node:child_process";
import type { Finding } from "./types";

/**
 * Reads one file's content at a git ref, without touching the working tree.
 *
 * This is the discipline gate.sh already uses for the quarantine baseline:
 * `git show BASE_REF:` and never the branch copy, so an agent cannot
 * whitelist its own breakage. It also avoids `git stash`, which is banned in
 * factory worktrees because refs/stash is shared across them.
 *
 * Returns null when the file does not exist at that ref — a file the branch
 * added. Its baseline contribution is then correctly empty.
 */
export function fileAtRef(
  repoRoot: string,
  ref: string,
  repoRelativePath: string,
): string | null {
  const result = spawnSync("git", ["show", `${ref}:${repoRelativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** H \ B — violations this branch introduced. These fail the gate. */
export function introducedFindings(head: Finding[], base: Finding[]): Finding[] {
  const baseline = new Set(base.map((f) => f.identity));
  return head.filter((f) => !baseline.has(f.identity));
}

/** H ∩ B — violations that already existed. These are reported, never failed. */
export function preExistingFindings(head: Finding[], base: Finding[]): Finding[] {
  const baseline = new Set(base.map((f) => f.identity));
  return head.filter((f) => baseline.has(f.identity));
}
```

> **Historical sample, not current guidance.** The shipped `baseline.ts` no longer matches
> this `Set`-based sketch. A later review round found that a `Set` cannot count multiplicity:
> a function with one existing violation that grows a second, identical one would report zero
> introduced findings. The shipped version compares by per-identity count instead. Read
> `scripts/factory/defect-gates/baseline.ts` for the real implementation.

- [ ] **Step 4: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/baseline.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Add an integration test for `fileAtRef`**

Append to `scripts/factory/defect-gates/baseline.test.ts`:

```ts
import { execSync } from "node:child_process";
import { fileAtRef } from "./baseline";

describe("fileAtRef", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

  it("reads a tracked file at HEAD", () => {
    const content = fileAtRef(repoRoot, "HEAD", "package.json");
    expect(content).toContain('"name"');
  });

  it("returns null for a path that does not exist at the ref", () => {
    expect(fileAtRef(repoRoot, "HEAD", "no/such/file.ts")).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/baseline.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/factory/defect-gates/baseline.ts scripts/factory/defect-gates/baseline.test.ts
git commit -m "feat(defect-gates): base-ref baseline and H-minus-B comparison

Reads the baseline with git show BASE_REF:, never the branch copy, and never
git stash — refs/stash is shared across factory worktrees."
```

---

### Task 4: The activation pin

**Files:**
- Create: `scripts/factory/defect-gates/activation.ts`
- Test: `scripts/factory/defect-gates/activation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PinDecision = { mode: "blocking" | "report-only"; activatedAt: string | null; mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number | null; expiresAfter: number }`
  - `decidePin(input: PinInput): PinDecision` — pure, takes already-resolved git facts.
  - `resolvePinFacts(repoRoot: string, baseRef: string, activatedAt: string): { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number }`

Splitting the pure decision from the git calls is what makes this testable without fixture repositories.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/activation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decidePin } from "./activation";

describe("decidePin", () => {
  it("is blocking when the rule has no activation commit yet", () => {
    // A rule before activation cannot retroactively block anything, so the
    // pin is irrelevant and the caller's own severity governs.
    const d = decidePin({
      activatedAt: null,
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: null,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is blocking when the merge-base already contains the activation commit", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: true,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only when the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 3,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("is blocking once main has advanced past the expiry, even if the branch predates activation", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 26,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("blocking");
  });

  it("is report-only exactly at the expiry boundary", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 25,
      expiresAfter: 25,
    });
    expect(d.mode).toBe("report-only");
  });

  it("carries the diagnostics needed to report the pin", () => {
    const d = decidePin({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
    expect(d).toMatchObject({
      activatedAt: "abc",
      mergeBaseIsAfterActivation: false,
      mainCommitsElapsed: 7,
      expiresAfter: 25,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/activation.test.ts
```

Expected: FAIL — cannot resolve `./activation`.

- [ ] **Step 3: Write the implementation**

Create `scripts/factory/defect-gates/activation.ts`:

```ts
import { spawnSync } from "node:child_process";

export interface PinInput {
  activatedAt: string | null;
  mergeBaseIsAfterActivation: boolean;
  mainCommitsElapsed: number | null;
  expiresAfter: number;
}

export interface PinDecision extends PinInput {
  mode: "blocking" | "report-only";
}

/**
 * Decides whether a newly blocking rule applies to this branch.
 *
 * A branch cut before the rule existed runs report-only, so the rule does not
 * retroactively fail work written before it. The exemption dissolves by
 * itself: merge-base only moves forward, and the factory already requires
 * every branch to merge origin/main before landing. The expiry bounds the
 * case where a branch never syncs.
 */
export function decidePin(input: PinInput): PinDecision {
  const { activatedAt, mergeBaseIsAfterActivation, mainCommitsElapsed, expiresAfter } = input;
  if (activatedAt === null) return { ...input, mode: "blocking" };
  if (mergeBaseIsAfterActivation) return { ...input, mode: "blocking" };
  if (mainCommitsElapsed !== null && mainCommitsElapsed > expiresAfter) {
    return { ...input, mode: "blocking" };
  }
  return { ...input, mode: "report-only" };
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/** Resolves the two git facts decidePin needs. */
export function resolvePinFacts(
  repoRoot: string,
  baseRef: string,
  activatedAt: string,
): { mergeBaseIsAfterActivation: boolean; mainCommitsElapsed: number } {
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", baseRef]).stdout;
  const isAncestor = git(repoRoot, [
    "merge-base",
    "--is-ancestor",
    activatedAt,
    mergeBase,
  ]).status === 0;
  const counted = git(repoRoot, ["rev-list", "--count", `${activatedAt}..${baseRef}`]);
  const elapsed = counted.status === 0 ? Number.parseInt(counted.stdout, 10) : 0;
  return {
    mergeBaseIsAfterActivation: isAncestor,
    mainCommitsElapsed: Number.isFinite(elapsed) ? elapsed : 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/activation.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/factory/defect-gates/activation.ts scripts/factory/defect-gates/activation.test.ts
git commit -m "feat(defect-gates): activation pin

A branch cut before a rule existed runs report-only. The exemption dissolves
when the branch syncs with main, and expires after 25 main commits."
```

---

### Task 5: The first rule — `vacuous-empty-quantifier`

**Files:**
- Create: `scripts/factory/defect-gates/ast.ts`
- Create: `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.ts`
- Test: `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts`

**Interfaces:**
- Consumes: `violationIdentity` from `../identity`; `Finding`, `Rule`, `RuleContext` from `../types`.
- Produces:
  - `ast.ts`: `parse(filePath: string, text: string): ts.SourceFile`, `enclosingFunctionName(node: ts.Node): string`
  - the rule module's default export, satisfying `Rule`.

**Why this rule first.** It needs no layer-2 registry, its historical corpus is small and uniform, and its measured backlog on `main` is 4 sites. It proves the whole vertical slice at the lowest implementation risk.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import rule from "./vacuous-empty-quantifier";
import type { RuleContext } from "../types";

function check(source: string) {
  const ctx: RuleContext = { files: [], repoRoot: "/repo", registries: {} };
  return rule.checkSource("src/sample.ts", source, ctx);
}

describe("vacuous-empty-quantifier", () => {
  it("flags .every reaching a return decision on an unguarded collection", () => {
    const findings = check(`
      function deriveOutcome(fields: F[]) {
        return { outcome: fields.every(isResolved) ? "resolved" : "partial" };
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("every");
  });

  it("flags .every used directly as an if condition", () => {
    const findings = check(`
      function gate(ids: string[]) {
        if (ids.every(valid)) { return "ok"; }
        return "no";
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("does not flag when a length guard precedes the quantifier", () => {
    const findings = check(`
      function deriveOutcome(fields: F[]) {
        if (!fields.length) throw new Error("empty");
        return fields.every(isResolved);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("does not flag a non-empty array literal", () => {
    const findings = check(`
      function gate() {
        return [a, b].every(check);
      }
    `);
    expect(findings).toEqual([]);
  });

  it("does not flag a quantifier used only for display", () => {
    const findings = check(`
      function label(items: I[]) {
        const text = items.every(done) ? "all done" : "in progress";
        return text.length;
      }
    `);
    expect(findings).toEqual([]);
  });

  it("flags a ternary used as a bare statement for its side effects", () => {
    // Same decision as an if/else. The branches are the decision, not the value.
    const findings = check(`
      function act(items: I[]) {
        items.every(p) ? doA() : doB();
      }
    `);
    expect(findings).toHaveLength(1);
  });

  it("reports the enclosing function in the identity, so two call sites differ", () => {
    const findings = check(`
      function one(xs: X[]) { return xs.every(p); }
      function two(xs: X[]) { return xs.every(p); }
    `);
    expect(findings).toHaveLength(2);
    expect(findings[0].identity).not.toBe(findings[1].identity);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts
```

Expected: FAIL — cannot resolve `./vacuous-empty-quantifier`.

- [ ] **Step 3: Write the AST helpers**

Create `scripts/factory/defect-gates/ast.ts`:

```ts
import ts from "typescript";

/** Parses one source file with parent pointers, which the walkers need. */
export function parse(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
}

/** Visits every node depth-first. */
export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Names the function a node sits inside.
 *
 * Used by the identity hash, so two identical call sites in different
 * functions get different identities.
 */
export function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return "<module>";
}

/** The 1-based line of a node. */
export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
```

- [ ] **Step 4: Write the rule**

Create `scripts/factory/defect-gates/rules/vacuous-empty-quantifier.ts`:

```ts
import { readFileSync } from "node:fs";
import ts from "typescript";
import { enclosingFunctionName, lineOf, parse, walk } from "../ast";
import { violationIdentity } from "../identity";
import type { Finding, RuleContext, RuleMeta } from "../types";

const QUANTIFIERS = new Set(["every", "some", "reduce"]);

const meta: RuleMeta = {
  id: "vacuous-empty-quantifier",
  version: 1,
  scope: "changeset",
  severity: "fail",
  repairability: "assisted",
  registries: [],
  activatedAt: null,
  pinExpiresAfterMainCommits: 25,
  replayCorpus: [],
};

/** True when the receiver cannot be empty. */
function isProvablyNonEmpty(receiver: ts.Expression, sourceFile: ts.SourceFile): boolean {
  // A literal array with at least one element.
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length > 0) return true;

  // A preceding length guard that leaves the function on empty.
  const receiverText = receiver.getText(sourceFile);
  let fn: ts.Node | undefined = receiver.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn || !("body" in fn) || !fn.body) return false;

  let guarded = false;
  walk(fn.body as ts.Node, (n) => {
    if (!ts.isIfStatement(n)) return;
    const test = n.expression.getText(sourceFile);
    const mentionsLength =
      test.includes(`${receiverText}.length`) || test.includes(`${receiverText}?.length`);
    if (!mentionsLength) return;
    const exits =
      ts.isReturnStatement(n.thenStatement) ||
      ts.isThrowStatement(n.thenStatement) ||
      (ts.isBlock(n.thenStatement) &&
        n.thenStatement.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s)));
    if (exits) guarded = true;
  });
  return guarded;
}

/** True when the call's result drives a program decision. */
function reachesDecisionSink(call: ts.CallExpression): boolean {
  let current: ts.Node | undefined = call;
  let child: ts.Node = call;
  while (current?.parent) {
    child = current;
    current = current.parent;
    if (ts.isReturnStatement(current)) return true;
    if (ts.isIfStatement(current) && current.expression === child) return true;
    if (ts.isConditionalExpression(current) && current.condition === child) {
      // A ternary used as a bare statement decides by side effect, not by value.
      // Its branches are the decision, so it is a sink.
      if (current.parent && ts.isExpressionStatement(current.parent)) return true;
      // Otherwise the ternary only passes a value along. Keep climbing.
      continue;
    }
    if (ts.isPropertyAssignment(current)) return true;
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function checkSource(filePath: string, text: string, _ctx: RuleContext): Finding[] {
  const sourceFile = parse(filePath, text);
  const findings: Finding[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    if (!QUANTIFIERS.has(name)) return;

    const receiver = node.expression.expression;
    if (isProvablyNonEmpty(receiver, sourceFile)) return;
    if (!reachesDecisionSink(node)) return;

    const fnName = enclosingFunctionName(node);
    findings.push({
      ruleId: meta.id,
      ruleVersion: meta.version,
      file: filePath,
      line: lineOf(sourceFile, node),
      identity: violationIdentity(meta.id, filePath, fnName, node.getText(sourceFile)),
      message:
        `.${name}() decides a program outcome over a collection that may be empty. ` +
        `An empty collection makes .${name}() vacuously true. Guard the empty case, ` +
        `or state explicitly what empty means.`,
      repairability: meta.repairability,
      exemptedBy: null,
    });
  });

  return findings;
}

export default {
  meta,
  checkSource,
  check(ctx: RuleContext): Finding[] {
    return ctx.files.flatMap((absolute) => {
      const relative = absolute.startsWith(ctx.repoRoot)
        ? absolute.slice(ctx.repoRoot.length + 1)
        : absolute;
      return checkSource(relative, readFileSync(absolute, "utf8"), ctx);
    });
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/rules/vacuous-empty-quantifier.test.ts
```

Expected: PASS, 6 tests. If `reduce` over-fires on the display case, narrow `reachesDecisionSink` before changing any test.

- [ ] **Step 6: Measure the rule against the current tree**

```bash
source .factory-env && pnpm exec tsx -e '
import rule from "./scripts/factory/defect-gates/rules/vacuous-empty-quantifier";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const files = execSync(`git ls-files "src/**/*.ts" "scripts/**/*.ts"`, {encoding:"utf8"})
  .trim().split("\n").filter((f) => !f.endsWith(".test.ts"));
let n = 0;
for (const f of files) {
  const found = rule.checkSource(f, readFileSync(f, "utf8"), {files:[],repoRoot:".",registries:{}});
  for (const x of found) { n++; console.log(`${x.file}:${x.line}  ${x.message.slice(0,60)}`); }
}
console.log(`TOTAL: ${n}`);
'
```

Record the count in `CHANGES.md`. The spec predicts ~4 sites. **If the real number differs, write the real number** — it is a measurement, not a target.

- [ ] **Step 7: Commit**

```bash
git add scripts/factory/defect-gates/ast.ts scripts/factory/defect-gates/rules/ CHANGES.md
git commit -m "feat(defect-gates): vacuous-empty-quantifier rule

Flags a quantifier that decides an outcome over a possibly-empty collection.
Requires both an unguarded receiver and a decision sink, so display-only
uses do not fire."
```

---

### Task 6: Replay harness

**Files:**
- Create: `scripts/factory/defect-gates/replay.ts`
- Test: `scripts/factory/defect-gates/replay.test.ts`
- Create: `factory/replay/.gitkeep`

**Interfaces:**
- Consumes: `Rule` from `./types`; `fileAtRef` from `./baseline`.
- Produces:
  - `type LedgerRow = { ticket: string; pr?: string; file: string; disposition: string; category: string; summary: string }`
  - `resolveFixCommit(repoRoot: string, row: LedgerRow): string | null`
  - `replayRule(repoRoot: string, rule: Rule, rows: LedgerRow[]): ReplayReport`

**Measured constraint.** The ledger carries `ticket`, `pr`, and `file`, but no commit SHA. Only 163 of 406 retained rows carry a `pr`. `resolveFixCommit` therefore tries the PR first and falls back to `git log --grep <ticket>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/replay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { resolveFixCommit, summariseReplay } from "./replay";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

describe("resolveFixCommit", () => {
  it("finds a commit by ticket id when no pr is recorded", () => {
    const sha = resolveFixCommit(repoRoot, {
      ticket: "TRO-511",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("returns null for a ticket that appears in no commit", () => {
    const sha = resolveFixCommit(repoRoot, {
      ticket: "TRO-000000",
      file: "src/x.ts",
      disposition: "fixed",
      category: "c",
      summary: "s",
    });
    expect(sha).toBeNull();
  });
});

describe("summariseReplay", () => {
  it("computes recall over resolvable rows only", () => {
    const report = summariseReplay([
      { ticket: "A", resolved: true, hit: true },
      { ticket: "B", resolved: true, hit: false },
      { ticket: "C", resolved: false, hit: false },
    ]);
    expect(report.resolvable).toBe(2);
    expect(report.hits).toBe(1);
    expect(report.recall).toBeCloseTo(0.5);
    expect(report.unresolvable).toBe(1);
  });

  it("reports zero recall rather than dividing by zero", () => {
    const report = summariseReplay([{ ticket: "A", resolved: false, hit: false }]);
    expect(report.recall).toBe(0);
    expect(report.resolvable).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/replay.test.ts
```

Expected: FAIL — cannot resolve `./replay`.

- [ ] **Step 3: Write the implementation**

Create `scripts/factory/defect-gates/replay.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileAtRef } from "./baseline";
import type { Rule } from "./types";

export interface LedgerRow {
  ticket: string;
  pr?: string;
  file: string;
  disposition: string;
  category: string;
  summary: string;
}

export interface ReplayOutcome {
  ticket: string;
  resolved: boolean;
  hit: boolean;
}

export interface ReplayReport {
  total: number;
  resolvable: number;
  unresolvable: number;
  hits: number;
  recall: number;
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

/**
 * Finds the commit that fixed a ledger row.
 *
 * The ledger records ticket, pr, and file, but no commit SHA. Measured
 * 2026-08-12: only 163 of 406 retained rows carry a pr. The ticket-id grep is
 * therefore the fallback, not the exception.
 */
export function resolveFixCommit(repoRoot: string, row: LedgerRow): string | null {
  if (row.pr) {
    const merge = git(repoRoot, [
      "log",
      "--format=%H",
      "-n",
      "1",
      "--grep",
      `Merge pull request #${row.pr}`,
    ]);
    if (merge.status === 0 && merge.stdout) return merge.stdout;
  }
  const byTicket = git(repoRoot, ["log", "--format=%H", "-n", "1", "--grep", row.ticket]);
  if (byTicket.status === 0 && byTicket.stdout) return byTicket.stdout;
  return null;
}

export function summariseReplay(outcomes: ReplayOutcome[]): ReplayReport {
  const resolvable = outcomes.filter((o) => o.resolved).length;
  const hits = outcomes.filter((o) => o.resolved && o.hit).length;
  return {
    total: outcomes.length,
    resolvable,
    unresolvable: outcomes.length - resolvable,
    hits,
    recall: resolvable === 0 ? 0 : hits / resolvable,
  };
}

/**
 * Runs a rule against the tree as it stood BEFORE each fix, and records
 * whether the rule would have caught it.
 */
export function replayRule(repoRoot: string, rule: Rule, rows: LedgerRow[]): {
  outcomes: ReplayOutcome[];
  report: ReplayReport;
} {
  const outcomes: ReplayOutcome[] = rows.map((row) => {
    const fix = resolveFixCommit(repoRoot, row);
    if (!fix) return { ticket: row.ticket, resolved: false, hit: false };
    const before = `${fix}^1`;
    const text = fileAtRef(repoRoot, before, row.file);
    if (text === null) return { ticket: row.ticket, resolved: false, hit: false };
    const withSource = rule as unknown as {
      checkSource?: (f: string, t: string, c: unknown) => unknown[];
    };
    const found = withSource.checkSource
      ? withSource.checkSource(row.file, text, { files: [], repoRoot, registries: {} })
      : [];
    return { ticket: row.ticket, resolved: true, hit: found.length > 0 };
  });
  return { outcomes, report: summariseReplay(outcomes) };
}

export function loadLedger(path: string): LedgerRow[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerRow);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/replay.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Run the real replay and record the evidence**

```bash
source .factory-env && mkdir -p factory/replay && pnpm exec tsx -e '
import rule from "./scripts/factory/defect-gates/rules/vacuous-empty-quantifier";
import { loadLedger, replayRule } from "./scripts/factory/defect-gates/replay";
import { writeFileSync } from "node:fs";
const rows = loadLedger("factory/review-findings.jsonl")
  .filter((r) => ["fixed","new-ticket"].includes(r.disposition))
  .filter((r) => /vacuous|\.every|empty/i.test(r.summary));
const { outcomes, report } = replayRule(process.cwd(), rule as never, rows);
console.log(JSON.stringify(report, null, 2));
writeFileSync("factory/replay/vacuous-empty-quantifier.v1.json",
  JSON.stringify({ rule: "vacuous-empty-quantifier", version: 1, report, outcomes }, null, 2) + "\n");
'
cat factory/replay/vacuous-empty-quantifier.v1.json
```

**Ship criterion:** recall ≥ 0.60 over resolvable rows. **If recall falls short, fix the rule and re-run — never lower the criterion, and never edit the corpus filter to exclude a miss.** Record the real number either way.

- [ ] **Step 6: Commit**

```bash
git add scripts/factory/defect-gates/replay.ts scripts/factory/defect-gates/replay.test.ts factory/replay/
git commit -m "feat(defect-gates): replay harness and vacuous-empty-quantifier calibration

Resolves a fixing commit by PR, falling back to a ticket-id grep — measured,
only 163 of 406 retained ledger rows carry a PR number."
```

---

### Task 7: G11 wiring, output document, and scorecard

**Files:**
- Create: `scripts/factory/defect-gates/run.ts`
- Modify: `scripts/factory/gate.sh` — insert G11 between G9 (line ~305) and G10 (line ~307)
- Test: `scripts/factory/defect-gates/run.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `.factory/defect-gate.json`, and exit code 0 or 1.

- [ ] **Step 1: Write the failing test**

Create `scripts/factory/defect-gates/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDocument } from "./run";
import type { Finding, RuleResult } from "./types";

function finding(identity: string): Finding {
  return {
    ruleId: "r", ruleVersion: 1, file: "src/a.ts", line: 1, identity,
    message: "m", repairability: "assisted", exemptedBy: null,
  };
}

const pin = {
  activatedAt: null, mergeBaseIsAfterActivation: true,
  mainCommitsElapsed: null, expiresAfter: 25, mode: "blocking" as const,
};

describe("buildDocument", () => {
  it("marks a rule failed when the branch introduced a finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("fail");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(1);
  });

  it("does not fail on a pre-existing finding", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("old")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [finding("old")] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("pass");
    expect(doc.rules[0].preExisting).toBe(1);
    expect(doc.exitCode).toBe(0);
  });

  it("does not fail a report-only rule, and records why", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "fail", findings: [finding("new")], error: null },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] },
      pins: { r: { ...pin, mode: "report-only", activatedAt: "abc", mergeBaseIsAfterActivation: false } },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].mode).toBe("report-only");
    expect(doc.rules[0].introduced).toHaveLength(1);
    expect(doc.exitCode).toBe(0);
  });

  it("fails the gate when a rule errored", () => {
    const results: RuleResult[] = [
      { id: "r", version: 1, status: "error", findings: [], error: "boom" },
    ];
    const doc = buildDocument({
      results, baselines: { r: [] }, pins: { r: pin },
      baseRef: "main", baseSha: "s", mergeBase: "m",
    });
    expect(doc.rules[0].status).toBe("error");
    expect(doc.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/run.test.ts
```

Expected: FAIL — cannot resolve `./run`.

- [ ] **Step 3: Write the document builder and CLI**

Create `scripts/factory/defect-gates/run.ts`:

```ts
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function main(): void {
  const repoRoot = sh("git rev-parse --show-toplevel", process.cwd());
  const baseRef = process.env.FACTORY_BASE_REF ?? "main";
  const outDir = join(repoRoot, ".factory");
  mkdirSync(outDir, { recursive: true });

  const changed = sh(`git diff ${baseRef}...HEAD --name-only`, repoRoot)
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));

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
    const facts = rule.meta.activatedAt
      ? resolvePinFacts(repoRoot, baseRef, rule.meta.activatedAt)
      : { mergeBaseIsAfterActivation: true, mainCommitsElapsed: null as number | null };
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
source .factory-env && pnpm test -- scripts/factory/defect-gates/run.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire G11 into gate.sh**

In `scripts/factory/gate.sh`, insert this block immediately **after** the G9 scope block and **before** the `# --- G10: review capture` comment:

```bash
# --- G11: defect gate (BLOCKING) --------------------------------------------
# Runs BEFORE G10 so a defect this factory can catch never consumes external
# review budget. Fails only on violations this branch introduced, measured
# against BASE_REF by content identity — the same discipline the quarantine
# baseline uses.
if [ "$FAST" = 1 ]; then
  record defect-gate skip "skipped in --fast"
elif [ ! -d scripts/factory/defect-gates ]; then
  record defect-gate skip "not installed"
else
  DG_LOG="$OUT_DIR/defect-gate.log"
  if FACTORY_BASE_REF="${BASE_REF}" pnpm exec tsx scripts/factory/defect-gates/run.ts > "$DG_LOG" 2>&1; then
    DG_N="$(grep -c '  FAIL  ' "$DG_LOG" || true)"; DG_N="${DG_N:-0}"
    record defect-gate pass "no introduced violations"
  else
    DG_N="$(grep -c '  FAIL  ' "$DG_LOG" || true)"; DG_N="${DG_N:-0}"
    record defect-gate fail "${DG_N} introduced violation(s) — see .factory/defect-gate.json"
  fi
fi
```

- [ ] **Step 6: Negative-test the gate**

The factory never trusts a gate it has not seen fail. Prove G11 catches a real violation:

```bash
source .factory-env
cat > src/lib/__dg-probe.ts <<'PROBE'
export function deriveOutcome(fields: { ok: boolean }[]) {
  return { outcome: fields.every((f) => f.ok) ? "resolved" : "partial" };
}
PROBE
git add src/lib/__dg-probe.ts && git commit -m "test: temporary defect-gate probe"
scripts/factory/gate.sh; echo "gate exit: $?"
```

Expected: `[FAIL] defect-gate  1 introduced violation(s)`, and the gate exits non-zero.

Then remove the probe and confirm the gate returns to green:

```bash
git rm -f src/lib/__dg-probe.ts && git commit -m "test: remove defect-gate probe"
scripts/factory/gate.sh; echo "gate exit: $?"
```

Expected: `[ok ] defect-gate  no introduced violations`.

**Record both results in `CHANGES.md` as observed evidence.** A gate that has only been seen to pass is unverified.

- [ ] **Step 7: Commit**

```bash
git add scripts/factory/defect-gates/run.ts scripts/factory/defect-gates/run.test.ts scripts/factory/gate.sh CHANGES.md
git commit -m "feat(gate): wire defect-gate in as G11, before review capture

Negative-tested: a probe violation fails the gate, and its removal returns it
to green. Both results recorded in CHANGES.md."
```

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| §2 three layers | Global Constraints, File Structure |
| §5 Rule Contract | Task 1 (`types.ts`) |
| §6 R5 `vacuous-empty-quantifier` | Task 5 |
| §8 G11 placement before G10 | Task 7 Step 5 |
| §9.2 base-ref scope discipline | Task 3 |
| §9.3 violation identity | Task 2 |
| §9.4 activation pin | Task 4 |
| §9.5 output document, `error` never reads clean | Tasks 1 and 7 |
| §12.1 replay | Task 6 |
| §12.3 ship criteria | Task 6 Step 5 |

**Deliberately not in this plan**, and named in Scope: spec §6 rules R1–R4 (plan 2); §10 repair orchestration, §11.1 `dgState` scorecard fields, §13 metrics (plan 3). §11's advisory plumbing is not needed here because no rule in plan 1 ships advisory.

**Type consistency.** `Finding`, `RuleContext`, `RuleMeta`, `RuleResult` are defined once in Task 1 and used unchanged in Tasks 3, 5, 6, 7. `checkSource(filePath, text, ctx)` has one signature, introduced in Task 5 and consumed in Tasks 6 and 7. `decidePin`/`resolvePinFacts` are introduced in Task 4 and consumed in Task 7.

**Known rough edge.** `run.ts` calls `checkSource` through a cast, because `checkSource` is a rule-module convenience rather than part of the `Rule` interface. Task 5's module exports both. If plan 2 finds every rule needs it, promote `checkSource` into the `Rule` interface and delete the casts — that is a `version` bump for no rule, since matching behaviour does not change.
