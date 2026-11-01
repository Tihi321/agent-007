/**
 * Secrets (S1.3). `secrets.json` is read into memory only: never copied to `process.env`, never logged.
 * At start the file's ACL is checked with a fixed `icacls` command and a start is refused if `Everyone`,
 * `Users`, `Authenticated Users` or `BUILTIN\Users` has any access.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerName } from "./schema.js";

export interface Secrets {
  telegramBotToken: string;
  /** Required only when `model.runner` is `lmstudio`. */
  lmStudioApiToken?: string;
  /** Optional, used when `model.runner` is `strata` (recommended default for 24/7). */
  strataApiKey?: string;
  /**
   * Phase 2 (S9.4): the 32-byte (base64url) key shared with the job runner (I16). The same value is in the job runner's
   * own secrets file. Required only by the code that talks to the job runner.
   */
  ipcHmacKey?: string;
  /** Phase 2, optional (UI-18): bearer tokens for MCP servers that need one, by server id (for example book-translator). */
  mcpTokens?: Record<string, string>;
  /**
   * Phase 4 (S20.5): one Telegram token per extra bot, by the bot's `telegramTokenRef` (a bot id). `main` uses `telegramBotToken`
   * unless `botTokens.main` is set. A runtime is given only its own token.
   */
  botTokens?: Record<string, string>;
  /** Phase 4 (S24): the write-only mirror bot's token (the bot room). Optional. */
  mirrorBotToken?: string;
  /** Phase 4 (S23.1): the api-acp-proxy key, copied by the user. Never a paid API key. Optional. */
  proxyApiKey?: string;
}

/** The token a bot's `telegramTokenRef` names, or undefined. `main` falls back to the Phase 1 `telegramBotToken`. */
export function botTokenFor(s: Pick<Secrets, "telegramBotToken" | "botTokens">, ref: string): string | undefined {
  const own = s.botTokens && Object.prototype.hasOwnProperty.call(s.botTokens, ref) ? s.botTokens[ref] : undefined;
  if (own) return own;
  return ref === "main" ? s.telegramBotToken : undefined;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

/** Secret values for the redactor. Never log the result. */
export function secretValues(s: Secrets): string[] {
  return [s.telegramBotToken, s.lmStudioApiToken, s.strataApiKey, s.ipcHmacKey, s.mirrorBotToken, s.proxyApiKey, ...Object.values(s.mcpTokens ?? {}), ...Object.values(s.botTokens ?? {})].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/** Parses and validates the JSON text. Error messages never echo file content. */
export function parseSecrets(text: string): Secrets {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SecretsError("secrets file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SecretsError("secrets file must be a JSON object");
  const o = raw as Record<string, unknown>;
  const token = o["telegramBotToken"];
  if (typeof token !== "string" || token.trim() === "") throw new SecretsError("secrets: telegramBotToken is required");
  const out: Secrets = { telegramBotToken: token };
  for (const key of ["lmStudioApiToken", "strataApiKey"] as const) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new SecretsError(`secrets: ${key} must be a string`);
    if (v !== "") out[key] = v;
  }
  const ipc = o["ipcHmacKey"];
  if (ipc !== undefined && ipc !== "") {
    if (typeof ipc !== "string") throw new SecretsError("secrets: ipcHmacKey must be a string");
    if (!IPC_KEY_PATTERN.test(ipc)) throw new SecretsError("secrets: ipcHmacKey must be a base64url string of at least 32 bytes (43 characters)");
    out.ipcHmacKey = ipc;
  }
  const tokens = o["mcpTokens"];
  if (tokens !== undefined) {
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) throw new SecretsError("secrets: mcpTokens must be an object of server id to token");
    const map: Record<string, string> = {};
    for (const [id, tok] of Object.entries(tokens as Record<string, unknown>)) {
      if (typeof tok !== "string") throw new SecretsError(`secrets: mcpTokens.${id} must be a string`);
      if (tok !== "") map[id] = tok;
    }
    if (Object.keys(map).length > 0) out.mcpTokens = map;
  }
  const botTokens = o["botTokens"];
  if (botTokens !== undefined) {
    if (typeof botTokens !== "object" || botTokens === null || Array.isArray(botTokens)) throw new SecretsError("secrets: botTokens must be an object of bot token reference to token");
    const map: Record<string, string> = {};
    for (const [ref, tok] of Object.entries(botTokens as Record<string, unknown>)) {
      if (!BOT_REF_PATTERN.test(ref)) throw new SecretsError("secrets: botTokens has a key that is not a bot id (2 to 24 of a-z, 0-9, -)");
      if (typeof tok !== "string") throw new SecretsError("secrets: a botTokens value must be a string");
      if (tok !== "") map[ref] = tok;
    }
    if (Object.keys(map).length > 0) out.botTokens = map;
  }
  for (const key of ["mirrorBotToken", "proxyApiKey"] as const) {
    const v = o[key];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string") throw new SecretsError(`secrets: ${key} must be a string`);
    out[key] = v;
  }
  return out;
}

const BOT_REF_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;

/** 32 bytes or more, base64url without padding: at least 43 characters. */
export const IPC_KEY_PATTERN = /^[A-Za-z0-9_-]{43,}$/;

// ---- icacls --------------------------------------------------------------------------------

export interface AclEntry {
  principal: string;
  /** The tokens inside parentheses, for example ["I", "F"] or ["DENY", "R"]. */
  flags: string[];
  deny: boolean;
}

/** Parses `icacls <file>` output. `filePath` is stripped from the first line. */
export function parseIcacls(output: string, filePath: string): AclEntry[] {
  const entries: AclEntry[] = [];
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line === "") continue;
    if (/^Successfully processed|^Failed processing/i.test(line)) continue;
    if (line.toLowerCase().startsWith(filePath.toLowerCase())) line = line.slice(filePath.length).trim();
    const m = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (!m) continue;
    const principal = (m[1] ?? "").trim();
    const flags = [...(m[2] ?? "").matchAll(/\(([^)]*)\)/g)].map((x) => (x[1] ?? "").trim());
    entries.push({ principal, flags, deny: flags.some((f) => f.toUpperCase() === "DENY") });
  }
  return entries;
}

