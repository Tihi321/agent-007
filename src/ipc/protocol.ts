/**
 * The agent <-> job runner wire protocol (I16, S9.3): newline-delimited JSON over TCP on 127.0.0.1, one signed message
 * per line. It is NOT HTTP; an HTTP-shaped request (a browser or a DNS-rebinding page) is rejected and the connection is
 * closed without a reply body.
 *
 *   {"v":1,"id":"...","ts":1730000000000,"nonce":"...","type":"submit","body":{...},"mac":"<64 hex>"}
 *
 * The MAC is HMAC-SHA256 over `v|id|ts|nonce|type|sha256(body)` (see ./hmac.ts). A receiver rejects, in this order:
 *   oversize (a line over 1 MiB), http_shaped, malformed (not the exact field set), unsupported_version, bad_type
 *   (unknown, or not allowed in that direction), stale (`ts` off by more than 60 s), bad_mac, replay (the nonce was seen
 *   within 5 minutes). Any rejection closes the connection and logs one `warn` line with the reason and no content.
 *
 * U40 (settled, S9.3): Node's `net` cannot give a Windows named pipe a custom DACL. For IPC servers `listen()` takes
 * `path`, `readableAll` and `writableAll` only (the `ListenOptions` of @types/node 24.19.2 list no security descriptor
 * option), so a pipe cannot be restricted to the agent user and the main user without a native addon, and none is
 * installed. That is why I16 uses loopback TCP plus a per-message HMAC with a key held in two ACL-protected secrets
 * files. (Checked in the installed @types/node; the Node and libuv docs were not re-fetched, there is no network here.)
 */
import type {
  CancelBody,
  CancelReply,
  FlowEstimateBody,
  FlowEstimateReply,
  HubStartBody,
  HubStartReply,
  HubStatusBody,
  HubStatusReply,
  JobDone,
  JobEvent,
  Json,
  JsonObject,
  ListTemplatesBody,
  ListTemplatesReply,
  PermissionDecision,
  PermissionHelperReply,
  PermissionHelperRequest,
  PermissionRequest,
  StatusBody,
  StatusReply,
  SubmitBody,
  SubmitReply,
} from "../jobs/contracts.js";
import { bodyHash, computeMac, randomToken, signingString, verifyMac } from "./hmac.js";
import type { IpcKey, KeyCandidate, SignedFields } from "./hmac.js";

export const IPC_VERSION = 1;
/** A line (one message) over this many bytes is rejected. */
export const MAX_LINE_BYTES = 1_048_576;
/** `ts` may be off by this much either way. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** A nonce is remembered this long. */
export const NONCE_TTL_MS = 300_000;
export const MAX_NONCES = 100_000;
/** The only host the job runner binds and the agent connects to. */
export const IPC_HOST = "127.0.0.1";

// ---- message types ---------------------------------------------------------------------------------

/** Agent to runner, answered by a `reply`. */
export const REQUEST_TYPES = ["submit", "cancel", "status", "list_templates", "hub_status", "hub_start", "flow_estimate"] as const;
/** Pushes and decisions: `job_event`, `permission_request` and `job_done` go runner to agent; `permission_decision` agent to runner. */
export const EVENT_TYPES = ["job_event", "permission_request", "permission_decision", "job_done"] as const;
export const REPLY_TYPE = "reply" as const;
export const MESSAGE_TYPES = [...REQUEST_TYPES, ...EVENT_TYPES, REPLY_TYPE] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** What the job runner accepts. `permission_request` here is the permission helper's (per-job key, I28). */
export const SERVER_ACCEPTS: ReadonlySet<string> = new Set<string>([...REQUEST_TYPES, "permission_request", "permission_decision"]);
/** The types the job runner answers with a `reply`. */
export const SERVER_REPLIES_TO: ReadonlySet<string> = new Set<string>([...REQUEST_TYPES, "permission_request"]);
/** What the agent accepts. */
export const CLIENT_ACCEPTS: ReadonlySet<string> = new Set<string>([REPLY_TYPE, "job_event", "permission_request", "job_done"]);

