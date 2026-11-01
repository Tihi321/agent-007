/**
 * prefs.json (S17.1, I29c): small, agent-writable (through approved proposals only), and ALWAYS read back as untrusted input.
 * It is validated against the schema at every load; an invalid file falls back to the defaults with a warning, and a forged
 * file can never widen anything (it holds no permission, only `style` and `defaultPersona`).
 *
 * `PrefsStore` re-reads the file when its size or mtime changes.
 *
 * Pure subset (node:fs only).
 */
import { statSync } from "node:fs";
import { validate } from "./jsonschema.js";
import type { Schema } from "./jsonschema.js";
import { PREFS_SCHEMA } from "./schema.js";
import { readTextIfExists, revisionOf } from "./store.js";

export interface Prefs {
  style: { tone: string; verbosity: string; language: string; notes: string };
  defaultPersona: string;
  [extra: string]: unknown;
}

export function defaultPrefs(): Prefs {
  return { style: { tone: "neutral", verbosity: "short", language: "en", notes: "" }, defaultPersona: "default" };
}

export interface LoadedPrefs {
  prefs: Prefs;
  /** `sha256(file text)`; the empty-text revision when the file does not exist. */
  revision: string;
  /** The file text as read (undefined: no file). */
  text: string | undefined;
  /** True when the file existed but was invalid, so the defaults are in use. */
  fellBack: boolean;
  warning?: string;
}

function mergeDefaults(raw: Record<string, unknown>): Prefs {
  const d = defaultPrefs();
  const style = typeof raw["style"] === "object" && raw["style"] !== null ? (raw["style"] as Record<string, unknown>) : {};
  return {
    ...raw,
    style: { ...d.style, ...style } as Prefs["style"],
    defaultPersona: typeof raw["defaultPersona"] === "string" ? raw["defaultPersona"] : d.defaultPersona,
  };
}

/** Parses prefs text. An invalid or unreadable document gives the defaults and a warning (never a throw). */
export function parsePrefsText(text: string | undefined, schema: Schema = PREFS_SCHEMA): LoadedPrefs {
  const revision = revisionOf(text);
  if (text === undefined || text.trim() === "") return { prefs: defaultPrefs(), revision, text, fellBack: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { prefs: defaultPrefs(), revision, text, fellBack: true, warning: "prefs.json is not valid JSON; using the defaults" };
  }
  const issues = validate(schema, raw);
  if (issues.length > 0) {
    return { prefs: defaultPrefs(), revision, text, fellBack: true, warning: `prefs.json is invalid (${issues[0]?.path}: ${issues[0]?.message}); using the defaults` };
  }
  return { prefs: mergeDefaults(raw as Record<string, unknown>), revision, text, fellBack: false };
}

export function loadPrefsFile(file: string, schema: Schema = PREFS_SCHEMA): LoadedPrefs {
  let text: string | undefined;
  try {
    text = readTextIfExists(file);
  } catch {
    return { prefs: defaultPrefs(), revision: revisionOf(undefined), text: undefined, fellBack: true, warning: "prefs.json cannot be read; using the defaults" };
  }
  return parsePrefsText(text, schema);
}

export class PrefsStore {
  readonly #file: string;
  readonly #schema: Schema;
  readonly #onWarning: ((w: string) => void) | undefined;
  #sig = "";
  #cached: LoadedPrefs | undefined;
  #warned = "";

  constructor(file: string, opts: { schema?: Schema; onWarning?: (w: string) => void } = {}) {
    this.#file = file;
    this.#schema = opts.schema ?? PREFS_SCHEMA;
    this.#onWarning = opts.onWarning;
  }

  get file(): string {
    return this.#file;
  }

  /** The current prefs, re-read when the file's size or mtime changed (or it appeared or vanished). */
  get(): LoadedPrefs {
    let sig = "absent";
    try {
      const st = statSync(this.#file);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      sig = "absent";
    }
    if (this.#cached === undefined || sig !== this.#sig) {
      this.#cached = loadPrefsFile(this.#file, this.#schema);
      this.#sig = sig;
      if (this.#cached.warning && this.#cached.warning !== this.#warned) {
        this.#warned = this.#cached.warning;
        this.#onWarning?.(this.#cached.warning);
      }
    }
    return this.#cached;
  }

  /** Forces a re-read at the next `get()`. */
  invalidate(): void {
    this.#sig = "";
  }
}
