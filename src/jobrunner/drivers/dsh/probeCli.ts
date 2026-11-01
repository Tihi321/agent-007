/**
 * The U39 live-probe command line (S13.2). Run by the MAIN user, in their own terminal, once, after reading the usage text:
 *
 *   node dist\src\jobrunner\drivers\dsh\probeCli.js --live --cwd <empty scratch folder> [--data-dir D] [--shell-off-attestation TEXT]
 *        [--ask-first-mode ID] [--dsh-path P] [--timeout-sec N]
 *
 * It runs the real `dsh` and calls the DeepSeek API (cloud quota), so nothing starts without `--live`; without it the command
 * only prints what it would do. The scratch folder must be empty (never creative-hub or any real project). The evidence goes to
 * `<dataDir>\dsh-probe.json` (the file the driver's gate reads). This command NEVER sets `engines.dsh.verified`: after a PASS,
 * the user reads the evidence and sets it in jobrunner.json themselves. Tests drive `runProbeCli` with fakes only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { FileEvidenceStore } from "./gate.js";
import { resolveDshPath, DshNotFoundError } from "./launch.js";
import { runDshProbe } from "./probe.js";
import type { RunProbeOptions } from "./probe.js";
import type { DshEvidenceStore, DshProbeEvidence, Logger } from "./types.js";

export interface ProbeCliArgs {
  live: boolean;
  cwd?: string;
  dataDir?: string;
  shellOffAttestation?: string;
  askFirstModeId?: string;
  dshPath?: string;
  timeoutSec?: number;
}

export class ProbeUsageError extends Error {}

const VALUE_FLAGS = new Set(["--cwd", "--data-dir", "--shell-off-attestation", "--ask-first-mode", "--dsh-path", "--timeout-sec"]);

export function parseProbeArgs(argv: readonly string[]): ProbeCliArgs {
  const out: ProbeCliArgs = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--live") {
      out.live = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) throw new ProbeUsageError(`unknown argument: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ProbeUsageError(`${a} needs a value`);
    i += 1;
    switch (a) {
      case "--cwd":
        out.cwd = v;
        break;
      case "--data-dir":
        out.dataDir = v;
        break;
      case "--shell-off-attestation":
        out.shellOffAttestation = v;
        break;
      case "--ask-first-mode":
        out.askFirstModeId = v;
        break;
      case "--dsh-path":
        out.dshPath = v;
        break;
      default: {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 10 || n > 1800) throw new ProbeUsageError("--timeout-sec must be an integer from 10 to 1800");
        out.timeoutSec = n;
      }
    }
  }
  return out;
}

export const PROBE_USAGE = [
  "dsh live probe (U39). This runs the REAL dsh and spends DeepSeek quota.",
  "  --live                      required; without it nothing runs",
  "  --cwd <folder>              required; an absolute, existing, EMPTY scratch folder",
  "  --data-dir <folder>         where dsh-probe.json is written (default %LOCALAPPDATA%\\agent-007-jobrunner)",
  "  --shell-off-attestation <t> say how dsh's own shell is switched off (the config line), if it is",
  "  --ask-first-mode <id>       the dsh mode that asks before acting",
  "  --dsh-path <file>           absolute dsh path (default: found on PATH)",
  "  --timeout-sec <n>           10 to 1800 (default 180)",
  "It never sets engines.dsh.verified. After a PASS, read the evidence and set it yourself.",
].join("\n");

export interface ProbeCliDeps {
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  isEmptyDir: (path: string) => boolean;
  resolveDsh: (explicit: string | undefined) => string;
  readDeepseekKey: (dataDir: string) => string | undefined;
  probe: (opts: RunProbeOptions) => Promise<DshProbeEvidence>;
  storeFor: (path: string) => DshEvidenceStore;
  logger: Logger;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "agent-007-jobrunner");
}

function defaultReadKey(dataDir: string): string | undefined {
  const file = join(dataDir, "secrets.json");
  if (!existsSync(file)) return undefined;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { deepseekApiKey?: unknown }).deepseekApiKey;
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

const consoleLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export function defaultProbeCliDeps(): ProbeCliDeps {
  return {
    out: (l) => console.log(l),
    env: process.env,
    isEmptyDir: (p) => existsSync(p) && statSync(p).isDirectory() && readdirSync(p).length === 0,
    resolveDsh: (explicit) => resolveDshPath(explicit !== undefined ? { explicit } : {}),
    readDeepseekKey: defaultReadKey,
    probe: runDshProbe,
    storeFor: (p) => new FileEvidenceStore(p),
    logger: consoleLogger,
  };
}

/** Returns the exit code: 0 the probe passed, 1 it ran and failed, 2 not run (usage, refused, or no `--live`). */
export async function runProbeCli(argv: readonly string[], deps: ProbeCliDeps = defaultProbeCliDeps()): Promise<number> {
  let args: ProbeCliArgs;
  try {
    args = parseProbeArgs(argv);
  } catch (e) {
    deps.out(`dsh-probe: ${(e as Error).message}`);
    deps.out(PROBE_USAGE);
    return 2;
  }
  if (!args.live) {
    deps.out("dsh-probe: dry run, nothing was started. Add --live to run the real dsh.");
    deps.out(PROBE_USAGE);
    return 2;
  }
  if (args.cwd === undefined || !isAbsolute(args.cwd) || args.cwd.startsWith("\\\\")) {
    deps.out("dsh-probe: --cwd must be an absolute local scratch folder");
    return 2;
  }
  if (/creative-hub|pixotope/i.test(args.cwd)) {
    deps.out("dsh-probe: refused: the scratch folder must not be creative-hub or a work folder");
    return 2;
  }
  if (!deps.isEmptyDir(args.cwd)) {
    deps.out("dsh-probe: refused: --cwd must exist and be empty");
    return 2;
  }
  let dshPath: string;
  try {
    dshPath = deps.resolveDsh(args.dshPath);
  } catch (e) {
    deps.out(`dsh-probe: ${e instanceof DshNotFoundError ? e.message : "dsh could not be resolved"}`);
    return 2;
  }
  const dataDir = resolve(args.dataDir ?? defaultDataDir(deps.env));
  const key = deps.readDeepseekKey(dataDir);
  const evidencePath = join(dataDir, "dsh-probe.json");
  const opts: RunProbeOptions = { dshPath, cwd: resolve(args.cwd), logger: deps.logger, store: deps.storeFor(evidencePath) };
  if (key !== undefined) opts.deepseekApiKey = key;
  if (args.shellOffAttestation !== undefined) opts.shellOffAttestation = args.shellOffAttestation;
  if (args.askFirstModeId !== undefined) opts.askFirstModeId = args.askFirstModeId;
  if (args.timeoutSec !== undefined) opts.timeoutMs = args.timeoutSec * 1000;
  const e = await deps.probe(opts);
  deps.out(`dsh-probe: ${e.passed ? "PASS" : "FAIL"} (dsh ${e.dshVersion})`);
  for (const r of e.reasons) deps.out(`  - ${r}`);
  deps.out(`evidence: ${evidencePath}`);
  if (e.passed) deps.out("engines.dsh.verified is NOT changed. Read the evidence, then set it in jobrunner.json yourself.");
  return e.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runProbeCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error("dsh-probe: " + (e instanceof Error ? e.message : String(e)));
      process.exit(1);
    },
  );
}
