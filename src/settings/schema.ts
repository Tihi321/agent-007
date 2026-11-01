/**
 * The schemas of the Phase 3 documents (S17.1): `config.json` v2 (bootstrap), `security.json` and `prefs.json`, as
 * descriptors of the `jsonschema.ts` subset. The settings UI renders its forms from the SAME descriptors (S18.2).
 *
 * `validateSecurityDoc` is what every writer and the loader run: the schema (unknown key = error), then the Phase 1/2
 * structural parser (`parseConfig`) and semantic refusals (`validateConfig`: non-loopback URL, empty allowlist, duplicate
 * alias, a missing folder, an unknown runner, a missing runner block), then the preset cross-checks.
 *
 * Pure subset: no adapter import (`config/schema.ts` has a type-only import of the adapter, erased at build).
 */
import { ConfigError, defaultsFromEnv, parseConfig } from "../config/schema.js";
import type { DefaultsEnv } from "../config/schema.js";
import { validateConfig } from "../config/validate.js";
import type { FsProbe } from "../config/validate.js";
import { validate } from "./jsonschema.js";
import type { Schema, SchemaIssue } from "./jsonschema.js";
import { mergeConfig } from "./split.js";
import {
  ACP_PROVIDERS,
  BOT_ID_PATTERN,
  DEFAULT_BOT_BUS,
  DEFAULT_BOT_ROOM,
  DEFAULT_GATE,
  ON_AUTH_REQUIRED,
  PRESET_ID_PATTERN,
  PRESET_KINDS,
  PRIVACY_CLASSES,
  botsPreRefusals,
  validateBotsDoc,
} from "../bots/schema.js";

// ---- tiny constructors ------------------------------------------------------------------------------------------

const str = (ui: Schema["x-ui"] = {}, more: Partial<Schema> = {}): Schema => ({ type: "string", minLength: 1, maxLength: 500, "x-ui": { widget: "text", ...ui }, ...more });
const int = (min: number, max: number, def: number, ui: Schema["x-ui"] = {}): Schema => ({ type: "integer", minimum: min, maximum: max, default: def, "x-ui": { widget: "number", ...ui } });
const bool = (def: boolean, ui: Schema["x-ui"] = {}): Schema => ({ type: "boolean", default: def, "x-ui": { widget: "toggle", ...ui } });
const obj = (properties: Record<string, Schema>, required: string[] = [], ui: Schema["x-ui"] = {}): Schema => ({ type: "object", properties, required, additionalProperties: false, "x-ui": ui });
const list = (items: Schema, ui: Schema["x-ui"] = {}, more: Partial<Schema> = {}): Schema => ({ type: "array", items, "x-ui": { widget: "list", ...ui }, ...more });
const pathStr = (ui: Schema["x-ui"] = {}): Schema => str({ widget: "path", ...ui }, { maxLength: 400 });
const urlStr = (ui: Schema["x-ui"] = {}): Schema => str({ widget: "url", ...ui }, { maxLength: 300 });

export const RUNNER_ENUM = ["lmstudio", "strata"] as const;
const compat = obj(
  {
    supportsStore: bool(false, { label: "Supports store" }),
    supportsDeveloperRole: bool(false, { label: "Supports developer role" }),
    supportsReasoningEffort: bool(false, { label: "Supports reasoning effort" }),
    supportsUsageInStreaming: bool(true, { label: "Usage in streaming" }),
    requiresToolResultName: bool(false, { label: "Tool result needs a name" }),
    maxTokensField: { type: "string", enum: ["max_tokens", "max_completion_tokens"], "x-ui": { widget: "select", label: "Max tokens field" } },
  },
  [],
  { label: "Compatibility flags", group: "advanced" },
);
const runnerProps: Record<string, Schema> = {
  baseUrl: urlStr({ label: "Base URL", help: "Must be on 127.0.0.1 or localhost.", placeholder: "http://127.0.0.1:1234/v1" }),
  modelId: str({ label: "Model id" }),
  contextWindow: int(1024, 4_000_000, 65536, { label: "Context window (tokens)" }),
  maxTokens: int(16, 200_000, 4096, { label: "Max output tokens" }),
  compat,
};

