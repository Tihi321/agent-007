/**
 * The approval gate (S3.3, D5): a `beforeTool` handler for the `shell` tool. Every command needs one approval;
 * decisions and the ask time are kept in `api.memo`, so the deadline and the decision survive a restart.
 *
 *   not "shell"                      -> pass through
 *   kill switch on                   -> block
 *   decision memo exists             -> use it, never ask again
 *   asked memo (first writer wins)   -> the deadline is askedAt + approvalTimeoutSec, kept across restarts
 *   deadline passed                  -> deny (`timeout`, or `restart-expired` if this is a rerun after a restart)
 *   else                             -> ask the transport; abort on kill switch, /stop or the deadline
 *
 * An approval grants a one-shot token that the shell tool consumes (tokens.ts).
 */
import type { ApprovalDecision, ApprovalDecisionBy, ApprovalRequest, ApprovalTransport, AuditLog, ChatLookup, KillSwitch, Logger, PeerProvenance } from "../contracts.js";
import type { ShellConfig } from "../config/schema.js";
import type { BeforeToolHandler, Context, HookApi, ToolHookCall } from "../pi/adapter.js";
import { approvalKey, sha256Command } from "../shell/tool.js";
import { effectiveTimeoutSec } from "../shell/runner.js";
import type { ApprovalTokens } from "./tokens.js";

export const MAX_COMMAND_CHARS = 2000;
export const DECISION_MEMO_PREFIX = "a7.approval.decision:";
export const ASKED_MEMO_PREFIX = "a7.approval.asked:";

export interface ApprovalGateDeps {
  transport: ApprovalTransport;
  killSwitch: KillSwitch & { blockReason?: () => "killswitch" | "disabled" };
  chats: ChatLookup;
  approvals: ApprovalTokens;
  audit: AuditLog;
  /** Re-read on every call (`approvalTimeoutSec`, exec timeout limits). */
  getShellConfig: () => ShellConfig;
  /** Working directory shown on the approval card (the workspace). */
  cwd: string;
  logger?: Logger;
  now?: () => number;
  /** How often the gate re-checks the kill switch while waiting (catches the flag file and config sources). */
  pollMs?: number;
  /** Phase 4 (S26.2): the peer replies the conversation's current turn received, to quote on the card. Absent in a one-bot install. */
  provenanceFor?: ((conversationId: string) => readonly PeerProvenance[] | undefined) | undefined;
}

/** What the decision memo stores: the decision plus the hash of the command it applies to. */
interface StoredDecision {
  approved: boolean;
  by: ApprovalDecisionBy;
  at: number;
  userId?: number;
  commandSha256: string;
}

interface AskedMemo {
  askedAt: number;
}

export interface ApprovalGate {
  beforeTool: BeforeToolHandler;
  /** Cancel the pending approvals of one conversation (`/stop`) with the given reason. Returns how many. */
  cancelConversation(conversationId: string, by?: "stop" | "killswitch"): number;
  pendingCount(): number;
}

/** Memo reads and writes, typed locally (the memo's JSON type is Pi's own, and our records are plain JSON). */
function memoRead(api: HookApi, name: string, ctx: Context): Promise<unknown> {
  return api.memo(name, ctx) as Promise<unknown>;
}
function memoWrite<T extends object>(api: HookApi, name: string, candidate: T, ctx: Context): Promise<T> {
  return api.memo(name, candidate as never, ctx) as unknown as Promise<T>;
}

export function denyText(d: { by: ApprovalDecisionBy; approved?: boolean }): string {
  switch (d.by) {
    case "user":
      return "The user denied this shell command. Do not retry it or work around the denial; tell the user it was not run.";
    case "timeout":
      return "The approval request timed out with no answer, so the command was not run. Tell the user; do not retry unless they ask.";
    case "killswitch":
      return "Shell is disabled (kill switch).";
    case "stop":
      return "The request was cancelled with /stop, so the command was not run.";
    case "restart-expired":
      return "The approval expired while the agent was restarting, so the command was not run. Ask again only if the user still wants it.";
    case "invalid":
      return `The command is invalid (it must be 1 to ${MAX_COMMAND_CHARS} characters), so it was not run and no approval was requested.`;
  }
}

