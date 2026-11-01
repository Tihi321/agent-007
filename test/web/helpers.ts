/** Helpers for the web gateway tests. Not a test file. */
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json(): any;
}

export interface ReqOpts {
  headers?: Record<string, string>;
  body?: unknown;
  /** Send this raw body instead of JSON. */
  raw?: string;
  host?: string;
}

/** A raw HTTP request to 127.0.0.1:<port>, with full control of Host, Origin and the other headers (fetch forbids some). */
export function http(port: number, method: string, path: string, o: ReqOpts = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (payload !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(payload));
      headers["content-type"] ??= "application/json";
      headers["origin"] ??= `http://127.0.0.1:${port}`;
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function cookieFrom(r: Reply): string {
  const sc = r.headers["set-cookie"];
  const first = Array.isArray(sc) ? sc[0] : sc;
  return (first ?? "").split(";")[0] ?? "";
}
