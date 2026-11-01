/**
 * The split table (S17.1). Every top-level key of the Phase 1/2 `config.json` is classified as `bootstrap` (stays in the
 * admin-only `config.json`) or `security` (moves to `security.json`, written only by the job runner's settings UI). A key that
 * is in neither list makes the migration REFUSE (fail closed): a new setting must be classified on purpose.
 *
 * `splitConfig` and `mergeConfig` are inverses on the legacy shape: `mergeConfig(splitConfig(c)) deep-equals c`. The Phase 3
 * only additions (`presets`, `budgets`, `proposals`, `model.defaultPreset`, `schemaVersion`, `settings`) are dropped again by
 * `mergeConfig`, so the Phase 1/2 `Config` loader and every consumer of it stay unchanged.
 *
 * Pure: no imports besides contracts.
 */
import { SETTINGS_SCHEMA_VERSION } from "./contracts.js";

export type KeyClass = "bootstrap" | "security";

export const KEY_TABLE: Readonly<Record<string, KeyClass>> = {
  schemaVersion: "bootstrap",
  paths: "bootstrap",
  mainUserProfile: "bootstrap",
  settings: "bootstrap",
  telegram: "security",
  model: "security",
  folders: "security",
  shell: "security",
  limits: "security",
  mcp: "security",
  jobs: "security",
  flow: "security",
  secondOpinion: "security",
  tools: "security",
  presets: "security",
  budgets: "security",
  proposals: "security",
};

/** Keys that exist only in the Phase 3 documents; `mergeConfig` removes them. */
const PHASE3_SECURITY_KEYS = new Set(["schemaVersion", "presets", "budgets", "proposals"]);
/**
 * Phase 4 (S20) keys of `security.json`. They are NOT in `KEY_TABLE`: a legacy `config.json` that carries one is refused as
 * unclassified (they exist only in `security.json`), and `mergeConfig` drops them, so the Phase 1/2 `Config` is unchanged.
 */
export const PHASE4_SECURITY_KEYS: ReadonlySet<string> = new Set(["bots", "termsAccepted", "botBus", "botRoom", "gate"]);

export const DEFAULT_PROPOSALS = { timeoutSec: 600, maxPending: 1, perHour: 5, autoApplyCosmetic: false } as const;
export const DEFAULT_BUDGETS = { maxJobsPerDay: 20 } as const;

export class UnclassifiedKeyError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`config.json has keys that the settings split table does not classify: ${keys.join(", ")}. Refusing to migrate (fail closed): classify them in src/settings/split.ts first.`);
    this.name = "UnclassifiedKeyError";
    this.keys = keys;
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function classifyKeys(config: Obj): { bootstrap: string[]; security: string[]; unclassified: string[] } {
  const out = { bootstrap: [] as string[], security: [] as string[], unclassified: [] as string[] };
  for (const k of Object.keys(config)) {
    const cls = KEY_TABLE[k];
    if (cls) out[cls].push(k);
    else if (k.startsWith("_")) out.bootstrap.push(k); // a note at the top of the file stays where it is
    else out.unclassified.push(k);
  }
  return out;
}

export interface SplitResult {
  bootstrap: Obj;
  security: Obj;
}

/** Derives `presets[]` from the configured runner blocks (one local preset per runner). */
function presetsFrom(model: Obj): Obj[] {
  const runners = isObj(model["runners"]) ? model["runners"] : {};
  const out: Obj[] = [];
  for (const name of ["lmstudio", "strata"]) {
    const b = runners[name];
    if (!isObj(b)) continue;
    out.push({
      id: name,
      kind: "local",
      runner: name,
      modelId: typeof b["modelId"] === "string" ? b["modelId"] : "",
      contextWindow: typeof b["contextWindow"] === "number" ? b["contextWindow"] : 8192,
      maxTokens: typeof b["maxTokens"] === "number" ? b["maxTokens"] : 4096,
      label: name === "lmstudio" ? "LM Studio" : "Strata",
    });
  }
  return out;
}

/** Splits a Phase 1/2 config. Throws `UnclassifiedKeyError`. `settingsDir` is written into the bootstrap `settings.dir`. */
export function splitConfig(config: Obj, settingsDir: string): SplitResult {
  const c = classifyKeys(config);
  if (c.unclassified.length > 0) throw new UnclassifiedKeyError(c.unclassified);
  const bootstrap: Obj = { schemaVersion: SETTINGS_SCHEMA_VERSION };
  for (const k of c.bootstrap) if (k !== "schemaVersion" && k !== "settings") bootstrap[k] = structuredClone(config[k]);
  bootstrap["settings"] = { dir: settingsDir };
  const security: Obj = { schemaVersion: 1 };
  for (const k of c.security) if (!PHASE3_SECURITY_KEYS.has(k)) security[k] = structuredClone(config[k]);
  const model = isObj(security["model"]) ? (security["model"] as Obj) : {};
  const runner = typeof model["runner"] === "string" ? model["runner"] : "lmstudio";
  if (model["defaultPreset"] === undefined) model["defaultPreset"] = runner;
  security["model"] = model;
  security["presets"] = Array.isArray(config["presets"]) ? structuredClone(config["presets"]) : presetsFrom(model);
  security["budgets"] = isObj(config["budgets"]) ? structuredClone(config["budgets"]) : { ...DEFAULT_BUDGETS };
  security["proposals"] = isObj(config["proposals"]) ? structuredClone(config["proposals"]) : { ...DEFAULT_PROPOSALS };
  return { bootstrap, security };
}

/** Rebuilds the legacy (Phase 1/2) shape from `config.json` (v2) and `security.json`. */
export function mergeConfig(bootstrap: Obj, security: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(bootstrap)) if (k !== "schemaVersion" && k !== "settings") out[k] = structuredClone(v);
  for (const [k, v] of Object.entries(security)) {
    if (PHASE3_SECURITY_KEYS.has(k) || PHASE4_SECURITY_KEYS.has(k)) continue;
    if (k === "model" && isObj(v)) {
      const { defaultPreset: _d, ...rest } = v;
      void _d;
      out[k] = structuredClone(rest);
    } else out[k] = structuredClone(v);
  }
  return out;
}

/** A printable table of the split for the dry run: one row per key, where it goes. */
export function splitTable(config: Obj): { key: string; goes: KeyClass | "REFUSED" }[] {
  const c = classifyKeys(config);
  return [
    ...c.bootstrap.map((key) => ({ key, goes: "bootstrap" as const })),
    ...c.security.map((key) => ({ key, goes: "security" as const })),
    ...c.unclassified.map((key) => ({ key, goes: "REFUSED" as const })),
  ];
}
