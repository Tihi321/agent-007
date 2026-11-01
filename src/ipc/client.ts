/**
 * The agent's end of the IPC (I16, S9.3): `IpcClient implements JobRunnerClient` (src/jobs/contracts.ts).
 *
 * - Connects to `127.0.0.1:<port>` only (`assertLoopbackHost`) and reconnects with jittered backoff until `close()`.
 * - After the TCP connect it sends a signed `status` request as the handshake. The state becomes `online` only when a
 *   valid signed reply came back, which proves the key and the clock. A server that rejects us closes the connection;
 *   the client then goes `offline` and retries (the cause is in the server's log, never in a reply).
 * - Every received line is verified like the server's (`decodeLine`, same checks, the client's own nonces are
 *   remembered, so a reflected copy of a sent line is a replay).
 * - A request while `offline` fails at once with `IpcOfflineError`; callers wait with `waitOnline()` or
 *   `onStateChange()` (S14.1: the job waits, `/status` shows "job runner offline").
 * - The key is never logged. Log fields carry reason codes and ports only.
 */
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { Logger } from "../contracts.js";
import type {
  CallOptions,
  CancelBody,
  CancelReply,
  FlowEstimateBody,
  FlowEstimateReply,
  HubStartBody,
  HubStartReply,
  HubStatusReply,
  JobDone,
  JobEvent,
  JobRunnerClient,
  JobRunnerConnectionState,
  JsonObject,
  ListTemplatesReply,
  PermissionDecision,
  PermissionRequest,
  StatusBody,
  StatusReply,
  SubmitBody,
  SubmitReply,
  Unsubscribe,
} from "../jobs/contracts.js";
import { randomToken } from "./hmac.js";
import type { IpcKey } from "./hmac.js";
import {
  CLIENT_ACCEPTS,
  IPC_HOST,
  IpcProtocolError,
  LineSplitter,
  NonceCache,
  assertLoopbackHost,
  decodeLine,
  encodeLine,
  signMessage,
} from "./protocol.js";
import type { IpcErrorCode, MessageType, ReplyBody, RequestMap, RequestType } from "./protocol.js";

export class IpcOfflineError extends Error {
  constructor(message = "the job runner is offline") {
    super(message);
    this.name = "IpcOfflineError";
  }
}
export class IpcTimeoutError extends Error {
  constructor(message = "the job runner did not answer in time") {
    super(message);
    this.name = "IpcTimeoutError";
  }
}
export class IpcAbortError extends Error {
  constructor(message = "the call was aborted") {
    super(message);
    this.name = "IpcAbortError";
  }
}
/** The runner answered with `ok: false`. */
export class IpcRemoteError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcRemoteError";
    this.code = code;
  }
}

