/**
 * `personaGuard` (S19.2, I27f): the second enforcement of a persona, composed into the host's SINGLE combined `beforeTool` (ahead of the
 * Flow guard and the shell approval gate). It holds even if `configure()` did not hide a tool. For any persona except `default` it
 * blocks:
 *   - a tool that is not in the persona's effective set (the message names the persona);
 *   - a tool name unknown to `KNOWN_TOOLS` (an MCP tool is judged by the persona's per-server list);
 *   - `dispatch_job` with a template outside `jobTemplates`, and past `maxJobsPerDay` (durable count, resets at local midnight);
 *   - `remember` when the persona's memory writes are off.
 * A persona that is invalid in force (fail closed to `readonly`) is judged as `readonly`. `default` is never blocked here: it is the
 * Phase 1/2 behaviour, still gated by the shell approval gate, the Flow guard and the job runner's own caps.
 */
import { KNOWN_TOOLS } from "../settings/catalog.js";
import type { BeforeToolHandler, Context, HookApi, ToolHookCall } from "../pi/adapter.js";
import type { Logger } from "../contracts.js";
import { allowedToolNames } from "./apply.js";
import type { PersonaResolver } from "./resolver.js";

export interface GuardDeps {
  resolver: PersonaResolver;
  known?: readonly string[];
  logger?: Logger | undefined;
}

export function createPersonaGuard(deps: GuardDeps): BeforeToolHandler {
  const known = deps.known ?? KNOWN_TOOLS;
  async function beforeTool(call: ToolHookCall, api: HookApi, _ctx: Context): Promise<{ block: string } | undefined> {
    const conv = String(api.conversationId);
    const r = deps.resolver.resolve(conv);
    if (r.personaId === "default" && !r.fallback) return undefined;
    const name = call.name;
    const who = `the ${r.name} persona${r.fallback ? ` (the "${r.requested}" persona is not usable)` : ""}`;
    const block = (why: string): { block: string } => {
      deps.logger?.info("personas.blocked", { persona: r.personaId, tool: name });
      return { block: `Blocked: ${why}` };
    };
    if (!name.startsWith("mcp__") && !known.includes(name)) return block(`the tool ${name} is not known to the persona rules, so ${who} may not use it.`);
    if (!allowedToolNames(r.effective).has(name)) return block(`${who} does not allow the tool ${name}.`);
    if (name === "dispatch_job") {
      const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as Record<string, unknown>;
      const tpl = typeof args["templateId"] === "string" ? args["templateId"] : "";
      if (!r.effective.jobTemplates.includes(tpl)) return block(`${who} may not dispatch the job template "${tpl.slice(0, 60)}".`);
      const c = await deps.resolver.countJob(conv);
      if (!c.ok) return block(`${who} has used its ${c.max ?? "daily"} jobs for today.`);
    }
    if (name === "remember" && r.effective.memory.write === "none") return block(`${who} has memory writes turned off.`);
    return undefined;
  }
  return beforeTool as unknown as BeforeToolHandler;
}
