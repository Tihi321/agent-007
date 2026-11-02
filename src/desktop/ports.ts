/**
 * Port probe for the desktop launcher: is a TCP port free, held by an agent-007 gateway, or held by something else.
 * No electron import. The gateway is recognised by its fixed security headers (src/web/http.ts SECURITY_HEADERS).
 */
import { request } from "node:http";
import { createServer, connect } from "node:net";

export type PortState = "free" | "agent007" | "other";

function canConnect(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** True when the response headers carry the gateway's distinctive combination. */
export function looksLikeGateway(h: Record<string, string | string[] | undefined>): boolean {
  const csp = String(h["content-security-policy"] ?? "");
  return (
    csp.includes("form-action 'none'") &&
    csp.includes("frame-ancestors 'none'") &&
    h["permissions-policy"] === "camera=(), microphone=(), geolocation=()" &&
    h["cross-origin-resource-policy"] === "same-origin" &&
    h["x-frame-options"] === "DENY"
  );
}

function fetchHeaders(port: number, host: string, timeoutMs: number): Promise<Record<string, string | string[] | undefined> | null> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.headers);
      req.destroy();
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

export async function probePort(port: number, host = "127.0.0.1", timeoutMs = 2000): Promise<PortState> {
  if (!(await canConnect(port, host, timeoutMs))) return "free";
  const headers = await fetchHeaders(port, host, timeoutMs);
  return headers && looksLikeGateway(headers) ? "agent007" : "other";
}

/** Asks the OS for a free loopback port (bind to 0, read it, close). */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}
