/**
 * The web gateway server (S29, I47, I48, I55). One `node:http` listener on 127.0.0.1 (never any other address), behind `tailscale serve`.
 *
 * Request order: peer is loopback -> Host is one of ours -> method -> identity (Tailscale headers trusted only through the injected
 * verifier, I49; unknown login = generic 403) -> rate limit -> static asset or API. For the API: a route is `public`, `session` or
 * `owner`; a session route resolves exactly one user from the cookie (I47), a POST with a session needs the CSRF header, an owner route
 * needs the owner role, and a `stepUp` route needs a passkey or TOTP confirmation under 5 minutes old (I56). Every response carries the
 * security headers. Nothing here knows about chat, bots or users: the routes are supplied by `api.ts`.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { safeEqual } from "./crypto.js";
import type { WebAudit } from "./audit.js";
import { COOKIE, LOOPBACK_PEERS, clearCookie, cookieValue, csrfFor, one, readJsonBody, send, sendJson } from "./http.js";
import { TokenBuckets } from "./ratelimit.js";
import type { Role } from "./schemas.js";
import { FORBIDDEN_PORTS, inspectServeStatus } from "./tailscale.js";
import { WebStoreError } from "./store.js";

export type Identity = { kind: "tailscale"; login: string; name?: string } | { kind: "local" };
export type IdentityResult = { ok: true; identity: Identity } | { ok: false; reason: string };

export interface AuthedSession {
  userId: string;
  role: Role;
  login: string;
  idHash: string;
  csrf: string;
  stepUpAt: number;
}

export interface SessionResolver {
  /** The live session for a cookie value, or undefined. Must be a pure lookup of ONE session (I47). */
  resolve(cookie: string, ctx: { ip: string; ua: string }): AuthedSession | undefined;
}

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  identity: Identity;
  session: AuthedSession | undefined;
  ip: string;
  ua: string;
  /** Reserve an SSE slot for the session user; undefined when the per-user cap is reached. Call the result when the stream ends. */
  openStream(): (() => void) | undefined;
}

export type RouteResult = { status: number; body: unknown; headers?: Record<string, string | string[]> } | { handled: true };

export interface RouteDef {
  /** `admin` = owner or admin role. */
  auth: "public" | "session" | "admin" | "owner";
  /** Needs a passkey or TOTP confirmation under 5 minutes old (I56). */
  stepUp?: boolean;
  /** The handler writes the response itself (SSE). */
  stream?: boolean;
  handler(ctx: RouteCtx): Promise<RouteResult>;
}

export const STEP_UP_MAX_AGE_MS = 5 * 60_000;

export interface GatewayOptions {
  host: string;
  port: number;
  /** Public host names that may appear in `Host` (the ts.net name). Loopback names are always allowed. */
  publicHosts: string[];
  routes: Record<string, RouteDef>;
  audit: WebAudit;
  sessions: SessionResolver;
  /** I49: turns a request into an identity, or refuses it. */
  identify(req: IncomingMessage, ctx: { port: number }): Promise<IdentityResult>;
  /** Does a verified Tailscale login map to a user or a pending invite? false = generic 403. Not called for local identities. */
  admit?(identity: Identity): boolean;
  assets?: Map<string, { body: string | Buffer; type: string }>;
  now?: () => number;
  maxStreamsPerUser?: number;
  /** A POST body must arrive within this time (default 15 s). */
  bodyTimeoutMs?: number;
  /** Token bucket per client (capacity, per second). */
  rate?: { capacity: number; perSec: number };
  /** True while the owner kill switch or a lockdown is on: every API route except the public state answers 503 and no session resolves. */
  lockedDown?(): boolean;
  /** Called when something other than the normal flow happens (for tests and the Telegram notifier). */
  onEvent?(e: { kind: string; detail?: string }): void;
}

export class GatewayStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayStartError";
  }
}