/** Request body and reply data per request type. */
export interface RequestMap {
  submit: { body: SubmitBody; reply: SubmitReply };
  cancel: { body: CancelBody; reply: CancelReply };
  status: { body: StatusBody; reply: StatusReply };
  list_templates: { body: ListTemplatesBody; reply: ListTemplatesReply };
  hub_status: { body: HubStatusBody; reply: HubStatusReply };
  hub_start: { body: HubStartBody; reply: HubStartReply };
  flow_estimate: { body: FlowEstimateBody; reply: FlowEstimateReply };
}
/** The helper's `permission_request` (to the runner, signed with the per-job token) and its reply. */
export interface HelperRequest {
  body: PermissionHelperRequest;
  reply: PermissionHelperReply;
}
/** Bodies of the messages the runner pushes to the agent, and the agent's decision. */
export interface PushMap {
  job_event: JobEvent;
  permission_request: PermissionRequest;
  job_done: JobDone;
}
export interface DecisionMap {
  permission_decision: PermissionDecision;
}

export type IpcErrorCode =
  | "bad_request"
  | "unknown_template"
  | "invalid_params"
  | "cwd_refused"
  | "limit_exceeded"
  | "engine_disabled"
  | "busy"
  | "not_found"
  | "forbidden"
  | "unsupported"
  | "internal";

/** The body of a `reply`. `replyTo` is the `id` of the request. */
export type ReplyBody =
  | { replyTo: string; ok: true; data: Json }
  | { replyTo: string; ok: false; error: { code: IpcErrorCode; message: string } };

export interface IpcMessage {
  v: number;
  id: string;
  ts: number;
  nonce: string;
  type: MessageType;
  body: JsonObject;
  mac: string;
}

// ---- rejections ------------------------------------------------------------------------------------

export type RejectReason = "oversize" | "http_shaped" | "malformed" | "unsupported_version" | "bad_type" | "stale" | "bad_mac" | "replay";

export class IpcProtocolError extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason, message?: string) {
    super(message ?? reason);
    this.name = "IpcProtocolError";
    this.reason = reason;
  }
}

/** Refuses anything but `127.0.0.1` (not `localhost`, not `0.0.0.0`, not `::`, not a LAN address). */
export function assertLoopbackHost(host: string): void {
  if (host !== IPC_HOST) throw new Error(`the IPC host must be ${IPC_HOST}, not "${host}"`);
}

// ---- framing ---------------------------------------------------------------------------------------

const HTTP_REQUEST_LINE = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|PRI)\s+\S+\s+HTTP\/\d/i;
const HTTP_METHOD_START = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE|PRI)\s/i;

/** True for a line that starts like an HTTP request (`POST / HTTP/1.1`), or a bare method word followed by a space. */
export function looksLikeHttp(line: string): boolean {
  return HTTP_REQUEST_LINE.test(line) || HTTP_METHOD_START.test(line);
}

/**
 * Splits a byte stream into lines (`\n`, an optional `\r` before it is dropped). Throws `IpcProtocolError("oversize")`
 * as soon as a line (complete or not) is longer than `maxBytes`, so an endless line cannot grow the buffer.
 */
export class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = chunk.subarray(start);
        if (this.pendingBytes + rest.length > this.maxBytes) throw new IpcProtocolError("oversize", "line is too long");
        if (rest.length > 0) {
          this.pending.push(rest);
          this.pendingBytes += rest.length;
        }
        return lines;
      }
      const part = chunk.subarray(start, nl);
      if (this.pendingBytes + part.length > this.maxBytes) throw new IpcProtocolError("oversize", "line is too long");
      const whole = this.pending.length > 0 ? Buffer.concat([...this.pending, part]) : part;
      this.pending = [];
      this.pendingBytes = 0;
      const text = whole.toString("utf8");
      lines.push(text.endsWith("\r") ? text.slice(0, -1) : text);
      start = nl + 1;
    }
  }
}

// ---- replay protection -----------------------------------------------------------------------------

/** Remembers nonces for `ttlMs`. Bounded: the oldest entries go first when `max` is reached. */
export class NonceCache {
  private readonly seenAt = new Map<string, number>();
  constructor(
    private readonly ttlMs: number = NONCE_TTL_MS,
    private readonly max: number = MAX_NONCES,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if the nonce is already known (and still fresh). */
  has(nonce: string): boolean {
    this.prune();
    return this.seenAt.has(nonce);
  }

  remember(nonce: string): void {
    this.prune();
    this.seenAt.delete(nonce);
    this.seenAt.set(nonce, this.now());
    while (this.seenAt.size > this.max) {
      const oldest = this.seenAt.keys().next();
      if (oldest.done) break;
      this.seenAt.delete(oldest.value);
    }
  }

  get size(): number {
    this.prune();
    return this.seenAt.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [nonce, at] of this.seenAt) {
      if (at > cutoff) break; // insertion order = time order
      this.seenAt.delete(nonce);
    }
  }
}

// ---- encode and decode ----------------------------------------------------------------------------

