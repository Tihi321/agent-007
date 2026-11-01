/**
 * The web audit log (S28, I54): append-only `web-audit\web-YYYYMM.jsonl`, one JSON object per line, written synchronously. It records
 * what happened (login, lockout, invite, user change, bot change, denials, approvals, quota hits) and NEVER a message body: an event
 * that carries a field named like a body is refused, and callers pass `bodyDigest()` (length and sha256) instead.
 * Secrets that might leak into a detail are masked by the redactor given at construction.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactDeep } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";

export const AUDIT_KINDS = [
  "login_ok",
  "login_fail",
  "lockout",
  "claim",
  "logout",
  "session_revoked",
  "invite_create",
  "invite_use",
  "invite_revoke",
  "invite_bound",
  "user_change",
  "user_delete",
  "bot_create",
  "bot_edit",
  "bot_delete",
  "tool_denied",
  "approval",
  "quota_hit",
  "identity_rejected",
  "startup_refused",
  "lockdown",
  "step_up",
  "export",
  "chat_turn",
  "paid_grant",
  "paid_usage",
  "paid_cap_hit",
  "route_changed",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface WebAuditEvent {
  kind: AuditKind;
  /** The acting user id, when known. */
  user?: string;
  /** Short, content-free facts: ids, counts, reasons from a fixed set. */
  detail?: Record<string, string | number | boolean | undefined>;
}

const BODY_KEYS = /^(body|text|message|content|prompt|reply|messages|input|output)$/i;

export interface WebAudit {
  write(e: WebAuditEvent): void;
}

export class WebAuditError extends Error {}

export function createWebAudit(o: { dir: string; redact?: Redactor; now?: () => Date }): WebAudit & { dir: string } {
  const now = o.now ?? (() => new Date());
  const redact = o.redact ?? ((s: string) => s);
  mkdirSync(o.dir, { recursive: true });
  return {
    dir: o.dir,
    write(e: WebAuditEvent): void {
      for (const k of Object.keys(e.detail ?? {})) if (BODY_KEYS.test(k)) throw new WebAuditError(`audit detail "${k}" looks like a message body; log bodyDigest() instead`);
      const d = now();
      const file = `web-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
      const line = JSON.stringify(redactDeep({ ts: d.toISOString(), ...e }, redact));
      appendFileSync(join(o.dir, file), line + "\n", { encoding: "utf8", flag: "a" });
    },
  };
}

/** For tests of other modules. */
export function memoryWebAudit(): WebAudit & { events: WebAuditEvent[] } {
  const events: WebAuditEvent[] = [];
  return {
    events,
    write(e) {
      for (const k of Object.keys(e.detail ?? {})) if (BODY_KEYS.test(k)) throw new WebAuditError(`audit detail "${k}" looks like a message body`);
      events.push(e);
    },
  };
}
