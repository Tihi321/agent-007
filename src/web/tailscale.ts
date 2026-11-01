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