function toStored(d: ApprovalDecision, commandSha256: string): StoredDecision {
  const out: StoredDecision = { approved: d.approved, by: d.by, at: d.at, commandSha256 };
  if (d.userId !== undefined) out.userId = d.userId;
  return out;
}

function fromStored(s: StoredDecision): ApprovalDecision {
  const out: ApprovalDecision = { approved: s.approved, by: s.by, at: s.at };
  if (s.userId !== undefined) out.userId = s.userId;
  return out;
}

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 1000;

  interface Pending {
    conversationId: string;
    cancel: (by: "stop" | "killswitch") => void;
  }
  const pending = new Set<Pending>();

  // One listener for the whole gate (KillSwitch has no unsubscribe): a kill switch change cancels everything pending.
  deps.killSwitch.onChange(() => {
    if (!deps.killSwitch.isOn()) return;
    for (const p of [...pending]) p.cancel("killswitch");
  });

  const blockText = (): string => "Shell is disabled (kill switch).";

  async function beforeTool(call: ToolHookCall, api: HookApi, ctx: Context): Promise<{ block: string } | undefined> {
    if (call.name !== "shell") return undefined;

    const conversationId = String(api.conversationId);
    const key = approvalKey(conversationId, call.id);
    const args = call.arguments as { command?: unknown; reason?: unknown; timeoutSec?: unknown };
    const command = typeof args.command === "string" ? args.command : "";

    // 1. kill switch
    if (deps.killSwitch.isOn()) {
      deps.audit.write({ event: "blocked", ts: new Date(now()).toISOString(), id: key, command, reason: deps.killSwitch.blockReason?.() ?? "killswitch" });
      return { block: blockText() };
    }

    // 2. invalid command: never asked, never run
    if (command.trim() === "" || command.length > MAX_COMMAND_CHARS) {
      deps.logger?.warn("approval.invalid_command", { key, length: command.length });
      const at = now();
      deps.audit.write({ event: "decided", ts: new Date(at).toISOString(), id: key, approved: false, by: "invalid", at });
      return { block: denyText({ by: "invalid" }) };
    }
    const commandSha = sha256Command(command);

    // 3. a decision already memoised: never ask again (the hook reruns after a restart)
    const existing = await memoRead(api, `${DECISION_MEMO_PREFIX}${key}`, ctx);
    if (existing !== undefined && existing !== null) {
      const stored = existing as StoredDecision;
      if (stored.commandSha256 !== commandSha) {
        deps.logger?.error("approval.memo_command_mismatch", { key });
        return { block: "Approval record does not match this command, so it was not run." };
      }
      if (stored.approved) {
        deps.approvals.grant(key, commandSha);
        return undefined;
      }
      return { block: denyText(stored) };
    }

    // 4. deadline: first writer wins, so the original ask time survives a restart
    const cfg = deps.getShellConfig();
    // `rerun` = the ask time was already stored by an earlier run of this hook, that is, the process restarted.
    const rerun = (await memoRead(api, `${ASKED_MEMO_PREFIX}${key}`, ctx)) !== undefined;
    const candidate: AskedMemo = { askedAt: now() };
    const asked = await memoWrite(api, `${ASKED_MEMO_PREFIX}${key}`, candidate, ctx);
    const deadline = asked.askedAt + cfg.approvalTimeoutSec * 1000;

    const chatId = deps.chats.chatForConversation(conversationId);
    if (chatId === undefined) {
      deps.logger?.warn("approval.no_chat", { key });
      return { block: "No Telegram chat is linked to this conversation, so approval cannot be requested and the command was not run." };
    }

    const provenance = deps.provenanceFor?.(conversationId);
    const request: ApprovalRequest = {
      key,
      conversationId,
      chatId,
      ...(provenance !== undefined && provenance.length > 0 ? { provenance } : {}),
      tool: "shell",
      command,
      reason: typeof args.reason === "string" ? args.reason : "",
      cwd: deps.cwd,
      timeoutSec: effectiveTimeoutSec(typeof args.timeoutSec === "number" ? args.timeoutSec : undefined, cfg),
      deadline,
    };
    deps.audit.write({
      event: "requested",
      ts: new Date(now()).toISOString(),
      id: key,
      conversationId,
      chatId,
      command,
      reason: request.reason,
      cwd: request.cwd,
      deadline,
    });

    let decision: ApprovalDecision;
    if (now() >= deadline) {
      decision = { approved: false, by: rerun ? "restart-expired" : "timeout", at: now() };
    } else {
      try {
        decision = await waitForDecision(request, conversationId, ctx);
      } catch (e) {
        // The transport failed (for example Telegram is down). Nothing is memoised, so the hook can ask again later.
        deps.logger?.error("approval.transport_failed", { key, error: e instanceof Error ? e.message : String(e) });
        return { block: "The approval request could not be delivered, so the command was not run." };
      }
    }

    // 5. first writer wins
    const finalStored = await memoWrite(api, `${DECISION_MEMO_PREFIX}${key}`, toStored(decision, commandSha), ctx);
    const final = fromStored(finalStored);
    deps.audit.write({
      event: "decided",
      ts: new Date(now()).toISOString(),
      id: key,
      approved: final.approved,
      by: final.by,
      ...(final.userId !== undefined ? { userId: final.userId } : {}),
      at: final.at,
    });
    if (final.approved) {
      // A late kill switch beats an approval that landed just before it.
      if (deps.killSwitch.isOn()) return { block: blockText() };
      deps.approvals.grant(key, commandSha);
      return undefined;
    }
    return { block: denyText(final) };
  }

  /** Ask the transport and race it against the kill switch, /stop (context abort) and the deadline. */
  function waitForDecision(request: ApprovalRequest, conversationId: string, ctx: Context): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const ac = new AbortController();
      let settled = false;
      let poll: NodeJS.Timeout | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        pending.delete(entry);
        if (poll) clearInterval(poll);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        ctx.abortSignal?.removeEventListener("abort", onStop);
      };
      const settle = (d: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!ac.signal.aborted) ac.abort(); // lets the transport clean up its card
        resolve(d);
      };
      const cancel = (by: ApprovalDecisionBy): void => settle({ approved: false, by, at: now() });
      const entry = { conversationId, cancel: (by: "stop" | "killswitch") => cancel(by) };
      const onStop = (): void => cancel("stop");

      pending.add(entry);
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) {
          cancel("stop");
          return;
        }
        ctx.abortSignal.addEventListener("abort", onStop, { once: true });
      }
      deadlineTimer = setTimeout(() => cancel("timeout"), Math.max(0, request.deadline - now()));
      poll = setInterval(() => {
        if (deps.killSwitch.isOn()) cancel("killswitch");
      }, pollMs);
      poll.unref?.();

      deps.transport.request(request, ac.signal).then(
        (d) => {
          if (settled) return;
          // A transport answer that claims approval is only trusted as an explicit decision object.
          settle({ approved: d.approved === true, by: d.by, at: d.at, ...(d.userId !== undefined ? { userId: d.userId } : {}) });
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e);
        },
      );
    });
  }

  return {
    beforeTool: beforeTool as BeforeToolHandler,
    cancelConversation(conversationId, by = "stop") {
      let n = 0;
      for (const p of [...pending]) {
        if (p.conversationId === conversationId) {
          p.cancel(by);
          n++;
        }
      }
      return n;
    },
    pendingCount: () => pending.size,
  };
}
