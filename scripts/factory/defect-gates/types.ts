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
