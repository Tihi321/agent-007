/**
 * The per-bot tool registry (S20.4, I27). A bot's registry is the code's tool list INTERSECTED with its allowlist: each extension
 * is installed with only the allowed tools, and everything else about it (its name, sections, hooks, tasks, wraps) is untouched.
 * So the approval guard stays in the host-default `a7` extension of that bot's own registry; no conversation ever passes an explicit
 * `extensions` array (footgun 30), and a `/new` conversation is gated like the first.
 *
 * The always-loaded set (exactly the 10 of I27, per bot) is not decided here: it is whatever non-deferred tools survive the
 * intersection, so it is always a subset of `ALWAYS_LOADED` and equals it for a full allowlist. `ask_bot` and `list_bots` are
 * deferred tools and are registered only for a bot with an edge (`effectiveTools`).
 */
import { ALWAYS_LOADED, checkToolCap, nonDeferredNames } from "../jobs/contracts.js";
import type { ToolCapReport } from "../jobs/contracts.js";
import { createRegistry, defineExtension } from "../pi/adapter.js";
import type { Extension, Registry, ToolRegistration } from "../pi/adapter.js";
import { BOT_BUS_TOOLS, effectiveTools } from "./schema.js";
import type { BotConfig } from "./schema.js";

/** True when `name` is in the allowlist: an exact entry, or an MCP tool matched by `mcp__*` or `mcp__<server>__*`. */
export function toolAllowed(allow: ReadonlySet<string>, name: string): boolean {
  if (allow.has(name)) return true;
  if (!name.startsWith("mcp__")) return false;
  if (allow.has("mcp__*")) return true;
  return [...allow].some((a) => a !== "mcp__*" && a.endsWith("__*") && name.startsWith(a.slice(0, -1)));
}

/** A copy of `ext` that offers only the tools in `allow`. An extension without tools is returned as is. */
export function narrowExtension(ext: Extension, allow: ReadonlySet<string>): Extension {
  if (!ext.tools) return ext;
  const tools = ext.tools.filter((t: ToolRegistration) => toolAllowed(allow, t.name));
  return defineExtension({ ...ext, tools });
}

export function allowedToolSet(bot: Pick<BotConfig, "tools" | "edges">): Set<string> {
  return new Set(effectiveTools(bot));
}

/** Installs every extension, narrowed to the bot's allowlist, into a NEW registry (one registry per bot). */
export function buildBotRegistry(installs: readonly Extension[], bot: Pick<BotConfig, "tools" | "edges">): Registry {
  const allow = allowedToolSet(bot);
  const registry = createRegistry();
  for (const e of installs) registry.install(narrowExtension(e, allow));
  return registry;
}

export interface BotRegistryReport extends ToolCapReport {
  /** Every registered tool name (deferred or not). */
  names: string[];
  /** Registered tools that are not in the bot's effective allowlist (must be empty). */
  stray: string[];
  /** The bus tools registered for a bot with no edge (must be empty). */
  busWithoutEdge: string[];
  /** Always-loaded names that the bot's allowlist keeps but that are not registered non-deferred (only for a full allowlist). */
  missingAlwaysLoaded: string[];
  /** Extensions that carry a hook (the guard lives in one of them): their names. */
  hookExtensions: string[];
  /** True when the whole check passes. */
  ok: boolean;
}

/** Reads a registry back and checks the I27 cap per bot, the allowlist, the bus tools and the guard. */
export function checkBotRegistry(registry: Registry, bot: Pick<BotConfig, "tools" | "edges">, opts: { guardExtension?: string } = {}): BotRegistryReport {
  const snap = registry.snapshot();
  const tools = snap.tools().map((x) => x.tool);
  const names = tools.map((t) => t.name);
  const allow = allowedToolSet(bot);
  const cap = checkToolCap(tools, { subset: true });
  const stray = names.filter((n) => !toolAllowed(allow, n));
  const busWithoutEdge = bot.edges.length === 0 ? names.filter((n) => (BOT_BUS_TOOLS as readonly string[]).includes(n)) : [];
  const have = new Set(nonDeferredNames(tools));
  const missingAlwaysLoaded = ALWAYS_LOADED.filter((n) => allow.has(n) && !have.has(n));
  const hookExtensions = snap.installed().filter((e) => (e.hooks ?? []).length > 0).map((e) => e.name);
  const guardOk = opts.guardExtension === undefined || hookExtensions.includes(opts.guardExtension);
  const busDeferred = tools.filter((t) => (BOT_BUS_TOOLS as readonly string[]).includes(t.name)).every((t) => t.deferred === true);
  return {
    ...cap,
    names,
    stray,
    busWithoutEdge,
    missingAlwaysLoaded,
    hookExtensions,
    ok: cap.ok && stray.length === 0 && busWithoutEdge.length === 0 && guardOk && busDeferred,
  };
}

/** The names a full allowlist would keep always-loaded: exactly `ALWAYS_LOADED`. For the per-bot count test of S26. */
export function expectedAlwaysLoaded(bot: Pick<BotConfig, "tools" | "edges">): string[] {
  const allow = allowedToolSet(bot);
  return ALWAYS_LOADED.filter((n) => allow.has(n));
}

