/**
 * Fakes for the bot room tests: a manual clock (the mirror's `now` and timers), a recording grammY `Api` whose HTTP layer is replaced
 * (EVERY method is recorded, `getUpdates` included, unlike `fakeTelegram`), and a fake bus audit source. Nothing real is contacted.
 */
import { Api, HttpError } from "grammy";
import type { BusAuditEvent } from "../../src/botroom/format.js";
import type { BusAuditSource, MirrorTimers } from "../../src/botroom/mirror.js";
import { FAKE_TOKEN } from "../telegram/helpers/fakeTelegram.js";

export const ROOM_CHAT_ID = -1001234567890;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};

export class ManualClock implements MirrorTimers {
  t = 1_700_000_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = (): number => this.t;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clear(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  pending(): number {
    return this.timers.length;
  }
  /** Moves time forward, firing every timer that falls due, in order, letting async work settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
  at: number;
}

export type ApiFailure = { kind: "api"; error_code: number; description: string; retry_after?: number } | { kind: "network" };

export interface RecordingApi {
  api: Api;
  calls: RecordedCall[];
  sends(): RecordedCall[];
  failNext(failure: ApiFailure, times?: number): void;
}

export function createRecordingApi(clock: { now(): number } = { now: Date.now }): RecordingApi {
  const calls: RecordedCall[] = [];
  const failures: { failure: ApiFailure; left: number }[] = [];
  const api = new Api(FAKE_TOKEN);
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: (payload ?? {}) as Record<string, unknown>, at: clock.now() });
    const head = failures[0];
    if (head && head.left > 0 && method === "sendMessage") {
      head.left--;
      if (head.left === 0) failures.shift();
      if (head.failure.kind === "network") throw new HttpError("fake network failure", new Error("ECONNRESET"));
      const { error_code, description, retry_after } = head.failure;
      return { ok: false, error_code, description, ...(retry_after !== undefined ? { parameters: { retry_after } } : {}) } as never;
    }
    if (method === "sendMessage") return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: Number((payload as { chat_id: unknown }).chat_id), type: "supergroup" } } } as never;
    return { ok: true, result: true } as never;
  });
  return {
    api,
    calls,
    sends: () => calls.filter((c) => c.method === "sendMessage"),
    failNext(failure, times = 1) {
      failures.push({ failure, left: times });
    },
  };
}

export interface FakeAuditSource extends BusAuditSource {
  readonly listeners: number;
  /** Delivers the event to every listener, exactly like a bus would. Throws only if a listener throws. */
  emit(event: BusAuditEvent): void;
}

export function createFakeAuditSource(): FakeAuditSource {
  const listeners = new Set<(e: BusAuditEvent) => void>();
  return {
    get listeners() {
      return listeners.size;
    },
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emit(event) {
      for (const l of [...listeners]) l(event);
    },
  };
}

let n = 0;
export function ask(text: string, o: Partial<BusAuditEvent> = {}): BusAuditEvent {
  n++;
  return { kind: "ask", from: "research", to: "ops", hop: 1, chainId: "7f3a9c1e55aa", text, ...o };
}
