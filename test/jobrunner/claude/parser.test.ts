import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TEXT_CHARS, StreamJsonParser, runParserSmoke } from "../../../src/jobrunner/drivers/claude/parser.js";
import { PARSER_FIXTURES, SESSION_ID, errorMessages, okMessages, toLines } from "./fixtures.js";

function parseAll(lines: string[], opts = {}): { events: ReturnType<StreamJsonParser["push"]>; parser: StreamJsonParser } {
  const parser = new StreamJsonParser(opts);
  const events = [...parser.push(lines.join("\n") + "\n"), ...parser.flush()];
  return { events, parser };
}

describe("stream-json parser (S12.2, U35 fixtures)", () => {
  it("maps a full run to JobEvent bodies", () => {
    const { events, parser } = parseAll(toLines(okMessages()));
    assert.deepEqual(events.map((e) => e.kind), ["init", "progress", "text", "tool_call", "tool_result", "retry", "text", "result"]);
    assert.deepEqual(events[0], { kind: "init", engineSessionId: SESSION_ID, engineVersion: "2.1.310", tools: ["Read", "Glob", "Grep", "mcp__a7perm__decide"] });
    assert.deepEqual(events[1], { kind: "progress", message: "MCP server book-translator is failed" });
    assert.deepEqual(events[2], { kind: "text", text: "I will list runs/." });
    assert.deepEqual(events[3], { kind: "tool_call", callId: "toolu_01", tool: "Glob", input: { pattern: "runs/*" } });
    assert.deepEqual(events[4], { kind: "tool_result", callId: "toolu_01", tool: "Glob", ok: true, text: "runs/a.txt\nruns/b.txt" });
    assert.deepEqual(events[5], { kind: "retry", attempt: 1, reason: "overloaded" });
    assert.deepEqual(events[7], { kind: "result", text: "Two files: a.txt and b.txt.", permissionDenials: 0, costUsd: 0.0123, durationMs: 4321 });
    assert.equal(parser.sessionId, SESSION_ID);
    assert.equal(parser.result?.isError, false);
    assert.equal(parser.skipped, 0);
  });

  it("reports an error result with its permission denials", () => {
    const { events, parser } = parseAll(toLines(errorMessages()));
    const r = events.at(-1);
    assert.equal(r?.kind, "result");
    assert.equal(r?.kind === "result" ? r.permissionDenials : -1, 1);
    assert.equal(parser.result?.isError, true);
    assert.equal(parser.result?.subtype, "error_max_turns");
    assert.match(parser.result?.text ?? "", /error_max_turns/);
  });

  it("gives the same events whatever the chunk boundaries are, including CRLF and a final unterminated line", () => {
    const text = toLines(okMessages()).join("\r\n"); // no trailing newline
    const whole = parseAll([text]).events;
    for (const size of [1, 7, 64, 1000]) {
      const p = new StreamJsonParser();
      const out = [];
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
      out.push(...p.flush());
      assert.deepEqual(out, whole, `chunk size ${size}`);
    }
  });

  it("matches a tool_result to its tool name and flags errors", () => {
    const lines = toLines([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "denied" }, { type: "image" }], is_error: true }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] } },
    ]);
    const { events } = parseAll(lines);
    assert.deepEqual(events[1], { kind: "tool_result", callId: "t1", tool: "Read", ok: false, text: "denied\n[image]" });
    assert.deepEqual(events[2], { kind: "tool_result", callId: "nope", tool: "unknown", ok: true, text: "x" });
  });

  it("skips garbage, unknown types and unknown fields without throwing", () => {
    const { events, parser } = parseAll(["not json", "[1,2]", "42", JSON.stringify({ type: "rate_limit_event" }), JSON.stringify({ type: "system", subtype: "hook_started" }), "", JSON.stringify({ type: "assistant", message: "weird" })]);
    assert.deepEqual(events, []);
    assert.equal(parser.skipped, 3);
  });

  it("bounds long text", () => {
    const big = "x".repeat(MAX_TEXT_CHARS + 500);
    const { events } = parseAll(toLines([{ type: "assistant", message: { content: [{ type: "text", text: big }] } }]));
    const t = events[0];
    assert.equal(t?.kind, "text");
    assert.ok(t?.kind === "text" && t.text.length < big.length && t.text.includes("more characters not shown"));
  });

  it("with partial messages, text comes from deltas only", () => {
    const lines = toLines([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
    ]);
    assert.deepEqual(parseAll(lines, { partialMessages: true }).events, [
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
    assert.deepEqual(parseAll(lines).events, [{ kind: "text", text: "Hello" }]);
  });

  it("parser smoke on recorded fixtures passes, and fails when a shape changes", () => {
    assert.deepEqual(runParserSmoke(PARSER_FIXTURES), { ok: true, failures: [] });
    const broken = PARSER_FIXTURES.map((f) => ({ ...f, lines: f.lines.map((l) => l.replace('"type":"result"', '"type":"final"')) }));
    const r = runParserSmoke(broken);
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 2);
    assert.equal(runParserSmoke([]).ok, false);
  });
});
