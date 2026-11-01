/**
 * Phase 2 shared contracts (S9.4). Pure types, constants and small pure helpers. This file imports nothing: not the Pi
 * packages (the job runner must not import them), not config, not the IPC code. Slices 10 to 14 build against it in
 * parallel with fakes:
 *
 *   S10  src/mcp/**              uses `ALWAYS_LOADED`, `JobApprovalTransport` (hub_start cards), `HubStartBody`
 *   S11  src/jobrunner core      implements `JobRunnerPolicy`, uses `EngineDriver`, `JobTemplate`, the IPC bodies
 *   S12  claude driver           implements `EngineDriver` (uses `EngineHost`, `JobRunnerPolicy`)
 *   S13  dsh driver              implements `EngineDriver`
 *   S14  src/jobs/**             implements `JobApprovalTransport`, uses `JobRunnerClient` (the agent side of IPC)
 *
 * The wire format is src/ipc/protocol.ts; its message bodies are the `*Body` / `*Reply` types here.
 */

// ---- JSON --------------------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---- I27: the always-loaded tool list ------------------------------------------------------------

/**
 * The tools the model is always offered (Phases 1 to 3 and, per bot, Phase 4): exactly 10, a code constant. Config cannot
 * add to it. Every other tool is registered with `deferred: true` and found through `tool_search`.
 */
export const ALWAYS_LOADED = [
  "tool_search",
  "dispatch_job",
  "job_status",
  "cancel_job",
  "list_templates",
  "ask_user",
  "hub_status",
  "system_facts",
  "list_dir",
  "read_file",
] as const;
export type AlwaysLoadedName = (typeof ALWAYS_LOADED)[number];
export const MAX_ALWAYS_LOADED = 10;

/** Phase 1 tools that become deferred from Phase 2 (S15.1), and `hub_start`. Names only; schemas are unchanged. */
export const DEFERRED_PHASE1_TOOLS = ["search_files", "write_file", "remember", "shell"] as const;
/** Other known deferred tool names. MCP tools (`mcp__<server>__<tool>`) and macros are deferred too. */
export const DEFERRED_KNOWN_TOOLS = [
  ...DEFERRED_PHASE1_TOOLS,
  "hub_start",
  "ask_second_opinion",
  "get_settings",
  "list_personas",
  "propose_setting",
  "propose_persona",
  "switch_persona",
  "ask_bot",
  "list_bots",
] as const;

/** The two fields of a tool registration the cap check reads (`ToolRegistration` from the adapter fits). */
export interface ToolLike {
  readonly name: string;
  readonly deferred?: boolean | undefined;
}

export interface ToolCapReport {
  /** True when the non-deferred set is within the cap and (unless `subset`) equals `ALWAYS_LOADED`. */
  ok: boolean;
  nonDeferred: string[];
  /** Non-deferred tools that are not in `ALWAYS_LOADED`. */
  unexpected: string[];
  /** `ALWAYS_LOADED` names that are not registered as non-deferred (only checked when `subset` is false). */
  missing: string[];
  tooMany: boolean;
}

/** Names of the tools that are not deferred, in registration order. */
export function nonDeferredNames(tools: Iterable<ToolLike>): string[] {
  const out: string[] = [];
  for (const t of tools) if (t.deferred !== true) out.push(t.name);
  return out;
}

/**
 * The I27 cap check, for the registry-count tests of S10.2, S14.2 and S15.1. `subset: true` is the per-bot form
 * (Phase 4: an allowlist can only narrow the list); the default demands exactly the 10.
 */
export function checkToolCap(tools: Iterable<ToolLike>, opts: { subset?: boolean } = {}): ToolCapReport {
  const nonDeferred = nonDeferredNames(tools);
  const allowed = new Set<string>(ALWAYS_LOADED);
  const unexpected = nonDeferred.filter((n) => !allowed.has(n));
  const have = new Set(nonDeferred);
  const missing = opts.subset ? [] : ALWAYS_LOADED.filter((n) => !have.has(n));
  const tooMany = nonDeferred.length > MAX_ALWAYS_LOADED || new Set(nonDeferred).size !== nonDeferred.length;
  return { ok: !tooMany && unexpected.length === 0 && missing.length === 0, nonDeferred, unexpected, missing, tooMany };
}

