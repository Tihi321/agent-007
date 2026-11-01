/**
 * Model sources (plan agent-007-model-sources, MS1, D4, D7, D10, I59): where a web preset's model list comes from, and the rules that
 * turn a (source, model id) pair into a preset. Pure: no file, no socket, no clock.
 *
 *  - `classify(source, modelId)` is the ONLY place that derives kind, privacy, provider id, key reference and runner of a preset. Its
 *    inputs are the source definition and the model id string; no field of a fetched payload is an input (I59).
 *  - The parsers (`parseProxyModels`, `parseLmStudioModels`, `parseOpenAiModels`) take an untrusted, already JSON-parsed body and
 *    return only `{modelId, group, loaded?, contextHint?}`: every other field of the payload is dropped. Limits: a model id must
 *    match `MODEL_ID_PATTERN` (128 chars), at most `MAX_ROWS` rows (the rest are counted in `ignored`), embedding models are hidden.
 *  - `presetIdFor` builds the D4 id.
 */
import { createHash } from "node:crypto";
import { ACP_PROVIDERS, PRESET_ID_PATTERN, PROXY_KEY_REF, TERMS_PROVIDERS } from "../bots/schema.js";
import type { AcpProvider, PresetConfig, Privacy } from "../bots/schema.js";

// ---- types and constants ----------------------------------------------------------------------------------------------

export type SourceKind = "acp-proxy" | "lmstudio" | "strata" | "custom";
/** Reserved: never a custom source id. */
export const BUILTIN_SOURCE_IDS = ["acp-proxy", "lmstudio", "strata"] as const;
/** Also never a custom source id: the built-in preset prefixes (so an id is not reused across privacy classes) and Object.prototype-like names. */
export const RESERVED_SOURCE_IDS: readonly string[] = [...BUILTIN_SOURCE_IDS, "claude", "codex", "ag", "lms", "strata", "constructor", "prototype"];
/** Custom source ids; also the preset id prefix. */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]{1,11}$/;
/** The proxy URL when no `acp` preset names one. */
export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8787/v1";

export interface ModelSource {
  id: string;
  kind: SourceKind;
  label: string;
  /** `.../v1`. Built-ins: from config (an absent runner block gives `""` = not set up, see `isSetUp`). */
  baseUrl: string;
  keyRef?: "proxyApiKey" | "lmStudioApiToken" | "strataApiKey" | `webkey:${string}`;
  /** Informational: `classify` re-derives privacy from `kind`, `baseUrl` and `treatAsCloud`, it never trusts this field. */
  privacy: "local" | "cloud";
  billing?: "subscription" | "paid";
  treatAsCloud?: boolean;
  /** Strata only (deviation from the plan's section 4, which gives `classify` no config): the runner block's context window and max tokens. */
  defaults?: { contextWindow: number; maxTokens: number };
}

export interface Classified {
  kind: "acp" | "local" | "custom";
  runner?: "lmstudio" | "strata";
  providerId?: AcpProvider;
  apiKeyRef?: string;
  privacy: "local" | "cloud";
  needsTerms: boolean;
  paidAllowed: boolean;
  defaults: { contextWindow: number; maxTokens: number };
  /** Fixed sentence: the row cannot be ticked (an unknown proxy provider). */
  blocked?: string;
}

export type FetchGroup = "claude" | "codex" | "antigravity" | "lmstudio" | "strata" | "custom";

/** One row of a fetch answer (server -> UI). */
export interface FetchedRow {
  modelId: string;
  group: FetchGroup;
  loaded?: boolean;
  contextHint?: number;
  presetId?: string;
  proposedId: string;
  classified: Pick<Classified, "kind" | "privacy" | "needsTerms" | "paidAllowed" | "defaults">;
  termsOk: boolean;
  blocked?: string;
}

/** What a parser keeps of one fetched row. */
export interface ParsedModel {
  modelId: string;
  group: FetchGroup;
  loaded?: boolean;
  contextHint?: number;
}

export interface ParsedList {
  rows: ParsedModel[];
  /** Entries dropped (bad id or shape) or cut by the row cap. Hidden embedding models and duplicates are not counted. */
  ignored: number;
  note?: string;
}

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export const MAX_ROWS = 500;
export const CONTEXT_HINT_MIN = 512;
export const CONTEXT_HINT_MAX = 10_000_000;
export const BLOCKED_UNKNOWN_PROVIDER = "unknown proxy provider";

type Defaults = { contextWindow: number; maxTokens: number };

// ---- privacy ----------------------------------------------------------------------------------------------------------