const rootRow = (label: string): Schema =>
  list(obj({ alias: str({ label: "Alias" }, { pattern: "^[A-Za-z0-9_-]{1,32}$", maxLength: 32 }), path: pathStr({ label: "Folder path" }) }, ["alias", "path"], { titleKey: "alias" }), { label, titleKey: "alias" }, { maxItems: 50 });
const presetIdStr = (label: string): Schema => str({ label }, { pattern: PRESET_ID_PATTERN.source });

/** One bot (S20.1, I30). */
const BOT_SCHEMA: Schema = obj(
  {
    description: { type: "string", maxLength: 200, "x-ui": { widget: "text", label: "Description" } },
    telegramTokenRef: str({ label: "Token reference", help: "The key in secrets.json botTokens that holds this bot's token (main also accepts telegramBotToken). One token per bot." }, { pattern: BOT_ID_PATTERN.source }),
    route: obj(
      {
        primary: presetIdStr("Primary preset"),
        allowed: list(presetIdStr("Preset"), { label: "Presets the bot may switch to", widget: "tags" }, { minItems: 1, maxItems: 12 }),
        fallback: list(presetIdStr("Preset"), { label: "Fallback presets", widget: "tags" }, { maxItems: 12 }),
        onAuthRequired: { type: "string", enum: [...ON_AUTH_REQUIRED], default: "fallback", "x-ui": { widget: "select", label: "When a login is needed" } },
      },
      ["primary", "allowed"],
      { label: "Model route" },
    ),
    tools: list(str({ label: "Tool" }, { maxLength: 100 }), { label: "Tool allowlist", help: "An allowlist only narrows what the code offers. At most one bot may have shell.", widget: "tags" }, { maxItems: 100 }),
    readRoots: rootRow("Read folders (inside the global allowlist)"),
    cloudSafeRoots: rootRow("Cloud-safe read folders (used while the bot can use a cloud preset)"),
    shared: obj({ read: bool(false, { label: "Read the shared facts and skills" }) }, [], { label: "Shared" }),
    edges: list(
      obj(
        {
          to: str({ label: "May ask bot" }, { pattern: BOT_ID_PATTERN.source }),
          allow: list(str({ label: "Tool" }, { maxLength: 100 }), { label: "Tools the other bot may use for this bot", widget: "tags" }, { maxItems: 50 }),
          egress: bool(false, { label: "Private-folder files may go to a cloud bot" }),
        },
        ["to"],
        { titleKey: "to" },
      ),
      { label: "Edges (who this bot may ask)", titleKey: "to" },
      { maxItems: 8 },
    ),
    approvalTimeoutSec: int(10, 86_400, 600, { label: "Approval timeout (s)" }),
    relax: obj(
      {
        privateRoots: bool(false, { label: "A cloud-capable bot may read its normal (private) folders", help: "UI-25. Off: it reads only the cloud-safe folders." }),
        privilegedTools: bool(false, { label: "A cloud-capable bot may have shell or dispatch_job", help: "UI-25. Off: refused." }),
      },
      [],
      { label: "Relax the cloud defaults", group: "advanced" },
    ),
  },
  ["telegramTokenRef", "route", "tools"],
  { titleKey: "description" },
);

