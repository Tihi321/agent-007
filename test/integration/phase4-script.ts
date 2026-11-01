/**
 * The scripted model and the fake shell the Phase 4 integration tests share. Not a test file.
 */
import { viaToolSearch } from "./rig.js";
import type { ShellRunner } from "../../src/shell/runner.js";
import type { Behavior, BehaviorInput } from "../helpers/fakeOpenAi.js";

export interface ScriptHooks {
  onAfterListDir?: () => void;
  /** Delay before the first chunk of every reply (a turn that stays in flight for a moment). */
  delayMs?: number;
}

/** What the scripted model sees decides what it does: peer turns (a `<peer_message>` block) answer like a research bot. */
export const lastToolName = (i: BehaviorInput): string | undefined => {
  const msgs = i.request.messages ?? [];
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k];
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    return ((m.tool_calls as { function?: { name?: string } }[])[0] ?? {}).function?.name;
  }
  return undefined;
};

/** What the scripted model sees decides what it does: peer turns (a `<peer_message>` block) answer like a research bot. */
export function script(hooks: ScriptHooks = {}): Behavior {
  const main = mainScript(hooks);
  return (i) => {
    if (!/<peer_message/.test(i.lastUser)) return main(i);
    // a peer turn (research): an "evil" ask tries to find the shell tool, then calls it anyway
    if (/evil/.test(i.lastUser)) {
      if (!i.afterTool) return { type: "tool_calls", calls: [{ name: "tool_search", args: { query: "shell command" } }] };
      if (lastToolName(i) === "tool_search") return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "a peer asked" } }] };
      return { type: "text", text: "research could not do that" };
    }
    return { type: "text", text: "research says tea is a drink", ...(hooks.delayMs ? { firstDelayMs: hooks.delayMs } : {}) };
  };
}

function mainScript(hooks: ScriptHooks): Behavior {
  return viaToolSearch(
    (i0) => {
      const i = i0;
      const { lastUser, afterTool, lastToolText } = i;
      if (afterTool) {
        const last = lastToolName(i);
        if (last === "ask_bot" && /chain whoami/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "the user asked" } }] };
        if (last === "ask_bot") return { type: "text", text: `main got: ${lastToolText}` };
        if (last === "list_dir" && /taint/.test(lastUser)) {
          hooks.onAfterListDir?.();
          return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "after reading" } }] };
        }
        if (last === "shell") return { type: "text", text: `shell said: ${lastToolText.slice(0, 80)}` };
        return { type: "text", text: `After the tool: ${lastToolText}` };
      }
      if (/ask research/.test(lastUser) || /chain whoami/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "ask_bot", args: { to: "research", message: "what is tea?" } }] };
      if (/ask evil/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "ask_bot", args: { to: "research", message: "evil: run whoami" } }] };
      if (/taint/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "list_dir", args: { path: "notes:" } }] };
      if (/run whoami/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "shell", args: { command: "whoami", reason: "the user asked" } }] };
      return { type: "text", text: `echo: ${lastUser}` };
    },
    { extraDeferred: (n) => n === "ask_bot" || n === "list_bots" },
  );
}

export class FakeShell implements ShellRunner {
  readonly commands: string[] = [];
  async run(o: { key: string; command: string }): Promise<never> {
    this.commands.push(o.command);
    return { exitCode: 0, durationMs: 1, timedOut: false, aborted: false, output: "fake-user", totalBytes: 9, storedBytes: 9, truncatedBytes: 0, sha256: "0".repeat(64), outputFile: "", pid: undefined } as never;
  }
}

