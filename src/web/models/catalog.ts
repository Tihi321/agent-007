/**
 * The preset catalogue of the web gateway (plan agent-007-model-sources, MS2, D3, D6, I59, I60, I62).
 *
 * It merges the presets of `security.json` (read-only here, I25) with the web presets the owner ticked on the Models page
 * (`<dataDir>\web\models.json`), follows both files without a restart, and turns a preset id into a model endpoint.
 *
 * API (all synchronous; readers call these per request, never keep the arrays):
 *   presets(): PresetConfig[]            every usable preset (settings first, then web); a new array only after a rebuild
 *   terms(): TermsAccepted               the terms flags of the current security snapshot
 *   sources(): ModelSource[]             acp-proxy, lmstudio, strata, then the custom sources (none while models.json is off)
 *   banners(): string[]                  owner-facing notices (invalid security.json, tampered/invalid models.json, hidden presets)
 *   endpoint(id): ModelEndpoint | undefined
 *   reloadSecurity(): void               re-reads security.json and checks models.json when their sha256 changed (10 s timer, and call it
 *                                        on every Models page load). Invalid security.json keeps the last good snapshot + banner + audit.
 *   afterWrite(): void                   call after every Models write: forces both files to be re-read and the catalogue rebuilt
 *   entries(): CatalogEntry[]            every preset with its origin ("settings" | "web") and source id
 *   existing(): ExistingPreset[]         for presetIdFor / findExistingPreset (settings presets are mapped to their source)
 *   stored(): {state, doc}               the web store as the gateway sees it (doc is empty unless state is "ok")
 *   keyFor(source): string | undefined   the key of a source, unsealed server-side on each call (never cached, logged or returned to a client)
 *   update(fn): R                        the one write path: fn edits a draft {doc, keys}; the files are validated and written atomically,
 *                                        `models_saved {sha256}` is audited and the catalogue is rebuilt. When the store is "tampered" or
 *                                        "invalid" the draft starts EMPTY (the owner saves again from a clean slate). Throws: nothing is written.
 *   close(): void                        stops the timer
 *
 * A stored preset becomes a `PresetConfig` at every rebuild via `classify(source, modelId)` (I59); `paid` is dropped when the source
 * cannot be paid; a security preset wins an id collision. A custom cloud source without `billing` makes its presets paid (fail closed).
 */
import { lookup } from "node:dns/promises";
import { isPaidPreset } from "../../bots/schema.js";
import type { PresetConfig, TermsAccepted } from "../../bots/schema.js";
import type { Config } from "../../config/schema.js";
import type { Secrets } from "../../config/secrets.js";
import { builtinSources, classify, derivePrivacy, isLiteralLoopbackUrl, isSetUp } from "../../models/sources.js";
import type { ExistingPreset, ModelSource } from "../../models/sources.js";
import { presetProblem } from "../../models/presets.js";
import type { WebAudit } from "../audit.js";
import type { ModelEndpoint } from "../chat/openaiEngine.js";
import type { SecretBox } from "../crypto.js";
import { webPaths } from "../paths.js";
import { checkUrl } from "../runtime/ssrf.js";
import type { Resolver } from "../runtime/ssrf.js";
import { ModelsStore, emptyKeys, emptyModels } from "./store.js";
import type { KeysFile, ModelsFile, StoredSource } from "./store.js";

export type ModelSecrets = Pick<Secrets, "lmStudioApiToken" | "strataApiKey" | "proxyApiKey">;

/** What the gateway takes from `security.json` + `config.json` (the same `loadConfig` + `parseBots` path as boot, see `main.ts`). */
export interface SecuritySnapshot {
  presets: readonly PresetConfig[];
  terms: TermsAccepted;
  config: Pick<Config, "model">;
}

export type StoreState = "ok" | "tampered" | "invalid";

export interface CatalogEntry {
  preset: PresetConfig;
  origin: "settings" | "web";
  sourceId: string;
}

export interface ModelsDraft {
  doc: ModelsFile;
  keys: {
    /** Seals `plain` for the source (AAD = `webkey:<id>`) and keeps `doc.sources[].hasKey` in step. */
    set(sourceId: string, plain: string): void;
    remove(sourceId: string): void;
    has(sourceId: string): boolean;
  };
}

