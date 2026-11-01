/** A whole web app on a free port with a scripted chat engine, for the S34 to S36 tests. Not a test file. */
import { request } from "node:http";
import { createServer } from "node:net";
import type { PresetConfig } from "../../src/bots/schema.js";
import { createWebAudit, memoryWebAudit } from "../../src/web/audit.js";
import type { WebAudit } from "../../src/web/audit.js";
import type { PresetCatalog } from "../../src/web/models/catalog.js";
import type { ModelsRouteDeps } from "../../src/web/routes/models.js";
import { webPaths } from "../../src/web/paths.js";
import { startWebApp } from "../../src/web/app.js";
import type { WebApp, WebAppOptions } from "../../src/web/app.js";
import type { ChatEngine, EngineTurn } from "../../src/web/chat/engine.js";
import { USER_TOOL_UNIVERSE } from "../../src/web/capabilities.js";
import { defaultCaps } from "../../src/web/schemas.js";
import type { Caps } from "../../src/web/schemas.js";
import { totpAt, totpStep } from "../../src/web/totp.js";
import { tempDir } from "../settings/helpers.js";
import { http } from "./helpers.js";
import type { Reply } from "./helpers.js";

export const PUBLIC = "pc.tail1234.ts.net";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

const local = (id: string): PresetConfig => ({ id, kind: "local", runner: "strata", label: id, modelId: id, contextWindow: 100000, maxTokens: 4096, privacy: "local", autoFallback: true });
export const PRESETS: PresetConfig[] = [
  local("strata"),
  { id: "claude-sonnet", kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", providerId: "claude", apiKeyRef: "proxyApiKey", label: "Claude Sonnet", modelId: "claude/sonnet", contextWindow: 200000, maxTokens: 8192, privacy: "cloud", autoFallback: false },
  // M2: a paid route (Anthropic API credits through the proxy); off for every bot until the owner enables it with caps
  { id: "claude-api", kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", providerId: "claude", apiKeyRef: "proxyApiKey", label: "Claude API credits", modelId: "claude/sonnet", contextWindow: 200000, maxTokens: 8192, privacy: "cloud", autoFallback: false, billing: "paid" },
];

export type Handler = (t: EngineTurn, n: number) => Promise<{ stopReason?: "stop" | "aborted" | "error"; usage?: { input: number; output: number }; error?: string; servedBy?: string } | void>;

export class ScriptedEngine implements ChatEngine {
  calls: EngineTurn[] = [];
  running = 0;
  maxRunning = 0;
  constructor(public handler: Handler = async (t) => {
    t.emit({ type: "delta", text: "Hello " });
    t.emit({ type: "delta", text: "world" });
  }) {}
  async runTurn(t: EngineTurn) {
    this.calls.push(t);
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      const r = (await this.handler(t, this.calls.length)) ?? {};
      return { stopReason: r.stopReason ?? "stop", usage: r.usage ?? { input: 10, output: 5 }, ...(r.error ? { error: r.error } : {}), servedBy: r.servedBy ?? t.bot.route.primary };
    } finally {
      this.running--;
    }
  }
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(5);
  }
  throw new Error("timed out waiting");
}

export interface Who {
  cookie: string;
  csrf: string;
  /** The Tailscale login the test identity header claims; omitted = the PC (local). */
  login?: string;
  userId: string;
}

export interface TestApp {
  app: WebApp;
  port: number;
  dir: string;
  audit: ReturnType<typeof memoryWebAudit>;
  engine: ScriptedEngine;
  clock: { t: number };
  owner: Who;
  ownerSecret: string;
  /** Invite and accept a new user (a tailnet identity), return their session. */
  addUser(login: string, caps?: Partial<Caps>, role?: "user" | "admin"): Promise<Who & { password: string; secret: string }>;
  post(who: Who | undefined, path: string, body?: unknown): Promise<Reply>;
  /** Opens an SSE stream and collects raw text until `until` matches or the stream ends. */
  stream(who: Who, qs: string, opts?: { lastEventId?: number; until?: RegExp; timeoutMs?: number }): Promise<string>;
  close(): Promise<void>;
}

