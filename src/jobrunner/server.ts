/**
 * The job runner's IPC server (S11.1). It wraps `src/ipc/server.ts` (S9: loopback bind, HMAC, replay cache, HTTP-shaped
 * and oversize rejection, one `warn` per rejection) and adds the handler:
 *
 *   - the agent (principal `main`, the shared `ipcHmacKey`) may send `submit`, `cancel`, `status`, `list_templates`,
 *     `hub_status`, `hub_start` and `permission_decision`. Its bodies are validated strictly: a `submit` is only
 *     `{jobId, request: {templateId, params, brief}, approval, flowBudgetCredits?, resume?}`; a `command`, `prompt` or
 *     `cwd` field anywhere is refused (I16);
 *   - a permission helper (principal `job:<id>`, the per-job token, I28) may send ONE type, `permission_request`, for its
 *     own job while it runs. The key for it exists only while the job runs (`JobKeyRegistry`), so a wrong token,
 *     another job's token, a token after the job ended and an unsigned request are all refused at the MAC check.
 *
 * Pushes (`job_event`, `permission_request`, `job_done`) go to the `main` connections only.
 */
import type { Logger } from "../contracts.js";
import type { IpcKey, KeyCandidate } from "../ipc/hmac.js";
import type { MessageType } from "../ipc/protocol.js";
import { IpcHandlerError, IpcServer } from "../ipc/server.js";
import type { IpcRequestContext } from "../ipc/server.js";
import type {
  ApprovalProof,
  CancelBody,
  FlowEstimateBody,
  HubStartBody,
  Json,
  JsonObject,
  PermissionDecision,
  PermissionHelperRequest,
  StatusBody,
  SubmitBody,
} from "../jobs/contracts.js";
import { MAX_BRIEF_CHARS, parseJobRequest } from "../jobs/contracts.js";
import type { PermissionBroker } from "./drivers/claude/permissionBroker.js";
import { JOB_ID_PATTERN } from "./journal.js";
import type { JobKeyRegistry, JobManager } from "./manager.js";

export interface JobRunnerServerOptions {
  port: number;
  /** Must be 127.0.0.1; anything else makes `IpcServer` throw. Present so a test can prove the refusal. */
  host?: string;
  /** The agent's key (`ipcHmacKey`). */
  key: IpcKey;
  manager: JobManager;
  jobKeys: JobKeyRegistry;
  /**
   * Permission brokers of engine drivers (S15: the Claude driver keeps its own per-job tokens in a `PermissionBroker`).
   * Their keys are accepted for a `permission_request` of a running job, and their `handle` answers it. A job that a broker
   * knows is answered by the broker; any other job by the core (`manager.handleHelperPermission`).
   */
  permissionBrokers?: readonly Pick<PermissionBroker, "keys" | "handle" | "isActive">[];
  logger: Logger;
  now?: () => number;
  authTimeoutMs?: number;
  maxConnections?: number;
}

function obj(v: unknown, what: string): JsonObject {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new IpcHandlerError("bad_request", `${what} must be an object`);
  return v as JsonObject;
}

function onlyKeys(o: JsonObject, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new IpcHandlerError("bad_request", `unknown field "${k}" in ${what}`);
}

function jobIdOf(v: unknown): string {
  if (typeof v !== "string" || !JOB_ID_PATTERN.test(v)) throw new IpcHandlerError("bad_request", "jobId must be 1 to 64 letters, digits, - or _");
  return v;
}

function approvalOf(v: unknown): ApprovalProof {
  const a = obj(v, "approval");
  onlyKeys(a, ["userId", "at"], "approval");
  if (typeof a["userId"] !== "number" || !Number.isSafeInteger(a["userId"]) || a["userId"] <= 0) throw new IpcHandlerError("bad_request", "approval.userId must be a numeric user id");
  if (typeof a["at"] !== "number" || !Number.isFinite(a["at"])) throw new IpcHandlerError("bad_request", "approval.at must be a time");
  return { userId: a["userId"], at: a["at"] };
}

