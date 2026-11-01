/**
 * Pieces shared by S5 and its child: the `gate_me` tool and the long-waiting `beforeTool` hook.
 * With `memo: true` the hook is the S5b variant: it writes `a7.approval.asked:<call.id>` through `api.memo` before
 * waiting, and a decision memo `a7.approval.decision:<call.id>` once the wait is over, so a restart can be inspected.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineExtension, defineTool, hook, ToolTask, Type } from "../../src/pi/adapter.js";

export interface S5Options {
  /** How long the hook waits (the simulated approval wait). */
  hookWaitMs: number;
  /** How long the tool body sleeps after the hook returns. */
  toolSleepMs: number;
  memo: boolean;
  /** JSONL event log (appended by every process that runs the hook or the tool). */
  logFile: string;
}

export interface S5Event {
  ev: "hook-start" | "hook-decision-found" | "hook-end" | "tool-start" | "tool-end";
  pid: number;
  at: number;
  callId?: string | undefined;
  callIdType?: string;
  askedAt?: number | undefined;
  decisionFound?: boolean;
}

export function logEvent(file: string, e: Omit<S5Event, "pid" | "at">): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ...e, pid: process.pid, at: Date.now() }) + "\n");
}

export function buildS5Extension(o: S5Options) {
  const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const gateMe = defineTool({
    name: "gate_me",
    description: "A tool that is gated by an approval hook.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    execute: async () => {
      logEvent(o.logFile, { ev: "tool-start" });
      await nap(o.toolSleepMs);
      logEvent(o.logFile, { ev: "tool-end" });
      return { output: [{ type: "text", text: "gate_me ran" }] };
    },
  });
  const gate = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      if (call.name !== "gate_me") return undefined;
      const callId = (call as { id?: unknown }).id;
      const idStr = typeof callId === "string" ? callId : undefined;
      if (!o.memo) {
        logEvent(o.logFile, { ev: "hook-start", callId: idStr, callIdType: typeof callId });
        await nap(o.hookWaitMs);
        logEvent(o.logFile, { ev: "hook-end", callId: idStr });
        return undefined;
      }
      const askedName = `a7.approval.asked:${idStr ?? "no-id"}`;
      const decisionName = `a7.approval.decision:${idStr ?? "no-id"}`;
      const decided = await api.memo<{ approved: boolean }>(decisionName, context);
      if (decided !== undefined) {
        logEvent(o.logFile, { ev: "hook-decision-found", callId: idStr, decisionFound: true });
        return undefined;
      }
      // returns the ORIGINAL value if the memo already exists (the point of the test)
      const asked = await api.memo<{ askedAt: number }>(askedName, { askedAt: Date.now() }, context);
      logEvent(o.logFile, { ev: "hook-start", callId: idStr, callIdType: typeof callId, askedAt: asked.askedAt, decisionFound: false });
      await nap(o.hookWaitMs);
      await api.memo<{ approved: boolean }>(decisionName, { approved: true }, context);
      logEvent(o.logFile, { ev: "hook-end", callId: idStr, askedAt: asked.askedAt });
      return undefined;
    },
  });
  return defineExtension({ name: "s5", tools: [gateMe], hooks: [gate] });
}

export const S5_PROMPT = "Call the tool gate_me once with note 'go', then reply with the single word gated.";
