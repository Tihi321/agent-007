/**
 * Fakes shared by the S3 tests: a `HookApi` whose memo store survives a simulated restart, a fake `Context`,
 * a scripted `ApprovalTransport`, and a shell config.
 */
import type { ApprovalDecision, ApprovalRequest, ApprovalTransport } from "../../src/contracts.js";
import type { ShellConfig } from "../../src/config/schema.js";
import type { Context, HookApi, ToolExecutionApi, ToolHookCall } from "../../src/pi/adapter.js";

export const SHELL_CFG: ShellConfig = {
  enabled: true,
  approvalTimeoutSec: 600,
  execTimeoutSec: 120,
  maxExecTimeoutSec: 600,
  maxOutputBytes: 65536,
  returnBytes: 8192,
};

export function cfg(over: Partial<ShellConfig> = {}): ShellConfig {
  return { ...SHELL_CFG, ...over };
}

/** First-writer-wins memo store, shared across "restarts" by reusing the same Map. */
export function fakeHookApi(store: Map<string, unknown>, conversationId = "conv1"): HookApi {
  const memo = async (...args: unknown[]): Promise<unknown> => {
    const name = args[0] as string;
    if (args.length === 2) return store.get(name);
    if (!store.has(name)) store.set(name, structuredClone(args[1]));
    return store.get(name);
  };
  return { taskId: "task1", conversationId, models: undefined, memo } as unknown as HookApi;
}

export function fakeContext(signal?: AbortSignal): Context {
  return { abortSignal: signal, telemetry: undefined, value: () => undefined, toString: () => "fake" } as unknown as Context;
}

export function shellCall(command: string, over: { id?: string; reason?: string; timeoutSec?: number; name?: string } = {}): ToolHookCall {
  const args: Record<string, unknown> = { command, reason: over.reason ?? "because" };
  if (over.timeoutSec !== undefined) args["timeoutSec"] = over.timeoutSec;
  return { type: "toolCall", id: over.id ?? "call1", name: over.name ?? "shell", arguments: args } as unknown as ToolHookCall;
}

export function fakeToolApi(conversationId = "conv1", callId = "call1"): ToolExecutionApi {
  return { conversationId, callId, taskId: "task1" } as unknown as ToolExecutionApi;
}

export interface ScriptedTransport extends ApprovalTransport {
  requests: ApprovalRequest[];
  signals: AbortSignal[];
}

/** A transport that answers with `answer(req)`; `answer` may return a promise that never settles. */
export function scriptedTransport(answer: (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>): ScriptedTransport {
  const t: ScriptedTransport = {
    requests: [],
    signals: [],
    request(req, signal) {
      t.requests.push(req);
      t.signals.push(signal);
      return answer(req, signal);
    },
  };
  return t;
}

export const approveNow = (userId = 42) => async (): Promise<ApprovalDecision> => ({ approved: true, by: "user", userId, at: Date.now() });
export const denyNow = (userId = 42) => async (): Promise<ApprovalDecision> => ({ approved: false, by: "user", userId, at: Date.now() });
export const neverAnswer = () => (): Promise<ApprovalDecision> => new Promise<ApprovalDecision>(() => undefined);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
