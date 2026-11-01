/** Helpers to run a registered tool's `execute` directly (no Harness). Not a test file. */
import type { Context, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../../src/pi/adapter.js";

export interface RunToolOptions {
  signal?: AbortSignal | undefined;
  conversationId?: string;
}

export interface RunToolResult {
  result: ToolExecutionResult;
  /** Everything the tool wrote with `api.output` (live progress). */
  progress: string[];
  text: string;
}

export function textOf(result: ToolExecutionResult): string {
  return (result.output ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

export async function runTool(tool: ToolRegistration, args: unknown, opts: RunToolOptions = {}): Promise<RunToolResult> {
  const progress: string[] = [];
  const api = {
    output: (c: string | Uint8Array) => progress.push(String(c)),
    conversationId: opts.conversationId ?? "conv-test",
    callId: "call-1",
  } as unknown as ToolExecutionApi;
  const ctx = { abortSignal: opts.signal, value: () => undefined, toString: () => "test-context" } as unknown as Context;
  const result = await tool.execute(args as never, api, ctx);
  return { result, progress, text: textOf(result) };
}

export function toolByName(tools: readonly ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool named ${name}; have ${tools.map((x) => x.name).join(", ")}`);
  return t;
}
