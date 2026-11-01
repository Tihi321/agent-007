/**
 * The receiving end of the IPC (I16): a loopback TCP server that speaks src/ipc/protocol.ts. S11 wraps it in the job
 * runner (`src/jobrunner/server.ts`: lock file, templates, limits, the real handler); S9's tests and the other slices'
 * fakes use it directly.
 *
 * - Binds 127.0.0.1 only (`assertLoopbackHost`).
 * - Every line is verified (`decodeLine`). A rejected line, of any kind, closes the connection and logs exactly one
 *   `warn` (`ipc.rejected`, with the reason, the peer port and a connection id, never content). Nothing is executed
 *   and no reply body is written. That includes an HTTP-shaped request.
 * - A connection that sends no valid message within `authTimeoutMs` is closed.
 * - The handler gets `(type, body, ctx)`. It returns the reply data (a `reply` message with `ok: true` is sent when the
 *   type is in `SERVER_REPLIES_TO`), or throws `IpcHandlerError(code, message)` (an `ok: false` reply). A handler for
 *   `permission_decision` returns nothing.
 * - Replies and pushes are signed with the key that authenticated the connection. `broadcast` goes to the connections of
 *   the principal `main` (the agent) by default, never to a permission helper's connection.
 */
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import type { Logger } from "../contracts.js";
import type { Json, JsonObject } from "../jobs/contracts.js";
import type { IpcKey, KeyCandidate } from "./hmac.js";
import {
  IPC_HOST,
  IpcProtocolError,
  LineSplitter,
  NonceCache,
  SERVER_ACCEPTS,
  SERVER_REPLIES_TO,
  assertLoopbackHost,
  decodeLine,
  encodeLine,
  signMessage,
} from "./protocol.js";
import type { IpcErrorCode, MessageType, ReplyBody } from "./protocol.js";

export class IpcHandlerError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcHandlerError";
    this.code = code;
  }
}

export interface IpcRequestContext {
  /** `main` for the agent's key; `job:<id>` (or whatever `keys` returned) for another. */
  principal: string;
  connectionId: number;
  /** The `id` of the request. */
  requestId: string;
  /** Push a signed message to this connection only. False when it is closed. */
  send(type: MessageType, body: JsonObject): boolean;
}

export type IpcHandler = (type: MessageType, body: JsonObject, ctx: IpcRequestContext) => Promise<Json | undefined> | Json | undefined;

export interface IpcServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Must be `127.0.0.1`. */
  host?: string;
  /** The keys that may authenticate a message. For a per-job key (I28), pick it from `peek.body.jobId`. */
  keys: (peek: { type: MessageType; body: JsonObject }) => Iterable<KeyCandidate>;
  handler: IpcHandler;
  logger?: Logger;
  now?: () => number;
  nonces?: NonceCache;
  maxConnections?: number;
  /** A connection with no valid message after this long is closed. Default 10 s. */
  authTimeoutMs?: number;
  /** Close a connection whose unsent output grows past this (a stuck reader). Default 8 MiB. */
  maxQueuedBytes?: number;
}

export interface IpcConnectionInfo {
  id: number;
  principal: string | undefined;
}

export class IpcServer {
  private readonly server: Server;
  private readonly conns = new Map<number, ConnState>();
  private nextConnId = 1;
  private readonly nonces: NonceCache;
  private readonly now: () => number;
  private readonly host: string;
  private readonly logger: Logger | undefined;
  private closing = false;

  constructor(private readonly opts: IpcServerOptions) {
    this.host = opts.host ?? IPC_HOST;
    assertLoopbackHost(this.host);
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.nonces = opts.nonces ?? new NonceCache(undefined, undefined, this.now);
    this.server = createServer((socket) => this.onConnection(socket));
  }

