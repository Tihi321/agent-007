/** S11.5 done-check: unknown service refused, fixed argv, scriptorium needs its flag. A fake exec stands in for pwsh. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HubError, HubRunner, SCRIPTORIUM, createHubEngineDriver, parseServicesJson, parseStatusOutput } from "../../../src/jobrunner/hub.js";
import type { ExecResult } from "../../../src/jobrunner/proc.js";
import type { HubConfig } from "../../../src/jobrunner/limits.js";
import type { JobEvent } from "../../../src/jobs/contracts.js";

const CFG: HubConfig = { dir: "C:\\hub", services: ["vibetts", "comfy", "scriptorium"], pwsh: "pwsh", ports: {}, startTimeoutSec: 5, statusTimeoutSec: 5 };

function rig(over: Partial<HubConfig> = {}, handler: (args: string[]) => ExecResult = () => ({ code: 0, stdout: "", stderr: "", timedOut: false })) {
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const hub = new HubRunner({ ...CFG, ...over }, {
    exec: (exe, args, o) => {
      calls.push({ exe, args: [...args], cwd: o.cwd });
      return Promise.resolve(handler([...args]));
    },
    probe: () => Promise.resolve(false),
  });
  return { hub, calls };
}

test("an unknown service is refused before anything runs", async () => {
  const { hub, calls } = rig();
  for (const bad of ["unknown", "vibetts; calc", "vibetts && whoami", "", "VIBETTS", "../scripts", "vibetts\nstart"]) {
    await assert.rejects(hub.start(bad), (e: unknown) => e instanceof HubError && e.code === "bad_request");
  }
  assert.equal(calls.length, 0, "no process was started");
  assert.throws(() => hub.argv("start", "nope"), HubError);
  assert.throws(() => hub.argv("start"), HubError);
});

test("the argv is fixed: pwsh -NoProfile -File <hub>\\scripts\\hub.ps1 start <service>, no shell string", async () => {
  const { hub, calls } = rig({}, (args) => (args[3] === "status" ? { code: 0, stdout: "", stderr: "", timedOut: false } : { code: 0, stdout: "started vibetts on 8123\n", stderr: "", timedOut: false }));
  const r = await hub.start("vibetts");
  assert.equal(r.started, true);
  assert.equal(r.message, "started vibetts on 8123");
  assert.deepEqual(hub.argv("start", "vibetts"), ["-NoProfile", "-File", "C:\\hub\\scripts\\hub.ps1", "start", "vibetts"]);
  assert.deepEqual(hub.argv("status"), ["-NoProfile", "-File", "C:\\hub\\scripts\\hub.ps1", "status"]);
  const start = calls.find((c) => c.args[3] === "start");
  assert.ok(start);
  assert.equal(start.exe, "pwsh");
  assert.deepEqual(start.args, ["-NoProfile", "-File", "C:\\hub\\scripts\\hub.ps1", "start", "vibetts"]);
  assert.equal(start.cwd, "C:\\hub");
  // every call is one of the two fixed shapes
  for (const c of calls) assert.ok(c.args.length === 4 || c.args.length === 5);
});

test("scriptorium without the explicit approval flag is refused; with it, it runs", async () => {
  const { hub, calls } = rig();
  await assert.rejects(hub.start(SCRIPTORIUM), (e: unknown) => e instanceof HubError && e.code === "forbidden");
  await assert.rejects(hub.start(SCRIPTORIUM, { scriptoriumApproved: false }), HubError);
  assert.equal(calls.length, 0);
  const r = await hub.start(SCRIPTORIUM, { scriptoriumApproved: true });
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c.args.includes("scriptorium") && c.args[3] === "start"));
});

test("a service that is already up is not started again; a failing start says why", async () => {
  const up = rig({}, () => ({ code: 0, stdout: JSON.stringify([{ id: "vibetts", up: true }]), stderr: "", timedOut: false }));
  const r = await up.hub.start("vibetts");
  assert.deepEqual(r, { service: "vibetts", started: false, alreadyUp: true, message: "vibetts is already running" });
  assert.ok(up.calls.every((c) => c.args[3] === "status"));
  const fail = rig({}, (args) => (args[3] === "start" ? { code: 2, stdout: "", stderr: "port busy\n", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false }));
  const f = await fail.hub.start("comfy");
  assert.equal(f.started, false);
  assert.match(f.message, /exited with 2: port busy/);
  const slow = rig({}, (args) => (args[3] === "start" ? { code: null, stdout: "", stderr: "", timedOut: true } : { code: 0, stdout: "", stderr: "", timedOut: false }));
  assert.match((await slow.hub.start("comfy")).message, /timed out after 5 s/);
});

test("hub_status: parses JSON and line output, and a TCP probe wins when a port is configured", async () => {
  const lines = rig({}, () => ({ code: 0, stdout: "vibetts   running\ncomfy   stopped\nscriptorium: not running\n", stderr: "", timedOut: false }));
  assert.deepEqual((await lines.hub.status()).services, [
    { id: "vibetts", up: true },
    { id: "comfy", up: false },
    { id: "scriptorium", up: false },
  ]);
  const probed = new HubRunner({ ...CFG, ports: { vibetts: 8123 } }, { exec: () => Promise.resolve({ code: 0, stdout: "vibetts stopped", stderr: "", timedOut: false }), probe: (p) => Promise.resolve(p === 8123) });
  assert.deepEqual((await probed.status()).services[0], { id: "vibetts", up: true, port: 8123 });
  const broken = rig({}, () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false }));
  assert.ok((await broken.hub.status()).services.every((s) => !s.up));
  assert.deepEqual([...parseStatusOutput('{"services":[{"name":"comfy","status":"up"}]}', ["comfy"])], [["comfy", true]]);
});

test("services.json can supply the fixed list (array, object, or {services})", () => {
  assert.deepEqual(parseServicesJson('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseServicesJson('[{"id":"vibetts"},{"name":"comfy"}]'), ["vibetts", "comfy"]);
  assert.deepEqual(parseServicesJson('{"services":{"vibetts":{},"comfy":{}}}'), ["vibetts", "comfy"]);
  assert.deepEqual(parseServicesJson('{"vibetts":{},"_c":1}'), ["vibetts"]);
  assert.throws(() => parseServicesJson("nope"));
  const hub = new HubRunner({ ...CFG, services: ["ignored"], servicesFile: "C:\\hub\\services.json" }, { readFile: () => '["x1","bad name"]', exec: () => Promise.reject(new Error("no")) });
  assert.deepEqual(hub.services(), ["x1"]);
});

test("the hub engine driver starts one fixed service as a job and never scriptorium", async () => {
  const { hub } = rig({}, (args) => (args[3] === "start" ? { code: 0, stdout: "up\n", stderr: "", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false }));
  const driver = createHubEngineDriver(hub);
  const spec = (service: string | undefined) => ({ jobId: "j1", template: { hubService: service } as never, params: {}, brief: "", prompt: "", cwd: "C:\\hub", host: {} as never });
  await assert.rejects(driver.start(spec(SCRIPTORIUM)), HubError);
  await assert.rejects(driver.start(spec(undefined)), HubError);
  await driver.start(spec("vibetts"));
  const events: JobEvent[] = [];
  for await (const e of driver.events("j1")) events.push(e);
  assert.deepEqual(events.map((e) => e.kind), ["progress", "result", "state"]);
  assert.equal(events[2]?.kind === "state" && events[2].state, "succeeded");
  await assert.rejects(driver.resume({ ...spec("vibetts"), engineSessionId: "x" }));
});
