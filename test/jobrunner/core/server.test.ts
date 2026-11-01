/**
 * S11.1 done-check: the job runner over real loopback sockets (startJobRunner = lock + journal + manager + the S9 IPC server)
 * with FAKE drivers. Refuses a non-loopback bind, unsigned, wrongly signed and replayed messages, an HTTP-shaped request
 * (connection closed, nothing executed, one warn line) and a second instance; round trips submit/cancel/status; the
 * per-job permission channel (I28).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IpcClient, IpcRemoteError } from "../../../src/ipc/client.js";
import { IpcKey } from "../../../src/ipc/hmac.js";
import { encodeLine, signMessage } from "../../../src/ipc/protocol.js";
import type { MessageType } from "../../../src/ipc/protocol.js";
import { createJobAuditLog } from "../../../src/jobrunner/audit.js";
import { JobKeyRegistry } from "../../../src/jobrunner/manager.js";
import type { CoreEngineHost } from "../../../src/jobrunner/manager.js";
import { JobRunnerSecretsError, parseJobRunnerSecrets, startJobRunner } from "../../../src/jobrunner/main.js";
import type { RunningJobRunner } from "../../../src/jobrunner/main.js";
import { startJobRunnerServer } from "../../../src/jobrunner/server.js";
import type { JobDone, JobEvent, JsonObject, PermissionRequest } from "../../../src/jobs/contracts.js";
import { LockHeldError } from "../../../src/runtime/lock.js";
import { KEY_TEXT_A, KEY_TEXT_B, captureLogger, rawConnect, sleep, waitFor } from "../../ipc/helpers.js";
import { FakeDriver, claudeTemplate, makeEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

const agentKey = IpcKey.fromBase64Url(KEY_TEXT_A);
const otherKey = IpcKey.fromBase64Url(KEY_TEXT_B);

interface Rig {
  env: Env;
  runner: RunningJobRunner;
  claude: FakeDriver;
  log: ReturnType<typeof captureLogger>;
  stop(): Promise<void>;
}

async function start(env = makeEnv(), withLogger = true): Promise<Rig> {
  env.writeTemplate(claudeTemplate(env));
  const log = captureLogger();
  const claude = new FakeDriver("claude");
  const runner = await startJobRunner({
    config: { ...env.config, ipcPort: 0 },
    secrets: parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: KEY_TEXT_A })),
    drivers: { claude, dsh: new FakeDriver("dsh") },
    ...(withLogger ? { logger: log.logger } : {}),
  });
  return {
    env,
    runner,
    claude,
    log,
    async stop() {
      await runner.stop();
      env.cleanup();
    },
  };
}

function client(port: number): IpcClient {
  return new IpcClient({ port, key: agentKey, logger: captureLogger().logger, reconnect: { initialDelayMs: 20, maxDelayMs: 80, jitter: false }, requestTimeoutMs: 3000 });
}

const SUBMIT = (jobId: string, extra: Record<string, unknown> = {}): never =>
  ({ jobId, request: { templateId: "list-runs", params: { topic: "cats" }, brief: "go" }, approval: { userId: 42, at: Date.now() }, ...extra }) as never;

/** One signed line over a raw socket; resolves with the first reply line (parsed) and whether the server closed. */
async function rawSend(port: number, type: MessageType, body: JsonObject, key: IpcKey): Promise<{ reply: Record<string, unknown> | undefined; closed: boolean; bytes: number }> {
  const conn = await rawConnect(port);
  conn.write(encodeLine(signMessage(key, type, body)));
  const t0 = Date.now();
  while (Date.now() - t0 < 1500 && !conn.isClosed() && !conn.text().includes("\n")) await sleep(10);
  const text = conn.text();
  const first = text.split("\n")[0];
  const reply = first ? (JSON.parse(first) as { body: Record<string, unknown> }).body : undefined;
  const closed = conn.isClosed();
  conn.socket.destroy();
  return { reply, closed, bytes: text.length };
}

