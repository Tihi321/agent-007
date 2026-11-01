/**
 * Job approval (S14.3): what the approval card says, how the task waits for the user's decision, and how permission
 * prompts inside a running job reach Telegram. The Telegram rendering is `src/telegram/jobUi.ts`; the texts and the rules
 * (every job approved, timeout means reject, only the allowlisted user's tap counts, Allow once or Deny, never "always")
 * are here, so both can be tested without a bot.
 */
import type { Logger } from "../contracts.js";
import type {
  CloudUse,
  JobApprovalCard,
  JobApprovalDecision,
  JobApprovalTransport,
  JobRunnerClient,
  JobTemplateSummary,
  JsonObject,
  PermissionDecision,
  PermissionRequest,
} from "./contracts.js";

/** The card line for templates with `paidModels: true` (Scriptorium and book templates), word for word from the plan (U47). */
export const PAID_MODELS_NOTICE =
  "This job may use paid models, per the tools' model settings (~\\Scriptorium\\config\\roles.md, ~\\VisualNovels\\config\\roles.md, and for Book Translator ~\\BookTranslator\\config\\defaults.json and providers.md). agent-007 does not estimate or cap their cost.";

/** The card line for templates with `autostart` (VN Studio). */
export const AUTOSTART_NOTICE = "VN Studio may start Pixel Studio, Chiptune Studio and ComfyUI.";

/** A brief longer than this is always sent in full, in extra messages, before the card (S14.3). */
export const INLINE_BRIEF_MAX_CHARS = 3500;

export const CLOUD_LABELS: Record<CloudUse, string> = {
  "claude-subscription": "Claude subscription",
  "deepseek-api": "DeepSeek API",
  "google-flow": "Google Flow",
};

/** Cloud services a template uses: what the runner says, plus Flow when the template spends credits. */
export function cloudUseFor(template: JobTemplateSummary): CloudUse[] {
  const out = new Set<CloudUse>(template.cloud);
  if (template.flow.enabled) out.add("google-flow");
  return [...out];
}

export interface BuildCardInput {
  jobId: string;
  conversationId: string;
  template: JobTemplateSummary;
  params: JsonObject;
  brief: string;
  flowEstimateCredits?: number | undefined;
  /** Epoch ms of the first ask (kept across restarts, so the deadline does not move). */
  askedAt: number;
  timeoutSec: number;
}

export function buildJobCard(i: BuildCardInput): JobApprovalCard {
  return {
    jobId: i.jobId,
    conversationId: i.conversationId,
    template: i.template,
    params: i.params,
    brief: i.brief,
    cwd: i.template.cwd,
    engine: i.template.engine,
    cloud: cloudUseFor(i.template),
    ...(i.flowEstimateCredits !== undefined ? { flowEstimateCredits: i.flowEstimateCredits } : {}),
    paidModels: i.template.paidModels,
    autostart: i.template.autostart,
    timeoutSec: i.timeoutSec,
    deadline: i.askedAt + i.timeoutSec * 1000,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function formatParams(params: JsonObject, max = 600): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return "(none)";
  try {
    return clip(JSON.stringify(params), max);
  } catch {
    return "(unprintable)";
  }
}

/**
 * The lines of the card around the brief: template, engine, cwd, params, cloud use, the Flow estimate, the paid-models
 * line and the autostart line. The caller adds the brief and the expiry.
 */
export function cardLines(card: JobApprovalCard): string[] {
  const lines = [
    `Template: ${card.template.id}${card.template.title ? ` (${clip(card.template.title, 80)})` : ""}`,
    `Engine: ${card.engine}`,
    `Cwd: ${clip(card.cwd, 200)}`,
    `Params: ${formatParams(card.params)}`,
    `Uses cloud: ${card.cloud.length === 0 ? "no" : card.cloud.map((c) => CLOUD_LABELS[c]).join(", ")}`,
  ];
  if (card.flowEstimateCredits !== undefined) {
    lines.push(`Flow estimate: ${card.flowEstimateCredits} credits. Approving approves exactly this number for this job; no other Flow budget is spent.`);
  }
  if (card.paidModels) lines.push(PAID_MODELS_NOTICE);
  if (card.autostart.length > 0) lines.push(`${AUTOSTART_NOTICE} (${card.autostart.join(", ")})`);
  lines.push(`Approval timeout: ${card.timeoutSec} s (no answer means reject).`);
  return lines;
}

// ---- waiting for the decision -----------------------------------------------------------------------

export type ApprovalOutcome =
  | { type: "decided"; decision: JobApprovalDecision }
  /** The Harness is closing (restart): nothing is decided; the task asks again when it resumes. */
  | { type: "closing" }
  /** The user (or the model, through `cancel_job`) cancelled the job while it waited for approval. */
  | { type: "cancelled" };

export interface WaitForApprovalOptions {
  transport: JobApprovalTransport;
  card: JobApprovalCard;
  /** The task's own abort signal (Harness close). */
  signal: AbortSignal;
  /** Aborted by `cancel_job`. */
  cancel?: AbortSignal | undefined;
  now: () => number;
  /** Wait before asking again after the transport failed (Telegram down). */
  retryDelayMs: number;
  logger?: Logger | undefined;
}

function sleepAbortable(ms: number, signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((s) => s.aborted)) return resolve();
    const done = (): void => {
      clearTimeout(t);
      for (const s of signals) s.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    for (const s of signals) s.addEventListener("abort", done, { once: true });
  });
}

