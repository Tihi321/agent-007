/**
 * HTTP helpers of the web gateway (S29): security headers, the `__Host-` session cookie, JSON body reading with a hard cap, and the
 * per-request checks that do not need a session (peer, Host, method, Origin, content type).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

export const COOKIE = "__Host-a7web";
export const BODY_LIMIT = 256 * 1024;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

export function sessionCookie(id: string, maxAgeSec: number): string {
  return `${COOKIE}=${id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}
export const clearCookie = (): string => `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function cookieValue(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The per-session CSRF token: derived from the session id with a different domain than the stored hash, so the stored hash does not reveal it. */
export const csrfFor = (sessionId: string): string => createHash("sha256").update(`a7-web:csrf:${sessionId}`).digest("base64url");

export const one = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h);

export const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function send(res: ServerResponse, status: number, body?: string | Buffer, type?: string, extra: Record<string, string | string[]> = {}): void {
  const headers: Record<string, string | number | string[]> = { ...SECURITY_HEADERS, ...extra };
  if (body !== undefined) {
    headers["Content-Type"] = type ?? "text/plain; charset=utf-8";
    headers["Content-Length"] = Buffer.byteLength(body);
  } else headers["Content-Length"] = 0;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string | string[]> = {}): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extra);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; reason: string };

export const BODY_TIMEOUT_MS = 15_000;

export function readJsonBody(req: IncomingMessage, limit = BODY_LIMIT, timeoutMs = BODY_TIMEOUT_MS): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    // a body that drips in slowly cannot hold a connection open (the request timeout is off for SSE)
    const timer = setTimeout(() => {
      finish({ ok: false, status: 408, reason: "body too slow" });
    }, timeoutMs);
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        finish({ ok: false, status: 413, reason: "body too large" });
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
