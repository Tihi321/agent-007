/**
 * Privacy routes (S36, UI-39, I52): "export my data" and "delete my data". The owner has no way to read chat text: there is no admin route
 * that returns thread bodies (the admin audit holds lengths and hashes only), so export by the user is the only way text leaves an account.
 * Deleting your data removes your bots, threads, uploads and quota (the whole user tree) but keeps the account and its sign-in methods;
 * the owner deletes the account itself.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { userPaths } from "../paths.js";
import type { RouteCtx, RouteDef } from "../server.js";
import type { ChatService } from "../chat/service.js";
import type { WebStack } from "../stack.js";
import type { UserAdmin } from "../users.js";
import { obj } from "./auth.js";

export function privacyRoutes(stack: WebStack, chat: ChatService, _admin: UserAdmin): Record<string, RouteDef> {
  const uid = (c: RouteCtx): string => c.session?.userId ?? "";
  return {
    "POST /api/account/export": {
      auth: "session",
      stepUp: true,
      handler: async (c) => {
        const id = uid(c);
        const u = stack.users.read().users[id];
        const bots = chat.bots(id).list().map(({ id: botId, bot }) => ({ id: botId, ...bot }));
        const threads = chat.threads(id).list().map((s) => chat.threads(id).get(s.botId, s.id));
        const memory: Record<string, string> = {};
        for (const { id: botId } of chat.bots(id).list()) {
          const f = userPaths(stack.dataDir, id).bot(botId).memoryFile;
          if (existsSync(f)) memory[botId] = readFileSync(f, "utf8");
        }
        stack.audit.write({ kind: "export", user: id, detail: { bots: bots.length, threads: threads.length } });
        return { status: 200, body: { exportedAt: new Date().toISOString(), account: { login: u?.login, displayName: u?.displayName, role: u?.role, createdAt: u?.createdAt }, bots, threads, memory } };
      },
    },
    "POST /api/account/delete-data": {
      auth: "session",
      stepUp: true,
      handler: async (c) => {
        const id = uid(c);
        const u = stack.users.read().users[id];
        if (!u || typeof obj(c.body)["confirm"] !== "string" || String(obj(c.body)["confirm"]).trim().toLowerCase() !== u.login.toLowerCase()) {
          return { status: 400, body: { error: "confirm", message: "Type your login to confirm." } };
        }
        chat.stopAllFor(id);
        chat.registry.unregisterUser(id);
        const root = userPaths(stack.dataDir, id).root;
        let removed = 0;
        if (existsSync(root)) {
          removed = readdirSync(root).length;
          rmSync(root, { recursive: true, force: true });
        }
        mkdirSync(root, { recursive: true });
        stack.audit.write({ kind: "user_change", user: id, detail: { change: "data_deleted", entries: removed } });
        return { status: 200, body: { ok: true } };
      },
    },
  };
}
