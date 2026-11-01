/**
 * Stream-json parser (S12.2, U35). `claude -p --output-format stream-json --verbose` writes one JSON object per line:
 *
 *   {"type":"system","subtype":"init","session_id":...,"tools":[...],"claude_code_version":...,"mcp_servers":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text",...},{"type":"tool_use","id":...,"name":...,"input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,"content":...,"is_error":...}]}}
 *   {"type":"system","subtype":"api_retry","attempt":...,"max_retries":...,"error":...}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","total_cost_usd":...,"duration_ms":...,"permission_denials":[...]}
 *
 * The shapes follow Claude Code's documented SDK message types; they have NOT been checked against a live 2.1.310 run
 * (U35 stays open until the S12.2 [GO] smoke). Unknown lines and unknown fields are skipped, never fatal. Everything is
 * untrusted content: it is bounded here and wrapped later (S14.6).
 */
import type { JobEvent, Json } from "../../../jobs/contracts.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A `JobEvent` before the driver stamps `jobId`, `seq` and `ts`. */
export type EventBody = DistributiveOmit<JobEvent, "jobId" | "seq" | "ts">;

export const MAX_TEXT_CHARS = 16_000;
export const MAX_RESULT_CHARS = 32_000;
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

export interface ParsedResult {
  isError: boolean;
  subtype: string;
  text: string;
  costUsd?: number;
  durationMs?: number;
  permissionDenials: number;
}

export interface ParserOptions {
  /** True when `--include-partial-messages` is on: text then comes from `stream_event` deltas, not from `assistant` blocks. */
  partialMessages?: boolean;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asJson(v: unknown, depth = 0): Json {
  if (depth > 12) return "[too deep]";
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => asJson(x, depth + 1));
  if (isObject(v)) {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v).slice(0, 200)) out[k] = asJson(x, depth + 1);
    return out;
  }
  return null;
}

/** The text of a tool_result `content` (a string, or an array of `{type:"text", text}` blocks). */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return clip(content, MAX_TEXT_CHARS);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (isObject(b) && b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
      else if (isObject(b) && typeof b["type"] === "string") parts.push(`[${b["type"]}]`);
    }
    return parts.length > 0 ? clip(parts.join("\n"), MAX_TEXT_CHARS) : undefined;
  }
  return undefined;
}

