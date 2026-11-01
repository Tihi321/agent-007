/**
 * The real chat engine (S34): streams one turn from an OpenAI-compatible endpoint, which is how Strata, LM Studio and the ACP proxy are
 * reached. It runs the tool loop with the bot's own registry, applies I39 for the proxy presets (a login problem, a busy provider or a downed
 * proxy falls back to the bot's local preset ONCE, with one notice), and never sends a sampling field (the same rule as the Pi provider path).
 *
 * Deviation recorded in the plan: this engine is used instead of the Pi `Harness` for web chat. A web turn does not need durable resume
 * (the thread is stored server-side and the client re-asks), and it keeps the gateway free of the owner's Harness, bot manager and Telegram
 * runtime. The proxy rules are the shared ones: `classifyProxyResponse` for errors, `ProxyStatus.refused` for an API-key login.
 */
import type { PresetConfig } from "../../bots/schema.js";
import { classifyProxyResponse, classifyThrown, failureOf } from "../../proxy/errors.js";
import type { ProxyFailure } from "../../proxy/errors.js";
import type { FetchLike, ProxyStatus } from "../../proxy/health.js";
import type { ChatEngine, EngineResult, EngineTurn } from "./engine.js";

export interface ModelEndpoint {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  apiKey?: string | undefined;
  modelId: string;
  maxTokens: number;
  /** True for a preset reached through the proxy (I39 applies). */
  viaProxy: boolean;
  /** The proxy provider of the preset (`claude`, `codex`, `antigravity`): the API-key refusal and /status are keyed by it, never by the model id (L7). */
  providerId?: string | undefined;
  /** M2: a paid route (billed per use). The API-key refusal of MA2 does not apply to it; its spending cap does. */
  paid?: boolean | undefined;
  label: string;
  /** I60: checked before EVERY request (custom cloud sources: https + `checkUrl`). A returned string is a refusal: the link counts as `down` and the chain falls to the next preset. */
  preflight?: (() => Promise<string | undefined>) | undefined;
}

export interface OpenAiEngineOptions {
  /** The endpoint for a preset id of the bot's route, or undefined when it cannot be served. */
  endpoint(presetId: string): ModelEndpoint | undefined;
  status?: ProxyStatus;
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string>; body: ReadableStream<Uint8Array> | null }>;
  maxToolRounds?: number;
  /** Called with a content-free line for the host log (never a prompt or a reply). */
  log?: (line: string) => void;
  /** Called when the proxy answers with a login problem, a 503 or is down, so the host re-reads its health at once instead of waiting for the poll (L7). */
  onProxyTrouble?: () => void;
}

interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

class Failed extends Error {
  constructor(readonly failure: ProxyFailure) {
    super(failure.message);
  }
}

const NOTICE: Record<string, string> = {
  auth_required: "The main model needs a login on the PC, so this answer comes from the local model.",
  down: "The main model is not reachable right now, so this answer comes from the local model.",
  refused: "The main model is not usable (its login is not the subscription), so this answer comes from the local model.",
};

