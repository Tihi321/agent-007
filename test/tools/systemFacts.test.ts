import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor } from "../../src/logging/redact.js";
import type { HealthStatus } from "../../src/runtime/health.js";
import { FACT_SCRIPTS, PS_PRELUDE, createSystemFactsTool, defaultPsRunner, powershellPath, psArgs, systemFacts } from "../../src/tools/systemFacts.js";
import type { PsRunResult, PsRunner, SystemFactsDeps } from "../../src/tools/systemFacts.js";
import { SYSTEM_FACTS } from "../../src/tools/schemas.js";
import { ToolRefusal } from "../../src/tools/folders.js";

const SCRIPT_FACTS = SYSTEM_FACTS.filter((f) => f !== "lmstudio");

function decode(args: readonly string[]): string {
  const i = args.indexOf("-EncodedCommand");
  assert.ok(i >= 0 && args[i + 1], "has -EncodedCommand");
  return Buffer.from(args[i + 1] as string, "base64").toString("utf16le");
}

function ok(stdout: string): PsRunResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, overflow: false };
}

interface Spy {
  runner: PsRunner;
  calls: (readonly string[])[];
}
function spy(stdout: string | ((script: string) => string)): Spy {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      return ok(typeof stdout === "function" ? stdout(decode(args)) : stdout);
    },
  };
}

const base = (extra: Partial<SystemFactsDeps> = {}): SystemFactsDeps => ({ runner: "lmstudio", modelId: "m1", ...extra });

test("every script constant is fixed: one per fact, no template placeholders, ends with ConvertTo-Json -Depth 3 -Compress", () => {
  assert.deepEqual(Object.keys(FACT_SCRIPTS).sort(), [...SCRIPT_FACTS].sort());
  for (const [fact, script] of Object.entries(FACT_SCRIPTS)) {
    assert.ok(script.trimEnd().endsWith("ConvertTo-Json -Depth 3 -Compress"), `${fact} ends with ConvertTo-Json`);
    assert.ok(!/\$\{|\{\{|\}\}|\{\d+\}|%[sdj]|\$\(|<%|\$env:|\$args|\$input/i.test(script), `${fact} has a placeholder: ${script}`);
    assert.ok(!/Invoke-Expression|iex |Start-Process|Remove-Item|Set-|New-Item|Out-File|>>?\s/i.test(script), `${fact} only reads`);
    assert.ok(!/undefined|\[object/.test(script), `${fact} has no leaked JS text`);
  }
  assert.match(FACT_SCRIPTS.os, /Win32_OperatingSystem/);
  assert.match(FACT_SCRIPTS.hardware, /Win32_Processor/);
  assert.match(FACT_SCRIPTS.hardware, /Win32_ComputerSystem/);
  assert.match(FACT_SCRIPTS.disks, /Win32_LogicalDisk/);
  assert.match(FACT_SCRIPTS.processes, /Get-Process/);
  assert.match(FACT_SCRIPTS.services, /Get-Service/);
  assert.match(FACT_SCRIPTS.apps, /Uninstall/);
  assert.match(FACT_SCRIPTS.apps, /HKLM:/);
  assert.match(FACT_SCRIPTS.apps, /HKCU:/);
  assert.match(FACT_SCRIPTS.network, /Get-NetIPAddress/);
  assert.ok(!/CommandLine/i.test(FACT_SCRIPTS.processes), "no command lines (they can hold secrets)");
});

test("the process is started with the fixed argument vector: -NoProfile -NonInteractive -EncodedCommand, script = prelude + constant", () => {
  const args = psArgs(FACT_SCRIPTS.os);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 4);
  assert.equal(decode(args), PS_PRELUDE + FACT_SCRIPTS.os);
  assert.match(powershellPath({ SystemRoot: "C:\\Windows" }), /^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
});

test("a malicious filter (and fact text) never reaches the process arguments", async () => {
  const malicious = '"; Remove-Item C:\\Users -Recurse -Force; "';
  const s = spy(JSON.stringify([{ Name: "chrome", Id: 1 }, { Name: "notepad", Id: 2 }]));
  const out = await systemFacts(base({ runPowerShell: s.runner }), { fact: "processes", filter: malicious });
  assert.equal(s.calls.length, 1);
  const all = [...(s.calls[0] as readonly string[]), decode(s.calls[0] as readonly string[])].join("\n");
  assert.ok(!all.includes("Remove-Item"), "malicious text absent from raw args and from the decoded script");
  assert.ok(!all.includes(malicious));
  assert.equal(decode(s.calls[0] as readonly string[]), PS_PRELUDE + FACT_SCRIPTS.processes, "the script is exactly the constant");
  assert.match(out, /"count":0/, "the filter was applied in JS and matched nothing");
  // an unknown fact is refused before anything runs
  await assert.rejects(systemFacts(base({ runPowerShell: s.runner }), { fact: "os; calc" as never }), ToolRefusal);
  assert.equal(s.calls.length, 1);
});

test("filter and limit are applied in JS, case-insensitively, over the rows", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ Name: i % 3 === 0 ? `Chrome${i}` : `other${i}`, Id: i }));
  const s = spy(JSON.stringify(rows));
  const out = await systemFacts(base({ runPowerShell: s.runner }), { fact: "processes", filter: "CHROME", limit: 4 });
  const body = JSON.parse(out.split("\n")[1] as string) as { count: number; total: number; rows: { Name: string }[] };
  assert.equal(body.total, 10);
  assert.equal(body.count, 4);
  assert.ok(body.rows.every((r) => /chrome/i.test(r.Name)));
  const all = JSON.parse((await systemFacts(base({ runPowerShell: s.runner }), { fact: "processes" })).split("\n")[1] as string) as { count: number };
  assert.equal(all.count, 30);
});

