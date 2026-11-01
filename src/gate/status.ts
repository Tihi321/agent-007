/**
 * S25.2: the topology of local bots and the `/status` data for the gate.
 *
 * The REFUSAL of more than `gate.localBotsOnStrata` bots with Strata as their primary preset lives in the settings loader
 * (`validateBotsDoc`, S20.1); this file only reports the same numbers so `/status` can show "2 of 2 bots on Strata", and gives the
 * queue depth per runner in a form S26.3 can print.
 */
import type { PresetConfig, ResolvedBot } from "../bots/schema.js";
import type { GateStatus, RunnerGateStatus } from "./gate.js";

export interface LocalTopology {
  /** Bot ids whose primary preset is a local preset on Strata, in bot order. */
  strataPrimary: string[];
  limit: number;
  /** True when the count is within the limit (the loader refuses a config where it is not). */
  withinLimit: boolean;
  /** Bot ids by local runner of their primary preset (`lmstudio`, `strata`). Bots with a proxy primary are not listed. */
  byRunner: Record<string, string[]>;
}

export function localTopology(bots: readonly Pick<ResolvedBot, "id" | "route">[], presets: readonly PresetConfig[], limit: number): LocalTopology {
  const byRunner: Record<string, string[]> = {};
  for (const b of bots) {
    const p = presets.find((x) => x.id === b.route.primary);
    if (p?.kind !== "local" || !p.runner) continue;
    (byRunner[p.runner] ??= []).push(b.id);
  }
  const strataPrimary = byRunner["strata"] ?? [];
  return { strataPrimary, limit, withinLimit: strataPrimary.length <= limit, byRunner };
}

/** The queue depth per runner: waiting entries, plus the one(s) running. */
export function queueDepths(status: GateStatus): Record<string, { running: number; queued: number }> {
  return Object.fromEntries(status.runners.map((r) => [r.runner, { running: r.running.length, queued: r.queued }]));
}

/** What `/status` shows for one bot: its place in each runner's line. */
export interface BotGateView {
  runner: string;
  running: boolean;
  /** Entries of this bot waiting for the runner. */
  waiting: number;
  /** Total waiting for the runner. */
  queued: number;
  sticky: boolean;
}

export function botGateView(status: GateStatus, botId: string): BotGateView[] {
  return status.runners.map((r: RunnerGateStatus) => ({
    runner: r.runner,
    running: r.running.some((x) => x.bot === botId),
    waiting: r.waiting.filter((w) => w.bot === botId).length,
    queued: r.queued,
    sticky: r.sticky?.bot === botId,
  }));
}

/** Plain-text lines for `/status`, one per runner: `strata: 1 running, 2 waiting (P0 0, P1 1, P2 1, P3 0), oldest 12s`. */
export function gateStatusLines(status: GateStatus): string[] {
  return status.runners.map((r) => {
    const parts = [`${r.running.length} running`, `${r.queued} waiting`];
    let line = `${r.runner}: ${parts.join(", ")}`;
    if (r.queued > 0) line += ` (P0 ${r.byPriority[0]}, P1 ${r.byPriority[1]}, P2 ${r.byPriority[2]}, P3 ${r.byPriority[3]}), oldest ${Math.round(r.oldestWaitMs / 1000)}s`;
    if (r.sticky) line += `, held for ${r.sticky.bot}`;
    if (r.busyRefused > 0) line += `, ${r.busyRefused} refused as busy`;
    return line;
  });
}
