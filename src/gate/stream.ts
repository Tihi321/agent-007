/**
 * A forwarding event stream with the same surface as pi-ai's `AssistantMessageEventStream` (async iterable of events, `result()`).
 *
 * The gate has to hand the caller a stream BEFORE it knows whether a slot is free, so it cannot return the provider's own stream.
 * `src/pi/adapter.ts` does not export the stream class (only the adapter may import Pi packages), so this is a small structural twin;
 * the one cast to the adapter's stream type lives in `models.ts`. Behaviour mirrors pi-ai's `EventStream`: FIFO delivery, `done` and
 * `error` events complete it, `end(result)` completes it with a result, and a stream that completes without a result never rejects.
 */
import type { AssistantMessage, Model } from "../pi/adapter.js";

type Api = Model<"openai-completions">["api"];

/** The event union of the stream, derived from the adapter's `AssistantMessage` so no Pi type is imported here. */
export interface StreamEventBase {
  type: string;
}
export type ErrorEvent = { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

export class ForwardStream<E extends StreamEventBase> implements AsyncIterable<E> {
  readonly #queue: E[] = [];
  readonly #waiting: ((r: IteratorResult<E>) => void)[] = [];
  #done = false;
  readonly #result: Promise<AssistantMessage>;
  #resolve!: (m: AssistantMessage) => void;

  constructor() {
    this.#result = new Promise<AssistantMessage>((r) => {
      this.#resolve = r;
    });
  }

  push(event: E): void {
    if (this.#done) return;
    const e = event as unknown as { type: string; message?: AssistantMessage; error?: AssistantMessage };
    if (e.type === "done" && e.message) {
      this.#done = true;
      this.#resolve(e.message);
    } else if (e.type === "error" && e.error) {
      this.#done = true;
      this.#resolve(e.error);
    }
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
    if (this.#done) this.#flush();
  }

  end(result?: AssistantMessage): void {
    this.#done = true;
    if (result !== undefined) this.#resolve(result);
    this.#flush();
  }

  #flush(): void {
    if (this.#queue.length > 0) return; // the consumer drains the queue first, then sees done
    for (const w of this.#waiting.splice(0)) w({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<E> {
    while (true) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#done) return;
      const r = await new Promise<IteratorResult<E>>((resolve) => this.#waiting.push(resolve));
      if (r.done) return;
      yield r.value;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.#result;
  }
}

/** A terminal assistant message for a call the gate refused or aborted (no tokens, no content). */
export function gateFailureMessage(model: { api: Api | string; provider: string; id: string }, stopReason: "error" | "aborted", errorMessage: string, now: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api as AssistantMessage["api"],
    provider: model.provider as AssistantMessage["provider"],
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: now,
  };
}
