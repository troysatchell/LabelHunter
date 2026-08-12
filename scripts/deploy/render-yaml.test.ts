/**
 * Regression test for render.yaml (TRO-481 / LH-060, TH-R16).
 *
 * render.yaml has no application code path of its own — nothing in src/
 * imports it, and no unit test can run a real Render deploy. What this
 * test CAN do, and what it checks: the file parses as valid YAML: it
 * describes exactly the three resources PRD §3.6 names (a `web` service, a
 * `worker` service, one Postgres database); every build/start/migrate
 * command it names is a real script in package.json, not a typo that would
 * only surface on Troy's first real deploy; and every secret-shaped env
 * var is wired as `sync: false` with no `value` — the one invariant this
 * repo cannot afford to regress silently (CLAUDE.md: "No secrets in the
 * repo").
 *
 * `js-yaml` — not a hand-rolled regex scan — parses the file, so this test
 * checks the actual structure Render's own loader will see, not a
 * approximation of it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDER_YAML_PATH = `${REPO_ROOT}render.yaml`;
const PACKAGE_JSON_PATH = `${REPO_ROOT}package.json`;

const renderYamlText = readFileSync(RENDER_YAML_PATH, "utf8");
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
  scripts?: Record<string, string>;
};

// --- Minimal shape for what this test reads. render.yaml is hand-authored
// by this repo, not a producer we don't control, but js-yaml's `load()`
// still returns `unknown` — narrowing explicitly here, rather than casting,
// is what turns a malformed file into a readable test failure instead of a
// raw "Cannot read properties of undefined" deep inside an assertion.
interface RenderEnvVar {
  key: string;
  value?: string;
  sync?: boolean;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; property: string };
  generateValue?: boolean;
}

interface RenderService {
  type: string;
  name: string;
  runtime?: string;
  plan?: string;
  branch?: string;
  buildCommand?: string;
  startCommand?: string;
  preDeployCommand?: string;
  healthCheckPath?: string;
  envVars?: RenderEnvVar[];
}

interface RenderDatabase {
  name: string;
  plan?: string;
  postgresMajorVersion?: string;
}

interface RenderBlueprint {
  services?: RenderService[];
  databases?: RenderDatabase[];
}

function isRenderBlueprint(value: unknown): value is RenderBlueprint {
  return typeof value === "object" && value !== null;
}

const parsed: unknown = loadYaml(renderYamlText);
if (!isRenderBlueprint(parsed)) {
  throw new Error("render.yaml did not parse to an object — see js-yaml's own error above, if any.");
}
const blueprint = parsed;

function requireScript(name: string): string {
  const scripts = packageJson.scripts ?? {};
  if (!(name in scripts)) {
    throw new Error(`package.json has no "${name}" script, but render.yaml's command references it.`);
  }
  return scripts[name];
}

function findService(type: string): RenderService {
  const services = blueprint.services ?? [];
  const matches = services.filter((s) => s.type === type);
  expect(matches, `expected exactly one service of type "${type}"`).toHaveLength(1);
  return matches[0];
}

describe("render.yaml — parses and has the three PRD §3.6 resources", () => {
  it("parses as valid YAML", () => {
    expect(blueprint).toBeTruthy();
  });

  it("declares exactly one web service and one worker service", () => {
    expect(blueprint.services ?? []).toHaveLength(2);
    expect(() => findService("web")).not.toThrow();
    expect(() => findService("worker")).not.toThrow();
  });

  it("declares exactly one Postgres database", () => {
    expect(blueprint.databases ?? []).toHaveLength(1);
  });
});

describe("render.yaml — web service", () => {
  const web = findService("web");

  it("runs on Render's Node runtime", () => {
    expect(web.runtime).toBe("node");
  });

  it("deploys from main", () => {
    expect(web.branch).toBe("main");
  });

  it("names a real, non-empty plan tier", () => {
    expect(web.plan).toBeTruthy();
  });

  it("builds with a real package.json script", () => {
    // Exact match, not toContain: a substring check would still pass on a
    // typo'd or malformed command (extra flags, a wrong operator) as long
    // as "pnpm build" appeared somewhere inside it.
    expect(web.buildCommand).toBe("pnpm install --frozen-lockfile && pnpm build");
    requireScript("build"); // throws if package.json ever drops the script
  });

  it("starts with a real package.json script", () => {
    expect(web.startCommand).toBe("pnpm start");
    expect(requireScript("start")).toBe("next start");
  });

  it("migrates the database before the new code starts serving", () => {
    expect(web.preDeployCommand).toBe("pnpm db:migrate");
    expect(requireScript("db:migrate")).toBe("drizzle-kit migrate");
  });

  it("points its health check at the route that actually exists", () => {
    expect(web.healthCheckPath).toBe("/api/health");
    // Confirms the route file is real, not just a plausible-looking guess —
    // a renamed/removed route would silently break Render's own deploy
    // gating (a health check that 404s never goes healthy) without this.
    expect(() => readFileSync(`${REPO_ROOT}src/app/api/health/route.ts`, "utf8")).not.toThrow();
  });

  it("wires DATABASE_URL from the labelhunter-db resource, not a literal value", () => {
    const envVar = (web.envVars ?? []).find((v) => v.key === "DATABASE_URL");
    expect(envVar?.fromDatabase?.name).toBe("labelhunter-db");
    expect(envVar?.fromDatabase?.property).toBe("connectionString");
    expect(envVar?.value).toBeUndefined();
  });
});

describe("render.yaml — worker service", () => {
  const worker = findService("worker");

  it("runs on Render's Node runtime", () => {
    expect(worker.runtime).toBe("node");
  });

  it("deploys from main", () => {
    expect(worker.branch).toBe("main");
  });

  it("names a real, non-empty plan tier (Render has no free `worker` plan)", () => {
    expect(worker.plan).toBeTruthy();
  });

  it("starts scripts/batch-worker/run.ts via the real package.json script", () => {
    expect(worker.startCommand).toBe("pnpm worker");
    expect(requireScript("worker")).toBe("tsx scripts/batch-worker/run.ts");
  });

  it("installs dependencies only — it never runs a Next.js build it does not use", () => {
    // Exact match, not a "does not contain next build" check: the worker
    // runs its entrypoint through tsx directly (see startCommand above), so
    // its buildCommand should be exactly the install step, nothing more —
    // an extra, unexpected step here would still pass a weaker substring
    // check.
    expect(worker.buildCommand).toBe("pnpm install --frozen-lockfile");
  });

  it("wires DATABASE_URL from the same labelhunter-db resource as the web service", () => {
    const envVar = (worker.envVars ?? []).find((v) => v.key === "DATABASE_URL");
    expect(envVar?.fromDatabase?.name).toBe("labelhunter-db");
    expect(envVar?.value).toBeUndefined();
  });

  it("wires the worker-pool concurrency knobs run.ts actually reads", () => {
    // scripts/batch-worker/run.ts's own envPositiveInt() calls — these three
    // names, and only these three, are the tunable knobs that file reads.
    const byKey = Object.fromEntries((worker.envVars ?? []).map((v) => [v.key, v]));
    expect(byKey.BATCH_WORKER_CONCURRENCY?.value).toBe("5");
    expect(byKey.BATCH_RESOLVE_WORKER_CONCURRENCY?.value).toBe("2");
    expect(byKey.BATCH_WORKER_SHUTDOWN_TIMEOUT_MS?.value).toBe("30000");
  });
});

describe("render.yaml — never hardcodes a secret", () => {
  const KNOWN_TUNING_KEYS = new Set([
    "BATCH_WORKER_CONCURRENCY",
    "BATCH_RESOLVE_WORKER_CONCURRENCY",
    "BATCH_WORKER_SHUTDOWN_TIMEOUT_MS",
  ]);

  it("marks every non-database, non-tuning env var as sync: false with no literal value", () => {
    const services = blueprint.services ?? [];
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      for (const envVar of service.envVars ?? []) {
        if (envVar.fromDatabase || envVar.fromService || envVar.generateValue) continue;
        if (KNOWN_TUNING_KEYS.has(envVar.key)) continue;
        expect(envVar.sync, `${service.name}.${envVar.key} must be sync: false`).toBe(false);
        expect(envVar.value, `${service.name}.${envVar.key} must not carry a literal value`).toBeUndefined();
      }
    }
  });

  it("names ANTHROPIC_API_KEY as sync: false on both services that read it", () => {
    // src/server/extractor/index.ts and src/server/resolver/index.ts both
    // read this — the extractor runs in the web route AND the worker's
    // extract pool; the resolver runs in the worker's resolve pool.
    for (const type of ["web", "worker"]) {
      const service = findService(type);
      const envVar = (service.envVars ?? []).find((v) => v.key === "ANTHROPIC_API_KEY");
      expect(envVar?.sync, `${type} service must declare ANTHROPIC_API_KEY`).toBe(false);
    }
  });

  it("contains no string shaped like a real Anthropic API key", () => {
    // Belt-and-suspenders raw-text scan, independent of the parsed
    // structure above — catches a key pasted into a comment or anywhere
    // else js-yaml's structural checks wouldn't reach.
    expect(renderYamlText).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
  });
});
