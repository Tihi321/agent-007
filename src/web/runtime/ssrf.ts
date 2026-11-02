/**
 * SSRF guard for any outbound fetch a user bot might ever be given (S33, section 5, T6, UI-41). No fetch tool ships (UI-41: none); this
 * guard exists, is tested, and is the only door if an allowlisted fetch is added later. It refuses private, loopback, link-local, CGNAT and
 * tailnet ranges (IPv4 and IPv6, including mapped addresses), numeric host tricks (decimal, hex, octal), credentials in the URL, non-http(s)
 * schemes, `localhost` and internal suffixes, the local model and gateway ports even on an allowed host, and a DNS answer that contains
 * ANY blocked address (rebinding is handled by the caller connecting to the address it was given).
 */
import { isIP } from "node:net";

export const BLOCKED_PORTS: readonly number[] = [1234, 8080, 8787, 47007, 47008, 47009];
/** Blocked ports a custom provider on this PC (a literal loopback URL) may still use: LM Studio (1234), Strata (8080) and the ACP proxy (8787) are model servers. */
export const LOOPBACK_MODEL_PORTS: readonly number[] = [1234, 8080, 8787];

/**
 * True when a loopback custom provider URL points at a blocked port that is not a model server: agent-007's own job runner IPC (47007),
 * settings UI (47008) and web gateway (47009). Those speak agent-007's own protocols and must never receive a model request or a provider key.
 */
export function isBlockedLoopbackPort(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return BLOCKED_PORTS.includes(port) && !LOOPBACK_MODEL_PORTS.includes(port);
}

function v4Parts(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const n = [m[1], m[2], m[3], m[4]].map(Number);
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined;
}

export function isBlockedV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b] = [p[0] as number, p[1] as number];
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, includes the tailnet 100.64.0.0/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The 8 groups of an IPv6 address (with "::" expanded and a trailing dotted quad folded in); undefined when it does not parse. */
function v6Groups(l: string): number[] | undefined {
  let s = l.replace(/%.*$/, "");
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = v4Parts(dotted[2] as string);
    if (!p) return undefined;
    const [a, b, c, d] = p as [number, number, number, number];
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const groups = (x: string): string[] => (x === "" ? [] : x.split(":"));
  const head = groups(halves[0] as string);
  const tail = halves.length === 2 ? groups(halves[1] as string) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + fill + tail.length !== 8 || ![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return [...head.map((g) => parseInt(g, 16)), ...Array<number>(fill).fill(0), ...tail.map((g) => parseInt(g, 16))];
}

export function isBlockedV6(ip: string): boolean {
  const l = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const g = v6Groups(l);
  if (!g) return true; // fail closed on anything that does not parse
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96: unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d
  if (((g[0] as number) & 0xffc0) === 0xfec0) return true; // fec0::/10, the deprecated site-local range
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (mapped) return isBlockedV4(mapped[1] as string);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1] as string, 16);
    const lo = parseInt(hexMapped[2] as string, 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (l === "::" || l === "::1") return true;
  if (/^f[cd]/.test(l)) return true; // unique local, includes the tailnet fd7a:115c:a1e0::/48
  if (/^fe[89ab]/.test(l)) return true; // link local
  if (/^ff/.test(l)) return true; // multicast
  if (/^64:ff9b:/.test(l)) return true; // NAT64
  return false;
}

export const isBlockedAddress = (ip: string): boolean => (isIP(ip) === 6 ? isBlockedV6(ip) : isBlockedV4(ip));

export type Resolver = (host: string) => Promise<string[]>;
export type UrlVerdict = { ok: true; url: URL; addresses: string[] } | { ok: false; reason: string };

/** `allow`: host names (exact, or `*.suffix`) the owner listed; an empty list allows nothing (UI-41). */
export async function checkUrl(input: string, allow: readonly string[], resolver: Resolver): Promise<UrlVerdict> {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "only http and https" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "no credentials in the URL" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".ts.net")) return { ok: false, reason: "a local or internal name" };
  if (u.port !== "" && BLOCKED_PORTS.includes(Number(u.port))) return { ok: false, reason: "a blocked port" };
  if (isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: "a private, loopback or tailnet address" };
  } else if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(host) || /^0[0-7]+\./.test(host)) {
    return { ok: false, reason: "a numeric host that is not a plain address" };
  }
  const listed = allow.some((a) => (a.startsWith("*.") ? host.endsWith(a.slice(1).toLowerCase()) : host === a.toLowerCase()));
  if (!listed) return { ok: false, reason: "the host is not on the allowlist" };
  const addresses = isIP(host) ? [host] : await resolver(host).catch(() => [] as string[]);
  if (addresses.length === 0) return { ok: false, reason: "the name did not resolve" };
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "the name resolves to a private, loopback or tailnet address" };
  return { ok: true, url: u, addresses };
}
