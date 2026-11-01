/**
 * A fake `claude` for the driver tests: a node script, started by the driver as `node fakeClaude.js <claude args>`.
 * It never contacts anything. Behaviour comes from env vars the test sets:
 *
 *   FAKE_CLAUDE_SCENARIO   ok | error | crash | hang | askperm | slow
 *   FAKE_CLAUDE_RECORD     file to write `{argv, stdin, cwd, env}` to (env: only ANTHROPIC_* and A7_* names)
 *   FAKE_CLAUDE_PIDFILE    file for `{pid, childPid}` (hang scenario: a grandchild node process is started)
 *   FAKE_CLAUDE_VERSION    text for `--version` (default "2.1.310 (Claude Code)")
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { errorMessages, okMessages, toLines } from "./fixtures.js";

const argv = process.argv.slice(2);
const scenario = process.env["FAKE_CLAUDE_SCENARIO"] ?? "ok";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function emit(lines: string[], delay = 15): Promise<void> {
  for (const l of lines) {
    process.stdout.write(l + "\n");
    await sleep(delay);
  }
}

/** Talks to the permission helper the way Claude Code would: stdio MCP, initialize then one tools/call. */
async function askPermission(mcpConfigPath: string): Promise<{ decision: string; configExisted: boolean }> {
  const configExisted = existsSync(mcpConfigPath);
  const cfg = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  const s = cfg.mcpServers["a7perm"]!;
  const child = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  child.stdout.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      waiters.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const rpc = (id: number, method: string, params: object): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      waiters.push(resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const res = await rpc(2, "tools/call", {
    name: "decide",
    arguments: { tool_name: "Write", input: { file_path: "runs/out.txt", content: "hello" }, tool_use_id: "toolu_perm01" },
  });
  child.stdin.end();
  const text = ((res["result"] as { content: Array<{ text: string }> }).content[0]!).text;
  return { decision: (JSON.parse(text) as { behavior: string }).behavior, configExisted };
}

async function main(): Promise<void> {
  if (argv.includes("--version")) {
    process.stdout.write((process.env["FAKE_CLAUDE_VERSION"] ?? "2.1.310 (Claude Code)") + "\n");
    return;
  }
  const stdin = await readStdin();
  const recordPath = process.env["FAKE_CLAUDE_RECORD"];
  if (recordPath) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (/^(ANTHROPIC_|A7_)/i.test(k) && v !== undefined) env[k] = v;
    writeFileSync(recordPath, JSON.stringify({ argv, stdin, cwd: process.cwd(), env }));
  }
  const ok = okMessages();
  switch (scenario) {
    case "ok":
      await emit(toLines(ok));
      return;
    case "slow":
      await emit(toLines(ok.slice(0, 3)), 60);
      await emit(toLines(ok.slice(3)), 60);
      return;
    case "error":
      await emit(toLines(errorMessages()));
      process.exitCode = 1;
      return;
    case "crash":
      await emit(toLines(ok.slice(0, 1)));
      process.stderr.write("fatal: something broke\n");
      process.exitCode = 3;
      return;
    case "hang": {
      await emit(toLines(ok.slice(0, 1)));
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      const pidFile = process.env["FAKE_CLAUDE_PIDFILE"];
      if (pidFile) writeFileSync(pidFile, JSON.stringify({ pid: process.pid, childPid: grandchild.pid }));
      setInterval(() => undefined, 1000);
      await new Promise<void>(() => undefined);
      return;
    }
    case "askperm": {
      const i = argv.indexOf("--mcp-config");
      const { decision, configExisted } = await askPermission(argv[i + 1]!);
      const messages = [
        ok[0]!,
        { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_perm01", name: "Write", input: { file_path: "runs/out.txt" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_perm01", content: `decision=${decision}`, is_error: decision !== "allow" }] } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `decision=${decision} configExisted=${String(configExisted)}`,
          total_cost_usd: 0,
          duration_ms: 1,
          permission_denials: decision === "allow" ? [] : [{ tool_name: "Write" }],
        },
      ];
      await emit(toLines(messages));
      return;
    }
    default:
      process.stderr.write(`unknown scenario ${scenario}\n`);
      process.exitCode = 2;
  }
}

void main();
