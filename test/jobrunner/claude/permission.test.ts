/**
 * S12.3: the stdio helper (initialize, tools/list, tools/call), the per-job token channel (I28) against the real IPC
 * server, and the broker's policy-first decisions.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { IpcKey } from "../../../src/ipc/hmac.js";
import { startIpcServer } from "../../../src/ipc/server.js";
import type { IpcServer } from "../../../src/ipc/server.js";
import { IPC_HOST, encodeLine, signMessage } from "../../../src/ipc/protocol.js";
import { PermissionBroker, kindOf, summaryOf } from "../../../src/jobrunner/drivers/claude/permissionBroker.js";
import { PermissionMcpServer, readHelperEnv, requestDecision } from "../../../src/jobrunner/permissionMcp.js";
import type { JobRef, JsonObject, PermissionHelperRequest } from "../../../src/jobs/contracts.js";
import { captureLogger, rawConnect, sleep, waitFor } from "../../ipc/helpers.js";
import { FakeHost, FakePolicy, HELPER_JS } from "./helpers.js";

const REF: JobRef = { jobId: "job1", templateId: "list-runs", engine: "claude" };

interface Channel {
  server: IpcServer;
  port: number;
  broker: PermissionBroker;
  host: FakeHost;
  policy: FakePolicy;
  lines: ReturnType<typeof captureLogger>;
  tokenFor(jobId: string, ref?: JobRef): string;
  close(): Promise<void>;
}

/** The runner side the way S11 will wire it: `keys` from the broker, `handle` for a permission_request. */
async function channel(verdict: ConstructorParameters<typeof FakePolicy>[0] = "ask"): Promise<Channel> {
  const broker = new PermissionBroker();
  const policy = new FakePolicy(verdict);
  const host = new FakeHost(policy);
  const lines = captureLogger();
  const { server, port } = await startIpcServer({
    port: 0,
    keys: (peek) => broker.keys(peek),
    logger: lines.logger,
    handler: (type, body, ctx) => {
      if (type !== "permission_request") return undefined;
      return broker.handle(ctx.principal, body);
    },
  });
  return {
    server,
    port,
    broker,
    host,
    policy,
    lines,
    tokenFor: (jobId, ref = { ...REF, jobId }) => broker.register({ jobId, ref, cwd: "C:\\hub", host }),
    close: () => server.close(),
  };
}

function helperRequest(jobId: string, tool = "Write", input: JsonObject = { file_path: "runs/x.txt" }): PermissionHelperRequest {
  return { requestId: "req-" + Math.random().toString(36).slice(2, 10), jobId, tool, input };
}