export interface StartChecks {
  /** `local`: loopback only, no tailnet needed (L1). `tailnet`: serve and Funnel are checked and must be clean. */
  mode: "local" | "tailnet";
  /** Each returns normally if the store/file loads, else throws. A throw = the gateway does not listen (I55). */
  loadStores: () => void;
  /** Text of `tailscale serve status --json`; undefined when the CLI is missing or fails. Only used in tailnet mode. */
  serveStatus?: () => Promise<string | undefined> | string | undefined;
  /** Clock skew in ms against a trusted reference (undefined = unknown). Tailnet mode refuses above 5 minutes. */
  clockSkewMs?: () => Promise<number | undefined> | number | undefined;
}

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Throws `GatewayStartError` with a fixed sentence when anything is missing, corrupt or unsafe (I48, I55). Also audits it. */
export async function checkStartup(o: Pick<GatewayOptions, "host" | "port" | "audit">, c: StartChecks): Promise<{ serveHosts: string[] }> {
  const refuse = (why: string): never => {
    try {
      o.audit.write({ kind: "startup_refused", detail: { reason: why } });
    } catch {
      /* the audit being down must not turn a refusal into a start */
    }
    throw new GatewayStartError(why);
  };
  if (o.host !== "127.0.0.1" && o.host !== "localhost") refuse("the gateway binds to 127.0.0.1 only");
  if (o.port !== 0 && FORBIDDEN_PORTS.includes(o.port)) refuse("the gateway port must not be the job runner or settings UI port");
  try {
    c.loadStores();
  } catch (e) {
    refuse(e instanceof WebStoreError ? `an auth store is unreadable or corrupt (${e.message.split(":")[0]})` : "an auth input is missing or unreadable");
  }
  let serveHosts: string[] = [];
  if (c.mode === "tailnet") {
    let text: string | undefined;
    try {
      text = await c.serveStatus?.();
    } catch {
      text = undefined;
    }
    if (c.serveStatus === undefined) refuse("tailnet mode needs the tailscale serve status check");
    const r = inspectServeStatus(text, o.port === 0 ? undefined : o.port);
    if (!r.ok) refuse(`tailscale serve check failed: ${r.problems.join("; ")}`);
    serveHosts = r.hosts;
    const skew = await c.clockSkewMs?.();
    if (c.clockSkewMs === undefined || skew === undefined) refuse("the clock could not be checked");
    else if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) refuse("the clock is off by more than 5 minutes");
  }
  return { serveHosts };
}