export interface IpcClientOptions {
  port: number;
  /** Must be `127.0.0.1`. */
  host?: string;
  key: IpcKey;
  logger?: Logger;
  now?: () => number;
  /** Default 30 s. */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Backoff between connection attempts. Defaults 500 ms to 15 s, with 20% jitter. */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number; jitter?: boolean };
  /** Test seam. */
  connectImpl?: (port: number, host: string) => Socket;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export class IpcClient implements JobRunnerClient {
  private readonly host: string;
  private readonly now: () => number;
  private readonly nonces: NonceCache;
  private readonly pending = new Map<string, Pending>();
  private readonly stateListeners = new Set<(s: JobRunnerConnectionState) => void>();
  private readonly eventListeners = new Set<(e: JobEvent) => void>();
  private readonly permissionListeners = new Set<(r: PermissionRequest) => void>();
  private readonly doneListeners = new Set<(d: JobDone) => void>();
  private socket: Socket | undefined;
  private splitter = new LineSplitter();
  private current: JobRunnerConnectionState = "offline";
  private started = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private generation = 0;

  constructor(private readonly opts: IpcClientOptions) {
    this.host = opts.host ?? IPC_HOST;
    assertLoopbackHost(this.host);
    this.now = opts.now ?? Date.now;
    this.nonces = new NonceCache(undefined, undefined, this.now);
  }

  get state(): JobRunnerConnectionState {
    return this.current;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connectNow();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.generation++;
    this.failPending(new IpcOfflineError("the client was closed"));
    const s = this.socket;
    this.socket = undefined;
    s?.destroy();
    this.setState("offline");
  }

  waitOnline(opts: CallOptions = {}): Promise<void> {
    if (this.current === "online") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void): void => {
        off();
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const off = this.onStateChange((s) => {
        if (s === "online") finish(resolve);
      });
      const onAbort = (): void => finish(() => reject(new IpcAbortError()));
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish(() => reject(new IpcTimeoutError("timed out waiting for the job runner"))), opts.timeoutMs);
    });
  }

  // ---- typed calls -------------------------------------------------------------------------------

  submit(body: SubmitBody, opts?: CallOptions): Promise<SubmitReply> {
    return this.call("submit", body, opts);
  }
  cancel(body: CancelBody, opts?: CallOptions): Promise<CancelReply> {
    return this.call("cancel", body, opts);
  }
  status(body: StatusBody = {}, opts?: CallOptions): Promise<StatusReply> {
    return this.call("status", body, opts);
  }
  listTemplates(opts?: CallOptions): Promise<ListTemplatesReply> {
    return this.call("list_templates", {}, opts);
  }
  hubStatus(opts?: CallOptions): Promise<HubStatusReply> {
    return this.call("hub_status", {}, opts);
  }
  hubStart(body: HubStartBody, opts?: CallOptions): Promise<HubStartReply> {
    return this.call("hub_start", body, opts);
  }

  flowEstimate(body: FlowEstimateBody, opts?: CallOptions): Promise<FlowEstimateReply> {
    return this.call("flow_estimate", body, opts);
  }

  async answerPermission(decision: PermissionDecision): Promise<void> {
    if (this.current !== "online" || !this.socket) throw new IpcOfflineError();
    this.send("permission_decision", decision as unknown as JsonObject);
  }

  onJobEvent(cb: (event: JobEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }
  onPermissionRequest(cb: (req: PermissionRequest) => void): Unsubscribe {
    this.permissionListeners.add(cb);
    return () => this.permissionListeners.delete(cb);
  }
  onJobDone(cb: (done: JobDone) => void): Unsubscribe {
    this.doneListeners.add(cb);
    return () => this.doneListeners.delete(cb);
  }
  onStateChange(cb: (state: JobRunnerConnectionState) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** The generic form: one request, one reply. Rejects with `IpcOfflineError`, `IpcTimeoutError`, `IpcAbortError` or `IpcRemoteError`. */
  call<T extends RequestType>(type: T, body: RequestMap[T]["body"], opts: CallOptions = {}): Promise<RequestMap[T]["reply"]> {
    if (this.current !== "online" || !this.socket) return Promise.reject(new IpcOfflineError());
    return this.request(type, body as unknown as JsonObject, opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000, opts.signal) as Promise<RequestMap[T]["reply"]>;
  }

  // ---- connection ----------------------------------------------------------------------------------

  private setState(s: JobRunnerConnectionState): void {
    if (this.current === s) return;
    this.current = s;
    for (const cb of [...this.stateListeners]) {
      try {
        cb(s);
      } catch (e) {
        this.opts.logger?.warn("ipc.listener_failed", { listener: "state", error: e instanceof Error ? e.name : "error" });
      }
    }
  }

  private connectNow(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.setState("connecting");
    this.splitter = new LineSplitter();
    let socket: Socket;
    try {
      socket = (this.opts.connectImpl ?? ((port, host) => connect({ port, host })))(this.opts.port, this.host);
    } catch (e) {
      this.opts.logger?.warn("ipc.connect_failed", { reason: e instanceof Error ? e.name : "error" });
      return this.scheduleRetry(gen);
    }
    this.socket = socket;
    socket.setNoDelay(true);
    const connectTimer = setTimeout(() => socket.destroy(new Error("connect timeout")), this.opts.connectTimeoutMs ?? 3000);
    connectTimer.unref();
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      if (gen !== this.generation) return socket.destroy();
      this.request("status", {}, this.opts.handshakeTimeoutMs ?? 5000, undefined).then(
        () => {
          if (gen !== this.generation || this.stopped) return;
          this.attempt = 0;
          this.setState("online");
        },
        (e: unknown) => {
          if (gen !== this.generation) return;
          this.opts.logger?.warn("ipc.handshake_failed", { reason: e instanceof Error ? e.name : "error" });
          socket.destroy();
        },
      );
    });
    socket.on("data", (chunk) => {
      if (gen === this.generation) this.onData(socket, chunk);
    });
    socket.on("error", () => {
      /* 'close' follows */
    });
    socket.once("close", () => {
      clearTimeout(connectTimer);
      if (gen !== this.generation) return;
      if (this.socket === socket) this.socket = undefined;
      this.failPending(new IpcOfflineError("the connection to the job runner closed"));
      this.setState("offline");
      this.scheduleRetry(gen);
    });
  }

  private scheduleRetry(gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    const r = this.opts.reconnect ?? {};
    const initial = r.initialDelayMs ?? 500;
    const max = r.maxDelayMs ?? 15_000;
    const base = Math.min(max, initial * 2 ** Math.min(this.attempt, 16));
    const delay = r.jitter === false ? base : Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.setState("offline");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connectNow();
    }, delay);
    this.retryTimer.unref();
  }

  // ---- messages ------------------------------------------------------------------------------------

  private send(type: MessageType, body: JsonObject): string {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new IpcOfflineError();
    const msg = signMessage(this.opts.key, type, body, { now: this.now });
    this.nonces.remember(msg.nonce);
    socket.write(encodeLine(msg));
    return msg.id;
  }

  private request(type: RequestType, body: JsonObject, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new IpcAbortError());
      let id: string;
      try {
        id = this.send(type, body);
      } catch (e) {
        return reject(e instanceof Error ? e : new IpcOfflineError());
      }
      const onAbort = (): void => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new IpcAbortError());
      };
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        p.reject(new IpcTimeoutError());
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", onAbort) });
    });
  }

  private failPending(e: Error): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(e);
    }
  }

  private onData(socket: Socket, chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.splitter.push(chunk);
    } catch (e) {
      return this.reject(socket, e instanceof IpcProtocolError ? e.reason : "malformed");
    }
    for (const line of lines) {
      if (line === "") continue;
      let decoded;
      try {
        decoded = decodeLine(line, { keys: () => [{ key: this.opts.key, principal: "main" }], nonces: this.nonces, now: this.now, accepts: CLIENT_ACCEPTS });
      } catch (e) {
        return this.reject(socket, e instanceof IpcProtocolError ? e.reason : "malformed");
      }
      this.handle(decoded.msg.type, decoded.msg.body);
    }
  }

  private handle(type: MessageType, body: JsonObject): void {
    try {
      switch (type) {
        case "reply": {
          const r = body as unknown as ReplyBody;
          const p = this.pending.get(r.replyTo);
          if (!p) return;
          this.pending.delete(r.replyTo);
          clearTimeout(p.timer);
          p.cleanup();
          if (r.ok) p.resolve(r.data);
          else p.reject(new IpcRemoteError(r.error.code, r.error.message));
          return;
        }
        case "job_event":
          for (const cb of [...this.eventListeners]) this.safe("job_event", () => cb(body as unknown as JobEvent));
          return;
        case "permission_request":
          for (const cb of [...this.permissionListeners]) this.safe("permission_request", () => cb(body as unknown as PermissionRequest));
          return;
        case "job_done":
          for (const cb of [...this.doneListeners]) this.safe("job_done", () => cb(body as unknown as JobDone));
          return;
        default:
          return;
      }
    } catch (e) {
      this.opts.logger?.warn("ipc.handle_failed", { type, error: e instanceof Error ? e.name : "error" });
    }
  }

  private safe(listener: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.opts.logger?.warn("ipc.listener_failed", { listener, error: e instanceof Error ? e.name : "error" });
    }
  }

  private reject(socket: Socket, reason: string): void {
    this.opts.logger?.warn("ipc.rejected", { reason, side: "client" });
    socket.destroy();
  }
}

/** A fresh request id (exported for tests and fakes). */
export const newRequestId = randomToken;
