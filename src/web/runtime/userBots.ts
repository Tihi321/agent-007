/**
 * User bots (S33, section 4): records under `users\<userId>\bots\<id>\bot.json`, validated with a HARD-CODED ceiling that no client field
 * can move. What a client can set: name, tagline, avatar (preset gallery, UI-42), persona text, a model preset and a local fallback from
 * the user's caps, a tool subset of the user's caps, memory on or off, starter prompts. What it can never set (unknown fields are an
 * error): read roots (always only the bot's workspace and the user's uploads), shared folders (none), edges (none, so no `ask_bot`), a
 * Telegram token (web only), any tool outside the non-owner universe.
 *
 * `UserBotRegistry` is the second registration source of the milestone plan (`registerUserBot`): runtime ids are `u:<userId>:<botId>`, which
 * the owner bot id pattern cannot produce, so the two namespaces cannot collide and the owner BotBus (built from owner bots only) cannot
 * address a user bot.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { PRESET_ID_PATTERN } from "../../bots/schema.js";
import type { PresetConfig, TermsAccepted } from "../../bots/schema.js";
import { presetProblem } from "../../models/presets.js";
import type { WebAudit } from "../audit.js";
import { USER_ALWAYS_LOADED_MAX, USER_TOOL_UNIVERSE } from "../capabilities.js";
import { isWebBotId, runtimeBotId } from "../ids.js";
import { userPaths } from "../paths.js";
import type { Caps } from "../schemas.js";
import { atomicWriteJson } from "../store.js";

export const AVATARS = ["robot", "fox", "owl", "cat", "planet", "leaf", "bolt", "book"] as const;
export const MAX_PERSONA = 4000;

export interface UserBotConfig {
  name: string;
  tagline: string;
  avatar: string;
  persona: string;
  preset: string;
  fallback?: string;
  tools: string[];
  memory: boolean;
  starters: string[];
  createdAt: number;
  updatedAt: number;
}

export type UserBotInput = Omit<UserBotConfig, "createdAt" | "updatedAt">;

export class UserBotError extends Error {
  readonly issues: string[];
  readonly status: number;
  constructor(issues: string[], status = 400) {
    super(issues[0] ?? "invalid bot");
    this.name = "UserBotError";
    this.issues = issues;
    this.status = status;
  }
}

const ALLOWED_KEYS = ["name", "tagline", "avatar", "persona", "preset", "fallback", "tools", "memory", "starters"];
const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

export interface ValidationContext {
  caps: Caps;
  presets: readonly PresetConfig[];
  terms: TermsAccepted;
}

export function validateUserBot(input: unknown, ctx: ValidationContext): { ok: true; bot: UserBotInput; warnings: string[] } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, issues: ["the bot must be an object"] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.includes(k)) issues.push(`${k.slice(0, 30)}: this field cannot be set (it is fixed by the system)`);
  const text = (k: string, max: number, min = 0): string => {
    const v = o[k];
    if (v === undefined && min === 0) return "";
    if (typeof v !== "string") {
      issues.push(`${k}: must be text`);
      return "";
    }
    const c = clean(v).trim();
    if (c.length < min || c.length > max) issues.push(`${k}: must be ${min} to ${max} characters`);
    return c;
  };
  const name = text("name", 40, 1);
  const tagline = text("tagline", 80);
  const persona = text("persona", MAX_PERSONA);
  const avatar = o["avatar"] === undefined ? AVATARS[0] : String(o["avatar"]);
  if (!(AVATARS as readonly string[]).includes(avatar)) issues.push(`avatar: pick one of ${AVATARS.join(", ")}`);
  const preset = typeof o["preset"] === "string" ? o["preset"] : "";
  const find = (id: string): PresetConfig | undefined => ctx.presets.find((p) => p.id === id);
  if (!PRESET_ID_PATTERN.test(preset) || !ctx.caps.presets.includes(preset)) issues.push("preset: not one of the models you may use");
  else {
    const p = find(preset);
    if (!p) issues.push("preset: that model is not configured");
    else {
      const why = presetProblem(p, ctx.terms);
      if (why) issues.push(`preset: ${why}`);
    }
  }
  let fallback: string | undefined;
  if (o["fallback"] !== undefined && o["fallback"] !== "") {
    fallback = typeof o["fallback"] === "string" ? o["fallback"] : "";
    const p = find(fallback);
    if (!ctx.caps.presets.includes(fallback) || !p) issues.push("fallback: not one of the models you may use");
    else if (p.privacy !== "local") issues.push("fallback: must be a local model (a cloud fallback would widen where your data goes)");
    else if (fallback === preset) issues.push("fallback: must differ from the main model");
  } else if (find(preset)?.privacy === "cloud") warnings.push("This bot has no local fallback: it is offline while the cloud model is unavailable.");
  const toolsIn = o["tools"] === undefined ? ["tool_search"] : o["tools"];
  const tools: string[] = [];
  if (!Array.isArray(toolsIn)) issues.push("tools: must be a list");
  else {
    for (const t of toolsIn) {
      if (typeof t !== "string" || !USER_TOOL_UNIVERSE.includes(t)) issues.push(`tools: "${String(t).slice(0, 40)}" does not exist for user bots`);
      else if (!ctx.caps.tools.includes(t)) issues.push(`tools: "${t}" is not allowed for your account`);
      else if (!tools.includes(t)) tools.push(t);
    }
    if (tools.length > USER_ALWAYS_LOADED_MAX) issues.push(`tools: at most ${USER_ALWAYS_LOADED_MAX}`);
  }
  if (o["memory"] !== undefined && typeof o["memory"] !== "boolean") issues.push("memory: must be true or false");
  const startersIn = o["starters"] === undefined ? [] : o["starters"];
  const starters: string[] = [];
  if (!Array.isArray(startersIn) || startersIn.length > 5) issues.push("starters: a list of at most 5");
  else for (const s of startersIn) typeof s === "string" && clean(s).trim().length >= 1 && clean(s).trim().length <= 120 ? starters.push(clean(s).trim()) : issues.push("starters: each is 1 to 120 characters");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, warnings, bot: { name, tagline, avatar, persona, preset, ...(fallback ? { fallback } : {}), tools, memory: o["memory"] === true, starters } };
}

function slug(name: string, taken: ReadonlySet<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  if (!/^[a-z]/.test(base)) base = `bot-${base}`.replace(/-+$/g, "");
  if (base.length < 2) base = "bot";
  let id = base.slice(0, 23);
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 20)}-${i}`;
  return id;
}

export interface UserBotStoreOptions {
  dataDir: string;
  userId: string;
  caps: () => Caps;
  presets: () => readonly PresetConfig[];
  terms: () => TermsAccepted;
  audit: WebAudit;
  now?: () => number;
}

/** The bots of ONE user. The userId is fixed at construction from the session; no method takes another user's id (I47). */
export class UserBotStore {
  readonly #o: UserBotStoreOptions;
  readonly #now: () => number;
  constructor(o: UserBotStoreOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  #paths() {
    return userPaths(this.#o.dataDir, this.#o.userId);
  }

  ids(): string[] {
    const dir = this.#paths().botsDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && isWebBotId(e.name) && existsSync(this.#paths().bot(e.name).botFile)).map((e) => e.name).sort();
  }

  get(botId: string): UserBotConfig | undefined {
    if (!isWebBotId(botId)) return undefined;
    const f = this.#paths().bot(botId).botFile;
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as UserBotConfig;
    } catch {
      return undefined;
    }
  }