  /** Starts listening. Resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      this.server.once("error", onError);
      this.server.listen({ port: this.opts.port, host: this.host }, () => {
        this.server.off("error", onError);
        const a = this.server.address() as AddressInfo;
        resolve({ host: a.address, port: a.port });
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo | null)?.port ?? this.opts.port;
  }

  connections(): IpcConnectionInfo[] {
    return [...this.conns.values()].map((c) => ({ id: c.id, principal: c.principal }));
  }

  /**
   * Pushes a signed message to every authenticated connection of `principal` (default `main`). Returns how many
   * connections it was written to.
   */
  broadcast(type: MessageType, body: JsonObject, principal = "main"): number {
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.principal === principal && this.write(c, type, body)) n++;
    }
    return n;
  }

  /** Stops listening and destroys every connection. */
  close(): Promise<void> {
    this.closing = true;
    for (const c of this.conns.values()) this.drop(c);
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  // ---- internals ---------------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    const max = this.opts.maxConnections ?? 8;
    if (this.closing || this.conns.size >= max) {
      this.logger?.warn("ipc.rejected", { reason: "too_many_connections", peerPort: socket.remotePort });
      socket.destroy();
      return;
    }
    if (socket.remoteAddress !== undefined && socket.remoteAddress !== "127.0.0.1" && socket.remoteAddress !== "::ffff:127.0.0.1") {
      this.logger?.warn("ipc.rejected", { reason: "non_loopback_peer" });
      socket.destroy();
      return;
    }
    const c: ConnState = {
      id: this.nextConnId++,
      socket,
      splitter: new LineSplitter(),
      principal: undefined,
      key: undefined,
      dead: false,
      timer: undefined,
    };
    this.conns.set(c.id, c);
    socket.setNoDelay(true);
    c.timer = setTimeout(() => {
      if (c.principal === undefined) this.reject(c, "auth_timeout");
    }, this.opts.authTimeoutMs ?? 10_000);
    c.timer.unref();
    socket.on("data", (chunk) => this.onData(c, chunk));
    socket.on("error", () => this.drop(c));
    socket.on("close", () => this.drop(c));
  }

  private onData(c: ConnState, chunk: Buffer): void {
    if (c.dead) return;
    let lines: string[];
    try {
      lines = c.splitter.push(chunk);
    } catch (e) {
      return this.reject(c, e instanceof IpcProtocolError ? e.reason : "malformed");
    }
    for (const line of lines) {
      if (c.dead) return;
      if (line === "") continue;
      let decoded;
      try {
        decoded = decodeLine(line, { keys: this.opts.keys, nonces: this.nonces, now: this.now, accepts: SERVER_ACCEPTS });
      } catch (e) {
        return this.reject(c, e instanceof IpcProtocolError ? e.reason : "malformed");
      }
      if (c.principal === undefined) {
        c.principal = decoded.principal;
        c.key = decoded.key;
        if (c.timer) clearTimeout(c.timer);
      } else if (c.principal !== decoded.principal) {
        // one connection, one principal: a message under another key is refused
        return this.reject(c, "bad_mac");
      }
      void this.dispatch(c, decoded.msg.type, decoded.msg.body, decoded.msg.id);
    }
  }

  private async dispatch(c: ConnState, type: MessageType, body: JsonObject, requestId: string): Promise<void> {
    const ctx: IpcRequestContext = {
      principal: c.principal ?? "",
      connectionId: c.id,
      requestId,
      send: (t, b) => this.write(c, t, b),
    };
    const replies = SERVER_REPLIES_TO.has(type);
    try {
      const data = await this.opts.handler(type, body, ctx);
      if (replies) this.writeReply(c, { replyTo: requestId, ok: true, data: data ?? {} });
    } catch (e) {
      if (e instanceof IpcHandlerError) {
        if (replies) this.writeReply(c, { replyTo: requestId, ok: false, error: { code: e.code, message: e.message } });
        return;
      }
      this.logger?.error("ipc.handler_failed", { type, connectionId: c.id, error: e instanceof Error ? e.name : "error" });
      if (replies) this.writeReply(c, { replyTo: requestId, ok: false, error: { code: "internal", message: "internal error" } });
    }
  }

  private writeReply(c: ConnState, body: ReplyBody): boolean {
    return this.write(c, "reply", body as unknown as JsonObject);
  }

  private write(c: ConnState, type: MessageType, body: JsonObject): boolean {
    if (c.dead || !c.key || c.socket.destroyed) return false;
    let line: Buffer;
    try {
      line = encodeLine(signMessage(c.key as IpcKey, type, body, { now: this.now }));
    } catch (e) {
      this.logger?.error("ipc.encode_failed", { type, connectionId: c.id, error: e instanceof Error ? e.message : "error" });
      return false;
    }
    // remember our own nonce so a reflected copy of this line is a replay
    try {
      const parsed = JSON.parse(line.toString("utf8")) as { nonce: string };
      this.nonces.remember(parsed.nonce);
    } catch {
      /* cannot happen: we just encoded it */
    }
    c.socket.write(line);
    if (c.socket.writableLength > (this.opts.maxQueuedBytes ?? 8 * 1024 * 1024)) {
      this.logger?.warn("ipc.rejected", { reason: "slow_reader", connectionId: c.id });
      this.drop(c);
      return false;
    }
    return true;
  }

  /** One warn line, then close. No reply body, no content. */
  private reject(c: ConnState, reason: string): void {
    if (c.dead) return;
    this.logger?.warn("ipc.rejected", { reason, connectionId: c.id, peerPort: c.socket.remotePort });
    this.drop(c);
  }

  private drop(c: ConnState): void {
    if (c.dead) return;
    c.dead = true;
    if (c.timer) clearTimeout(c.timer);
    this.conns.delete(c.id);
    c.socket.destroy();
  }
}

interface ConnState {
  id: number;
  socket: Socket;
  splitter: LineSplitter;
  principal: string | undefined;
  key: IpcKey | undefined;
  dead: boolean;
  timer: NodeJS.Timeout | undefined;
}

/** Convenience: build and start. */
export async function startIpcServer(opts: IpcServerOptions): Promise<{ server: IpcServer; port: number }> {
  const server = new IpcServer(opts);
  const { port } = await server.listen();
  return { server, port };
}