export const SECURITY_SCHEMA: Schema = obj(
  {
    schemaVersion: { type: "integer", enum: [1], "x-ui": { widget: "readonly" } },
    telegram: obj(
      {
        allowedUserIds: list({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { label: "Allowed Telegram user ids", help: "Numeric ids. Only these accounts can talk to the agent or approve anything." }, { minItems: 1, maxItems: 20 }),
      },
      ["allowedUserIds"],
      { label: "Telegram access", group: "access" },
    ),
    model: obj(
      {
        runner: { type: "string", enum: [...RUNNER_ENUM], "x-ui": { widget: "select", label: "Active runner", help: "Changes take effect after the agent restarts." } },
        runners: obj(
          {
            lmstudio: obj(runnerProps, []),
            strata: obj({ ...runnerProps, installDir: pathStr({ label: "Install folder" }), dataDir: pathStr({ label: "Model data folder" }), configFile: pathStr({ label: "Config copy" }), logDir: pathStr({ label: "Log folder" }) }, []),
          },
          [],
          { label: "Runner endpoints" },
        ),
        streamTimeoutMs: int(1000, 3_600_000, 600_000, { label: "Stream timeout (ms)" }),
        retry: obj(
          {
            enabled: bool(true, { label: "Retry while the runner is down" }),
            maxRetries: int(0, 1000, 50, { label: "Max retries" }),
            baseDelayMs: int(0, 600_000, 2000, { label: "Base delay (ms)" }),
            maxAgentDelayMs: int(0, 3_600_000, 60_000, { label: "Max delay (ms)" }),
          },
          [],
          { label: "Retry", group: "advanced" },
        ),
        defaultPreset: str({ label: "Default model preset", help: "One of the presets below." }, { pattern: "^[a-z][a-z0-9-]{0,23}$" }),
      },
      ["runner"],
      { label: "Model runners", group: "model" },
    ),
    presets: list(
      obj(
        {
          id: str({ label: "Preset id" }, { pattern: "^[a-z][a-z0-9-]{0,23}$" }),
          kind: { type: "string", enum: [...PRESET_KINDS], default: "local", "x-ui": { widget: "select", label: "Kind", help: "local = a runner on this PC; acp = the api-acp-proxy on 127.0.0.1 (Phase 4). A per-token-billed API key is not a kind." } },
          runner: { type: "string", enum: [...RUNNER_ENUM], "x-ui": { widget: "select", label: "Runner", help: "local presets only." } },
          baseUrl: urlStr({ label: "Proxy URL", help: "acp presets only: http://127.0.0.1:<port>/v1 (loopback)." }),
          providerId: { type: "string", enum: [...ACP_PROVIDERS], "x-ui": { widget: "select", label: "Proxy provider", help: "acp presets only. claude and antigravity need the terms acknowledgment." } },
          apiKeyRef: { type: "string", enum: ["proxyApiKey"], "x-ui": { widget: "select", label: "Key reference", help: "acp presets only: the proxy key in secrets.json." } },
          modelId: str({ label: "Model id" }),
          contextWindow: int(1024, 4_000_000, 65536, { label: "Context window" }),
          maxTokens: int(16, 200_000, 4096, { label: "Max output tokens" }),
          label: str({ label: "Label" }, { maxLength: 60 }),
          privacy: { type: "string", enum: [...PRIVACY_CLASSES], "x-ui": { widget: "select", label: "Privacy class", help: "local presets are local; acp presets send tool output to a vendor (cloud). Default by kind." } },
          autoFallback: bool(false, { label: "May be an automatic fallback", help: "Default: on for local presets, off for acp presets." }),
          billing: { type: "string", enum: ["subscription", "paid"], "x-ui": { widget: "select", label: "Billing", help: "acp presets only. paid = billed per use (DeepSeek API, Anthropic API credits, Gemini): usable only by web bots the owner enabled with a daily and monthly cap (I58)." } },
        },
        ["id", "kind", "modelId", "contextWindow", "maxTokens", "label"],
        { titleKey: "label" },
      ),
      { label: "Model presets", help: "A persona can only pick one of these.", titleKey: "label", group: "model" },
      { maxItems: 12 },
    ),
    folders: obj(
      {
        allow: list(
          obj({ alias: str({ label: "Alias" }, { pattern: "^[A-Za-z0-9_-]{1,32}$", maxLength: 32 }), path: pathStr({ label: "Folder path" }) }, ["alias", "path"], { titleKey: "alias" }),
          { label: "Allowed folders", help: "The agent may read, list and search these. NTFS read rights for a new folder are not granted here: run deploy\\grant-folder-acls.ps1.", titleKey: "alias" },
          { minItems: 1, maxItems: 50 },
        ),
        deny: list(pathStr({ label: "Path" }), { label: "Denied paths", help: "Always refused, even inside an allowed folder. Also copied into the next Claude job's deny rules." }, { maxItems: 100 }),
      },
      ["allow"],
      { label: "Folders", group: "access" },
    ),
    shell: obj(
      {
        enabled: bool(true, { label: "Shell tool enabled", help: "Every command still needs your approval in Telegram." }),
        approvalTimeoutSec: int(10, 86_400, 600, { label: "Approval timeout (s)" }),
        execTimeoutSec: int(5, 3600, 120, { label: "Default run time limit (s)" }),
        maxExecTimeoutSec: int(5, 3600, 600, { label: "Maximum run time limit (s)" }),
        maxOutputBytes: int(1024, 16_777_216, 65536, { label: "Max output (bytes)" }),
        returnBytes: int(256, 1_048_576, 8192, { label: "Returned to the model (bytes)" }),
      },
      [],
      { label: "Shell", group: "access" },
    ),
    limits: obj(
      {
        readFileBytes: int(1024, 16_777_216, 32768, { label: "Read file limit (bytes)" }),
        searchMaxFiles: int(1, 1_000_000, 5000, { label: "Search: max files" }),
        listMaxEntries: int(1, 100_000, 500, { label: "List: max entries" }),
        searchMaxResults: int(1, 10_000, 200, { label: "Search: max results" }),
      },
      [],
      { label: "Tool limits", group: "access" },
    ),
    mcp: obj(
      {
        servers: list(
          obj(
            {
              id: str({ label: "Server id" }, { pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?=[A-Za-z0-9-])){0,31}$", maxLength: 32 }),
              url: urlStr({ label: "URL", help: "http://127.0.0.1:<port>/mcp (loopback only)." }),
              allowTools: list(str({ label: "Tool" }, { maxLength: 100 }), { label: "Allowed tools", widget: "tags" }, { maxItems: 200 }),
              macros: list(str({ label: "Macro" }, { maxLength: 60 }), { label: "Enabled macros", widget: "tags" }, { maxItems: 20 }),
              callTimeoutSec: int(1, 86_400, 300, { label: "Call timeout (s)" }),
            },
            ["id", "url", "allowTools", "macros"],
            { titleKey: "id" },
          ),
          { label: "creative-hub MCP servers", titleKey: "id" },
          { maxItems: 30 },
        ),
        callTimeoutSec: int(1, 86_400, 300, { label: "Default call timeout (s)" }),
      },
      [],
      { label: "MCP servers", group: "jobs" },
    ),
    jobs: obj(
      {
        ipcPort: int(1024, 65_535, 47007, { label: "Job runner port", help: "Loopback port of the job runner. Must match jobrunner.json." }),
        approvalTimeoutSec: int(10, 86_400, 1800, { label: "Job approval timeout (s)" }),
        progressIntervalSec: int(1, 3600, 30, { label: "Progress update interval (s)" }),
      },
      [],
      { label: "Jobs (agent side)", group: "jobs" },
    ),
    flow: obj({ serverId: str({ label: "Flow server id" }, { maxLength: 32 }) }, [], { label: "Flow", group: "jobs" }),
    secondOpinion: obj(
      { enabled: bool(false, { label: "Second opinion endpoint", help: "Not built; stays off." }), baseUrl: urlStr({ label: "Base URL" }), modelId: { type: "string", maxLength: 200, "x-ui": { widget: "text", label: "Model id" } } },
      [],
      { label: "Second opinion", group: "advanced" },
    ),
    // Phase 2 placeholder block: nothing to configure (the always-loaded tool list is a code constant, I27). Kept so the example config migrates.
    tools: obj({}, [], { label: "Tools (no settings)", group: "advanced" }),
    budgets: obj({ maxJobsPerDay: int(0, 10_000, 20, { label: "Jobs per day (ceiling for personas)" }) }, [], { label: "Budgets", group: "jobs" }),
    proposals: obj(
      {
        timeoutSec: int(60, 86_400, 600, { label: "Proposal card timeout (s)" }),
        maxPending: int(1, 5, 1, { label: "Pending proposals per chat" }),
        perHour: int(1, 60, 5, { label: "Proposals per hour" }),
        autoApplyCosmetic: bool(false, { label: "Auto-apply tone and verbosity", help: "When on, the model may change tone and verbosity (fixed choices only) with no card. Every change is still audited." }),
      },
      [],
      { label: "Model proposals", group: "proposals" },
    ),
    // ---- Phase 4 (S20): bots, terms, bus limits, bot room, gate ----
    bots: { type: "object", additionalProperties: BOT_SCHEMA, "x-ui": { label: "Bots", help: "Each bot has its own Telegram token, memory, route and tools. The bot main is the existing agent. Edited only in the settings UI.", group: "bots" } },
    termsAccepted: obj(
      {
        claude: bool(false, { label: "I accept the risk of using Claude through the proxy", help: "Claude's consumer terms may forbid this; the account could be blocked. Set only here." }),
        antigravity: bool(false, { label: "I accept the risk of using Antigravity through the proxy", help: "Google's terms may forbid this; the account could be suspended. Set only here." }),
      },
      [],
      { label: "Terms acknowledgments", group: "bots" },
    ),
    botBus: obj(
      {
        hopLimit: int(1, 3, DEFAULT_BOT_BUS.hopLimit, { label: "Hop limit" }),
        chainMaxMessages: int(2, 50, DEFAULT_BOT_BUS.chainMaxMessages, { label: "Messages per chain" }),
        chainMaxSeconds: int(10, 3600, DEFAULT_BOT_BUS.chainMaxSeconds, { label: "Seconds per chain" }),
        chainMaxTokens: int(1000, 1_000_000, DEFAULT_BOT_BUS.chainMaxTokens, { label: "Tokens per chain" }),
        edgeMinGapSec: int(0, 3600, DEFAULT_BOT_BUS.edgeMinGapSec, { label: "Seconds between asks on one edge" }),
        edgeDailyCap: int(1, 1000, DEFAULT_BOT_BUS.edgeDailyCap, { label: "Asks per edge per day" }),
        breakerAsks: int(2, 1000, DEFAULT_BOT_BUS.breakerAsks, { label: "Circuit breaker: asks" }),
        breakerWindowMin: int(1, 1440, DEFAULT_BOT_BUS.breakerWindowMin, { label: "Circuit breaker: window (min)" }),
        askTimeoutMaxSec: int(1, 120, DEFAULT_BOT_BUS.askTimeoutMaxSec, { label: "Longest ask_bot wait (s)" }),
      },
      [],
      { label: "Bot-to-bot limits", group: "bots" },
    ),
    botRoom: obj(
      {
        mode: { type: "string", enum: ["none", "summary", "truncated"], default: DEFAULT_BOT_ROOM.mode, "x-ui": { widget: "select", label: "Bot room text", help: "none = the room is off." } },
        maxChars: int(20, 4000, DEFAULT_BOT_ROOM.maxChars, { label: "Characters per mirrored line" }),
        maxPerMinute: int(1, 20, DEFAULT_BOT_ROOM.maxPerMinute, { label: "Posts per minute" }),
        chatId: { type: "integer", minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991, "x-ui": { widget: "number", label: "Room chat id" } },
      },
      [],
      { label: "Bot room (mirror)", group: "bots" },
    ),
    gate: obj(
      {
        localBotsOnStrata: int(1, 8, DEFAULT_GATE.localBotsOnStrata, { label: "Bots with Strata as primary (at most)" }),
        maxQueueDepth: int(1, 100, DEFAULT_GATE.maxQueueDepth, { label: "Local queue depth" }),
        stickinessSec: int(0, 600, DEFAULT_GATE.stickinessSec, { label: "Stickiness window (s)" }),
        agingSec: int(1, 3600, DEFAULT_GATE.agingSec, { label: "Aging step (s)" }),
        waitNoticeSec: int(1, 600, DEFAULT_GATE.waitNoticeSec, { label: "Waiting notice after (s)" }),
        proxyMaxConcurrent: int(1, 4, DEFAULT_GATE.proxyMaxConcurrent, { label: "Proxy calls at once (never above 4)" }),
      },
      [],
      { label: "Model gate", group: "bots" },
    ),
  },
  ["schemaVersion", "telegram", "model", "folders"],
  { label: "Security settings" },
);

export const BOOTSTRAP_SCHEMA: Schema = obj(
  {
    schemaVersion: { type: "integer", enum: [2] },
    paths: { type: "object", additionalProperties: { type: "string", maxLength: 400 } },
    mainUserProfile: str({}, { maxLength: 400 }),
    settings: obj({ dir: pathStr() }, ["dir"]),
  },
  ["schemaVersion"],
);

export const STYLE_TONES = ["neutral", "concise", "friendly"] as const;
export const STYLE_VERBOSITY = ["short", "normal", "detailed"] as const;

const baseStyleProps: Record<string, Schema> = {
  tone: { type: "string", enum: [...STYLE_TONES], default: "neutral", "x-ui": { widget: "select", label: "Tone" } },
  verbosity: { type: "string", enum: [...STYLE_VERBOSITY], default: "short", "x-ui": { widget: "select", label: "Verbosity" } },
  language: { type: "string", pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})?$", maxLength: 12, default: "en", "x-ui": { widget: "text", label: "Language tag" } },
  notes: { type: "string", maxLength: 500, default: "", "x-ui": { widget: "textarea", label: "Style notes" } },
};