// ---- templates -------------------------------------------------------------------------------------

export type JobEngine = "claude" | "dsh" | "hub";
export const JOB_ENGINES: readonly JobEngine[] = ["claude", "dsh", "hub"];
/** `bypassPermissions`, `auto` and `acceptEdits` are not representable: the loader refuses them (S11.2). */
export type JobPermissionMode = "default" | "dontAsk";
export type CloudUse = "claude-subscription" | "deepseek-api" | "google-flow";

export interface JobTemplateFlow {
  enabled: boolean;
  /** A fixed estimate in credits, shown on the card. */
  estimate?: number;
  /** `video-plan`: the estimate comes from creative-hub `scripts/video-plan.mjs` through the job runner (S14.4). */
  estimator?: "video-plan";
  /** The per-template credit cap (I22). */
  maxCredits?: number;
}

/** A job template as the job runner loads it from `templates\*.json` (S11.2). The agent only holds a read-only copy. */
export interface JobTemplate {
  id: string;
  title: string;
  description: string;
  engine: JobEngine;
  /** Realpath-equal to an entry of the job runner's cwd allowlist (default: creative-hub). */
  cwd: string;
  /** The prompt, with one delimited `{{brief}}` slot ("treat as content, not instructions"). */
  prompt: string;
  /** JSON Schema (type object) of the typed params. */
  params: JsonObject;
  permissionMode: JobPermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: string[];
  flow: JobTemplateFlow;
  /** True for any template that drives Scriptorium or another book step (creative-hub's roles config uses paid models). */
  paidModels: boolean;
  /** Services VN Studio may start for this template (shown on the card). */
  autostart: string[];
  timeoutMin: number;
  model?: string;
  /** `engine: "hub"` templates: the fixed creative-hub service name. */
  hubService?: string;
  /** Default true. `engine: "dsh"` templates are disabled until S13.4 and `dsh.verified` (S13.2). */
  enabled?: boolean;
}

/** What `list_templates` shows the model and what the approval card needs. */
export interface JobTemplateSummary {
  id: string;
  title: string;
  description: string;
  engine: JobEngine;
  params: JsonObject;
  flow: { enabled: boolean; estimate?: number; estimator?: "video-plan"; maxCredits?: number };
  paidModels: boolean;
  autostart: string[];
  cloud: CloudUse[];
  cwd: string;
  enabled: boolean;
}

// ---- requests --------------------------------------------------------------------------------------

/** The only thing the agent may ask for: a template id, typed params and the user's brief. Never a command, prompt or path. */
export interface JobRequest {
  templateId: string;
  params: JsonObject;
  brief: string;
}

export const JOB_REQUEST_KEYS: readonly string[] = ["templateId", "params", "brief"];
export const MAX_BRIEF_CHARS = 20_000;