/**
 * Asks the transport and races it against the deadline, the task's own signal and a cancel. Only an explicit approval
 * from the user counts: a transport answer must carry `approved: true`, `by: "user"` and a numeric user id. A failed card
 * delivery is retried until the deadline; the deadline passing is a rejection (`by: "timeout"`).
 */
export async function waitForApproval(o: WaitForApprovalOptions): Promise<ApprovalOutcome> {
  const { card } = o;
  const decided = (approved: boolean, by: JobApprovalDecision["by"], extra: Partial<JobApprovalDecision> = {}): ApprovalOutcome => ({
    type: "decided",
    decision: { approved, by, at: o.now(), ...extra },
  });
  for (;;) {
    if (o.signal.aborted) return { type: "closing" };
    if (o.cancel?.aborted) return { type: "cancelled" };
    const left = card.deadline - o.now();
    if (left <= 0) return decided(false, "timeout");

    const ac = new AbortController();
    const link = (): void => ac.abort();
    let deadlineHit = false;
    o.signal.addEventListener("abort", link, { once: true });
    o.cancel?.addEventListener("abort", link, { once: true });
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      link();
    }, Math.min(2 ** 31 - 1, left));
    // A transport is expected to settle when its signal aborts; the race makes the deadline hold even if it does not.
    const stopped = new Promise<"stopped">((resolve) => ac.signal.addEventListener("abort", () => resolve("stopped"), { once: true }));
    let result: JobApprovalDecision | { error: unknown } | "stopped";
    try {
      result = await Promise.race([o.transport.requestJobApproval(card, ac.signal), stopped]);
    } catch (error) {
      result = { error };
    } finally {
      clearTimeout(deadlineTimer);
      o.signal.removeEventListener("abort", link);
      o.cancel?.removeEventListener("abort", link);
      if (!ac.signal.aborted) ac.abort(); // lets the transport clean up its card
    }
    if (o.signal.aborted) return { type: "closing" };
    if (o.cancel?.aborted) return { type: "cancelled" };
    if (deadlineHit || o.now() >= card.deadline) return decided(false, "timeout");
    if (result === "stopped") return { type: "closing" };
    if ("error" in result) {
      o.logger?.warn("jobs.approval_transport_failed", { jobId: card.jobId, error: result.error instanceof Error ? result.error.message : "error" });
      await sleepAbortable(o.retryDelayMs, [o.signal, ...(o.cancel ? [o.cancel] : [])]);
      continue;
    }
    const d = result;
    if (d.approved === true && d.by === "user" && typeof d.userId === "number") {
      return { type: "decided", decision: { approved: true, by: "user", userId: d.userId, at: d.at, ...(d.approvedCredits !== undefined ? { approvedCredits: d.approvedCredits } : {}) } };
    }
    // Anything else, including a claimed approval that is not an explicit user tap, is a rejection.
    return { type: "decided", decision: { approved: false, by: d.approved === true ? "user" : d.by, ...(d.userId !== undefined ? { userId: d.userId } : {}), at: d.at } };
  }
}

