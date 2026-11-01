/**
 * The tool catalog personas are checked against (S17.5, I27c). `KNOWN_TOOLS` is a code constant, tested against the real
 * registry (`test/integration/phase3-registry.test.ts`): a tool added later is unknown to every older persona, because persona
 * lists are explicit (no "absent means all"). `READONLY_TOOLS` is the built-in `readonly` persona's set (S19.1).
 *
 * Pure: no imports.
 */

/** Every tool name of Phases 1 to 3 (the 7 Phase 1 tools, `tool_search`, the job tools, the hub tools, the 5 Phase 3 tools) and the 3 macros. */
export const KNOWN_TOOLS: readonly string[] = [
  "tool_search",
  "dispatch_job",
  "job_status",
  "cancel_job",
  "list_templates",
  "ask_user",
  "hub_status",
  "system_facts",
  "list_dir",
  "read_file",
  "search_files",
  "write_file",
  "remember",
  "shell",
  "hub_start",
  "get_settings",
  "list_personas",
  "propose_setting",
  "propose_persona",
  "switch_persona",
  "tts_line",
  "chiptune_loop",
  "comfy_image",
];

/** The macro tool names (a subset of `KNOWN_TOOLS`); each needs the macro enabled on some MCP server. */
export const MACRO_TOOLS: readonly string[] = ["tts_line", "chiptune_loop", "comfy_image"];

export const READONLY_TOOLS: readonly string[] = [
  "tool_search",
  "system_facts",
  "list_dir",
  "read_file",
  "search_files",
  "get_settings",
  "list_personas",
  "job_status",
  "list_templates",
  "hub_status",
  "ask_user",
];

/** Tools that, whichever persona is active, change files, run commands, spend money or start work. Named for cards and summaries. */
export const SENSITIVE_TOOLS: readonly string[] = ["shell", "write_file", "remember", "dispatch_job", "hub_start"];
