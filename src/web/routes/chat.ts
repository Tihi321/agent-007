/**
 * Routes for bots, threads and chat (S34). Every handler gets the user from the SESSION and passes only that id to the services; bot and
 * thread ids from the client are looked up inside that user's own folders, so a foreign id is simply "not found" (I47).
 * The SSE stream is a GET of the user's own thread; it resumes with `Last-Event-ID`.
 */
import type { ServerResponse } from "node:http";
import type { PresetConfig } from "../../bots/schema.js";
import { brainBadge } from "../../bots/brain.js";
import { USER_TOOL_UNIVERSE } from "../capabilities.js";
import { SECURITY_HEADERS, one } from "../http.js";
import type { RouteCtx, RouteDef, RouteResult } from "../server.js";
import { ChatError, QuotaError, ThreadError, UserBotError } from "../chat/service.js";
import type { ChatService, SeqEvent } from "../chat/service.js";
import { AVATARS, } from "../runtime/userBots.js";
import type { UserBotConfig } from "../runtime/userBots.js";
import { obj } from "./auth.js";

async function api(fn: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserBotError) return { status: e.status, body: { error: "bad_bot", message: e.message, issues: e.issues } };
    if (e instanceof ThreadError || e instanceof ChatError) return { status: e.status, body: { error: "chat", message: e.message } };
    if (e instanceof QuotaError) return { status: 429, body: { error: "quota", message: e.message } };
    throw e;
  }
}

function sse(res: ServerResponse, e: SeqEvent): void {
  res.write(`id: ${e.seq}\nevent: ${e.ev.type}\ndata: ${JSON.stringify(e.ev)}\n\n`);
}