/** The prefs schema; later phases add root properties (Phase 4's per-bot `activePreset`) through `extra`. */
export function prefsSchemaWith(extra: Record<string, Schema> = {}): Schema {
  return obj(
    {
      style: obj(baseStyleProps, []),
      defaultPersona: { type: "string", pattern: "^[a-z][a-z0-9-]{1,23}$", default: "default", "x-ui": { widget: "text", label: "Default persona" } },
      ...extra,
    },
    [],
  );
}
/** Phase 4 (S20): `bots.<id>.activePreset` lives in prefs (the model may propose it; the row classifies the switch, I38). */
export const BOTS_PREFS_SCHEMA: Schema = {
  type: "object",
  additionalProperties: obj({ activePreset: str({ label: "Active model preset" }, { pattern: PRESET_ID_PATTERN.source }) }, []),
  "x-ui": { hidden: true },
};
export const PREFS_SCHEMA: Schema = prefsSchemaWith({ bots: BOTS_PREFS_SCHEMA });

// ---- validation -------------------------------------------------------------------------------------------------

export interface SecurityValidation {
  ok: boolean;
  /** Human-readable problems; each starts with a dotted path where one applies. */
  issues: string[];
  warnings: string[];
}

export interface ValidateSecurityOptions {
  fs?: FsProbe;
  env?: DefaultsEnv;
  /** Skip the folder-exists check (the job runner cannot see the agent's NTFS view). Default false. */
  skipFolderExists?: boolean;
}

