/**
 * The gate in front of a bot's `Models` (S25.1): `createHarnessBotFactory({ decorateModels })` calls the decorator once per bot.
 *
 * The returned `Models` is the bot's own registry with the four request methods (`stream`, `streamSimple`, `complete`,
 * `completeSimple`) wrapped. A call whose model belongs to a gated runner (`model.provider` is `lmstudio` or `strata`) first waits for the
 * runner's slot, then runs the real call and keeps the slot until the stream ends; every other provider (the ACP proxy) passes
 * straight through, since S23's limiter owns it. Everything else on `Models` (lookup, auth, `setProvider`, ...) is the original, unchanged.
 *
 * Failure surfaces the way a provider failure does, as an `error` event with a final message (pi never throws from a stream):
 *  - `busy` (P2 or P3 with a full queue): stopReason `error`, message `server_busy: ...`, which the Harness's retry policy treats as
 *    transient and retries after its backoff;
 *  - `/stop` while waiting: stopReason `aborted`.
 * A call that ends with `toolUse` keeps the slot reserved for its bot for the stickiness window (see `gate.ts`).
 */
import type { AssistantMessage, Models } from "../pi/adapter.js";
import { realClock } from "./clock.js";
import type { GateClock } from "./clock.js";
import { GateAbortedError, GateBusyError } from "./gate.js";
import type { Lease, LocalGate } from "./gate.js";
import type { PriorityHints, TurnHint } from "./hints.js";
import { ForwardStream, gateFailureMessage } from "./stream.js";

type StreamFn = Models["streamSimple"];
type StreamResult = ReturnType<StreamFn>;
type StreamEvent = StreamResult extends AsyncIterable<infer E> ? E : never;
type SimpleOptions = Parameters<StreamFn>[2];

export interface GateDecoratorOptions {
  gate: LocalGate;
  hints: PriorityHints;
  clock?: GateClock;
  /** Content-free hook for tests and logs: called when a gated call is admitted (after its wait). */
  onAdmit?: (info: { bot: string; runner: string; priority: number; waitedMs: number }) => void;
}

/** The `decorateModels` hook for `createHarnessBotFactory`. */
export function createGateDecorator(opts: GateDecoratorOptions): (models: Models, spec: { id: string }) => Models {
  return (models, spec) => gateModels(models, spec.id, opts);
}

export function gateModels(models: Models, botId: string, opts: GateDecoratorOptions): Models {
  const clock = opts.clock ?? realClock;

  function run(variant: "stream" | "streamSimple", kind: "turn" | "summary", model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], options: SimpleOptions): StreamResult {
    const inner = (): StreamResult => (models[variant] as unknown as StreamFn).call(models, model, context, options);
    const gate = opts.gate.runner(model.provider);
    if (!gate) return inner();

    const hint: TurnHint = kind === "summary" ? opts.hints.resolveSummary(botId) : opts.hints.resolve(botId);
    const out = new ForwardStream<StreamEvent>();
    const signal = options?.signal;
    const fail = (stopReason: "error" | "aborted", text: string): void => {
      const error = gateFailureMessage(model, stopReason, text, clock.now());
      out.push({ type: "error", reason: stopReason, error } as unknown as StreamEvent);
      out.end(error);
    };

    void (async () => {
      let lease: Lease;
      try {
        lease = await gate.acquire({ bot: botId, priority: hint.priority, signal, conversationId: hint.conversationId });
      } catch (e) {
        if (e instanceof GateBusyError) fail("error", `server_busy: ${e.message}; try again shortly`);
        else if (e instanceof GateAbortedError) fail("aborted", e.message);
        else fail("error", `local model gate failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      opts.onAdmit?.({ bot: botId, runner: lease.runner, priority: lease.priority, waitedMs: lease.waitedMs });
      // `/stop` frees the slot at once, whether or not the provider has wound down its own stream yet.
      const onAbort = () => lease.release({ aborted: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      let continues = false;
      let ok = false;
      try {
        const stream = inner();
        for await (const ev of stream) out.push(ev);
        const final: AssistantMessage = await stream.result();
        continues = final.stopReason === "toolUse";
        ok = final.stopReason === "toolUse" || final.stopReason === "stop" || final.stopReason === "length";
        out.end(final);
      } catch (e) {
        fail("error", `local model call failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        lease.release({ continues: continues && ok, aborted: !ok });
      }
    })();

    return out as unknown as StreamResult;
  }

  const overrides: Partial<Record<keyof Models, unknown>> = {
    stream: (model: never, context: never, options: never) => run("stream", "turn", model, context, options),
    streamSimple: (model: never, context: never, options: never) => run("streamSimple", "turn", model, context, options),
    complete: (model: never, context: never, options: never) =>
      opts.gate.runner((model as Parameters<StreamFn>[0]).provider) ? run("stream", "summary", model, context, options).result() : (models.complete as unknown as (...a: unknown[]) => unknown).call(models, model, context, options),
    completeSimple: (model: never, context: never, options: never) =>
      opts.gate.runner((model as Parameters<StreamFn>[0]).provider) ? run("streamSimple", "summary", model, context, options).result() : (models.completeSimple as unknown as (...a: unknown[]) => unknown).call(models, model, context, options),
  };

  return new Proxy(models, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop as keyof Models];
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
