/**
 * A tiny fake OpenAI-compatible server (loopback only) for unit-testing the Phase 0 scripts.
 * It stands in for LM Studio / Strata: `GET /v1/models`, `GET /health`, `POST /v1/chat/completions` (SSE
 * streaming, text and tool calls), optional bearer-key enforcement. It records every request body.
 * Nothing here talks to a real runner or model.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: { function?: { name?: string } }[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  [k: string]: unknown;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body?: ChatRequest;
}

export type Reply =
  | { type: "text"; text: string; firstDelayMs?: number; chunkDelayMs?: number; chunkSize?: number }
  | { type: "tool_calls"; calls: { name: string; args: unknown }[]; firstDelayMs?: number }
  | { type: "error"; status: number; body?: unknown }
  | { type: "hang" };

export interface BehaviorInput {
  request: ChatRequest;
  lastUser: string;
  /** True when the last message is a tool result (the model is being shown what its tool returned). */
  afterTool: boolean;
  lastToolText: string;
  /** Number of chat requests seen so far, including this one. */
  count: number;
}

export type Behavior = (i: BehaviorInput) => Reply;

export interface FakeOptions {
  port?: number;
  modelId?: string;
  /** Require `Authorization: Bearer <key>` on /v1/*; /health stays open (as the Strata docs describe for /health [U29]). */
  requireKey?: string;
  behavior?: Behavior;
  /** Default delay before the first chunk. */
  firstDelayMs?: number;
}

export interface FakeServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>/v1` */
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  readonly chatRequests: () => RecordedRequest[];
  setBehavior(b: Behavior): void;
  close(): Promise<void>;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[]).map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("");
  }
  return "";
}

/** The behaviours the smoke scripts need, keyed by the user prompt. */
export const defaultBehavior: Behavior = ({ lastUser, afterTool, lastToolText }) => {
  if (afterTool) {
    if (/5555/.test(lastToolText)) return { type: "text", text: "The sum is 5555." };
    return { type: "text", text: `DONE (${lastToolText.slice(0, 40)})` };
  }
  if (/exactly:\s*PONG/i.test(lastUser)) return { type: "text", text: "PONG" };
  if (/add 1234 and 4321/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "add_numbers", args: { a: 1234, b: 4321 } }] };
  if (/gate_me/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "gate_me", args: { note: "go" } }] };
  if (/slow_unsafe/i.test(lastUser)) return { type: "tool_calls", calls: [{ name: "slow_unsafe", args: {} }, { name: "slow_safe", args: {} }] };
  if (/600 words/i.test(lastUser)) return { type: "text", text: "word ".repeat(600), chunkSize: 25, chunkDelayMs: 30 };
  if (/needle/i.test(lastUser)) return { type: "text", text: "OK" };
  return { type: "text", text: "OK" };
};

export async function startFakeOpenAi(opts: FakeOptions = {}): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let behavior: Behavior = opts.behavior ?? defaultBehavior;
  const modelId = opts.modelId ?? "fake-model";
  const sockets = new Set<import("node:net").Socket>();
  let chatCount = 0;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const rec: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization };
    requests.push(rec);
    const url = (req.url ?? "").split("?")[0];
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
      return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
    if (url === "/v1/chat/completions" && req.method === "POST") {
      let body: ChatRequest;
      try {
        body = JSON.parse(raw) as ChatRequest;
      } catch {
        return json(res, 400, { error: { message: "bad json" } });
      }
      rec.body = body;
      chatCount++;
      const msgs = body.messages ?? [];
      const last = msgs[msgs.length - 1];
      const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
      const reply = behavior({
        request: body,
        lastUser: textOf(lastUserMsg?.content),
        afterTool: last?.role === "tool",
        lastToolText: last?.role === "tool" ? textOf(last.content) : "",
        count: chatCount,
      });
      return void respond(res, reply, body, opts.firstDelayMs ?? 0);
    }
    json(res, 404, { error: { message: "not found" } });
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.url === "/v1/chat/completions"),
    setBehavior: (b) => {
      behavior = b;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

function sse(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function respond(res: ServerResponse, reply: Reply, body: ChatRequest, defaultFirstDelay: number): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  if (reply.type === "hang") return; // never answers; the socket is destroyed on close()
  if (reply.type === "error") {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? { error: { message: `fake error ${reply.status}` } }));
    return;
  }
  const first = reply.firstDelayMs ?? defaultFirstDelay;
  if (first > 0) await sleep(first);
  if (closed) return;
  const id = `chatcmpl-fake-${Date.now()}`;
  const model = body.model ?? "fake-model";
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  let completionTokens = 1;
  if (reply.type === "text") {
    const size = reply.chunkSize ?? Math.max(1, reply.text.length);
    for (let i = 0; i < reply.text.length; i += size) {
      if (closed) return;
      sse(res, { ...base, choices: [{ index: 0, delta: { content: reply.text.slice(i, i + size) }, finish_reason: null }] });
      completionTokens++;
      if (reply.chunkDelayMs) await sleep(reply.chunkDelayMs);
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    reply.calls.forEach((c, index) => {
      sse(res, {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_fake_${index}_${Date.now()}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }],
      });
      completionTokens++;
    });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }
  if (body.stream_options?.include_usage) {
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: completionTokens, total_tokens: 10 + completionTokens } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