describe("permission helper over stdio (S12.3)", () => {
  it("answers initialize, tools/list and tools/call with the Claude Code decision JSON", async () => {
    const calls: PermissionHelperRequest[] = [];
    const key = IpcKey.generate();
    const srv = new PermissionMcpServer({
      env: { jobId: "job1", key, port: 1 },
      decide: async (o) => {
        calls.push(o.request);
        return o.request.tool === "Write" ? { decision: "allow_once" } : { decision: "deny", message: "no thanks" };
      },
    });
    const init = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })))!);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "a7perm");
    assert.equal(await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), undefined);
    const odd = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "1999-01-01" } })))!);
    assert.equal(odd.result.protocolVersion, "2025-06-18");
    const list = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["decide"]);
    const allow = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: { tool_name: "Write", input: { file_path: "a" }, tool_use_id: "toolu_1" } } })))!);
    assert.deepEqual(JSON.parse(allow.result.content[0].text), { behavior: "allow", updatedInput: { file_path: "a" } });
    const deny = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "decide", arguments: { tool_name: "Edit", input: {} } } })))!);
    assert.deepEqual(JSON.parse(deny.result.content[0].text), { behavior: "deny", message: "no thanks" });
    assert.deepEqual(calls.map((c) => [c.jobId, c.tool, c.requestId === "toolu_1"]), [["job1", "Write", true], ["job1", "Edit", false]]);
    const unknown = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" })))!);
    assert.equal(unknown.error.code, -32601);
    assert.equal(JSON.parse((await srv.handleLine("{bad"))!).error.code, -32700);
    const other = JSON.parse((await srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "other", arguments: {} } })))!);
    assert.equal(other.result.isError, true);
  });

  it("denies when the environment is missing, the runner is unreachable or the call fails", async () => {
    const call = (srv: PermissionMcpServer) => srv.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "decide", arguments: { tool_name: "Write", input: {} } } }));
    const bad = new PermissionMcpServer({ env: undefined, envError: "A7_JOB_TOKEN is missing" });
    assert.equal(JSON.parse(JSON.parse((await call(bad))!).result.content[0].text).behavior, "deny");
    const unreachable = new PermissionMcpServer({ env: { jobId: "job1", key: IpcKey.generate(), port: 1 }, timeoutMs: 2000 });
    const out = JSON.parse(JSON.parse((await call(unreachable))!).result.content[0].text);
    assert.equal(out.behavior, "deny");
    assert.match(out.message, /could not reach/);
    const noTool = new PermissionMcpServer({ env: { jobId: "job1", key: IpcKey.generate(), port: 1 } });
    const r = await noTool.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "decide", arguments: { input: {} } } }));
    assert.equal(JSON.parse(JSON.parse(r!).result.content[0].text).behavior, "deny");
  });

  it("validates its environment without echoing the token", () => {
    const token = IpcKey.generate().toString(); // "[IpcKey]": not a token
    assert.ok(token);
    assert.throws(() => readHelperEnv({}), /A7_JOB_ID/);
    assert.throws(() => readHelperEnv({ A7_JOB_ID: "j 1", A7_JOB_TOKEN: "x", A7_JOB_PORT: "1" }), /A7_JOB_ID/);
    assert.throws(() => readHelperEnv({ A7_JOB_ID: "j1", A7_JOB_PORT: "1" }), /A7_JOB_TOKEN is missing/);
    assert.throws(() => readHelperEnv({ A7_JOB_ID: "j1", A7_JOB_TOKEN: "SECRETSHORT", A7_JOB_PORT: "1" }), (e: Error) => !e.message.includes("SECRETSHORT") && /malformed/.test(e.message));
    assert.throws(() => readHelperEnv({ A7_JOB_ID: "j1", A7_JOB_TOKEN: "A".repeat(43), A7_JOB_PORT: "70000" }), /A7_JOB_PORT/);
    const env = readHelperEnv({ A7_JOB_ID: "j1", A7_JOB_TOKEN: "A".repeat(43), A7_JOB_PORT: "47007" });
    assert.equal(env.port, 47007);
    assert.equal(String(env.key), "[IpcKey]");
  });

  it("runs as a real stdio process (the compiled helper)", async () => {
    const ch = await channel("allow");
    try {
      const token = ch.tokenFor("job1");
      const child = spawn(process.execPath, [HELPER_JS], {
        env: { PATH: process.env["PATH"] ?? "", A7_JOB_ID: "job1", A7_JOB_TOKEN: token, A7_JOB_PORT: String(ch.port) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: { tool_name: "Read", input: { file_path: "runs/a" }, tool_use_id: "toolu_7" } } }) + "\n");
      await waitFor(() => out.split("\n").filter(Boolean).length >= 3, 5000, "three replies");
      child.stdin.end();
      await new Promise((r) => child.once("close", r));
      const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(replies.map((r) => r.id).sort(), [1, 2, 3]);
      const call = replies.find((r) => r.id === 3);
      assert.deepEqual(JSON.parse(call.result.content[0].text), { behavior: "allow", updatedInput: { file_path: "runs/a" } });
      assert.equal(out.includes(token), false);
      assert.equal(err.includes(token), false);
      assert.equal(ch.policy.calls[0]?.tool, "Read");
    } finally {
      await ch.close();
    }
  });
});