/** The text the model gets when a job was not approved. */
export function rejectionText(by: JobApprovalDecision["by"]): string {
  switch (by) {
    case "user":
      return "The user rejected this job. It was not started. Do not dispatch it again unless the user asks.";
    case "timeout":
      return "The approval request timed out with no answer, so the job was not started. Tell the user; do not retry unless they ask.";
    case "stop":
      return "The approval was cancelled with /stop, so the job was not started.";
    case "restart-expired":
      return "The approval expired while the agent was restarting, so the job was not started. Ask again only if the user still wants it.";
  }
}

// ---- permission prompts inside a running job ---------------------------------------------------------

export interface PermissionRelayOptions {
  client: Pick<JobRunnerClient, "answerPermission">;
  transport: JobApprovalTransport;
  conversationId: string;
  logger?: Logger | undefined;
  now: () => number;
}

/**
 * Sends each permission request of a job to Telegram (Allow once or Deny) and gives the answer to the job runner. A
 * request id is asked once while it is pending or answered; the runner may repeat one after a reconnect. Only
 * `allow_once` and `deny` exist: any other answer from the transport is a deny. On `dispose()` (the task's invocation
 * ended, for example a restart) pending cards are cancelled and nothing is answered; the job runner still holds the
 * request, and the next invocation asks again.
 */
export class PermissionRelay {
  readonly #o: PermissionRelayOptions;
  readonly #seen = new Set<string>();
  readonly #pending = new Map<string, AbortController>();
  #disposed = false;

  constructor(opts: PermissionRelayOptions) {
    this.#o = opts;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  handle(req: PermissionRequest): void {
    if (this.#disposed || this.#seen.has(req.requestId)) return;
    this.#seen.add(req.requestId);
    const ac = new AbortController();
    this.#pending.set(req.requestId, ac);
    void this.#ask(req, ac);
  }

  /** Denies every pending prompt (the job was cancelled or finished) and answers the runner. */
  cancelAll(by: "cancel" | "stop" = "cancel"): void {
    for (const [id, ac] of [...this.#pending]) {
      this.#pending.delete(id);
      ac.abort(by);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const ac of this.#pending.values()) ac.abort("dispose");
    this.#pending.clear();
  }

  async #ask(req: PermissionRequest, ac: AbortController): Promise<void> {
    const o = this.#o;
    let answer: PermissionDecision;
    try {
      const raw = await o.transport.requestPermission(req, o.conversationId, ac.signal);
      answer = {
        requestId: req.requestId,
        jobId: req.jobId,
        answer: raw.answer === "allow_once" && raw.by === "user" ? "allow_once" : "deny",
        by: raw.by,
        ...(raw.userId !== undefined ? { userId: raw.userId } : {}),
        at: raw.at,
        ...(raw.message !== undefined ? { message: raw.message } : {}),
      };
    } catch (e) {
      o.logger?.warn("jobs.permission_card_failed", { jobId: req.jobId, error: e instanceof Error ? e.message : "error" });
      answer = { requestId: req.requestId, jobId: req.jobId, answer: "deny", by: "policy", at: o.now(), message: "the permission prompt could not be delivered" };
    }
    if (this.#disposed || ac.signal.reason === "dispose") return;
    this.#pending.delete(req.requestId);
    try {
      await o.client.answerPermission(answer);
    } catch (e) {
      // The runner is offline: its request will time out there, or be asked again after the reconnect.
      this.#seen.delete(req.requestId);
      o.logger?.warn("jobs.permission_answer_failed", { jobId: req.jobId, error: e instanceof Error ? e.name : "error" });
    }
  }
}
