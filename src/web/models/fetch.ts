/**
 * Server-side model list fetch for the Models page (plan agent-007-model-sources, MS3, D7, D9, I40, I59, I60).
 *
 * One owner action ("Fetch models") makes a few GETs against one source and turns the answer into `FetchedRow`s. Rules:
 *  - every request: `redirect: "error"`, 10 s timeout, body read capped at 1 MB (the stream is aborted past the cap), no cookies,
 *    `User-Agent: agent-007`; at most one fetch per source per 3 s.
 *  - a cloud custom source (not a literal loopback host) is checked first: https and `checkUrl` with its own host as the only allowed name.
 *  - the answer holds only what the parsers of `src/models/sources.ts` keep; kind, privacy, provider and defaults come from `classify` (I59).
 *  - errors are FIXED sentences, passed through `createRedactor`; the body and the keys are never returned, logged or echoed.
 */
import { lookup } from "node:dns/promises";
import { createRedactor } from "../../logging/redact.js";
import { parseHealth } from "../../proxy/health.js";
import type { AuthMethod } from "../../proxy/health.js";
import type { TermsAccepted } from "../../bots/schema.js";
import { classify, familyDefaults, findExistingPreset, isLiteralLoopbackUrl, isSetUp, parseLmStudioModels, parseOpenAiModels, parseProxyModels, presetIdFor } from "../../models/sources.js";
import type { ExistingPreset, FetchedRow, ModelSource, ParsedList, ParsedModel } from "../../models/sources.js";
import { checkUrl } from "../runtime/ssrf.js";
import type { Resolver } from "../runtime/ssrf.js";

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BODY_BYTES = 1_000_000;
export const FETCH_MIN_INTERVAL_MS = 3000;
export const USER_AGENT = "agent-007";

export const ERR_NOT_REACHABLE = "not reachable";
export const ERR_NOT_A_LIST = "not an OpenAI-compatible model list";
export const ERR_LMSTUDIO_TOKEN = "LM Studio wants an API token: add lmStudioApiToken to secrets.json";
export const ERR_RATE_LIMIT = "fetch again in a few seconds (one fetch per source every 3 s)";
export const ERR_NOT_SET_UP = "this source is not set up";
export const ERR_NO_PROXY_KEY = "the proxy key is missing: add proxyApiKey to secrets.json";
export const ERR_BAD_URL = "the provider URL was refused";
export const NOTE_CLAUDE_API_KEY = "the proxy's Claude login is an API key: refused unless marked paid";
export const NOTE_PROXY_WAIT = "a provider may be missing; fetch again";
const errKeyRefused = (status: number): string => `the key was refused (${status})`;

/** The slice of `PresetCatalog` (MS2) the fetcher reads. */
export interface FetchCatalog {
  existing(): ExistingPreset[];
  presets(): readonly { id: string }[];
  terms(): TermsAccepted;
  keyFor(source: ModelSource): string | undefined;
}

export type FetchFn = (url: string, init: { method: "GET"; headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

export interface FetchDeps {
  catalog: FetchCatalog;
  /** Default: global `fetch`. */
  fetch?: FetchFn;
  /** For `checkUrl` on cloud custom sources. Default: system DNS. */
  resolver?: Resolver;
  /** Default `Date.now`. */
  now?: () => number;
  /** Last fetch time per source id. Default: one shared map; tests pass their own. */
  lastFetch?: Map<string, number>;
  /** Default `FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface FetchAnswer {
  rows: FetchedRow[];
  ignored: number;
  note?: string;
  /** acp-proxy only: provider -> auth_method from `/healthz` (absent when `/healthz` did not answer or the proxy is older). For `SourceView.proxyAuth`. */
  proxyAuth?: Record<string, AuthMethod>;
}
export type FetchResult = FetchAnswer | { error: string };

const sharedLastFetch = new Map<string, number>();

type Got = { ok: true; status: number; body: unknown } | { ok: false; why: "network" | "too_big" };

async function getJson(url: string, headers: Record<string, string>, deps: FetchDeps): Promise<Got> {
  const f: FetchFn = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await f(url, { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT, ...headers }, redirect: "error", signal: ctl.signal });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > FETCH_MAX_BODY_BYTES) {
          ctl.abort();
          await reader.cancel().catch(() => undefined);
          return { ok: false, why: "too_big" };
        }
        chunks.push(value);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = undefined;
    }
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false, why: "network" };
  } finally {
    clearTimeout(timer);
  }
}

