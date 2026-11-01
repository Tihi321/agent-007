/**
 * S23.2 and S23.3 wiring: the proxy as a bot's brain, through the two hooks of `createHarnessBotFactory` (`extraProviders`, `decorateModels`).
 *
 * - `proxyProvidersForBot`: one provider per proxy vendor (`acp-codex`, `acp-claude`, `acp-antigravity`) with one `Model` per preset of
 *   the bot's route, built with the adapter's generic factory (plain OpenAI chat completions over loopback; no ACP SDK, no Pi import here).
 *   `contextWindow` and `maxTokens` come from the preset (`/v1/models` has neither). No sampling parameter is set anywhere (U53).
 * - `limitProxyModels`: wraps a bot's `Models` so every call to an `acp-*` provider first takes a slot in the shared per-provider limiter
 *   (default 3, never above 4, per-bot 1, I44 priority order), reports classified failures to `/status` and the fallback engine, and
 *   keeps non-retryable failures from being retried by the Harness (I39). Calls to any other provider pass through untouched.
 *
 * Only `POST /v1/chat/completions` is ever sent by the provider; `GET /v1/models` and `GET /healthz` live in `health.ts`.
 */
import type { PresetConfig, ResolvedBot } from "../bots/schema.js";
import { routePresets } from "../bots/runtime.js";
import type { Redactor } from "../logging/redact.js";
import type { AssistantMessage, Models, OpenAICompatModelInput, OpenAICompatProviderInput } from "../pi/adapter.js";
import { classifyProxyMessage, failureOf, markedMessage } from "./errors.js";
import type { ProxyFailure } from "./errors.js";
import { ProxyStatus, proxyEndpoint } from "./health.js";
import { LimiterBusyError, ProxyLimiters } from "./limiter.js";
import type { Priority } from "./limiter.js";

/** Provider ids of the proxy in a bot's `Models`: `acp-<vendor>`. */
export const ACP_PROVIDER_PREFIX = "acp-";

export function isProxyProviderId(id: string): boolean {
  return id.startsWith(ACP_PROVIDER_PREFIX);
}

// ---- providers -----------------------------------------------------------------------------

export interface ProxyProviderOptions {
  /** `secrets.proxyApiKey`. Only ever held in the provider's auth closure. */
  proxyApiKey?: string | undefined;
  /** Preset ids to leave out (the setup check marked them unavailable). */
  unavailablePresetIds?: ReadonlySet<string>;
}

/**
 * The proxy providers for one bot's route. The URL must be loopback `http://127.0.0.1:<port>/v1` (the loader already refuses anything else;
 * this throws `EndpointError` as a second check). A later provider with the same id replaces an earlier one inside `createBotModels`, so this
 * is safe next to `providersForBot`, which also builds `acp-*` providers from the same presets.
 */
export function proxyProvidersForBot(spec: Pick<ResolvedBot, "route">, presets: readonly PresetConfig[], opts: ProxyProviderOptions = {}): OpenAICompatProviderInput[] {
  const byProvider = new Map<string, { id: string; baseUrl: string; models: OpenAICompatModelInput[] }>();
  for (const p of routePresets(spec, presets)) {
    if (p.kind !== "acp" || p.baseUrl === undefined) continue;
    if (opts.unavailablePresetIds?.has(p.id)) continue;
    const id = `${ACP_PROVIDER_PREFIX}${p.providerId ?? "proxy"}`;
    let draft = byProvider.get(id);
    if (!draft) {
      draft = { id, baseUrl: proxyEndpoint({ baseUrl: p.baseUrl }).baseUrl, models: [] };
      byProvider.set(id, draft);
    }
    if (!draft.models.some((m) => m.modelId === p.modelId)) {
      draft.models.push({ modelId: p.modelId, name: p.label, contextWindow: p.contextWindow, maxTokens: p.maxTokens });
    }
  }
  return [...byProvider.values()].map((d) => ({ ...d, authLabel: "proxy key", ...(opts.proxyApiKey ? { apiKey: opts.proxyApiKey } : {}) }));
}

// ---- the Models wrapper --------------------------------------------------------------------

type Streamed = ReturnType<Models["streamSimple"]>;
type StreamEvent = Streamed extends AsyncIterable<infer E> ? E : never;
type ModelRef = Parameters<Models["streamSimple"]>[0];

