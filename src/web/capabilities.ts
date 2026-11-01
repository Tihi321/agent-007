import type { Caps, WebUser } from "./schemas.js";

/**
 * What a non-owner bot can ever have (S32, S33, I50). This is the UNIVERSE: the tool registry for user bots is built from exactly these
 * names, so a host tool does not exist for them (capability absent, not policy-denied). A user's `caps.tools` is a subset of it.
 *
 * Absent by construction: shell, any host file write outside the bot's own workspace, dispatch_job and the job tools, Flow and hub
 * tools, MCP servers, ask_bot / list_bots, the owner's `remember`, settings and persona tools, web fetch (UI-41: none for now).
 */
export const USER_TOOL_UNIVERSE: readonly string[] = ["tool_search", "ask_user", "read_file", "list_dir", "search_files", "write_file", "remember"];

/** Names that must never be reachable from a user bot, used by the registry enumeration test. */
export const HOST_TOOL_NAMES: readonly string[] = [
  "shell",
  "dispatch_job",
  "job_status",
  "cancel_job",
  "list_templates",
  "hub_status",
  "hub_start",
  "system_facts",
  "ask_bot",
  "list_bots",
  "get_settings",
  "propose_setting",
  "propose_persona",
  "switch_persona",
  "list_personas",
  "ask_second_opinion",
  "web_fetch",
];

/** The most tools a user bot may load at once (I27 is 10 per bot). */
export const USER_ALWAYS_LOADED_MAX = 10;

/**
 * The caps a user has RIGHT NOW (I61): the owner's presets are every configured preset (security.json and the Models page), anyone else's are
 * exactly `caps.presets`. The stored owner caps keep their other limits; the stored `presets` of the owner row is ignored.
 */
export function effectiveCaps(user: Pick<WebUser, "role" | "caps">, presetIds: readonly string[]): Caps {
  return user.role === "owner" ? { ...user.caps, presets: [...presetIds] } : user.caps;
}