test("a single object for a row fact becomes one row, empty output becomes zero rows, object facts return data", async () => {
  const one = await systemFacts(base({ runPowerShell: spy('{"Drive":"C:","FreeGB":10}').runner }), { fact: "disks" });
  assert.match(one, /"count":1/);
  const none = await systemFacts(base({ runPowerShell: spy("").runner }), { fact: "services" });
  assert.match(none, /"count":0/);
  const obj = await systemFacts(base({ runPowerShell: spy('\uFEFF{"Caption":"Windows 11 Pro","Version":"10.0"}').runner }), { fact: "os", filter: "ignored", limit: 1 });
  assert.match(obj, /"data":\{"Caption":"Windows 11 Pro"/);
});

test("output is wrapped as untrusted content and capped at 16 KB, dropping rows from the end", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ Name: `Application ${i} ${"x".repeat(200)}`, Version: "1.0" }));
  const out = await systemFacts(base({ runPowerShell: spy(JSON.stringify(rows)).runner }), { fact: "apps", limit: 200 });
  assert.ok(out.startsWith('<untrusted_content source="system_facts:apps">'));
  assert.ok(out.endsWith("</untrusted_content>"));
  const json = out.split("\n")[1] as string;
  assert.ok(Buffer.byteLength(json) <= 16 * 1024, `${Buffer.byteLength(json)} bytes`);
  const parsed = JSON.parse(json) as { truncated: boolean; count: number; total: number };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.count < 200 && parsed.count > 10);
  assert.equal(parsed.total, 200);
});

test("timeouts, non-zero exits, oversized and unparseable output are refusals without leaking stderr", async () => {
  const run = (r: Partial<PsRunResult>): PsRunner => async () => ({ stdout: "", stderr: "C:\\secret\\path boom", exitCode: 0, timedOut: false, overflow: false, ...r });
  await assert.rejects(systemFacts(base({ runPowerShell: run({ timedOut: true, exitCode: null }) }), { fact: "os" }), /timed out/);
  await assert.rejects(systemFacts(base({ runPowerShell: run({ exitCode: 1 }) }), { fact: "os" }), (e: unknown) => e instanceof ToolRefusal && /exit 1/.test(e.message) && !e.message.includes("secret"));
  await assert.rejects(systemFacts(base({ runPowerShell: run({ overflow: true }) }), { fact: "os" }), /too large/);
  await assert.rejects(systemFacts(base({ runPowerShell: run({ stdout: "not json" }) }), { fact: "os" }), /parsed/);
});

