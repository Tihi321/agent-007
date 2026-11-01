/**
 * Owner routes of the Models page (plan agent-007-model-sources, MS4, section 4, I56, I59, I60, I61).
 *
 * Every route is `auth: "owner"`; every write also needs a fresh step-up. Kind, privacy, provider, key reference and base URL of a preset
 * are never read from the client: `presets/add` re-classifies from the SOURCE and the model id (I59) and ignores every field it does not
 * list. A key is sealed by the catalogue and never echoed, logged or audited. The audit lines carry ids and counts only.
 *
 * Answers: `{error, message}` on a refusal (a preset or source in use: 409 `{error: "in_use", message, bots: [{user, bot}]}`).
 */
import { lookup } from "node:dns/promises";
import { isPaidPreset } from "../../bots/schema.js";
import type { PresetConfig } from "../../bots/schema.js";
import { BUILTIN_SOURCE_IDS, MODEL_ID_PATTERN, SOURCE_ID_PATTERN, classify, derivePrivacy, findExistingPreset, groupOf, isLiteralLoopbackUrl, isSetUp, presetIdFor } from "../../models/sources.js";
import type { ExistingPreset, FetchedRow, ModelSource } from "../../models/sources.js";
import type { AuthMethod } from "../../proxy/health.js";
import type { WebAudit } from "../audit.js";
import type { ChatService } from "../chat/service.js";
import { ERR_RATE_LIMIT, fetchModels } from "../models/fetch.js";
import type { FetchFn } from "../models/fetch.js";
import type { PresetCatalog } from "../models/catalog.js";
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, MAX_BASE_URL, MAX_CUSTOM_SOURCES, MAX_PRESET_LABEL, MAX_SOURCE_LABEL, MAX_TOKENS_MIN, MAX_WEB_PRESETS, maxTokensLimit } from "../models/store.js";
import { chainOf } from "../runtime/route.js";
import { checkUrl } from "../runtime/ssrf.js";
import type { Resolver } from "../runtime/ssrf.js";
import type { RouteCtx, RouteDef, RouteResult } from "../server.js";
import type { WebStack } from "../stack.js";
import { guarded } from "./auth.js";

export const MAX_ADD_MODELS = 50;
export const MAX_API_KEY = 512;
export const READ_ONLY = "That model comes from the settings UI and is read-only here.";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KEY_BAD = /[\u0000- \u007f-\u009f]/;

/** Test seams: a fake fetch, DNS resolver, clock and rate-limit map. Production passes none of them. */
export interface ModelsRouteDeps {
  fetch?: FetchFn;
  resolver?: Resolver;
  now?: () => number;
  lastFetch?: Map<string, number>;
}

export interface ModelsRoutesOptions extends ModelsRouteDeps {
  stack: WebStack;
  chat: ChatService;
  catalog: PresetCatalog;
  audit: WebAudit;
}

class ModelsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const bad = (message: string): ModelsError => new ModelsError(400, "bad_request", message);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function models(fn: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  return guarded(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ModelsError) return { status: e.status, body: { error: e.code, message: e.message, ...e.extra } };
      throw e;
    }
  });
}

function body(c: RouteCtx): Record<string, unknown> {
  if (!isObj(c.body)) throw bad("The request body must be a JSON object.");
  return c.body;
}

function text(v: unknown, what: string, min: number, max: number): string {
  if (typeof v !== "string") throw bad(`${what} must be text.`);
  const t = v.replace(CONTROL, "").trim();
  if (t.length < min || t.length > max) throw bad(`${what} must be ${min} to ${max} characters.`);
  return t;
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}

function billingOf(v: unknown): "subscription" | "paid" {
  if (v !== "subscription" && v !== "paid") throw bad('Billing must be "subscription" or "paid".');
  return v;
}

const joinList = (xs: readonly string[]): string => xs.join(",").slice(0, 400);

