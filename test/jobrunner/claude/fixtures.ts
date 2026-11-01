/**
 * Stream-json fixtures for the Claude driver tests. They are written from Claude Code's documented message shapes (S12.2,
 * U35), NOT recorded from a real `claude` run: the real binary is never run in tests (it spends quota and acts as the
 * user). The live [GO] smoke (S12.2) is where U35 gets checked against 2.1.310.
 */
import type { ParserFixture } from "../../../src/jobrunner/drivers/claude/parser.js";

export const SESSION_ID = "11111111-2222-3333-4444-555555555555";

export function okMessages(): object[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: SESSION_ID,
      cwd: "C:\\projects\\Personal\\creative-hub",
      model: "claude-sonnet-5-5",
      permissionMode: "default",
      claude_code_version: "2.1.310",
      tools: ["Read", "Glob", "Grep", "mcp__a7perm__decide"],
      mcp_servers: [
        { name: "a7perm", status: "connected" },
        { name: "book-translator", status: "failed" },
      ],
    },
    { type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: "I will list runs/." }] } },
    { type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Glob", input: { pattern: "runs/*" } }] } },
    { type: "user", session_id: SESSION_ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "runs/a.txt\nruns/b.txt", is_error: false }] } },
    { type: "system", subtype: "api_retry", attempt: 1, max_retries: 5, retry_delay_ms: 500, error_status: 529, error: "overloaded" },
    { type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: "Two files: a.txt and b.txt." }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Two files: a.txt and b.txt.",
      session_id: SESSION_ID,
      total_cost_usd: 0.0123,
      duration_ms: 4321,
      num_turns: 3,
      permission_denials: [],
    },
  ];
}

export function errorMessages(): object[] {
  const [init] = okMessages();
  return [
    init as object,
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: SESSION_ID,
      total_cost_usd: 0.5,
      duration_ms: 99,
      permission_denials: [{ tool_name: "Read", tool_use_id: "toolu_09", tool_input: { file_path: "C:\\Pixotope\\x" } }],
    },
  ];
}

export function toLines(messages: readonly object[]): string[] {
  return messages.map((m) => JSON.stringify(m));
}

export const PARSER_FIXTURES: ParserFixture[] = [
  {
    name: "ok-run",
    lines: toLines(okMessages()),
    expectKinds: ["init", "progress", "text", "tool_call", "tool_result", "retry", "text", "result"],
  },
  { name: "error-run", lines: toLines(errorMessages()), expectKinds: ["init", "progress", "result"] },
];
