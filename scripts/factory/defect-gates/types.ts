// Generic rule contract for the factory's defect gate.
// Layer 1: nothing here names a target repository's domain.

export type Repairability = "auto" | "assisted" | "manual";
export type RuleScope = "changeset" | "repo";
export type Severity = "fail" | "advisory";
export type RuleStatus = "pass" | "fail" | "advisory" | "error" | "skipped";

/**
 * One historical ledger row a rule declares itself calibrated against.
 *
 * The review ledger has no stable row id. A corpus entry names a row by
 * ticket, file, and a distinctive substring of its summary instead.
 */
export interface ReplayCorpusEntry {
  ticket: string;
  file: string;
  summaryIncludes: string;
}

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
  /** Ledger rows this rule is calibrated against. Select by row, not category. */
  replayCorpus: ReplayCorpusEntry[];
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
  /**
   * Checks one file's source text directly, without reading the working
   * tree. The baseline pass and the replay harness both call this against
   * historical text read from a git ref — `check` alone cannot serve
   * either, since it reads files from disk by path. Required, not
   * optional: an optional method here previously let a rule silently
   * contribute an empty baseline and an empty replay result instead of a
   * visible error.
   */
  checkSource(filePath: string, text: string, ctx: RuleContext): Finding[];
}

export interface RuleResult {
  id: string;
  version: number;
  status: RuleStatus;
  findings: Finding[];
  error: string | null;
}
