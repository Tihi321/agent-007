/** Fixtures for the Phase 4 bot tests (S20). Not a test file. */
import { splitConfig } from "../../src/settings/split.js";
import { validateSecurityDoc } from "../../src/settings/schema.js";
import { MAIN_DEFAULT_TOOLS } from "../../src/bots/schema.js";
import { ENV, allFs, phase2Config } from "../settings/helpers.js";

export const NOTES = "C:\\Users\\main\\notes";
export const SAFE = "C:\\Users\\main\\notes\\cloud-safe";
export const DENIED = "C:\\Users\\main\\notes\\Pixotope";

/** A migrated Phase 2 security document with both runners, so presets for LM Studio and Strata exist. */
export function baseSecurity(): Record<string, any> {
  const cfg = phase2Config(NOTES) as Record<string, any>;
  cfg["model"].runners.strata = { baseUrl: "http://127.0.0.1:8080/v1", modelId: "strata-model", contextWindow: 122880, maxTokens: 4096, installDir: "D:\\Strata", dataDir: "D:\\Strata-data", configFile: "C:\\ProgramData\\agent-007\\strata\\strata.json", logDir: "C:\\ProgramData\\agent-007\\logs" };
  return splitConfig(cfg, "C:\\ProgramData\\agent-007\\settings").security as Record<string, any>;
}

export const ACP_CODEX = { id: "codex", kind: "acp", baseUrl: "http://127.0.0.1:8787/v1", providerId: "codex", apiKeyRef: "proxyApiKey", modelId: "codex/gpt", contextWindow: 100000, maxTokens: 4096, label: "Codex", privacy: "cloud" };
export const ACP_CLAUDE = { ...ACP_CODEX, id: "claude", providerId: "claude", modelId: "claude/sonnet", label: "Claude" };
export const ACP_ANTI = { ...ACP_CODEX, id: "anti", providerId: "antigravity", modelId: "antigravity/x", label: "Antigravity" };

export const READ_ONLY_TOOLS = ["tool_search", "system_facts", "list_dir", "read_file", "search_files", "ask_user"];

export function bot(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    description: "a bot",
    telegramTokenRef: "main",
    route: { primary: "lmstudio", allowed: ["lmstudio"], fallback: [], onAuthRequired: "fallback" },
    tools: [...MAIN_DEFAULT_TOOLS],
    readRoots: [{ alias: "notes", path: NOTES }],
    cloudSafeRoots: [],
    shared: { read: false },
    edges: [],
    ...over,
  };
}

/** A research bot: read-only tools, its own token. */
export function research(over: Record<string, unknown> = {}): Record<string, any> {
  return bot({ telegramTokenRef: "research", tools: [...READ_ONLY_TOOLS], ...over });
}

export function withBots(bots: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, any> {
  return { ...baseSecurity(), bots, ...extra };
}

export function check(doc: unknown): { ok: boolean; issues: string[]; warnings: string[] } {
  return validateSecurityDoc(doc, { env: ENV, fs: allFs });
}

export function mutate<T extends Record<string, any>>(base: T, fn: (d: any) => void): T {
  const d = structuredClone(base);
  fn(d);
  return d;
}
