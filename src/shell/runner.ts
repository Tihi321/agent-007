/**
 * PowerShell runner (S3.1, I8). Spawns Windows PowerShell 5.1 by absolute path with
 * `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Restricted -OutputFormat Text -EncodedCommand <base64 UTF-16LE>`.
 * cwd = workspace, windowsHide, stdin closed, minimal environment. A timeout or abort kills the whole process tree
 * (`taskkill /PID <pid> /T /F`). Output is capped, hashed and saved to `workspace\shell-output\<key>.txt`.
 * It runs as the agent user automatically, because the agent process does.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellConfig } from "../config/schema.js";

export interface ShellRunOptions {
  /** Approval/exec key, used for the saved output file name. */
  key: string;
  command: string;
  timeoutSec: number;
  signal?: AbortSignal | undefined;
}

export interface ShellRunResult {
  /** Null when the process was killed (timeout or abort). */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Head + marker + tail, at most about `returnBytes`, ready for the model (not yet wrapped). */
  output: string;
  /** All bytes the process wrote (stdout and stderr). */
  totalBytes: number;
  /** Bytes saved to the output file (capped at `maxOutputBytes`). */
  storedBytes: number;
  /** Bytes left out of `output`. */
  truncatedBytes: number;
  /** SHA-256 of all output bytes. */
  sha256: string;
  outputFile: string;
  pid: number | undefined;
}

export interface ShellRunner {
  run(opts: ShellRunOptions): Promise<ShellRunResult>;
}

export interface ShellRunnerOptions {
  workspaceDir: string;
  /** Re-read on every run, so config changes apply at once. */
  getShellConfig: () => ShellConfig;
  /** Override for tests only; the default is the System32 path resolved at construction. */
  powershellPath?: string;
  /** Source of the system variables copied into the child environment (default `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * Prefix of every command. `$ProgressPreference` is silenced because Windows PowerShell 5.1 writes progress records
 * ("Preparing modules for first use") to stderr as CLIXML when stdout is redirected; `-OutputFormat Text` (below)
 * keeps errors as plain text for the same reason. Both found by the real-PowerShell tests (deviation from S3.1's arg list).
 */
export const OUTPUT_ENCODING_PREFIX = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ";

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env["SystemRoot"] ?? env["SYSTEMROOT"] ?? env["windir"] ?? "C:\\Windows";
}

export function resolvePowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function resolveTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(systemRoot(env), "System32", "taskkill.exe");
}

/** Clamp the requested timeout to the configured default and maximum (I12). */
export function effectiveTimeoutSec(requested: number | undefined, cfg: ShellConfig): number {
  const t = requested === undefined || !Number.isFinite(requested) ? cfg.execTimeoutSec : Math.floor(requested);
  return Math.max(1, Math.min(t, cfg.maxExecTimeoutSec));
}

/** The base64 UTF-16LE text for `-EncodedCommand`. */
export function encodeCommand(command: string): string {
  return Buffer.from(OUTPUT_ENCODING_PREFIX + command, "utf16le").toString("base64");
}

function pick(src: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(src)) if (k.toLowerCase() === lower && typeof v === "string") return v;
  return undefined;
}

/**
 * The minimal child environment (S3.1): only these variables, nothing else, so no secret or token in the agent's
 * own environment can leak into a command. TEMP/TMP point into the workspace.
 */