test("a valid round trip: list_templates, submit, pushed events and job_done, status with sinceSeq, duplicate submit, cancel", async () => {
  const rig = await start();
  const c = client(rig.runner.port);
  try {
    const events: JobEvent[] = [];
    const dones: JobDone[] = [];
    c.onJobEvent((e) => events.push(e));
    c.onJobDone((d) => dones.push(d));
    c.start();
    await c.waitOnline({ timeoutMs: 3000 });
    const st = await c.status();
    assert.equal(st.runner.version, "0.1.0");
    assert.equal(st.engines.claude?.enabled, true);
    assert.equal((await c.listTemplates()).templates[0]?.id, "list-runs");

    rig.claude.onStart = (job) => {
      job.text("working");
      job.finish("succeeded", "finished");
    };
    const r = await c.submit(SUBMIT("job-1"));
    assert.deepEqual([r.jobId, r.duplicate], ["job-1", false]);
    await waitFor(() => dones.length === 1);
    assert.equal(dones[0]?.state, "succeeded");
    assert.deepEqual(events.filter((e) => e.jobId === "job-1").map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(events.at(-1)?.kind, "state");
    const after = await c.status({ jobId: "job-1", sinceSeq: 3 });
    assert.deepEqual(after.events?.map((e) => e.seq), [4, 5]);
    assert.equal((await c.submit(SUBMIT("job-1"))).duplicate, true);
    assert.equal(rig.claude.starts.length, 1);
    assert.equal((await c.cancel({ jobId: "job-1" })).state, "succeeded");
    await assert.rejects(c.cancel({ jobId: "nope" }), (e: unknown) => e instanceof IpcRemoteError && e.code === "not_found");
    await assert.rejects(c.status({ jobId: "nope" }), (e: unknown) => e instanceof IpcRemoteError && e.code === "not_found");
  } finally {
    await c.close();
    await rig.stop();
  }
});

test("a submit that carries a raw command, prompt or cwd (anywhere) is refused and nothing runs", async () => {
  const rig = await start();
  const c = client(rig.runner.port);
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 3000 });
    const bad: [string, Record<string, unknown>][] = [
      ["top-level command", { command: "cmd /c dir" }],
      ["top-level cwd", { cwd: "C:\\Pixotope" }],
      ["top-level prompt", { prompt: "do anything" }],
      ["request.command", { request: { templateId: "list-runs", params: { topic: "cats" }, brief: "x", command: "dir" } }],
      ["request.cwd", { request: { templateId: "list-runs", params: { topic: "cats" }, brief: "x", cwd: "C:\\Pixotope" } }],
      ["prompt only", { request: { prompt: "just a prompt" } }],
      ["bad approval", { approval: { userId: "42", at: 1 } }],
      ["bad job id", { jobId: "..\\evil" }],
    ];
    for (const [name, extra] of bad) {
      await assert.rejects(c.submit(SUBMIT("job-x", extra)), (e: unknown) => e instanceof IpcRemoteError && e.code === "bad_request", name);
    }
    // the same through an unknown param: refused by the template, not the wire
    await assert.rejects(c.submit({ ...(SUBMIT("job-y") as object), request: { templateId: "list-runs", params: { topic: "cats", cwd: "C:\\Pixotope" }, brief: "x" } } as never), (e: unknown) => e instanceof IpcRemoteError && e.code === "invalid_params");
    assert.equal(rig.claude.starts.length, 0);
    assert.equal(existsSync(join(rig.env.dataDir, "journal")) ? readdirSync(join(rig.env.dataDir, "journal")).length : 0, 0, "no journal file for a refused job");
  } finally {
    await c.close();
    await rig.stop();
  }
});