/** True only for the literal hosts `127.0.0.1`, `[::1]` and `localhost` (I60). */
export function isLiteralLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "[::1]" || h === "localhost";
  } catch {
    return false;
  }
}

/** The privacy class a source gets: built-ins are fixed; a custom source is local only on a literal loopback host and not `treatAsCloud`. */
export function derivePrivacy(source: Pick<ModelSource, "kind" | "baseUrl" | "treatAsCloud">): Privacy {
  switch (source.kind) {
    case "acp-proxy":
      return "cloud";
    case "lmstudio":
    case "strata":
      return "local";
    default:
      return isLiteralLoopbackUrl(source.baseUrl) && source.treatAsCloud !== true ? "local" : "cloud";
  }
}

/** False for a built-in whose runner block is absent. */
export function isSetUp(source: Pick<ModelSource, "baseUrl">): boolean {
  return source.baseUrl !== "";
}

// ---- built-in sources -------------------------------------------------------------------------------------------------

interface BuiltinConfig {
  model: { runners: { lmstudio?: { baseUrl: string }; strata?: { baseUrl: string; contextWindow: number; maxTokens: number } } };
}

/**
 * The three built-in sources. Proxy URL: the `baseUrl` of the first `acp` preset in `security.json`, else `DEFAULT_PROXY_BASE_URL`.
 * LM Studio and Strata: the runner block's `baseUrl`; no block gives `baseUrl: ""` (not set up).
 */
export function builtinSources(config: BuiltinConfig, securityPresets: readonly Pick<PresetConfig, "kind" | "baseUrl">[]): ModelSource[] {
  const proxyUrl = securityPresets.find((p) => p.kind === "acp" && p.baseUrl !== undefined)?.baseUrl ?? DEFAULT_PROXY_BASE_URL;
  const { lmstudio, strata } = config.model.runners;
  return [
    { id: "acp-proxy", kind: "acp-proxy", label: "ACP proxy", baseUrl: proxyUrl, keyRef: "proxyApiKey", privacy: "cloud" },
    { id: "lmstudio", kind: "lmstudio", label: "LM Studio", baseUrl: lmstudio?.baseUrl ?? "", keyRef: "lmStudioApiToken", privacy: "local" },
    {
      id: "strata",
      kind: "strata",
      label: "Strata",
      baseUrl: strata?.baseUrl ?? "",
      keyRef: "strataApiKey",
      privacy: "local",
      ...(strata ? { defaults: { contextWindow: strata.contextWindow, maxTokens: strata.maxTokens } } : {}),
    },
  ];
}

// ---- family defaults and classification -------------------------------------------------------------------------------

/**
 * Context window and max tokens by family (D2). `claude`/`codex` 200000/8192; `antigravity` 1000000/8192; `lmstudio` loaded with a
 * `contextHint`: hint/4096, otherwise 8192/2048; `strata`: `sourceDefaults` (the runner block) else 8192/2048; `custom` 32768/4096.
 */
export function familyDefaults(group: FetchGroup, opts: { loaded?: boolean; contextHint?: number; sourceDefaults?: Defaults } = {}): Defaults {
  switch (group) {
    case "claude":
    case "codex":
      return { contextWindow: 200_000, maxTokens: 8192 };
    case "antigravity":
      return { contextWindow: 1_000_000, maxTokens: 8192 };
    case "lmstudio":
      return opts.loaded === true && validHint(opts.contextHint) ? { contextWindow: opts.contextHint as number, maxTokens: 4096 } : { contextWindow: 8192, maxTokens: 2048 };
    case "strata":
      return opts.sourceDefaults ? { ...opts.sourceDefaults } : { contextWindow: 8192, maxTokens: 2048 };
    default:
      return { contextWindow: 32_768, maxTokens: 4096 };
  }
}

function validHint(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= CONTEXT_HINT_MIN && n <= CONTEXT_HINT_MAX;
}

/** The proxy provider of a model id: `claude/..`, `antigravity/..`, `codex/..` or a bare id (codex); anything else is undefined. */
export function proxyProviderOf(modelId: string): AcpProvider | undefined {
  const i = modelId.indexOf("/");
  if (i < 0) return "codex";
  const prefix = modelId.slice(0, i);
  return (ACP_PROVIDERS as readonly string[]).includes(prefix) ? (prefix as AcpProvider) : undefined;
}

