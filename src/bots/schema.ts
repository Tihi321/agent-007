/**
 * Phase 4 bot configuration (S20.1, I30, I38, I41, I42, I43): the types of `bots`, `presets` and the Phase 4 settings blocks of
 * `security.json`, and `validateBotsDoc`, the cross-checks the settings loader runs on top of the JSON schema. The schema
 * descriptors themselves live in `src/settings/schema.ts` (one document, one schema, one UI); this file has only constants,
 * types and pure functions, and imports nothing that imports Pi.
 *
 * The loader REFUSES (a `ConfigError` with the dotted path): a bad bot id or no `main`; a duplicate token ref; two bots with
 * `shell`; `shell` or `dispatch_job` on a cloud-capable bot without the UI-25 flag (`relax.privilegedTools`); a `claude` or
 * `antigravity` preset in a route without `termsAccepted`; a per-token-billed (API-key) preset (it is not a `kind`: the schema
 * enum is `local | acp`, and an `apiKeyRef` other than the proxy key is refused too); a non-loopback preset URL; a `readRoots` or
 * `cloudSafeRoots` entry outside the global folder allowlist or overlapping `folders.deny` (in either direction); a `tools` list
 * that names a tool the code does not have (an allowlist only narrows); an edge to a missing bot, to itself, or with an
 * `elevated` key; an edge `allow` that names a tool a peer turn never gets (D12); more local bots on Strata than
 * `gate.localBotsOnStrata` (UI-32).
 *
 * `parseBots` turns a valid document into the resolved form the manager, the registry builder and the path policy use. With no
 * `bots` key (every Phase 1 to 3 install) it returns the one implicit bot `main` that behaves exactly as before.
 *
 * Pure subset.
 */
import { isLoopbackUrl, isSameOrUnder, normalizeWin } from "../config/paths.js";
import { KNOWN_TOOLS } from "../settings/catalog.js";

// ---- constants --------------------------------------------------------------------------------------------------------

export const BOT_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
export const PRESET_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const MAIN_BOT_ID = "main";
export const MAX_BOTS = 8;

/** The two bus tools. Deferred, and registered only for a bot that has at least one edge (I27, I30). */
export const BOT_BUS_TOOLS = ["ask_bot", "list_bots"] as const;
/** Every tool name the code can register: Phases 1 to 3 (`KNOWN_TOOLS`) plus the bus tools. An allowlist is a subset of this. */
export const CODE_TOOL_NAMES: readonly string[] = [...KNOWN_TOOLS, ...BOT_BUS_TOOLS];
/** The tools a bot with a cloud-capable route does not get unless the user relaxes it in the UI (I42, UI-25). */
export const PRIVILEGED_TOOLS = ["shell", "dispatch_job"] as const;
/**
 * Tools a PEER turn never gets, whatever an edge lists (D12, I36): shell, file write, `dispatch_job`, Flow (`hub_start` and the
 * Flow server's tools), `remember`, settings and persona changes, job control. S21's capability rule reuses this list.
 */
export const PEER_FORBIDDEN_TOOLS: readonly string[] = [
  "shell",
  "write_file",
  "dispatch_job",
  "cancel_job",
  "hub_start",
  "remember",
  "propose_setting",
  "propose_persona",
  "switch_persona",
  "ask_second_opinion",
];

export const PRESET_KINDS = ["local", "acp"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];
export const ACP_PROVIDERS = ["codex", "claude", "antigravity"] as const;
export type AcpProvider = (typeof ACP_PROVIDERS)[number];
/** Providers whose terms may forbid the use (I41, UI-24): they need `termsAccepted.<provider>`, which only the UI sets. */
export const TERMS_PROVIDERS = ["claude", "antigravity"] as const;
/** The one key reference an `acp` preset may carry: the proxy key in `secrets.json`. A paid API key is never a brain (D12). */
export const PROXY_KEY_REF = "proxyApiKey";
export const PRIVACY_CLASSES = ["local", "cloud"] as const;
export type Privacy = (typeof PRIVACY_CLASSES)[number];
export const ON_AUTH_REQUIRED = ["fallback", "ask", "fail"] as const;
export type OnAuthRequired = (typeof ON_AUTH_REQUIRED)[number];

