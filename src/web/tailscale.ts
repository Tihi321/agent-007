/**
 * Tailscale facts the gateway checks (S29 serve status, S30 identity). Nothing here runs `tailscale`: callers inject a function that
 * returns the JSON text, so tests use fakes and the real one is a thin `execFile` wrapper in the CLI.
 */

export const GATEWAY_PORT = 47009;
export const FORBIDDEN_PORTS: readonly number[] = [47007, 47008];

export interface ServeInspection {
  ok: boolean;
  /** Fixed sentences; never the status text itself. */
  problems: string[];
  /** The `host:port` names serve answers for (the Host header values to accept). */
  hosts: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The proxy target is exactly the gateway on loopback (`http://127.0.0.1:47009` or `localhost`, any path suffix). */
export function isGatewayTarget(target: string, port = GATEWAY_PORT): boolean {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && Number(u.port) === port && u.username === "" && u.password === "";
}

/**
 * Reads `tailscale serve status --json` (I48). Refuses when: the text is not the expected JSON, any Funnel entry is on, any handler is
 * not a proxy to the gateway (a file share, text, or another port, 47008 and 47007 included), or any raw TCP forward exists.
 * An empty status (nothing served yet) is fine.
 */
export function inspectServeStatus(json: string | undefined, port = GATEWAY_PORT): ServeInspection {
  const problems: string[] = [];
  const hosts: string[] = [];
  if (json === undefined) return { ok: false, problems: ["tailscale serve status could not be read"], hosts };
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, problems: ["tailscale serve status is not valid JSON"], hosts };
  }
  if (!isObj(doc)) return { ok: false, problems: ["tailscale serve status has an unexpected shape"], hosts };
  const funnel = doc["AllowFunnel"];
  if (funnel !== undefined) {
    if (!isObj(funnel)) problems.push("AllowFunnel has an unexpected shape");
    else if (Object.values(funnel).some((v) => v === true)) problems.push("a Funnel entry is on (Funnel is never allowed)");
  }
  const tcp = doc["TCP"];
  if (isObj(tcp)) {
    for (const v of Object.values(tcp)) if (isObj(v) && typeof v["TCPForward"] === "string") problems.push("a raw TCP forward is configured");
  }
  const web = doc["Web"];
  if (web !== undefined) {
    if (!isObj(web)) problems.push("Web has an unexpected shape");
    else {
      for (const [host, cfg] of Object.entries(web)) {
        hosts.push(host);
        const handlers = isObj(cfg) ? cfg["Handlers"] : undefined;
        if (!isObj(handlers)) {
          problems.push("a Web entry has no handlers object");
          continue;
        }
        for (const h of Object.values(handlers)) {
          const proxy = isObj(h) ? h["Proxy"] : undefined;
          if (typeof proxy !== "string") problems.push("a serve handler is not a proxy (file or text handlers are not allowed)");
          else if (!isGatewayTarget(proxy, port)) problems.push(`a serve handler targets something other than the gateway on port ${port}`);
        }
      }
    }
  }
  const foreign = doc["Foreground"];
  if (isObj(foreign) && Object.keys(foreign).length > 0) problems.push("a foreground serve session exists; use the background form only");
  return { ok: problems.length === 0, problems, hosts };
}

// ---- S30: identity (I49) -----------------------------------------------------------------------------------------------

import type { IncomingMessage } from "node:http";
import type { IdentityResult } from "./server.js";

export interface WhoisResult {
  login: string;
  displayName?: string;
  /** A tagged node has no user identity; its traffic never gets a trusted login. */
  tagged: boolean;
  addresses: string[];
}

/** `tailscale whois --json <ip>`: `{ Node: { Addresses, Tags }, UserProfile: { LoginName, DisplayName } }`. Undefined for anything else. */
export function parseWhoisJson(text: string): WhoisResult | undefined {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObj(d) || !isObj(d["Node"]) || !isObj(d["UserProfile"])) return undefined;
  const login = d["UserProfile"]["LoginName"];
  if (typeof login !== "string" || login === "") return undefined;
  const tags = d["Node"]["Tags"];
  const addrs = d["Node"]["Addresses"];
  const out: WhoisResult = {
    login,
    tagged: Array.isArray(tags) && tags.length > 0,
    addresses: Array.isArray(addrs) ? addrs.filter((a): a is string => typeof a === "string").map((a) => a.replace(/\/\d+$/, "")) : [],
  };
  const dn = d["UserProfile"]["DisplayName"];
  if (typeof dn === "string") out.displayName = dn;
  return out;
}

export type WhoisFn = (ip: string) => Promise<WhoisResult | undefined>;

/** The real whois: runs `tailscale whois --json <ip>` through an injected exec (the CLI wrapper), so tests use a fake. */
export function cliWhois(exec: (args: string[]) => Promise<string | undefined>): WhoisFn {
  return async (ip) => {
    if (!isTailnetIp(ip)) return undefined;
    const out = await exec(["whois", "--json", ip]);
    return out === undefined ? undefined : parseWhoisJson(out);
  };
}