export interface RunningGateway {
  host: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

const GENERIC_403 = "<!doctype html><meta charset=utf-8><title>Not available</title><p>This page is not available.";

export async function startGateway(o: GatewayOptions): Promise<RunningGateway> {
  if (o.host !== "127.0.0.1" && o.host !== "localhost") throw new GatewayStartError("the gateway binds to 127.0.0.1 only");
  const now = o.now ?? Date.now;
  const buckets = new TokenBuckets({ capacity: o.rate?.capacity ?? 60, refillPerSec: o.rate?.perSec ?? 20, now });
  const streams = new Map<string, number>();
  const maxStreams = o.maxStreamsPerUser ?? 3;
  let bound = o.port;

  const hostOk = (host: string): boolean => {
    const h = host.toLowerCase();
    if (h === `127.0.0.1:${bound}` || h === `localhost:${bound}`) return true;
    return o.publicHosts.some((p) => h === p.toLowerCase() || h === `${p.toLowerCase()}:443`);
  };
  const originsOk = (): string[] => [`http://127.0.0.1:${bound}`, `http://localhost:${bound}`, ...o.publicHosts.map((p) => `https://${p.toLowerCase()}`)];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? "")) {
      o.audit.write({ kind: "identity_rejected", detail: { reason: "peer is not loopback" } });
      return send(res, 403, GENERIC_403, "text/html; charset=utf-8");
    }
    if (!hostOk(one(req.headers["host"]) ?? "")) return send(res, 421);
    const method = req.method ?? "";
    if (method !== "GET" && method !== "HEAD" && method !== "POST") return send(res, 405);
    const raw = req.url ?? "/";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return send(res, 400);
    let url: URL;
    try {
      url = new URL(raw, "http://localhost");
    } catch {
      return send(res, 400);
    }
    if (method === "POST") {
      const origin = one(req.headers["origin"]);
      if (origin === undefined || !originsOk().includes(origin.toLowerCase())) {
        req.resume();
        return send(res, 403, JSON.stringify({ error: "origin" }), "application/json; charset=utf-8");
      }
      const site = one(req.headers["sec-fetch-site"]);
      if (site !== undefined && site !== "same-origin") {
        req.resume();
        return send(res, 403, JSON.stringify({ error: "cross_site" }), "application/json; charset=utf-8");
      }
      const type = (one(req.headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        req.resume();
        return send(res, 415);
      }
      if (Number(one(req.headers["content-length"]) ?? "0") > 256 * 1024) {
        req.resume();
        return send(res, 413);
      }
    }

    // ---- identity (I49) ----
    const idr = await o.identify(req, { port: bound });
    if (!idr.ok) {
      o.audit.write({ kind: "identity_rejected", detail: { reason: idr.reason } });
      if (method === "POST") req.resume();
      return send(res, 403, GENERIC_403, "text/html; charset=utf-8");
    }
    const identity = idr.identity;
    if (identity.kind === "tailscale" && o.admit && !o.admit(identity)) {
      o.audit.write({ kind: "identity_rejected", detail: { reason: "unknown login" } });
      if (method === "POST") req.resume();
      return send(res, 403, GENERIC_403, "text/html; charset=utf-8");
    }
    const ip = identity.kind === "tailscale" ? `ts:${identity.login.toLowerCase()}` : "local";
    if (!buckets.take(ip)) {
      if (method === "POST") req.resume();
      return send(res, 429, JSON.stringify({ error: "rate_limited" }), "application/json; charset=utf-8", { "Retry-After": "5" });
    }

    // ---- static ----
    if (!url.pathname.startsWith("/api/")) {
      if (method === "POST") {
        req.resume();
        return send(res, 404);
      }
      const a = o.assets?.get(url.pathname) ?? (url.pathname.includes(".") ? undefined : o.assets?.get("/"));
      if (!a) return send(res, 404);
      return send(res, 200, method === "HEAD" ? undefined : a.body, a.type);
    }

    // ---- API ----
    if (method === "HEAD") return send(res, 405);
    if (o.lockedDown?.() === true && !(method === "GET" && url.pathname === "/api/state")) {
      if (method === "POST") req.resume();
      return sendJson(res, 503, { error: "lockdown", message: "The web access is switched off by the owner." });
    }
    const route = o.routes[`${method} ${url.pathname}`];
    if (!route) {
      if (method === "POST") req.resume();
      return sendJson(res, 404, { error: "not_found" });
    }
    const ua = one(req.headers["user-agent"]) ?? "";
    let session: AuthedSession | undefined;
    if (route.auth !== "public") {
      const cookie = cookieValue(req.headers["cookie"]);
      session = cookie ? o.sessions.resolve(cookie, { ip, ua }) : undefined;
      if (!session) {
        if (method === "POST") req.resume();
        return sendJson(res, 401, { error: "no_session" });
      }
      // the session belongs to ONE login: a cookie used from another tailnet identity (a stolen cookie) or, from the PC itself, by a non-owner is refused
      if ((identity.kind === "tailscale" && identity.login.toLowerCase() !== session.login.toLowerCase()) || (identity.kind === "local" && session.role !== "owner")) {
        if (method === "POST") req.resume();
        o.audit.write({ kind: "identity_rejected", user: session.userId, detail: { reason: "session does not match the identity" } });
        return sendJson(res, 401, { error: "no_session" });
      }
      if ((route.auth === "owner" && session.role !== "owner") || (route.auth === "admin" && session.role !== "owner" && session.role !== "admin")) {
        if (method === "POST") req.resume();
        o.audit.write({ kind: "tool_denied", user: session.userId, detail: { reason: `${route.auth} route`, route: url.pathname } });
        return sendJson(res, 403, { error: "forbidden" });
      }
      if (method === "POST") {
        const t = one(req.headers["x-csrf-token"]);
        if (typeof t !== "string" || !safeEqual(t, session.csrf)) {
          req.resume();
          return sendJson(res, 403, { error: "csrf" });
        }
      }
      if (route.stepUp && now() - session.stepUpAt > STEP_UP_MAX_AGE_MS) {
        if (method === "POST") req.resume();
        return sendJson(res, 401, { error: "step_up_required" });
      }
    }
    let body: unknown = {};
    if (method === "POST") {
      const b = await readJsonBody(req, undefined, o.bodyTimeoutMs);
      if (!b.ok) {
        // answer, then drop the connection: the rest of a slow or oversized body is not read
        res.once("finish", () => req.destroy());
        return sendJson(res, b.status, { error: "bad_body", message: b.reason }, { Connection: "close" });
      }
      body = b.value;
    }
    const ctx: RouteCtx = {
      req,
      res,
      url,
      body,
      identity,
      session,
      ip,
      ua,
      openStream: () => {
        const id = session?.userId;
        if (!id) return undefined;
        const n = streams.get(id) ?? 0;
        if (n >= maxStreams) return undefined;
        streams.set(id, n + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          streams.set(id, Math.max(0, (streams.get(id) ?? 1) - 1));
        };
      },
    };
    try {
      const r = await route.handler(ctx);
      if ("handled" in r) return;
      sendJson(res, r.status, r.body, r.headers);
    } catch (e) {
      o.onEvent?.({ kind: "route_failed", detail: `${method} ${url.pathname}: ${String((e as Error)?.message ?? e).slice(0, 120)}` });
      if (!res.headersSent) sendJson(res, 500, { error: "error", message: "Something went wrong. Nothing was changed unless the page says so." });
      else res.destroy();
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // SSE streams are long; the headers and the body reader have their own limits
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new GatewayStartError(`port ${o.port} is already in use`) : e));
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  bound = (server.address() as AddressInfo).port;
  return {
    host: "127.0.0.1",
    port: bound,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export { COOKIE, clearCookie, csrfFor };
