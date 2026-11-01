/**
 * S10.1: one connection to one creative-hub MCP server (Streamable HTTP, loopback only), over the adapter's `McpClient`.
 *
 *  - The URL must be http(s) on `127.0.0.1` or `localhost`, with no credentials in it (checked here again, whatever the
 *    config loader did). Redirects are refused, so a loopback server cannot send the agent elsewhere.
 *  - The connection is opened on first use and opened again after it closed or the session expired. A tool call is retried
 *    only after a session-expired answer (the request never ran); a dropped connection mid-call is NOT retried, because a
 *    replay-unsafe call may already have started on the server.
 *  - `callTool` takes the caller's `signal` (cancel), a timeout (inactivity: progress notifications re-arm it) and a
 *    progress callback.
 *  - `probeMcpServer` is the `hub_status` check: a TCP connect, then MCP `initialize`. No tool is called.
 */
import { connect as tcpConnect } from "node:net";
import type { Logger } from "../contracts.js";
import { isLoopbackUrl } from "../config/paths.js";
import {
  McpAbortError,
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StreamableHttpTransport,
} from "../pi/adapter.js";
import type { McpCallToolResult, McpProgressNotification, McpTool, StreamableHttpTransportOptions } from "../pi/adapter.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_LIST_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 300_000;
export const CLIENT_NAME = "agent-007";
export const CLIENT_VERSION = "0.1.0";

export class McpUrlRefusedError extends Error {
  constructor(
    readonly serverId: string,
    reason: string,
  ) {
    super(`MCP server "${serverId}": ${reason}`);
    this.name = "McpUrlRefusedError";
  }
}

/** The server cannot be reached (nothing listening, no MCP answer, auth needed, connect timeout). */
export class HubUnavailableError extends Error {
  constructor(
    readonly serverId: string,
    readonly reason: "unreachable" | "auth_required" | "no_mcp" | "timeout" | "closed" | "connection_lost",
    detail?: string,
  ) {
    super(`MCP server "${serverId}" is not available (${reason}${detail ? `: ${detail}` : ""})`);
    this.name = "HubUnavailableError";
  }
}