/** 100.64.0.0/10 (CGNAT range Tailscale uses) or fd7a:115c:a1e0::/48. */
export function isTailnetIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 100 && b >= 64 && b <= 127 && [3, 4].every((i) => Number(v4[i]) <= 255);
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** `1.78.1` -> [1,78,1]. Undefined when it is not a version. */
export function parseVersion(text: string): number[] | undefined {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** Fail closed: an unreadable version is "not met" (risk 13, pin a minimum Tailscale version). */
export function meetsMinVersion(versionText: string | undefined, min: string): boolean {
  const v = versionText === undefined ? undefined : parseVersion(versionText);
  const m = parseVersion(min);
  if (!v || !m) return false;
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (m[i] ?? 0)) return true;
    if ((v[i] ?? 0) < (m[i] ?? 0)) return false;
  }
  return true;
}

export const MIN_TAILSCALE_VERSION = "1.60.0";

const h1 = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export interface IdentityVerifierOptions {
  /** The gateway's bound port (for the local Host check). */
  port: number;
  /** Public host names serve answers for. */
  publicHosts: string[];
  whois: WhoisFn;
}

/**
 * I49: `Tailscale-User-*` is trusted only when ALL of these hold: the TCP peer is loopback; the request has the shape `tailscale serve`
 * produces (`X-Forwarded-For` with a tailnet address, `X-Forwarded-Proto: https`, `X-Forwarded-Host` one of ours); no Funnel marker; and
 * `whois` for the forwarded address agrees with the header (same login, not a tagged node). A request with no Tailscale header is a
 * LOCAL identity only when it came straight to the loopback Host without any forwarding header. Everything else is refused.
 * Residual (T3): another process on the PC can build the whole shape; the app login is still required.
 */
export function makeIdentityVerifier(o: IdentityVerifierOptions): (req: IncomingMessage) => Promise<IdentityResult> {
  const publicHosts = o.publicHosts.map((p) => p.toLowerCase());
  return async (req) => {
    const peer = req.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) return { ok: false, reason: "peer is not loopback" };
    if (h1(req, "tailscale-funnel-request") !== undefined) return { ok: false, reason: "funnel request" };
    const login = h1(req, "tailscale-user-login");
    const fwdFor = h1(req, "x-forwarded-for");
    const fwdProto = h1(req, "x-forwarded-proto");
    const fwdHost = h1(req, "x-forwarded-host");
    const host = (h1(req, "host") ?? "").toLowerCase();
    const anyForward = fwdFor !== undefined || fwdProto !== undefined || fwdHost !== undefined || h1(req, "forwarded") !== undefined;
    if (login === undefined) {
      if (anyForward) return { ok: false, reason: "forwarded without identity (tagged device or funnel)" };
      if (host === `127.0.0.1:${o.port}` || host === `localhost:${o.port}`) return { ok: true, identity: { kind: "local" } };
      return { ok: false, reason: "no identity on a public host" };
    }
    if (fwdFor === undefined || fwdProto !== "https" || fwdHost === undefined) return { ok: false, reason: "identity header without the serve shape" };
    const fh = fwdHost.toLowerCase();
    if (!publicHosts.some((p) => fh === p || fh === `${p}:443`)) return { ok: false, reason: "forwarded host is not ours" };
    const client = fwdFor.split(",")[0]?.trim() ?? "";
    if (!isTailnetIp(client)) return { ok: false, reason: "forwarded address is not a tailnet address" };
    let who: WhoisResult | undefined;
    try {
      who = await o.whois(client);
    } catch {
      who = undefined;
    }
    if (!who) return { ok: false, reason: "whois failed" };
    if (who.tagged) return { ok: false, reason: "tagged device" };
    if (who.login.toLowerCase() !== login.toLowerCase()) return { ok: false, reason: "whois disagrees with the header" };
    if (who.addresses.length > 0 && !who.addresses.includes(client)) return { ok: false, reason: "whois address mismatch" };
    const name = h1(req, "tailscale-user-name");
    return { ok: true, identity: { kind: "tailscale", login: who.login, ...(name !== undefined ? { name } : {}) } };
  };
}

// ---- S30: the text the setup script prints, kept here so tests can compare it with the script ------------------------------

export const SERVE_COMMAND = (port = GATEWAY_PORT): string => `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
export const SERVE_REMOVE_COMMAND = "tailscale serve --https=443 off";

export function aclSnippet(opts: { group?: string; tag?: string; members?: string[] } = {}): string {
  const group = opts.group ?? "group:agent007-users";
  const tag = opts.tag ?? "tag:agent007-host";
  return JSON.stringify(
    {
      tagOwners: { [tag]: ["autogroup:admin"] },
      groups: { [group]: opts.members ?? ["EDIT-ME@example.com"] },
      acls: [{ action: "accept", src: [group], dst: [`${tag}:443`] }],
    },
    null,
    2,
  );
}
