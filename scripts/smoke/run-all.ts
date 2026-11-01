/**
 * Runs the Phase 0 smoke scripts in order and summarises (P0.4).
 *   node dist/scripts/smoke/run-all.js [--runner lmstudio|strata] [--only S2,S3] [--s5-minutes 5] [--s5b]
 * Each script is a separate process that prints `SMOKE <id> PASS|FAIL runner=<name>: <reason>` and exits 0/1.
 * If the runner is unreachable, every script that needs it is reported as an unreachable FAIL without starting
 * anything; S1 does not need a runner and still runs.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRunnerReachable, formatSmokeLine, isMain, loadSmokeRunner, parseArgs, smokeOutDir, unreachableOutcome } from "./config.js";
import type { ParsedArgs, SmokeOutcome } from "./config.js";

interface ScriptSpec {
  id: string;
  file: string;
  needsRunner: boolean;
  extra?: (args: ParsedArgs) => string[];
}

export const SCRIPTS: ScriptSpec[] = [
  { id: "S1", file: "s1-sqlite.js", needsRunner: false },
  { id: "S2", file: "s2-roundtrip.js", needsRunner: true },
  { id: "S3", file: "s3-toolcall.js", needsRunner: true },
  { id: "S4", file: "s4-crash-resume.js", needsRunner: true },
  { id: "S5", file: "s5-long-hook.js", needsRunner: true, extra: (a) => (typeof a.flags["s5-minutes"] === "string" ? ["--minutes", a.flags["s5-minutes"]] : []) },
  { id: "S6", file: "s6-stream-timeout.js", needsRunner: true },
  { id: "S7", file: "s7-runner-down.js", needsRunner: true },
];

function passThrough(args: ParsedArgs): string[] {
  const out: string[] = [];
  for (const k of ["runner", "model", "base-url", "compat"]) {
    const v = args.flags[k];
    if (typeof v === "string") out.push(`--${k}`, v);
  }
  if (args.flags["no-key"]) out.push("--no-key");
  return out;
}

function runScript(file: string, argv: string[]): Promise<{ code: number | null; lastLine: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), file), ...argv], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.on("exit", (code) => resolve({ code, lastLine: out.trim().split("\n").filter((l) => l.startsWith("SMOKE ")).pop() ?? "" }));
  });
}

export async function runAll(args: ParsedArgs, scripts: ScriptSpec[] = SCRIPTS): Promise<{ lines: string[]; failed: number }> {
  const cfg = loadSmokeRunner(args);
  const only = args.only;
  const selected = scripts.filter((s) => !only || only.includes(s.id));
  const reach = await checkRunnerReachable(cfg);
  const lines: string[] = [];
  const outcomes: Record<string, unknown>[] = [];
  let failed = 0;
  for (const s of selected) {
    if (s.needsRunner && !reach.reachable) {
      const o: SmokeOutcome = unreachableOutcome(s.id, cfg, reach);
      const line = formatSmokeLine(o);
      console.log(line);
      lines.push(line);
      outcomes.push({ id: s.id, pass: false, line });
      failed++;
      continue;
    }
    const argv = [...passThrough(args), ...(s.extra?.(args) ?? [])];
    const r = await runScript(s.file, argv);
    const line = r.lastLine || `SMOKE ${s.id} FAIL runner=${cfg.runner}: no result line printed (exit ${r.code})`;
    lines.push(line);
    const pass = r.code === 0 && / PASS /.test(line);
    if (!pass) failed++;
    outcomes.push({ id: s.id, pass, exitCode: r.code, line });
  }
  if (args.flags["s5b"] && (!only || only.includes("S5")) && reach.reachable) {
    const r = await runScript("s5-long-hook.js", [...passThrough(args), "--restart"]);
    const line = r.lastLine || `SMOKE S5b FAIL runner=${cfg.runner}: no result line printed (exit ${r.code})`;
    lines.push(line);
    if (r.code !== 0) failed++;
    outcomes.push({ id: "S5b", pass: r.code === 0, exitCode: r.code, line });
  }
  console.log("\n==== smoke summary (" + cfg.runner + ") ====");
  for (const l of lines) console.log(l);
  console.log(failed === 0 ? `ALL ${lines.length} PASS` : `${failed} of ${lines.length} FAILED`);
  const out = smokeOutDir();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `run-all.${cfg.runner}.json`), JSON.stringify({ runner: cfg.runner, at: new Date().toISOString(), outcomes }, null, 2));
  return { lines, failed };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const { failed } = await runAll(args);
  process.exitCode = failed === 0 ? 0 : 1;
}
