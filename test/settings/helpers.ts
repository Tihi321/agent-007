/**
 * Fixtures for the Phase 3 settings tests (S17): Phase 1, Phase 2 and Strata config shapes, temp folders, fake audit writers.
 * Not a test file.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FsProbe } from "../../src/config/validate.js";
import { SettingsError } from "../../src/settings/contracts.js";
import type { AuditEntryInput, AuditLine, SettingsAudit } from "../../src/settings/contracts.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function tempDir(prefix = "a7-set-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const allFs: FsProbe = { exists: () => true, isDirectory: () => true };

export const ENV = { localAppData: "C:\\Users\\agent007\\AppData\\Local", programData: "C:\\ProgramData", mainUserProfile: "C:\\Users\\main" };

/** A Phase 1 `config.json` (LM Studio). `folder` is an existing folder for the allowlist. */
export function phase1Config(folder: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    telegram: { allowedUserIds: [4242] },
    model: {
      runner: "lmstudio",
      runners: { lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", modelId: "fake-model", contextWindow: 8192, maxTokens: 512 } },
      streamTimeoutMs: 20_000,
      retry: { enabled: true, maxRetries: 5, baseDelayMs: 10, maxAgentDelayMs: 100 },
    },
    folders: { allow: [{ alias: "notes", path: folder }], deny: [] },
    shell: { enabled: true, approvalTimeoutSec: 600 },
    paths: { programDataDir: "C:\\ProgramData\\agent-007", dataDir: "C:\\Users\\agent007\\AppData\\Local\\agent-007" },
    mainUserProfile: "C:\\Users\\main",
    ...over,
  };
}

/** A Phase 2 config: MCP servers (with macros), jobs, flow, second opinion off. */
export function phase2Config(folder: string): Record<string, unknown> {
  return phase1Config(folder, {
    _comment: "kept in config.json",
    mcp: {
      servers: [
        { id: "vibetts", url: "http://127.0.0.1:7101/mcp", allowTools: ["speak"], macros: ["tts_line"] },
        { id: "flow-music-mcp", url: "http://127.0.0.1:7102/mcp", allowTools: ["make_music"], macros: [] },
      ],
      callTimeoutSec: 300,
    },
    jobs: { ipcPort: 47007, approvalTimeoutSec: 1800, progressIntervalSec: 30 },
    flow: { serverId: "flow-music-mcp" },
    secondOpinion: { enabled: false, baseUrl: "http://127.0.0.1:8787/v1", modelId: "" },
  });
}

export function strataConfig(folder: string): Record<string, unknown> {
  return phase1Config(folder, {
    model: {
      runner: "strata",
      runners: {
        strata: {
          baseUrl: "http://127.0.0.1:8080/v1",
          modelId: "qwen3.8-flash-next-iq3_s",
          contextWindow: 122880,
          maxTokens: 4096,
          installDir: "D:\\Strata",
          dataDir: "D:\\Strata-data",
          configFile: "C:\\ProgramData\\agent-007\\strata\\strata.json",
          logDir: "C:\\ProgramData\\agent-007\\logs",
        },
      },
    },
  });
}

export interface CapturingAudit extends SettingsAudit {
  lines: AuditLine[];
}

/** An in-memory audit: keeps the lines, never touches disk. `failNext` makes the next append throw. */
export function capturingAudit(): CapturingAudit & { failNext(): void } {
  const lines: AuditLine[] = [];
  let fail = false;
  return {
    lines,
    failNext: () => {
      fail = true;
    },
    append(e: AuditEntryInput): AuditLine {
      if (fail) {
        fail = false;
        throw new SettingsError("audit_failed", "audit down");
      }
      const line = { v: 1 as const, ts: new Date(0).toISOString(), writer: "agent" as const, wseq: lines.length + 1, prev: "0", h: String(lines.length), ...e };
      lines.push(line);
      return line;
    },
  };
}

export function writeJson(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A valid persona draft (all lists explicit). */
export function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "research",
    name: "Research",
    description: "Look things up.",
    prompt: "You research topics and answer with sources.",
    toolAllow: ["tool_search", "read_file"],
    mcpAllow: {},
    jobTemplates: [],
    modelPreset: "lmstudio",
    memory: { write: "scope", scope: "research", sharedRead: true },
    budgets: {},
    ...over,
  };
}