export interface SignOptions {
  now?: () => number;
  id?: string;
  nonce?: string;
}

export function signMessage(key: IpcKey, type: MessageType, body: JsonObject, opts: SignOptions = {}): IpcMessage {
  const fields: SignedFields = {
    v: IPC_VERSION,
    id: opts.id ?? randomToken(),
    ts: (opts.now ?? Date.now)(),
    nonce: opts.nonce ?? randomToken(),
    type,
    body,
  };
  return { ...fields, type, body, mac: computeMac(key, fields) };
}

/** The wire form: one JSON line ending in `\n`. Throws when it would exceed `MAX_LINE_BYTES`. */
export function encodeLine(msg: IpcMessage): Buffer {
  const line = Buffer.from(JSON.stringify(msg) + "\n", "utf8");
  if (line.length > MAX_LINE_BYTES) throw new Error(`message is larger than ${MAX_LINE_BYTES} bytes`);
  return line;
}

const FIELD_SET = new Set(["v", "id", "ts", "nonce", "type", "body", "mac"]);
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const MAC_TEXT = /^[0-9a-f]{64}$/;

/** Structure only (no key, no time): the exact field set with the right types. */
export function parseLine(line: string): IpcMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new IpcProtocolError("oversize");
  if (looksLikeHttp(line)) throw new IpcProtocolError("http_shaped");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new IpcProtocolError("malformed", "not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new IpcProtocolError("malformed", "not an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELD_SET.has(k)) throw new IpcProtocolError("malformed", "unexpected field");
  for (const k of FIELD_SET) if (!(k in o)) throw new IpcProtocolError("malformed", "missing field");
  if (o["v"] !== IPC_VERSION) throw new IpcProtocolError("unsupported_version");
  if (typeof o["id"] !== "string" || !TOKEN.test(o["id"])) throw new IpcProtocolError("malformed", "bad id");
  if (typeof o["nonce"] !== "string" || !TOKEN.test(o["nonce"]) || o["nonce"].length < 16) throw new IpcProtocolError("malformed", "bad nonce");
  if (typeof o["ts"] !== "number" || !Number.isSafeInteger(o["ts"])) throw new IpcProtocolError("malformed", "bad ts");
  if (typeof o["type"] !== "string" || !(MESSAGE_TYPES as readonly string[]).includes(o["type"])) throw new IpcProtocolError("bad_type");
  if (typeof o["body"] !== "object" || o["body"] === null || Array.isArray(o["body"])) throw new IpcProtocolError("malformed", "body must be an object");
  if (typeof o["mac"] !== "string" || !MAC_TEXT.test(o["mac"])) throw new IpcProtocolError("malformed", "bad mac");
  return o as unknown as IpcMessage;
}

export interface DecodeOptions {
  /** The keys to try for this message. It sees the unverified `type` and `body` (to pick a per-job key); it must not trust them. */
  keys: (peek: { type: MessageType; body: JsonObject }) => Iterable<KeyCandidate>;
  nonces: NonceCache;
  now?: () => number;
  /** Types this side accepts; anything else is `bad_type`. */
  accepts: ReadonlySet<string>;
}

export interface Decoded {
  msg: IpcMessage;
  principal: string;
  key: IpcKey;
}

/**
 * Full receive-side check of one line. Throws `IpcProtocolError`. The nonce is remembered only after the MAC verified,
 * so unauthenticated traffic cannot fill the cache.
 */
export function decodeLine(line: string, opts: DecodeOptions): Decoded {
  const msg = parseLine(line);
  if (!opts.accepts.has(msg.type)) throw new IpcProtocolError("bad_type");
  const now = (opts.now ?? Date.now)();
  if (Math.abs(now - msg.ts) > MAX_CLOCK_SKEW_MS) throw new IpcProtocolError("stale");
  const fields: SignedFields = { v: msg.v, id: msg.id, ts: msg.ts, nonce: msg.nonce, type: msg.type, body: msg.body };
  let matched: KeyCandidate | undefined;
  for (const cand of opts.keys({ type: msg.type, body: msg.body })) {
    if (verifyMac(cand.key, fields, msg.mac)) {
      matched = cand;
      break;
    }
  }
  if (!matched) throw new IpcProtocolError("bad_mac");
  if (opts.nonces.has(msg.nonce)) throw new IpcProtocolError("replay");
  opts.nonces.remember(msg.nonce);
  return { msg, principal: matched.principal, key: matched.key };
}

/** Test and debugging aid: the string a MAC covers. */
export { bodyHash, signingString };
