/**
 * The bus guard (S26.1, I36, S21 deviation 80): the two hooks the `a7` extension of every bot of a multi-bot install carries, ahead of
 * the Flow guard and the shell approval gate.
 *
 *   beforeTool  `bus.guard(self, conversationId, tool)` answers from the chain record: a tool a peer turn may not have, a gated tool
 *               in a tainted chain, `ask_bot` at the hop limit. A reason blocks the call. In a peer turn of a cloud-capable bot the
 *               read tools may only name the cloud-safe roots (`cloudSafePolicy`), whatever the bot's own roots are.
 *   afterTool   `bus.noteToolUse(self, conversationId, tool)` after EVERY call: a content-ingesting tool (web, mail, any MCP tool
 *               outside the Flow server) taints the conversation and its chain. The tool names are also kept per conversation so the
 *               peer runtime can report `toolsUsed`.
 *
 * Both are pure hooks over the bus; neither can approve anything. A throw from the bus blocks the call (fail closed).
 */
import type { BotBus } from "../botbus/contracts.js";
import type { AfterToolHandler, BeforeToolHandler, Context, HookApi, ToolExecutionResult, ToolHookCall } from "../pi/adapter.js";
import type { PathPolicy } from "../tools/pathPolicy.js";

/** The read tools that take a `path` the cloud-safe check applies to. */
export const PATH_READ_TOOLS: readonly string[] = ["list_dir", "read_file", "search_files"];

export interface BusGuardDeps {
  bus: Pick<BotBus, "guard" | "noteToolUse" | "contextOf">;
  self: string;
  /** For a cloud-capable bot: a policy over its cloud-safe roots only (plus `workspace`), applied to peer turns. */
  cloudSafePolicy?: PathPolicy | undefined;
  /** Called with the tool name after each call (the peer runtime's `toolsUsed`). */
  onToolUsed?: ((conversationId: string, tool: string) => void) | undefined;
}

export interface BusGuard {
  beforeTool: BeforeToolHandler;
  afterTool: AfterToolHandler;
}

export function createBusGuard(deps: BusGuardDeps): BusGuard {
  const beforeTool = async (call: ToolHookCall, api: HookApi, _ctx: Context): Promise<{ block: string } | undefined> => {
    void _ctx;
    const conversationId = String(api.conversationId);
    let reason: string | undefined;
    try {
      reason = deps.bus.guard(deps.self, conversationId, call.name);
    } catch {
      reason = "the bot bus could not check this call";
    }
    if (reason !== undefined) return { block: `Blocked by the bot router: ${reason}.` };

    if (deps.cloudSafePolicy && PATH_READ_TOOLS.includes(call.name) && deps.bus.contextOf(deps.self, conversationId)?.origin === "peer") {
      const raw = (call.arguments as { path?: unknown }).path;
      const path = typeof raw === "string" ? raw.trim() : "";
      let ok = path !== "";
      if (ok) {
        try {
          deps.cloudSafePolicy.resolve(path);
        } catch {
          ok = false;
        }
      }
      if (!ok) return { block: "Blocked by the bot router: a peer turn of a bot that can use a cloud model may read only its cloud-safe folders and workspace." };
    }
    return undefined;
  };

  const afterTool = (call: ToolHookCall, result: ToolExecutionResult, api: HookApi, _ctx: Context): ToolExecutionResult => {
    void _ctx;
    const conversationId = String(api.conversationId);
    try {
      deps.bus.noteToolUse(deps.self, conversationId, call.name);
    } catch {
      // Fail closed: if the taint cannot be recorded, the model does not get the content.
      return { isError: true, output: [{ type: "text", text: "The result was withheld: the bot router could not record where it came from." }] };
    }
    try {
      deps.onToolUsed?.(conversationId, call.name);
    } catch {
      /* an observer never changes the result */
    }
    return result;
  };

  return { beforeTool: beforeTool as unknown as BeforeToolHandler, afterTool: afterTool as unknown as AfterToolHandler };
}
