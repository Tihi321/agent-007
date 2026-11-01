/** The driver against a fake `claude` (a node script). The real binary is never run. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClaudeArgvError } from "../../../src/jobrunner/drivers/claude/argv.js";
import { ClaudeDriver, ClaudePreflightError } from "../../../src/jobrunner/drivers/claude/driver.js";
import { startIpcServer } from "../../../src/ipc/server.js";
import type { JobEvent } from "../../../src/jobs/contracts.js";
import { SESSION_ID } from "./fixtures.js";
import { FAKE_CLAUDE, FakeHost, FakePolicy, HELPER_JS, collect, isAlive, makeRig, makeSpec, makeTemplate, sleep, waitFor } from "./helpers.js";

interface Record_ {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
}

function readRecord(path: string): Record_ {
  return JSON.parse(readFileSync(path, "utf8")) as Record_;
}

function terminal(events: JobEvent[]): string {
  const last = events.at(-1);
  return last?.kind === "state" ? last.state : "(none)";
}

describe("claude driver with a fake claude (S12.2, S12.4)", () => {
  it("records the version, runs a job and streams gapless events ending with result then a terminal state", async () => {
    const rig = makeRig("ok");
    try {
      assert.equal(await rig.driver.version(), "2.1.310 (Claude Code)");
      await rig.driver.start(makeSpec({ jobId: "job-ok", cwd: rig.cwd }));
      const events = await collect(rig.driver.events("job-ok"));
      assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq is gapless from 1");
      assert.ok(events.every((e) => e.jobId === "job-ok" && e.ts > 0));
      assert.deepEqual(events.map((e) => e.kind), ["state", "init", "progress", "text", "tool_call", "tool_result", "retry", "text", "result", "state"]);
      assert.deepEqual(events[0], { jobId: "job-ok", seq: 1, ts: events[0]!.ts, kind: "state", state: "running" });
      const init = events[1]!;
      assert.ok(init.kind === "init" && init.engineSessionId === SESSION_ID && init.engineVersion === "2.1.310");
      const result = events.at(-2)!;
      assert.ok(result.kind === "result" && result.costUsd === 0.0123 && result.durationMs === 4321 && result.permissionDenials === 0);
      assert.equal(terminal(events), "succeeded");
      assert.equal(rig.driver.runningCount, 0);
      assert.equal(rig.broker.activeCount, 0);
    } finally {
      rig.cleanup();
    }
  });

  it("starts claude in the job cwd with the exact argv, the prompt on stdin and no ANTHROPIC_* in its env", async () => {
    const rig = makeRig("ok", {}, { ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://evil", anthropic_extra: "x", BOOK_TRANSLATOR_TOKEN: "keep-me" });
    try {
      const spec = makeSpec({ jobId: "job-argv", cwd: rig.cwd, prompt: "Zażółć gęślą jaźń: do the thing" });
      await rig.driver.start(spec);
      await collect(rig.driver.events("job-argv"));
      const rec = readRecord(rig.recordPath);
      assert.equal(rec.cwd.toLowerCase(), rig.cwd.toLowerCase());
      assert.equal(rec.stdin, "Zażółć gęślą jaźń: do the thing");
      assert.deepEqual(rec.env, {}, "no ANTHROPIC_* and no A7_* in claude's own env");
      assert.deepEqual(rec.argv.slice(0, 6), ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"]);
      assert.equal(rec.argv.includes("bypassPermissions"), false);
      assert.equal(rec.argv.includes("auto"), false);
      const dis = rec.argv.slice(rec.argv.indexOf("--disallowedTools") + 1);
      assert.ok(dis.includes("Bash") && dis.includes("PowerShell") && dis.includes("mcp__flow-music-mcp__*"));
      assert.ok(dis.includes("Read(//c/Pixotope/**)") && dis.includes("Edit(//c/Pixotope/**)") && dis.includes("Write(//c/Pixotope/**)"));
      assert.equal(rec.argv[rec.argv.indexOf("--permission-prompt-tool") + 1], "mcp__a7perm__decide");
      assert.equal(rec.argv.includes(spec.prompt), false, "the brief is never on the command line");
      assert.equal(rec.argv.some((a) => a.includes("sk-secret")), false);
    } finally {
      rig.cleanup();
    }
  });

  it("writes a job-scoped mcp-config with the token only there, and deletes it when the job ends", async () => {
    const rig = makeRig("slow");
    try {
      await rig.driver.start(makeSpec({ jobId: "job-cfg", cwd: rig.cwd }));
      const cfgPath = join(rig.dataDir, "jobs", "job-cfg", "mcp.json");
      assert.ok(existsSync(cfgPath));
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcpServers: { a7perm: { type: string; env: Record<string, string> } } };
      assert.equal(cfg.mcpServers.a7perm.type, "stdio");
      assert.equal(cfg.mcpServers.a7perm.env["A7_JOB_ID"], "job-cfg");
      assert.equal(cfg.mcpServers.a7perm.env["A7_JOB_PORT"], "1");
      assert.match(cfg.mcpServers.a7perm.env["A7_JOB_TOKEN"] ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.ok(rig.broker.isActive("job-cfg"));
      const events = await collect(rig.driver.events("job-cfg"));
      assert.equal(terminal(events), "succeeded");
      assert.equal(existsSync(cfgPath), false, "mcp-config is gone");
      assert.equal(existsSync(join(rig.dataDir, "jobs", "job-cfg")), false);
      assert.equal(rig.broker.isActive("job-cfg"), false, "token is revoked");
      const rec = readRecord(rig.recordPath);
      assert.equal(JSON.stringify(rec).includes(cfg.mcpServers.a7perm.env["A7_JOB_TOKEN"]!), false, "the token never reaches claude's argv or env");
    } finally {
      rig.cleanup();
    }
  });

  it("a permission prompt from the helper reaches the host exactly once, and a Deny is reported by the job", async () => {
    const policy = new FakePolicy("ask");
    const host = new FakeHost(policy);
    host.answer = "deny";
    const rig = makeRig("askperm");
    // the runner's IPC server, wired as S11 will wire it
    const { server, port } = await startIpcServer({
      port: 0,
      keys: (peek) => rig.broker.keys(peek),
      handler: (type, body, ctx) => (type === "permission_request" ? rig.broker.handle(ctx.principal, body) : undefined),
    });
    try {
      const driver = new ClaudeDriver({
        command: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        dataDir: rig.dataDir,
        ipcPort: port,
        broker: rig.broker,
        denyPaths: [],
        env: rig.env,
        helperCommand: process.execPath,
        helperArgs: [HELPER_JS],
      });
      await driver.start(makeSpec({ jobId: "job-perm", cwd: rig.cwd, host }));
      const events = await collect(driver.events("job-perm"));
      assert.equal(host.asked.length, 1);
      assert.equal(host.asked[0]?.tool, "Write");
      assert.equal(host.asked[0]?.requestId, "toolu_perm01");
      const res = events.find((e) => e.kind === "result");
      assert.ok(res?.kind === "result" && res.text === "decision=deny configExisted=true" && res.permissionDenials === 1, JSON.stringify(res));
      const tr = events.find((e) => e.kind === "tool_result");
      assert.ok(tr?.kind === "tool_result" && tr.ok === false);
      assert.equal(terminal(events), "succeeded");

      // and an Allow once
      host.answer = "allow_once";
      await driver.start(makeSpec({ jobId: "job-perm2", cwd: rig.cwd, host }));
      const events2 = await collect(driver.events("job-perm2"));
      assert.equal(host.asked.length, 2);
      assert.ok(events2.some((e) => e.kind === "result" && e.text === "decision=allow configExisted=true"));
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  it("a failing run ends result then failed, with the permission denials counted", async () => {
    const rig = makeRig("error");
    try {
      await rig.driver.start(makeSpec({ jobId: "job-err", cwd: rig.cwd }));
      const events = await collect(rig.driver.events("job-err"));
      const result = events.at(-2);
      assert.ok(result?.kind === "result" && result.permissionDenials === 1);
      const last = events.at(-1);
      assert.ok(last?.kind === "state" && last.state === "failed" && /error_max_turns/.test(last.detail ?? ""));
    } finally {
      rig.cleanup();
    }
  });

  it("a crash with no result gets a synthetic result and a failed state with the exit code", async () => {
    const rig = makeRig("crash");
    try {
      await rig.driver.start(makeSpec({ jobId: "job-crash", cwd: rig.cwd }));
      const events = await collect(rig.driver.events("job-crash"));
      assert.deepEqual(events.slice(-2).map((e) => e.kind), ["result", "state"]);
      const last = events.at(-1);
      assert.ok(last?.kind === "state" && last.state === "failed" && /exit 3/.test(last.detail ?? "") && /something broke/.test(last.detail ?? ""));
      assert.equal(existsSync(join(rig.dataDir, "jobs", "job-crash")), false);
      assert.equal(rig.broker.isActive("job-crash"), false);
    } finally {
      rig.cleanup();
    }
  });

  it("cancel kills the whole process tree (no claude, no grandchild left) and ends in cancelled", async () => {
    const rig = makeRig("hang");
    try {
      await rig.driver.start(makeSpec({ jobId: "job-cancel", cwd: rig.cwd }));
      const consumed = collect(rig.driver.events("job-cancel"));
      await waitFor(() => existsSync(rig.pidPath), 8000, "pid file");
      await sleep(100);
      const { pid, childPid } = JSON.parse(readFileSync(rig.pidPath, "utf8")) as { pid: number; childPid: number };
      assert.ok(isAlive(pid) && isAlive(childPid));
      await rig.driver.cancel("job-cancel");
      const events = await consumed;
      assert.equal(terminal(events), "cancelled");
      assert.equal(events.at(-2)?.kind, "result");
      await waitFor(() => !isAlive(pid) && !isAlive(childPid), 5000, "tree to die");
      assert.equal(rig.driver.runningCount, 0);
      assert.equal(existsSync(join(rig.dataDir, "jobs", "job-cancel")), false);
      assert.equal(rig.broker.isActive("job-cancel"), false);
      await rig.driver.cancel("job-cancel"); // a second cancel is a no-op
      await rig.driver.cancel("never-ran");
    } finally {
      rig.cleanup();
    }
  });

  it("the job timeout kills the tree and fails the job", async () => {
    const rig = makeRig("hang", { timeoutMsOverride: 600 });
    try {
      await rig.driver.start(makeSpec({ jobId: "job-timeout", cwd: rig.cwd }));
      const events = await collect(rig.driver.events("job-timeout"));
      const last = events.at(-1);
      assert.ok(last?.kind === "state" && last.state === "failed" && last.detail === "timed out");
      const { pid, childPid } = JSON.parse(readFileSync(rig.pidPath, "utf8")) as { pid: number; childPid: number };
      await waitFor(() => !isAlive(pid) && !isAlive(childPid), 5000, "tree to die");
    } finally {
      rig.cleanup();
    }
  });

  it("resume runs claude --resume <session> with the same flags and a continue prompt", async () => {
    const rig = makeRig("ok");
    try {
      const spec = makeSpec({ jobId: "job-resume", cwd: rig.cwd, template: makeTemplate({ permissionMode: "dontAsk", model: "sonnet" }) });
      await rig.driver.resume({ ...spec, engineSessionId: SESSION_ID });
      const events = await collect(rig.driver.events("job-resume"));
      assert.equal(terminal(events), "succeeded");
      const rec = readRecord(rig.recordPath);
      assert.equal(rec.argv[rec.argv.indexOf("--resume") + 1], SESSION_ID);
      assert.equal(rec.argv[rec.argv.indexOf("--permission-mode") + 1], "dontAsk");
      assert.ok(rec.argv.includes("--disallowedTools") && rec.argv.includes("--permission-prompt-tool"));
      assert.match(rec.stdin, /^Continue the task/);
      assert.equal(rec.stdin.includes("PROMPT TEXT"), false, "the original prompt is not resent");
    } finally {
      rig.cleanup();
    }
  });

  it("refuses without spawning: bypass mode, a shell tool in allowedTools, a settings allow rule for Bash, a non-claude template", async () => {
    const rig = makeRig("ok");
    try {
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "r1", cwd: rig.cwd, template: makeTemplate({ permissionMode: "bypassPermissions" as never }) })), ClaudeArgvError);
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "r2", cwd: rig.cwd, template: makeTemplate({ allowedTools: ["Bash"] }) })), ClaudeArgvError);
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "r3", cwd: rig.cwd, template: makeTemplate({ engine: "dsh" }) })), /not a claude template/);
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "../r4", cwd: rig.cwd })), /job id/);
      mkdirSync(join(rig.cwd, ".claude"), { recursive: true });
      writeFileSync(join(rig.cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }));
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "r5", cwd: rig.cwd })), ClaudePreflightError);
      assert.equal(existsSync(rig.recordPath), false, "claude was never started");
      assert.equal(rig.broker.activeCount, 0, "a refused job leaves no token");
      assert.equal(existsSync(join(rig.dataDir, "jobs")), false, "and no mcp-config");
    } finally {
      rig.cleanup();
    }
  });

  it("refuses a second start of a running job id, and a missing binary leaves nothing behind", async () => {
    const rig = makeRig("hang");
    try {
      await rig.driver.start(makeSpec({ jobId: "dup", cwd: rig.cwd }));
      await assert.rejects(rig.driver.start(makeSpec({ jobId: "dup", cwd: rig.cwd })), /already running/);
      await rig.driver.cancel("dup");
      await collect(rig.driver.events("dup"));
    } finally {
      rig.cleanup();
    }
    const rig2 = makeRig("ok");
    try {
      const d = new ClaudeDriver({ command: join(rig2.dir, "no-such-claude.exe"), dataDir: rig2.dataDir, ipcPort: 1, broker: rig2.broker, denyPaths: [], env: rig2.env });
      await assert.rejects(d.start(makeSpec({ jobId: "nobin", cwd: rig2.cwd })), /claude --version failed|could not start/);
      assert.equal(rig2.broker.activeCount, 0);
    } finally {
      rig2.cleanup();
    }
  });
});
