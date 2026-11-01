/**
 * Rig for the settings UI tests (S18): a REAL listener on 127.0.0.1 with an ephemeral port over temp folders (never the real
 * ProgramData), a shared fake clock, raw `node:http` requests (so a test can forge Host, Origin and the rest), and a sign-in helper.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import type { Logger } from "../../src/contracts.js";
import { LoginStore } from "../../src/jobrunner/settingsUi/auth.js";
import { shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import type { FormRegistry } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { createRoutes } from "../../src/jobrunner/settingsUi/routes.js";
import type { RoutesDeps } from "../../src/jobrunner/settingsUi/routes.js";
import { startSettingsUi } from "../../src/jobrunner/settingsUi/server.js";
import type { RunningSettingsUi } from "../../src/jobrunner/settingsUi/server.js";
import { createSettingsAudit } from "../../src/settings/audit.js";
import type { SettingsAuditWriter } from "../../src/settings/audit.js";
import type { SettingsAudit } from "../../src/settings/contracts.js";
import { splitConfig } from "../../src/settings/split.js";
import { ROOT, ENV, phase1Config, phase2Config, tempDir, writeJson } from "../settings/helpers.js";

export { ROOT };

export interface MemLogger extends Logger {
  lines: { level: string; event: string; fields: object | undefined }[];
}

export function memLogger(): MemLogger {
  const lines: MemLogger["lines"] = [];
  const add = (level: string) => (event: string, fields?: object) => void lines.push({ level, event, fields });
  return { lines, debug: add("debug"), info: add("info"), warn: add("warn"), error: add("error") };
}

export interface UiRig {
  dir: string;
  notes: string;
  port: number;
  ui: RunningSettingsUi;
  loginStore: LoginStore;
  clock: { t: number };
  audit: SettingsAuditWriter;
  logger: MemLogger;
  paths: { securityFile: string; settingsDir: string; personasDir: string; auditDir: string; templatesDir: string; jobrunnerFile: string };
  forms: FormRegistry;
  routeKeys: string[];
  reloaded: { n: number };
  cleanup(): Promise<void>;
}

export interface RigOptions {
  forms?: FormRegistry;
  audit?: SettingsAudit;
  replaceFs?: RoutesDeps["replaceFs"];
  folderGrant?: RoutesDeps["folderGrant"];
  fsProbe?: RoutesDeps["fsProbe"];
  sessionIdleMin?: number;
  sessionMaxHours?: number;
  /** Phase 2 shaped config (MCP servers, macros) instead of Phase 1. */
  phase2?: boolean;
  noSecurity?: boolean;
}

