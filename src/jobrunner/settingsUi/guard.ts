/**
 * The request guard of the settings UI (S18.1, I25c). Every request passes it BEFORE routing, in this order:
 *   1. the peer address is loopback;
 *   2. the `Host` header is exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding: 421, no body);
 *   3. the method is GET, HEAD or POST;
 *   4. `X-Forwarded-*` and `Forwarded` are never read (so they cannot change anything);
 *   5. for POST: `Origin` is present and equals one of the two allowed origins (`Origin: null` is refused),
 *      `Sec-Fetch-Site` is `same-origin` when present, `Content-Type` is `application/json`, and the body is at most 256 KB.
 * The session and the CSRF token are checked by the server after the guard (the login route has no session yet).
 *
 * GET and HEAD never change state: no route reacts to a query string or a path verb.
 */
import type { IncomingMessage } from "node:http";

export const BODY_LIMIT = 256 * 1024;

export type GuardResult = { ok: true } | { ok: false; status: number; reason: string };

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

function one(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

export function checkRequest(req: IncomingMessage, port: number): GuardResult {
  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_PEERS.has(peer)) return { ok: false, status: 403, reason: "peer is not loopback" };
  const host = (one(req.headers["host"]) ?? "").toLowerCase();
  if (!allowedHosts(port).includes(host)) return { ok: false, status: 421, reason: "host not allowed" };
  const method = req.method ?? "";
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return { ok: false, status: 405, reason: "method not allowed" };
  if (method === "POST") {
    const origin = one(req.headers["origin"]);
    if (origin === undefined || !allowedOrigins(port).includes(origin)) return { ok: false, status: 403, reason: "origin not allowed" };
    const site = one(req.headers["sec-fetch-site"]);
    if (site !== undefined && site !== "same-origin") return { ok: false, status: 403, reason: "cross-site request" };
    const type = (one(req.headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return { ok: false, status: 415, reason: "content type must be application/json" };
    const len = Number(one(req.headers["content-length"]) ?? "0");
    if (Number.isFinite(len) && len > BODY_LIMIT) return { ok: false, status: 413, reason: "body too large" };
  }
  return { ok: true };
}

/** Headers on every response (I25c). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; reason: string };

/** Reads a JSON body of at most `limit` bytes. */
export function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        finish({ ok: false, status: 413, reason: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        finish({ ok: true, value: text === "" ? {} : (JSON.parse(text) as unknown) });
      } catch {
        finish({ ok: false, status: 400, reason: "body is not valid JSON" });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, reason: "request error" }));
  });
}
