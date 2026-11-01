/**
 * The settings UI listener (S18.1, I25a to I25c): a SEPARATE `node:http` server hosted by the job runner next to the IPC server, bound to
 * 127.0.0.1 only. There is no LAN, tunnel or Cloudflare mode: a non-loopback host and a port equal to the IPC port are refused.
 *
 * Request order: guard (peer, Host, method, and for POST Origin, Sec-Fetch-Site, Content-Type, body size) -> static file (a fixed
 * map, no path joining) -> API: login needs no session; everything else needs a session cookie, and a POST also the CSRF header.
 * Every response carries the CSP and the other headers of I25c. A GET or HEAD never changes state.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../../contracts.js";
import { LoginLimiter, LoginStore } from "./auth.js";
import { SECURITY_HEADERS, checkRequest, readJsonBody } from "./guard.js";
import { loadAssets } from "./assets.js";
import type { Asset } from "./assets.js";
import type { Route } from "./routes.js";
import { SessionStore, clearCookie, safeEqual, sessionCookie } from "./session.js";

export interface SettingsUiServerOptions {
  /** `127.0.0.1` or `localhost` (both bind 127.0.0.1). Anything else throws. */
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** The IPC port; the UI port must differ. */
  ipcPort: number;
  sessionIdleMin: number;
  sessionMaxHours: number;
  routes: Record<string, Route>;
  loginStore: LoginStore;
  logger: Logger;
  assetsDir?: string;
  now?: () => number;
  /** Test seam: a prebuilt asset map. */
  assets?: Map<string, Asset>;
}

export interface RunningSettingsUi {
  host: string;
  port: number;
  server: Server;
  sessions: SessionStore;
  close(): Promise<void>;
}

export class SettingsUiBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsUiBindError";
  }
}

function send(res: ServerResponse, status: number, body?: string | Buffer, type?: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string | number> = { ...SECURITY_HEADERS, ...extra };
  if (body !== undefined) {
    headers["Content-Type"] = type ?? "text/plain; charset=utf-8";
    headers["Content-Length"] = Buffer.byteLength(body);
  } else headers["Content-Length"] = 0;
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extra);
}

export async function startSettingsUi(o: SettingsUiServerOptions): Promise<RunningSettingsUi> {
  if (o.host !== "127.0.0.1" && o.host !== "localhost") throw new SettingsUiBindError("the settings UI binds to loopback only (127.0.0.1)");
  if (o.port !== 0 && o.port === o.ipcPort) throw new SettingsUiBindError("the settings UI port must differ from the IPC port");
  const assets = o.assets ?? loadAssets(o.assetsDir);
  const now = o.now ?? Date.now;
  const sessions = new SessionStore({ idleMs: o.sessionIdleMin * 60_000, maxAgeMs: o.sessionMaxHours * 3_600_000, now, revokedAt: () => o.loginStore.revokedAt() });
  const limiter = new LoginLimiter(now);
  let boundPort = o.port;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const guard = checkRequest(req, boundPort);
    if (!guard.ok) {
      o.logger.warn("settingsui.refused", { status: guard.status, reason: guard.reason });
      send(res, guard.status);
      req.resume();
      return;
    }
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("\\")) return send(res, 400); // origin-form paths only
    let url: URL;
    try {
      url = new URL(rawUrl, "http://localhost");
    } catch {
      send(res, 400);
      return;
    }
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      if (method === "POST") {
        send(res, 404);
        req.resume();
        return;
      }
      const a = assets.get(path);
      if (!a) return send(res, 404);
      send(res, 200, method === "HEAD" ? undefined : a.body, a.type);
      return;
    }

    // ---- API ----
    if (method === "HEAD") return send(res, 405);
    if (path === "/api/login" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return send(res, body.status);
      const locked = limiter.lockedFor();
      if (locked > 0) return sendJson(res, 429, { error: "locked", message: "Too many failed attempts. Try again in a minute.", retryAfterSec: Math.ceil(locked / 1000) }, { "Retry-After": String(Math.ceil(locked / 1000)) });
      const code = typeof (body.value as { code?: unknown })?.code === "string" ? (body.value as { code: string }).code : "";
      if (code === "" || code.length > 200 || !o.loginStore.consume(code)) {
        limiter.recordFailure();
        o.logger.warn("settingsui.login_failed", {});
        return sendJson(res, 401, { error: "invalid_code", message: "That code is wrong, already used or expired. Run settings-link again." });
      }
      limiter.recordSuccess();
      const s = sessions.create();
      o.logger.info("settingsui.login", { session: s.hash });
      return sendJson(res, 200, { csrf: s.csrf, idleMin: o.sessionIdleMin, maxHours: o.sessionMaxHours }, { "Set-Cookie": sessionCookie(s.id, o.sessionMaxHours * 3600) });
    }

    const session = sessions.fromCookie(req.headers["cookie"]);
    if (!session) {
      if (method === "POST") req.resume();
      return sendJson(res, 401, { error: "no_session", message: "Sign in with the link from settings-link." });
    }
    let parsedBody: unknown = {};
    if (method === "POST") {
      const token = req.headers["x-csrf-token"];
      if (typeof token !== "string" || !safeEqual(token, session.csrf)) {
        req.resume();
        return sendJson(res, 403, { error: "csrf", message: "Missing or wrong CSRF token. Reload the page." });
      }
      const body = await readJsonBody(req);
      if (!body.ok) return sendJson(res, body.status, { error: "bad_body", message: body.reason });
      parsedBody = body.value;
      if (path === "/api/logout") {
        sessions.destroy(session.id);
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
      }
    }
    const route = o.routes[`${method} ${path}`];
    if (!route) return sendJson(res, 404, { error: "not_found", message: "no such route" });
    try {
      const r = await route({ session, body: parsedBody, query: url.searchParams });
      sendJson(res, r.status, r.body);
    } catch (e) {
      o.logger.error("settingsui.route_failed", { route: `${method} ${path}`, error: String((e as Error)?.message ?? e).slice(0, 200) });
      sendJson(res, 500, { error: "error", message: "Something went wrong. Nothing was changed unless the page says so." });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      o.logger.error("settingsui.handler_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new SettingsUiBindError(`the settings UI port ${o.port} is already in use`) : e));
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  boundPort = (server.address() as AddressInfo).port;
  o.logger.info("settingsui.started", { port: boundPort });
  return {
    host: "127.0.0.1",
    port: boundPort,
    server,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        sessions.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