const fmt = (i: SchemaIssue): string => `${i.path}: ${i.message}`;

/**
 * Full validation of a `security.json` document. The runner secrets are never part of it, so the semantic refusals that need
 * a secret (an LM Studio token) are checked against placeholders: that refusal belongs to the agent's secrets loader.
 */
export function validateSecurityDoc(doc: unknown, opts: ValidateSecurityOptions = {}): SecurityValidation {
  const issues: string[] = [...botsPreRefusals(doc), ...validate(SECURITY_SCHEMA, doc).map(fmt)];
  const warnings: string[] = [];
  if (issues.length > 0) return { ok: false, issues, warnings };
  const d = doc as Record<string, unknown>;
  try {
    const legacy = mergeConfig({}, d);
    const config = parseConfig(legacy, opts.env ?? defaultsFromEnv());
    const probe: FsProbe = opts.skipFolderExists ? { exists: () => true, isDirectory: () => true } : (opts.fs ?? { exists: (p) => fsExists(p), isDirectory: (p) => fsIsDir(p) });
    warnings.push(...validateConfig(config, { lmStudioApiToken: "(checked by the agent's secrets loader)", strataApiKey: "(optional)" }, { fs: probe }));
    // Phase 4 (S20.1): bots, presets, terms, gate
    const botCheck = validateBotsDoc(d, { folderAllow: config.folders.allow, folderDeny: config.folders.deny, mcpServerIds: config.mcp.servers.map((s) => s.id), flowServerId: config.flow.serverId });
    issues.push(...botCheck.issues);
    warnings.push(...botCheck.warnings);
  } catch (e) {
    if (e instanceof ConfigError) issues.push(...e.issues);
    else throw e;
  }
  // preset cross-checks
  const model = (d["model"] ?? {}) as Record<string, unknown>;
  const runners = (model["runners"] ?? {}) as Record<string, unknown>;
  const presets = (Array.isArray(d["presets"]) ? d["presets"] : []) as Record<string, unknown>[];
  const ids = new Set<string>();
  presets.forEach((p, i) => {
    const id = String(p["id"]);
    if (ids.has(id)) issues.push(`presets[${i}].id: duplicate preset id "${id}"`);
    ids.add(id);
    if (typeof p["runner"] === "string" && runners[p["runner"]] === undefined) issues.push(`presets[${i}].runner: no runner block for "${String(p["runner"])}"`);
  });
  const dp = model["defaultPreset"];
  if (presets.length > 0 && typeof dp === "string" && !ids.has(dp)) issues.push(`model.defaultPreset: "${dp}" is not one of the presets`);
  if (presets.length > 0 && dp === undefined) issues.push("model.defaultPreset: required when presets are defined");
  return { ok: issues.length === 0, issues, warnings };
}

import { existsSync, statSync } from "node:fs";
function fsExists(p: string): boolean {
  return existsSync(p);
}
function fsIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
