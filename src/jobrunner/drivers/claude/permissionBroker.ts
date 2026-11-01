/**
 * The job runner's side of the permission channel (S12.3, I28). One broker serves every running Claude job:
 *
 *  - `register(job)` makes a random 32-byte token for the job (returned once, for the job-scoped `--mcp-config` file) and
 *    keeps only the derived `IpcKey`. `unregister(jobId)` ends it: a token after the job is useless.
 *  - `keys(peek)` is what S11's IPC server hands to `IpcServer` as `keys`: for a `permission_request` whose `jobId` is a
 *    running job it returns that job's key with the principal `job:<id>`; for anything else it returns nothing, so a
 *    wrong token, another job's token, an ended job's token and an unsigned request all fail the MAC check and the
 *    connection is closed (src/ipc/server.ts).
 *  - `handle(principal, body)` is S11's handler for a `permission_request` from such a principal. It re-checks that the
 *    principal is exactly `job:<body.jobId>`, applies the runner's own policy first (`JobRunnerPolicy`: Flow budget,
 *    Scriptorium start, shell kinds) and only on `ask` goes to `host.askPermission` (the Telegram card). Only
 *    `allow_once` and `deny` exist; any error, timeout or odd answer is a deny.
 *
 * The token is never logged and never put in an error message.
 */
import { randomBytes } from "node:crypto";
import { IpcHandlerError } from "../../../ipc/server.js";
import { IpcKey } from "../../../ipc/hmac.js";
import type { KeyCandidate } from "../../../ipc/hmac.js";
import type { MessageType } from "../../../ipc/protocol.js";
import type {
  EngineHost,
  JobRef,
  Json,
  JsonObject,
  PermissionAnswer,
  PermissionHelperReply,
  PermissionKind,
  PermissionRequest,
} from "../../../jobs/contracts.js";
import { isShellRule } from "./argv.js";

export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const DEFAULT_PERMISSION_TIMEOUT_SEC = 1800;

export interface BrokerJob {
  jobId: string;
  /** The runner's view of the job for the policy (budget and charged credits change, so a getter is allowed). */
  ref: JobRef | (() => JobRef);
  cwd: string;
  host: EngineHost;
  timeoutSec?: number;
}

interface ActiveJob extends BrokerJob {
  key: IpcKey;
}

export interface PermissionBrokerOptions {
  now?: () => number;
}

export class PermissionBroker {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly now: () => number;

  constructor(opts: PermissionBrokerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Returns the token text for this job (base64url, 43 characters). Throws when the job id is odd or already registered. */
  register(job: BrokerJob): string {
    if (!JOB_ID_PATTERN.test(job.jobId)) throw new Error("job id has unexpected characters");
    if (this.jobs.has(job.jobId)) throw new Error("job already has a permission channel");
    const token = randomBytes(32).toString("base64url");
    this.jobs.set(job.jobId, { ...job, key: IpcKey.fromBase64Url(token) });
    return token;
  }

  unregister(jobId: string): void {
    this.jobs.delete(jobId);
  }

  isActive(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  get activeCount(): number {
    return this.jobs.size;
  }

  /** For `IpcServerOptions.keys`: the per-job key when a `permission_request` names a running job. */
  keys(peek: { type: MessageType; body: JsonObject }): KeyCandidate[] {
    if (peek.type !== "permission_request") return [];
    const id = peek.body["jobId"];
    if (typeof id !== "string") return [];
    const job = this.jobs.get(id);
    return job ? [{ key: job.key, principal: `job:${id}` }] : [];
  }

  /** The handler for a `permission_request` from a job helper. Throws `IpcHandlerError` for a bad principal or body. */
  async handle(principal: string, body: JsonObject): Promise<PermissionHelperReply & JsonObject> {
    const jobId = body["jobId"];
    if (typeof jobId !== "string" || principal !== `job:${jobId}`) throw new IpcHandlerError("forbidden", "not the channel of this job");
    const job = this.jobs.get(jobId);
    if (!job) throw new IpcHandlerError("forbidden", "job is not running");
    const requestId = body["requestId"];
    const tool = body["tool"];
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) throw new IpcHandlerError("bad_request", "bad requestId");
    if (typeof tool !== "string" || tool === "" || tool.length > 256) throw new IpcHandlerError("bad_request", "bad tool");
    const input = (body["input"] ?? {}) as Json;

    // Belt and braces: the argv already disallows the shell tools; a request for one is never put to the user.
    if (isShellRule(tool)) return this.reply("deny", "shell tools are not available in jobs");

    const ref = typeof job.ref === "function" ? job.ref() : job.ref;
    try {
      const verdict = await job.host.policy.checkPermission(ref, tool, input);
      if (verdict === "allow") return this.reply("allow_once");
      if (verdict === "deny") return this.reply("deny", "denied by the job runner's rules");
      if (verdict !== "ask") return this.reply("deny", "unknown policy verdict");
      const req: PermissionRequest = {
        requestId,
        jobId,
        engine: "claude",
        tool,
        input,
        cwd: job.cwd,
        kind: kindOf(tool),
        summary: summaryOf(tool, input),
        requestedAt: this.now(),
        timeoutSec: job.timeoutSec ?? DEFAULT_PERMISSION_TIMEOUT_SEC,
      };
      const decision = await job.host.askPermission(req);
      if (decision.requestId !== requestId || decision.jobId !== jobId) return this.reply("deny", "answer did not match the request");
      return decision.answer === "allow_once" ? this.reply("allow_once") : this.reply("deny", decision.message ?? "denied");
    } catch {
      return this.reply("deny", "permission check failed");
    }
  }

  private reply(decision: PermissionAnswer, message?: string): PermissionHelperReply & JsonObject {
    return message === undefined ? { decision } : { decision, message };
  }
}

export function kindOf(tool: string): PermissionKind {
  const t = tool.toLowerCase();
  if (isShellRule(tool)) return "execute";
  if (t.startsWith("mcp__flow")) return "flow";
  if (["read", "glob", "grep", "ls"].includes(t)) return "read";
  if (["edit", "write", "multiedit", "notebookedit"].includes(t)) return "edit";
  return "other";
}

const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];

/** One line for the card. Content comes from the model: bounded and flattened, never executed. */
export function summaryOf(tool: string, input: Json): string {
  let detail = "";
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    for (const k of SUMMARY_KEYS) {
      const v = input[k];
      if (typeof v === "string" && v !== "") {
        detail = `${k}: ${v}`;
        break;
      }
    }
    if (detail === "") detail = JSON.stringify(input);
  }
  const line = `${tool} ${detail}`.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}
