import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createHealthMonitor, probeRunner } from "../src/runtime/health.js";
import type { HealthStatus } from "../src/runtime/health.js";

interface Stub {
  server: Server;
  port: number;
  hits: string[];
  /** Mutable behaviour. */
  state: { healthOk: boolean; modelIds: string[]; requireKey?: string; healthDelayMs: number; modelsStatus: number };
  close(): Promise<void>;
}

async function startStub(port = 0): Promise<Stub> {
  const hits: string[] = [];
  const state: Stub["state"] = { healthOk: true, modelIds: ["m-1"], healthDelayMs: 0, modelsStatus: 200 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "-"}`);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.requireKey && req.headers.authorization !== `Bearer ${state.requireKey}` && req.url !== "/health") return send(401, { error: "unauthorized" });
    if (req.url === "/health") return void setTimeout(() => (state.healthOk ? send(200, { status: "ok" }) : send(503, { status: "loading" })), state.healthDelayMs);
    if (req.url === "/v1/models") {
      if (state.modelsStatus !== 200) return send(state.modelsStatus, {});
      return send(200, { data: state.modelIds.map((id) => ({ id })) });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const actual = (server.address() as AddressInfo).port;
  return {
    server,
    port: actual,
    hits,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("LM Studio shape: GET /v1/models with the token; up needs 200 and the model id", async () => {
  const stub = await startStub();
  try {
    stub.state.requireKey = "tok-lm";
    const base = `http://127.0.0.1:${stub.port}/v1`;
    const o = { runner: "lmstudio" as const, baseUrl: base, modelId: "m-1", apiKey: "tok-lm" };
    assert.deepEqual(await probeRunner(o), { up: true, detail: "ok" });
    assert.ok(stub.hits.some((h) => h === "GET /v1/models auth=Bearer tok-lm"));
    assert.equal(stub.hits.some((h) => h.includes("/health")), false, "LM Studio is not probed on /health");

    assert.match((await probeRunner({ ...o, apiKey: "wrong" })).detail, /HTTP 401/);
    stub.state.modelIds = ["other"];
    assert.match((await probeRunner(o)).detail, /model m-1 not listed/);
  } finally {
    await stub.close();
  }
});

test("Strata shape: /health AND /v1/models (with the key) listing the model id", async () => {
  const stub = await startStub();
  try {
    stub.state.requireKey = "sk-strata";
    const base = `http://127.0.0.1:${stub.port}/v1`;
    const o = { runner: "strata" as const, baseUrl: base, modelId: "m-1", apiKey: "sk-strata" };
    assert.deepEqual(await probeRunner(o), { up: true, detail: "ok" });
    assert.ok(stub.hits.some((h) => h.startsWith("GET /health")));
    assert.ok(stub.hits.some((h) => h === "GET /v1/models auth=Bearer sk-strata"));

    stub.state.healthOk = false;
    assert.match((await probeRunner(o)).detail, /\/health returned HTTP 503/);
    stub.state.healthOk = true;
    assert.match((await probeRunner({ ...o, apiKey: "bad" })).detail, /models returned HTTP 401/);
    stub.state.modelIds = [];
    assert.match((await probeRunner(o)).detail, /not listed/);
  } finally {
    await stub.close();
  }
});

test("Strata busy: a slow /health counts as up, not down; a refused connection is down", async () => {
  const stub = await startStub();
  const base = `http://127.0.0.1:${stub.port}/v1`;
  try {
    stub.state.healthDelayMs = 400;
    const busy = await probeRunner({ runner: "strata", baseUrl: base, modelId: "m-1", timeoutMs: 100 });
    assert.equal(busy.up, true);
    assert.match(busy.detail, /busy/);
    // LM Studio has no FIFO excuse: a timeout is down
    stub.state.healthDelayMs = 0;
  } finally {
    await stub.close();
  }
  const down = await probeRunner({ runner: "strata", baseUrl: base, modelId: "m-1", timeoutMs: 500 });
  assert.equal(down.up, false);
  assert.match(down.detail, /runner unreachable: ECONNREFUSED/);
});

test("monitor: going up and down emits change events once each, with a stable since", async () => {
  const stub = await startStub();
  const base = `http://127.0.0.1:${stub.port}/v1`;
  let t = 1000;
  const mon = createHealthMonitor({ runner: "lmstudio", baseUrl: base, modelId: "m-1", now: () => t, timeoutMs: 500 });
  const changes: HealthStatus[] = [];
  mon.onChange((s) => changes.push(s));
  try {
    assert.equal(mon.status().up, false);
    t = 2000;
    assert.equal((await mon.check()).up, true); // first result is a change
    t = 3000;
    await mon.check(); // no change
    assert.equal(mon.status().since, 2000);
    assert.equal(changes.length, 1);

    stub.state.modelsStatus = 500;
    t = 4000;
    assert.equal((await mon.check()).up, false);
    assert.equal(mon.status().since, 4000);
    stub.state.modelsStatus = 200;
    t = 5000;
    assert.equal((await mon.check()).up, true);
    assert.deepEqual(changes.map((c) => c.up), [true, false, true]);
    assert.equal(changes[0]?.runner, "lmstudio");
  } finally {
    mon.stop();
    await stub.close();
  }
});