export async function startRig(o: RigOptions = {}): Promise<UiRig> {
  const dir = tempDir("a7-ui-");
  const notes = join(dir, "notes");
  mkdirSync(notes, { recursive: true });
  const settingsDir = join(dir, "pd", "settings");
  const paths = {
    securityFile: join(settingsDir, "security.json"),
    settingsDir,
    personasDir: join(settingsDir, "personas"),
    auditDir: join(settingsDir, "audit"),
    templatesDir: join(dir, "pd", "jobrunner", "templates"),
    jobrunnerFile: join(dir, "pd", "jobrunner", "jobrunner.json"),
  };
  for (const d of [paths.personasDir, paths.auditDir, paths.templatesDir]) mkdirSync(d, { recursive: true });
  if (!o.noSecurity) {
    const cfg = o.phase2 ? phase2Config(notes) : phase1Config(notes);
    cfg["paths"] = { programDataDir: join(dir, "pd"), dataDir: join(dir, "data") };
    writeJson(paths.securityFile, splitConfig(cfg, settingsDir).security);
  }
  copyFileSync(join(ROOT, "config", "templates", "list-runs.json"), join(paths.templatesDir, "list-runs.json"));
  writeJson(paths.jobrunnerFile, { _comment: "kept", ipcPort: 47007, limits: { dailyJobCap: 20, dailyCreditCap: 0 } });

  const clock = { t: Date.now() };
  const audit = createSettingsAudit({ dir: paths.auditDir, writer: "jobrunner", now: () => new Date(clock.t) });
  const forms = o.forms ?? shippedForms();
  const reloaded = { n: 0 };
  const routes = createRoutes({
    paths,
    audit: o.audit ?? audit,
    forms,
    flowServerId: "flow-music-mcp",
    hubServices: () => ["vibetts", "comfy"],
    env: ENV,
    agentUser: "agent007",
    reloadTemplates: () => void reloaded.n++,
    folderGrant: o.folderGrant ?? (() => "granted"),
    ...(o.fsProbe ? { fsProbe: o.fsProbe } : {}),
    ...(o.replaceFs ? { replaceFs: o.replaceFs } : {}),
    sleep: async () => undefined,
  });
  const loginStore = new LoginStore(join(dir, "data", "settings-login.json"), () => clock.t);
  const logger = memLogger();
  const ui = await startSettingsUi({
    host: "127.0.0.1",
    port: 0,
    ipcPort: 47007,
    sessionIdleMin: o.sessionIdleMin ?? 30,
    sessionMaxHours: o.sessionMaxHours ?? 8,
    routes,
    loginStore,
    logger,
    assetsDir: join(ROOT, "ui", "settings"),
    now: () => clock.t,
  });
  return {
    dir,
    notes,
    port: ui.port,
    ui,
    loginStore,
    clock,
    audit,
    logger,
    paths,
    forms,
    routeKeys: Object.keys(routes),
    reloaded,
    async cleanup() {
      await ui.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => Record<string, unknown>;
}

export interface ReqOptions {
  headers?: Record<string, string | undefined>;
  /** An object is sent as JSON, a string as is. */
  body?: unknown;
  /** Do not add the default Host, Origin and Content-Type headers. */
  bare?: boolean;
}

export function request(rig: Pick<UiRig, "port">, method: string, path: string, o: ReqOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const base: Record<string, string> = o.bare ? {} : { Host: `127.0.0.1:${rig.port}` };
    if (!o.bare && method === "POST") {
      base["Origin"] = `http://127.0.0.1:${rig.port}`;
      base["Content-Type"] = "application/json";
    }
    const headers: Record<string, string> = { ...base };
    for (const [k, v] of Object.entries(o.headers ?? {})) {
      const existing = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
      if (existing) delete headers[existing];
      if (v !== undefined) headers[k] = v;
    }
    if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const req = httpRequest({ host: "127.0.0.1", port: rig.port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface Session {
  cookie: string;
  csrf: string;
  get(path: string, headers?: Record<string, string | undefined>): Promise<Reply>;
  post(path: string, body?: unknown, headers?: Record<string, string | undefined>): Promise<Reply>;
}

export function sessionOf(rig: Pick<UiRig, "port">, cookie: string, csrf: string): Session {
  return {
    cookie,
    csrf,
    get: (path, headers) => request(rig, "GET", path, { headers: { Cookie: cookie, ...(headers ?? {}) } }),
    post: (path, body, headers) => request(rig, "POST", path, { body: body ?? {}, headers: { Cookie: cookie, "X-CSRF-Token": csrf, ...(headers ?? {}) } }),
  };
}

/** Issues a one-time code and signs in with it, like the page does. */
export async function signIn(rig: UiRig): Promise<Session> {
  const { code } = rig.loginStore.issue();
  const r = await request(rig, "POST", "/api/login", { body: { code } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  const raw = r.headers["set-cookie"]?.[0] ?? "";
  return sessionOf(rig, raw.split(";")[0] as string, String(r.json()["csrf"]));
}

export function readSecurity(rig: UiRig): { doc: Record<string, any>; text: string } {
  const text = readFileSync(rig.paths.securityFile, "utf8");
  return { doc: JSON.parse(text) as Record<string, any>, text };
}

export function writeText(file: string, text: string): void {
  writeFileSync(file, text);
}