/** The `FetchGroup` a source's row belongs to (a proxy id with an unknown prefix is shown in `custom` and blocked). */
export function groupOf(source: Pick<ModelSource, "kind">, modelId: string): FetchGroup {
  if (source.kind === "acp-proxy") return proxyProviderOf(modelId) ?? "custom";
  return source.kind === "custom" ? "custom" : source.kind;
}

/** Kind, privacy, provider, key reference, runner, terms and defaults from the SOURCE and the model id only (I59). */
export function classify(source: ModelSource, modelId: string): Classified {
  const privacy = derivePrivacy(source);
  const base = { privacy, paidAllowed: privacy === "cloud" };
  switch (source.kind) {
    case "acp-proxy": {
      const providerId = proxyProviderOf(modelId);
      if (providerId === undefined) {
        return { ...base, kind: "acp", apiKeyRef: PROXY_KEY_REF, needsTerms: false, defaults: familyDefaults("custom"), blocked: BLOCKED_UNKNOWN_PROVIDER };
      }
      return {
        ...base,
        kind: "acp",
        providerId,
        apiKeyRef: PROXY_KEY_REF,
        needsTerms: (TERMS_PROVIDERS as readonly string[]).includes(providerId),
        defaults: familyDefaults(providerId),
      };
    }
    case "lmstudio":
      return { ...base, kind: "local", runner: "lmstudio", needsTerms: false, defaults: familyDefaults("lmstudio") };
    case "strata":
      return { ...base, kind: "local", runner: "strata", needsTerms: false, defaults: familyDefaults("strata", source.defaults ? { sourceDefaults: source.defaults } : {}) };
    default:
      return { ...base, kind: "custom", ...(source.keyRef !== undefined ? { apiKeyRef: `webkey:${source.id}` } : {}), needsTerms: false, defaults: familyDefaults("custom") };
  }
}

// ---- preset ids (D4) --------------------------------------------------------------------------------------------------

const GROUP_PREFIX: Record<Exclude<FetchGroup, "custom">, string> = { claude: "claude", codex: "codex", antigravity: "ag", lmstudio: "lms", strata: "strata" };

export interface ExistingPreset {
  id: string;
  sourceId: string;
  modelId: string;
}

const normalizeModelId = (id: string): string => (id.startsWith("codex/") ? id.slice("codex/".length) : id);

/** An existing web preset with the same source and model id (the Codex bare and `codex/` forms count as one model). */
export function findExistingPreset(existing: readonly ExistingPreset[], sourceId: string, modelId: string): ExistingPreset | undefined {
  const want = normalizeModelId(modelId);
  return existing.find((e) => e.sourceId === sourceId && normalizeModelId(e.modelId) === want);
}

const hex = (sourceId: string, modelId: string, salt: string, n: number): string => createHash("sha256").update(`${sourceId}\n${modelId}${salt}`).digest("hex").slice(0, n);

/**
 * D4: the id for (source, model). If `existing` has a preset with the same source and model id, its id is returned unchanged (so
 * `claude-sonnet`, `claude-opus` and `strata` keep their ids). Otherwise `<prefix>-<slug>`, valid for `PRESET_ID_PATTERN` and not in
 * `takenIds`; when it is too long or taken: the base cut to 19 chars + `-` + 4 hex of `sha256(sourceId "\n" modelId)`, then 6 hex
 * (base cut to 17), then 6 hex of a salted hash until free. `takenIds` holds every id in use (settings and web presets).
 */
export function presetIdFor(sourceId: string, group: FetchGroup, modelId: string, takenIds: ReadonlySet<string> | readonly string[], existing: readonly ExistingPreset[] = []): string {
  const reused = findExistingPreset(existing, sourceId, modelId);
  if (reused) return reused.id;
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds);
  const prefix = group === "custom" ? sourceId : GROUP_PREFIX[group];
  const stripped = group === "claude" || group === "codex" || group === "antigravity" ? (modelId.startsWith(`${group}/`) ? modelId.slice(group.length + 1) : modelId) : modelId;
  const slug = stripped.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  const base = `${prefix}-${slug}`;
  if (PRESET_ID_PATTERN.test(base) && !taken.has(base)) return base;
  const cut = (n: number): string => base.slice(0, n).replace(/-+$/, "");
  const tries = [`${cut(19)}-${hex(sourceId, modelId, "", 4)}`, `${cut(17)}-${hex(sourceId, modelId, "", 6)}`];
  for (const t of tries) if (PRESET_ID_PATTERN.test(t) && !taken.has(t)) return t;
  for (let n = 2; ; n++) {
    const t = `${cut(17)}-${hex(sourceId, modelId, `\n${n}`, 6)}`;
    if (!taken.has(t)) return t;
  }
}

