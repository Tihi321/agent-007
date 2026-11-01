import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_PERMISSION_MODES,
  ClaudeArgvError,
  PERMISSION_TOOL,
  assertSafeArgv,
  buildClaudeArgs,
  buildClaudeEnv,
  claudePathPattern,
  denyRulesForPaths,
} from "../../../src/jobrunner/drivers/claude/argv.js";
import type { JobTemplate } from "../../../src/jobs/contracts.js";
import { DENY_PATHS, makeTemplate } from "./helpers.js";

const MCP = "C:\\data\\jobs\\j1\\mcp.json";

function build(over: Partial<JobTemplate> = {}, extra: { resumeSessionId?: string; denyPaths?: readonly string[] } = {}): string[] {
  return buildClaudeArgs({ template: makeTemplate(over), mcpConfigPath: MCP, denyPaths: extra.denyPaths ?? DENY_PATHS, ...(extra.resumeSessionId ? { resumeSessionId: extra.resumeSessionId } : {}) }).args;
}

describe("claude argv (S12.2)", () => {
  it("builds the exact argv for a read-only template", () => {
    const args = build();
    assert.deepEqual(args, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "default",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "--disallowedTools",
      "Bash",
      "PowerShell",
      "mcp__flow-music-mcp__*",
      "Read(//c/Pixotope/**)",
      "Edit(//c/Pixotope/**)",
      "Write(//c/Pixotope/**)",
      "Read(//d/Work/Repos/**)",
      "Edit(//d/Work/Repos/**)",
      "Write(//d/Work/Repos/**)",
      "Read(//c/ProgramData/agent-007/**)",
      "Edit(//c/ProgramData/agent-007/**)",
      "Write(//c/ProgramData/agent-007/**)",
      "Read(//c/Users/agent/AppData/Local/agent-007/**)",
      "Edit(//c/Users/agent/AppData/Local/agent-007/**)",
      "Write(//c/Users/agent/AppData/Local/agent-007/**)",
      "WebFetch",
      "--permission-prompt-tool",
      "mcp__a7perm__decide",
      "--mcp-config",
      MCP,
    ]);
    assert.equal(PERMISSION_TOOL, "mcp__a7perm__decide");
  });

  it("uses dontAsk, a model and --resume when asked", () => {
    const args = build({ permissionMode: "dontAsk", model: "sonnet" }, { resumeSessionId: "abc-123" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
    assert.equal(args[args.indexOf("--resume") + 1], "abc-123");
    assert.equal(args.includes("--bare"), false);
  });

  it("never allows bypassPermissions, auto, acceptEdits or plan (any template)", () => {
    for (const mode of ["bypassPermissions", "auto", "acceptEdits", "plan", "", "DEFAULT", "dontask"]) {
      assert.throws(() => build({ permissionMode: mode as never }), ClaudeArgvError, `mode ${mode}`);
    }
    assert.deepEqual([...ALLOWED_PERMISSION_MODES], ["default", "dontAsk"]);
    for (const mode of ALLOWED_PERMISSION_MODES) {
      const args = build({ permissionMode: mode });
      assert.equal(args.includes("bypassPermissions"), false);
      assert.equal(args.includes("auto"), false);
      assert.equal(args.includes("--dangerously-skip-permissions"), false);
    }
  });

  it("assertSafeArgv refuses forbidden flags and modes in a finished argv", () => {
    const base = build();
    assert.doesNotThrow(() => assertSafeArgv(base));
    assert.throws(() => assertSafeArgv([...base, "--dangerously-skip-permissions"]), ClaudeArgvError);
    assert.throws(() => assertSafeArgv([...base, "--bare"]), ClaudeArgvError);
    assert.throws(() => assertSafeArgv([...base, "--settings", "x.json"]), ClaudeArgvError);
    assert.throws(() => assertSafeArgv([...base, "--permission-mode", "dontAsk"]), ClaudeArgvError);
    assert.throws(() => assertSafeArgv(["-p", "--permission-mode", "bypassPermissions"]), ClaudeArgvError);
    assert.throws(() => assertSafeArgv(["-p"]), ClaudeArgvError);
  });

  it("always disallows the shell tools, even if the template omits them", () => {
    const { disallowedTools } = buildClaudeArgs({ template: makeTemplate({ disallowedTools: [] }), mcpConfigPath: MCP, denyPaths: [] });
    assert.ok(disallowedTools.includes("Bash"));
    assert.ok(disallowedTools.includes("PowerShell"));
  });

  it("refuses shell or Flow tools and a bare wildcard in allowedTools", () => {
    assert.throws(() => build({ allowedTools: ["Read", "Bash"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["Bash(git log *)"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["powershell"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["mcp__flow-music-mcp__generate"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["mcp__flow-music-mcp"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["*"] }), ClaudeArgvError);
    assert.throws(() => build({ allowedTools: ["--help"] }), ClaudeArgvError);
    assert.doesNotThrow(() => build({ allowedTools: ["mcp__vibetts__speak"] }));
  });

  it("denies the Flow server unless the template enables Flow", () => {
    assert.ok(build({ flow: { enabled: false } }).includes("mcp__flow-music-mcp__*"));
    const enabled = buildClaudeArgs({ template: makeTemplate({ flow: { enabled: true, estimate: 10 } }), mcpConfigPath: MCP, denyPaths: [] });
    assert.equal(enabled.disallowedTools.includes("mcp__flow-music-mcp__*"), false);
    // and Flow tools still cannot be pre-allowed, so every Flow call reaches the permission tool
    assert.throws(() => build({ flow: { enabled: true }, allowedTools: ["mcp__flow-music-mcp__x"] }), ClaudeArgvError);
  });

  it("builds one Read, Edit and Write deny rule per configured path (a new path adds rules, no code change)", () => {
    const three = build({}, { denyPaths: ["C:\\A", "C:\\B", "E:\\C\\D"] }).filter((a) => /^(Read|Edit|Write)\(\/\//.test(a));
    assert.equal(three.length, 9);
    const four = build({}, { denyPaths: ["C:\\A", "C:\\B", "E:\\C\\D", "F:\\New"] }).filter((a) => /^(Read|Edit|Write)\(\/\//.test(a));
    assert.equal(four.length, 12);
    assert.deepEqual(four.slice(9), ["Read(//f/New/**)", "Edit(//f/New/**)", "Write(//f/New/**)"]);
    assert.deepEqual(build({}, { denyPaths: [] }).filter((a) => /^(Read|Edit|Write)\(\/\//.test(a)), []);
  });

  it("converts Windows paths to Claude absolute-path patterns [U46 form]", () => {
    assert.equal(claudePathPattern("C:\\Pixotope"), "//c/Pixotope/**");
    assert.equal(claudePathPattern("C:\\Pixotope\\"), "//c/Pixotope/**");
    assert.equal(claudePathPattern("c:/Work/My Repo"), "//c/Work/My Repo/**");
    assert.equal(claudePathPattern("D:\\"), "//d/**");
    assert.equal(claudePathPattern("C:\\x\\**"), "//c/x/**");
    assert.throws(() => claudePathPattern("\\\\server\\share\\x"), ClaudeArgvError);
    assert.throws(() => claudePathPattern("relative\\path"), ClaudeArgvError);
    assert.throws(() => claudePathPattern("  "), ClaudeArgvError);
    assert.deepEqual(denyRulesForPaths(["C:\\Q"]), ["Read(//c/Q/**)", "Edit(//c/Q/**)", "Write(//c/Q/**)"]);
  });

  it("rejects an odd session id or model name", () => {
    assert.throws(() => build({}, { resumeSessionId: "a b; rm" }), ClaudeArgvError);
    assert.throws(() => build({ model: "x --bare" }), ClaudeArgvError);
  });

  it("strips ANTHROPIC_* (any case) and provider switches from the env, keeps the rest", () => {
    const env = buildClaudeEnv({
      PATH: "C:\\bin",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "http://x",
      anthropic_model: "m",
      ANTHROPIC_FOO: "f",
      CLAUDE_CODE_USE_BEDROCK: "1",
      A7_JOB_TOKEN: "tok",
      BOOK_TRANSLATOR_TOKEN: "keep",
    });
    assert.deepEqual(env, { PATH: "C:\\bin", BOOK_TRANSLATOR_TOKEN: "keep" });
  });
});