function health(over: Partial<HealthStatus> = {}): { status(): HealthStatus } {
  return { status: () => ({ runner: "strata", up: true, since: Date.UTC(2026, 9, 29, 8, 0, 0), lastCheckedAt: Date.UTC(2026, 9, 29, 8, 5, 0), detail: "ok", ...over }) };
}

test("fact 'lmstudio' reports the CONFIGURED runner: Strata and LM Studio, without a shell and without secrets", async () => {
  const secrets = { strataApiKey: "strata-key-1234567890", lmStudioApiToken: "lms-token-1234567890" };
  const redact = createRedactor(Object.values(secrets));
  const never: PsRunner = async () => {
    throw new Error("no shell for the runner fact");
  };

  const strata = await systemFacts({ runner: "strata", modelId: "qwen3.8-flash-next-iq3_s", health: health(), runPowerShell: never, redact }, { fact: "lmstudio" });
  const sBody = JSON.parse(strata.split("\n")[1] as string) as { fact: string; data: Record<string, unknown> };
  assert.equal(sBody.fact, "lmstudio");
  assert.equal(sBody.data["runner"], "strata");
  assert.equal(sBody.data["runnerName"], "Strata");
  assert.equal(sBody.data["modelId"], "qwen3.8-flash-next-iq3_s");
  assert.equal(sBody.data["state"], "up");
  assert.equal(sBody.data["since"], "2026-10-29T08:00:00.000Z");

  const lms = await systemFacts(
    { runner: "lmstudio", modelId: "nail-qwen3.6-35b-a3b-mtp", health: health({ runner: "lmstudio", up: false, detail: `connect ECONNREFUSED with Bearer ${secrets.lmStudioApiToken}` }), runPowerShell: never, redact },
    { fact: "lmstudio" },
  );
  const lBody = JSON.parse(lms.split("\n")[1] as string) as { data: Record<string, unknown> };
  assert.equal(lBody.data["runner"], "lmstudio");
  assert.equal(lBody.data["runnerName"], "LM Studio");
  assert.equal(lBody.data["modelId"], "nail-qwen3.6-35b-a3b-mtp");
  assert.equal(lBody.data["state"], "down");

  for (const text of [strata, lms]) {
    for (const secret of Object.values(secrets)) assert.ok(!text.includes(secret), "secret value absent");
    assert.ok(!/baseUrl|127\.0\.0\.1|http:\/\//.test(text), "no endpoint in the output");
  }
  assert.match(lms, /\[REDACTED\]/, "a secret inside the health detail is redacted");

  const unknown = await systemFacts({ runner: "strata", modelId: "m", runPowerShell: never }, { fact: "lmstudio" });
  assert.match(unknown, /"state":"unknown"/);
});

test("system_facts tool: replay safe, frozen name, errors are error results", async () => {
  const tool = createSystemFactsTool(base({ runPowerShell: async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: false, overflow: false }) }));
  assert.equal(tool.name, "system_facts");
  assert.equal(tool.replay, "safe");
  const res = await tool.execute({ fact: "os" }, {} as never, {} as never);
  assert.equal(res.isError, true);
});

test("LIVE (main user): every fact returns parseable JSON through powershell.exe", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const deps = base({ runPowerShell: defaultPsRunner(), health: health() });
  for (const fact of SYSTEM_FACTS) {
    const out = await systemFacts(deps, { fact, limit: 5 });
    assert.ok(out.startsWith("<untrusted_content"), fact);
    const json = JSON.parse(out.split("\n")[1] as string) as Record<string, unknown>;
    assert.equal(json["fact"], fact);
    assert.ok(Object.keys(json).length >= 2, `${fact} returned data`);
    if (fact === "os") assert.match(JSON.stringify(json), /Windows/);
    if (fact === "processes") assert.ok((json["count"] as number) >= 1);
  }
  // the malicious filter really is just a filter, in a live run too
  const live = await systemFacts(deps, { fact: "processes", filter: '"; Remove-Item C:\\nope -Recurse; "' });
  assert.match(live, /"count":0/);
});