/** Aliases a bot's own roots may not use: the code adds these roots itself. */
export const RESERVED_ROOT_ALIASES = ["workspace", "skills", "shared"] as const;

// ---- types ------------------------------------------------------------------------------------------------------------

export interface FolderRoot {
  alias: string;
  path: string;
}

export interface BotEdge {
  to: string;
  /** Tools the receiver may use while serving this asker (it only narrows; never more than D12 allows). */
  allow: string[];
  /** May a file ref of the asker's PRIVATE folders travel on this edge to a cloud bot (I42)? Default false. */
  egress: boolean;
}

export interface BotRoute {
  primary: string;
  allowed: string[];
  fallback: string[];
  onAuthRequired: OnAuthRequired;
}

export interface BotConfig {
  description: string;
  telegramTokenRef: string;
  route: BotRoute;
  tools: string[];
  readRoots: FolderRoot[];
  cloudSafeRoots: FolderRoot[];
  shared: { read: boolean };
  edges: BotEdge[];
  approvalTimeoutSec?: number;
  /** UI-25: the user may relax the cloud defaults per bot, in the settings UI only. */
  relax: { privateRoots: boolean; privilegedTools: boolean };
}

export interface PresetConfig {
  id: string;
  kind: PresetKind;
  label: string;
  /** `local` presets: the runner block of `model.runners`. */
  runner?: string;
  /** `acp` presets: `http://127.0.0.1:<port>/v1`. */
  baseUrl?: string;
  modelId: string;
  providerId?: AcpProvider;
  apiKeyRef?: string;
  contextWindow: number;
  maxTokens: number;
  privacy: Privacy;
  autoFallback: boolean;
}

export interface BotBusLimits {
  hopLimit: number;
  chainMaxMessages: number;
  chainMaxSeconds: number;
  chainMaxTokens: number;
  edgeMinGapSec: number;
  edgeDailyCap: number;
  breakerAsks: number;
  breakerWindowMin: number;
  askTimeoutMaxSec: number;
}
export interface BotRoomSettings {
  mode: "none" | "summary" | "truncated";
  maxChars: number;
  maxPerMinute: number;
  /** The private group or channel the mirror bot posts to; absent = off. */
  chatId?: number;
}
export interface GateSettings {
  localBotsOnStrata: number;
  maxQueueDepth: number;
  stickinessSec: number;
  agingSec: number;
  waitNoticeSec: number;
  proxyMaxConcurrent: number;
}

export const DEFAULT_BOT_BUS: Readonly<BotBusLimits> = {
  hopLimit: 2,
  chainMaxMessages: 6,
  chainMaxSeconds: 300,
  chainMaxTokens: 60_000,
  edgeMinGapSec: 5,
  edgeDailyCap: 30,
  breakerAsks: 10,
  breakerWindowMin: 10,
  askTimeoutMaxSec: 120,
};
export const DEFAULT_BOT_ROOM: Readonly<BotRoomSettings> = { mode: "none", maxChars: 300, maxPerMinute: 15 };
export const DEFAULT_GATE: Readonly<GateSettings> = { localBotsOnStrata: 2, maxQueueDepth: 8, stickinessSec: 15, agingSec: 60, waitNoticeSec: 10, proxyMaxConcurrent: 3 };

export interface TermsAccepted {
  claude: boolean;
  antigravity: boolean;
}

/** What `parseBots` needs besides the document: the Phase 1 to 3 data it falls back on. */
export interface BotsParseContext {
  /** `config.folders.allow` (UI-1). */
  folderAllow: readonly FolderRoot[];
  /** The preset list when `presets` is absent (derived from the runner blocks, as `securityLikeOf` does). */
  derivedPresets: readonly PresetConfig[];
  /** The preset id the Phase 3 install runs on (`model.defaultPreset`, else the runner name). */
  defaultPreset: string;
}

