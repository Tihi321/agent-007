/**
 * The Flow guard (S14.4, D11, I21). Credits are approved per job, as a number on the approval card; no default budget is
 * ever spent. For the agent's own (deferred) Flow tools, two checks stand between the model and the credits:
 *
 *   1. `beforeTool` (hook on `ToolTask`): blocks any Flow call with no `max_credits`, with a `max_credits` above what is left
 *      of the approved number, and every Flow call that has no open ledger entry (no approved Flow job). There is no default
 *      and no "small call" exception.
 *   2. `wrapTool` (applied to each Flow tool registration): the charge. In `execute`, one commit re-checks the budget and
 *      adds `max_credits` to the ledger before the call runs, once per call key. Flow tools are `replay: "unsafe"`: after a
 *      crash the call is not run again, and the charge stays on the ledger, so a crash never gives credits back.
 *
 * Inside a job the job runner applies the same rule to Flow calls (S11, S12.3); the ledger follows its `flow_call` events.
 *
 * Dev 153: a fixed allowlist of free tools (`FREE_FLOW_TOOLS`) skips the cap and the charge but still needs an approved Flow job;
 * `music_generate`/`music_remix` are refused with a "Flow Music credit approval is not supported yet" message.
 *
 * U38 (settled by the S14.5 read-only `listTools`, plan section 14): the field is `max_credits` everywhere, but `flow_generate`
 * carries it per scene (`scenes[].max_credits`, summed here) while `flow_continue`, `flow_edit` and `flow_narrate` carry it at the
 * top level. `music_generate`/`music_remix` have no cap field and are therefore always blocked. See `flowCredits.ts`.
 * `maxCreditsFields` stays configurable.
 */
import type { Logger } from "../contracts.js";
import type { BeforeToolHandler, Context, HookApi, ToolExecutionApi, ToolExecutionResult, ToolHookCall, ToolRegistration } from "../pi/adapter.js";
import { DEFAULT_MAX_CREDITS_FIELDS, MUSIC_CREDIT_REFUSAL, isFreeFlowTool, isMusicCreditTool, sceneCreditsTotal } from "./flowCredits.js";
import { chargeDirect, findBudget, flowLedgerDoc, isCredits, readLedger } from "./ledger.js";

export { DEFAULT_MAX_CREDITS_FIELDS };

export interface FlowGuardOptions {
  /** `config.flow.serverId`: the MCP server whose tools spend credits (`mcp__<serverId>__<tool>`). */
  serverId: string;
  /** Accepted names of the credit field in a Flow tool's arguments (U38). */
  maxCreditsFields?: readonly string[] | undefined;
  /** Override the "is this a Flow tool" test (default: the `mcp__<serverId>__` prefix). */
  isFlowTool?: ((name: string) => boolean) | undefined;
  logger?: Logger | undefined;
  now?: (() => number) | undefined;
}

export type MaxCreditsRead = { ok: true; value: number } | { ok: false; text: string };

/** The `max_credits` of a call, or why there is none. A string, zero, a negative, NaN or Infinity is refused. */
export function readMaxCredits(args: unknown, fields: readonly string[] = DEFAULT_MAX_CREDITS_FIELDS): MaxCreditsRead {
  const o = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  for (const f of fields) {
    if (!(f in o)) continue;
    const v = o[f];
    if (isCredits(v)) return { ok: true, value: v };
    return { ok: false, text: `Blocked: ${f} must be a number above zero (got ${typeof v === "number" ? String(v) : typeof v}). Every Flow call needs max_credits within the approved budget.` };
  }
  const scenes = sceneCreditsTotal(args, fields);
  if (scenes !== undefined) {
    if (!scenes.ok) return scenes;
    if (scenes.total > 0) return { ok: true, value: scenes.total };
    return { ok: false, text: "Blocked: the scenes of this Flow call carry max_credits 0 in total. Even a free Flow call needs an approved Flow job; ask the user to approve one." };
  }
  return { ok: false, text: `Blocked: this Flow call has no ${fields[0] ?? "max_credits"}. Every Flow call needs max_credits within the approved budget; add it and call again.` };
}