export function parseSubmitBody(body: JsonObject): SubmitBody {
  onlyKeys(body, ["jobId", "request", "approval", "flowBudgetCredits", "resume"], "submit");
  const jobId = jobIdOf(body["jobId"]);
  const req = parseJobRequest(body["request"]);
  if (!req.ok) throw new IpcHandlerError("bad_request", req.error);
  if (req.value.brief.length > MAX_BRIEF_CHARS) throw new IpcHandlerError("bad_request", "the brief is too long");
  const out: SubmitBody = { jobId, request: req.value, approval: approvalOf(body["approval"]) };
  const credits = body["flowBudgetCredits"];
  if (credits !== undefined) {
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) throw new IpcHandlerError("bad_request", "flowBudgetCredits must be a number");
    out.flowBudgetCredits = credits;
  }
  const resume = body["resume"];
  if (resume !== undefined) {
    if (typeof resume !== "boolean") throw new IpcHandlerError("bad_request", "resume must be true or false");
    out.resume = resume;
  }
  return out;
}

function parseCancelBody(body: JsonObject): CancelBody {
  onlyKeys(body, ["jobId", "reason"], "cancel");
  const out: CancelBody = { jobId: jobIdOf(body["jobId"]) };
  if (body["reason"] !== undefined) {
    if (typeof body["reason"] !== "string") throw new IpcHandlerError("bad_request", "reason must be text");
    out.reason = body["reason"];
  }
  return out;
}

function parseStatusBody(body: JsonObject): StatusBody {
  onlyKeys(body, ["jobId", "sinceSeq"], "status");
  const out: StatusBody = {};
  if (body["jobId"] !== undefined) out.jobId = jobIdOf(body["jobId"]);
  if (body["sinceSeq"] !== undefined) {
    const s = body["sinceSeq"];
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0) throw new IpcHandlerError("bad_request", "sinceSeq must be a whole number from 0");
    out.sinceSeq = s;
  }
  return out;
}

function parseHubStartBody(body: JsonObject): HubStartBody {
  onlyKeys(body, ["service", "scriptoriumApproved", "approval"], "hub_start");
  if (typeof body["service"] !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(body["service"])) throw new IpcHandlerError("bad_request", "service must be a service id");
  const out: HubStartBody = { service: body["service"], approval: approvalOf(body["approval"]) };
  if (body["scriptoriumApproved"] !== undefined) {
    if (typeof body["scriptoriumApproved"] !== "boolean") throw new IpcHandlerError("bad_request", "scriptoriumApproved must be true or false");
    out.scriptoriumApproved = body["scriptoriumApproved"];
  }
  return out;
}

function parseFlowEstimateBody(body: JsonObject): FlowEstimateBody {
  onlyKeys(body, ["templateId", "params"], "flow_estimate");
  if (typeof body["templateId"] !== "string" || body["templateId"] === "" || body["templateId"].length > 64) throw new IpcHandlerError("bad_request", "templateId is required");
  const params = body["params"] ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw new IpcHandlerError("bad_request", "params must be an object");
  return { templateId: body["templateId"], params: params as JsonObject };
}

function parseDecision(body: JsonObject): PermissionDecision {
  onlyKeys(body, ["requestId", "jobId", "answer", "by", "userId", "at", "message"], "permission_decision");
  if (typeof body["requestId"] !== "string") throw new IpcHandlerError("bad_request", "requestId is required");
  const d: PermissionDecision = {
    requestId: body["requestId"],
    jobId: jobIdOf(body["jobId"]),
    answer: body["answer"] === "allow_once" ? "allow_once" : "deny",
    by: body["by"] as PermissionDecision["by"],
    at: typeof body["at"] === "number" ? body["at"] : Date.now(),
  };
  if (typeof body["userId"] === "number") d.userId = body["userId"];
  if (typeof body["message"] === "string") d.message = body["message"];
  return d;
}