export async function makeApp(o: { engine?: ScriptedEngine; realEngine?: ChatEngine; claim?: boolean; controlDir?: string; bodyTimeoutMs?: number; ownerCaps?: boolean; mode?: WebAppOptions["mode"]; keepRunMs?: number; rate?: WebAppOptions["rate"];
  /** MS4: build the preset catalogue (and the route seams) of the Models page. The audit given writes to the audit folder too, as in production. */
  models?: (dir: string, audit: WebAudit) => { catalog: PresetCatalog; deps?: ModelsRouteDeps };
} = {}): Promise<TestApp> {
  const dir = tempDir("a7-app-");
  const port = await freePort();
  const mem = memoryWebAudit();
  let audit = mem;
  let m: ReturnType<NonNullable<typeof o.models>> | undefined;
  if (o.models) {
    const file = createWebAudit({ dir: webPaths(dir).auditDir });
    audit = { events: mem.events, write: (e) => (mem.write(e), file.write(e)) };
    m = o.models(dir, audit);
  }
  const engine = o.engine ?? new ScriptedEngine();
  const clock = { t: Date.now() };
  const app = await startWebApp({
    dataDir: dir,
    port,
    mode: o.mode ?? "tailnet",
    publicHosts: [PUBLIC],
    serveStatus: () => JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${PUBLIC}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } }),
    clockSkewMs: () => 0,
    presets: m ? () => m.catalog.presets() : () => PRESETS,
    terms: m ? () => m.catalog.terms() : () => ({ claude: true, antigravity: false }),
    ...(m ? { catalog: m.catalog, ...(m.deps ? { models: m.deps } : {}) } : {}),
    engine: o.realEngine ?? engine,
    audit,
    now: () => clock.t,
    identify: async (req) => (req.headers["x-test-identity"] ? { ok: true, identity: { kind: "tailscale", login: String(req.headers["x-test-identity"]) } } : { ok: true, identity: { kind: "local" } }),
    ...(o.rate ? { rate: o.rate } : {}),
    ...(o.keepRunMs !== undefined ? { keepRunMs: o.keepRunMs } : {}),
    ...(o.controlDir ? { controlDir: o.controlDir } : {}),
    ...(o.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: o.bodyTimeoutMs } : {}),
  });
  const host = (w?: Who) => (w?.login ? PUBLIC : `localhost:${port}`);
  const origin = (w?: Who) => (w?.login ? `https://${PUBLIC}` : `http://localhost:${port}`);
  const hdr = (w?: Who): Record<string, string> => ({ origin: origin(w), ...(w ? { cookie: w.cookie, "x-csrf-token": w.csrf } : {}), ...(w?.login ? { "x-test-identity": w.login } : {}) });
  const post = (w: Who | undefined, path: string, body: unknown = {}) => http(port, "POST", path, { body, headers: hdr(w), host: host(w) });

  let owner: Who = { cookie: "", csrf: "", userId: "" };
  let ownerUserId = "";
  if (o.claim !== false) {
  // claim the owner on the PC
  const { code } = app.stack.auth.issueOwnerCode();
  const begin = (await post(undefined, "/api/claim/begin", { code })).json();
  const fin = await post(undefined, "/api/claim/finish", { claimId: begin.claimId, login: "owner@example.com", displayName: "Olive", password: "an owner password long", totpCode: totpAt(begin.totp.secret, totpStep(clock.t)) });
  if (fin.status !== 200) throw new Error("claim failed: " + fin.text);
  ownerUserId = Object.entries(app.stack.users.read().users).find(([, u]) => u.role === "owner")![0];
  owner = { cookie: String(fin.headers["set-cookie"]).split(";")[0] as string, csrf: fin.json().csrf, userId: ownerUserId };
  if (o.ownerCaps !== false) {
    app.stack.users.update((d) => {
      (d.users[ownerUserId] as { caps: Caps }).caps = { ...defaultCaps(), presets: ["strata", "claude-sonnet"], tools: [...USER_TOOL_UNIVERSE], maxBots: 8, maxChatsPerDay: 1000 };
    });
  }
  }
  let n = 0;
  const api: TestApp = {
    app,
    port,
    dir,
    audit,
    engine,
    clock,
    owner,
    ownerSecret: "",
    post,
    async addUser(login, caps = {}, role = "user") {
      // step-up for the owner so the invite route accepts the call
      const sec = app.stack.box.open(app.stack.credentials.read().users[ownerUserId]!.password!.totpSealed, ownerUserId);
      clock.t += 31_000;
      app.stack.auth.stepUp(app.stack.sessions.resolve(owner.cookie.split("=")[1] as string, { ip: "x", ua: "t" })!, { totpCode: totpAt(sec, totpStep(clock.t)) }, { identity: { kind: "local" }, host: `localhost:${port}`, ip: "local", ua: "t" });
      const inv = await post(owner, "/api/admin/invites/create", { role, tailscaleLoginPin: login, caps: { ...defaultCaps(), tools: [...USER_TOOL_UNIVERSE], ...caps } });
      if (inv.status !== 200) throw new Error("invite failed: " + inv.text);
      const w: Who = { cookie: "", csrf: "", login, userId: "" };
      const b = (await post(w, "/api/invite/begin", { code: inv.json().code })).json();
      const password = `user password number ${++n}`;
      const f = await post(w, "/api/invite/finish", { token: b.token, code: inv.json().code, displayName: login.split("@")[0], password, totpCode: totpAt(b.totp.secret, totpStep(clock.t)) });
      if (f.status !== 200) throw new Error("accept failed: " + f.text);
      const userId = Object.entries(app.stack.users.read().users).find(([, u]) => u.login === login)![0];
      return { cookie: String(f.headers["set-cookie"]).split(";")[0] as string, csrf: f.json().csrf, login, userId, password, secret: b.totp.secret };
    },
    stream(who, qs, opts = {}) {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { host: host(who), cookie: who.cookie, ...(who.login ? { "x-test-identity": who.login } : {}), ...(opts.lastEventId !== undefined ? { "last-event-id": String(opts.lastEventId) } : {}) };
        const req = request({ host: "127.0.0.1", port, method: "GET", path: `/api/chat/stream?${qs}`, headers, setHost: false }, (res) => {
          let text = `HTTP ${res.statusCode}\n`;
          const done = (): void => {
            res.destroy();
            resolve(text);
          };
          const t = setTimeout(done, opts.timeoutMs ?? 4000);
          res.on("data", (c: Buffer) => {
            text += c.toString("utf8");
            if (opts.until?.test(text)) {
              clearTimeout(t);
              done();
            }
          });
          res.on("end", () => {
            clearTimeout(t);
            resolve(text);
          });
          res.on("error", () => resolve(text));
        });
        req.on("error", reject);
        req.end();
      });
    },
    close: () => app.close(),
  };
  return api;
}

export const BOT = { name: "Helper", tagline: "hi", preset: "strata", persona: "You love tea.", tools: ["tool_search", "read_file", "write_file", "remember"], memory: true, starters: ["Hello"] };
