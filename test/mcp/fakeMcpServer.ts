/**
 * A local fake MCP server over Streamable HTTP, bound to 127.0.0.1 on an ephemeral port (S10 tests). Never a real
 * creative-hub server. Supports `initialize` (with an `Mcp-Session-Id`), `tools/list` (optionally paged), `tools/call`
 * (JSON or an SSE stream with progress notifications, a hanging call, an error result), `notifications/cancelled`, a
 * bearer-token check, and forgetting every session (a "server restart"). Not a test file.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface FakeToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface FakeTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  /** Returns the result, or a string for one text block. */
  handler?: (args: Record<string, unknown>) => FakeToolResult | string | Promise<FakeToolResult | string>;
  /** Sends these progress notifications (as an SSE stream) before the result, when the caller asked for progress. */
  progress?: { progress: number; total?: number; message?: string }[];
  /** Never answers (until the server closes): for cancel and timeout tests. */
  hang?: boolean;
}

export interface FakeMcpOptions {
  tools: FakeTool[];
  /** Page size for `tools/list` (default: one page). */
  pageSize?: number;
  /** When set, every request must carry `Authorization: Bearer <token>` (else 401). */
  requireToken?: string;
  /** Fixed port (to simulate a restart on the same address). Default: ephemeral. */
  port?: number;
}

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  hadProgressToken: boolean;
}

export class FakeMcpServer {
  readonly calls: RecordedCall[] = [];
  /** Every JSON-RPC method received, in order (`tools/call` included). */
  readonly methods: string[] = [];
  /** `requestId`s of `notifications/cancelled`. */
  readonly cancelled: unknown[] = [];
  /** Headers of the most recent request that had a method. */
  lastHeaders: Record<string, string | string[] | undefined> = {};
  /** Authorization headers seen on `initialize`. */
  readonly initAuth: (string | undefined)[] = [];
  private readonly sessions = new Set<string>();
  private readonly held = new Set<ServerResponse>();
  private readonly server: Server;
  tools: FakeTool[];

  private constructor(
    private readonly opts: FakeMcpOptions,
    server: Server,
  ) {
    this.tools = opts.tools;
    this.server = server;
  }

  static async start(opts: FakeMcpOptions): Promise<FakeMcpServer> {
    let self!: FakeMcpServer;
    const server = createServer((req, res) => void self.handle(req, res));
    self = new FakeMcpServer(opts, server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    return self;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Forget every session: the next request with an old session id gets 404 (a server restart). */
  dropSessions(): void {
    this.sessions.clear();
  }

  async close(): Promise<void> {
    for (const r of this.held) r.destroy();
    this.held.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text === "" ? undefined : JSON.parse(text);
  }

  private reply(res: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (this.opts.requireToken !== undefined && req.headers.authorization !== `Bearer ${this.opts.requireToken}`) {
        res.writeHead(401, { "www-authenticate": 'Bearer realm="fake"' }).end("unauthorized");
        return;
      }
      if (req.method === "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.method === "DELETE") {
        const sid = req.headers["mcp-session-id"];
        if (typeof sid === "string") this.sessions.delete(sid);
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = (await this.readJson(req)) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      const method = msg.method ?? "";
      this.methods.push(method);
      this.lastHeaders = { ...req.headers };

      if (method === "initialize") {
        this.initAuth.push(req.headers.authorization);
        const sid = randomBytes(8).toString("hex");
        this.sessions.add(sid);
        const requested = (msg.params?.["protocolVersion"] as string | undefined) ?? "2025-11-25";
        this.reply(res, msg.id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } }, { "mcp-session-id": sid });
        return;
      }
      const sid = req.headers["mcp-session-id"];
      if (typeof sid !== "string" || !this.sessions.has(sid)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("session not found");
        return;
      }
      if (method === "notifications/cancelled") {
        this.cancelled.push(msg.params?.["requestId"]);
        res.writeHead(202).end();
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (method === "ping") {
        this.reply(res, msg.id, {});
        return;
      }
      if (method === "tools/list") {
        const size = this.opts.pageSize ?? Number.MAX_SAFE_INTEGER;
        const start = Number(msg.params?.["cursor"] ?? 0);
        const page = this.tools.slice(start, start + size).map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        }));
        const next = start + size < this.tools.length ? { nextCursor: String(start + size) } : {};
        this.reply(res, msg.id, { tools: page, ...next });
        return;
      }
      if (method === "tools/call") {
        await this.call(res, msg);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  private async call(res: ServerResponse, msg: { id?: unknown; params?: Record<string, unknown> }): Promise<void> {
    const name = String(msg.params?.["name"]);
    const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
    const meta = msg.params?.["_meta"] as { progressToken?: unknown } | undefined;
    const token = meta?.progressToken;
    this.calls.push({ name, args, hadProgressToken: token !== undefined });
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      this.reply(res, msg.id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      return;
    }
    if (tool.hang) {
      this.held.add(res);
      res.on("close", () => this.held.delete(res));
      return;
    }
    const out = tool.handler ? await tool.handler(args) : "ok";
    const result: FakeToolResult = typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
    if (token !== undefined && tool.progress && tool.progress.length > 0) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const p of tool.progress) {
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, ...p } })}\n\n`);
      }
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
      res.end();
      return;
    }
    this.reply(res, msg.id, result);
  }
}

/** A loopback port with nothing listening on it (it was bound and released). */
export async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
