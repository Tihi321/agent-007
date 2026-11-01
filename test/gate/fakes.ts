/** Fakes for the S25 gate tests: a manual clock and a fake local runner. Nothing here touches a network, a model or a GPU. */
import type { GateClock } from "../../src/gate/clock.js";
import { ForwardStream } from "../../src/gate/stream.js";
import type { AssistantMessage, Models } from "../../src/pi/adapter.js";

export class FakeClock implements GateClock {
  #now = 1_000_000;
  #timers: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;

  now(): number {
    return this.#now;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const t = { at: this.#now + Math.max(0, ms), seq: ++this.#seq, fn };
    this.#timers.push(t);
    return () => {
      this.#timers = this.#timers.filter((x) => x !== t);
    };
  }

  /** Advances time, firing due timers in order (a timer may set another). */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = target;
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }
}

/** Lets queued promise callbacks run. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

export const SEC = 1000;

type Stop = "stop" | "toolUse" | "length" | "error" | "aborted";

export function assistant(model: { api?: string; provider: string; id: string }, stopReason: Stop, text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: (model.api ?? "openai-completions") as AssistantMessage["api"],
    provider: model.provider as AssistantMessage["provider"],
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

export interface FakeCall {
  provider: string;
  modelId: string;
  variant: "stream" | "streamSimple";
  signal: AbortSignal | undefined;
  /** Sends a text delta. */
  emit(text: string): void;
  /** Ends the call the way a provider does. */
  finish(stopReason?: Stop): void;
  /** Ends the call by throwing inside the stream (a provider bug). */
  crash(message: string): void;
  ended: boolean;
}

/** A fake `Models`: `getModel` knows the given models; every request returns a stream the test finishes by hand. */
export function fakeModels(modelIds: Record<string, string[]>): { models: Models; calls: FakeCall[]; completeCalls: unknown[][]; other: string[] } {
  const calls: FakeCall[] = [];
  const completeCalls: unknown[][] = [];
  const other: string[] = [];
  const table = new Map<string, { provider: string; id: string }>();
  for (const [provider, ids] of Object.entries(modelIds)) for (const id of ids) table.set(`${provider}/${id}`, { provider, id });

  const start = (variant: FakeCall["variant"], model: { provider: string; id: string }, options: { signal?: AbortSignal } | undefined) => {
    const stream = new ForwardStream<{ type: string }>();
    let last: AssistantMessage | undefined;
    let crashMessage: string | undefined;
    const call: FakeCall = {
      provider: model.provider,
      modelId: model.id,
      variant,
      signal: options?.signal,
      ended: false,
      emit(text) {
        stream.push({ type: "text_delta", delta: text } as never);
      },
      finish(stopReason = "stop") {
        if (call.ended) return;
        call.ended = true;
        last = assistant(model, stopReason);
        stream.push(stopReason === "error" || stopReason === "aborted" ? ({ type: "error", reason: stopReason, error: last } as never) : ({ type: "done", reason: stopReason, message: last } as never));
      },
      crash(message) {
        if (call.ended) return;
        call.ended = true;
        crashMessage = message;
        stream.end();
      },
    };
    calls.push(call);
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      result: () => (crashMessage !== undefined ? Promise.reject(new Error(crashMessage)) : stream.result()),
    };
  };

  const models = {
    getModel: (provider: string, id: string) => {
      const m = table.get(`${provider}/${id}`);
      return m ? { ...m, api: "openai-completions", name: id, baseUrl: "http://fake.invalid", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } : undefined;
    },
    getProviders: () => Object.keys(modelIds).map((id) => ({ id })),
    stream: (model: { provider: string; id: string }, _c: unknown, options?: { signal?: AbortSignal }) => start("stream", model, options),
    streamSimple: (model: { provider: string; id: string }, _c: unknown, options?: { signal?: AbortSignal }) => start("streamSimple", model, options),
    complete: (...args: unknown[]) => {
      completeCalls.push(args);
      other.push("complete");
      return Promise.resolve(assistant(args[0] as { provider: string; id: string }, "stop"));
    },
    completeSimple: (...args: unknown[]) => {
      completeCalls.push(args);
      other.push("completeSimple");
      return Promise.resolve(assistant(args[0] as { provider: string; id: string }, "stop"));
    },
    refresh: () => {
      other.push("refresh");
      return Promise.resolve({ aborted: false, errors: new Map() });
    },
  };
  return { models: models as unknown as Models, calls, completeCalls, other };
}

export function modelOf(provider: string, id = "m"): { api: "openai-completions"; provider: string; id: string } {
  return { api: "openai-completions", provider, id };
}
