/**
 * S23.1: the setup check (plan I40, U52, U56, UI-31). Given the proxy port (the user's, from `scripts/proxy/check-port.ps1`, never read
 * from the proxy's settings by an agent) and the shared key from `secrets.json`, it calls `GET /healthz` and `GET /v1/models` and compares
 * the ids with the `acp` presets. A preset whose id the proxy does not list is marked unavailable (the proxy lists only what the user's
 * plan offers, and the list can change).
 *
 * The report holds ids, counts and fixed sentences. The key is never in it, and `formatSetupReport` passes every line through a
 * redactor built from the key as a second line of defence.
 */
import type { PresetConfig } from "../bots/schema.js";
import { fetchHealth, fetchModelIds, proxyEndpoint } from "./health.js";
import type { FetchLike, HealthResult, ModelsResult, ProviderHealth, ProxyEndpoint } from "./health.js";

export interface PresetAvailability {
  presetId: string;
  providerId: string;
  modelId: string;
  available: boolean;
  /** Why not (fixed sentence). */
  reason?: string;
}

/** The proxy lists Codex models both as `codex/<id>` and bare; every other provider only as `<provider>/<id>`. */
function normalize(providerId: string | undefined, id: string): string {
  return providerId === "codex" && id.startsWith("codex/") ? id.slice("codex/".length) : id;
}

/** Compare the `acp` presets with the ids the proxy lists. Local presets are ignored. */
export function matchPresets(presets: readonly Pick<PresetConfig, "id" | "kind" | "modelId" | "providerId">[], ids: readonly string[]): PresetAvailability[] {
  const out: PresetAvailability[] = [];
  for (const p of presets) {
    if (p.kind !== "acp") continue;
    const providerId = p.providerId ?? "codex";
    const wanted = normalize(providerId, p.modelId);
    const found = ids.some((id) => normalize(providerId, id) === wanted);
    out.push({
      presetId: p.id,
      providerId,
      modelId: p.modelId,
      available: found,
      ...(found ? {} : { reason: "the proxy does not list this model id (not in the user's plan, or the id changed)" }),
    });
  }
  return out;
}

/** The proxy ids no `acp` preset uses: the user may want a preset for them. */
export function unusedIds(presets: readonly Pick<PresetConfig, "kind" | "modelId" | "providerId">[], ids: readonly string[]): string[] {
  const used = new Set(presets.filter((p) => p.kind === "acp").map((p) => normalize(p.providerId ?? "codex", p.modelId)));
  return ids.filter((id) => !used.has(normalize(id.startsWith("codex/") ? "codex" : undefined, id)));
}

export interface SetupReport {
  endpoint: ProxyEndpoint;
  health: HealthResult;
  models: ModelsResult;
  presets: PresetAvailability[];
  /** Ids the proxy lists that no preset uses. */
  unusedModelIds: string[];
  /** True only when the proxy answered `/healthz`, the key was accepted, and every `acp` preset is available. */
  ok: boolean;
}

export interface SetupCheckInput {
  port?: number;
  baseUrl?: string;
  /** `secrets.proxyApiKey`. */
  apiKey?: string | undefined;
  presets?: readonly Pick<PresetConfig, "id" | "kind" | "modelId" | "providerId">[];
  fetch?: FetchLike;
  timeoutMs?: number;
}

export async function checkProxy(input: SetupCheckInput): Promise<SetupReport> {
  const endpoint = proxyEndpoint({ ...(input.port !== undefined ? { port: input.port } : {}), ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}) });
  const probe = { ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) };
  const health = await fetchHealth(endpoint, probe);
  // a wrong port: no point in sending the key to something that is not the proxy
  const models: ModelsResult = health.ok
    ? await fetchModelIds(endpoint, input.apiKey, probe)
    : { ok: false, reason: health.reason === "timeout" ? "timeout" : health.reason === "not_proxy" ? "not_proxy" : "down", failure: health.failure };
  const presets = input.presets ?? [];
  const ids = models.ok ? models.ids : [];
  const matched = models.ok ? matchPresets(presets, ids) : matchPresets(presets, []).map((m) => ({ ...m, reason: "not checked: the model list could not be read" }));
  return {
    endpoint,
    health,
    models,
    presets: matched,
    unusedModelIds: models.ok ? unusedIds(presets, ids) : [],
    ok: health.ok && models.ok && matched.every((m) => m.available),
  };
}

function providerLine(p: ProviderHealth): string {
  const parts = [`${p.id}:`];
  if (p.active !== undefined || p.queued !== undefined) parts.push(`active ${p.active ?? "?"}, queued ${p.queued ?? "?"}`);
  if (p.maxConcurrent !== undefined) parts.push(`proxy cap ${p.maxConcurrent}`);
  if (p.maxQueue !== undefined) parts.push(`max queue ${p.maxQueue}`);
  return parts.join(" ");
}

/** Human-readable lines for the report. `redact` is applied to each line (pass a redactor built from the key). */
export function formatSetupReport(r: SetupReport, redact: (s: string) => string = (s) => s): string[] {
  const lines: string[] = [];
  lines.push(`proxy: ${r.endpoint.baseUrl}`);
  if (r.health.ok) {
    lines.push(`healthz: ok (status ${r.health.health.status}${r.health.health.uptimeSeconds !== undefined ? `, up ${r.health.health.uptimeSeconds}s` : ""})`);
    if (r.health.health.providers.length === 0) lines.push("healthz: no per-provider counts reported");
    for (const p of r.health.health.providers) lines.push(`healthz ${providerLine(p)}`);
  } else {
    const why =
      r.health.reason === "down"
        ? "nothing answers on this port (wrong port, proxy not running, or the main user is logged off)"
        : r.health.reason === "not_proxy"
          ? "something answers, but it is not the proxy (wrong port)"
          : r.health.reason === "timeout"
            ? "no answer in time"
            : `HTTP ${r.health.failure.status ?? "error"}`;
    lines.push(`healthz: FAILED, ${why}`);
  }
  if (r.models.ok) {
    lines.push(`models: ${r.models.ids.length} listed, key accepted`);
  } else if (r.models.reason === "no_key") {
    lines.push("models: SKIPPED, no proxyApiKey in secrets.json (I40 requires a key; copy it yourself, never paste it into a chat)");
  } else if (r.models.reason === "unauthorized") {
    lines.push("models: FAILED, the proxy rejected the key (HTTP 401): the proxyApiKey in secrets.json is wrong");
  } else if (r.health.ok) {
    lines.push(`models: FAILED, ${r.models.failure.message}`);
  } else {
    lines.push("models: SKIPPED, the proxy was not reachable");
  }
  for (const p of r.presets) lines.push(`preset ${p.presetId} (${p.providerId}/${p.modelId}): ${p.available ? "available" : `UNAVAILABLE, ${p.reason ?? "unknown"}`}`);
  if (r.unusedModelIds.length > 0) lines.push(`ids the proxy lists that no preset uses: ${r.unusedModelIds.join(", ")}`);
  lines.push(r.ok ? "setup check: OK" : "setup check: NOT OK");
  return lines.map(redact);
}
