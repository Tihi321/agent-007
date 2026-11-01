/**
 * The job runner's own audit log (S11.4): append-only `audit\jobs-YYYYMM.jsonl` in its data folder (main user only).
 * One JSON object per line, written synchronously BEFORE the action it records, through the redactor. The brief is never
 * stored (only its length and SHA-256), nor is a permission request's input (only its SHA-256).
 *
 * Events: `submitted`, `rejected`, `started`, `permission_asked`, `permission_decided`, `flow_call`, `cancelled`,
 * `finished` (exit, duration, cost if reported), plus `interrupted`, `resumed` and `hub_start`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JobEngine, JobState, JsonObject, PermissionAnswer, PermissionDecider } from "../jobs/contracts.js";
import { redactDeep } from "../logging/redact.js";
import type { Redactor } from "../logging/redact.js";

interface Base {
  /** ISO time. */
  ts: string;
}

export type JobAuditEvent =
  | (Base & {
      event: "submitted";
      jobId: string;
      templateId: string;
      engine: JobEngine;
      cwd: string;
      params: JsonObject;
      briefChars: number;
      briefSha256: string;
      approvalUserId: number;
      approvedAt: number;
      flowBudgetCredits?: number;
    })
  | (Base & { event: "rejected"; jobId: string; templateId?: string; code: string; reason: string })
  | (Base & { event: "started"; jobId: string; engine: JobEngine; engineVersion: string; resumed: boolean })
  | (Base & { event: "permission_asked"; jobId: string; requestId: string; tool: string; kind: string; inputSha256: string; summary?: string })
  | (Base & { event: "permission_decided"; jobId: string; requestId: string; answer: PermissionAnswer; by: PermissionDecider; userId?: number })
  | (Base & { event: "flow_call"; jobId: string; tool: string; maxCredits: number; allowed: boolean; chargedTotal: number; remaining: number })
  | (Base & { event: "cancelled"; jobId: string; reason: string; by: string })
  | (Base & { event: "finished"; jobId: string; state: JobState; exitCode?: number; durationMs: number; costUsd?: number; error?: string })
  | (Base & { event: "interrupted"; jobId: string; reason: string; pid?: number })
  | (Base & { event: "resumed"; jobId: string; approvalUserId: number })
  | (Base & { event: "hub_start"; service: string; approvalUserId: number; scriptorium: boolean; outcome: "requested" | "started" | "already_up" | "failed" | "refused"; detail?: string });

export type JobAuditEventName = JobAuditEvent["event"];

const REQUIRED: Record<JobAuditEventName, string[]> = {
  submitted: ["ts", "jobId", "templateId", "engine", "cwd", "params", "briefChars", "briefSha256", "approvalUserId", "approvedAt"],
  rejected: ["ts", "jobId", "code", "reason"],
  started: ["ts", "jobId", "engine", "engineVersion", "resumed"],
  permission_asked: ["ts", "jobId", "requestId", "tool", "kind", "inputSha256"],
  permission_decided: ["ts", "jobId", "requestId", "answer", "by"],
  flow_call: ["ts", "jobId", "tool", "maxCredits", "allowed", "chargedTotal", "remaining"],
  cancelled: ["ts", "jobId", "reason", "by"],
  finished: ["ts", "jobId", "state", "durationMs"],
  interrupted: ["ts", "jobId", "reason"],
  resumed: ["ts", "jobId", "approvalUserId"],
  hub_start: ["ts", "service", "approvalUserId", "scriptorium", "outcome"],
};

export function missingJobAuditFields(event: JobAuditEvent): string[] {
  const rec = event as unknown as Record<string, unknown>;
  const req = REQUIRED[event.event];
  if (!req) return ["event"];
  return req.filter((k) => rec[k] === undefined);
}

export function jobAuditFileName(d: Date): string {
  return `jobs-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface JobAuditLog {
  write(event: JobAuditEvent): void;
}

export interface JobAuditOptions {
  dir: string;
  redact: Redactor;
  now?: () => Date;
}

export function createJobAuditLog(opts: JobAuditOptions): JobAuditLog {
  const now = opts.now ?? (() => new Date());
  mkdirSync(opts.dir, { recursive: true });
  return {
    write(event: JobAuditEvent): void {
      const missing = missingJobAuditFields(event);
      if (missing.length > 0) throw new Error(`job audit event "${event.event}" is missing: ${missing.join(", ")}`);
      const line = JSON.stringify(redactDeep(event, opts.redact));
      // `flag: "a"` is append-only; this process never rewrites or truncates the file.
      appendFileSync(join(opts.dir, jobAuditFileName(now())), line + "\n", { encoding: "utf8", flag: "a" });
    },
  };
}

/** An audit log that keeps events in memory, for tests. */
export function createMemoryJobAudit(): JobAuditLog & { events: JobAuditEvent[] } {
  const events: JobAuditEvent[] = [];
  return {
    events,
    write(event) {
      const missing = missingJobAuditFields(event);
      if (missing.length > 0) throw new Error(`job audit event "${event.event}" is missing: ${missing.join(", ")}`);
      events.push(event);
    },
  };
}