export type CallKind = "stream" | "complete";

export interface CallInfo {
  botId: string;
  providerId: string;
  modelId: string;
  kind: CallKind;
}

export interface FailureEvent extends CallInfo {
  failure: ProxyFailure;
}

export interface LimitDeps {
  limiters: ProxyLimiters;
  status?: ProxyStatus;
  /**
   * The I44 class of a call. Default: a streamed generation is P0 (the user's own turn) and a `complete` (compaction, summaries) is P3.
   * S26 supplies the real one: a peer-initiated or background turn is P2, a turn in a user-started chain P1.
   */
  priorityFor?: (info: CallInfo) => Priority;
  /** Called once per failed call, with the classification (the fixed sentence, never the proxy's text). S26 feeds the S22.3 fallback engine. */
  onFailure?: (ev: FailureEvent) => void;
  isProxyProvider?: (providerId: string) => boolean;
  /** Retry inside the call (default true; deviation 98). `false` reports every failure once and never retries. */
  retry?: boolean;
  /** Test seam: waits `ms`, resolves false when `signal` aborted first. Default: a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** Applied to anything this wrapper puts into a message (it never puts the key there; this is the second line of defence). */
  redact?: Redactor;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function zeroUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function errorMessageFor(model: ModelRef, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason, errorMessage, timestamp: Date.now() };
}

/**
 * A stream the wrapper can create before the limiter lets the call start. It is the minimal shape the Harness uses (`for await` and
 * `result()`), which `AssistantMessageEventStream` also offers; the class itself is not importable here (only the adapter imports Pi).
 */
class DeferredStream {
  readonly #events: StreamEvent[] = [];
  readonly #readers: ((r: IteratorResult<StreamEvent>) => void)[] = [];
  #done = false;
  readonly #result: Promise<AssistantMessage>;
  #resolve!: (m: AssistantMessage) => void;

