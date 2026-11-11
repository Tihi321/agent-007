/**
 * The job runner's IPC server (S11.1). It wraps `src/ipc/server.ts` (S9: loopback bind, HMAC, replay cache, HTTP-shaped
 * and oversize rejection, one `warn` per rejection) and adds the handler:
 *
 *   - the agent (principal `main`, the shared `ipcHmacKey`) may send `submit`, `cancel`, `status`, `list_templates`,
 *     `hub_status`, `hub_start`, `browser_action` and `permission_decision`. Its bodies are validated strictly: a `submit` is only
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
import { BROWSER_KEYS } from "../jobs/browserContracts.js";
import type { BrowserAction, BrowserActionBody, BrowserKey } from "../jobs/browserContracts.js";
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

const BROWSER_CALL_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const BROWSER_REF = /^e\d{1,5}$/;

function browserText(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || v.length > max) throw new IpcHandlerError("bad_request", `${what} must be text of at most ${max} characters`);
  return v;
}

function browserRef(v: unknown, what: string): string {
  if (typeof v !== "string" || !BROWSER_REF.test(v)) throw new IpcHandlerError("bad_request", `${what} must be an element id from browser_read (like e12)`);
  return v;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Typed text and fill values: no CR, LF or other control character (an Enter inside the text would submit a form unasked; use browser_press Enter, which is checked). */
function browserTyped(v: unknown, what: string): string {
  const t = browserText(v, what, 2000);
  if (CONTROL_CHARS.test(t)) throw new IpcHandlerError("bad_request", `${what} must not contain line breaks or control characters; to press Enter use browser_press with key Enter`);
  return t;
}

function browserBool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new IpcHandlerError("bad_request", `${what} must be true or false`);
  return v;
}

function parseBrowserAction(v: unknown): BrowserAction {
  const a = obj(v, "action");
  const op = a["op"];
  switch (op) {
    case "goto": {
      onlyKeys(a, ["op", "url"], "action goto");
      const url = browserText(a["url"], "url", 2048);
      if (!/^https?:\/\//i.test(url)) throw new IpcHandlerError("bad_request", "url must start with http:// or https://");
      return { op, url };
    }
    case "back":
      onlyKeys(a, ["op"], "action back");
      return { op };
    case "read": {
      onlyKeys(a, ["op", "maxChars"], "action read");
      if (a["maxChars"] === undefined) return { op };
      const m = a["maxChars"];
      if (typeof m !== "number" || !Number.isInteger(m) || m < 1000 || m > 40_000) throw new IpcHandlerError("bad_request", "maxChars must be an integer from 1000 to 40000");
      return { op, maxChars: m };
    }
    case "click":
      onlyKeys(a, ["op", "ref"], "action click");
      return { op, ref: browserRef(a["ref"], "ref") };
    case "type": {
      onlyKeys(a, ["op", "ref", "text", "clear"], "action type");
      const out: Extract<BrowserAction, { op: "type" }> = { op, ref: browserRef(a["ref"], "ref"), text: browserTyped(a["text"], "text") };
      if (a["clear"] !== undefined) out.clear = browserBool(a["clear"], "clear");
      return out;
    }
    case "fill": {
      onlyKeys(a, ["op", "fields"], "action fill");
      const f = a["fields"];
      if (!Array.isArray(f) || f.length < 1 || f.length > 20) throw new IpcHandlerError("bad_request", "fields must be a list of 1 to 20 fields");
      const fields = f.map((x, i) => {
        const o = obj(x, `fields[${i}]`);
        onlyKeys(o, ["ref", "value"], `fields[${i}]`);
        return { ref: browserRef(o["ref"], `fields[${i}].ref`), value: browserTyped(o["value"], `fields[${i}].value`) };
      });
      return { op, fields };
    }
    case "press": {
      onlyKeys(a, ["op", "key", "ref"], "action press");
      if (typeof a["key"] !== "string" || !(BROWSER_KEYS as readonly string[]).includes(a["key"])) throw new IpcHandlerError("bad_request", `key must be one of ${BROWSER_KEYS.join(", ")}`);
      const out: Extract<BrowserAction, { op: "press" }> = { op, key: a["key"] as BrowserKey };
      if (a["ref"] !== undefined) out.ref = browserRef(a["ref"], "ref");
      return out;
    }
    case "screenshot": {
      onlyKeys(a, ["op", "fullPage"], "action screenshot");
      return a["fullPage"] === undefined ? { op } : { op, fullPage: browserBool(a["fullPage"], "fullPage") };
    }
    case "done":
      onlyKeys(a, ["op", "summary"], "action done");
      return { op, summary: browserText(a["summary"], "summary", 2000) };
    default:
      throw new IpcHandlerError("bad_request", "action.op is not a known browser operation");
  }
}

/** Strict: only `jobId`, `callId` and `action`; each op takes only its own keys, with the limits of `browserContracts.ts`. */
export function parseBrowserActionBody(body: JsonObject): BrowserActionBody {
  onlyKeys(body, ["jobId", "callId", "action"], "browser_action");
  if (typeof body["callId"] !== "string" || !BROWSER_CALL_ID.test(body["callId"])) throw new IpcHandlerError("bad_request", "callId must be 1 to 100 letters, digits, _ . : or -");
  return { jobId: jobIdOf(body["jobId"]), callId: body["callId"], action: parseBrowserAction(body["action"]) };
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
      case "browser_action":
        return (await manager.browserAction(parseBrowserActionBody(body))) as unknown as Json;
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