  list(): { id: string; bot: UserBotConfig }[] {
    return this.ids().flatMap((id) => {
      const bot = this.get(id);
      return bot ? [{ id, bot }] : [];
    });
  }

  create(input: unknown): { id: string; bot: UserBotConfig; warnings: string[] } {
    const caps = this.#o.caps();
    const ids = this.ids();
    if (ids.length >= caps.maxBots) throw new UserBotError([`You can have at most ${caps.maxBots} bots.`], 403);
    const v = validateUserBot(input, { caps, presets: this.#o.presets(), terms: this.#o.terms() });
    if (!v.ok) throw new UserBotError(v.issues);
    const id = slug(v.bot.name, new Set(ids));
    const t = this.#now();
    const bot: UserBotConfig = { ...v.bot, createdAt: t, updatedAt: t };
    const p = this.#paths().bot(id);
    for (const d of [p.root, p.stateDir, p.memoryDir, p.skillsDir, p.workspaceDir, p.logsDir]) mkdirSync(d, { recursive: true });
    mkdirSync(this.#paths().uploadsDir, { recursive: true });
    atomicWriteJson(p.botFile, bot);
    this.#o.audit.write({ kind: "bot_create", user: this.#o.userId, detail: { bot: id, preset: bot.preset } });
    return { id, bot, warnings: v.warnings };
  }

  update(botId: string, input: unknown): { bot: UserBotConfig; warnings: string[] } {
    const old = this.get(botId);
    if (!old) throw new UserBotError(["No such bot."], 404);
    const v = validateUserBot(input, { caps: this.#o.caps(), presets: this.#o.presets(), terms: this.#o.terms() });
    if (!v.ok) throw new UserBotError(v.issues);
    const bot: UserBotConfig = { ...v.bot, createdAt: old.createdAt, updatedAt: this.#now() };
    atomicWriteJson(this.#paths().bot(botId).botFile, bot);
    this.#o.audit.write({ kind: "bot_edit", user: this.#o.userId, detail: { bot: botId, preset: bot.preset } });
    return { bot, warnings: v.warnings };
  }

  delete(botId: string): void {
    if (!this.get(botId)) throw new UserBotError(["No such bot."], 404);
    rmSync(this.#paths().bot(botId).root, { recursive: true, force: true });
    rmSync(this.#paths().threadsDir + "\\" + botId, { recursive: true, force: true });
    this.#o.audit.write({ kind: "bot_delete", user: this.#o.userId, detail: { bot: botId } });
  }
}

// ---- runtime registration -------------------------------------------------------------------------------------------------

export interface RuntimeUserBot {
  runtimeId: string;
  userId: string;
  botId: string;
  name: string;
  persona: string;
  route: { primary: string; allowed: string[]; fallback: string[]; onAuthRequired: "fallback" };
  tools: readonly string[];
  memory: boolean;
  memoryFile: string;
  /** Always exactly the bot's workspace (read and write) and the user's uploads (read only). */
  readRoots: readonly { alias: "workspace" | "uploads"; dir: string; writable: boolean }[];
  readonly edges: readonly [];
  readonly shared: { readonly read: false };
  readonly telegramTokenRef: undefined;
}

export function toRuntimeBot(dataDir: string, userId: string, botId: string, cfg: UserBotConfig): RuntimeUserBot {
  const up = userPaths(dataDir, userId);
  const bp = up.bot(botId);
  return {
    runtimeId: runtimeBotId(userId, botId),
    userId,
    botId,
    name: cfg.name,
    persona: cfg.persona,
    route: { primary: cfg.preset, allowed: cfg.fallback ? [cfg.preset, cfg.fallback] : [cfg.preset], fallback: cfg.fallback ? [cfg.fallback] : [], onAuthRequired: "fallback" },
    tools: [...cfg.tools],
    memory: cfg.memory,
    memoryFile: bp.memoryFile,
    readRoots: [
      { alias: "workspace", dir: bp.workspaceDir, writable: true },
      { alias: "uploads", dir: up.uploadsDir, writable: false },
    ],
    edges: [],
    shared: { read: false },
    telegramTokenRef: undefined,
  };
}

export class UserBotRegistry {
  readonly #bots = new Map<string, RuntimeUserBot>();

  /** The second registration source: a user's bot, under its namespaced id. Re-registering the same bot replaces it; a collision is impossible by construction. */
  registerUserBot(dataDir: string, userId: string, botId: string, cfg: UserBotConfig): RuntimeUserBot {
    const bot = toRuntimeBot(dataDir, userId, botId, cfg);
    this.#bots.set(bot.runtimeId, bot);
    return bot;
  }

  get(runtimeId: string): RuntimeUserBot | undefined {
    return this.#bots.get(runtimeId);
  }

  /** The bots of ONE user. */
  forUser(userId: string): RuntimeUserBot[] {
    return [...this.#bots.values()].filter((b) => b.userId === userId);
  }

  unregister(runtimeId: string): void {
    this.#bots.delete(runtimeId);
  }

  unregisterUser(userId: string): void {
    for (const b of this.forUser(userId)) this.#bots.delete(b.runtimeId);
  }

  all(): RuntimeUserBot[] {
    return [...this.#bots.values()];
  }
}
