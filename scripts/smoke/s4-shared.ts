/**
 * Tools shared by the S4 parent and its child process: `slow_unsafe` (default replay policy, "unsafe") and
 * `slow_safe` (replay: "safe"). Each appends one line to a counter file when it starts, then sleeps.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, Type } from "../../src/pi/adapter.js";

export function counterPath(dir: string, name: string): string {
  return join(dir, `${name}.count`);
}

export function buildS4Extension(counterDir: string, sleepMs: number) {
  mkdirSync(counterDir, { recursive: true });
  const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const slowUnsafe = defineTool({
    name: "slow_unsafe",
    description: "A slow tool that must not be run twice (default replay policy).",
    parameters: Type.Object({}),
    execute: async () => {
      appendFileSync(counterPath(counterDir, "slow_unsafe"), `${Date.now()}\n`);
      await nap(sleepMs);
      return { output: [{ type: "text", text: "slow_unsafe finished" }] };
    },
  });
  const slowSafe = defineTool({
    name: "slow_safe",
    description: "A slow tool that is safe to run again after a crash.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      appendFileSync(counterPath(counterDir, "slow_safe"), `${Date.now()}\n`);
      await nap(sleepMs);
      return { output: [{ type: "text", text: "slow_safe finished" }] };
    },
  });
  return defineExtension({ name: "s4", tools: [slowUnsafe, slowSafe] });
}

export const S4_PROMPTS = {
  a: "Write 600 words about the history of tea.",
  b: "Call the tools slow_unsafe and slow_safe once each, then reply DONE.",
} as const;
