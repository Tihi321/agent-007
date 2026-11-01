/**
 * Strict stores of the Models page (plan agent-007-model-sources, MS2, D3, I60, I62): `<dataDir>\web\models.json` (custom sources and the
 * presets the owner ticked) and `<dataDir>\web\model-keys.json` (the keys of custom sources, sealed with `web.key`, see `SecretBox`).
 *
 *  - Parsing is strict: an unknown key, a wrong type or a value outside its limit rejects the WHOLE file (the catalogue then turns the
 *    web presets off, shows a banner and audits). Nothing is repaired.
 *  - Writes are atomic (`atomicWriteJson`) and return `sha256(models.json bytes)`; the caller audits `models_saved {sha256}`. At load a
 *    hash that differs from the last `models_saved` line of the audit means the file was changed outside the Models page.
 *  - `kind`, `privacy`, provider, key reference, runner and base URL of a preset are never stored (I59); a source's `baseUrl` is stored
 *    once and never edited (D9).
 * Pure file I/O: no network, no clock. The keys are opaque sealed strings here; sealing and opening is the catalogue's job.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRESET_ID_PATTERN } from "../../bots/schema.js";
import { BUILTIN_SOURCE_IDS, MODEL_ID_PATTERN, SOURCE_ID_PATTERN } from "../../models/sources.js";
import { sha256Hex } from "../crypto.js";
import { atomicWriteJson } from "../store.js";

export const MAX_CUSTOM_SOURCES = 8;
export const MAX_WEB_PRESETS = 64;
export const MAX_SOURCE_LABEL = 40;
export const MAX_PRESET_LABEL = 60;
export const MAX_BASE_URL = 300;
export const CONTEXT_WINDOW_MIN = 1024;
export const CONTEXT_WINDOW_MAX = 2_000_000;
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_CAP = 200_000;

export interface StoredSource {
  id: string;
  label: string;
  baseUrl: string;
  billing?: "subscription" | "paid";
  treatAsCloud?: boolean;
  hasKey: boolean;
}

export interface StoredPreset {
  id: string;
  sourceId: string;
  modelId: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  billing: "subscription" | "paid";
}

export interface ModelsFile {
  v: 1;
  sources: StoredSource[];
  presets: StoredPreset[];
}

export interface KeysFile {
  v: 1;
  keys: Record<string, string>;
}

export const emptyModels = (): ModelsFile => ({ v: 1, sources: [], presets: [] });
export const emptyKeys = (): KeysFile => ({ v: 1, keys: {} });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function exactKeys(o: Obj, required: readonly string[], optional: readonly string[], at: string): void {
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) throw new Error(`${at}: unknown key "${k.slice(0, 40)}"`);
  for (const k of required) if (!(k in o)) throw new Error(`${at}: missing "${k}"`);
}

function text(v: unknown, at: string, min: number, max: number): string {
  if (typeof v !== "string" || v.length < min || v.length > max || CONTROL.test(v)) throw new Error(`${at}: must be text of ${min} to ${max} characters without control characters`);
  return v;
}

function int(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${at}: must be an integer from ${min} to ${max}`);
  return v;
}

function billing(v: unknown, at: string): "subscription" | "paid" {
  if (v !== "subscription" && v !== "paid") throw new Error(`${at}: must be "subscription" or "paid"`);
  return v;
}

/** Max tokens bound for a context window (plan section 4): 256..min(contextWindow / 2, 200000). */
export const maxTokensLimit = (contextWindow: number): number => Math.min(Math.floor(contextWindow / 2), MAX_TOKENS_CAP);