  constructor() {
    this.#result = new Promise<AssistantMessage>((r) => {
      this.#resolve = r;
    });
  }

  push(ev: StreamEvent): void {
    if (this.#done) return;
    const reader = this.#readers.shift();
    if (reader) reader({ value: ev, done: false });
    else this.#events.push(ev);
  }

  end(result: AssistantMessage): void {
    if (this.#done) return;
    this.#done = true;
    this.#resolve(result);
    for (const r of this.#readers.splice(0)) r({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: (): Promise<IteratorResult<StreamEvent>> => {
        const ev = this.#events.shift();
        if (ev !== undefined) return Promise.resolve({ value: ev, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.#readers.push(r));
      },
    };
  }

  result(): Promise<AssistantMessage> {
    return this.#result;
  }
}

/** Wrap one bot's `Models`. Everything except the four generation entry points is forwarded unchanged. */
export function limitProxyModels(models: Models, spec: Pick<ResolvedBot, "id">, deps: LimitDeps): Models {
  const isProxy = deps.isProxyProvider ?? isProxyProviderId;
  const redact = deps.redact ?? ((s: string) => s);
  const priorityFor = deps.priorityFor ?? ((info: CallInfo): Priority => (info.kind === "stream" ? 0 : 3));

  const info = (model: ModelRef, kind: CallKind): CallInfo => ({ botId: spec.id, providerId: model.provider, modelId: model.id, kind });

  const report = (i: CallInfo, failure: ProxyFailure): void => {
    deps.status?.noteFailure(i.providerId, failure);
    try {
      deps.onFailure?.({ ...i, failure });
    } catch {
      /* a failing observer never changes the call */
    }
  };

  const sleep = deps.sleep ?? defaultSleep;
  const retriesOn = deps.retry !== false;

  /**
   * Deviation 98 fix: the retry lives INSIDE the model call. A failure that I39 allows to retry (busy: twice, waiting `Retry-After` when the
   * text carried one, else the table's delay; queue full, timeout, unknown: once after 5 s) is retried by this wrapper, with the slot released
   * while it waits. Every failed try is reported (so the S22.3 engine's counters match the tries); when the tries are spent the Harness sees the
   * fixed marked sentence, which contains none of its retry words, so the Harness's own retry never stacks on top of this one.
   */
  const retryDelayMs = (failure: ProxyFailure, attempt: number, signal: AbortSignal | undefined): number | undefined => {
    if (!retriesOn || signal?.aborted === true || failure.kind === "aborted") return undefined;
    if (attempt >= failure.retry.attempts) return undefined;
    return Math.max(0, Math.round(failure.retry.delaySec * 1000));
  };

  const guardedStream = (model: ModelRef, signal: AbortSignal | undefined, start: () => Streamed): Streamed => {
    const i = info(model, "stream");
    const out = new DeferredStream();
    const fail = (failure: ProxyFailure, kind: "error" | "aborted"): void => {
      const msg = errorMessageFor(model, kind, redact(markedMessage(failure)));
      out.push({ type: "error", reason: kind, error: msg } as StreamEvent);
      out.end(msg);
    };
    /** One try. Returns the wait before the next try when it failed before any content and may be retried. */
    const once = async (attempt: number): Promise<number | undefined> => {
      let release: (() => void) | undefined;
      try {
        release = await deps.limiters.for(i.providerId).acquire({ botId: i.botId, priority: priorityFor(i), signal });
      } catch (e) {
        const aborted = !(e instanceof LimiterBusyError);
        const failure = failureOf(aborted ? "aborted" : "limiter_busy");
        if (!aborted) report(i, failure);
        fail(failure, aborted ? "aborted" : "error");
        return undefined;
      }
      try {
        const inner = start();
        let last: AssistantMessage | undefined;
        let held: StreamEvent[] = [];
        let flushed = false;
        let retryMs: number | undefined;
        const flush = (): void => {
          flushed = true;
          for (const h of held.splice(0)) out.push(h);
        };
        for await (const ev of inner) {
          const e = ev as { type: string; error?: AssistantMessage; message?: AssistantMessage; reason?: string };
          if (e.type === "error" && e.error) {
            const failure = classifyProxyMessage(e.error.errorMessage, { aborted: e.error.stopReason === "aborted" });
            if (failure.kind !== "aborted") report(i, failure);
            if (!flushed) {
              const wait = retryDelayMs(failure, attempt, signal);
              if (wait !== undefined) {
                retryMs = wait;
                held = [];
                continue;
              }
            }
            const fixed = failure.kind === "aborted" ? e.error : { ...e.error, errorMessage: redact(markedMessage(failure)) };
            last = fixed;
            flush();
            out.push(fixed === e.error ? ev : ({ ...e, error: fixed } as StreamEvent));
            continue;
          }
          if (e.type === "done") deps.status?.noteSuccess(i.providerId);
          if (e.type === "start" && !flushed) held.push(ev);
          else {
            flush();
            out.push(ev);
          }
        }
        const res = await inner.result();
        if (retryMs !== undefined && last === undefined) return retryMs;
        flush();
        out.end(last ?? res);
        return undefined;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        const failure = classifyProxyMessage(text, { aborted: signal?.aborted === true });
        if (failure.kind !== "aborted") report(i, failure);
        const wait = retryDelayMs(failure, attempt, signal);
        if (wait !== undefined) return wait;
        fail(failure, failure.kind === "aborted" ? "aborted" : "error");
        return undefined;
      } finally {
        release();
      }
    };
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = await once(attempt);
        if (wait === undefined) return;
        // the slot is released while waiting; the next try queues again at its own priority
        const slept = await sleep(wait, signal);
        if (!slept) {
          fail(failureOf("aborted"), "aborted");
          return;
        }
      }
    })();
    return out as unknown as Streamed;
  };

  const guardedComplete = async (model: ModelRef, signal: AbortSignal | undefined, call: () => Promise<AssistantMessage>): Promise<AssistantMessage> => {
    const i = info(model, "complete");
    for (let attempt = 0; ; attempt++) {
      let release: () => void;
      try {
        release = await deps.limiters.for(i.providerId).acquire({ botId: i.botId, priority: priorityFor(i), signal });
      } catch (e) {
        const aborted = !(e instanceof LimiterBusyError);
        const failure = failureOf(aborted ? "aborted" : "limiter_busy");
        if (!aborted) report(i, failure);
        return errorMessageFor(model, aborted ? "aborted" : "error", redact(markedMessage(failure)));
      }
      let wait: number | undefined;
      try {
        const m = await call();
        if (m.stopReason === "error") {
          const failure = classifyProxyMessage(m.errorMessage);
          report(i, failure);
          wait = retryDelayMs(failure, attempt, signal);
          if (wait === undefined) return { ...m, errorMessage: redact(markedMessage(failure)) };
        } else {
          if (m.stopReason !== "aborted") deps.status?.noteSuccess(i.providerId);
          return m;
        }
      } finally {
        release();
      }
      if (!(await sleep(wait, signal))) return errorMessageFor(model, "aborted", redact(markedMessage(failureOf("aborted"))));
    }
  };

  const target = models;
  const wrapped = new Proxy(target, {
    get(t, prop) {
      if (prop === "streamSimple" || prop === "stream") {
        const fn = (t as unknown as Record<string, (...a: unknown[]) => Streamed>)[prop] as (...a: unknown[]) => Streamed;
        return (model: ModelRef, context: unknown, options?: { signal?: AbortSignal }): Streamed =>
          isProxy(model.provider) ? guardedStream(model, options?.signal, () => fn.call(t, model, context, options)) : fn.call(t, model, context, options);
      }
      if (prop === "completeSimple" || prop === "complete") {
        const fn = (t as unknown as Record<string, (...a: unknown[]) => Promise<AssistantMessage>>)[prop] as (...a: unknown[]) => Promise<AssistantMessage>;
        return (model: ModelRef, context: unknown, options?: { signal?: AbortSignal }): Promise<AssistantMessage> =>
          isProxy(model.provider) ? guardedComplete(model, options?.signal, () => fn.call(t, model, context, options)) : fn.call(t, model, context, options);
      }
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return wrapped as Models;
}

// ---- one object for the host ---------------------------------------------------------------

export interface ProxyBrainOptions {
  presets: readonly PresetConfig[];
  secrets: { proxyApiKey?: string | undefined };
  /** `gate.proxyMaxConcurrent` (default 3, clamped to 1..4). */
  proxyMaxConcurrent?: number;
  /** `gate.maxQueueDepth` and `gate.agingSec` (as ms), so the proxy limiter follows the same numbers as the local gate. */
  maxQueue?: number;
  agingMs?: number;
  /** One limiter set per host; create it once and pass it when several brains are built. Default: a new one. */
  limiters?: ProxyLimiters;
  status?: ProxyStatus;
  priorityFor?: LimitDeps["priorityFor"];
  onFailure?: LimitDeps["onFailure"];
  redact?: Redactor;
  retry?: boolean;
  sleep?: LimitDeps["sleep"];
  unavailablePresetIds?: ReadonlySet<string>;
}

export interface ProxyBrain {
  /** `HarnessBotDeps.extraProviders` */
  extraProviders(spec: ResolvedBot): OpenAICompatProviderInput[];
  /** `HarnessBotDeps.decorateModels` */
  decorateModels(models: Models, spec: ResolvedBot): Models;
  limiters: ProxyLimiters;
  status: ProxyStatus;
}

/** The two hooks S26 passes to `createHarnessBotFactory`, sharing one limiter set and one status object across all bots. */
export function createProxyBrain(opts: ProxyBrainOptions): ProxyBrain {
  const limiters =
    opts.limiters ??
    new ProxyLimiters({
      ...(opts.proxyMaxConcurrent !== undefined ? { defaultLimit: opts.proxyMaxConcurrent } : {}),
      ...(opts.maxQueue !== undefined ? { maxQueue: opts.maxQueue } : {}),
      ...(opts.agingMs !== undefined ? { agingMs: opts.agingMs } : {}),
    });
  const status = opts.status ?? new ProxyStatus();
  return {
    limiters,
    status,
    extraProviders: (spec) => proxyProvidersForBot(spec, opts.presets, { proxyApiKey: opts.secrets.proxyApiKey, ...(opts.unavailablePresetIds ? { unavailablePresetIds: opts.unavailablePresetIds } : {}) }),
    decorateModels: (models, spec) =>
      limitProxyModels(models, spec, {
        limiters,
        status,
        ...(opts.priorityFor ? { priorityFor: opts.priorityFor } : {}),
        ...(opts.onFailure ? { onFailure: opts.onFailure } : {}),
        ...(opts.redact ? { redact: opts.redact } : {}),
        ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      }),
  };
}
