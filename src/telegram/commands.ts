/**
 * Commands (S4.4): /new, /stop, /status, /killshell (plus /start and /help). Registered on the bot after the
 * allowlist middleware, so only the allowlisted user in a private chat ever reaches them. Replies are plain text.
 */
import type { Bot, Context } from "grammy";
import type { KillSwitch } from "../contracts.js";
import type { RunnerName } from "../config/schema.js";
import type { HealthStatus } from "../runtime/health.js";
import { runnerLabel } from "./offline.js";

export const COMMAND_LIST: readonly { command: string; description: string }[] = [
  { command: "new", description: "Start a new conversation" },
  { command: "stop", description: "Stop the current answer and cancel pending approvals" },
  { command: "status", description: "Show model runner, shell and queue status" },
  { command: "killshell", description: "Disable the shell tool now (re-enable locally only)" },
];

export interface CommandDeps {
  conversations: {
    /** Cancels the old conversation's work and maps the chat to a fresh conversation. */
    startNew(chatId: number): Promise<unknown>;
    /** Aborts the chat's current conversation. */
    abort(chatId: number): Promise<void>;
  };
  approvals: {
    cancelChat(chatId: number, by: "stop" | "killswitch"): Promise<number>;
    cancelAll(by: "stop" | "killswitch"): Promise<number>;
    pendingCount(chatId?: number): number;
  };
  killSwitch: KillSwitch;
  /** Shown in the /killshell reply: the flag file an admin deletes to re-enable the shell. */
  killFlagPath: string;
  health?: { status(): HealthStatus } | undefined;
  runner: { name: RunnerName; modelId: string };
  /** `shell.enabled` from config. */
  shellEnabled: boolean;
  delivery: { inFlight(chatId?: number): number };
  startedAt: number;
  now: () => number;
  /** The last error, already redacted. */
  lastError: () => string | undefined;
  /** How long `/stop` waits for the abort to finish before it answers anyway. Default 10 s. */
  stopWaitMs?: number | undefined;
  /** Extra `/status` lines (Phase 2: job runner, jobs, MCP servers, Flow credits). A failure is ignored. */
  extraStatus?: (() => Promise<readonly string[]> | readonly string[]) | undefined;
}

export function formatLocalDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function statusText(deps: CommandDeps, chatId: number): string {
  const label = runnerLabel(deps.runner.name);
  const lines: string[] = [];
  lines.push(`Runner: ${label} (${deps.runner.modelId})`);
  const h = deps.health?.status();
  if (!h || h.lastCheckedAt === 0) lines.push("Runner status: not checked yet");
  else lines.push(`Runner status: ${h.up ? "up" : "DOWN"} since ${formatLocalDateTime(h.since)} (${h.detail})`);
  const inflight = deps.delivery.inFlight(chatId);
  lines.push(inflight > 0 ? `State: busy (${Math.max(0, inflight - 1)} queued behind the current one)` : "State: idle");
  let shell: string;
  if (deps.killSwitch.isOn()) shell = "disabled (kill switch is on; re-enable locally)";
  else if (!deps.shellEnabled) shell = "disabled (shell.enabled is false in config)";
  else shell = "enabled (every command needs your approval)";
  lines.push(`Shell: ${shell}`);
  lines.push(`Pending approvals: ${deps.approvals.pendingCount(chatId)}`);
  lines.push(`Uptime: ${formatDuration(deps.now() - deps.startedAt)}`);
  lines.push(`Last error: ${deps.lastError() ?? "none"}`);
  return lines.join("\n");
}

export async function withTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    const res = await Promise.race([p.then(() => "done" as const), timeout]);
    return res === "done";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const chatOf = (ctx: Context): number | undefined => ctx.chat?.id;

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply("agent-007 is running. Send a message to talk to it.\n\n/new  start a new conversation\n/stop  stop the current answer\n/status  runner, shell and approvals\n/model  switch the model\n/persona  switch the persona\n/settings  open the settings menu\n/proposals  settings changes waiting for you\n/applysettings  restart to use new security settings\n/killshell  disable the shell tool now");
  });

  bot.command("new", async (ctx) => {
    const chatId = chatOf(ctx);
    if (chatId === undefined) return;
    await deps.conversations.startNew(chatId);
    await ctx.reply("Started a new conversation.");
  });

  bot.command("stop", async (ctx) => {
    const chatId = chatOf(ctx);
    if (chatId === undefined) return;
    // Pending approvals first: the shell tool is usually what a run is waiting on.
    const cancelled = await deps.approvals.cancelChat(chatId, "stop");
    const finished = await withTimeout(deps.conversations.abort(chatId), deps.stopWaitMs ?? 10_000);
    const extra = cancelled > 0 ? ` ${cancelled} pending approval${cancelled === 1 ? "" : "s"} cancelled.` : "";
    await ctx.reply(finished ? `Stopped.${extra}` : `Stop requested; it is still winding down.${extra}`);
  });

  bot.command("status", async (ctx) => {
    const chatId = chatOf(ctx);
    if (chatId === undefined) return;
    let extra: readonly string[] = [];
    try {
      extra = (await deps.extraStatus?.()) ?? [];
    } catch {
      /* the base status still goes out */
    }
    await ctx.reply([statusText(deps, chatId), ...extra].join("\n"));
  });

  bot.command("killshell", async (ctx) => {
    const fromId = ctx.from?.id ?? 0;
    let failed = false;
    try {
      await deps.killSwitch.turnOn(`telegram:${fromId}`);
    } catch {
      failed = true;
    }
    await deps.approvals.cancelAll("killswitch");
    await ctx.reply(
      failed
        ? "Could not write the kill-switch flag. Pending approvals were cancelled, but the shell may still be enabled. Stop the agent locally."
        : `Shell disabled. Re-enable locally by deleting ${deps.killFlagPath}.`,
    );
  });
}