export class StreamJsonParser {
  /** Set by the first `session_id` seen. */
  sessionId: string | undefined;
  /** The last `result` line, once seen. */
  result: ParsedResult | undefined;
  /** Lines that were not JSON objects or were too long. */
  skipped = 0;
  private buffer = "";
  private overflow = false;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly opts: ParserOptions = {}) {}

  /** Feed decoded text; returns the events of every complete line. */
  push(chunk: string): EventBody[] {
    const out: EventBody[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) {
        const rest = chunk.slice(start);
        if (!this.overflow) {
          if (this.buffer.length + rest.length > MAX_LINE_CHARS) {
            this.overflow = true;
            this.buffer = "";
          } else this.buffer += rest;
        }
        return out;
      }
      const part = chunk.slice(start, nl);
      start = nl + 1;
      if (this.overflow || this.buffer.length + part.length > MAX_LINE_CHARS) {
        this.skipped++;
        this.overflow = false;
        this.buffer = "";
        continue;
      }
      const line = this.buffer + part;
      this.buffer = "";
      out.push(...this.parseLine(line));
    }
  }

  /** The final unterminated line, if any. */
  flush(): EventBody[] {
    const line = this.buffer;
    this.buffer = "";
    if (this.overflow) {
      this.overflow = false;
      this.skipped++;
      return [];
    }
    return line.trim() === "" ? [] : this.parseLine(line);
  }

  parseLine(line: string): EventBody[] {
    const text = line.trim();
    if (text === "") return [];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.skipped++;
      return [];
    }
    if (!isObject(raw)) {
      this.skipped++;
      return [];
    }
    if (typeof raw["session_id"] === "string" && this.sessionId === undefined) this.sessionId = raw["session_id"];
    switch (raw["type"]) {
      case "system":
        return this.system(raw);
      case "assistant":
        return this.assistant(raw);
      case "user":
        return this.user(raw);
      case "stream_event":
        return this.streamEvent(raw);
      case "result":
        return this.resultLine(raw);
      default:
        return [];
    }
  }

  private system(o: Record<string, unknown>): EventBody[] {
    if (o["subtype"] === "init") {
      const ev: EventBody & { kind: "init" } = { kind: "init" };
      if (typeof o["session_id"] === "string") ev.engineSessionId = o["session_id"];
      if (typeof o["claude_code_version"] === "string") ev.engineVersion = o["claude_code_version"];
      if (Array.isArray(o["tools"])) ev.tools = o["tools"].filter((t): t is string => typeof t === "string").slice(0, 500);
      const out: EventBody[] = [ev];
      if (Array.isArray(o["mcp_servers"])) {
        for (const s of o["mcp_servers"].slice(0, 50)) {
          if (isObject(s) && typeof s["name"] === "string" && typeof s["status"] === "string" && s["status"] !== "connected") {
            out.push({ kind: "progress", message: `MCP server ${clip(s["name"], 80)} is ${clip(s["status"], 40)}` });
          }
        }
      }
      return out;
    }
    if (o["subtype"] === "api_retry") {
      const attempt = typeof o["attempt"] === "number" ? o["attempt"] : 1;
      const reasonRaw = o["error"] ?? o["error_status"] ?? "api error";
      const reason = typeof reasonRaw === "string" ? reasonRaw : JSON.stringify(asJson(reasonRaw));
      return [{ kind: "retry", attempt, reason: clip(reason, 300) }];
    }
    return [];
  }

  private content(o: Record<string, unknown>): unknown[] {
    const m = o["message"];
    if (!isObject(m)) return [];
    return Array.isArray(m["content"]) ? m["content"] : [];
  }

  private assistant(o: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [];
    for (const b of this.content(o)) {
      if (!isObject(b)) continue;
      if (b["type"] === "text" && typeof b["text"] === "string" && b["text"] !== "") {
        if (!this.opts.partialMessages) out.push({ kind: "text", text: clip(b["text"], MAX_TEXT_CHARS) });
      } else if (b["type"] === "tool_use" && typeof b["name"] === "string") {
        const callId = typeof b["id"] === "string" ? b["id"] : undefined;
        if (callId !== undefined) this.toolNames.set(callId, b["name"]);
        const ev: EventBody & { kind: "tool_call" } = { kind: "tool_call", tool: clip(b["name"], 200), input: asJson(b["input"] ?? {}) };
        if (callId !== undefined) ev.callId = callId;
        out.push(ev);
      }
    }
    return out;
  }

  private user(o: Record<string, unknown>): EventBody[] {
    const out: EventBody[] = [];
    for (const b of this.content(o)) {
      if (!isObject(b) || b["type"] !== "tool_result") continue;
      const callId = typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : undefined;
      const ev: EventBody & { kind: "tool_result" } = {
        kind: "tool_result",
        tool: (callId !== undefined ? this.toolNames.get(callId) : undefined) ?? "unknown",
        ok: b["is_error"] !== true,
      };
      if (callId !== undefined) ev.callId = callId;
      const text = resultText(b["content"]);
      if (text !== undefined) ev.text = text;
      out.push(ev);
    }
    return out;
  }

  private streamEvent(o: Record<string, unknown>): EventBody[] {
    if (!this.opts.partialMessages) return [];
    const e = o["event"];
    if (!isObject(e) || e["type"] !== "content_block_delta" || !isObject(e["delta"])) return [];
    const d = e["delta"];
    if (d["type"] === "text_delta" && typeof d["text"] === "string" && d["text"] !== "") return [{ kind: "text", text: clip(d["text"], MAX_TEXT_CHARS) }];
    return [];
  }

  private resultLine(o: Record<string, unknown>): EventBody[] {
    const subtype = typeof o["subtype"] === "string" ? o["subtype"] : "unknown";
    const isError = o["is_error"] === true || (subtype !== "success" && subtype !== "unknown");
    let text = typeof o["result"] === "string" ? o["result"] : "";
    if (text === "" && isError) text = `Claude Code ended with ${subtype}`;
    const denials = Array.isArray(o["permission_denials"]) ? o["permission_denials"].length : 0;
    const r: ParsedResult = { isError, subtype, text: clip(text, MAX_RESULT_CHARS), permissionDenials: denials };
    if (typeof o["total_cost_usd"] === "number" && Number.isFinite(o["total_cost_usd"])) r.costUsd = o["total_cost_usd"];
    if (typeof o["duration_ms"] === "number" && Number.isFinite(o["duration_ms"])) r.durationMs = o["duration_ms"];
    this.result = r;
    const ev: EventBody & { kind: "result" } = { kind: "result", text: r.text, permissionDenials: denials };
    if (r.costUsd !== undefined) ev.costUsd = r.costUsd;
    if (r.durationMs !== undefined) ev.durationMs = r.durationMs;
    return [ev];
  }
}

/** Recorded-fixture smoke for the version guard (S12.5): parse every fixture and compare the event kinds. */
export interface ParserFixture {
  name: string;
  lines: readonly string[];
  /** The event kinds the fixture must produce, in order. */
  expectKinds: readonly string[];
}

export function runParserSmoke(fixtures: readonly ParserFixture[]): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (fixtures.length === 0) failures.push("no fixtures");
  for (const f of fixtures) {
    const p = new StreamJsonParser();
    const kinds = [...p.push(f.lines.join("\n") + "\n"), ...p.flush()].map((e) => e.kind);
    if (kinds.join(",") !== f.expectKinds.join(",")) failures.push(`${f.name}: expected [${f.expectKinds.join(",")}] got [${kinds.join(",")}]`);
  }
  return { ok: failures.length === 0, failures };
}
