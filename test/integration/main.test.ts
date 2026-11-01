/**
 * Entry-point tests (S6.2): `runMain` with a fake process (signals), exit codes, and the real
 * `node dist/src/main.js` as a child process (dry run: `--no-telegram`, so nothing contacts Telegram) that takes the lock,
 * refuses a second instance with exit code 3, and shuts down cleanly. The example config is used as the base.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_BAD_CONFIG, EXIT_OK, parseCli, runMain } from "../../src/main.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { LM_TOKEN, MODEL_ID, e2eBehavior, makeDirs, writeConfig } from "./rig.js";
import type { Dirs } from "./rig.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN_JS = join(REPO, "dist", "src", "main.js");

function cleanup(d: Dirs): void {
  rmSync(d.root, { recursive: true, force: true });
}

test("parseCli: defaults come from ProgramData, flags override, unknown flags are refused", () => {
  const d = parseCli([], { ProgramData: "C:\\PD" });
  assert.equal(d.configPath, "C:\\PD\\agent-007\\config\\config.json");
  assert.equal(d.secretsPath, "C:\\PD\\agent-007\\secrets\\secrets.json");
  assert.equal(d.telegram, true);
  assert.equal(d.checkAcl, true);
  const o = parseCli(["--config", "a.json", "--secrets", "s.json", "--no-telegram", "--skip-acl-check"], {});
  assert.deepEqual(o, { configPath: "a.json", secretsPath: "s.json", telegram: false, checkAcl: false });
  assert.throws(() => parseCli(["--bogus"], {}), /unknown argument/);
  assert.throws(() => parseCli(["--config"], {}), /needs a value/);
});

test("runMain: starts (dry run), takes the lock, and a SIGINT on the process stops it cleanly with exit code 0", async () => {
  const fake = await startFakeOpenAi({ behavior: e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
  const d = makeDirs();
  writeConfig(d, { baseUrl: fake.baseUrl });
  const proc = new EventEmitter();
  const out: string[] = [];
  const lockPath = join(d.data, "run", "agent.lock");
  try {
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    const finished = runMain(
      { configPath: d.configPath, secretsPath: d.secretsPath, telegram: false, checkAcl: false },
      { proc, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`), start: { env: d.env, healthIntervalMs: 3_600_000 }, onStarted: () => started() },
    );
    await up;
    assert.ok(existsSync(lockPath), "the lock file exists while running");
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    assert.equal(info.pid, process.pid);
    assert.ok(out.some((l) => l.startsWith("agent-007 started")));
    proc.emit("SIGINT");
    assert.equal(await finished, EXIT_OK);
    assert.equal(existsSync(lockPath), false, "the lock is released on shutdown");
    assert.ok(out.includes("agent-007 stopped"));
    assert.equal(proc.listenerCount("SIGINT"), 0, "signal handlers were removed");
  } finally {
    await fake.close();
    cleanup(d);
  }
});

test("runMain: a second instance exits 3 (lock held); an invalid config exits 2", async () => {
  const fake = await startFakeOpenAi({ behavior: e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
  const d = makeDirs();
  writeConfig(d, { baseUrl: fake.baseUrl });
  const proc = new EventEmitter();
  const errs: string[] = [];
  try {
    let started!: () => void;
    const up = new Promise<void>((r) => (started = r));
    const cli = { configPath: d.configPath, secretsPath: d.secretsPath, telegram: false, checkAcl: false };
    const first = runMain(cli, { proc, out: () => undefined, start: { env: d.env }, onStarted: () => started() });
    await up;
    // A different PID holds the lock for the second runMain: fake the holder by rewriting the file with the parent PID.
    const lockPath = join(d.data, "run", "agent.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    const second = await runMain(cli, { proc: new EventEmitter(), out: () => undefined, err: (l) => errs.push(l), start: { env: d.env } });
    assert.equal(second, 3);
    assert.match(errs.join("\n"), /another agent-007 instance holds/);
    proc.emit("SIGTERM");
    assert.equal(await first, EXIT_OK);

    const bad = join(d.root, "bad.json");
    writeFileSync(bad, JSON.stringify({ telegram: { allowedUserIds: [] } }));
    const code = await runMain({ ...cli, configPath: bad }, { proc: new EventEmitter(), out: () => undefined, err: (l) => errs.push(l), start: { env: d.env } });
    assert.equal(code, EXIT_BAD_CONFIG);
    assert.match(errs.join("\n"), /allowedUserIds/);
  } finally {
    await fake.close();
    cleanup(d);
  }
});

function runChild(args: string[], opts: { ipc: boolean }): { child: ReturnType<typeof spawn>; stdout: () => string; stderr: () => string; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [MAIN_JS, ...args], { stdio: opts.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], windowsHide: true });
  let so = "";
  let se = "";
  child.stdout?.on("data", (b: Buffer) => (so += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (se += b.toString()));
  const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, stdout: () => so, stderr: () => se, exit };
}

async function waitUntil(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("node dist/src/main.js with the example config (patched to temp dirs and the fake runner): starts, takes the lock, 2nd instance exits 3, IPC shutdown exits 0", async () => {
  assert.ok(existsSync(MAIN_JS), "run `npm run build` first");
  const fake = await startFakeOpenAi({ behavior: e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
  const d = makeDirs();
  // Start from config/config.example.json and change only what must point at the temp dirs and the fake runner.
  const example = JSON.parse(readFileSync(join(REPO, "config", "config.example.json"), "utf8")) as Record<string, any>;
  example["telegram"].allowedUserIds = [4242];
  example["model"].runner = "lmstudio";
  example["model"].runners.lmstudio.baseUrl = fake.baseUrl;
  example["model"].runners.lmstudio.modelId = MODEL_ID;
  delete example["model"].runners.strata;
  example["folders"].allow = [{ alias: "notes", path: d.notes }];
  const paths = {
    programDataDir: d.programData,
    dataDir: d.data,
    stateDir: join(d.data, "state"),
    workspaceDir: join(d.data, "workspace"),
    memoryFile: join(d.data, "memory", "MEMORY.md"),
    userFile: join(d.programData, "config", "USER.md"),
    logsDir: join(d.data, "logs"),
    auditDir: join(d.data, "audit"),
    controlDir: join(d.data, "control"),
    runDir: join(d.data, "run"),
  };
  example["paths"] = { ...paths };
  example["mainUserProfile"] = join(d.root, "profile");
  mkdirSync(d.root, { recursive: true });
  writeFileSync(d.configPath, JSON.stringify(example, null, 2));
  writeFileSync(d.secretsPath, JSON.stringify({ telegramBotToken: "123456:FAKE-test-token_AAAA", lmStudioApiToken: LM_TOKEN }));

  const args = ["--config", d.configPath, "--secrets", d.secretsPath, "--no-telegram", "--skip-acl-check"];
  const first = runChild(args, { ipc: true });
  try {
    await waitUntil(() => first.stdout().includes("agent-007 started"), 20_000, `the child to start (stderr: ${first.stderr()})`);
    assert.match(first.stdout(), /telegram off/);
    const lockPath = join(d.data, "run", "agent.lock");
    assert.ok(existsSync(lockPath), "the lock file exists");
    assert.equal((JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid, first.child.pid);

    const second = runChild(args, { ipc: false });
    assert.equal(await second.exit, 3, `the second instance exits 3 (stderr: ${second.stderr()})`);
    assert.match(second.stderr(), /another agent-007 instance holds/);

    first.child.send({ type: "shutdown" });
    assert.equal(await first.exit, 0, `a clean exit (stderr: ${first.stderr()})`);
    assert.match(first.stdout(), /agent-007 stopped/);
    assert.equal(existsSync(lockPath), false, "the lock is gone after a clean shutdown");
    const noise = first.stderr().split("\n").filter((l) => l.trim() !== "" && !/ExperimentalWarning: SQLite|--trace-warnings/.test(l));
    assert.deepEqual(noise, [], "nothing on stderr except the node:sqlite experimental notice");
    assert.ok(existsSync(join(d.data, "logs")), "the agent log folder was created");
    assert.ok(existsSync(join(d.data, "state", "agent.sqlite")), "the SQLite file was created");
  } finally {
    if (first.child.exitCode === null) first.child.kill();
    await fake.close();
    cleanup(d);
  }
});