export function createOpenAiEngine(o: OpenAiEngineOptions): ChatEngine {
  const doFetch = o.fetch ?? (globalThis.fetch as unknown as NonNullable<OpenAiEngineOptions["fetch"]>);
  const rounds = o.maxToolRounds ?? 6;

  /** One streamed request. Calls `onDelta` for text. Returns finish info or throws `Failed`. */
  async function stream(ep: ModelEndpoint, messages: Msg[], tools: EngineTurn["tools"], signal: AbortSignal, onDelta: (s: string) => void, maxTokens: number = ep.maxTokens): Promise<{ content: string; calls: NonNullable<Msg["tool_calls"]>; usage?: { input: number; output: number } }> {
    const body = {
      model: ep.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      ...(tools.length > 0 ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    };
    let res: Awaited<ReturnType<typeof doFetch>>;
    if (ep.preflight) {
      let refusal: string | undefined;
      try {
        refusal = await ep.preflight();
      } catch {
        refusal = "the address check failed";
      }
      if (refusal !== undefined) throw new Failed(failureOf("down")); // the fixed "not reachable" notice; the reason is never shown to the chat
    }
    try {
      res = await doFetch(`${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new Failed(classifyThrown(e, { callerAborted: signal.aborted }));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      throw new Failed(classifyProxyResponse({ status: res.status, body: parsed ?? text, retryAfter: res.headers.get("retry-after") }));
    }
    if (!res.body) throw new Failed(failureOf("unknown"));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let usage: { input: number; output: number } | undefined;
    const calls: Record<number, { id: string; name: string; args: string }> = {};
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: unknown };
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.error) throw new Failed(failureOf("unknown"));
          const d = j.choices?.[0]?.delta;
          if (d?.content) {
            content += d.content;
            onDelta(d.content);
          }
          for (const c of d?.tool_calls ?? []) {
            const i = c.index ?? 0;
            const cur = (calls[i] ??= { id: "", name: "", args: "" });
            if (c.id) cur.id = c.id;
            if (c.function?.name) cur.name += c.function.name;
            if (c.function?.arguments) cur.args += c.function.arguments;
          }
          if (j.usage) usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
        }
      }
    } catch (e) {
      if (e instanceof Failed) throw e;
      throw new Failed(classifyThrown(e, { callerAborted: signal.aborted }));
    }
    const out = Object.values(calls)
      .filter((c) => c.name !== "")
      .map((c, i) => ({ id: c.id || `call_${i}`, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } }));
    return { content, calls: out, ...(usage ? { usage } : {}) };
  }

  async function turnOn(t: EngineTurn, ep: ModelEndpoint, presetId: string): Promise<EngineResult> {
    const messages: Msg[] = [{ role: "system", content: t.system }, ...t.history.map((h) => ({ role: h.role, content: h.text }) as Msg), { role: "user", content: t.userText }];
    const total = { input: 0, output: 0 };
    const budget = t.budget?.(presetId);
    for (let round = 0; round < rounds; round++) {
      // M2: a paid preset never gets more output than its cap has left, and the answer ends when the cap is used up
      const left = budget === undefined ? undefined : budget - total.input - total.output;
      if (left !== undefined && left <= 0) {
        t.emit({ type: "notice", text: "The paid model reached its spending cap during this answer, so it stops here." });
        return { stopReason: "stop", usage: total };
      }
      const r = await stream(ep, messages, t.tools, t.signal, (s) => t.emit({ type: "delta", text: s }), left === undefined ? ep.maxTokens : Math.max(1, Math.min(ep.maxTokens, left)));
      total.input += r.usage?.input ?? 0;
      total.output += r.usage?.output ?? 0;
      if (r.calls.length === 0) return { stopReason: "stop", usage: total };
      messages.push({ role: "assistant", content: r.content === "" ? null : r.content, tool_calls: r.calls });
      for (const c of r.calls) {
        let args: Record<string, unknown> = {};
        try {
          const p = JSON.parse(c.function.arguments) as unknown;
          if (typeof p === "object" && p !== null && !Array.isArray(p)) args = p as Record<string, unknown>;
        } catch {
          /* bad arguments are passed on as empty; the tool says what is missing */
        }
        const res = await t.callTool(c.function.name, args);
        messages.push({ role: "tool", tool_call_id: c.id, content: `<untrusted_content source="tool:${c.function.name}">\n${res.text}\n</untrusted_content>` });
        if (res.question) return { stopReason: "stop", usage: total };
      }
    }
    return { stopReason: "stop", usage: total };
  }

  return {
    async runTurn(t: EngineTurn): Promise<EngineResult> {
      const route = t.bot.route;
      const ids = [route.primary, ...route.fallback.filter((f) => f !== route.primary)];
      let said = false;
      let lastFailure: ProxyFailure | undefined;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i] as string;
        if (t.allow && !t.allow(id)) continue; // M1/M2: dropped since the turn started
        const ep = o.endpoint(id);
        if (!ep) continue;
        // MA2: an API-key login is refused for a subscription preset; a preset the owner marked as paid (M2) is billed per use on purpose
        if (ep.viaProxy && ep.providerId !== undefined && ep.paid !== true && o.status?.refused(ep.providerId)) {
          lastFailure = failureOf("refused");
          if (!said && i + 1 < ids.length) {
            t.emit({ type: "notice", text: NOTICE["refused"] as string });
            said = true;
          }
          continue;
        }
        try {
          const r = await turnOn(t, ep, id);
          if (ep.viaProxy && ep.providerId !== undefined) o.status?.noteSuccess(`acp-${ep.providerId}`);
          return { ...r, servedBy: id };
        } catch (e) {
          if (!(e instanceof Failed)) {
            if (t.signal.aborted) return { stopReason: "aborted", usage: { input: 0, output: 0 } };
            throw e;
          }
          lastFailure = e.failure;
          if (ep.viaProxy && e.failure.kind !== "aborted" && ep.providerId !== undefined) o.status?.noteFailure(`acp-${ep.providerId}`, e.failure);
          if (ep.viaProxy && (e.failure.kind === "auth_required" || e.failure.kind === "down" || e.failure.status === 503)) {
            try {
              o.onProxyTrouble?.();
            } catch {
              /* a refresh problem never changes the answer */
            }
          }
          o.log?.(`chat engine: ${ep.label}: ${e.failure.kind}`);
          if (e.failure.kind === "aborted" || t.signal.aborted) return { stopReason: "aborted", usage: { input: 0, output: 0 } };
          if (e.failure.fallback === "never") return { stopReason: "error", usage: { input: 0, output: 0 }, error: "The model could not process this request." };
          if (i + 1 < ids.length && !said) {
            t.emit({ type: "notice", text: NOTICE[e.failure.kind] ?? "The main model did not answer, so this answer comes from the local model." });
            said = true;
          }
        }
      }
      return { stopReason: "error", usage: { input: 0, output: 0 }, error: lastFailure ? `The model is not available right now (${lastFailure.kind.replace("_", " ")}).` : "No model is available for this bot." };
    },
  };
}

export type { FetchLike, PresetConfig };
