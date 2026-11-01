/**
 * Shell audit log (S1.4): append-only `audit\shell-YYYYMM.jsonl`. One JSON object per line with the events
 * `requested`, `decided`, `started`, `finished` (exit code, duration, bytes, sha256 of the full output), `blocked`.
 * Written synchronously so an event is on disk before the action it records.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, AuditLog } from "../contracts.js";
import { redactDeep } from "./redact.js";
import type { Redactor } from "./redact.js";

export interface AuditOptions {
  dir: string;
  redact: Redactor;
  now?: () => Date;
}

export function auditFileName(d: Date): string {
  return `shell-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

const REQUIRED: Record<AuditEvent["event"], string[]> = {
  requested: ["ts", "id", "conversationId", "chatId", "command", "reason", "cwd", "deadline"],
  decided: ["ts", "id", "approved", "by", "at"],
  started: ["ts", "id", "command", "cwd", "timeoutSec"],
  finished: ["ts", "id", "exitCode", "durationMs", "bytes", "sha256"],
  blocked: ["ts", "id", "command", "reason"],
};

/** Names of required fields missing from an event (empty = valid). */
export function missingAuditFields(event: AuditEvent): string[] {
  const rec = event as unknown as Record<string, unknown>;
  const req = REQUIRED[event.event];
  if (!req) return ["event"];
  return req.filter((k) => rec[k] === undefined);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createAuditLog(opts: AuditOptions): AuditLog {
  const now = opts.now ?? (() => new Date());
  mkdirSync(opts.dir, { recursive: true });
  return {
    write(event: AuditEvent): void {
      const missing = missingAuditFields(event);
      if (missing.length > 0) throw new Error(`audit event "${event.event}" is missing: ${missing.join(", ")}`);
      const line = JSON.stringify(redactDeep(event, opts.redact));
      // `flag: "a"` is append-only; the audit file is never rewritten or truncated by this process.
      appendFileSync(join(opts.dir, auditFileName(now())), line + "\n", { encoding: "utf8", flag: "a" });
    },
  };
}

/** An audit log that keeps events in memory, for tests of other modules. */
export function createMemoryAuditLog(): AuditLog & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    write(event) {
      const missing = missingAuditFields(event);
      if (missing.length > 0) throw new Error(`audit event "${event.event}" is missing: ${missing.join(", ")}`);
      events.push(event);
    },
  };
}