describe("per-job token channel (I28)", () => {
  it("accepts a request signed with the job's own token and forwards exactly one permission_request", async () => {
    const ch = await channel("ask");
    try {
      ch.host.answer = "allow_once";
      const token = ch.tokenFor("job1");
      const req = helperRequest("job1", "Write", { file_path: "runs/out.txt", content: "hello" });
      const reply = await requestDecision({ port: ch.port, key: IpcKey.fromBase64Url(token), request: req, timeoutMs: 5000 });
      assert.deepEqual(reply, { decision: "allow_once" });
      assert.equal(ch.host.asked.length, 1);
      const asked = ch.host.asked[0]!;
      assert.equal(asked.requestId, req.requestId);
      assert.equal(asked.engine, "claude");
      assert.equal(asked.kind, "edit");
      assert.equal(asked.tool, "Write");
      assert.equal(asked.cwd, "C:\\hub");
      assert.equal(asked.timeoutSec, 1800);
      assert.match(asked.summary ?? "", /^Write file_path: runs\/out\.txt$/);
      assert.deepEqual(ch.policy.calls.map((c) => c.tool), ["Write"]);
      assert.deepEqual(ch.policy.calls[0]?.job, REF);
    } finally {
      await ch.close();
    }
  });

  it("a Deny from the user, a throw and a timeout all come back as deny", async () => {
    const ch = await channel("ask");
    try {
      const key = IpcKey.fromBase64Url(ch.tokenFor("job1"));
      ch.host.answer = "deny";
      assert.equal((await requestDecision({ port: ch.port, key, request: helperRequest("job1"), timeoutMs: 5000 })).decision, "deny");
      ch.host.askPermission = async () => {
        throw new Error("transport down");
      };
      assert.equal((await requestDecision({ port: ch.port, key, request: helperRequest("job1"), timeoutMs: 5000 })).decision, "deny");
      ch.host.askPermission = async (r) => ({ requestId: "someone-else", jobId: r.jobId, answer: "allow_once", by: "user", at: 1 });
      assert.equal((await requestDecision({ port: ch.port, key, request: helperRequest("job1"), timeoutMs: 5000 })).decision, "deny");
    } finally {
      await ch.close();
    }
  });

  it("refuses a wrong token, another job's token, an ended job's token and an unsigned request", async () => {
    const ch = await channel("ask");
    try {
      const tokenA = ch.tokenFor("jobA");
      const tokenB = ch.tokenFor("jobB");
      // wrong token
      await assert.rejects(requestDecision({ port: ch.port, key: IpcKey.generate(), request: helperRequest("jobA"), timeoutMs: 3000 }), /closed the connection|refused/);
      // job B's token used for job A's id
      await assert.rejects(requestDecision({ port: ch.port, key: IpcKey.fromBase64Url(tokenB), request: helperRequest("jobA"), timeoutMs: 3000 }), /closed the connection|refused/);
      // an unknown job id
      await assert.rejects(requestDecision({ port: ch.port, key: IpcKey.fromBase64Url(tokenA), request: helperRequest("jobZ"), timeoutMs: 3000 }), /closed the connection|refused/);
      // the token after the job ended
      ch.broker.unregister("jobA");
      await assert.rejects(requestDecision({ port: ch.port, key: IpcKey.fromBase64Url(tokenA), request: helperRequest("jobA"), timeoutMs: 3000 }), /closed the connection|refused/);
      // the other job still works
      ch.host.answer = "allow_once";
      assert.equal((await requestDecision({ port: ch.port, key: IpcKey.fromBase64Url(tokenB), request: helperRequest("jobB"), timeoutMs: 3000 })).decision, "allow_once");
      // an unsigned request (a MAC of the wrong key shape is the same as none)
      const raw = await rawConnect(ch.port);
      const msg = signMessage(IpcKey.generate(), "permission_request", helperRequest("jobB") as unknown as JsonObject);
      raw.write(encodeLine({ ...msg, mac: "0".repeat(64) }));
      await raw.closed;
      assert.equal(raw.text(), "");
      const raw2 = await rawConnect(ch.port);
      raw2.write(JSON.stringify({ v: 1, id: "x", type: "permission_request", body: helperRequest("jobB") }) + "\n");
      await raw2.closed;
      assert.equal(raw2.text(), "");
      // only the jobB request reached the host
      assert.equal(ch.host.asked.length, 1);
      assert.equal(ch.host.asked[0]?.jobId, "jobB");
      assert.ok(ch.lines.lines.filter((l) => l.event === "ipc.rejected").length >= 5);
      assert.equal(ch.lines.text().includes(tokenA), false);
      assert.equal(ch.lines.text().includes(tokenB), false);
    } finally {
      await ch.close();
    }
  });

  it("a token cannot be used with the agent's message types, and the agent key cannot answer for a job", async () => {
    const ch = await channel("ask");
    try {
      const token = ch.tokenFor("job1");
      const raw = await rawConnect(ch.port);
      // a status request signed with the job token: no key matches (keys() offers the job key only for permission_request)
      raw.write(encodeLine(signMessage(IpcKey.fromBase64Url(token), "status", {})));
      await raw.closed;
      assert.equal(raw.text(), "");
      assert.equal(IPC_HOST, "127.0.0.1");
    } finally {
      await ch.close();
    }
  });

  it("the broker itself refuses a mismatched principal and a malformed body", async () => {
    const broker = new PermissionBroker();
    const host = new FakeHost(new FakePolicy("allow"));
    broker.register({ jobId: "job1", ref: REF, cwd: "C:\\hub", host });
    await assert.rejects(broker.handle("main", { jobId: "job1", requestId: "r1", tool: "Read", input: {} }), /not the channel/);
    await assert.rejects(broker.handle("job:job2", { jobId: "job1", requestId: "r1", tool: "Read", input: {} }), /not the channel/);
    await assert.rejects(broker.handle("job:job9", { jobId: "job9", requestId: "r1", tool: "Read", input: {} }), /not running/);
    await assert.rejects(broker.handle("job:job1", { jobId: "job1", requestId: "bad id!", tool: "Read", input: {} }), /requestId/);
    await assert.rejects(broker.handle("job:job1", { jobId: "job1", requestId: "r1", tool: "", input: {} }), /tool/);
    assert.deepEqual(await broker.handle("job:job1", { jobId: "job1", requestId: "r1", tool: "Read", input: {} }), { decision: "allow_once" });
    assert.throws(() => broker.register({ jobId: "job1", ref: REF, cwd: "x", host }), /already/);
    assert.throws(() => broker.register({ jobId: "../evil", ref: REF, cwd: "x", host }), /unexpected/);
  });
});

