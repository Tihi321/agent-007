/**
 * S3 (P0.4): one tool call, streamed (the Harness default).
 * `defineTool` `add_numbers {a: integer, b: integer}`; prompt "Use the tool to add 1234 and 4321".
 * PASS: the tool executes once with `{a:1234,b:4321}` and the final answer contains `5555`.
 * Records the usage the runner reported (`supportsUsageInStreaming`) and the compat flags used, per runner.
 * On Strata this is also the check that its tool-call output parses with `openAICompletionsApi` (U19).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, Type } from "../../src/pi/adapter.js";
import { checkRunnerReachable, failOutcome, finish, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { SmokeOutcome, SmokeRunnerConfig } from "./config.js";
import { allEntries, ask, ctx, describeSettled, entryHasToolCall, errMessage, openRig } from "./common.js";
import { withTimeout } from "./s2-roundtrip.js";

export interface S3Options {
  timeoutMs?: number;
  storageDir?: string;
}

export async function run(cfg: SmokeRunnerConfig, opts: S3Options = {}): Promise<SmokeOutcome> {
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) return unreachableOutcome("S3", cfg, reach);

  const calls: unknown[] = [];
  const addNumbers = defineTool({
    name: "add_numbers",
    description: "Add two integers and return the sum.",
    parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }),
    execute: async (args) => {
      calls.push(args);
      return { output: [{ type: "text", text: String(args.a + args.b) }] };
    },
  });
  const ext = defineExtension({ name: "s3", tools: [addNumbers] });

  const timeout = opts.timeoutMs ?? 180_000;
  const path = join(opts.storageDir ?? join(smokeOutDir(), "s3"), "s3.sqlite");
  rmSync(path, { force: true });
  const rig = await openRig({ storagePath: path, cfg, extensions: [ext], settings: { stream: { timeoutMs: timeout } } });
  const details: Record<string, unknown> = {
    compatFlags: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", ...(cfg.compat ?? {}) },
  };
  try {
    const out = await withTimeout(ask(rig.root, "Use the tool to add 1234 and 4321"), timeout, "tool-call run");
    const entries = await allEntries(rig.root);
    const toolCallTurns = entries.filter(entryHasToolCall).length;
    const usage = await rig.harness.usage(ctx).catch(() => undefined);
    Object.assign(details, {
      settled: describeSettled(out.settled),
      answer: out.text.slice(0, 160),
      toolExecutions: calls.length,
      toolArguments: calls,
      toolCallTurns,
      usageReported: usage ?? null,
      ms: out.ms,
      note: "If usage is all zero the runner did not report usage while streaming: set compat.supportsUsageInStreaming=false for it (U2).",
    });
    const argsOk = calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify({ a: 1234, b: 4321 });
    const pass = out.settled.status === "done" && argsOk && /5555/.test(out.text);
    let reason: string;
    if (pass) reason = `tool ran once with {a:1234,b:4321}; answer contains 5555 (${out.ms} ms)`;
    else if (out.settled.status !== "done") reason = `run ended ${out.settled.status}${out.settled.status === "unanswered" ? ` (${out.settled.reason})` : ""}`;
    else if (!argsOk) reason = `tool executed ${calls.length} time(s) with ${JSON.stringify(calls)}`;
    else reason = `final answer lacks 5555: ${out.text.slice(0, 80)}`;
    return { id: "S3", runner: cfg.runner, pass, reason, details };
  } catch (e) {
    return { id: "S3", runner: cfg.runner, pass: false, reason: errMessage(e), details };
  } finally {
    await rig.close().catch(() => undefined);
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadSmokeRunner(args);
  try {
    finish(await run(cfg));
  } catch (e) {
    finish(failOutcome("S3", cfg.runner, `unexpected error: ${errMessage(e)}`));
  }
}
