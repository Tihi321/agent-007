/**
 * The capability rule (S21.2, I36, D12): monotone narrowing, enforced in code (the router and the guard), never in a prompt.
 *
 *  (1) Authority comes only from the user: a user's own message in bot B's chat is a `user` turn with B's full tools (not computed here).
 *  (2) A PEER turn gets `caps(receiver) ∩ caps(every bot in path) ∩ allow(every edge on the path)` and NEVER `PEER_FORBIDDEN_TOOLS`
 *      (shell, write_file, dispatch_job, Flow, remember, settings and persona changes, job control), timers, or private-folder reads on
 *      a cloud route. There is no `elevated` edge.
 *  (3) A tainted chain (a content-ingesting tool was used, or its input came from one) exposes no gated tool (`TAINT_BLOCKED_TOOLS`).
 *  (4) At the hop limit the turn cannot ask (no `ask_bot`, no `list_bots`).
 *
 * `permits` is a pure function of the configuration and the path, so a restart recomputes the same answer (U59).
 *
 * Pure: imports only pure helpers.
 */
import { toolAllowed } from "../bots/registry.js";
import { BOT_BUS_TOOLS, PEER_FORBIDDEN_TOOLS, effectiveTools } from "../bots/schema.js";
import { DEFAULT_FLOW_SERVER_ID } from "../config/schema.js";
import { MACRO_TOOLS } from "../settings/catalog.js";
import type { BusBot, PeerCaps, PeerSummary, RootsMode } from "./contracts.js";

/** Tools that need the user's go-ahead (or change what the bot may do). In a tainted turn none of them exists at all (I36(3)). */
export const TAINT_BLOCKED_TOOLS: readonly string[] = ["shell", "dispatch_job", "hub_start", "propose_setting", "propose_persona", "switch_persona"];

/** Timers and schedulers are never offered to a peer turn (I33). No such tool exists yet; the names are reserved. */
export const TIMER_TOOLS: readonly string[] = ["set_timer", "schedule_task", "remind_me", "cron"];

/** On top of `PEER_FORBIDDEN_TOOLS`: the three macros are Flow calls, and timers. */
export const PEER_EXTRA_FORBIDDEN: readonly string[] = [...MACRO_TOOLS, ...TIMER_TOOLS];

/** Tools whose output is outside text the user wrote: web, mail and fetched pages (other than the names below, any MCP tool). */
export const CONTENT_INGESTING_TOOLS: readonly string[] = ["web_search", "fetch_url", "fetch_page", "browse", "read_email", "search_email"];

export function isForbiddenForPeer(tool: string, flowServerId: string = DEFAULT_FLOW_SERVER_ID): boolean {
  return PEER_FORBIDDEN_TOOLS.includes(tool) || PEER_EXTRA_FORBIDDEN.includes(tool) || tool === "mcp__*" || tool.startsWith(`mcp__${flowServerId}__`);
}

/** True for a tool that reads content from outside (any MCP tool except the Flow server's, the names above). */
export function isIngestingTool(tool: string, flowServerId: string = DEFAULT_FLOW_SERVER_ID): boolean {
  if (CONTENT_INGESTING_TOOLS.includes(tool)) return true;
  return tool.startsWith("mcp__") && !tool.startsWith(`mcp__${flowServerId}__`);
}

export interface CapsInput {
  bots: ReadonlyMap<string, BusBot>;
  /** Root first, the receiver last. */
  path: readonly string[];
  hopLimit: number;
  taint: boolean;
  flowServerId?: string;
  /** Is the receiver on (or able to reach) a cloud route right now? Default: `cloudCapable`. */
  isCloud?: (id: string) => boolean;
}

/** The peer capabilities of the LAST bot of `path`. */
export function computePeerCaps(input: CapsInput): PeerCaps {
  const flow = input.flowServerId ?? DEFAULT_FLOW_SERVER_ID;
  const path = [...input.path];
  const receiverId = path[path.length - 1] ?? "";
  const hop = Math.max(0, path.length - 1);
  const canAsk = hop < input.hopLimit;
  const members = path.map((id) => input.bots.get(id));
  const memberSets = path.map((_id, i) => new Set(members[i] ? effectiveTools({ tools: [...(members[i] as BusBot).tools], edges: (members[i] as BusBot).edges.map((e) => ({ to: e.to, allow: [...e.allow], egress: e.egress })) }) : []));
  // the allow list of the edge path[i] -> path[i+1], for every hop; a missing edge empties the turn
  const edgeAllows: Set<string>[] = [];
  let wired = members.every((m) => m !== undefined);
  for (let i = 0; wired && i < path.length - 1; i++) {
    const edge = members[i]?.edges.find((e) => e.to === path[i + 1]);
    if (!edge) wired = false;
    else edgeAllows.push(new Set(edge.allow));
  }
  const cloud = input.isCloud ?? ((id: string) => input.bots.get(id)?.cloudCapable === true);
  const bus = BOT_BUS_TOOLS as readonly string[];

  const denied = (tool: string): string | undefined => {
    if (!wired) return "no edge on this path";
    if (isForbiddenForPeer(tool, flow)) return "a peer turn never gets this tool";
    if (input.taint && TAINT_BLOCKED_TOOLS.includes(tool)) return "the chain is tainted: no gated tool exists in it";
    if (bus.includes(tool) && !canAsk) return "hop limit reached: this turn cannot ask another bot";
    for (let i = 0; i < path.length; i++) if (!toolAllowed(memberSets[i] as Set<string>, tool)) return `the bot ${path[i]} does not have this tool`;
    for (let i = 0; i < edgeAllows.length; i++) if (!toolAllowed(edgeAllows[i] as Set<string>, tool)) return `the edge ${path[i]} to ${path[i + 1]} does not allow this tool`;
    return undefined;
  };

  const last = edgeAllows[edgeAllows.length - 1];
  const tools = last ? [...last].filter((t) => denied(t) === undefined) : [];
  const readRoots: RootsMode = cloud(receiverId) ? "cloud_safe" : "normal";
  return { receiver: receiverId, path, hop, taint: input.taint, tools, permits: (t) => denied(t) === undefined, denied, canAsk, timers: false, asyncAsk: false, readRoots };
}

/** The `list_bots` summary of the edge `path[last-1] -> path[last]`; `path` ends with the candidate receiver. */
export function summarizePeer(input: CapsInput, receiver: BusBot, edgeEgress: boolean): PeerSummary {
  const caps = computePeerCaps(input);
  const visited = input.path.slice(0, -1).includes(receiver.id);
  const atLimit = input.path.length - 1 > input.hopLimit;
  const unavailableReason = visited ? "already in this chain" : atLimit ? "hop limit reached" : undefined;
  const cloud = (input.isCloud ?? ((id: string) => input.bots.get(id)?.cloudCapable === true))(receiver.id);
  return {
    id: receiver.id,
    description: receiver.description,
    available: unavailableReason === undefined,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    caps: {
      tools: [...caps.tools],
      canAsk: caps.canAsk,
      dataOnly: caps.taint,
      readRoots: caps.readRoots,
      attachRefs: cloud && !edgeEgress ? "needs_egress_edge" : "ok",
    },
  };
}