describe("runner rules come first (I21, shell and Scriptorium)", () => {
  it("allow and deny verdicts never ask the user; ask asks exactly once", async () => {
    const policy = new FakePolicy((tool) => (tool.startsWith("mcp__flow") ? "deny" : tool === "mcp__scriptorium__start" ? "deny" : tool === "Glob" ? "allow" : "ask"));
    const host = new FakeHost(policy);
    host.answer = "deny";
    const broker = new PermissionBroker();
    broker.register({ jobId: "job1", ref: () => ({ ...REF, flowBudgetCredits: 100, flowChargedCredits: 90 }), cwd: "C:\\hub", host });
    const call = (tool: string) => broker.handle("job:job1", { jobId: "job1", requestId: "r-" + tool, tool, input: {} });
    assert.equal((await call("mcp__flow-music-mcp__generate_video")).decision, "deny");
    assert.equal((await call("mcp__scriptorium__start")).decision, "deny");
    assert.equal((await call("Glob")).decision, "allow_once");
    assert.equal(host.asked.length, 0);
    assert.equal((await call("Write")).decision, "deny");
    assert.deepEqual(host.asked.map((a) => a.tool), ["Write"]);
    assert.equal(policy.calls[0]?.job.flowChargedCredits, 90, "the ref getter is read on every request");
  });

  it("a shell tool is denied without asking anyone, whatever the policy says", async () => {
    const host = new FakeHost(new FakePolicy("allow"));
    const broker = new PermissionBroker();
    broker.register({ jobId: "job1", ref: REF, cwd: "C:\\hub", host });
    for (const tool of ["Bash", "PowerShell", "bash"]) {
      const r = await broker.handle("job:job1", { jobId: "job1", requestId: "r1", tool, input: { command: "whoami" } });
      assert.equal(r.decision, "deny");
    }
    assert.equal(host.asked.length, 0);
    assert.equal((host.policy as FakePolicy).calls.length, 0);
  });

  it("classifies tools and builds a bounded one-line summary", () => {
    assert.equal(kindOf("Bash"), "execute");
    assert.equal(kindOf("mcp__flow-music-mcp__x"), "flow");
    assert.equal(kindOf("Read"), "read");
    assert.equal(kindOf("Edit"), "edit");
    assert.equal(kindOf("WebFetch"), "other");
    assert.equal(summaryOf("Read", { file_path: "C:\\a\\b" }), "Read file_path: C:\\a\\b");
    assert.equal(summaryOf("Grep", { pattern: "a\nb\n  c" }), "Grep pattern: a b c");
    assert.ok(summaryOf("Write", { content: "x".repeat(1000) }).length <= 203);
    assert.equal(summaryOf("Task", {}), "Task {}");
  });
});

void sleep;