export interface ResolvedBot extends BotConfig {
  id: string;
  /** True for a bot whose route lists any cloud preset (primary, allowed or fallback): the I42 checks treat it as cloud-capable. */
  cloudCapable: boolean;
  /** `legacy`: the implicit `main` of a Phase 1 to 3 install, state under the data root as before. `bots`: `bots\<id>\`. */
  layout: "legacy" | "bots";
}

export interface ResolvedBots {
  /** No `bots` key in `security.json`: the implicit `main`. */
  implicit: boolean;
  bots: ResolvedBot[];
  presets: PresetConfig[];
  termsAccepted: TermsAccepted;
  botBus: BotBusLimits;
  botRoom: BotRoomSettings;
  gate: GateSettings;
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The loaded acknowledgments, read only (the web gateway reads them through this, so only this file names the key). */
export const termsOf = (r: Pick<ResolvedBots, "termsAccepted">): TermsAccepted => r.termsAccepted;

export function isBotId(id: string): boolean {
  return BOT_ID_PATTERN.test(id);
}

/** Default privacy and autoFallback by kind: `local` is local and may be a fallback; `acp` is cloud and is never a fallback unless set. */
export function presetFromDoc(p: Obj): PresetConfig {
  const kind = (p["kind"] === "acp" ? "acp" : "local") as PresetKind;
  const out: PresetConfig = {
    id: String(p["id"]),
    kind,
    label: typeof p["label"] === "string" ? p["label"] : String(p["id"]),
    modelId: String(p["modelId"] ?? ""),
    contextWindow: typeof p["contextWindow"] === "number" ? p["contextWindow"] : 8192,
    maxTokens: typeof p["maxTokens"] === "number" ? p["maxTokens"] : 4096,
    privacy: (p["privacy"] === "cloud" || p["privacy"] === "local" ? p["privacy"] : kind === "acp" ? "cloud" : "local") as Privacy,
    autoFallback: typeof p["autoFallback"] === "boolean" ? p["autoFallback"] : kind === "local",
  };
  if (typeof p["runner"] === "string") out.runner = p["runner"];
  if (typeof p["baseUrl"] === "string") out.baseUrl = p["baseUrl"];
  if (typeof p["providerId"] === "string") out.providerId = p["providerId"] as AcpProvider;
  if (typeof p["apiKeyRef"] === "string") out.apiKeyRef = p["apiKeyRef"];
  return out;
}

function rootsOf(v: unknown): FolderRoot[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((r) => ({ alias: String(r["alias"]), path: String(r["path"]) }));
}

function edgesOf(v: unknown): BotEdge[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((e) => ({ to: String(e["to"]), allow: strings(e["allow"]), egress: e["egress"] === true }));
}

export function botFromDoc(b: Obj): BotConfig {
  const route = isObj(b["route"]) ? b["route"] : {};
  const shared = isObj(b["shared"]) ? b["shared"] : {};
  const relax = isObj(b["relax"]) ? b["relax"] : {};
  const out: BotConfig = {
    description: typeof b["description"] === "string" ? b["description"] : "",
    telegramTokenRef: String(b["telegramTokenRef"]),
    route: {
      primary: String(route["primary"]),
      allowed: strings(route["allowed"]),
      fallback: strings(route["fallback"]),
      onAuthRequired: (ON_AUTH_REQUIRED as readonly unknown[]).includes(route["onAuthRequired"]) ? (route["onAuthRequired"] as OnAuthRequired) : "fallback",
    },
    tools: strings(b["tools"]),
    readRoots: rootsOf(b["readRoots"]),
    cloudSafeRoots: rootsOf(b["cloudSafeRoots"]),
    shared: { read: shared["read"] === true },
    edges: edgesOf(b["edges"]),
    relax: { privateRoots: relax["privateRoots"] === true, privilegedTools: relax["privilegedTools"] === true },
  };
  if (typeof b["approvalTimeoutSec"] === "number") out.approvalTimeoutSec = b["approvalTimeoutSec"];
  return out;
}

/** True when any preset in the route is a cloud preset. */
export function isCloudCapable(route: BotRoute, presets: readonly PresetConfig[]): boolean {
  const ids = new Set([route.primary, ...route.allowed, ...route.fallback]);
  return presets.some((p) => ids.has(p.id) && p.privacy === "cloud");
}

/** The tool names a bot registers: its allowlist, minus the bus tools unless it has an edge. */
export function effectiveTools(bot: Pick<BotConfig, "tools" | "edges">): string[] {
  const hasEdge = bot.edges.length > 0;
  return bot.tools.filter((t) => hasEdge || !(BOT_BUS_TOOLS as readonly string[]).includes(t));
}

/** The default tool list of the implicit `main`: everything the code has, except the bus tools and the unbuilt second opinion. */
export const MAIN_DEFAULT_TOOLS: readonly string[] = [...KNOWN_TOOLS.filter((t) => t !== "ask_second_opinion"), "mcp__*"];

/** The roots a bot's read tools use: its `cloudSafeRoots` while it is cloud-capable (unless relaxed, UI-25), else its `readRoots`. */
export function effectiveReadRoots(bot: Pick<ResolvedBot, "readRoots" | "cloudSafeRoots" | "cloudCapable" | "relax">): FolderRoot[] {
  return bot.cloudCapable && !bot.relax.privateRoots ? bot.cloudSafeRoots : bot.readRoots;
}

// ---- parse ------------------------------------------------------------------------------------------------------------

/** The resolved form of a (valid) `security.json`, or the implicit `main` when it has no `bots` key or is absent (legacy mode). */
export function parseBots(security: Readonly<Obj> | undefined, ctx: BotsParseContext): ResolvedBots {
  const doc = security ?? {};
  const presets = Array.isArray(doc["presets"]) && doc["presets"].length > 0 ? (doc["presets"] as unknown[]).filter(isObj).map(presetFromDoc) : [...ctx.derivedPresets];
  const terms = isObj(doc["termsAccepted"]) ? doc["termsAccepted"] : {};
  const base = {
    presets,
    termsAccepted: { claude: terms["claude"] === true, antigravity: terms["antigravity"] === true },
    botBus: { ...DEFAULT_BOT_BUS, ...(isObj(doc["botBus"]) ? (doc["botBus"] as Partial<BotBusLimits>) : {}) },
    botRoom: { ...DEFAULT_BOT_ROOM, ...(isObj(doc["botRoom"]) ? (doc["botRoom"] as Partial<BotRoomSettings>) : {}) },
    gate: { ...DEFAULT_GATE, ...(isObj(doc["gate"]) ? (doc["gate"] as Partial<GateSettings>) : {}) },
  };
  const botsDoc = doc["bots"];
  if (!isObj(botsDoc)) {
    const main: BotConfig = {
      description: "The main agent",
      telegramTokenRef: MAIN_BOT_ID,
      route: { primary: ctx.defaultPreset, allowed: presets.map((p) => p.id), fallback: [], onAuthRequired: "fallback" },
      tools: [...MAIN_DEFAULT_TOOLS],
      readRoots: ctx.folderAllow.map((f) => ({ ...f })),
      cloudSafeRoots: [],
      shared: { read: false },
      edges: [],
      relax: { privateRoots: false, privilegedTools: false },
    };
    return { implicit: true, ...base, bots: [{ ...main, id: MAIN_BOT_ID, cloudCapable: isCloudCapable(main.route, presets), layout: "legacy" }] };
  }
  const bots = Object.entries(botsDoc)
    .filter(([, v]) => isObj(v))
    .map(([id, v]) => {
      const cfg = botFromDoc(v as Obj);
      return { ...cfg, id, cloudCapable: isCloudCapable(cfg.route, presets), layout: "bots" as const };
    })
    // `main` first, then in document order
    .sort((a, b) => (a.id === MAIN_BOT_ID ? -1 : b.id === MAIN_BOT_ID ? 1 : 0));
  return { implicit: false, ...base, bots };
}

// ---- validation -------------------------------------------------------------------------------------------------------

export interface BotsCheckContext {
  folderAllow: readonly FolderRoot[];
  folderDeny: readonly string[];
  mcpServerIds: readonly string[];
  flowServerId: string;
  /** Runner names whose preset counts as "on Strata" for UI-32. */
  strataRunner?: string;
}

export interface BotsValidation {
  issues: string[];
  warnings: string[];
}

/**
 * Refusals that must name a specific cause even though the schema would also reject the key (run BEFORE the schema, so the
 * message says why). Currently: an `elevated` edge key.
 */
export function botsPreRefusals(doc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(doc) || !isObj(doc["bots"])) return out;
  for (const [id, b] of Object.entries(doc["bots"])) {
    if (!isObj(b) || !Array.isArray(b["edges"])) continue;
    b["edges"].forEach((e, i) => {
      if (isObj(e) && Object.prototype.hasOwnProperty.call(e, "elevated")) out.push(`bots.${id}.edges[${i}].elevated: an elevated edge is not an option in v1; a peer turn never gets shell, file write, dispatch_job, Flow or remember`);
    });
  }
  return out;
}