function parseSource(v: unknown, i: number): StoredSource {
  const at = `sources[${i}]`;
  if (!isObj(v)) throw new Error(`${at}: must be an object`);
  exactKeys(v, ["id", "label", "baseUrl", "hasKey"], ["billing", "treatAsCloud"], at);
  const id = text(v["id"], `${at}.id`, 2, 12);
  if (!SOURCE_ID_PATTERN.test(id) || (BUILTIN_SOURCE_IDS as readonly string[]).includes(id)) throw new Error(`${at}.id: not a valid custom source id`);
  const baseUrl = text(v["baseUrl"], `${at}.baseUrl`, 8, MAX_BASE_URL);
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`${at}.baseUrl: not a URL`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") throw new Error(`${at}.baseUrl: http(s) without credentials, query or fragment`);
  if (typeof v["hasKey"] !== "boolean") throw new Error(`${at}.hasKey: must be true or false`);
  if ("treatAsCloud" in v && typeof v["treatAsCloud"] !== "boolean") throw new Error(`${at}.treatAsCloud: must be true or false`);
  return {
    id,
    label: text(v["label"], `${at}.label`, 1, MAX_SOURCE_LABEL),
    baseUrl,
    hasKey: v["hasKey"],
    ...("billing" in v ? { billing: billing(v["billing"], `${at}.billing`) } : {}),
    ...("treatAsCloud" in v ? { treatAsCloud: v["treatAsCloud"] as boolean } : {}),
  };
}

function parsePreset(v: unknown, i: number): StoredPreset {
  const at = `presets[${i}]`;
  if (!isObj(v)) throw new Error(`${at}: must be an object`);
  exactKeys(v, ["id", "sourceId", "modelId", "label", "contextWindow", "maxTokens", "billing"], [], at);
  const id = text(v["id"], `${at}.id`, 1, 24);
  if (!PRESET_ID_PATTERN.test(id)) throw new Error(`${at}.id: not a valid preset id`);
  const modelId = text(v["modelId"], `${at}.modelId`, 1, 128);
  if (!MODEL_ID_PATTERN.test(modelId)) throw new Error(`${at}.modelId: not a valid model id`);
  const contextWindow = int(v["contextWindow"], `${at}.contextWindow`, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX);
  return {
    id,
    sourceId: text(v["sourceId"], `${at}.sourceId`, 2, 12),
    modelId,
    label: text(v["label"], `${at}.label`, 1, MAX_PRESET_LABEL),
    contextWindow,
    maxTokens: int(v["maxTokens"], `${at}.maxTokens`, MAX_TOKENS_MIN, maxTokensLimit(contextWindow)),
    billing: billing(v["billing"], `${at}.billing`),
  };
}

/** Strict parse of `models.json`. Throws an `Error` with a content-free message (no value is echoed beyond a 40-char key name). */
export function parseModelsFile(raw: unknown): ModelsFile {
  if (!isObj(raw)) throw new Error("the file must be an object");
  exactKeys(raw, ["v", "sources", "presets"], [], "models.json");
  if (raw["v"] !== 1) throw new Error("v must be 1");
  if (!Array.isArray(raw["sources"]) || raw["sources"].length > MAX_CUSTOM_SOURCES) throw new Error(`sources: an array of at most ${MAX_CUSTOM_SOURCES}`);
  if (!Array.isArray(raw["presets"]) || raw["presets"].length > MAX_WEB_PRESETS) throw new Error(`presets: an array of at most ${MAX_WEB_PRESETS}`);
  const sources = raw["sources"].map(parseSource);
  const presets = raw["presets"].map(parsePreset);
  const sourceIds = new Set<string>();
  for (const s of sources) {
    if (sourceIds.has(s.id)) throw new Error("sources: duplicate id");
    sourceIds.add(s.id);
  }
  const presetIds = new Set<string>();
  for (const p of presets) {
    if (presetIds.has(p.id)) throw new Error("presets: duplicate id");
    presetIds.add(p.id);
    if (!sourceIds.has(p.sourceId) && !(BUILTIN_SOURCE_IDS as readonly string[]).includes(p.sourceId)) throw new Error("presets: unknown source");
  }
  return { v: 1, sources, presets };
}

const SEALED = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{0,4096}$/;

