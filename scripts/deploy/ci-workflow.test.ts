/**
 * Regression test for `.github/workflows/ci.yml` (TRO-522).
 *
 * `pnpm test:e2e` (the Playwright suite, TRO-479) never ran in CI before
 * this ticket — not even the pre-existing `e2e/health.spec.ts`. TRO-479's
 * own agent and CodeRabbit both named the gap independently. This test
 * checks the workflow file itself, the same way `render-yaml.test.ts`
 * checks `render.yaml`: parse the real YAML CI actually reads, not a
 * hand-rolled text scan, so a later edit that silently drops or breaks
 * the job fails here first.
 *
 * Three invariants TRO-522's brief states as hard requirements:
 * 1. `pnpm test:e2e` runs as its own job — not folded into the existing
 *    unit-test job (`verify`'s "Unit tests (JSON report)" step, G4).
 * 2. That job must never spend real API money: no step or job sets
 *    `E2E_LIVE` at all, since `playwright.config.ts` treats it unset as
 *    "use the fake Anthropic server" and any non-empty value as the
 *    real, paid opt-in.
 * 3. The job reproduces the same Postgres + migration lifecycle the
 *    suite needs locally (`e2e/helpers.ts`, `playwright.config.ts`) —
 *    a `postgres` service, a `DATABASE_URL` pointed at it, and a
 *    migration step before the suite runs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CI_YAML_PATH = `${REPO_ROOT}.github/workflows/ci.yml`;

const ciYamlText = readFileSync(CI_YAML_PATH, "utf8");

// --- Minimal shape for what this test reads. GitHub Actions' real schema
// is much larger; narrowing explicitly here (standing rule 13) turns a
// malformed workflow into a readable test failure instead of a raw
// "Cannot read properties of undefined" deep inside an assertion.
interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  services?: Record<string, { image?: string; env?: Record<string, string>; ports?: string[] }>;
  steps?: WorkflowStep[];
}

interface Workflow {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
}

function isWorkflow(value: unknown): value is Workflow {
  return typeof value === "object" && value !== null;
}

const parsed: unknown = loadYaml(ciYamlText);
if (!isWorkflow(parsed)) {
  throw new Error("ci.yml did not parse to an object — see js-yaml's own error above, if any.");
}
const workflow = parsed;

/** The job (by id) containing a step whose `run` invokes `pnpm test:e2e`
 * directly — not merely a job that happens to depend on one, and not a
 * substring match against an unrelated command like `pnpm test`. */
function findJobRunningE2e(): { jobId: string; job: WorkflowJob; step: WorkflowStep } | undefined {
  const jobs = workflow.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (step.run && /(^|\s|&&|\|)pnpm test:e2e(\s|$)/.test(step.run)) {
        return { jobId, job, step };
      }
    }
  }
  return undefined;
}

describe("ci.yml — pnpm test:e2e runs as its own explicit CI check (TRO-522)", () => {
  it("parses as valid YAML with at least one job", () => {
    expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(0);
  });

  it("runs pnpm test:e2e somewhere in the workflow", () => {
    const found = findJobRunningE2e();
    expect(found, "no step anywhere in ci.yml runs `pnpm test:e2e`").toBeDefined();
  });

  it("runs it in a job separate from the existing unit-test job, not folded into G4", () => {
    const found = findJobRunningE2e();
    expect(found).toBeDefined();
    // "verify" is the job that already runs `pnpm test -- --reporter=json`
    // (G4). Folding the E2E command into that same job's steps would still
    // pass a naive "does ci.yml mention pnpm test:e2e" check while missing
    // the brief's explicit "own explicit check" requirement.
    expect(found?.jobId).not.toBe("verify");
  });

  it("never sets E2E_LIVE — a default CI run must never spend real API money", () => {
    const jobs = workflow.jobs ?? {};
    const offendingLocations: string[] = [];

    // Workflow-level `env` applies to every job, so it is the widest place
    // a paid run could be switched on — and the first this test missed.
    if (workflow.env && "E2E_LIVE" in workflow.env) offendingLocations.push("workflow-level env");

    for (const [jobId, job] of Object.entries(jobs)) {
      if (job.env && "E2E_LIVE" in job.env) offendingLocations.push(`job "${jobId}"`);
      for (const step of job.steps ?? []) {
        const where = `job "${jobId}", step "${step.name ?? step.run}"`;
        if (step.env && "E2E_LIVE" in step.env) offendingLocations.push(where);
        // A YAML `env:` key is not the only way to set a variable. A shell
        // line can do it too — `export E2E_LIVE=1`, a bare `E2E_LIVE=1`
        // assignment, a `E2E_LIVE=1 pnpm test:e2e` prefix, or an append to
        // $GITHUB_ENV, which sets it for every LATER step in the job. None
        // of those appear in any parsed `env` map (CodeRabbit finding,
        // TRO-522 review round 1).
        if (step.run && /(^|[\s;&|(])(export\s+)?E2E_LIVE\s*=/.test(step.run)) {
          offendingLocations.push(`${where} — shell assignment in \`run\``);
        }
        if (step.run && /E2E_LIVE[^\n]*>>\s*"?\$GITHUB_ENV/.test(step.run)) {
          offendingLocations.push(`${where} — written to $GITHUB_ENV`);
        }
      }
    }
    expect(offendingLocations, `E2E_LIVE set at: ${offendingLocations.join("; ")}`).toHaveLength(0);
  });

  it("gives the E2E job its own Postgres service and a matching DATABASE_URL", () => {
    const found = findJobRunningE2e();
    expect(found).toBeDefined();
    const { job, step: e2eStep } = found!;
    const service = job.services?.postgres;
    expect(service?.image, "the E2E job needs its own postgres service").toBeTruthy();

    // The value the E2E step actually runs under: a step-level `env` wins
    // over the job's. Asserting only that the JOB's URL contains
    // "postgresql://" would pass while the step ran against something else
    // entirely — or against a developer's own database (CodeRabbit finding,
    // TRO-522 review round 1; CLAUDE.md's DATABASE_URL non-negotiable).
    const effectiveUrl = e2eStep.env?.DATABASE_URL ?? job.env?.DATABASE_URL;
    expect(effectiveUrl, "the E2E step needs a DATABASE_URL").toBeTruthy();

    const url = new URL(effectiveUrl!);
    expect(url.protocol).toBe("postgresql:");
    // The service is reached over the runner's mapped port on localhost.
    expect(url.hostname).toBe("localhost");

    const mappedPort = (service?.ports ?? []).map((p) => String(p).split(":")[0]).at(0);
    expect(mappedPort, "the postgres service must publish a port for the job to reach it").toBeTruthy();
    expect(url.port).toBe(mappedPort);

    // Credentials and database name must be the service's own, not a
    // leftover pointing at some other database.
    expect(url.username).toBe(service?.env?.POSTGRES_USER);
    expect(decodeURIComponent(url.password)).toBe(service?.env?.POSTGRES_PASSWORD);
    expect(url.pathname.replace(/^\//, "")).toBe(service?.env?.POSTGRES_DB);
  });

  it("migrates the database before the E2E suite runs", () => {
    const found = findJobRunningE2e();
    expect(found).toBeDefined();
    const { job, step: e2eStep } = found!;
    const steps = job.steps ?? [];
    const e2eIndex = steps.indexOf(e2eStep);
    const migrateIndex = steps.findIndex((s) => s.run?.includes("pnpm db:migrate"));
    expect(migrateIndex, "no `pnpm db:migrate` step found in the E2E job").toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeLessThan(e2eIndex);
  });
});