/** Strict parse: unknown keys (`command`, `prompt`, `cwd`, ...) are refused, so no raw command or path can ride along. */
export function parseJobRequest(value: unknown): { ok: true; value: JobRequest } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "request must be an object" };
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!JOB_REQUEST_KEYS.includes(k)) return { ok: false, error: `unknown field "${k}" (only templateId, params and brief are accepted)` };
  if (typeof o["templateId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(o["templateId"])) return { ok: false, error: "templateId must be a template id" };
  const params = o["params"] ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return { ok: false, error: "params must be an object" };
  const brief = o["brief"] ?? "";
  if (typeof brief !== "string") return { ok: false, error: "brief must be a string" };
  if (brief.length > MAX_BRIEF_CHARS) return { ok: false, error: `brief is longer than ${MAX_BRIEF_CHARS} characters` };
  return { ok: true, value: { templateId: o["templateId"], params: params as JsonObject, brief } };
}

// ---- state and events ------------------------------------------------------------------------------

export const JOB_STATES = ["queued", "running", "interrupted", "cancelling", "succeeded", "failed", "cancelled", "rejected"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES = ["succeeded", "failed", "cancelled", "rejected"] as const;
export type TerminalJobState = (typeof TERMINAL_JOB_STATES)[number];
export function isTerminalJobState(s: JobState): s is TerminalJobState {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(s);
}

interface JobEventBase {
  jobId: string;
  /** Per job, starting at 1 and gapless. `status {sinceSeq}` returns the events after it. */
  seq: number;
  /** Epoch milliseconds, job runner clock. */
  ts: number;
}

/**
 * Engine output, already parsed (stream-json for Claude, ACP updates for DeepSeek). Streamed text, tool calls and results
 * are untrusted before the model sees them (S14.6). The last two events of a job are `result` then a terminal `state`.
 */
export type JobEvent = JobEventBase &
  (
    | { kind: "state"; state: JobState; detail?: string }
    | { kind: "init"; engineSessionId?: string; engineVersion?: string; tools?: string[] }
    | { kind: "text"; text: string }
    | { kind: "tool_call"; callId?: string; tool: string; input: Json }
    | { kind: "tool_result"; callId?: string; tool: string; ok: boolean; text?: string }
    | { kind: "progress"; message: string; fraction?: number }
    | { kind: "retry"; attempt: number; reason: string }
    | { kind: "flow_call"; tool: string; maxCredits: number; allowed: boolean; chargedTotal: number; remaining: number }
    | { kind: "result"; text: string; costUsd?: number; durationMs?: number; permissionDenials?: number }
  );
export type JobEventKind = JobEvent["kind"];

export interface JobFlowSummary {
  approved: number;
  /** Sum of the `max_credits` of the allowed Flow calls. */
  charged: number;
  /** Parsed from results when the server reports it. */
  reported?: number;
}

export interface JobDone {
  jobId: string;
  state: TerminalJobState;
  summary: string;
  artifacts: string[];
  exitCode?: number;
  durationMs: number;
  costUsd?: number;
  flow?: JobFlowSummary;
  engineVersion?: string;
  error?: string;
}

/** The current picture of one job, from `status`. */
export interface JobSnapshot {
  jobId: string;
  templateId: string;
  engine: JobEngine;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Highest event `seq` so far. */
  lastSeq: number;
  engineSessionId?: string;
  engineVersion?: string;
  /** Permission requests waiting for the user. */
  pendingPermissions: PermissionRequest[];
  flow?: JobFlowSummary;
  /** Present once the job is terminal. */
  done?: JobDone;
}

// ---- permissions (S12.3, S13.3) --------------------------------------------------------------------

export type PermissionKind = "execute" | "read" | "edit" | "flow" | "other";

/** Runner to agent. The runner fills `engine`, `cwd`, `kind`, `requestedAt` and `timeoutSec` before forwarding. */
export interface PermissionRequest {
  requestId: string;
  jobId: string;
  engine: JobEngine;
  tool: string;
  input: Json;
  cwd: string;
  kind: PermissionKind;
  /** One line for the card, built by the driver. */
  summary?: string;
  requestedAt: number;
  timeoutSec: number;
}

/** Permission helper to runner (S12.3): signed with the per-job token (I28), not the agent key. */
export interface PermissionHelperRequest {
  requestId: string;
  jobId: string;
  tool: string;
  input: Json;
}
export interface PermissionHelperReply {
  decision: PermissionAnswer;
  message?: string;
}

/** Only these two. "Always" options are never offered or applied (I19, S13.3). */
export type PermissionAnswer = "allow_once" | "deny";
export type PermissionDecider = "user" | "timeout" | "cancel" | "stop" | "restart" | "policy";

/** Agent to runner. */
export interface PermissionDecision {
  requestId: string;
  jobId: string;
  answer: PermissionAnswer;
  by: PermissionDecider;
  userId?: number;
  at: number;
  message?: string;
}

/** What the job runner's own policy says before any user is asked (S11, used by S12 and S13). */
export type PolicyVerdict = "allow" | "deny" | "ask";

export interface JobRef {
  jobId: string;
  templateId: string;
  engine: JobEngine;
  /** The credits the user approved for this job (D11). */
  flowBudgetCredits?: number;
  /** Credits already charged (sum of `max_credits` of allowed calls). */
  flowChargedCredits?: number;
}

export interface JobRunnerPolicy {
  /** Own rules first: Flow budget (I21), the Scriptorium start always denied, shell kinds denied; otherwise `ask`. */
  checkPermission(job: JobRef, tool: string, input: Json): PolicyVerdict | Promise<PolicyVerdict>;
}

// ---- engines (S12, S13) ----------------------------------------------------------------------------

/** What the core (S11) hands to a driver. */
export interface EngineHost {
  readonly policy: JobRunnerPolicy;
  /**
   * The driver calls this when its policy check said `ask`. The core sends `permission_request` to the agent and resolves
   * with the user's answer, or `deny` on timeout or cancel.
   */
  askPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

export interface EngineStartSpec {
  jobId: string;
  template: JobTemplate;
  params: JsonObject;
  brief: string;
  /** The template prompt with the brief inserted in its delimited slot. */
  prompt: string;
  /** The validated, realpath-checked cwd. */
  cwd: string;
  flowBudgetCredits?: number;
  host: EngineHost;
}
export interface EngineResumeSpec extends EngineStartSpec {
  engineSessionId: string;
}

export interface EngineDriver {
  readonly engine: JobEngine;
  /** The CLI or dsh version string, recorded per job and compared by the version guard (S12.5, S13.4). */
  version(): Promise<string>;
  start(spec: EngineStartSpec): Promise<void>;
  /** `claude -p --resume` / ACP `session/resume`, with the same flags and a "continue" prompt. */
  resume(spec: EngineResumeSpec): Promise<void>;
  /** Events of one job in `seq` order; ends after the terminal `state` event. */
  events(jobId: string): AsyncIterable<JobEvent>;
  /** Tree kill (Claude) or `session/cancel` then a kill after a grace period (DeepSeek). */
  cancel(jobId: string): Promise<void>;
}

// ---- IPC message bodies (src/ipc/protocol.ts) -----------------------------------------------------

export interface ApprovalProof {
  /** The numeric Telegram user id that tapped Approve. The runner records it in its own audit. */
  userId: number;
  /** Epoch ms of the tap. */
  at: number;
}

/** `submit`. Idempotent on `jobId` (S14.1 re-attaches instead of submitting twice). `resume: true` continues an `interrupted` job. */
export interface SubmitBody {
  jobId: string;
  request: JobRequest;
  approval: ApprovalProof;
  /** The credits the user approved (D11). Required when the template has `flow.enabled`. */
  flowBudgetCredits?: number;
  resume?: boolean;
}
export interface SubmitReply {
  jobId: string;
  state: JobState;
  /** True when the `jobId` already existed (nothing was started a second time). */
  duplicate: boolean;
  queuePosition?: number;
}

export interface CancelBody {
  jobId: string;
  reason?: string;
}
export interface CancelReply {
  jobId: string;
  state: JobState;
}

export interface StatusBody {
  /** One job (with `sinceSeq`: its events after that seq), or every job when absent. */
  jobId?: string;
  sinceSeq?: number;
}
export interface EngineStatus {
  enabled: boolean;
  running: number;
  queued: number;
  version?: string;
}
export interface StatusReply {
  runner: { version: string; startedAt: number; now: number };
  engines: Partial<Record<JobEngine, EngineStatus>>;
  jobs: JobSnapshot[];
  /** Only with `jobId` and `sinceSeq`. */
  events?: JobEvent[];
  daily: { jobs: number; jobCap: number; credits: number; creditCap: number };
}

export type ListTemplatesBody = Record<string, never>;
export interface ListTemplatesReply {
  templates: JobTemplateSummary[];
}

export type HubStatusBody = Record<string, never>;
export interface HubServiceStatus {
  id: string;
  up: boolean;
  port?: number;
}
export interface HubStatusReply {
  services: HubServiceStatus[];
}

export interface HubStartBody {
  /** From the fixed list in creative-hub `services.json`. */
  service: string;
  /** Required (true) for `scriptorium`, together with its own warning card (S10.4, S11.5). */
  scriptoriumApproved?: boolean;
  approval: ApprovalProof;
}
export interface HubStartReply {
  service: string;
  started: boolean;
  alreadyUp?: boolean;
  message: string;
}

/**
 * S14.4 live estimate (U38): the job runner runs creative-hub `scripts/video-plan.mjs estimate <runDir>` (read only: it only
 * reads `<runDir>/plan.json` and prints the dry run) for a template with `flow.estimator: "video-plan"`. The template must
 * declare a string param `runDir` (a folder under `runs/` that already holds a plan.json).
 */
export interface FlowEstimateBody {
  templateId: string;
  params: JsonObject;
}
export interface FlowEstimateReply {
  /** The number put on the approval card: the video credits plus the 25% retake reserve (the dry run's "with the reserve"). */
  credits: number;
  videoCredits: number;
  reserve: number;
  runDir: string;
}

// ---- agent-side interfaces -------------------------------------------------------------------------

export type JobRunnerConnectionState = "connecting" | "online" | "offline";
export type Unsubscribe = () => void;
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The agent's view of the job runner (implemented by `IpcClient`, src/ipc/client.ts; faked in S10 and S14 tests). */
export interface JobRunnerClient {
  readonly state: JobRunnerConnectionState;
  /** Starts connecting (idempotent). Reconnects with backoff until `close()`. */
  start(): void;
  close(): Promise<void>;
  /** Resolves when `state` is `online`; rejects on abort or timeout. */
  waitOnline(opts?: CallOptions): Promise<void>;
  submit(body: SubmitBody, opts?: CallOptions): Promise<SubmitReply>;
  cancel(body: CancelBody, opts?: CallOptions): Promise<CancelReply>;
  status(body?: StatusBody, opts?: CallOptions): Promise<StatusReply>;
  listTemplates(opts?: CallOptions): Promise<ListTemplatesReply>;
  hubStatus(opts?: CallOptions): Promise<HubStatusReply>;
  hubStart(body: HubStartBody, opts?: CallOptions): Promise<HubStartReply>;
  /** Read-only: asks the job runner to run the template's Flow estimator (S14.4). */
  flowEstimate(body: FlowEstimateBody, opts?: CallOptions): Promise<FlowEstimateReply>;
  /** Fire and forget; rejects only when offline. */
  answerPermission(decision: PermissionDecision): Promise<void>;
  onJobEvent(cb: (event: JobEvent) => void): Unsubscribe;
  onPermissionRequest(cb: (req: PermissionRequest) => void): Unsubscribe;
  onJobDone(cb: (done: JobDone) => void): Unsubscribe;
  onStateChange(cb: (state: JobRunnerConnectionState) => void): Unsubscribe;
}

// ---- Telegram cards (implemented by S14, used by S10 and S14) ---------------------------------------

export interface JobApprovalCard {
  jobId: string;
  conversationId: string;
  template: JobTemplateSummary;
  params: JsonObject;
  /** The full brief. The card UI sends it in full (or with a "Show full brief" button) and enables Approve only afterwards. */
  brief: string;
  cwd: string;
  engine: JobEngine;
  cloud: CloudUse[];
  /** The Flow estimate in credits (D11); the user approves this number. */
  flowEstimateCredits?: number;
  paidModels: boolean;
  autostart: string[];
  timeoutSec: number;
  /** Epoch ms. */
  deadline: number;
}

export interface HubStartCard {
  conversationId: string;
  service: string;
  /** True for `scriptorium`: its own warning text ("resumes its whole book factory and may spend on paid models"). */
  scriptorium: boolean;
  warning?: string;
  timeoutSec: number;
  deadline: number;
}

export type JobApprovalDecider = "user" | "timeout" | "stop" | "restart-expired";
export interface JobApprovalDecision {
  approved: boolean;
  by: JobApprovalDecider;
  userId?: number;
  at: number;
  /** The credits the user approved, when the card showed an estimate. */
  approvedCredits?: number;
}

export interface JobProgressUpdate {
  jobId: string;
  conversationId: string;
  state: JobState;
  /** Plain text for the user (not wrapped; the model only ever gets wrapped text, S14.6). */
  text: string;
  eventCount: number;
}

export interface JobApprovalTransport {
  requestJobApproval(card: JobApprovalCard, signal: AbortSignal): Promise<JobApprovalDecision>;
  /** `hub_start` approval (S10.4); Scriptorium has its own text. */
  requestHubStartApproval(card: HubStartCard, signal: AbortSignal): Promise<JobApprovalDecision>;
  /** A permission prompt inside a running job: Allow once / Deny. */
  requestPermission(req: PermissionRequest, conversationId: string, signal: AbortSignal): Promise<PermissionDecision>;
  postProgress(update: JobProgressUpdate): Promise<void>;
  postFinal(done: JobDone, conversationId: string): Promise<void>;
}
