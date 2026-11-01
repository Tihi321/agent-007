/**
 * One combined `beforeTool` for the host (S15, U43a). The plan keeps a single handler on the `a7` extension whatever U43a
 * says about two `hook(ToolTask, ...)` registrations: each guard (the shell approval gate, the Flow guard) only acts on its own
 * tools, so the first one that returns a block decides, and a call no guard blocks goes on.
 */
import type { AfterToolHandler, BeforeToolHandler, Context, HookApi, ToolExecutionResult, ToolHookCall } from "../pi/adapter.js";

type Verdict = { block: string } | undefined | void;
type Handler = (call: ToolHookCall, api: HookApi, ctx: Context) => Promise<Verdict> | Verdict;

export function composeBeforeTool(...handlers: readonly BeforeToolHandler[]): BeforeToolHandler {
  const list = handlers as unknown as readonly Handler[];
  const combined = async (call: ToolHookCall, api: HookApi, ctx: Context): Promise<{ block: string } | undefined> => {
    for (const h of list) {
      const verdict = await h(call, api, ctx);
      if (verdict !== undefined && verdict !== null && typeof verdict === "object" && "block" in verdict) return verdict;
    }
    return undefined;
  };
  return combined as unknown as BeforeToolHandler;
}

type AfterHandler = (call: ToolHookCall, result: ToolExecutionResult, api: HookApi, ctx: Context) => Promise<ToolExecutionResult | undefined | void> | ToolExecutionResult | undefined | void;

/** Phase 4: runs every `afterTool` handler in order; a handler that returns a result replaces it for the next one. */
export function composeAfterTool(...handlers: readonly AfterToolHandler[]): AfterToolHandler {
  const list = handlers as unknown as readonly AfterHandler[];
  const combined = async (call: ToolHookCall, result: ToolExecutionResult, api: HookApi, ctx: Context): Promise<ToolExecutionResult> => {
    let current = result;
    for (const h of list) {
      const next = await h(call, current, api, ctx);
      if (next !== undefined && next !== null && typeof next === "object") current = next;
    }
    return current;
  };
  return combined as unknown as AfterToolHandler;
}
