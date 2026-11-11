/**
 * REQ-0014 egress proxy. A runner-owned loopback CONNECT/HTTP proxy that every Chromium request goes through. It resolves DNS itself,
 * refuses any name that resolves to a blocked address and the project's blocked ports, and connects to the vetted IP (no rebinding).
 * Every request needs a random per-session Basic credential, and only loopback peers are served.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { vetPublicHost, type Resolver } from "../../../web/runtime/ssrf.js";

export interface EgressOptions {
  /** default: dns.promises.lookup(host, {all:true}) */
  resolver?: Resolver;
  /** TEST SEAM ONLY: hosts (e.g. "127.0.0.1") that skip the address check. Never read from config. */
  testAllowHosts?: readonly string[];
  onRefused?: (host: string, reason: string) => void;
  /** TEST SEAM: opens the upstream connection to a vetted address. Default: net.connect. */
  dial?: (address: string, port: number) => net.Socket | Promise<net.Socket>;
}

export interface EgressProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

const IDLE_MS = 120_000;
const MAX_SOCKETS = 256;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
const defaultDial = (address: string, port: number): net.Socket => net.connect({ host: address, port });

/** "host:port" or "[v6]:port" of a CONNECT target. */
function splitHostPort(target: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(target);
  if (!m) return undefined;
  return { host: (m[1] ?? m[2]) as string, port: Number(m[3]) };
}

export async function startEgressProxy(o: EgressOptions = {}): Promise<EgressProxy> {
  const resolver = o.resolver ?? defaultResolver;
  const dial = o.dial ?? defaultDial;
  const allow = new Set((o.testAllowHosts ?? []).map((h) => h.toLowerCase()));
  const username = "a7";
  const password = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const sockets = new Set<net.Socket>();

  const authorized = (header: string | undefined): boolean => {
    const got = Buffer.from(header ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const vet = async (host: string, port: number): Promise<{ ok: true; address: string } | { ok: false; reason: string }> => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (allow.has(h)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "not a valid port" };
      return { ok: true, address: h };
    }
    const v = await vetPublicHost(h, port, resolver);
    if (!v.ok) return v;
    return { ok: true, address: v.addresses[0] as string };
  };

  const refuse = (host: string, reason: string): void => {
    try {
      o.onRefused?.(host, reason);
    } catch {
      /* a callback must not break the proxy */
    }
  };

  const track = (s: net.Socket): void => {
    sockets.add(s);
    s.setTimeout(IDLE_MS, () => s.destroy());
    s.on("error", () => s.destroy());
    s.on("close", () => sockets.delete(s));
  };

  const reply = (s: net.Socket, code: number, text: string, extra = ""): void => {
    const body = `${text}\n`;
    s.end(`HTTP/1.1 ${code} ${text}\r\n${extra}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  };

  const server = http.createServer();
  server.maxHeadersCount = 100;

  server.on("connection", (s) => {
    const peer = s.remoteAddress ?? "";
    if (!(peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") || sockets.size >= MAX_SOCKETS) {
      s.destroy();
      return;
    }
    track(s);
  });

  server.on("connect", (req, client: net.Socket, head: Buffer) => {
    void (async () => {
      if (!authorized(req.headers["proxy-authorization"])) return reply(client, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="agent-007"\r\n');
      const target = splitHostPort(req.url ?? "");
      if (!target) return reply(client, 400, "Bad Request");
      const v = await vet(target.host, target.port);
      if (!v.ok) {
        refuse(target.host, v.reason);
        return reply(client, 403, `Forbidden: ${v.reason}`);
      }
      let upstream: net.Socket;
      try {
        upstream = await dial(v.address, target.port);
      } catch {
        return reply(client, 502, "Bad Gateway");
      }
      track(upstream);
      const onUp = (): void => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      };
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
      if (upstream.connecting) upstream.once("connect", onUp);
      else onUp();
    })().catch(() => client.destroy());
  });

  server.on("request", (req, res) => {
    void (async () => {
      const fail = (code: number, text: string, extra: http.OutgoingHttpHeaders = {}): void => {
        res.writeHead(code, { "Content-Type": "text/plain", Connection: "close", ...extra });
        res.end(`${text}\n`);
      };
      if (!authorized(req.headers["proxy-authorization"])) return fail(407, "Proxy Authentication Required", { "Proxy-Authenticate": 'Basic realm="agent-007"' });
      let u: URL;
      try {
        u = new URL(req.url ?? "");
      } catch {
        return fail(400, "Bad Request");
      }
      if (u.protocol !== "http:" && u.protocol !== "ws:") return fail(400, "Bad Request");
      const port = u.port !== "" ? Number(u.port) : 80;
      const v = await vet(u.hostname, port);
      if (!v.ok) {
        refuse(u.hostname, v.reason);
        return fail(403, `Forbidden: ${v.reason}`);
      }
      const headers = { ...req.headers };
      for (const k of Object.keys(headers)) if (k.startsWith("proxy-") || k === "connection" || k === "keep-alive") delete headers[k];
      headers.connection = "close";
      const reqOpts: http.RequestOptions = {
        method: req.method,
        path: `${u.pathname}${u.search}`,
        headers,
        // No agent: Node then calls createConnection directly, and its callback form lets the dial be async.
        createConnection: (_opts: unknown, cb: (err: Error | null, s: net.Socket) => void) => {
          Promise.resolve(dial(v.address, port)).then(
            (s) => {
              track(s);
              cb(null, s);
            },
            (e: Error) => cb(e, undefined as unknown as net.Socket),
          );
          return undefined;
        },
      };
      const out = http.request(reqOpts, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on("error", () => {
        if (!res.headersSent) fail(502, "Bad Gateway");
        else res.destroy();
      });
      req.pipe(out);
    })().catch(() => res.destroy());
  });

  // WebSocket upgrades arrive as absolute-form requests with `Upgrade`; Chromium sends wss through CONNECT, ws as an upgrade request.
  server.on("upgrade", (req, client: net.Socket, head: Buffer) => {
    void (async () => {
      if (!authorized(req.headers["proxy-authorization"])) return reply(client, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="agent-007"\r\n');
      let u: URL;
      try {
        u = new URL(req.url ?? "");
      } catch {
        return reply(client, 400, "Bad Request");
      }
      if (u.protocol !== "http:" && u.protocol !== "ws:") return reply(client, 400, "Bad Request");
      const port = u.port !== "" ? Number(u.port) : 80;
      const v = await vet(u.hostname, port);
      if (!v.ok) {
        refuse(u.hostname, v.reason);
        return reply(client, 403, `Forbidden: ${v.reason}`);
      }
      let upstream: net.Socket;
      try {
        upstream = await dial(v.address, port);
      } catch {
        return reply(client, 502, "Bad Gateway");
      }
      track(upstream);
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i] as string;
        if (k.toLowerCase().startsWith("proxy-")) continue;
        lines.push(`${k}: ${req.rawHeaders[i + 1] as string}`);
      }
      const send = (): void => {
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      };
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
      if (upstream.connecting) upstream.once("connect", send);
      else send();
    })().catch(() => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as net.AddressInfo;
  return {
    server: `http://127.0.0.1:${addr.port}`,
    username,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
