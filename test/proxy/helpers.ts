/**
 * Helpers for the S23 tests. A fake proxy on 127.0.0.1 (port 0) that records every request, plus the "only these URLs, no sampling field"
 * check. Nothing here talks to the real proxy.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { PresetConfig } from "../../src/bots/schema.js";
import type { RecordedRequest } from "../helpers/fakeOpenAi.js";

export const FAKE_KEY = "sk-fake-proxy-key-0123456789abcdef";

export interface FakeProxyOptions {
  /** Required bearer key for /v1/* (default FAKE_KEY). `/healthz` never needs one. */
  key?: string;
  modelIds?: string[];
  /** The /healthz answer. `false` = answer 404 (something that is not the proxy). */
  health?: unknown;
  /** Force the /v1/models answer (status, body, headers). */
  modelsReply?: { status: number; body: unknown; headers?: Record<string, string> };
}

export interface FakeProxy {
  readonly port: number;
  readonly baseUrl: string;
  readonly requests: { method: string; url: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

export const HEALTH_BODY = {
  status: "ok",
  uptime_seconds: 123,
  providers: { codex: { active: 1, queued: 0, max_concurrent: 4, max_queue: 20 }, claude: { active: 0, queued: 2, max_concurrent: 4 } },
};

export async function startFakeProxy(opts: FakeProxyOptions = {}): Promise<FakeProxy> {
  const requests: FakeProxy["requests"] = [];
  const key = opts.key ?? FAKE_KEY;
  const sockets = new Set<Socket>();
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    const url = (req.url ?? "").split("?")[0];
    if (url === "/healthz") {
      if (opts.health === false) return send(res, 404, { error: { message: "nope" } });
      return send(res, 200, opts.health ?? HEALTH_BODY);
    }
    if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
    if (url === "/v1/models") {
      if (opts.modelsReply) return send(res, opts.modelsReply.status, opts.modelsReply.body, opts.modelsReply.headers);
      return send(res, 200, { object: "list", data: (opts.modelIds ?? ["codex/gpt-x", "claude/sonnet"]).map((id) => ({ id, object: "model" })) });
    }
    send(res, 404, { error: { message: "not found", code: "model_not_found" } });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A port nothing listens on: bind, read the port, close. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const SAMPLING_FIELDS = ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed"];

/** The violations of the I40 rule in the recorded requests: another URL or method, or a sampling field in a chat body. Empty = fine. */
export function violations(requests: readonly Pick<RecordedRequest, "method" | "url" | "body">[]): string[] {
  const out: string[] = [];
  for (const r of requests) {
    const url = r.url.split("?")[0];
    const ok = (r.method === "POST" && url === "/v1/chat/completions") || (r.method === "GET" && (url === "/v1/models" || url === "/healthz"));
    if (!ok || r.url.includes("?")) out.push(`${r.method} ${r.url}`);
    if (r.body) for (const f of SAMPLING_FIELDS) if (f in r.body) out.push(`sampling field ${f} in ${r.url}`);
  }
  return out;
}

export function acpPreset(over: Partial<PresetConfig> & { baseUrl: string }): PresetConfig {
  return {
    id: "codex",
    kind: "acp",
    label: "Codex",
    providerId: "codex",
    apiKeyRef: "proxyApiKey",
    modelId: "codex/gpt-x",
    contextWindow: 100000,
    maxTokens: 4096,
    privacy: "cloud",
    autoFallback: true,
    ...over,
  } as PresetConfig;
}

export function specFor(primary: string, id = "main"): { id: string; route: { primary: string; allowed: string[]; fallback: string[]; onAuthRequired: "ask" } } {
  return { id, route: { primary, allowed: [], fallback: [], onAuthRequired: "ask" } };
}