const FORBIDDEN_NAMES = new Set(["everyone", "users", "authenticated users"]);
const FORBIDDEN_SIDS = new Set(["*s-1-1-0", "*s-1-5-11", "*s-1-5-32-545"]);

export function isForbiddenPrincipal(principal: string): boolean {
  const p = principal.trim().toLowerCase();
  if (FORBIDDEN_SIDS.has(p)) return true;
  const last = p.split("\\").pop() ?? p;
  return FORBIDDEN_NAMES.has(last);
}

/** Returns the principals that have (non-deny) access but must not. Empty = the ACL is acceptable. */
export function aclViolations(entries: AclEntry[]): string[] {
  const bad = entries.filter((e) => !e.deny && isForbiddenPrincipal(e.principal)).map((e) => e.principal);
  return [...new Set(bad)];
}

export type IcaclsRunner = (filePath: string) => string;

/** The fixed command: `icacls.exe <file>` by absolute path. */
export const runIcacls: IcaclsRunner = (filePath) => {
  const exe = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  return execFileSync(exe, [filePath], { encoding: "utf8", windowsHide: true });
};

/** Throws `SecretsError` if the file's ACL gives `Everyone`/`Users`/`Authenticated Users` any access. */
export function assertAclSafe(filePath: string, run: IcaclsRunner = runIcacls, label = "secrets file"): void {
  let out: string;
  try {
    out = run(filePath);
  } catch (e) {
    throw new SecretsError(`cannot check the ACL of the ${label} (${filePath}): ${(e as Error).message}`);
  }
  const entries = parseIcacls(out, filePath);
  if (entries.length === 0) throw new SecretsError(`icacls returned no ACL entries for the ${label} (${filePath}); refusing to start`);
  const bad = aclViolations(entries);
  if (bad.length > 0) throw new SecretsError(`the ${label} (${filePath}) is accessible to ${bad.join(", ")}; refusing to start`);
}

export interface LoadSecretsOptions {
  secretsPath: string;
  runner: RunnerName;
  /** The Strata config copy; its ACL is also checked when `runner` is `strata` and a key is set. */
  strataConfigFile?: string;
  icacls?: IcaclsRunner;
  /** Test seam; default reads the file. */
  readFile?: (path: string) => string;
  /** Set false to skip the ACL checks (only for dev runs with the dev secrets file; never in production). */
  checkAcl?: boolean;
}

export interface LoadedSecrets {
  secrets: Secrets;
  warnings: string[];
}

export function loadSecrets(opts: LoadSecretsOptions): LoadedSecrets {
  const warnings: string[] = [];
  const run = opts.icacls ?? runIcacls;
  const check = opts.checkAcl ?? true;
  if (check) assertAclSafe(opts.secretsPath, run, "secrets file");
  const text = (opts.readFile ?? ((p: string) => readFileSync(p, "utf8")))(opts.secretsPath);
  const secrets = parseSecrets(text);
  if (opts.runner === "lmstudio" && !secrets.lmStudioApiToken) {
    throw new SecretsError("runner is lmstudio but secrets has no lmStudioApiToken");
  }
  if (opts.runner === "strata") {
    if (!secrets.strataApiKey) warnings.push("Strata without an API key: any local process can use the model");
    else if (check && opts.strataConfigFile) assertAclSafe(opts.strataConfigFile, run, "Strata config copy");
  }
  return { secrets, warnings };
}
