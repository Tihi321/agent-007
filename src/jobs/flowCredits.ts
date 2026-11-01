/**
 * Where the credit cap sits in a flow-music-mcp call (S14.5, U38; read from the live `listTools` of 2026-10-31, plan section 14):
 *
 *   - `flow_generate`: `scenes[].max_credits`, one cap per scene (integer, 0 or more; images are free and carry 0). The call's cap
 *     is the SUM over the scenes, and every scene must carry one.
 *   - `flow_continue`, `flow_edit`, `flow_narrate`: a top-level `max_credits`.
 *   - Every other tool has none: `music_generate` and `music_remix` spend Flow Music credits with no cap field at all, and the
 *     free tools (`flow_status`, `flow_assets`, `flow_assemble`, ...) spend nothing.
 *
 * Both the agent's Flow guard and the job runner's policy read it here, so the two cannot disagree.
 */

export const DEFAULT_MAX_CREDITS_FIELDS: readonly string[] = ["max_credits"];

export type SceneCredits = { ok: true; total: number } | { ok: false; text: string };

/** The total cap over `scenes[]`, or `undefined` when the call has no `scenes` array. */
export function sceneCreditsTotal(args: unknown, fields: readonly string[] = DEFAULT_MAX_CREDITS_FIELDS): SceneCredits | undefined {
  const o = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const scenes = o["scenes"];
  if (!Array.isArray(scenes)) return undefined;
  if (scenes.length === 0) return { ok: false, text: "Blocked: this Flow call has no scenes." };
  let total = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const rec = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
    const f = fields.find((name) => name in rec);
    if (f === undefined) return { ok: false, text: `Blocked: scene ${i + 1} has no ${fields[0] ?? "max_credits"}. Every scene of a Flow call needs max_credits (0 for a free image).` };
    const v = rec[f];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, text: `Blocked: scene ${i + 1} ${f} must be a number, zero or more (got ${typeof v === "number" ? String(v) : typeof v}).` };
    total += v;
  }
  return { ok: true, total };
}

/**
 * Dev 153a: the fixed allowlist of flow-music-mcp tools that cannot spend credits. They need no `max_credits` and charge
 * nothing, but they are allowed only inside an approved Flow job (agent: an open ledger entry; job runner: an enabled Flow job
 * with a budget). Derived from the live `listTools` of 2026-10-31 and each tool's own description (plan section 14, dev 153).
 * Anything not named here (generating, retrying, trashing, debugging, installing, key-handling tools) keeps the cap rule.
 */
export const FREE_FLOW_TOOLS: ReadonlySet<string> = new Set([
  // Flow Music: status, queue and library reads, cancel, and local or existing-song work
  "music_status", "music_wait", "music_jobs", "music_cancel", "music_songs", "music_download", "music_loop",
  // Flow: status, queue, library reads, local ffmpeg assemble, existing-media download, prompt phrases
  "flow_status", "flow_wait", "flow_cancel", "flow_assets", "flow_download", "flow_characters", "flow_voices", "flow_assemble", "flow_techniques",
]);

/** Dev 153b: these spend Flow Music credits with no cap field, so they stay blocked. */
export const MUSIC_CREDIT_TOOLS: ReadonlySet<string> = new Set(["music_generate", "music_remix"]);

export const MUSIC_CREDIT_REFUSAL = "Blocked: this tool spends Flow Music credits, and Flow Music credit approval is not supported yet. Ask the user to make the song in Flow Music themselves.";

/** The tool name without the `mcp__<serverId>__` prefix, or undefined when the tool is not of that server. */
export function bareFlowToolName(tool: string, serverId: string): string | undefined {
  const prefix = `mcp__${serverId}__`;
  return tool.toLowerCase().startsWith(prefix.toLowerCase()) ? tool.slice(prefix.length) : undefined;
}

export function isFreeFlowTool(tool: string, serverId: string): boolean {
  const n = bareFlowToolName(tool, serverId);
  return n !== undefined && FREE_FLOW_TOOLS.has(n);
}

export function isMusicCreditTool(tool: string, serverId: string): boolean {
  const n = bareFlowToolName(tool, serverId);
  return n !== undefined && MUSIC_CREDIT_TOOLS.has(n);
}