const overlaps = (a: string, b: string): boolean => isSameOrUnder(a, b) || isSameOrUnder(b, a);

function checkRoots(at: string, roots: readonly FolderRoot[], ctx: BotsCheckContext, issues: string[]): void {
  const aliases = new Set<string>();
  roots.forEach((r, i) => {
    const here = `${at}[${i}]`;
    const key = r.alias.toLowerCase();
    if (aliases.has(key)) issues.push(`${here}.alias: duplicate alias "${r.alias}" in this bot`);
    aliases.add(key);
    if ((RESERVED_ROOT_ALIASES as readonly string[]).includes(key)) issues.push(`${here}.alias: "${r.alias}" is reserved (the code adds that root itself)`);
    if (!ctx.folderAllow.some((a) => isSameOrUnder(r.path, a.path))) issues.push(`${here}.path: ${r.path} is not inside a folder of the global allowlist (folders.allow)`);
    const hit = ctx.folderDeny.find((d) => overlaps(r.path, d));
    if (hit !== undefined) issues.push(`${here}.path: ${r.path} overlaps the denied path ${hit} (folders.deny always wins)`);
  });
}

/**
 * An allowlist entry is a code tool name, `mcp__*` (every MCP tool the host registers), `mcp__<server>__*` (one server's tools) or
 * `mcp__<server>__<tool>`. An entry for an MCP tool that the host does not register simply matches nothing: it can only narrow.
 */