export interface PresetCatalog {
  presets(): PresetConfig[];
  terms(): TermsAccepted;
  sources(): ModelSource[];
  banners(): string[];
  endpoint(id: string): ModelEndpoint | undefined;
  reloadSecurity(): void;
  afterWrite(): void;
  entries(): CatalogEntry[];
  existing(): ExistingPreset[];
  stored(): { state: StoreState; doc: ModelsFile };
  keyFor(source: ModelSource): string | undefined;
  update<R>(fn: (draft: ModelsDraft) => R): R;
  close(): void;
}

export interface PresetCatalogOptions {
  dataDir: string;
  box: SecretBox;
  audit: WebAudit;
  secrets: ModelSecrets;
  /** Same path as boot: `loadConfig` + `parseBots`. Throws for an invalid `security.json` or config. */
  loadSecurity(): SecuritySnapshot;
  /** sha256 of the `security.json` text ("" when there is none). */
  securityHash(): string;
  resolver?: Resolver;
  /** Default 10 000 ms; 0 = no timer (tests). */
  intervalMs?: number;
}

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Where each settings preset is reached: local presets at their runner's URL, proxy presets at the proxy URL with the proxy key. */
export function endpointResolver(config: Pick<Config, "model">, secrets: ModelSecrets, presets: readonly PresetConfig[]): (id: string) => ModelEndpoint | undefined {
  return (id) => {
    const p = presets.find((x) => x.id === id);
    return p ? settingsEndpoint(config, secrets, p) : undefined;
  };
}

function settingsEndpoint(config: Pick<Config, "model">, secrets: ModelSecrets, p: PresetConfig): ModelEndpoint | undefined {
  if (p.kind === "acp") {
    if (!p.baseUrl) return undefined;
    return { baseUrl: p.baseUrl, apiKey: secrets.proxyApiKey, modelId: p.modelId, maxTokens: p.maxTokens, viaProxy: true, providerId: p.providerId, ...(isPaidPreset(p) ? { paid: true } : {}), label: p.label };
  }
  const runner = p.runner ? (config.model.runners as Record<string, { baseUrl: string } | undefined>)[p.runner] : undefined;
  if (!runner) return undefined;
  const apiKey = p.runner === "lmstudio" ? secrets.lmStudioApiToken : p.runner === "strata" ? secrets.strataApiKey : undefined;
  return { baseUrl: runner.baseUrl, apiKey, modelId: p.modelId, maxTokens: p.maxTokens, viaProxy: false, label: p.label };
}

const sourceIdOfSettings = (p: PresetConfig): string => (p.kind === "acp" ? "acp-proxy" : (p.runner ?? "lmstudio"));

