/** Fixtures for the BotBus tests (S21). Not a test file. */
import { DEFAULT_BOT_BUS } from "../../src/bots/schema.js";
import type { BotBusLimits } from "../../src/bots/schema.js";
import { createBotBus } from "../../src/botbus/bus.js";
import type { BotBusOptions } from "../../src/botbus/bus.js";
import type { BusBot } from "../../src/botbus/contracts.js";
import { FakeBotRuntime } from "./fakes.js";
import type { RuntimeScript } from "./fakes.js";

export const FULL_TOOLS = ["tool_search", "read_file", "list_dir", "search_files", "web_search", "ask_user", "ask_bot", "list_bots", "remember", "shell", "write_file", "dispatch_job"];
export const SAFE_ALLOW = ["read_file", "list_dir", "web_search", "ask_bot", "list_bots"];

export function mkBot(id: string, over: Partial<BusBot> = {}): BusBot {
  return { id, description: `the ${id} bot`, tools: FULL_TOOLS, edges: [], cloudCapable: false, ...over };
}
export const edge = (to: string, allow: string[] = SAFE_ALLOW, egress = false) => ({ to, allow, egress });

/** No gap or daily cap by default: the limits tests set their own. */
export const LIMITS: BotBusLimits = { ...DEFAULT_BOT_BUS, edgeMinGapSec: 0, edgeDailyCap: 1000, breakerAsks: 1000 };

export interface Rig {
  bus: ReturnType<typeof createBotBus>;
  runtimes: Map<string, FakeBotRuntime>;
  clock: { t: number };
}

/** Bots a (edge to b), b (edge to c), c (no edge), all with FakeBotRuntimes. */
export function chainRig(over: Partial<BotBusOptions> = {}, bots?: BusBot[], scripts: Record<string, RuntimeScript> = {}): Rig {
  const list = bots ?? [mkBot("a", { edges: [edge("b")] }), mkBot("b", { edges: [edge("c")] }), mkBot("c")];
  const clock = { t: Date.UTC(2026, 0, 1, 12, 0, 0) };
  let n = 0;
  const bus = createBotBus({ bots: list, limits: LIMITS, now: () => clock.t, newId: () => `id${++n}`, ...over });
  const runtimes = new Map<string, FakeBotRuntime>();
  for (const b of list) {
    const rt = new FakeBotRuntime(scripts[b.id], b.id);
    runtimes.set(b.id, rt);
    bus.register(b.id, rt);
  }
  return { bus, runtimes, clock };
}