/** Strict parse of `model-keys.json`: `{v: 1, keys: {<sourceId>: <sealed value>}}`. */
export function parseKeysFile(raw: unknown): KeysFile {
  if (!isObj(raw)) throw new Error("the file must be an object");
  exactKeys(raw, ["v", "keys"], [], "model-keys.json");
  if (raw["v"] !== 1) throw new Error("v must be 1");
  const k = raw["keys"];
  if (!isObj(k) || Object.keys(k).length > MAX_CUSTOM_SOURCES) throw new Error(`keys: an object of at most ${MAX_CUSTOM_SOURCES}`);
  const keys: Record<string, string> = {};
  for (const [id, sealed] of Object.entries(k)) {
    if (!SOURCE_ID_PATTERN.test(id) || typeof sealed !== "string" || !SEALED.test(sealed)) throw new Error("keys: a bad entry");
    keys[id] = sealed;
  }
  return { v: 1, keys };
}

export type ModelsRead = { ok: true; doc: ModelsFile; hash: string } | { ok: false; error: string; hash: string };

export interface ModelsStoreOptions {
  modelsFile: string;
  keysFile: string;
  /** `<dataDir>\web-audit`: read to find the last `models_saved` line. */
  auditDir: string;
}

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

export class ModelsStore {
  readonly #o: ModelsStoreOptions;
  constructor(o: ModelsStoreOptions) {
    this.#o = o;
  }

  /** `models.json`: missing = the empty document with hash `""`. A file that does not parse or validate is `{ok: false}`. */
  readModels(): ModelsRead {
    let bytes: Buffer | undefined;
    try {
      bytes = readFileSync(this.#o.modelsFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, doc: emptyModels(), hash: "" };
      return { ok: false, error: "the file cannot be read", hash: "unreadable" };
    }
    const hash = sha256Hex(bytes);
    try {
      return { ok: true, doc: parseModelsFile(JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""))), hash };
    } catch (e) {
      return { ok: false, error: e instanceof SyntaxError ? "not valid JSON" : e instanceof Error ? e.message : "invalid", hash };
    }
  }

  /** `model-keys.json`: missing = empty. Invalid = `undefined` (no key is usable; a source with `hasKey` then has no endpoint). */
  readKeys(): KeysFile | undefined {
    try {
      const t = readText(this.#o.keysFile);
      return t === undefined ? emptyKeys() : parseKeysFile(JSON.parse(t.replace(/^﻿/, "")));
    } catch {
      return undefined;
    }
  }

  /** The sha256 of the last `models_saved` audit line (newest file first), or undefined when there is none. */
  lastSavedHash(): string | undefined {
    let files: string[];
    try {
      files = readdirSync(this.#o.auditDir).filter((f) => /^web-\d{6}\.jsonl$/.test(f)).sort().reverse();
    } catch {
      return undefined;
    }
    for (const f of files) {
      let body: string | undefined;
      try {
        body = readText(join(this.#o.auditDir, f));
      } catch {
        continue;
      }
      if (body === undefined || !body.includes('"models_saved"')) continue;
      const lines = body.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] as string;
        if (!line.includes('"models_saved"')) continue;
        try {
          const e = JSON.parse(line) as { kind?: unknown; detail?: { sha256?: unknown } };
          if (e.kind === "models_saved" && typeof e.detail?.sha256 === "string") return e.detail.sha256;
        } catch {
          /* a damaged line is skipped */
        }
      }
    }
    return undefined;
  }

  /**
   * Validates (strictly, plus: `hasKey` matches the keys, every key belongs to a source), then writes the keys file and the models
   * file atomically, keys first. Returns `sha256` of the bytes of `models.json`. The caller audits `models_saved`.
   */
  write(models: ModelsFile, keys: KeysFile): string {
    const m = parseModelsFile(JSON.parse(JSON.stringify(models)));
    const k = parseKeysFile(JSON.parse(JSON.stringify(keys)));
    for (const s of m.sources) if (s.hasKey !== (s.id in k.keys)) throw new Error(`source "${s.id}": hasKey does not match the stored keys`);
    for (const id of Object.keys(k.keys)) if (!m.sources.some((s) => s.id === id)) throw new Error("keys: a key without a source");
    atomicWriteJson(this.#o.keysFile, k);
    atomicWriteJson(this.#o.modelsFile, m);
    return sha256Hex(JSON.stringify(m, null, 2));
  }
}
