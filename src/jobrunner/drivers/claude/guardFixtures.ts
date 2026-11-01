/**
 * Stream-json fixtures for the S12.5 version guard's parser smoke. They are written from Claude Code's documented message
 * shapes, NOT recorded from a real `claude` run (the real binary is never run offline). So the smoke proves the parser
 * still handles the shapes we know; the second half of the guard (one harmless live probe job under the new version) is
 * what checks them against the real binary. Replace these with recorded lines after the first live smoke (U35).
 */
import type { ParserFixture } from "./parser.js";

const SID = "11111111-2222-3333-4444-555555555555";

const OK_RUN: object[] = [
  { type: "system", subtype: "init", session_id: SID, cwd: "C:\\scratch", model: "claude-sonnet-5-5", permissionMode: "default", claude_code_version: "0.0.0", tools: ["Read", "Glob", "Grep"], mcp_servers: [{ name: "a7perm", status: "connected" }, { name: "book-translator", status: "failed" }] },
  { type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "text", text: "I will list runs/." }] } },
  { type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Glob", input: { pattern: "runs/*" } }] } },
  { type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "runs/a.txt", is_error: false }] } },
  { type: "system", subtype: "api_retry", attempt: 1, max_retries: 5, retry_delay_ms: 500, error_status: 529, error: "overloaded" },
  { type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "text", text: "One file." }] } },
  { type: "result", subtype: "success", is_error: false, result: "One file.", session_id: SID, total_cost_usd: 0.01, duration_ms: 100, num_turns: 3, permission_denials: [] },
];

const ERROR_RUN: object[] = [
  OK_RUN[0] as object,
  { type: "result", subtype: "error_max_turns", is_error: true, session_id: SID, total_cost_usd: 0.5, duration_ms: 99, permission_denials: [] },
];

export const GUARD_PARSER_FIXTURES: readonly ParserFixture[] = [
  { name: "ok-run", lines: OK_RUN.map((m) => JSON.stringify(m)), expectKinds: ["init", "progress", "text", "tool_call", "tool_result", "retry", "text", "result"] },
  { name: "error-run", lines: ERROR_RUN.map((m) => JSON.stringify(m)), expectKinds: ["init", "progress", "result"] },
];