export function createPresetCatalog(o: PresetCatalogOptions): PresetCatalog {
  const paths = webPaths(o.dataDir);
  const store = new ModelsStore({ modelsFile: paths.modelsFile, keysFile: paths.modelKeysFile, auditDir: paths.auditDir });
  const resolver = o.resolver ?? defaultResolver;

  const audit = (e: Parameters<WebAudit["write"]>[0]): void => {
    try {
      o.audit.write(e);
    } catch {
      /* a failing audit never stops the catalogue */
    }
  };

  // ---- security snapshot -------------------------------------------------------------------------------------------------
  let secHash = o.securityHash();
  let snap: SecuritySnapshot = o.loadSecurity();
  let secBad = false;

  // ---- web store state ---------------------------------------------------------------------------------------------------
  let state: StoreState = "ok";
  let stored: ModelsFile = emptyModels();
  let evaluated: string | undefined; // hash of the models.json bytes last evaluated

  let entries: CatalogEntry[] = [];
  let sources: ModelSource[] = [];
  let banners: string[] = [];
  let presets: PresetConfig[] = [];

  function evaluateModels(force: boolean): boolean {
    const r = store.readModels();
    if (!force && evaluated === r.hash) return false;
    evaluated = r.hash;
    if (!r.ok) {
      state = "invalid";
      stored = emptyModels();
      audit({ kind: "models_reload", detail: { file: "models.json", ok: false } });
      return true;
    }
    if (r.hash === "") {
      state = "ok";
      stored = r.doc;
      return true;
    }
    if (store.lastSavedHash() === r.hash) {
      state = "ok";
      stored = r.doc;
      return true;
    }
    state = "tampered";
    stored = emptyModels();
    audit({ kind: "models_reload", detail: { file: "models.json", ok: false } });
    return true;
  }

  function customSource(s: StoredSource): ModelSource {
    const partial = { kind: "custom" as const, baseUrl: s.baseUrl, ...(s.treatAsCloud !== undefined ? { treatAsCloud: s.treatAsCloud } : {}) };
    return {
      id: s.id,
      label: s.label,
      baseUrl: s.baseUrl,
      kind: "custom",
      privacy: derivePrivacy(partial),
      ...(s.hasKey ? { keyRef: `webkey:${s.id}` as const } : {}),
      ...(s.billing !== undefined ? { billing: s.billing } : {}),
      ...(s.treatAsCloud !== undefined ? { treatAsCloud: s.treatAsCloud } : {}),
    };
  }

  function rebuild(): void {
    const notes: string[] = [];
    if (secBad) notes.push("security.json is invalid: the last good settings are still in use");
    if (state === "tampered") notes.push("models.json was changed outside the Models page");
    if (state === "invalid") notes.push("models.json is invalid: the web models are off until they are saved again on the Models page");
    const settingsEntries: CatalogEntry[] = snap.presets.map((preset) => ({ preset, origin: "settings", sourceId: sourceIdOfSettings(preset) }));
    const srcs: ModelSource[] = [...builtinSources(snap.config, snap.presets), ...(state === "ok" ? stored.sources.map(customSource) : [])];
    const taken = new Set(settingsEntries.map((e) => e.preset.id));
    const web: CatalogEntry[] = [];
    if (state === "ok") {
      for (const sp of stored.presets) {
        const src = srcs.find((s) => s.id === sp.sourceId);
        if (!src || !isSetUp(src)) {
          notes.push(`Web model "${sp.id}" is off: its source is not set up`);
          continue;
        }
        if (taken.has(sp.id)) {
          notes.push(`Web model "${sp.id}" is hidden: security.json has a preset with the same id`);
          continue;
        }
        const c = classify(src, sp.modelId);
        if (c.blocked) {
          notes.push(`Web model "${sp.id}" is off: ${c.blocked}`);
          continue;
        }
        let bill: "subscription" | "paid" = sp.billing;
        if (src.kind === "custom" && c.privacy === "cloud" && src.billing === undefined) bill = "paid"; // no default for a cloud provider (D1)
        if (bill === "paid" && !c.paidAllowed) {
          notes.push(`Web model "${sp.id}" is off: only a cloud model can be paid`);
          continue;
        }
        const preset: PresetConfig = {
          id: sp.id,
          kind: c.kind,
          label: sp.label,
          ...(c.runner ? { runner: c.runner } : {}),
          ...(c.kind !== "local" ? { baseUrl: src.baseUrl } : {}),
          modelId: sp.modelId,
          ...(c.providerId ? { providerId: c.providerId } : {}),
          ...(c.apiKeyRef ? { apiKeyRef: c.apiKeyRef } : {}),
          contextWindow: sp.contextWindow,
          maxTokens: sp.maxTokens,
          privacy: c.privacy,
          autoFallback: c.kind === "local",
          billing: bill,
        };
        const why = presetProblem(preset, { claude: true, antigravity: true }); // terms are checked per turn, not here
        if (why) {
          notes.push(`Web model "${sp.id}" is off: ${why}`);
          continue;
        }
        taken.add(sp.id);
        web.push({ preset, origin: "web", sourceId: sp.sourceId });
      }
    }
    entries = [...settingsEntries, ...web];
    sources = srcs;
    banners = notes;
    presets = entries.map((e) => e.preset);
  }

  function reloadSecurityFile(): boolean {
    let h: string;
    try {
      h = o.securityHash();
    } catch {
      h = "unreadable";
    }
    if (h === secHash) return false;
    secHash = h;
    try {
      snap = o.loadSecurity();
      secBad = false;
      audit({ kind: "models_reload", detail: { file: "security.json", ok: true } });
    } catch {
      secBad = true;
      audit({ kind: "models_reload", detail: { file: "security.json", ok: false } });
    }
    return true;
  }

  function reload(force: boolean): void {
    const a = reloadSecurityFile();
    const b = evaluateModels(force);
    if (a || b || force) rebuild();
  }

  evaluateModels(true);
  rebuild();

  const interval = o.intervalMs ?? 10_000;
  const timer =
    interval > 0
      ? setInterval(() => {
          try {
            reload(false);
          } catch {
            /* the next tick tries again */
          }
        }, interval)
      : undefined;
  timer?.unref();

  const keyFor = (source: ModelSource): string | undefined => {
    switch (source.keyRef) {
      case undefined:
        return undefined;
      case "proxyApiKey":
        return o.secrets.proxyApiKey;
      case "lmStudioApiToken":
        return o.secrets.lmStudioApiToken;
      case "strataApiKey":
        return o.secrets.strataApiKey;
      default: {
        const sealed = store.readKeys()?.keys[source.id];
        if (sealed === undefined) return undefined;
        try {
          return o.box.open(sealed, `webkey:${source.id}`);
        } catch {
          return undefined;
        }
      }
    }
  };

  function customEndpoint(e: CatalogEntry): ModelEndpoint | undefined {
    const p = e.preset;
    const src = sources.find((s) => s.id === e.sourceId);
    if (!src || src.kind !== "custom" || !p.baseUrl) return undefined;
    let apiKey: string | undefined;
    if (src.keyRef !== undefined) {
      apiKey = keyFor(src);
      if (apiKey === undefined) return undefined; // a keyed source without a usable key is not served (no key-less call to a paid host)
    }
    const baseUrl = p.baseUrl;
    const ep: ModelEndpoint = { baseUrl, apiKey, modelId: p.modelId, maxTokens: p.maxTokens, viaProxy: false, ...(isPaidPreset(p) ? { paid: true } : {}), label: p.label };
    // I60: a source on a host that is not a literal loopback one is checked before every request (https, no private address, own host only).
    // A loopback source marked "treat as cloud" is cloud for privacy but is the owner's own machine, so it has no SSRF check.
    if (!isLiteralLoopbackUrl(baseUrl)) {
      const host = new URL(baseUrl).hostname;
      ep.preflight = async () => {
        if (!baseUrl.startsWith("https://")) return "the provider URL is not https";
        const v = await checkUrl(baseUrl, [host], resolver);
        return v.ok ? undefined : `the provider address was refused (${v.reason})`;
      };
    }
    return ep;
  }

  return {
    presets: () => presets,
    terms: () => snap.terms,
    sources: () => sources,
    banners: () => [...banners],
    entries: () => entries,
    existing: () => entries.map((e) => ({ id: e.preset.id, sourceId: e.sourceId, modelId: e.preset.modelId })),
    stored: () => ({ state, doc: stored }),
    keyFor,
    reloadSecurity: () => reload(false),
    afterWrite: () => reload(true),
    endpoint(id) {
      const e = entries.find((x) => x.preset.id === id);
      if (!e) return undefined;
      return e.preset.kind === "custom" ? customEndpoint(e) : settingsEndpoint(snap.config, o.secrets, e.preset);
    },
    update<R>(fn: (draft: ModelsDraft) => R): R {
      reload(false);
      const base = state === "ok" ? (JSON.parse(JSON.stringify(stored)) as ModelsFile) : emptyModels();
      const sealedKeys: KeysFile = state === "ok" ? (store.readKeys() ?? emptyKeys()) : emptyKeys();
      const keys: Record<string, string> = {};
      for (const s of base.sources) {
        const k = sealedKeys.keys[s.id];
        if (k !== undefined) keys[s.id] = k;
        s.hasKey = k !== undefined;
      }
      const draft: ModelsDraft = {
        doc: base,
        keys: {
          set(sourceId, plain) {
            keys[sourceId] = o.box.seal(plain, `webkey:${sourceId}`);
            const s = draft.doc.sources.find((x) => x.id === sourceId);
            if (s) s.hasKey = true;
          },
          remove(sourceId) {
            delete keys[sourceId];
            const s = draft.doc.sources.find((x) => x.id === sourceId);
            if (s) s.hasKey = false;
          },
          has: (sourceId) => sourceId in keys,
        },
      };
      const result = fn(draft);
      for (const s of draft.doc.sources) s.hasKey = s.id in keys;
      for (const id of Object.keys(keys)) if (!draft.doc.sources.some((s) => s.id === id)) delete keys[id];
      const sha256 = store.write(draft.doc, { v: 1, keys });
      o.audit.write({ kind: "models_saved", detail: { sha256 } }); // not swallowed: without the line the file would read as tampered
      reload(true);
      return result;
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
