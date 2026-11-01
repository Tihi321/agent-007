/**
 * S23.1: the proxy endpoint, `GET /healthz` and `GET /v1/models` (plan I40). These two GETs and `POST /v1/chat/completions` are the ONLY
 * calls this code base makes to the proxy; never `/v1/mcp`, images or URL parameters.
 *
 * Loopback only. The key goes into the `Authorization` header and nowhere else: not into a URL, a log line, an error or a result.
 * `/healthz` needs no key, so it is called without one.
 */
import { ProxyError, classifyProxyResponse, classifyThrown, failureOf } from "./errors.js";
import type { ProxyFailure } from "./errors.js";

/** The proxy's own code default (`src/settings.ts` of the proxy). The real port is read at setup from the user's proxy (U52); the plan's earlier 7461 was wrong. */
export const DEFAULT_PROXY_PORT = 8787;

export const PROXY_PATHS = { chat: "/v1/chat/completions", models: "/v1/models", health: "/healthz" } as const;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ProxyEndpoint {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `http://127.0.0.1:<port>/v1`, what a preset's `baseUrl` holds. */
  baseUrl: string;
  host: string;
  port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointError";
  }
}

/** Build the endpoint from a port, or from a preset `baseUrl` (`http://127.0.0.1:<port>/v1`). Throws `EndpointError` for anything that is not loopback http. */
export function proxyEndpoint(input: { port?: number; baseUrl?: string }): ProxyEndpoint {
  if (input.baseUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(input.baseUrl);
    } catch {
      throw new EndpointError("the proxy URL is not a valid URL");
    }
    if (u.protocol !== "http:") throw new EndpointError("the proxy URL must be http (loopback only)");
    if (!LOOPBACK_HOSTS.has(u.hostname)) throw new EndpointError("the proxy URL must be on 127.0.0.1 (loopback only)");
    if (u.username !== "" || u.password !== "") throw new EndpointError("the proxy URL must not carry credentials");
    const path = u.pathname.replace(/\/+$/, "");
    if (path !== "/v1" && path !== "") throw new EndpointError("the proxy URL must be http://127.0.0.1:<port>/v1");
    const port = u.port === "" ? 80 : Number(u.port);
    return endpointFor(u.hostname === "localhost" ? "127.0.0.1" : u.hostname === "::1" ? "[::1]" : u.hostname, port);
  }
  if (input.port === undefined) throw new EndpointError("give the proxy port (the proxy's default is 8787; scripts/proxy/check-port.ps1 prints the real one)");
  return endpointFor("127.0.0.1", input.port);
}

function endpointFor(host: string, port: number): ProxyEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EndpointError("the proxy port must be 1 to 65535");
  const origin = `http://${host}:${port}`;
  return { origin, baseUrl: `${origin}/v1`, host, port };
}

// ---- /healthz ------------------------------------------------------------------------------

export interface ProviderHealth {
  id: string;
  active?: number;
  queued?: number;
  /** `max_concurrent`: the proxy's cap for this provider (default 4). */
  maxConcurrent?: number;
  /** `max_queue`, when the proxy sets `PROXY_MAX_QUEUE`. */
  maxQueue?: number;
}

export interface ProxyHealth {
  status: string;
  uptimeSeconds?: number;
  providers: ProviderHealth[];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse the `/healthz` body. The proxy's source answers `{ status: "ok", uptime_seconds, providers?: { <id>: { active, queued, max_concurrent, max_queue } } }`;
 * an array of such entries (with an `id`) is accepted too. Returns undefined when the body does not look like the proxy's.
 */
export function parseHealth(body: unknown): ProxyHealth | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o["status"] !== "string") return undefined;
  const providers: ProviderHealth[] = [];
  const raw = o["providers"];
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((p, i): [string, unknown] => [typeof (p as { id?: unknown })?.id === "string" ? ((p as { id: string }).id) : String(i), p])
    : typeof raw === "object" && raw !== null
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  for (const [id, p] of entries) {
    if (typeof p !== "object" || p === null) continue;
    const q = p as Record<string, unknown>;
    const h: ProviderHealth = { id };
    const active = num(q["active"]);
    const queued = num(q["queued"]);
    const cap = num(q["max_concurrent"]);
    const maxQueue = num(q["max_queue"]);
    if (active !== undefined) h.active = active;
    if (queued !== undefined) h.queued = queued;
    if (cap !== undefined) h.maxConcurrent = cap;
    if (maxQueue !== undefined) h.maxQueue = maxQueue;
    providers.push(h);
  }
  const up = num(o["uptime_seconds"]);
  return { status: o["status"], ...(up !== undefined ? { uptimeSeconds: up } : {}), providers };
}

export type HealthResult = { ok: true; health: ProxyHealth } | { ok: false; reason: "down" | "timeout" | "not_proxy" | "http_error"; failure: ProxyFailure };

export interface ProbeOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface Answer {
  status: number;
  body: unknown;
  text: string;
  retryAfter: string | null;
}