/** Throws `McpUrlRefusedError` unless the URL is http(s) on loopback without credentials. Returns the parsed URL. */
export function assertLoopbackMcpUrl(serverId: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpUrlRefusedError(serverId, "the url is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new McpUrlRefusedError(serverId, "the url must be http or https");
  if (u.username !== "" || u.password !== "") throw new McpUrlRefusedError(serverId, "the url must not carry credentials");
  if (!isLoopbackUrl(raw)) throw new McpUrlRefusedError(serverId, "refused: the url is not on loopback (127.0.0.1 or localhost)");
  return u;
}

/** The fetch the transport uses: redirects are an error (a hub server never redirects). */
const noRedirectFetch: NonNullable<StreamableHttpTransportOptions["fetch"]> = (input, init) => fetch(input, { ...init, redirect: "error" });

export type McpErrorKind = "abort" | "timeout" | "auth" | "unavailable" | "http" | "closed" | "other";

export interface DescribedError {
  kind: McpErrorKind;
  /** Safe for the model: no URL, no response body. */
  message: string;
}

/** Maps any error from the client to a short message and a kind. Never includes a response body (untrusted). */
export function describeMcpError(e: unknown, serverId: string): DescribedError {
  if (e instanceof McpUrlRefusedError) return { kind: "unavailable", message: e.message };
  if (e instanceof HubUnavailableError && e.reason === "connection_lost") {
    return {
      kind: "closed",
      message: `The connection to "${serverId}" dropped during the call. The call may or may not have run: check with hub_status and do not repeat it blindly.`,
    };
  }
  if (e instanceof HubUnavailableError) {
    const hint = `agent-007 never starts a service itself. Use hub_status to check it; hub_start({service: "${serverId}"}) asks the user for approval in Telegram first.`;
    return { kind: e.reason === "auth_required" ? "auth" : "unavailable", message: `The creative-hub server "${serverId}" is not answering (${e.reason}). ${hint}` };
  }
  if (e instanceof McpAbortError) return { kind: "abort", message: "The call was cancelled." };
  if (e instanceof McpTimeoutError) return { kind: "timeout", message: "The call timed out. It may still be running on the server; do not assume it failed or finished." };
  if (e instanceof McpAuthRequiredError) return { kind: "auth", message: `The server "${serverId}" asked for authentication (HTTP 401). No token is configured for it.` };
  if (e instanceof McpSessionExpiredError) return { kind: "closed", message: "The server session expired." };
  if (e instanceof McpHttpError) return { kind: "http", message: `The server answered HTTP ${e.status}.` };
  if (e instanceof McpConnectionClosedError) return { kind: "closed", message: "The connection to the server closed." };
  const name = e instanceof Error ? e.name : "Error";
  return { kind: "other", message: `The call failed (${name}).` };
}

export interface HubClientOptions {
  id: string;
  url: string;
  /** Sent as `Authorization: Bearer <token>` (secrets.mcpTokens, UI-18). Never logged. */
  token?: string | undefined;
  logger?: Logger | undefined;
  connectTimeoutMs?: number | undefined;
  listTimeoutMs?: number | undefined;
}

export interface HubCallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  onProgress?: ((p: McpProgressNotification) => void) | undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class HubClient {
  readonly id: string;
  readonly url: string;
  private readonly parsed: URL;
  private readonly token: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly connectTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private client: McpClient | undefined;
  private connecting: Promise<McpClient> | undefined;
  private closedByUs = false;

  constructor(opts: HubClientOptions) {
    this.id = opts.id;
    this.url = opts.url;
    this.parsed = assertLoopbackMcpUrl(opts.id, opts.url); // throws before anything touches the network
    this.token = opts.token;
    this.logger = opts.logger;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.listTimeoutMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.client?.connectionState === "connected";
  }

  private async open(): Promise<McpClient> {
    const client = new McpClient({ name: CLIENT_NAME, version: CLIENT_VERSION, requestTimeoutMs: this.connectTimeoutMs });
    const transport = new StreamableHttpTransport({
      url: this.parsed,
      ...(this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {}),
      fetch: noRedirectFetch,
    });
    try {
      await withTimeout(client.connect(transport), this.connectTimeoutMs + 500, () => new McpTimeoutError(this.connectTimeoutMs));
    } catch (e) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      if (e instanceof McpAuthRequiredError) throw new HubUnavailableError(this.id, "auth_required");
      if (e instanceof McpTimeoutError) throw new HubUnavailableError(this.id, "timeout");
      if (e instanceof McpHttpError) throw new HubUnavailableError(this.id, "no_mcp", `HTTP ${e.status}`);
      if (e instanceof TypeError) throw new HubUnavailableError(this.id, "unreachable");
      throw new HubUnavailableError(this.id, "no_mcp", e instanceof Error ? e.name : undefined);
    }
    client.onClose(() => {
      if (this.client === client) this.client = undefined;
    });
    this.logger?.info("mcp.connected", { server: this.id });
    return client;
  }

  /** The connected client; connects (or reconnects) first when needed. Concurrent callers share one attempt. */
  async ensure(): Promise<McpClient> {
    if (this.closedByUs) throw new HubUnavailableError(this.id, "closed");
    if (this.client?.connectionState === "connected") return this.client;
    this.connecting ??= this.open()
      .then((c) => {
        this.client = c;
        return c;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  /** Every tool the server lists (all pages). */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const client = await this.ensure();
    return client.listTools({ timeoutMs: this.listTimeoutMs, ...(signal ? { signal } : {}) });
  }

  async callTool(name: string, args: Record<string, unknown>, opts: HubCallOptions = {}): Promise<McpCallToolResult> {
    const run = async (): Promise<McpCallToolResult> => {
      const client = await this.ensure();
      return client.callTool(name, args, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });
    };
    const t0 = Date.now();
    try {
      let result: McpCallToolResult;
      try {
        result = await run();
      } catch (e) {
        // The server forgot our session (it restarted): the request was refused before it ran, so one retry is safe.
        if (!(e instanceof McpSessionExpiredError)) throw e;
        this.client = undefined;
        result = await run();
      }
      this.logger?.info("mcp.call", { server: this.id, tool: name, ms: Date.now() - t0, ok: result.isError !== true });
      return result;
    } catch (e) {
      this.logger?.info("mcp.call", { server: this.id, tool: name, ms: Date.now() - t0, ok: false, error: e instanceof Error ? e.name : "Error" });
      if (e instanceof TypeError || e instanceof McpConnectionClosedError) {
        // The transport failed under the call (the server went away, or the connection dropped). Never retried: a
        // replay-unsafe call may already be running. Is the server still there?
        const dead = this.client;
        this.client = undefined;
        if (dead) await dead.close().catch(() => {});
        await this.ensure(); // throws HubUnavailableError (unreachable, ...) when it is really down
        throw new HubUnavailableError(this.id, "connection_lost");
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    const c = this.client;
    this.client = undefined;
    if (c) await c.close().catch(() => {});
  }
}

// ---- hub_status probe -----------------------------------------------------------------------------

export type ProbeState = "up" | "down" | "no_mcp" | "auth_required";

export interface ProbeResult {
  state: ProbeState;
  /** Safe one-liner for the model. */
  detail: string;
}

export interface ProbeOptions {
  url: string;
  token?: string | undefined;
  /** TCP connect budget. */
  tcpTimeoutMs?: number;
  /** MCP `initialize` budget. */
  initTimeoutMs?: number;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A TCP connect, then MCP `initialize` over a short-lived session. No tool is called. */
export async function probeMcpServer(serverId: string, opts: ProbeOptions): Promise<ProbeResult> {
  const u = assertLoopbackMcpUrl(serverId, opts.url);
  const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const host = u.hostname;
  if (!(await tcpProbe(host, port, opts.tcpTimeoutMs ?? 1500))) {
    return { state: "down", detail: `nothing is listening on ${host}:${port}` };
  }
  const initMs = opts.initTimeoutMs ?? 4000;
  const client = new McpClient({ name: CLIENT_NAME, version: CLIENT_VERSION, requestTimeoutMs: initMs });
  const transport = new StreamableHttpTransport({
    url: u,
    ...(opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : {}),
    fetch: noRedirectFetch,
    openGetStream: false,
  });
  try {
    await withTimeout(client.connect(transport), initMs + 500, () => new McpTimeoutError(initMs));
    return { state: "up", detail: "answers MCP initialize" };
  } catch (e) {
    if (e instanceof McpAuthRequiredError) return { state: "auth_required", detail: "port open, but the server asks for authentication" };
    return { state: "no_mcp", detail: "port open, but no MCP answer" };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
