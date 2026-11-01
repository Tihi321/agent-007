/**
 * The writable-path allowlist (S17.3, I29d, I26a). A CODE TABLE of rows `{path, schema, class, proposable, telegram, classify?}`.
 * There is NO row of security class, so a `security.json` path is "not writable" by construction (a test walks every key path of
 * the security schema and checks each is refused). Paths are matched segment by segment; `__proto__`, `constructor`,
 * `prototype`, empty segments and array indexes are refused; values are applied to a COPY, never by assigning a user key on a
 * plain object. Phase 4's S20 adds ONE ROW PER CONFIGURED BOT for `bots.<id>.activePreset` (`src/bots/rows.ts`, wired with `withRows`;
 * a row per bot, not a `*` wildcard, so a bot that does not exist can never be written and each row knows its bot's `allowed` list),
 * and no row for any other `bots.*` or `presets` path.
 *
 * Pure subset.
 */
import type { Classification, RowClass } from "./contracts.js";
import { SettingsError } from "./contracts.js";
import { validate } from "./jsonschema.js";
import type { Schema } from "./jsonschema.js";
import { looksSecret } from "./secretShape.js";
import { PREFS_SCHEMA, STYLE_TONES, STYLE_VERBOSITY } from "./schema.js";

export interface ClassifyContext {
  autoApplyCosmetic: boolean;
}

export interface AllowRow {
  /** Dotted segments; `*` matches exactly one segment (for example `bots.*.activePreset`). */
  path: string;
  label: string;
  schema: Schema;
  class: RowClass;
  proposable: boolean;
  /** Reachable from the `/settings` buttons (fixed choices only; there is no free-text input). */
  telegram: boolean;
  /** Fixed button choices for the Telegram menu; `"personas"` means the valid persona ids. */
  choices?: readonly string[] | "personas";
  /** A row's own rule. Default: `card`, or `auto` for a `cosmetic` row only when `autoApplyCosmetic` is on. */
  classify?: (before: unknown, after: unknown, ctx: ClassifyContext) => Classification;
}

const SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function sub(path: readonly string[]): Schema {
  let s: Schema = PREFS_SCHEMA;
  for (const seg of path) {
    const next = s.properties?.[seg];
    if (!next) throw new Error(`allowlist: no prefs schema for ${path.join(".")}`);
    s = next;
  }
  return s;
}

export const DEFAULT_ROWS: readonly AllowRow[] = [
  { path: "style.tone", label: "Tone", schema: sub(["style", "tone"]), class: "cosmetic", proposable: true, telegram: true, choices: STYLE_TONES },
  { path: "style.verbosity", label: "Verbosity", schema: sub(["style", "verbosity"]), class: "cosmetic", proposable: true, telegram: true, choices: STYLE_VERBOSITY },
  { path: "style.language", label: "Language", schema: sub(["style", "language"]), class: "pref", proposable: true, telegram: true, choices: ["en", "de", "fr", "es", "it", "hr", "pt", "nl"] },
  { path: "style.notes", label: "Style notes", schema: sub(["style", "notes"]), class: "pref", proposable: true, telegram: false },
  { path: "defaultPersona", label: "Default persona", schema: sub(["defaultPersona"]), class: "user-only", proposable: false, telegram: true, choices: "personas" },
];

/** Splits a model-supplied path into safe segments, or throws `not_writable`. */
export function parseSettingPath(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) throw new SettingsError("not_writable", "that setting path is not writable");
  const segs = path.split(".");
  for (const s of segs) {
    if (!SEGMENT.test(s) || FORBIDDEN.has(s)) throw new SettingsError("not_writable", "that setting path is not writable");
  }
  return segs;
}

export function matchRow(row: AllowRow, segs: readonly string[]): boolean {
  const rs = row.path.split(".");
  if (rs.length !== segs.length) return false;
  return rs.every((r, i) => r === "*" || r === segs[i]);
}

export function findRow(rows: readonly AllowRow[], segs: readonly string[]): AllowRow | undefined {
  return rows.find((r) => matchRow(r, segs));
}

export function getAt(doc: unknown, segs: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const s of segs) {
    if (typeof cur !== "object" || cur === null || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** A copy of `doc` with `value` set at `segs`. The segments were already checked; `defineProperty` never runs a setter. */
export function applyToCopy<T extends Record<string, unknown>>(doc: T, segs: readonly string[], value: unknown): T {
  const copy = structuredClone(doc) as Record<string, unknown>;
  let cur = copy;
  segs.forEach((s, i) => {
    if (FORBIDDEN.has(s) || !SEGMENT.test(s)) throw new SettingsError("not_writable", "that setting path is not writable");
    if (i === segs.length - 1) {
      Object.defineProperty(cur, s, { value, enumerable: true, writable: true, configurable: true });
      return;
    }
    const next = Object.prototype.hasOwnProperty.call(cur, s) ? cur[s] : undefined;
    if (typeof next === "object" && next !== null && !Array.isArray(next)) cur = next as Record<string, unknown>;
    else {
      const fresh: Record<string, unknown> = {};
      Object.defineProperty(cur, s, { value: fresh, enumerable: true, writable: true, configurable: true });
      cur = fresh;
    }
  });
  return copy as T;
}

/** Checks a proposed value: the row's schema, then the secret shape. Throws `invalid_value` or `secret_shaped`. */
export function checkValue(row: AllowRow, value: unknown): void {
  const issues = validate(row.schema, value, row.path);
  if (issues.length > 0) throw new SettingsError("invalid_value", issues.map((i) => i.message).join("; "));
  if (typeof value === "string" && looksSecret(value)) throw new SettingsError("secret_shaped", "that value looks like a secret and is never stored");
  if (value !== null && typeof value === "object" && looksSecret(JSON.stringify(value))) throw new SettingsError("secret_shaped", "that value looks like a secret and is never stored");
}

export function classify(row: AllowRow, before: unknown, after: unknown, ctx: ClassifyContext): Classification {
  if (row.classify) return row.classify(before, after, ctx);
  if (row.class === "cosmetic" && ctx.autoApplyCosmetic) return "auto";
  return "card";
}

export function telegramRows(rows: readonly AllowRow[] = DEFAULT_ROWS): AllowRow[] {
  return rows.filter((r) => r.telegram);
}

/** Adds rows (Phase 4). A duplicate path is refused. */
export function withRows(base: readonly AllowRow[], extra: readonly AllowRow[]): AllowRow[] {
  const have = new Set(base.map((r) => r.path));
  for (const r of extra) if (have.has(r.path)) throw new Error(`allowlist: duplicate row ${r.path}`);
  return [...base, ...extra];
}