export function buildShellEnv(workspaceDir: string, src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const root = systemRoot(src);
  const env: Record<string, string> = {
    SystemRoot: root,
    windir: pick(src, "windir") ?? root,
    PATH: [join(root, "System32"), root, join(root, "System32", "Wbem"), join(root, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    TEMP: join(workspaceDir, ".tmp"),
    TMP: join(workspaceDir, ".tmp"),
    // The system default, never inherited: a PowerShell 7 parent (or a user-level path) puts modules on the path that
    // Windows PowerShell 5.1 cannot load, and an inherited path would let a writable folder shadow a system module.
    PSModulePath: [join(pick(src, "ProgramFiles") ?? "C:\\Program Files", "WindowsPowerShell", "Modules"), join(root, "System32", "WindowsPowerShell", "v1.0", "Modules")].join(";"),
    ComSpec: pick(src, "ComSpec") ?? join(root, "System32", "cmd.exe"),
    PATHEXT: pick(src, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD",
  };
  for (const name of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMPUTERNAME", "USERNAME"]) {
    const v = pick(src, name);
    if (v !== undefined) env[name] = v;
  }
  return env;
}

class OutputCollector {
  private readonly hash = createHash("sha256");
  private readonly stored: Buffer[] = [];
  private storedLen = 0;
  private tail: Buffer = Buffer.alloc(0);
  total = 0;
  private readonly bomChecked = new Set<string>();

  constructor(
    private readonly cap: number,
    private readonly tailBytes: number,
  ) {}

  add(stream: string, chunk: Buffer): void {
    let data = chunk;
    // Windows PowerShell can emit a UTF-8 BOM when [Console]::OutputEncoding is set to UTF8: drop it.
    if (!this.bomChecked.has(stream)) {
      this.bomChecked.add(stream);
      if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
    }
    if (data.length === 0) return;
    this.hash.update(data);
    this.total += data.length;
    if (this.storedLen < this.cap) {
      const piece = data.subarray(0, this.cap - this.storedLen);
      this.stored.push(piece);
      this.storedLen += piece.length;
    }
    this.tail = Buffer.concat([this.tail, data]);
    if (this.tail.length > this.tailBytes) this.tail = this.tail.subarray(this.tail.length - this.tailBytes);
  }

  storedBuffer(): Buffer {
    return Buffer.concat(this.stored);
  }

  get storedBytes(): number {
    return this.storedLen;
  }

  tailBuffer(): Buffer {
    return this.tail;
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

/** Drop an incomplete multi-byte sequence at the END of a slice (the slice was cut mid-character). */
function trimIncompleteEnd(buf: Buffer): Buffer {
  const n = buf.length;
  for (let back = 1; back <= Math.min(4, n); back++) {
    const b = buf[n - back]!;
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, n - back) : buf;
  }
  return buf;
}

/** Drop orphaned continuation bytes at the START of a slice (the slice was cut mid-character). */
function trimOrphanStart(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i]! & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

/** Head and tail of the output within `returnBytes`, with a `[truncated N bytes]` marker between them. */
export function composeOutput(collector: { total: number; storedBuffer(): Buffer; tailBuffer(): Buffer }, returnBytes: number, storedBytes: number): { text: string; truncatedBytes: number } {
  const total = collector.total;
  if (total <= returnBytes && storedBytes === total) return { text: collector.storedBuffer().toString("utf8"), truncatedBytes: 0 };
  const headLen = Math.floor(returnBytes / 2);
  const tailLen = returnBytes - headLen;
  const head = collector.storedBuffer().subarray(0, Math.min(headLen, storedBytes));
  const tailAll = collector.tailBuffer();
  const tail = tailAll.subarray(Math.max(0, tailAll.length - tailLen));
  const truncated = Math.max(0, total - head.length - tail.length);
  const headText = trimIncompleteEnd(head).toString("utf8");
  const tailText = trimOrphanStart(tail).toString("utf8");
  return { text: `${headText}\n[truncated ${truncated} bytes]\n${tailText}`, truncatedBytes: truncated };
}

function safeFileName(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const h = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${cleaned}-${h}.txt`;
}

export function createShellRunner(opts: ShellRunnerOptions): ShellRunner {
  const srcEnv = opts.sourceEnv ?? process.env;
  const psPath = opts.powershellPath ?? resolvePowerShellPath(srcEnv);
  const taskkill = resolveTaskkillPath(srcEnv);
  if (!opts.powershellPath && !existsSync(psPath)) throw new Error(`Windows PowerShell not found at ${psPath}`);

  const killTree = (child: ChildProcess): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      const k = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  return {
    run(run: ShellRunOptions): Promise<ShellRunResult> {
      const cfg = opts.getShellConfig();
      const tmpDir = join(opts.workspaceDir, ".tmp");
      const outDir = join(opts.workspaceDir, "shell-output");
      mkdirSync(tmpDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const outputFile = join(outDir, safeFileName(run.key));
      const cap = Math.max(cfg.maxOutputBytes, cfg.returnBytes);
      const tailBytes = cfg.returnBytes - Math.floor(cfg.returnBytes / 2);
      const collector = new OutputCollector(cap, tailBytes);

      return new Promise<ShellRunResult>((resolve, reject) => {
        const started = Date.now();
        let child: ChildProcess;
        try {
          child = spawn(
            psPath,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-OutputFormat", "Text", "-EncodedCommand", encodeCommand(run.command)],
            { cwd: opts.workspaceDir, env: buildShellEnv(opts.workspaceDir, srcEnv), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (e) {
          reject(e);
          return;
        }

        let timedOut = false;
        let aborted = false;
        let settled = false;
        let exitCode: number | null | undefined;
        let openStreams = 2;
        let graceTimer: NodeJS.Timeout | undefined;

        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          run.signal?.removeEventListener("abort", onAbort);
          const stored = collector.storedBuffer();
          try {
            writeFileSync(outputFile, stored);
          } catch {
            /* the result is still returned; the audit has the hash */
          }
          const composed = composeOutput(collector, cfg.returnBytes, collector.storedBytes);
          resolve({
            exitCode: timedOut || aborted ? null : (exitCode ?? null),
            durationMs: Date.now() - started,
            timedOut,
            aborted,
            output: composed.text,
            totalBytes: collector.total,
            storedBytes: collector.storedBytes,
            truncatedBytes: composed.truncatedBytes,
            sha256: collector.digest(),
            outputFile,
            pid: child.pid,
          });
        };

        const streamDone = (): void => {
          openStreams--;
          if (openStreams <= 0 && exitCode !== undefined) finish();
        };

        child.stdout?.on("data", (d: Buffer) => collector.add("stdout", d));
        child.stderr?.on("data", (d: Buffer) => collector.add("stderr", d));
        child.stdout?.on("close", streamDone);
        child.stderr?.on("close", streamDone);
        child.on("error", (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          run.signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
        child.on("exit", (code) => {
          exitCode = code;
          if (openStreams <= 0) finish();
          else graceTimer = setTimeout(finish, 2000); // a stray grandchild holding a pipe must not hang the tool
        });

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, run.timeoutSec * 1000);

        function onAbort(): void {
          aborted = true;
          killTree(child);
        }
        if (run.signal) {
          if (run.signal.aborted) onAbort();
          else run.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}
