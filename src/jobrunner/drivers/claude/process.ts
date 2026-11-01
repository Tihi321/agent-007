/** Small process helpers for the Claude driver: the event queue, tree kill and the job-scoped mcp-config file. */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PERMISSION_SERVER_NAME } from "./argv.js";

/** A single-consumer async queue that ends after `close()` once drained. */
export class EventChannel<T> {
  private readonly queue: T[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.queue.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  async *iterate(): AsyncGenerator<T, void, undefined> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/**
 * Kills a process and its children. Windows has no clean SIGINT for a child, so it is `taskkill /T /F` (notes 3.1);
 * elsewhere the child leads its own process group (the driver spawns it `detached`) and the group is killed.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.once("error", () => resolve());
      k.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Where the job-scoped mcp-config file goes: `<dataDir>/jobs/<jobId>/mcp.json`. */
export function mcpConfigPathFor(dataDir: string, jobId: string): string {
  return join(dataDir, "jobs", jobId, "mcp.json");
}

export interface McpConfigFile {
  dir: string;
  path: string;
  /** Deletes the file and its folder. Safe to call twice. */
  remove(): Promise<void>;
}

export interface McpConfigInput {
  /** The job runner's main-user-only data folder; the file goes to `<dataDir>/jobs/<jobId>/mcp.json`. */
  dataDir: string;
  jobId: string;
  /** `node`, and the helper script. */
  helperCommand: string;
  helperArgs: readonly string[];
  token: string;
  port: number;
}

/**
 * Writes the job-scoped `--mcp-config` file (S12.3, I28). The token lives only in this file's `env` block for the
 * helper. It is created exclusively (`wx`, mode 0600 where modes exist) and removed when the job ends.
 */
export async function writeMcpConfig(input: McpConfigInput): Promise<McpConfigFile> {
  const path = mcpConfigPathFor(input.dataDir, input.jobId);
  const dir = dirname(path);
  await rm(dir, { recursive: true, force: true }); // a leftover from a crashed run
  await mkdir(dir, { recursive: true });
  const config = {
    mcpServers: {
      [PERMISSION_SERVER_NAME]: {
        type: "stdio",
        command: input.helperCommand,
        args: [...input.helperArgs],
        env: { A7_JOB_ID: input.jobId, A7_JOB_TOKEN: input.token, A7_JOB_PORT: String(input.port) },
      },
    },
  };
  await writeFile(path, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
  let removed = false;
  return {
    dir,
    path,
    async remove() {
      if (removed) return;
      removed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