export interface FlowGuard {
  isFlowTool(name: string): boolean;
  /** Compose into the single combined `beforeTool` of the host (U43a). */
  beforeTool: BeforeToolHandler;
  /** Adds the atomic charge to one Flow tool registration. */
  wrapTool<T extends ToolRegistration>(tool: T): T;
  /** The same as an extension `wraps` entry for the tool called `toolName`. */
  wrapFor(toolName: string): { tool: string; wrap<T extends ToolRegistration>(tool: T): T };
}

function errorText(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text }] };
}

export function createFlowGuard(opts: FlowGuardOptions): FlowGuard {
  const prefix = `mcp__${opts.serverId}__`;
  const isFlowTool = opts.isFlowTool ?? ((name: string) => name.startsWith(prefix));
  const fields = opts.maxCreditsFields ?? DEFAULT_MAX_CREDITS_FIELDS;
  const now = opts.now ?? Date.now;

  async function beforeTool(call: ToolHookCall, api: HookApi, ctx: Context): Promise<{ block: string } | undefined> {
    if (!isFlowTool(call.name)) return undefined;
    if (isMusicCreditTool(call.name, opts.serverId)) {
      opts.logger?.info("flow.blocked", { tool: call.name, reason: "music_credits" });
      return { block: MUSIC_CREDIT_REFUSAL };
    }
    if (isFreeFlowTool(call.name, opts.serverId)) {
      // dev 153a: a free tool needs no cap and no charge, only an approved Flow job (an open ledger entry)
      const verdict = findBudget(readLedger(await api.snapshot(flowLedgerDoc, ctx)), String(api.conversationId), 0);
      if (!verdict.ok) {
        opts.logger?.info("flow.blocked", { tool: call.name, reason: verdict.reason });
        return { block: verdict.text };
      }
      return undefined;
    }
    const mc = readMaxCredits(call.arguments, fields);
    if (!mc.ok) {
      opts.logger?.info("flow.blocked", { tool: call.name, reason: "max_credits" });
      return { block: mc.text };
    }
    const ledger = readLedger(await api.snapshot(flowLedgerDoc, ctx));
    const verdict = findBudget(ledger, String(api.conversationId), mc.value);
    if (!verdict.ok) {
      opts.logger?.info("flow.blocked", { tool: call.name, reason: verdict.reason });
      return { block: verdict.text };
    }
    return undefined;
  }

  function wrapTool<T extends ToolRegistration>(tool: T): T {
    const inner = tool.execute.bind(tool) as ToolRegistration["execute"];
    const execute = async (args: unknown, api: ToolExecutionApi, ctx: Context): Promise<ToolExecutionResult> => {
      if (isMusicCreditTool(tool.name, opts.serverId)) return errorText(MUSIC_CREDIT_REFUSAL);
      if (isFreeFlowTool(tool.name, opts.serverId)) return inner(args as never, api as never, ctx); // free: no charge (beforeTool checked the job)
      const mc = readMaxCredits(args, fields);
      if (!mc.ok) return errorText(mc.text);
      const callKey = `${String(api.conversationId)}/${api.callId}`;
      const at = now();
      const charged = await api.commit(async (tx) => {
        const doc = await tx.doc(flowLedgerDoc);
        return chargeDirect(doc, String(api.conversationId), callKey, mc.value, at);
      }, ctx);
      if (!charged.ok) {
        opts.logger?.info("flow.blocked", { tool: tool.name, reason: charged.reason, stage: "charge" });
        return errorText(charged.text);
      }
      opts.logger?.info("flow.charged", { tool: tool.name, maxCredits: mc.value, remaining: charged.remaining });
      return inner(args as never, api as never, ctx);
    };
    return { ...tool, execute } as unknown as T;
  }

  return {
    isFlowTool,
    beforeTool: beforeTool as BeforeToolHandler,
    wrapTool,
    wrapFor: (toolName) => ({ tool: toolName, wrap: wrapTool }),
  };
}
