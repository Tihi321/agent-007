/**
 * S9.3 done-check: the IPC over real loopback sockets (IpcServer + IpcClient). Covers a valid round trip; wrong MAC,
 * stale ts, replayed nonce and an oversize line rejected; an HTTP-shaped request rejected with the connection closed and
 * no reply body; no key in logs; the loopback-only rules; reconnect; the per-job key (I28).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobEvent, JsonObject, PermissionDecision, StatusReply } from "../../src/jobs/contracts.js";
import { IpcClient, IpcAbortError, IpcOfflineError, IpcRemoteError, IpcTimeoutError } from "../../src/ipc/client.js";
import { IpcKey } from "../../src/ipc/hmac.js";
import { MAX_LINE_BYTES, encodeLine, signMessage } from "../../src/ipc/protocol.js";
import type { MessageType } from "../../src/ipc/protocol.js";
import { IpcHandlerError, IpcServer, startIpcServer } from "../../src/ipc/server.js";
import type { IpcRequestContext } from "../../src/ipc/server.js";
import { createRedactor } from "../../src/logging/redact.js";
import { secretValues } from "../../src/config/secrets.js";
import { KEY_TEXT_A, KEY_TEXT_B, captureLogger, rawConnect, sleep, waitFor } from "./helpers.js";

const key = IpcKey.fromBase64Url(KEY_TEXT_A);
const jobKey = IpcKey.fromBase64Url(KEY_TEXT_B);

const STATUS: StatusReply = {
  runner: { version: "test", startedAt: 1, now: 2 },
  engines: {},
  jobs: [],
  daily: { jobs: 0, jobCap: 10, credits: 0, creditCap: 100 },
};

interface Call {
  type: MessageType;
  body: JsonObject;
  principal: string;
}

async function startServer(opts: { onRequest?: (type: MessageType, body: JsonObject, ctx: IpcRequestContext) => unknown; authTimeoutMs?: number; maxConnections?: number; port?: number } = {}) {
  const log = captureLogger();
  const calls: Call[] = [];
  const { server, port } = await startIpcServer({
    port: opts.port ?? 0,
    keys: (peek) => {
      const jobId = typeof peek.body["jobId"] === "string" ? peek.body["jobId"] : undefined;
      return [{ key, principal: "main" }, ...(peek.type === "permission_request" && jobId === "job-1" ? [{ key: jobKey, principal: "job:job-1" }] : [])];
    },
    handler: async (type, body, ctx) => {
      calls.push({ type, body, principal: ctx.principal });
      if (opts.onRequest) return opts.onRequest(type, body, ctx) as never;
      if (type === "status") return STATUS as never;
      if (type === "submit") return { jobId: String(body["jobId"]), state: "queued", duplicate: false } as never;
      return undefined;
    },
    logger: log.logger,
    ...(opts.authTimeoutMs !== undefined ? { authTimeoutMs: opts.authTimeoutMs } : {}),
    ...(opts.maxConnections !== undefined ? { maxConnections: opts.maxConnections } : {}),
  });
  return { server, port, calls, log };
}

function client(port: number, over: Partial<ConstructorParameters<typeof IpcClient>[0]> = {}): IpcClient {
  const log = captureLogger();
  return new IpcClient({ port, key, logger: log.logger, reconnect: { initialDelayMs: 20, maxDelayMs: 80, jitter: false }, requestTimeoutMs: 2000, ...over });
}

const SUBMIT = { jobId: "job-1", request: { templateId: "tts-line", params: { text: "hi" }, brief: "say hi" }, approval: { userId: 42, at: 1 } };

test("a valid round trip: the client handshakes, submit is answered, the handler saw the agent principal", async () => {
  const { server, port, calls } = await startServer();
  const c = client(port);
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 2000 });
    assert.equal(c.state, "online");
    const reply = await c.submit(SUBMIT);
    assert.deepEqual(reply, { jobId: "job-1", state: "queued", duplicate: false });
    const submit = calls.find((x) => x.type === "submit");
    assert.equal(submit?.principal, "main");
    assert.deepEqual(submit?.body, SUBMIT);
    assert.equal(calls[0]?.type, "status", "the handshake is a signed status request");
    assert.deepEqual(await c.status(), STATUS);
  } finally {
    await c.close();
    await server.close();
  }
});

test("pushes: job_event, permission_request and job_done reach the client; permission_decision reaches the handler", async () => {
  const { server, port, calls } = await startServer();
  const c = client(port);
  try {
    const events: JobEvent[] = [];
    const perms: string[] = [];
    const done: string[] = [];
    c.onJobEvent((e) => events.push(e));
    c.onPermissionRequest((r) => perms.push(r.requestId));
    c.onJobDone((d) => done.push(d.jobId));
    c.start();
    await c.waitOnline({ timeoutMs: 2000 });
    assert.equal(server.broadcast("job_event", { jobId: "j", seq: 1, ts: 1, kind: "text", text: "hello" }), 1);
    assert.equal(server.broadcast("permission_request", { requestId: "r1", jobId: "j", tool: "Read", input: {}, engine: "claude", cwd: "x", kind: "read", requestedAt: 1, timeoutSec: 60 }), 1);
    assert.equal(server.broadcast("job_done", { jobId: "j", state: "succeeded", summary: "ok", artifacts: [], durationMs: 5 }), 1);
    await waitFor(() => events.length === 1 && perms.length === 1 && done.length === 1, 2000, "pushes");
    assert.equal(events[0]?.kind, "text");
    assert.deepEqual(perms, ["r1"]);
    assert.deepEqual(done, ["j"]);

    const decision: PermissionDecision = { requestId: "r1", jobId: "j", answer: "deny", by: "user", userId: 42, at: 5 };
    await c.answerPermission(decision);
    await waitFor(() => calls.some((x) => x.type === "permission_decision"), 2000, "decision");
    assert.deepEqual(calls.find((x) => x.type === "permission_decision")?.body, decision);
  } finally {
    await c.close();
    await server.close();
  }
});

test("a handler error becomes an ok:false reply and an IpcRemoteError; an unexpected throw is a generic internal error", async () => {
  const { server, port } = await startServer({
    onRequest: (type) => {
      if (type === "status") return STATUS;
      if (type === "cancel") throw new IpcHandlerError("not_found", "no such job");
      throw new Error("secret detail that must not leak");
    },
  });
  const c = client(port);
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 2000 });
    await assert.rejects(c.cancel({ jobId: "nope" }), (e: unknown) => e instanceof IpcRemoteError && e.code === "not_found" && e.message === "no such job");
    await assert.rejects(c.hubStatus(), (e: unknown) => e instanceof IpcRemoteError && e.code === "internal" && !/secret detail/.test(e.message));
  } finally {
    await c.close();
    await server.close();
  }
});

// ---- hostile input, with a raw socket --------------------------------------------------------------

function expectRejected(log: ReturnType<typeof captureLogger>, reason: string): void {
  const warns = log.lines.filter((l) => l.level === "warn" && l.event === "ipc.rejected");
  assert.equal(warns.length, 1, `exactly one warn line: ${log.text()}`);
  assert.equal((warns[0]?.fields as { reason: string }).reason, reason);
}

test("a wrong MAC is rejected: connection closed, no reply body, nothing executed, one warn", async () => {
  const { server, port, calls, log } = await startServer();
  try {
    const raw = await rawConnect(port);
    const msg = signMessage(key, "submit", SUBMIT as unknown as JsonObject);
    raw.write(encodeLine({ ...msg, mac: "a".repeat(64) }));
    await raw.closed;
    assert.equal(raw.text(), "");
    assert.equal(calls.length, 0);
    expectRejected(log, "bad_mac");
  } finally {
    await server.close();
  }
});

test("a message signed with another key is rejected the same way", async () => {
  const { server, port, calls, log } = await startServer();
  try {
    const raw = await rawConnect(port);
    raw.write(encodeLine(signMessage(jobKey, "status", {})));
    await raw.closed;
    assert.equal(raw.text(), "");
    assert.equal(calls.length, 0);
    expectRejected(log, "bad_mac");
  } finally {
    await server.close();
  }
});

test("a stale ts is rejected (61 s in the past and in the future)", async () => {
  for (const delta of [-61_000, 61_000]) {
    const { server, port, calls, log } = await startServer();
    try {
      const raw = await rawConnect(port);
      raw.write(encodeLine(signMessage(key, "status", {}, { now: () => Date.now() + delta })));
      await raw.closed;
      assert.equal(raw.text(), "");
      assert.equal(calls.length, 0);
      expectRejected(log, "stale");
    } finally {
      await server.close();
    }
  }
});

test("a replayed nonce is rejected: the first copy is handled once, the second closes the connection", async () => {
  const { server, port, calls, log } = await startServer();
  try {
    const raw = await rawConnect(port);
    const line = encodeLine(signMessage(key, "status", {}));
    raw.write(line);
    await waitFor(() => raw.text().includes("\n"), 2000, "first reply");
    assert.equal(calls.length, 1);
    raw.write(line);
    await raw.closed;
    assert.equal(calls.length, 1, "the replay executed nothing");
    expectRejected(log, "replay");
    // a replay on a NEW connection is refused too (the cache is per server)
    const raw2 = await rawConnect(port);
    raw2.write(line);
    await raw2.closed;
    assert.equal(calls.length, 1);
    assert.equal(log.lines.filter((l) => l.event === "ipc.rejected").length, 2);
  } finally {
    await server.close();
  }
});

test("an oversize line (over 1 MiB) is rejected and the connection closed", async () => {
  const { server, port, calls, log } = await startServer();
  try {
    const raw = await rawConnect(port);
    raw.write(Buffer.alloc(MAX_LINE_BYTES + 10, 0x61));
    await raw.closed;
    assert.equal(raw.text(), "");
    assert.equal(calls.length, 0);
    expectRejected(log, "oversize");
  } finally {
    await server.close();
  }
});

test("an oversize but otherwise valid message is refused by the sender before it is sent", () => {
  assert.throws(() => encodeLine(signMessage(key, "submit", { text: "x".repeat(MAX_LINE_BYTES) })), /larger than/);
});

test("an HTTP-shaped request (a browser or DNS-rebinding page) is rejected: connection closed, no reply body, one warn, nothing executed", async () => {
  const { server, port, calls, log } = await startServer();
  try {
    const raw = await rawConnect(port);
    const body = JSON.stringify({ jobId: "x", request: { templateId: "tts-line", params: {}, brief: "" } });
    raw.write(
      `POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    await raw.closed;
    assert.equal(raw.text(), "", "no reply body, not even an HTTP status line");
    assert.equal(calls.length, 0);
    expectRejected(log, "http_shaped");
    // a GET (a simple browser navigation) too
    const log2 = captureLogger();
    assert.equal(log2.lines.length, 0);
    const raw2 = await rawConnect(port);
    raw2.write("GET /status HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await raw2.closed;
    assert.equal(raw2.text(), "");
    assert.equal(calls.length, 0);
    assert.equal(log.lines.filter((l) => l.event === "ipc.rejected").length, 2);
  } finally {
    await server.close();
  }
});

test("garbage, an unknown type and a direction violation are all rejected", async () => {
  const cases: [string, string | Buffer, string][] = [
    ["not json", "hello there\n", "malformed"],
    ["extra field", JSON.stringify({ ...signMessage(key, "status", {}), admin: true }) + "\n", "malformed"],
    ["unknown type", JSON.stringify({ ...signMessage(key, "status", {}), type: "rm_rf" }) + "\n", "bad_type"],
    ["runner-to-agent type sent to the runner", encodeLine(signMessage(key, "job_event", {})), "bad_type"],
  ];
  for (const [label, data, reason] of cases) {
    const { server, port, calls, log } = await startServer();
    try {
      const raw = await rawConnect(port);
      raw.write(data);
      await raw.closed;
      assert.equal(raw.text(), "", label);
      assert.equal(calls.length, 0, label);
      expectRejected(log, reason);
    } finally {
      await server.close();
    }
  }
});

test("a connection that never authenticates is closed after the auth timeout", async () => {
  const { server, port, log } = await startServer({ authTimeoutMs: 80 });
  try {
    const raw = await rawConnect(port);
    await raw.closed;
    expectRejected(log, "auth_timeout");
  } finally {
    await server.close();
  }
});

test("connections beyond the maximum are refused", async () => {
  const { server, port, log } = await startServer({ maxConnections: 1, authTimeoutMs: 5000 });
  try {
    const a = await rawConnect(port);
    const b = await rawConnect(port);
    await b.closed;
    assert.equal(a.isClosed(), false);
    assert.ok(log.lines.some((l) => (l.fields as { reason?: string } | undefined)?.reason === "too_many_connections"));
    a.socket.destroy();
  } finally {
    await server.close();
  }
});

// ---- loopback only ------------------------------------------------------------------------------------

test("the server refuses a non-loopback bind and the client a non-loopback host", () => {
  for (const host of ["0.0.0.0", "::", "localhost", "192.168.0.10"]) {
    assert.throws(() => new IpcServer({ port: 0, host, keys: () => [], handler: () => undefined }), /127\.0\.0\.1/, host);
    assert.throws(() => new IpcClient({ port: 1, host, key }), /127\.0\.0\.1/, host);
  }
});

test("the server listens on 127.0.0.1 only", async () => {
  const { server, port } = await startServer();
  try {
    assert.ok(port > 0);
    const raw = await rawConnect(port);
    assert.equal(raw.socket.remoteAddress, "127.0.0.1");
    raw.socket.destroy();
  } finally {
    await server.close();
  }
});

// ---- reconnect, offline, timeouts -----------------------------------------------------------------------

test("offline: calls fail at once; the client connects when the server appears and reconnects after it restarts", async () => {
  // reserve a port, release it, then start the client first
  const probe = await startServer();
  const port = probe.port;
  await probe.server.close();
  const c = client(port);
  let server: IpcServer | undefined;
  try {
    c.start();
    await sleep(80);
    assert.notEqual(c.state, "online");
    await assert.rejects(c.status(), IpcOfflineError);
    await assert.rejects(c.answerPermission({ requestId: "r", jobId: "j", answer: "deny", by: "user", at: 1 }), IpcOfflineError);

    const states: string[] = [];
    c.onStateChange((s) => states.push(s));
    server = (await startServer({ port })).server;
    await c.waitOnline({ timeoutMs: 3000 });
    assert.equal(c.state, "online");
    assert.ok(states.includes("online"));

    // the server goes away: the pending call fails with an offline error and the state follows
    await server.close();
    await waitFor(() => c.state !== "online", 2000, "offline");
    await assert.rejects(c.status(), IpcOfflineError);

    server = (await startServer({ port })).server;
    await c.waitOnline({ timeoutMs: 3000 });
    assert.deepEqual(await c.status(), STATUS);
  } finally {
    await c.close();
    await server?.close();
  }
});

test("a pending call fails with IpcOfflineError when the connection drops, and with IpcTimeoutError or IpcAbortError otherwise", async () => {
  let release: (() => void) | undefined;
  const { server, port } = await startServer({
    onRequest: (type) => {
      if (type === "status") return STATUS;
      return new Promise((resolve) => {
        release = () => resolve({ jobId: "j", state: "queued", duplicate: false });
      });
    },
  });
  const c = client(port);
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 2000 });
    await assert.rejects(c.submit(SUBMIT, { timeoutMs: 80 }), IpcTimeoutError);
    const ac = new AbortController();
    const p = c.submit(SUBMIT, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, IpcAbortError);
    const dropped = c.submit(SUBMIT);
    await sleep(30);
    await server.close();
    await assert.rejects(dropped, IpcOfflineError);
    release?.();
  } finally {
    await c.close();
    await server.close();
  }
});

test("waitOnline rejects on timeout and on abort", async () => {
  const c = new IpcClient({ port: 1, key });
  await assert.rejects(c.waitOnline({ timeoutMs: 30 }), IpcTimeoutError);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.waitOnline({ signal: ac.signal }), IpcAbortError);
});

test("a client with the wrong key never goes online (the server closes it, the client keeps retrying)", async () => {
  const { server, port, calls, log } = await startServer();
  const c = client(port, { key: jobKey, handshakeTimeoutMs: 300 });
  try {
    c.start();
    await waitFor(() => log.lines.some((l) => l.event === "ipc.rejected"), 2000, "a rejection");
    assert.notEqual(c.state, "online");
    assert.equal(calls.length, 0);
    await assert.rejects(c.status(), IpcOfflineError);
  } finally {
    await c.close();
    await server.close();
  }
});

// ---- I28: a per-job key on the same server --------------------------------------------------------------

test("a permission helper with a per-job key is answered, is a different principal, and gets no pushes", async () => {
  const { server, port, calls } = await startServer({
    onRequest: (type, body, ctx) => {
      if (type === "permission_request") return { decision: ctx.principal === "job:job-1" ? "allow_once" : "deny" };
      return STATUS;
    },
  });
  try {
    const raw = await rawConnect(port);
    raw.write(encodeLine(signMessage(jobKey, "permission_request", { requestId: "r1", jobId: "job-1", tool: "Read", input: {} })));
    await waitFor(() => raw.text().includes("\n"), 2000, "helper reply");
    const line = JSON.parse(raw.text().split("\n")[0] ?? "{}") as { type: string; body: { ok: boolean; data: { decision: string } } };
    assert.equal(line.type, "reply");
    assert.equal(line.body.data.decision, "allow_once");
    assert.equal(calls[0]?.principal, "job:job-1");
    assert.equal(server.broadcast("job_event", { jobId: "job-1" }), 0, "pushes go to the agent principal only");
    assert.equal(server.broadcast("job_event", { jobId: "job-1" }, "job:job-1"), 1, "explicitly addressed");
    raw.socket.destroy();

    // another job's token, and the job token on a non-permission request: both rejected
    const other = await rawConnect(port);
    other.write(encodeLine(signMessage(jobKey, "permission_request", { requestId: "r2", jobId: "job-2", tool: "Read", input: {} })));
    await other.closed;
    const third = await rawConnect(port);
    third.write(encodeLine(signMessage(jobKey, "submit", { jobId: "job-1" })));
    await third.closed;
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

// ---- the key never appears in logs ----------------------------------------------------------------------

test("the key text never appears in any log line, including the rejection paths, and secretValues registers it", async () => {
  const { server, port, log } = await startServer();
  const clientLog = captureLogger();
  const c = new IpcClient({ port, key, logger: clientLog.logger, reconnect: { initialDelayMs: 20, maxDelayMs: 40, jitter: false } });
  try {
    c.start();
    await c.waitOnline({ timeoutMs: 2000 });
    await c.submit(SUBMIT);
    for (const hostile of [Buffer.from("POST / HTTP/1.1\r\n\r\n"), Buffer.from("garbage\n"), encodeLine({ ...signMessage(key, "status", {}), mac: "b".repeat(64) })]) {
      const raw = await rawConnect(port);
      raw.write(hostile);
      await raw.closed;
    }
    await server.close();
    await waitFor(() => c.state !== "online", 2000, "offline");
  } finally {
    await c.close();
    await server.close();
  }
  const all = log.text() + clientLog.text();
  assert.doesNotMatch(all, new RegExp(KEY_TEXT_A));
  assert.doesNotMatch(all, new RegExp(KEY_TEXT_B));
  assert.doesNotMatch(all, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.ok(log.lines.length > 0);

  // the redactor built from the secrets removes the key text from anything that does carry it
  const values = secretValues({ telegramBotToken: "123:abcdefghijklmnopqrstuvwxyz", ipcHmacKey: KEY_TEXT_A, mcpTokens: { "book-translator": "bt-token-value-1" } });
  assert.ok(values.includes(KEY_TEXT_A));
  assert.ok(values.includes("bt-token-value-1"));
  const redact = createRedactor(values);
  assert.equal(redact(`oops ${KEY_TEXT_A} and bt-token-value-1`), "oops [REDACTED] and [REDACTED]");
});