/** One GET, with a timeout. Throws only the raw fetch error (the callers classify it). */
async function get(url: string, headers: Record<string, string>, opts: ProbeOptions): Promise<Answer> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await f(url, { method: "GET", headers, signal: ctl.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text, retryAfter: res.headers.get("retry-after") };
  } catch (e) {
    throw new ProxyError(classifyThrown(e, { timedOut: ctl.signal.aborted }));
  } finally {
    clearTimeout(timer);
  }
}

/** `down` for anything that is not a timeout (a refused connection and a reset look the same to the user). */
function unreachable(e: unknown): { reason: "down" | "timeout"; failure: ProxyFailure } {
  const failure = e instanceof ProxyError ? e.failure : failureOf("down");
  return failure.kind === "timeout" ? { reason: "timeout", failure } : { reason: "down", failure: failureOf("down") };
}

/** `GET /healthz` (no key). A wrong port gives `down` (nothing listens) or `not_proxy` (something else answers). */
export async function fetchHealth(endpoint: ProxyEndpoint, opts: ProbeOptions = {}): Promise<HealthResult> {
  let a: Answer;
  try {
    a = await get(endpoint.origin + PROXY_PATHS.health, {}, opts);
  } catch (e) {
    return { ok: false, ...unreachable(e) };
  }
  if (a.status !== 200) return { ok: false, reason: "http_error", failure: classifyProxyResponse({ status: a.status, body: a.body, retryAfter: a.retryAfter }) };
  const health = parseHealth(a.body);
  if (!health) return { ok: false, reason: "not_proxy", failure: failureOf("unknown", { status: a.status }) };
  return { ok: true, health };
}

// ---- /v1/models ----------------------------------------------------------------------------

/** The ids in an OpenAI model-list body (`{ data: [{ id }] }`). Undefined when the body is not a list. */
export function parseModelIds(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  return data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && id !== "");
}

export type ModelsResult = { ok: true; ids: string[] } | { ok: false; reason: "no_key" | "unauthorized" | "down" | "timeout" | "http_error" | "not_proxy"; failure: ProxyFailure };

/** `GET /v1/models` with the shared bearer key. A 401 means the key is wrong. The key is not part of any result. */
export async function fetchModelIds(endpoint: ProxyEndpoint, apiKey: string | undefined, opts: ProbeOptions = {}): Promise<ModelsResult> {
  if (apiKey === undefined || apiKey === "") return { ok: false, reason: "no_key", failure: failureOf("bad_key") };
  let a: Answer;
  try {
    a = await get(endpoint.baseUrl + "/models", { authorization: `Bearer ${apiKey}` }, opts);
  } catch (e) {
    return { ok: false, ...unreachable(e) };
  }
  if (a.status === 401) return { ok: false, reason: "unauthorized", failure: failureOf("bad_key", { status: 401 }) };
  if (a.status !== 200) return { ok: false, reason: "http_error", failure: classifyProxyResponse({ status: a.status, body: a.body, retryAfter: a.retryAfter }) };
  const ids = parseModelIds(a.body);
  if (!ids) return { ok: false, reason: "not_proxy", failure: failureOf("unknown", { status: a.status }) };
  return { ok: true, ids };
}

// ---- /status data --------------------------------------------------------------------------

export interface ProviderStatus {
  providerId: string;
  /** Set by an `auth_required`, `down` failure; cleared by the next success. */
  needsLogin: boolean;
  /** Set by a 401. */
  needsKeyFix: boolean;
  lastFailure?: string;
  lastFailureAt?: number;
}

/**
 * What `/status` shows about the proxy providers: a "needs login" flag per provider (I39). Updated by the Models wrapper from the
 * classified failures; holds only fixed sentences and timestamps, never message text from the proxy.
 */
export class ProxyStatus {
  readonly #byProvider = new Map<string, ProviderStatus>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  noteFailure(providerId: string, failure: ProxyFailure): void {
    if (failure.kind === "aborted" || failure.kind === "limiter_busy") return;
    const s = this.#get(providerId);
    if (failure.needsLogin) s.needsLogin = true;
    if (failure.needsKeyFix) s.needsKeyFix = true;
    s.lastFailure = failure.message;
    s.lastFailureAt = this.#now();
  }

  noteSuccess(providerId: string): void {
    const s = this.#byProvider.get(providerId);
    if (!s) return;
    s.needsLogin = false;
    s.needsKeyFix = false;
  }

  needsLogin(providerId: string): boolean {
    return this.#byProvider.get(providerId)?.needsLogin === true;
  }

  snapshot(): ProviderStatus[] {
    return [...this.#byProvider.values()].map((s) => ({ ...s }));
  }

  #get(providerId: string): ProviderStatus {
    let s = this.#byProvider.get(providerId);
    if (!s) {
      s = { providerId, needsLogin: false, needsKeyFix: false };
      this.#byProvider.set(providerId, s);
    }
    return s;
  }
}
