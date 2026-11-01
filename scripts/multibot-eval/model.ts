/**
 * The two ways a multi-bot eval run gets its model (S27.1):
 *
 *  - STUB: a scripted GOLDEN model (the case's `golden` steps for `main`, its `peer` script for the other bots), served by the
 *    fake OpenAI server of the Phase 4 rig. It runs offline and proves the harness, the rig and the checks; it is NOT a measurement of
 *    any model.
 *  - LIVE: a small loopback gateway in front of the G0-picked local runner. A request of `main` is forwarded to the real runner; a
 *    request of any other bot (a `<peer_message>` turn) is answered by the scripted peer. So the asking bot is real and the other
 *    bots are fakes: nothing is spent. The gateway only ever talks to `--runner`'s base URL; nothing else is contacted.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { viaToolSearch } from "../../test/integration/rig.js";
import { lastToolName } from "../../test/integration/phase4-script.js";
import { startFakeOpenAi, textOf } from "../../test/helpers/fakeOpenAi.js";
import type { Behavior, BehaviorInput, ChatMessage, ChatRequest, FakeServer } from "../../test/helpers/fakeOpenAi.js";
import { defaultPeer } from "./cases.js";
import type { MultiCase, PeerCtx } from "./cases.js";

export const isPeerTurn = (lastUser: string): boolean => /<peer_message\b/.test(lastUser);

export function peerCtx(i: BehaviorInput): PeerCtx {
  return { from: /from="([^"]+)"/.exec(i.lastUser)?.[1] ?? "?", hop: Number(/hop="(\d+)"/.exec(i.lastUser)?.[1] ?? 0), i, lastTool: lastToolName(i) };
}

/** Non-`tool_search` tool calls since the last user message: the index into a case's golden steps. */
export function realCallsAfterLastUser(msgs: readonly ChatMessage[]): number {
  let last = -1;
  msgs.forEach((m, k) => {
    if (m.role === "user") last = k;
  });
  let n = 0;
  for (const m of msgs.slice(last + 1)) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const t of m.tool_calls as { function?: { name?: string } }[]) if (t.function?.name !== "tool_search") n++;
  }
  return n;
}

export interface MainHooks {
  /** Called when the (stub or real) main model is shown a tool result: the eval marks the chain tainted here when the case says so. */
  onMainAfterTool(): void;
}

/** The scripted answer of any non-main bot. */
export const peerBehavior =
  (c: MultiCase): Behavior =>
  (i) =>
    (c.peer ?? defaultPeer)(peerCtx(i));

/** The GOLDEN stub model for a case: main follows the steps, every other bot answers with the case's peer script. */
export function stubBehavior(c: MultiCase, hooks: MainHooks): Behavior {
  const peer = peerBehavior(c);
  const main = viaToolSearch(
    (i) => {
      const step = c.golden[Math.min(realCallsAfterLastUser(i.request.messages), c.golden.length - 1)] ?? { type: "text" as const, text: "(no golden step)" };
      return typeof step === "function" ? step(i) : step;
    },
    { extraDeferred: (n) => n === "ask_bot" || n === "list_bots" },
  );
  return (i) => {
    if (isPeerTurn(i.lastUser)) return peer(i);
    if (i.afterTool) hooks.onMainAfterTool();
    return main(i);
  };
}

/** The scripted first turns of `main` in a `forceAsk` case: `tool_search`, then `golden[0]` (the ask). */
export function forcedAskBehavior(c: MultiCase): Behavior {
  return viaToolSearch(
    (i) => {
      const step = c.golden[0] ?? { type: "text" as const, text: "(no golden step)" };
      return typeof step === "function" ? step(i) : step;
    },
    { extraDeferred: (n) => n === "ask_bot" || n === "list_bots" },
  );
}

/** True once `main` has called `ask_bot` since the last user message. */
export function askAlreadyCalled(msgs: readonly ChatMessage[]): boolean {
  let last = -1;
  msgs.forEach((m, k) => {
    if (m.role === "user") last = k;
  });
  return msgs.slice(last + 1).some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as { function?: { name?: string } }[]).some((t) => t.function?.name === "ask_bot"));
}

export interface LiveTarget {
  baseUrl: string;
  apiKey?: string | undefined;
  modelId: string;
}

export interface Gateway {
  readonly baseUrl: string;
  /** Every chat request the bots sent to their local runner (main's and the scripted peers'). */
  readonly requests: ChatRequest[];
  inFlight(): number;
  close(): Promise<void>;
}

/** A loopback gateway: main's requests go to the real runner, peer turns to a scripted fake. Opens no other connection. */
export async function startGateway(target: LiveTarget, peerFake: FakeServer, hooks: MainHooks, forcer?: FakeServer): Promise<Gateway> {
  const requests: ChatRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let inFlight = 0;
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: target.modelId, object: "model" }] });
    if (url !== "/v1/chat/completions" || req.method !== "POST") return json(res, 404, { error: { message: "not found" } });
    let body: ChatRequest;
    try {
      body = JSON.parse(raw) as ChatRequest;
    } catch {
      return json(res, 400, { error: { message: "bad json" } });
    }
    requests.push(body);
    const msgs = body.messages ?? [];
    const lastUser = textOf([...msgs].reverse().find((m) => m.role === "user")?.content);
    const peer = isPeerTurn(lastUser);
    if (!peer && msgs[msgs.length - 1]?.role === "tool") hooks.onMainAfterTool();
    const forced = !peer && forcer !== undefined && !askAlreadyCalled(msgs);
    const dest = peer || forced ? `${(forced ? (forcer as FakeServer) : peerFake).baseUrl}/chat/completions` : `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!peer && !forced && target.apiKey) headers["authorization"] = `Bearer ${target.apiKey}`;
    inFlight++;
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      const upstream = await fetch(dest, { method: "POST", headers, body: JSON.stringify(peer || forced ? body : { ...body, model: target.modelId }), signal: ac.signal });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) json(res, 502, { error: { message: "gateway: upstream failed" } });
      else res.end();
    } finally {
      inFlight--;
    }
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    inFlight: () => inFlight,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export async function startPeerFake(c: MultiCase): Promise<FakeServer> {
  return startFakeOpenAi({ behavior: peerBehavior(c), modelId: "peer-fake" });
}