export function chatRoutes(svc: ChatService, presets: () => readonly PresetConfig[], users: (userId: string) => { caps: { presets: string[]; tools: string[]; maxBots: number } } | undefined): Record<string, RouteDef> {
  const uid = (c: RouteCtx): string => c.session?.userId ?? "";
  const botView = (id: string, b: UserBotConfig, full = false) => {
    const ps = presets();
    const p = ps.find((x) => x.id === b.preset);
    const badge = brainBadge({ route: { primary: b.preset, allowed: b.fallback ? [b.preset, b.fallback] : [b.preset], fallback: b.fallback ? [b.fallback] : [], onAuthRequired: "fallback" } }, ps);
    return {
      id,
      name: b.name,
      tagline: b.tagline,
      avatar: b.avatar,
      preset: b.preset,
      presetLabel: p?.label ?? b.preset,
      fallback: b.fallback ?? null,
      cloud: badge.cloud,
      egressNote: badge.egressNote,
      tools: b.tools,
      memory: b.memory,
      starters: b.starters,
      ...(full ? { persona: b.persona } : {}),
    };
  };
  return {
    "POST /api/bots/options": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const caps = users(uid(c))?.caps;
          if (!caps) return { status: 403, body: { error: "forbidden" } };
          const ps = presets().filter((p) => caps.presets.includes(p.id)).map((p) => ({ id: p.id, label: p.label, cloud: p.privacy === "cloud", note: brainBadge({ route: { primary: p.id, allowed: [p.id], fallback: [], onAuthRequired: "fallback" } }, presets()).egressNote }));
          return { status: 200, body: { presets: ps, avatars: AVATARS, tools: caps.tools.filter((t) => USER_TOOL_UNIVERSE.includes(t)), maxBots: caps.maxBots, count: svc.bots(uid(c)).ids().length } };
        }),
    },
    "POST /api/bots/list": { auth: "session", handler: (c) => api(() => ({ status: 200, body: { bots: svc.bots(uid(c)).list().map(({ id, bot }) => botView(id, bot)) } })) },
    "POST /api/bots/get": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const id = String(obj(c.body)["id"]);
          const b = svc.bots(uid(c)).get(id);
          return b ? { status: 200, body: { bot: botView(id, b, true) } } : { status: 404, body: { error: "chat", message: "No such bot." } };
        }),
    },
    "POST /api/bots/create": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const r = svc.bots(uid(c)).create(obj(c.body));
          return { status: 200, body: { bot: botView(r.id, r.bot, true), warnings: r.warnings } };
        }),
    },
    "POST /api/bots/update": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const { id, ...rest } = obj(c.body);
          const r = svc.bots(uid(c)).update(String(id), rest);
          return { status: 200, body: { bot: botView(String(id), r.bot, true), warnings: r.warnings } };
        }),
    },
    "POST /api/bots/delete": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const id = String(obj(c.body)["id"]);
          svc.bots(uid(c)).delete(id);
          svc.registry.unregister(`u:${uid(c)}:${id}`);
          return { status: 200, body: { ok: true } };
        }),
    },
    "POST /api/chat/threads": { auth: "session", handler: (c) => api(() => ({ status: 200, body: { threads: svc.threads(uid(c)).list(typeof obj(c.body)["bot"] === "string" ? String(obj(c.body)["bot"]) : undefined) } })) },
    "POST /api/chat/thread/create": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const bot = String(obj(c.body)["bot"]);
          if (!svc.bots(uid(c)).get(bot)) return { status: 404, body: { error: "chat", message: "No such bot." } };
          return { status: 200, body: { thread: svc.threads(uid(c)).create(bot) } };
        }),
    },
    "POST /api/chat/thread/get": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const b = obj(c.body);
          const th = svc.threads(uid(c)).get(String(b["bot"]), String(b["thread"]));
          const run = svc.run(uid(c), th.id);
          return { status: 200, body: { thread: th, running: run !== undefined && !run.done } };
        }),
    },
    "POST /api/chat/thread/rename": { auth: "session", handler: (c) => api(() => (svc.threads(uid(c)).rename(String(obj(c.body)["bot"]), String(obj(c.body)["thread"]), obj(c.body)["title"]), { status: 200, body: { ok: true } })) },
    "POST /api/chat/thread/pin": { auth: "session", handler: (c) => api(() => (svc.threads(uid(c)).pin(String(obj(c.body)["bot"]), String(obj(c.body)["thread"]), obj(c.body)["pinned"]), { status: 200, body: { ok: true } })) },
    "POST /api/chat/thread/delete": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const b = obj(c.body);
          svc.stop(uid(c), String(b["thread"]));
          svc.threads(uid(c)).delete(String(b["bot"]), String(b["thread"]));
          return { status: 200, body: { ok: true } };
        }),
    },
    "POST /api/chat/thread/search": { auth: "session", handler: (c) => api(() => ({ status: 200, body: { threads: svc.threads(uid(c)).search(obj(c.body)["q"]) } })) },
    "POST /api/chat/thread/export": { auth: "session", handler: (c) => api(() => ({ status: 200, body: svc.threads(uid(c)).exportThread(String(obj(c.body)["bot"]), String(obj(c.body)["thread"]), obj(c.body)["format"]) })) },
    "POST /api/chat/send": { auth: "session", handler: (c) => api(async () => ({ status: 200, body: await svc.send(uid(c), { botId: obj(c.body)["bot"], threadId: obj(c.body)["thread"], text: obj(c.body)["text"] }) })) },
    "POST /api/chat/regenerate": { auth: "session", handler: (c) => api(async () => ({ status: 200, body: await svc.regenerate(uid(c), { botId: obj(c.body)["bot"], threadId: obj(c.body)["thread"] }) })) },
    "POST /api/chat/stop": { auth: "session", handler: (c) => api(() => ({ status: 200, body: { stopped: svc.stop(uid(c), obj(c.body)["thread"]) } })) },
    "POST /api/chat/approval": {
      auth: "session",
      handler: (c) =>
        api(() => {
          const ok = svc.approvals.decide(uid(c), obj(c.body)["token"], obj(c.body)["decision"]);
          return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "chat", message: "That approval is no longer open." } };
        }),
    },
    "POST /api/chat/usage": { auth: "session", handler: (c) => api(() => ({ status: 200, body: svc.usage(uid(c)) })) },
    "GET /api/chat/stream": {
      auth: "session",
      stream: true,
      handler: async (c) => {
        const userId = uid(c);
        const bot = c.url.searchParams.get("bot") ?? "";
        const thread = c.url.searchParams.get("thread") ?? "";
        try {
          svc.threads(userId).get(bot, thread); // 404 unless this thread is the session user's
        } catch (e) {
          if (e instanceof ThreadError) return { status: e.status, body: { error: "chat", message: e.message } };
          throw e;
        }
        const release = c.openStream();
        if (!release) return { status: 429, body: { error: "chat", message: "Too many open streams. Close another tab." } };
        const last = Number(one(c.req.headers["last-event-id"]) ?? c.url.searchParams.get("last") ?? 0) || 0;
        const { res } = c;
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
        res.write(": ok\n\n");
        const run = svc.run(userId, thread);
        let finished = false;
        const end = (): void => {
          if (finished) return;
          finished = true;
          clearInterval(beat);
          run?.listeners.delete(listener);
          release();
          res.end();
        };
        const listener = (e: SeqEvent): void => {
          sse(res, e);
          if (e.ev.type === "done") end();
        };
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        beat.unref?.();
        c.req.on("close", end);
        if (!run) {
          res.write(`event: idle\ndata: {}\n\n`);
          end();
          return { handled: true };
        }
        for (const e of run.events) if (e.seq > last) sse(res, e);
        if (run.done) end();
        else run.listeners.add(listener);
        return { handled: true };
      },
    },
  };
}
