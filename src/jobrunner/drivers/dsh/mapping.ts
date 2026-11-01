/**
 * `session/update` to `JobEvent` bodies (S13.2). Pure: the driver adds `jobId`, `seq` and `ts`. Streamed text and tool output
 * are untrusted (S14.6); this only shapes and caps them. Agent thoughts are not forwarded. Updates this driver does not know
 * (the v1 schema grows) are ignored, never an error.
 */
import type { Json, JobEvent } from "../../../jobs/contracts.js";
import { toJsonInput, toolNameOf } from "./permissions.js";
import type { SessionUpdate } from "./session.js";

export type EventBody = JobEvent extends infer E ? (E extends unknown ? Omit<E, "jobId" | "seq" | "ts"> : never) : never;

const MAX_TOOL_RESULT_CHARS = 2000;

function textOfBlock(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  const b = block as { type?: unknown; text?: unknown; uri?: unknown; name?: unknown };
  if (b.type === "text" && typeof b.text === "string") return b.text;
  if (b.type === "resource_link" && typeof b.uri === "string") return `[link ${b.uri}]`;
  if (b.type === "image") return "[image]";
  if (b.type === "audio") return "[audio]";
  return "";
}

/** Text of a tool call's `content` array (text blocks and diffs by path only). */
export function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c !== "object" || c === null) continue;
    const item = c as { type?: unknown; content?: unknown; path?: unknown };
    if (item.type === "content") parts.push(textOfBlock(item.content));
    else if (item.type === "diff" && typeof item.path === "string") parts.push(`[edit ${item.path}]`);
    else if (item.type === "terminal") parts.push("[terminal output]");
  }
  return parts.filter((p) => p !== "").join("\n");
}

export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [${text.length - max} more characters]`;
}

/** The text of an `agent_message_chunk`, or undefined for any other update. */
export function messageChunkText(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "agent_message_chunk") return undefined;
  return textOfBlock(update.content);
}

/** Everything except message chunks. The driver handles message chunks itself (coalescing). */
export function mapUpdate(update: SessionUpdate, toolNames: Map<string, string>): { events: EventBody[]; costUsd?: number } {
  switch (update.sessionUpdate) {
    case "tool_call": {
      const name = toolNameOf(update);
      toolNames.set(update.toolCallId, name);
      const events: EventBody[] = [{ kind: "tool_call", callId: update.toolCallId, tool: name, input: toJsonInput(update.rawInput) }];
      if (update.status === "completed" || update.status === "failed") events.push(resultEvent(update.toolCallId, name, update.status, update.content, update.rawOutput));
      return { events };
    }
    case "tool_call_update": {
      const known = toolNames.get(update.toolCallId);
      const name = (update.name ?? "").trim() || known || (update.title ?? "").trim() || "tool";
      if (known === undefined) toolNames.set(update.toolCallId, name);
      if (update.status === "completed" || update.status === "failed") return { events: [resultEvent(update.toolCallId, name, update.status, update.content, update.rawOutput)] };
      return { events: [] };
    }
    case "plan": {
      const entries = update.entries;
      const done = entries.filter((e) => e.status === "completed").length;
      const current = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status === "pending");
      const message = `plan ${done}/${entries.length}${current ? `: ${capText(current.content, 160)}` : ""}`;
      return { events: [{ kind: "progress", message, ...(entries.length > 0 ? { fraction: done / entries.length } : {}) }] };
    }
    case "notice":
      return { events: [{ kind: "progress", message: capText(`${update.severity}: ${update.title}`, 300) }] };
    case "compaction_update":
      return { events: [{ kind: "progress", message: `context compaction ${update.status}` }] };
    case "usage_update": {
      const cost = update.cost;
      if (cost && cost.currency.toUpperCase() === "USD" && Number.isFinite(cost.amount)) return { events: [], costUsd: cost.amount };
      return { events: [] };
    }
    default:
      // user_message_chunk, agent_message_chunk, agent_thought_chunk, available_commands_update, current_mode_update,
      // config_option_update, session_info_update, compaction_summary_chunk, and anything newer.
      return { events: [] };
  }
}

function resultEvent(callId: string, tool: string, status: "completed" | "failed", content: unknown, rawOutput: unknown): EventBody {
  let text = toolContentText(content);
  if (text === "" && rawOutput !== undefined) {
    const j: Json = toJsonInput(rawOutput);
    text = typeof j === "string" ? j : JSON.stringify(j);
  }
  const ev: EventBody = { kind: "tool_result", callId, tool, ok: status === "completed" };
  return text === "" ? ev : { ...ev, text: capText(text, MAX_TOOL_RESULT_CHARS) };
}