// ---- parsers ----------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Collector {
  readonly rows: ParsedModel[] = [];
  ignored = 0;
  #seen = new Set<string>();
  capped = false;

  add(modelId: unknown, group: FetchGroup, extra: { loaded?: boolean; contextHint?: unknown } = {}, hidden = false): void {
    if (typeof modelId !== "string" || !MODEL_ID_PATTERN.test(modelId)) {
      this.ignored++;
      return;
    }
    if (hidden || /embed/i.test(modelId)) return;
    const key = normalizeModelId(modelId);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    if (this.rows.length >= MAX_ROWS) {
      this.ignored++;
      this.capped = true;
      return;
    }
    this.rows.push({
      modelId,
      group,
      ...(extra.loaded !== undefined ? { loaded: extra.loaded } : {}),
      ...(validHint(extra.contextHint) ? { contextHint: extra.contextHint } : {}),
    });
  }

  done(note?: string): ParsedList {
    const notes = [this.capped ? `more than ${MAX_ROWS} models: the first ${MAX_ROWS} are shown` : undefined, note].filter((x): x is string => x !== undefined);
    return { rows: this.rows, ignored: this.ignored, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
  }
}

function dataArray(body: unknown, key: string): unknown[] | undefined {
  if (!isObj(body)) return undefined;
  const v = body[key];
  return Array.isArray(v) ? v : undefined;
}

/** ACP proxy `GET /v1/models`. Codex bare and `codex/` ids are one row, stored as `codex/<id>` (D10). An unknown prefix is kept (and blocked by `classify`). */
export function parseProxyModels(body: unknown): ParsedList {
  const c = new Collector();
  for (const m of dataArray(body, "data") ?? []) {
    const id = isObj(m) ? m["id"] : undefined;
    if (typeof id !== "string") {
      c.add(undefined, "custom");
      continue;
    }
    const provider = MODEL_ID_PATTERN.test(id) ? proxyProviderOf(id) : undefined;
    const stored = provider === "codex" && !id.startsWith("codex/") ? `codex/${id}` : id;
    c.add(stored, provider ?? "custom");
  }
  return c.done();
}

/** An OpenAI-style `GET /models` (`data[].id`), for Strata (`group: "strata"`) and custom providers. */
export function parseOpenAiModels(body: unknown, group: "strata" | "custom" = "custom"): ParsedList {
  const c = new Collector();
  for (const m of dataArray(body, "data") ?? []) c.add(isObj(m) ? m["id"] : undefined, group);
  return c.done();
}

const isEmbeddingType = (t: unknown): boolean => typeof t === "string" && /embed/i.test(t);

/**
 * LM Studio, first usable shape wins: `v1` (`GET /api/v1/models`: `models[].{key,type,loaded_instances,max_context_length}`), `v0`
 * (`GET /api/v0/models`: `data[].{id,type,state,loaded_context_length}`), then `openai` (`GET /v1/models`: ids only, `loaded` unknown).
 * `max_context_length` is the model's limit, not the loaded context, so it is never a `contextHint`.
 */
export function parseLmStudioModels(bodies: { v1?: unknown; v0?: unknown; openai?: unknown }): ParsedList {
  const c = new Collector();
  const v1 = dataArray(bodies.v1, "models");
  if (v1) {
    for (const m of v1) {
      if (!isObj(m)) {
        c.add(undefined, "lmstudio");
        continue;
      }
      const inst = Array.isArray(m["loaded_instances"]) ? m["loaded_instances"] : [];
      const first = inst.find(isObj);
      const cfg = first && isObj(first["config"]) ? first["config"] : undefined;
      c.add(m["key"], "lmstudio", { loaded: inst.length > 0, contextHint: cfg?.["context_length"] }, isEmbeddingType(m["type"]));
    }
    return c.done();
  }
  const v0 = dataArray(bodies.v0, "data");
  if (v0) {
    for (const m of v0) {
      if (!isObj(m)) {
        c.add(undefined, "lmstudio");
        continue;
      }
      const loaded = m["state"] === "loaded";
      c.add(m["id"], "lmstudio", { loaded, ...(loaded ? { contextHint: m["loaded_context_length"] } : {}) }, isEmbeddingType(m["type"]));
    }
    return c.done();
  }
  for (const m of dataArray(bodies.openai, "data") ?? []) c.add(isObj(m) ? m["id"] : undefined, "lmstudio");
  return c.done("LM Studio did not report which models are loaded");
}
