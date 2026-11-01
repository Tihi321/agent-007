/**
 * Approval cards for user tool calls (S34, I47). A card is shown ONLY in the web chat of the user whose bot asked; the token is random,
 * single use, expires, and is bound to that userId: another user's decision (or the owner's, or a forged id) is refused and audited.
 * Anything that touches the host, jobs or spend does not exist for user bots, so the cards here are about the user's own workspace.
 * The owner's own approvals (shell, jobs, Flow) stay on Telegram and never go through this broker.
 */
import { hashSecret, randomToken } from "../crypto.js";
import type { WebAudit } from "../audit.js";

export interface ApprovalCard {
  token: string;
  tool: string;
  summary: string;
  why: string;
  expiresAt: number;
}

interface Pending {
  userId: string;
  threadId: string;
  tokenHash: string;
  resolve(approved: boolean): void;
  timer: NodeJS.Timeout;
}

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export class ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #audit: WebAudit;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(audit: WebAudit, opts: { now?: () => number; timeoutMs?: number } = {}) {
    this.#audit = audit;
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  }

  /** Creates a card and waits for the user's decision. Resolves false on deny, on timeout and when the run is aborted. */
  request(userId: string, threadId: string, card: { tool: string; summary: string; why: string }, show: (c: ApprovalCard) => void, signal?: AbortSignal): Promise<boolean> {
    const token = randomToken(16);
    const tokenHash = hashSecret("approval", token);
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean, how: string): void => {
        const p = this.#pending.get(tokenHash);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(tokenHash);
        this.#audit.write({ kind: "approval", user: userId, detail: { tool: card.tool, decision: approved ? "approved" : "denied", how } });
        resolve(approved);
      };
      const timer = setTimeout(() => done(false, "timeout"), this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(tokenHash, { userId, threadId, tokenHash, resolve: (a) => done(a, "user"), timer });
      signal?.addEventListener("abort", () => done(false, "aborted"), { once: true });
      show({ token, ...card, expiresAt: this.#now() + this.#timeoutMs });
    });
  }

  /** The user's tap. Returns false (and audits) when the token is unknown or belongs to another user. */
  decide(sessionUserId: string, token: unknown, decision: unknown): boolean {
    if (typeof token !== "string" || token.length > 100) return false;
    const p = this.#pending.get(hashSecret("approval", token));
    if (!p) return false;
    if (p.userId !== sessionUserId) {
      this.#audit.write({ kind: "tool_denied", user: sessionUserId, detail: { reason: "approval token of another user" } });
      return false;
    }
    p.resolve(decision === "approve");
    return true;
  }

  pendingCount(): number {
    return this.#pending.size;
  }
}
