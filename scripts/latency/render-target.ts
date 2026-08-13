/**
 * Derives Render deployment metadata for a `--url` latency run (TRO-539,
 * PRD §3.8, `render.yaml`).
 *
 * This script has no Render API credentials — the orchestrator's own scope
 * ruling for TRO-539 keeps deploy/Render access out of this dispatch, and
 * CLAUDE.md's non-negotiables never put a real API key in this repo. So
 * "the Render plan" a `--url` artifact records below is read from THIS
 * repo's own committed `render.yaml`, the same way
 * `scripts/deploy/render-yaml.test.ts` already reads it (`js-yaml`, not a
 * hand-rolled regex) — never queried live from Render, and never a
 * hard-coded string literal.
 *
 * A plan value is only ever attached when the run's own target hostname
 * matches the hostname Render's own naming convention
 * (`<service-name>.onrender.com`, no custom domain) would assign to
 * `render.yaml`'s `web` service. A run against `localhost`, a different
 * host, or a future renamed service correctly gets `null` — never a stale
 * or wrong guess. That is the whole point: TRO-539's "provenance trap" was
 * a string that stayed accurate in its own words while the pipeline moved
 * out from under it. This function has no default to go stale — it reads
 * `render.yaml` and the actual `--url` target fresh, every run.
 */
import { load as loadYaml } from "js-yaml";

interface RenderServiceShape {
  type?: unknown;
  name?: unknown;
  plan?: unknown;
}

interface RenderBlueprintShape {
  services?: unknown;
}

export interface RenderWebServiceInfo {
  name: string;
  plan: string;
  /** The hostname Render's own naming convention assigns this service:
   * `${name}.onrender.com`. Not a live DNS lookup — Render's documented,
   * fixed convention for a blueprint service with no custom domain. */
  expectedHost: string;
}

/**
 * Reads the `type: web` service out of a `render.yaml` blueprint's raw YAML
 * text. Defensive (standing rule 13: validate at a boundary where a
 * value's shape is only assumed) — `render.yaml` is repo-controlled today,
 * but this function's job is "does a web service exist and what does it
 * say", not "assume a specific shape". Returns `null` on anything that
 * does not parse to a blueprint with a well-formed `web` service, rather
 * than throwing — a malformed or missing `render.yaml` should degrade this
 * one optional artifact field to `null`, not crash a latency measurement
 * run.
 */
export function findRenderWebService(renderYamlText: string): RenderWebServiceInfo | null {
  let parsed: unknown;
  try {
    parsed = loadYaml(renderYamlText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const services = (parsed as RenderBlueprintShape).services;
  if (!Array.isArray(services)) return null;
  for (const raw of services as RenderServiceShape[]) {
    if (raw?.type === "web" && typeof raw.name === "string" && raw.name.length > 0 && typeof raw.plan === "string" && raw.plan.length > 0) {
      return { name: raw.name, plan: raw.plan, expectedHost: `${raw.name}.onrender.com` };
    }
  }
  return null;
}

/**
 * Returns `render.yaml`'s own `plan` value for its `web` service when
 * `hostname` matches the host Render's naming convention would give that
 * service, `null` otherwise — including when `render.yaml` has no web
 * service, or does not parse. Case-insensitive: hostnames are not
 * case-sensitive (RFC 4343), and a URL typed by hand may not match
 * `render.yaml`'s own casing exactly.
 */
export function deriveRenderPlanForHost(hostname: string, renderYamlText: string): string | null {
  const service = findRenderWebService(renderYamlText);
  if (!service) return null;
  return service.expectedHost.toLowerCase() === hostname.toLowerCase() ? service.plan : null;
}