const bearer = (key: string | undefined): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});
const originOf = (baseUrl: string): string => new URL(baseUrl).origin;
const joinBase = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/, "")}${path}`;

/** Map a non-200 answer to the fixed error (401/403 = key refused). */
function httpError(status: number): string {
  return status === 401 || status === 403 ? errKeyRefused(status) : ERR_NOT_A_LIST;
}

type Listed = { parsed: ParsedList } | { error: string };

async function listOpenAi(source: ModelSource, group: "strata" | "custom", deps: FetchDeps, key: string | undefined): Promise<Listed> {
  const g = await getJson(joinBase(source.baseUrl, "/models"), bearer(key), deps);
  if (!g.ok) return { error: g.why === "network" ? ERR_NOT_REACHABLE : ERR_NOT_A_LIST };
  if (g.status !== 200) return { error: httpError(g.status) };
  const parsed = parseOpenAiModels(g.body, group);
  return hasData(g.body, "data") ? { parsed } : { error: ERR_NOT_A_LIST };
}

function hasData(body: unknown, key: string): boolean {
  return typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>)[key]);
}

async function listProxy(source: ModelSource, deps: FetchDeps, key: string | undefined): Promise<(Listed & { proxyAuth?: Record<string, AuthMethod> }) | { error: string }> {
  if (!key) return { error: ERR_NO_PROXY_KEY };
  const g = await getJson(joinBase(source.baseUrl, "/models"), bearer(key), deps);
  if (!g.ok) return { error: g.why === "network" ? ERR_NOT_REACHABLE : ERR_NOT_A_LIST };
  if (g.status !== 200) return { error: httpError(g.status) };
  if (!hasData(g.body, "data")) return { error: ERR_NOT_A_LIST };
  const parsed = parseProxyModels(g.body);
  // /healthz needs no key; a failure here only means no auth information.
  let proxyAuth: Record<string, AuthMethod> | undefined;
  const h = await getJson(`${originOf(source.baseUrl)}/healthz`, {}, deps);
  if (h.ok && h.status === 200) {
    const health = parseHealth(h.body);
    if (health) {
      const map: Record<string, AuthMethod> = {};
      for (const p of health.providers) if (p.authMethod !== undefined) map[p.id.replace(/^acp-/, "")] = p.authMethod;
      if (Object.keys(map).length > 0) proxyAuth = map;
    }
  }
  return { parsed, ...(proxyAuth ? { proxyAuth } : {}) };
}

async function listLmStudio(source: ModelSource, deps: FetchDeps, key: string | undefined): Promise<Listed> {
  const origin = originOf(source.baseUrl);
  const steps: { url: string; shape: "v1" | "v0" | "openai"; field: string }[] = [
    { url: `${origin}/api/v1/models`, shape: "v1", field: "models" },
    { url: `${origin}/api/v0/models`, shape: "v0", field: "data" },
    { url: joinBase(source.baseUrl, "/models"), shape: "openai", field: "data" },
  ];
  let refused: number | undefined;
  let lastError = ERR_NOT_A_LIST;
  for (const s of steps) {
    const g = await getJson(s.url, bearer(key), deps);
    if (!g.ok) {
      if (g.why === "network") return { error: ERR_NOT_REACHABLE };
      lastError = ERR_NOT_A_LIST;
      continue;
    }
    if (g.status === 401) return { error: ERR_LMSTUDIO_TOKEN };
    if (g.status === 403) refused = 403;
    if (g.status !== 200 || !hasData(g.body, s.field)) continue;
    return { parsed: parseLmStudioModels({ [s.shape]: g.body }) };
  }
  return { error: refused !== undefined ? errKeyRefused(refused) : lastError };
}

/**
 * Fetch and classify the model list of one source. Never throws. The rate limit counts every attempt, also a failed one.
 * `proposedId`s are unique within the answer and against every catalogue id.
 */
export async function fetchModels(source: ModelSource, deps: FetchDeps): Promise<FetchResult> {
  const now = (deps.now ?? Date.now)();
  const last = deps.lastFetch ?? sharedLastFetch;
  const prev = last.get(source.id);
  if (prev !== undefined && now - prev < FETCH_MIN_INTERVAL_MS && now >= prev) return { error: ERR_RATE_LIMIT };

  const key = safeKey(source, deps);
  const redact = createRedactor([key]);
  const fail = (error: string): { error: string } => ({ error: redact(error) });

  if (!isSetUp(source)) return fail(ERR_NOT_SET_UP);
  last.set(source.id, now);

  // I60: a custom source off a literal loopback host is cloud: https and the SSRF guard with its own host as the only allowed name.
  if (source.kind === "custom" && !isLiteralLoopbackUrl(source.baseUrl)) {
    let host: string;
    try {
      host = new URL(source.baseUrl).hostname;
    } catch {
      return fail(ERR_BAD_URL);
    }
    if (!source.baseUrl.startsWith("https://")) return fail(ERR_BAD_URL);
    const v = await checkUrl(source.baseUrl, [host], deps.resolver ?? defaultResolver);
    if (!v.ok) return fail(ERR_BAD_URL);
  }
  if (source.keyRef?.startsWith("webkey:") && key === undefined) return fail("the key of this provider cannot be read: save it again");

  let listed: Listed;
  let proxyAuth: Record<string, AuthMethod> | undefined;
  try {
    switch (source.kind) {
      case "acp-proxy": {
        const r = await listProxy(source, deps, key);
        listed = r;
        proxyAuth = "proxyAuth" in r ? r.proxyAuth : undefined;
        break;
      }
      case "lmstudio":
        listed = await listLmStudio(source, deps, key);
        break;
      case "strata":
        listed = await listOpenAi(source, "strata", deps, key);
        break;
      default:
        listed = await listOpenAi(source, "custom", deps, key);
    }
  } catch {
    return fail(ERR_NOT_REACHABLE);
  }
  if ("error" in listed) return fail(listed.error);

  const rows = buildRows(source, listed.parsed.rows, deps);
  const notes: string[] = [];
  if (listed.parsed.note) notes.push(listed.parsed.note);
  if (source.kind === "acp-proxy") {
    if (proxyAuth?.["claude"] === "api_key") notes.push(NOTE_CLAUDE_API_KEY);
    notes.push(NOTE_PROXY_WAIT);
  }
  return {
    rows,
    ignored: listed.parsed.ignored,
    ...(notes.length > 0 ? { note: redact(notes.join("; ")) } : {}),
    ...(proxyAuth ? { proxyAuth } : {}),
  };
}

function safeKey(source: ModelSource, deps: FetchDeps): string | undefined {
  try {
    return deps.catalog.keyFor(source);
  } catch {
    return undefined;
  }
}

function buildRows(source: ModelSource, parsed: readonly ParsedModel[], deps: FetchDeps): FetchedRow[] {
  const existing = deps.catalog.existing();
  const terms = deps.catalog.terms();
  const taken = new Set(deps.catalog.presets().map((p) => p.id));
  for (const e of existing) taken.add(e.id);
  return parsed.map((m) => {
    const c = classify(source, m.modelId);
    const defaults = m.group === "lmstudio" ? familyDefaults("lmstudio", { ...(m.loaded !== undefined ? { loaded: m.loaded } : {}), ...(m.contextHint !== undefined ? { contextHint: m.contextHint } : {}) }) : c.defaults;
    const presetId = findExistingPreset(existing, source.id, m.modelId)?.id;
    const proposedId = presetIdFor(source.id, m.group, m.modelId, taken, existing);
    taken.add(proposedId);
    return {
      modelId: m.modelId,
      group: m.group,
      ...(m.loaded !== undefined ? { loaded: m.loaded } : {}),
      ...(m.contextHint !== undefined ? { contextHint: m.contextHint } : {}),
      ...(presetId !== undefined ? { presetId } : {}),
      proposedId,
      classified: { kind: c.kind, privacy: c.privacy, needsTerms: c.needsTerms, paidAllowed: c.paidAllowed, defaults },
      termsOk: c.needsTerms && c.providerId !== undefined && (terms as unknown as Record<string, boolean>)[c.providerId] === true,
      ...(c.blocked ? { blocked: c.blocked } : {}),
    };
  });
}

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