function parseHelperRequest(body: JsonObject): PermissionHelperRequest {
  onlyKeys(body, ["requestId", "jobId", "tool", "input"], "permission_request");
  if (typeof body["requestId"] !== "string" || typeof body["tool"] !== "string") throw new IpcHandlerError("bad_request", "requestId and tool are required");
  return { requestId: body["requestId"], jobId: jobIdOf(body["jobId"]), tool: body["tool"], input: (body["input"] ?? {}) as Json };
}

/** The handler for `IpcServer`. Exported so tests can drive it without a socket. */
export function createHandler(manager: JobManager, brokers: readonly Pick<PermissionBroker, "handle" | "isActive">[] = []) {
  return async (type: MessageType, body: JsonObject, ctx: IpcRequestContext): Promise<Json | undefined> => {
    if (ctx.principal.startsWith("job:")) {
      // a permission helper: one type, its own job only
      if (type !== "permission_request") throw new IpcHandlerError("forbidden", "a job token may only send permission_request");
      const req = parseHelperRequest(body);
      if (ctx.principal !== `job:${req.jobId}`) throw new IpcHandlerError("forbidden", "the token belongs to another job");
      const broker = brokers.find((b) => b.isActive(req.jobId));
      if (broker) return (await broker.handle(ctx.principal, body)) as unknown as Json;
      return (await manager.handleHelperPermission(req, req.jobId)) as unknown as Json;
    }
    switch (type) {
      case "submit":
        return (await manager.submit(parseSubmitBody(body))) as unknown as Json;
      case "cancel":
        return manager.cancel(parseCancelBody(body)) as unknown as Json;
      case "status":
        return manager.status(parseStatusBody(body)) as unknown as Json;
      case "list_templates":
        onlyKeys(body, [], "list_templates");
        return manager.listTemplates() as unknown as Json;
      case "hub_status":
        onlyKeys(body, [], "hub_status");
        return (await manager.hubStatus()) as unknown as Json;
      case "hub_start":
        return (await manager.hubStart(parseHubStartBody(body))) as unknown as Json;
      case "flow_estimate":
        return (await manager.flowEstimate(parseFlowEstimateBody(body))) as unknown as Json;
      case "permission_decision":
        manager.decidePermission(parseDecision(body));
        return undefined;
      default:
        // `permission_request` from the agent's key, or a type the server never accepts
        throw new IpcHandlerError("forbidden", `the agent may not send ${type}`);
    }
  };
}

/** Starts the IPC server and connects the manager's pushes to it. */
export async function startJobRunnerServer(opts: JobRunnerServerOptions): Promise<{ server: IpcServer; port: number }> {
  const server = new IpcServer({
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    keys: (peek): Iterable<KeyCandidate> => {
      const out: KeyCandidate[] = [{ key: opts.key, principal: "main" }];
      if (peek.type === "permission_request") {
        const jobId = peek.body["jobId"];
        if (typeof jobId === "string") {
          const k = opts.jobKeys.get(jobId);
          if (k) out.push({ key: k, principal: `job:${jobId}` });
        }
        for (const b of opts.permissionBrokers ?? []) out.push(...b.keys(peek));
      }
      return out;
    },
    handler: createHandler(opts.manager, opts.permissionBrokers ?? []),
    logger: opts.logger,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.authTimeoutMs !== undefined ? { authTimeoutMs: opts.authTimeoutMs } : {}),
    ...(opts.maxConnections !== undefined ? { maxConnections: opts.maxConnections } : {}),
  });
  opts.manager.setNotifier({
    event: (e) => void server.broadcast("job_event", e as unknown as JsonObject),
    permission: (r) => void server.broadcast("permission_request", r as unknown as JsonObject),
    done: (d) => void server.broadcast("job_done", d as unknown as JsonObject),
  });
  const { port } = await server.listen();
  return { server, port };
}