function toolProblem(t: string, ctx: BotsCheckContext): string | undefined {
  if (CODE_TOOL_NAMES.includes(t) || t === "mcp__*") return undefined;
  const m = /^mcp__(.+?)__(.+)$/.exec(t);
  if (m && ctx.mcpServerIds.some((id) => t.startsWith(`mcp__${id}__`) && t.length > `mcp__${id}__`.length)) return undefined;
  return `"${t}" is not a tool of this build or of a configured MCP server (an allowlist only narrows)`;
}

/** Cross-checks of `bots`, `presets`, `termsAccepted` and `gate` (the schema ran first and passed). */
export function validateBotsDoc(doc: Readonly<Obj>, ctx: BotsCheckContext): BotsValidation {
  const issues: string[] = [];
  const warnings: string[] = [];
  const presetDocs = (Array.isArray(doc["presets"]) ? doc["presets"] : []).filter(isObj);
  const presets = presetDocs.map(presetFromDoc);
  const presetById = new Map(presets.map((p) => [p.id, p] as const));
  const terms = isObj(doc["termsAccepted"]) ? doc["termsAccepted"] : {};

  // presets (I38, I39, I41)
  presetDocs.forEach((_raw, i) => {
    const p = presets[i] as PresetConfig;
    const at = `presets[${i}]`;
    if (p.kind === "acp") {
      if (p.baseUrl === undefined) issues.push(`${at}.baseUrl: an acp preset needs the proxy URL (http://127.0.0.1:<port>/v1)`);
      else if (!isLoopbackHttp(p.baseUrl)) issues.push(`${at}.baseUrl: must be an http URL on 127.0.0.1 or localhost: ${p.baseUrl}`);
      if (p.providerId === undefined) issues.push(`${at}.providerId: an acp preset needs providerId (${ACP_PROVIDERS.join(", ")})`);
      if (p.privacy !== "cloud") issues.push(`${at}.privacy: an acp preset sends data to a vendor, so its privacy class is "cloud"`);
      if (p.apiKeyRef !== undefined && p.apiKeyRef !== PROXY_KEY_REF) issues.push(`${at}.apiKeyRef: only "${PROXY_KEY_REF}" (the proxy key) is allowed; a paid API key is never a brain or a fallback (D12)`);
    } else {
      if (p.runner === undefined) issues.push(`${at}.runner: a local preset needs a runner`);
      if (p.baseUrl !== undefined && !isLoopbackHttp(p.baseUrl)) issues.push(`${at}.baseUrl: must be an http URL on 127.0.0.1 or localhost: ${p.baseUrl}`);
      if (p.privacy !== "local") issues.push(`${at}.privacy: a local preset is "local"`);
      if (p.providerId !== undefined) issues.push(`${at}.providerId: only an acp preset has a provider`);
      if (p.apiKeyRef !== undefined) issues.push(`${at}.apiKeyRef: only an acp preset has a key reference`);
    }
  });

  const botsDoc = doc["bots"];
  if (botsDoc === undefined) return { issues, warnings };
  if (!isObj(botsDoc)) return { issues: [...issues, "bots: expected an object of bot id to bot"], warnings };

  const ids = Object.keys(botsDoc);
  if (!ids.includes(MAIN_BOT_ID)) issues.push(`bots: the bot "${MAIN_BOT_ID}" is required (it is the existing agent)`);
  if (ids.length > MAX_BOTS) issues.push(`bots: at most ${MAX_BOTS} bots`);
  for (const id of ids) if (!isBotId(id)) issues.push(`bots.${id}: a bot id is 2 to 24 characters of a-z, 0-9 and "-", starting with a letter`);

  const bots = ids.filter((id) => isObj(botsDoc[id])).map((id) => ({ id, cfg: botFromDoc(botsDoc[id] as Obj) }));
  const known = new Set(ids);

  // duplicate token refs
  const refOwner = new Map<string, string>();
  for (const { id, cfg } of bots) {
    const prev = refOwner.get(cfg.telegramTokenRef);
    if (prev !== undefined) issues.push(`bots.${id}.telegramTokenRef: the token "${cfg.telegramTokenRef}" is already used by bot "${prev}" (one poller per token)`);
    else refOwner.set(cfg.telegramTokenRef, id);
  }

  let shellBots = 0;
  let strataLocal = 0;
  for (const { id, cfg } of bots) {
    const at = `bots.${id}`;
    // route
    const routeIds = [cfg.route.primary, ...cfg.route.allowed, ...cfg.route.fallback];
    for (const pid of routeIds) if (!presetById.has(pid)) issues.push(`${at}.route: "${pid}" is not one of the presets`);
    if (!cfg.route.allowed.includes(cfg.route.primary)) issues.push(`${at}.route.allowed: must include the primary preset "${cfg.route.primary}"`);
    for (const pid of cfg.route.fallback) {
      const fb = presetById.get(pid);
      if (fb && !fb.autoFallback) issues.push(`${at}.route.fallback: preset "${pid}" has autoFallback false, so it can never be an automatic fallback; set autoFallback true on the preset or remove it from the fallback list`);
    }
    for (const pid of new Set(routeIds)) {
      const p = presetById.get(pid);
      if (p?.kind === "acp" && p.providerId !== undefined && (TERMS_PROVIDERS as readonly string[]).includes(p.providerId) && terms[p.providerId] !== true) {
        issues.push(`${at}.route: preset "${pid}" uses ${p.providerId} through the proxy, which may break that vendor's terms; it needs termsAccepted.${p.providerId}, set only in the settings UI`);
      }
    }
    const cloudCapable = isCloudCapable(cfg.route, presets);
    const primary = presetById.get(cfg.route.primary);
    if (primary?.kind === "local" && primary.runner === (ctx.strataRunner ?? "strata")) strataLocal++;
    if (!routeIds.some((pid) => presetById.get(pid)?.privacy === "local")) warnings.push(`${at}.route: no local preset in the route; the bot has no local fallback`);

    // tools
    cfg.tools.forEach((t, i) => {
      const problem = toolProblem(t, ctx);
      if (problem) issues.push(`${at}.tools[${i}]: ${problem}`);
    });
    if (new Set(cfg.tools).size !== cfg.tools.length) issues.push(`${at}.tools: duplicate names`);
    const hasShell = cfg.tools.includes("shell");
    if (hasShell) shellBots++;
    if (cloudCapable && !cfg.relax.privilegedTools) {
      for (const t of PRIVILEGED_TOOLS) if (cfg.tools.includes(t)) issues.push(`${at}.tools: "${t}" on a bot with a cloud preset in its route sends tool output to a vendor; keep it local or set relax.privilegedTools in the settings UI (I42, UI-25)`);
    }
    if (cfg.edges.length === 0 && BOT_BUS_TOOLS.some((t) => cfg.tools.includes(t))) warnings.push(`${at}.tools: ask_bot and list_bots are not registered for a bot with no edge`);

    // roots
    checkRoots(`${at}.readRoots`, cfg.readRoots, ctx, issues);
    checkRoots(`${at}.cloudSafeRoots`, cfg.cloudSafeRoots, ctx, issues);
    for (const r of cfg.cloudSafeRoots) {
      const same = cfg.readRoots.find((x) => x.alias.toLowerCase() === r.alias.toLowerCase() && normalizeWin(x.path) !== normalizeWin(r.path));
      if (same) issues.push(`${at}.cloudSafeRoots: alias "${r.alias}" names a different folder than in readRoots`);
    }

    // edges
    const seenTo = new Set<string>();
    cfg.edges.forEach((e, i) => {
      const eat = `${at}.edges[${i}]`;
      if (!known.has(e.to)) issues.push(`${eat}.to: there is no bot "${e.to}"`);
      else if (e.to === id) issues.push(`${eat}.to: a bot cannot have an edge to itself`);
      if (seenTo.has(e.to)) issues.push(`${eat}.to: duplicate edge to "${e.to}"`);
      seenTo.add(e.to);
      e.allow.forEach((t, j) => {
        const problem = toolProblem(t, ctx);
        if (problem) issues.push(`${eat}.allow[${j}]: ${problem}`);
        else if (PEER_FORBIDDEN_TOOLS.includes(t) || t === "mcp__*" || t.startsWith(`mcp__${ctx.flowServerId}__`)) issues.push(`${eat}.allow[${j}]: a peer turn never gets "${t}" (D12)`);
      });
    });
  }
  if (shellBots > 1) issues.push(`bots: at most one bot may have the shell tool (I42); ${shellBots} do`);
  const gate = isObj(doc["gate"]) ? doc["gate"] : {};
  const limit = typeof gate["localBotsOnStrata"] === "number" ? gate["localBotsOnStrata"] : DEFAULT_GATE.localBotsOnStrata;
  if (strataLocal > limit) issues.push(`bots: ${strataLocal} bots have Strata as their primary preset but gate.localBotsOnStrata is ${limit} (Strata serves one request at a time, UI-32)`);
  return { issues, warnings };
}

function isLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackUrl(url);
  } catch {
    return false;
  }
}