export function modelsRoutes(o: ModelsRoutesOptions): Record<string, RouteDef> {
  const { stack, chat, catalog } = o;
  const resolver = o.resolver;
  const audit = (e: Parameters<WebAudit["write"]>[0]): void => {
    try {
      o.audit.write(e);
    } catch {
      /* an audit failure never changes the answer of a route that already acted */
    }
  };
  const me = (c: RouteCtx): string => c.session?.userId ?? "";
  // what the last fetch of each source returned (for "add by id" and the LM Studio context hint) and the proxy's login methods
  const lastRows = new Map<string, Map<string, FetchedRow>>();
  let proxyAuth: Record<string, AuthMethod> | undefined;
  const lastFetch = o.lastFetch ?? new Map<string, number>();

  const sourceOf = (id: unknown): ModelSource => {
    const s = typeof id === "string" ? catalog.sources().find((x) => x.id === id) : undefined;
    if (!s) throw new ModelsError(404, "not_found", "No such source.");
    return s;
  };

  /** Every user's bots whose chain names one of these presets (D8). */
  function botsUsing(ids: ReadonlySet<string>): { user: string; bot: string }[] {
    const out: { user: string; bot: string }[] = [];
    for (const [userId, u] of Object.entries(stack.users.read().users)) {
      let list: ReturnType<ReturnType<ChatService["bots"]>["list"]>;
      try {
        list = chat.bots(userId).list();
      } catch {
        continue; // an unreadable bot folder holds no bot we could name
      }
      for (const { bot } of list) if (chainOf(bot).some((p) => ids.has(p))) out.push({ user: u.login, bot: bot.name });
    }
    return out;
  }

  function usedByCount(): Map<string, number> {
    const n = new Map<string, number>();
    for (const [userId] of Object.entries(stack.users.read().users)) {
      try {
        for (const { bot } of chat.bots(userId).list()) for (const p of chainOf(bot)) n.set(p, (n.get(p) ?? 0) + 1);
      } catch {
        /* skip */
      }
    }
    return n;
  }

  const inUse = (bots: { user: string; bot: string }[], what: string): ModelsError =>
    new ModelsError(409, "in_use", `${what} is used by ${bots.length} ${bots.length === 1 ? "bot" : "bots"}. Remove it anyway to make their chats fall back or be refused.`, { bots: bots.slice(0, 100) });

  function copyJson(p: PresetConfig): string | undefined {
    if (p.kind === "custom") return undefined;
    const doc: Record<string, unknown> = { id: p.id, kind: p.kind, label: p.label.slice(0, 60), ...(p.runner ? { runner: p.runner } : {}), ...(p.kind === "acp" ? { baseUrl: p.baseUrl, providerId: p.providerId, apiKeyRef: p.apiKeyRef } : {}), modelId: p.modelId, contextWindow: p.contextWindow, maxTokens: p.maxTokens, privacy: p.privacy, ...(isPaidPreset(p) ? { billing: "paid" } : {}) };
    return JSON.stringify(doc, null, 2);
  }

  function labelFor(source: ModelSource, modelId: string): string {
    if (source.kind === "acp-proxy" && modelId === "claude/default") return "Claude default (the proxy picks the model)";
    return `${source.label}: ${modelId}`.slice(0, MAX_PRESET_LABEL);
  }

  /** Context and max tokens that satisfy the stored bounds whatever the source suggested. */
  function bounded(cw: number, mt: number): { contextWindow: number; maxTokens: number } {
    const contextWindow = Math.min(CONTEXT_WINDOW_MAX, Math.max(CONTEXT_WINDOW_MIN, cw));
    return { contextWindow, maxTokens: Math.max(MAX_TOKENS_MIN, Math.min(mt, maxTokensLimit(contextWindow))) };
  }

  async function validateUrl(raw: unknown): Promise<{ baseUrl: string; loopback: boolean }> {
    if (typeof raw !== "string" || raw.length < 8 || raw.length > MAX_BASE_URL || HAS_CONTROL.test(raw)) throw bad("Enter the provider's base URL, for example https://openrouter.ai/api/v1.");
    if (/[?#]/.test(raw)) throw bad("The base URL must not have a query or a fragment.");
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw bad("That is not a valid URL.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("The base URL must start with http:// or https://.");
    if (u.username !== "" || u.password !== "") throw bad("The base URL must not contain a user name or password. Use the API key field.");
    const baseUrl = u.origin + u.pathname.replace(/\/+$/, "");
    const loopback = isLiteralLoopbackUrl(baseUrl);
    if (!loopback) {
      if (u.protocol !== "https:") throw bad("A provider that is not on this PC must use https.");
      const v = await checkUrl(baseUrl, [u.hostname], resolver ?? defaultResolver);
      if (!v.ok) throw bad(`That address was refused (${v.reason}).`);
    }
    return { baseUrl, loopback };
  }

  function deriveSourceId(label: string, taken: readonly string[]): string {
    let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!/^[a-z]/.test(base)) base = `prov${base}`;
    base = base.slice(0, 12);
    if (base.length < 2) base = "prov";
    const used = new Set<string>([...taken, ...BUILTIN_SOURCE_IDS]);
    let id = base;
    for (let n = 2; used.has(id) || !SOURCE_ID_PATTERN.test(id); n++) id = `${base.slice(0, 12 - String(n).length)}${n}`;
    return id;
  }

  return {
    "POST /api/admin/models/list": {
      auth: "owner",
      handler: () =>
        models(() => {
          catalog.reloadSecurity();
          const used = usedByCount();
          const terms = catalog.terms() as unknown as Record<string, boolean | undefined>;
          const sources = catalog.sources();
          const sourceViews = sources.map((s) => ({
            id: s.id,
            kind: s.kind,
            label: s.label,
            baseUrl: s.baseUrl,
            privacy: derivePrivacy(s),
            ...(s.billing !== undefined ? { billing: s.billing } : {}),
            hasKey: s.kind === "custom" ? s.keyRef !== undefined : s.keyRef !== undefined && catalog.keyFor(s) !== undefined,
            setUp: isSetUp(s),
            ...(s.kind === "acp-proxy" && proxyAuth ? { proxyAuth } : {}),
          }));
          const presetViews = catalog.entries().map((e) => {
            const p = e.preset;
            const src = sources.find((s) => s.id === e.sourceId);
            const c = src ? classify(src, p.modelId) : undefined;
            const needsTerms = c?.needsTerms ?? false;
            return {
              id: p.id,
              label: p.label,
              sourceId: e.sourceId,
              modelId: p.modelId,
              origin: e.origin,
              kind: p.kind,
              privacy: p.privacy,
              billing: isPaidPreset(p) ? "paid" : "subscription",
              contextWindow: p.contextWindow,
              maxTokens: p.maxTokens,
              needsTerms,
              termsOk: needsTerms && p.providerId !== undefined && terms[p.providerId] === true,
              usedBy: used.get(p.id) ?? 0,
              ...(e.origin === "web" && copyJson(p) ? { copyJson: copyJson(p) } : {}),
            };
          });
          return { status: 200, body: { sources: sourceViews, presets: presetViews, banners: catalog.banners() } };
        }),
    },

    "POST /api/admin/models/fetch": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(async () => {
          const b = body(c);
          catalog.reloadSecurity();
          const source = sourceOf(b["sourceId"]);
          const r = await fetchModels(source, { catalog, lastFetch, ...(o.fetch ? { fetch: o.fetch } : {}), ...(resolver ? { resolver } : {}), ...(o.now ? { now: o.now } : {}) });
          if ("error" in r) {
            audit({ kind: "models_fetch", user: me(c), detail: { sourceId: source.id, ok: false } });
            throw new ModelsError(r.error === ERR_RATE_LIMIT ? 429 : 502, r.error === ERR_RATE_LIMIT ? "rate_limited" : "fetch_failed", r.error);
          }
          lastRows.set(source.id, new Map(r.rows.map((x) => [x.modelId, x])));
          if (source.kind === "acp-proxy") proxyAuth = r.proxyAuth;
          audit({ kind: "models_fetch", user: me(c), detail: { sourceId: source.id, ok: true, rows: r.rows.length } });
          return { status: 200, body: { rows: r.rows, ignored: r.ignored, ...(r.note ? { note: r.note } : {}) } };
        }),
    },

    "POST /api/admin/models/presets/add": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(() => {
          const b = body(c);
          catalog.reloadSecurity();
          const source = sourceOf(b["sourceId"]);
          if (!isSetUp(source)) throw bad("That source is not set up.");
          const list = b["models"];
          if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ADD_MODELS) throw bad(`Send 1 to ${MAX_ADD_MODELS} models.`);
          const seen = lastRows.get(source.id);
          const added: { presetId: string; modelId: string }[] = [];
          const skipped: { modelId: string; reason: string }[] = [];
          const existing: ExistingPreset[] = [...catalog.existing()];
          const taken = new Set<string>([...catalog.presets().map((p) => p.id), ...existing.map((e) => e.id)]);
          catalog.update((draft) => {
            for (const raw of list) {
              const m = isObj(raw) ? raw : {};
              let modelId = typeof m["modelId"] === "string" ? m["modelId"] : "";
              const shown = modelId.slice(0, 40).replace(CONTROL, "");
              try {
                if (!MODEL_ID_PATTERN.test(modelId)) throw bad("not a valid model id");
                if (source.kind === "acp-proxy" && !modelId.includes("/")) modelId = `codex/${modelId}`; // D10: the stored form
                const cl = classify(source, modelId);
                if (cl.blocked) throw bad(cl.blocked);
                if (findExistingPreset(existing, source.id, modelId)) throw bad("already added");
                if (draft.doc.presets.length >= MAX_WEB_PRESETS) throw bad(`the limit of ${MAX_WEB_PRESETS} web models is reached`);
                const row = seen?.get(modelId) ?? seen?.get(modelId.replace(/^codex\//, ""));
                const defaults = row?.classified.defaults ?? cl.defaults;
                const req = m["contextWindow"] !== undefined ? int(m["contextWindow"], "Context window", CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX) : undefined;
                const reqMax = m["maxTokens"] !== undefined ? int(m["maxTokens"], "Max tokens", MAX_TOKENS_MIN, 200_000) : undefined;
                const dflt = bounded(defaults.contextWindow, defaults.maxTokens);
                const contextWindow = req ?? dflt.contextWindow;
                const maxTokens = reqMax ?? Math.min(dflt.maxTokens, maxTokensLimit(contextWindow));
                if (maxTokens > maxTokensLimit(contextWindow) || maxTokens < MAX_TOKENS_MIN) throw bad("max tokens must be at most half the context window");
                let billing: "subscription" | "paid" = source.kind === "custom" && cl.privacy === "cloud" && source.billing === "paid" ? "paid" : "subscription";
                if (m["billing"] !== undefined) billing = billingOf(m["billing"]);
                if (billing === "paid" && !cl.paidAllowed) throw bad("only a cloud model can be paid");
                const label = m["label"] !== undefined ? text(m["label"], "The label", 1, MAX_PRESET_LABEL) : labelFor(source, modelId);
                const id = presetIdFor(source.id, groupOf(source, modelId), modelId, taken, existing);
                taken.add(id);
                existing.push({ id, sourceId: source.id, modelId });
                draft.doc.presets.push({ id, sourceId: source.id, modelId, label, contextWindow, maxTokens, billing });
                added.push({ presetId: id, modelId: row?.modelId ?? modelId });
              } catch (e) {
                if (!(e instanceof ModelsError)) throw e;
                skipped.push({ modelId: shown, reason: e.message });
              }
            }
          });
          if (added.length > 0) audit({ kind: "models_add", user: me(c), detail: { sourceId: source.id, ids: joinList(added.map((a) => a.presetId)) } });
          return { status: 200, body: { added, skipped } };
        }),
    },

    "POST /api/admin/models/presets/update": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(() => {
          const b = body(c);
          catalog.reloadSecurity();
          const presetId = typeof b["presetId"] === "string" ? b["presetId"] : "";
          const entry = catalog.entries().find((e) => e.preset.id === presetId);
          if (!entry) throw new ModelsError(404, "not_found", "No such model.");
          if (entry.origin !== "web") throw bad(READ_ONLY);
          const fields = ["label", "contextWindow", "maxTokens", "billing"].filter((k) => b[k] !== undefined);
          if (fields.length === 0) throw bad("Nothing to change.");
          const src = sourceOf(entry.sourceId);
          let unpaid = false;
          catalog.update((draft) => {
            const p = draft.doc.presets.find((x) => x.id === presetId);
            if (!p) throw new ModelsError(404, "not_found", "No such model.");
            if (b["label"] !== undefined) p.label = text(b["label"], "The label", 1, MAX_PRESET_LABEL);
            if (b["contextWindow"] !== undefined) p.contextWindow = int(b["contextWindow"], "Context window", CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX);
            if (b["maxTokens"] !== undefined) p.maxTokens = int(b["maxTokens"], "Max tokens", MAX_TOKENS_MIN, 200_000);
            if (p.maxTokens > maxTokensLimit(p.contextWindow)) throw bad(`Max tokens must be at most ${maxTokensLimit(p.contextWindow)} (half the context window).`);
            if (b["billing"] !== undefined) {
              const bill = billingOf(b["billing"]);
              if (bill === "paid" && !classify(src, p.modelId).paidAllowed) throw bad("Only a cloud model can be paid.");
              unpaid = bill === "subscription" && p.billing === "paid";
              p.billing = bill;
            }
          });
          if (unpaid) chat.paid.dropPreset(presetId); // a grant must not come back if the model is marked paid again later
          audit({ kind: "models_update", user: me(c), detail: { presetId, fields: fields.join(",") } });
          return { status: 200, body: { ok: true } };
        }),
    },

    "POST /api/admin/models/presets/remove": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(() => {
          const b = body(c);
          catalog.reloadSecurity();
          const presetId = typeof b["presetId"] === "string" ? b["presetId"] : "";
          const entry = catalog.entries().find((e) => e.preset.id === presetId);
          if (!entry) throw new ModelsError(404, "not_found", "No such model.");
          if (entry.origin !== "web") throw bad(READ_ONLY);
          const force = b["force"] === true;
          const bots = botsUsing(new Set([presetId]));
          if (bots.length > 0 && !force) throw inUse(bots, "This model");
          catalog.update((draft) => {
            draft.doc.presets = draft.doc.presets.filter((x) => x.id !== presetId);
          });
          chat.paid.dropPreset(presetId);
          audit({ kind: "models_remove", user: me(c), detail: { presetId, force, bots: bots.length } });
          return { status: 200, body: { ok: true } };
        }),
    },

    "POST /api/admin/models/sources/add": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(async () => {
          const b = body(c);
          catalog.reloadSecurity();
          const label = text(b["label"], "The name", 1, MAX_SOURCE_LABEL);
          const { baseUrl, loopback } = await validateUrl(b["baseUrl"]);
          if (b["treatAsCloud"] !== undefined && typeof b["treatAsCloud"] !== "boolean") throw bad("Treat as cloud must be true or false.");
          const treatAsCloud = loopback && b["treatAsCloud"] === true;
          const cloud = !loopback || treatAsCloud;
          let billing: "subscription" | "paid" | undefined;
          if (cloud) {
            if (b["billing"] === undefined) throw bad("Choose how this provider is billed: free or subscription, or paid per use.");
            billing = billingOf(b["billing"]);
          } else if (b["billing"] !== undefined && b["billing"] !== "subscription") {
            throw bad("Only a cloud provider can be paid per use.");
          }
          let apiKey: string | undefined;
          if (b["apiKey"] !== undefined) {
            const k = b["apiKey"];
            if (typeof k !== "string" || k.length < 1 || k.length > MAX_API_KEY || KEY_BAD.test(k)) throw bad(`The API key must be 1 to ${MAX_API_KEY} characters without spaces or control characters.`);
            apiKey = k;
          }
          let sourceId = "";
          catalog.update((draft) => {
            if (draft.doc.sources.length >= MAX_CUSTOM_SOURCES) throw bad(`At most ${MAX_CUSTOM_SOURCES} providers can be added.`);
            sourceId = deriveSourceId(label, [...draft.doc.sources.map((s) => s.id)]);
            draft.doc.sources.push({ id: sourceId, label, baseUrl, hasKey: false, ...(billing ? { billing } : {}), ...(treatAsCloud ? { treatAsCloud: true } : {}) });
            if (apiKey !== undefined) draft.keys.set(sourceId, apiKey);
          });
          audit({ kind: "models_source_add", user: me(c), detail: { sourceId, privacy: cloud ? "cloud" : "local", billing, keyChanged: apiKey !== undefined } });
          return { status: 200, body: { sourceId } };
        }),
    },

    "POST /api/admin/models/sources/update": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(() => {
          const b = body(c);
          catalog.reloadSecurity();
          if ("baseUrl" in b) throw bad("The base URL cannot be changed. Remove the provider and add it again.");
          const source = sourceOf(b["sourceId"]);
          if (source.kind !== "custom") throw bad("Only a provider you added can be changed here.");
          const cloud = derivePrivacy(source) === "cloud";
          let apiKey: string | undefined;
          if (b["apiKey"] !== undefined) {
            const k = b["apiKey"];
            if (typeof k !== "string" || k.length < 1 || k.length > MAX_API_KEY || KEY_BAD.test(k)) throw bad(`The API key must be 1 to ${MAX_API_KEY} characters without spaces or control characters.`);
            apiKey = k;
          }
          const label = b["label"] !== undefined ? text(b["label"], "The name", 1, MAX_SOURCE_LABEL) : undefined;
          let billing: "subscription" | "paid" | undefined;
          if (b["billing"] !== undefined) {
            billing = billingOf(b["billing"]);
            if (!cloud) throw bad("Only a cloud provider can be paid per use.");
          }
          if (label === undefined && apiKey === undefined && billing === undefined) throw bad("Nothing to change.");
          catalog.update((draft) => {
            const s = draft.doc.sources.find((x) => x.id === source.id);
            if (!s) throw new ModelsError(404, "not_found", "No such source.");
            if (label !== undefined) s.label = label;
            if (apiKey !== undefined) draft.keys.set(s.id, apiKey);
            if (billing !== undefined) {
              s.billing = billing;
              if (billing === "paid") for (const p of draft.doc.presets) if (p.sourceId === s.id) p.billing = "paid"; // paying can only go up here
            }
          });
          audit({ kind: "models_source_update", user: me(c), detail: { sourceId: source.id, privacy: cloud ? "cloud" : "local", billing, keyChanged: apiKey !== undefined } });
          return { status: 200, body: { ok: true } };
        }),
    },

    "POST /api/admin/models/sources/remove": {
      auth: "owner",
      stepUp: true,
      handler: (c) =>
        models(() => {
          const b = body(c);
          catalog.reloadSecurity();
          const source = sourceOf(b["sourceId"]);
          if (source.kind !== "custom") throw bad("Only a provider you added can be removed.");
          const force = b["force"] === true;
          const ids = new Set(catalog.entries().filter((e) => e.origin === "web" && e.sourceId === source.id).map((e) => e.preset.id));
          const bots = botsUsing(ids);
          if (bots.length > 0 && !force) throw inUse(bots, "This provider's models are");
          catalog.update((draft) => {
            draft.doc.presets = draft.doc.presets.filter((p) => p.sourceId !== source.id);
            draft.doc.sources = draft.doc.sources.filter((s) => s.id !== source.id);
            draft.keys.remove(source.id);
          });
          for (const id of ids) chat.paid.dropPreset(id);
          lastRows.delete(source.id);
          audit({ kind: "models_source_remove", user: me(c), detail: { sourceId: source.id, privacy: derivePrivacy(source), billing: source.billing, keyChanged: source.keyRef !== undefined, bots: bots.length, force } });
          return { status: 200, body: { ok: true } };
        }),
    },
  };
}

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