test("unsigned, wrongly signed and replayed messages, and an HTTP-shaped request, are dropped: connection closed, no reply bytes, nothing executed", async () => {
  const rig = await start();
  try {
    const port = rig.runner.port;
    const warn = () => rig.log.lines.filter((l) => l.level === "warn" && l.event === "ipc.rejected");
    const body = JSON.parse(JSON.stringify(SUBMIT("sneaky"))) as JsonObject;

    // an HTTP-shaped request, as a browser or a DNS-rebinding page would send
    const http = await rawConnect(port);
    http.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}\r\n`);
    await http.closed;
    assert.equal(http.received.length, 0, "no reply bytes");
    assert.equal(warn().length, 1);
    assert.equal((warn()[0]?.fields as { reason: string }).reason, "http_shaped");

    // unsigned: a bare JSON line
    const bare = await rawConnect(port);
    bare.write(JSON.stringify({ type: "submit", body }) + "\n");
    await bare.closed;
    assert.equal(bare.received.length, 0);
    assert.equal(warn().length, 2);

    // signed with another key
    const wrong = await rawSend(port, "submit", body, otherKey);
    assert.equal(wrong.closed, true);
    assert.equal(wrong.bytes, 0);
    assert.equal(warn().length, 3);

    // a replayed line: the first is answered, the same bytes again are not
    const line = encodeLine(signMessage(agentKey, "status", {}));
    const first = await rawConnect(port);
    first.write(line);
    await waitFor(() => first.text().includes("\n"));
    first.socket.destroy();
    const again = await rawConnect(port);
    again.write(line);
    await again.closed;
    assert.equal(again.received.length, 0);
    assert.equal(warn().at(-1) && (warn().at(-1)?.fields as { reason: string }).reason, "replay");

    assert.equal(rig.claude.starts.length, 0, "nothing was executed");
    assert.equal(rig.runner.manager.status({}).jobs.length, 0);
    const logText = rig.log.text();
    assert.ok(!logText.includes(KEY_TEXT_A) && !logText.includes("sneaky"), "no key and no content in the log");
  } finally {
    await rig.stop();
  }
});

test("the server refuses a non-loopback bind", async () => {
  const env = makeEnv();
  try {
    const log = captureLogger();
    const rig = await start(env);
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "localhost"]) {
      await assert.rejects(startJobRunnerServer({ port: 0, host, key: agentKey, manager: rig.runner.manager, jobKeys: new JobKeyRegistry(), logger: log.logger }), /must be 127\.0\.0\.1/, host);
    }
    await rig.runner.stop();
  } finally {
    env.cleanup();
  }
});

test("a second instance is refused while the first holds the lock; a dead holder is taken over", async () => {
  const env = makeEnv();
  env.writeTemplate(claudeTemplate(env));
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const lockPath = join(env.dataDir, "run", "jobrunner.lock");
    mkdirSync(join(env.dataDir, "run"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }));
    const opts = { config: { ...env.config, ipcPort: 0 }, secrets: parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: KEY_TEXT_A })), drivers: {}, logger: captureLogger().logger };
    await assert.rejects(startJobRunner(opts), (e: unknown) => e instanceof LockHeldError && e.pid === holder.pid);
    holder.kill();
    await new Promise((r) => holder.once("exit", r));
    const runner = await startJobRunner(opts);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    await runner.stop();
    assert.equal(existsSync(lockPath), false, "a clean stop releases the lock");
  } finally {
    holder.kill();
    env.cleanup();
  }
});

test("per-job permission channel (I28): the job's token works for its own job while it runs; every other token is refused", async () => {
  const rig = await start();
  const c = client(rig.runner.port);
  try {
    const asked: PermissionRequest[] = [];
    c.onPermissionRequest((r) => {
      asked.push(r);
      void c.answerPermission({ requestId: r.requestId, jobId: r.jobId, answer: "allow_once", by: "user", userId: 42, at: Date.now() });
    });
    const dones: JobDone[] = [];
    c.onJobDone((d) => dones.push(d));
    c.start();
    await c.waitOnline({ timeoutMs: 3000 });
    await c.submit(SUBMIT("job-a"));
    const hostA = rig.claude.job("job-a").host as CoreEngineHost;
    assert.equal(hostA.channel?.port, rig.runner.port);
    const keyA = IpcKey.fromBase64Url(hostA.channel!.token);
    const req = (jobId: string, requestId: string): JsonObject => ({ requestId, jobId, tool: "Edit", input: { file_path: "notes.md" } });

    // the right token, for its own job: one permission_request goes to the agent, the answer comes back to the helper
    const ok = await rawSend(rig.runner.port, "permission_request", req("job-a", "r1"), keyA);
    assert.equal(ok.closed, false);
    assert.deepEqual(ok.reply, { replyTo: (ok.reply as { replyTo: string }).replyTo, ok: true, data: { decision: "allow_once" } });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.jobId, "job-a");

    // a wrong token, another job's token (job-b is queued behind job-a: it has no key at all), and the agent's own key
    const wrong = await rawSend(rig.runner.port, "permission_request", req("job-a", "r2"), otherKey);
    assert.deepEqual([wrong.closed, wrong.bytes], [true, 0]);
    const noKeyForB = await rawSend(rig.runner.port, "permission_request", req("job-b", "r3"), keyA);
    assert.deepEqual([noKeyForB.closed, noKeyForB.bytes], [true, 0], "job-a's token cannot speak for job-b");
    const withAgentKey = await rawSend(rig.runner.port, "permission_request", req("job-a", "r4"), agentKey);
    assert.equal(withAgentKey.closed, false);
    assert.equal((withAgentKey.reply as { ok: boolean; error: { code: string } }).error.code, "forbidden", "the agent may not send permission_request");
    // a job token may only send permission_request
    const status = await rawSend(rig.runner.port, "status", {}, keyA);
    assert.deepEqual([status.closed, status.bytes], [true, 0]);
    assert.equal(asked.length, 1, "none of the refused requests reached the user");

    // after the job ended the token is dead
    rig.claude.job("job-a").finish();
    await waitFor(() => dones.length === 1);
    const late = await rawSend(rig.runner.port, "permission_request", req("job-a", "r5"), keyA);
    assert.deepEqual([late.closed, late.bytes], [true, 0]);
    assert.equal(rig.runner.manager.status({}).jobs.length, 1);
    assert.ok(!rig.log.text().includes(hostA.channel!.token), "the token is never logged");
  } finally {
    await c.close();
    await rig.stop();
  }
});

test("the job runner logs JSONL in its own data folder, writes its audit there, and never logs the key", async () => {
  const env = makeEnv();
  env.writeTemplate(claudeTemplate(env));
  const claude = new FakeDriver("claude");
  claude.onStart = (job) => job.finish();
  const runner = await startJobRunner({ config: { ...env.config, ipcPort: 0 }, secrets: parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: KEY_TEXT_A, deepseekApiKey: "DS-SECRET-KEY-123" })), drivers: { claude } });
  const c = client(runner.port);
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 3000 });
    await c.submit(SUBMIT("job-1"));
    await runner.manager.idle();
    const logs = readdirSync(join(env.dataDir, "logs"));
    assert.ok(logs.some((f) => /^agent-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)));
    const text = logs.map((f) => readFileSync(join(env.dataDir, "logs", f), "utf8")).join("");
    assert.match(text, /jobrunner\.started/);
    assert.match(text, /jobrunner\.templates_loaded/);
    assert.ok(!text.includes(KEY_TEXT_A) && !text.includes("DS-SECRET-KEY-123"));
    const audit = readdirSync(join(env.dataDir, "audit"));
    assert.ok(audit.some((f) => /^jobs-\d{6}\.jsonl$/.test(f)));
    assert.ok(readFileSync(join(env.dataDir, "audit", audit[0]!), "utf8").includes('"event":"submitted"'));
    assert.ok(existsSync(join(env.dataDir, "journal", "job-1.jsonl")));
    void createJobAuditLog;
  } finally {
    await c.close();
    await runner.stop();
    env.cleanup();
  }
});

test("the secrets file is validated and an error never echoes its content", () => {
  assert.throws(() => parseJobRunnerSecrets("not json"), JobRunnerSecretsError);
  assert.throws(() => parseJobRunnerSecrets("[]"), JobRunnerSecretsError);
  assert.throws(() => parseJobRunnerSecrets(JSON.stringify({})), /ipcHmacKey is missing/);
  try {
    parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: "short-but-secret" }));
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!String((e as Error).message).includes("short-but-secret"));
  }
  assert.throws(() => parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: KEY_TEXT_A, deepseekApiKey: 5 })), JobRunnerSecretsError);
  const s = parseJobRunnerSecrets(JSON.stringify({ ipcHmacKey: KEY_TEXT_A, deepseekApiKey: "ds-key" }));
  assert.equal(String(s.ipcKey), "[IpcKey]");
  assert.deepEqual(s.redactValues, [KEY_TEXT_A, "ds-key"]);
});
