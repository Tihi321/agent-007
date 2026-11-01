/**
 * Shared contracts (plan section 4.3, S1.1). These let slices 2 to 5 run in parallel.
 * Type-only: nothing here imports Pi.
 */

/**
 * Phase 4 (S26.2, I35): a peer reply the turn received before it asked for an approval. The card shows it so the user can see that
 * the request may come from another bot, not from them. Never an authority: it is only text on the card.
 */
export interface PeerProvenance {
  from: string;
  hop: number;
  /** The peer's reply text, already clipped. */
  text: string;
}

export interface ApprovalRequest {
  /** Stable key, also the memo name suffix; used to find the request again after a restart. */
  key: string;
  /** Phase 4: set when the turn that produced this card received a peer reply (the card quotes it). */
  provenance?: readonly PeerProvenance[] | undefined;
  conversationId: string;
  chatId: number;
  tool: "shell";
  command: string;
  reason: string;
  cwd: string;
  timeoutSec: number;
  /** Epoch ms after which the request is a Deny. Kept across restarts. */
  deadline: number;
}

/** `invalid`: the command was empty or too long, so it was never shown or run (S3.3, S4.5). */
export type ApprovalDecisionBy = "user" | "timeout" | "killswitch" | "stop" | "restart-expired" | "invalid";

export interface ApprovalDecision {
  approved: boolean;
  by: ApprovalDecisionBy;
  userId?: number;
  /** Epoch ms of the decision. */
  at: number;
}

/** Implemented by S4 (Telegram), faked in S3 tests. */
export interface ApprovalTransport {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** S4; used by `remember` (S2). */
export interface Notifier {
  notify(conversationId: string, text: string): Promise<void>;
}

export interface ChatLookup {
  chatForConversation(conversationId: string): number | undefined;
}

export interface KillSwitch {
  isOn(): boolean;
  turnOn(by: string): Promise<void>;
  onChange(cb: () => void): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: object): void;
  info(event: string, fields?: object): void;
  warn(event: string, fields?: object): void;
  error(event: string, fields?: object): void;
}

/** Shell audit events (S1.4). Every event carries `ts` (ISO) and the approval/exec `id`. */
export type AuditEvent =
  | { event: "requested"; ts: string; id: string; conversationId: string; chatId: number; command: string; reason: string; cwd: string; deadline: number }
  | { event: "decided"; ts: string; id: string; approved: boolean; by: ApprovalDecisionBy; userId?: number; at: number }
  | { event: "started"; ts: string; id: string; command: string; cwd: string; timeoutSec: number }
  | { event: "finished"; ts: string; id: string; exitCode: number | null; durationMs: number; bytes: number; sha256: string; timedOut?: boolean }
  | { event: "blocked"; ts: string; id: string; command: string; reason: "killswitch" | "disabled" };

export type AuditEventName = AuditEvent["event"];

export interface AuditLog {
  write(event: AuditEvent): void;
}
