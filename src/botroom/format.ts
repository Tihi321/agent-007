/**
 * Bot room line format (S24.1, I37, UI-27). Pure functions: a bus audit event in, one plain-text line out.
 *
 *   [research → ops, hop 1, chain 7f3a9c1e] first part of the text…
 *
 * Rules, all enforced here and tested:
 *  - redaction happens BEFORE truncation (a secret cut in half would no longer match a pattern), and covers the exact secret
 *    values (through the host redactor) plus secret-SHAPED text (API keys, bearer tokens, JWTs, `key=value` pairs, private keys);
 *  - the text is flattened to one line and stripped of control characters; the room never receives markup (no parse_mode);
 *  - only the kinds in `MIRRORED_KINDS` are mirrored. Approvals, prompts, tool output and anything else are never in this module's
 *    input type, and an unknown kind is ignored (I35: approvals are never relayed).
 */
import type { Redactor } from "../logging/redact.js";

/** The bus audit events the room shows. Anything else is dropped without a trace in the room. */
export const MIRRORED_KINDS = ["ask", "reply", "refused", "failed"] as const;
export type MirroredKind = (typeof MIRRORED_KINDS)[number];

/**
 * The minimal, read-only shape the mirror needs from a bus audit event. The S21 bus audit record is adapted to this by the
 * host (S26); the mirror never sees an envelope's body field other than `text`, never a taint flag, never an approval.
 * `from` is the sender of THIS message and `to` its recipient (a reply has `from` = the answering bot).
 */
export interface BusAuditEvent {
  kind: string;
  from: string;
  to: string;
  hop: number;
  chainId: string;
  /** The ask or reply text. */
  text?: string;
  /** For `refused` and `failed`: a short machine reason (never content). */
  reason?: string;
}

export interface FormatOptions {
  mode: "summary" | "truncated";
  /** Upper bound of the text part, in characters. */
  maxChars: number;
  /** Exact-value redactor of the host (secrets, tokens). */
  redact: Redactor;
}

/** `summary` shows only the first line, at most this many characters (or `maxChars` when that is smaller). */
export const SUMMARY_CHARS = 80;
export const CHAIN_ID_CHARS = 8;
/** Telegram's hard limit is 4096; leave room for the notice line. */
export const MAX_POST_CHARS = 3900;
export const ELLIPSIS = "…";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED]"],
  // key = value, key: value, "key": "value" for names that hold secrets.
  [
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|authorization|credential)s?)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    "$1$2[REDACTED]",
  ],
  // Long opaque runs: hex digests and base64url keys (the 43-character IPC key shape included).
  [/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]"],
  [/[A-Za-z0-9_-]{43,}/g, "[REDACTED]"],
];

/** Host redactor first (exact values, bot tokens), then the secret-shaped patterns. */
export function redactForRoom(text: string, redact: Redactor): string {
  let out = redact(text);
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** One line: control characters removed, whitespace runs collapsed, trimmed. */
export function flatten(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .split(String.fromCharCode(0x2028))
    .join(" ")
    .split(String.fromCharCode(0x2029))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `max` code points of `text`, with an ellipsis when something was cut. */
export function truncate(text: string, max: number): string {
  const limit = Math.max(1, Math.floor(max));
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return points.slice(0, Math.max(0, limit - 1)).join("").trimEnd() + ELLIPSIS;
}

function label(value: string, redact: Redactor): string {
  return truncate(flatten(redactForRoom(value, redact)), 40) || "?";
}

/** The text part of a line for an event, already redacted, flattened and truncated. Empty when the event carries none. */
export function bodyOf(event: BusAuditEvent, opts: FormatOptions): string {
  let raw: string | undefined;
  if (event.kind === "ask" || event.kind === "reply") raw = event.text;
  else raw = event.reason !== undefined ? `${event.kind}: ${event.reason}` : event.kind;
  if (raw === undefined) return "";
  let text = redactForRoom(raw, opts.redact);
  if (opts.mode === "summary") {
    // The first non-empty line only.
    const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    text = first;
  }
  text = flatten(text);
  const cap = opts.mode === "summary" ? Math.min(opts.maxChars, SUMMARY_CHARS) : opts.maxChars;
  return truncate(text, cap);
}

/** True for a kind the room shows. */
export function isMirrored(event: { kind: string }): boolean {
  return (MIRRORED_KINDS as readonly string[]).includes(event.kind);
}

/** `[from → to, hop n, chain id] text…`, or undefined for a kind the room never shows or a malformed event. */
export function formatLine(event: BusAuditEvent, opts: FormatOptions): string | undefined {
  if (!isMirrored(event)) return undefined;
  if (typeof event.from !== "string" || typeof event.to !== "string" || typeof event.chainId !== "string") return undefined;
  const hop = Number.isFinite(event.hop) ? Math.max(0, Math.trunc(event.hop)) : 0;
  const chain = flatten(redactForRoom(event.chainId, opts.redact)).slice(0, CHAIN_ID_CHARS) || "?";
  const header = `[${label(event.from, opts.redact)} → ${label(event.to, opts.redact)}, hop ${hop}, chain ${chain}]`;
  const body = bodyOf(event, opts);
  return body.length > 0 ? `${header} ${body}` : header;
}

/** A line for the notice that a burst was cut. */
export function droppedNotice(n: number): string {
  return `… ${n} line${n === 1 ? "" : "s"} dropped (room rate limit)`;
}

/** Groups lines into posts of at most `linesPerPost` lines and `MAX_POST_CHARS` characters. Never splits a line. */
export function takeBatch(lines: string[], linesPerPost: number, maxChars: number = MAX_POST_CHARS): string[] {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (out.length >= linesPerPost) break;
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (out.length > 0 && size + add > maxChars) break;
    out.push(line.length > maxChars ? truncate(line, maxChars) : line);
    size += add;
  }
  return out;
}
