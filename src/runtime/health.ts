/**
 * Runner health monitor (S1.5). Polls the CONFIGURED runner every 30 s and emits change events.
 *  - LM Studio: `GET /v1/models` with the token; up = HTTP 200 and the model id is listed.
 *  - Strata: `GET /health` OK AND `GET /v1/models` (with `strataApiKey` if set) lists the model id.
 *    The probe timeout is 10 s. A probe that times out while the port accepts connections means Strata is busy
 *    with another sequence (FIFO): that counts as UP, not down (U28). A refused connection is down.
 * The `beforeRequest` health gate (only if smoke S7 FAILED) is not built here; it is S1.5's conditional
 * fallback and depends on the live Phase 0 result.
 */
import type { Logger } from "../contracts.js";
import type { RunnerName } from "../config/schema.js";

export interface HealthStatus {
  runner: RunnerName;
  up: boolean;
  /** Epoch ms since the current up/down state began (the first probe result sets it). */
  since: number;
  lastCheckedAt: number;
  /** Short reason when down, or "busy" when up through a probe timeout. */
  detail: string;
}

export interface HealthOptions {
  runner: RunnerName;
  /** The runner's OpenAI base URL, for example `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  modelId: string;
  apiKey?: string | undefined;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export type ProbeResult = { up: boolean; detail: string };

export interface HealthMonitor {
  readonly status: () => HealthStatus;
  /** One probe now; updates the status and fires change events. */
  check(): Promise<HealthStatus>;
  start(): void;
  stop(): void;
  onChange(cb: (s: HealthStatus) => void): void;
}

function originOf(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.origin;
}

/** A short text for a failed `fetch` (Node wraps the real code in `error.cause`). */
export function describeFetchError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } } | null;
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
}

function isAbort(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

async function listsModel(res: Response, modelId: string): Promise<boolean> {
  try {
    const body = (await res.json()) as { data?: { id?: string }[] };
    return Array.isArray(body.data) && body.data.some((m) => m.id === modelId);
  } catch {
    return false;
  }
}

/** One probe of the configured runner. Never throws. */
export async function probeRunner(o: HealthOptions): Promise<ProbeResult> {
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const headers: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  const get = (url: string) => f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const modelsUrl = `${o.baseUrl.replace(/\/+$/, "")}/models`;

  if (o.runner === "strata") {
    try {
      const h = await get(`${originOf(o.baseUrl)}/health`);
      if (!h.ok) return { up: false, detail: `/health returned HTTP ${h.status}` };
    } catch (e) {
      if (isAbort(e)) return { up: true, detail: "busy (health probe timed out)" };
      return { up: false, detail: `runner unreachable: ${describeFetchError(e)}` };
    }
    try {
      const m = await get(modelsUrl);
      if (!m.ok) return { up: false, detail: `/v1/models returned HTTP ${m.status}` };
      return (await listsModel(m, o.modelId)) ? { up: true, detail: "ok" } : { up: false, detail: `model ${o.modelId} not listed` };
    } catch (e) {
      if (isAbort(e)) return { up: true, detail: "busy (models probe timed out)" };
      return { up: false, detail: `runner unreachable: ${describeFetchError(e)}` };
    }
  }

  try {
    const m = await get(modelsUrl);
    if (m.status !== 200) return { up: false, detail: `/v1/models returned HTTP ${m.status}` };
    return (await listsModel(m, o.modelId)) ? { up: true, detail: "ok" } : { up: false, detail: `model ${o.modelId} not listed` };
  } catch (e) {
    return { up: false, detail: isAbort(e) ? "probe timed out" : `runner unreachable: ${describeFetchError(e)}` };
  }
}

export function createHealthMonitor(o: HealthOptions): HealthMonitor {
  const now = o.now ?? Date.now;
  const interval = o.intervalMs ?? 30_000;
  let status: HealthStatus = { runner: o.runner, up: false, since: now(), lastCheckedAt: 0, detail: "not checked yet" };
  let first = true;
  let timer: NodeJS.Timeout | undefined;
  const listeners: ((s: HealthStatus) => void)[] = [];

  const check = async (): Promise<HealthStatus> => {
    const r = await probeRunner(o);
    const t = now();
    const changed = first || r.up !== status.up;
    status = { runner: o.runner, up: r.up, since: changed ? t : status.since, lastCheckedAt: t, detail: r.detail };
    if (changed) {
      first = false;
      o.logger?.info("runner.health", { runner: o.runner, up: r.up, detail: r.detail });
      for (const cb of listeners) {
        try {
          cb(status);
        } catch (e) {
          o.logger?.warn("runner.health.listener_error", { error: String(e) });
        }
      }
    }
    return status;
  };

  return {
    status: () => status,
    check,
    start() {
      if (timer) return;
      void check();
      timer = setInterval(() => void check(), interval);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}
