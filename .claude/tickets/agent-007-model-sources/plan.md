# Model sources: every ACP proxy model, LM Studio, custom OpenAI-compatible providers, fetch-and-tick

Status: IMPLEMENTING on branch `agent-007-model-sources` (from master 37102df), approved 2026-11-01. Repo `C:\projects\Personal\agent-007`, base `master` 37102df. Research: `research.md` (this folder).
Parent plans: `.claude/tickets/agent-007-milestone2/plan.md` (I47 to I58, MA2, MA3, S38) and `.claude/tickets/agent-007-pi-durable-mvp/plan.md` (I25, I25d, I38 to I44). New IDs here continue from **I59** and use the prefix **MS** for tasks, **AC** for acceptance criteria, **R** for risks, **UM** for user steps.

## 0. Scope (one line)

Full reading: an owner-only **Models** page in the web Admin fetches the model list from the ACP proxy (Codex, Antigravity, Claude), LM Studio (all downloaded models, loaded ones marked), Strata and any owner-added OpenAI-compatible URL; the owner ticks models (or adds one by id) and they become presets of the **web gateway** at once, without a restart. Telegram bots are not changed by this ticket (see D3).

## 1. Decisions

### 1a. User decisions (2026-11-01)

| ID | Decision |
|---|---|
| U1 | Fetch-and-tick like Scriptorium: list fetched models, the owner ticks which become presets, plus "Add a model by its id". |
| U2 | Sources: ACP proxy (Codex, Antigravity, Claude), LM Studio, Strata, and "Add provider" for any OpenAI-compatible URL. Loopback URL = local; any other URL = cloud (cloud badge, cloud-safe handling of I42, terms/egress note). Keys of custom providers are stored as secrets: never in a settings file, never shown back. |
| U3 | LM Studio: list every downloaded model (Just-in-Time loading), mark the loaded ones. |
| U4 | Managed in the web UI: a Models page in web Admin, owner only, step-up for every change. New presets are available to the owner's own bots at once (replaces the hardcoded `ownerCaps()` list, `src/web/auth.ts:42-44`); users get them only through explicit owner caps. |

### 1b. Defaults chosen by the director or this plan (the user can override each)

| ID | Default | Why / alternative |
|---|---|---|
| D1 | **Billing.** Proxy, LM Studio, Strata and loopback custom presets default to `subscription` (not billed per use). Only the owner can mark a preset `paid` (step-up), and only for a cloud preset (proxy or non-loopback custom); then the S38 paid caps apply (web only; the Telegram loader keeps refusing paid). A **non-loopback custom provider has no default**: the owner must pick "Free or subscription" or "Paid per use" when adding it. | A custom cloud key (OpenRouter, DeepSeek) is usually billed per token; a silent `subscription` default would bypass S38. Alternative: default such providers to `paid`. |
| D2 | **Context window / max tokens.** Per-family defaults in code (table in MS1), editable per preset. LM Studio: `loaded_context_length` when the model is loaded, else 8192 with the note "set this to the context LM Studio loads the model with". | The proxy lists neither (I40). A too-large window breaks the 75% compaction. |
| D3 | **Where web presets live and Telegram.** The gateway runs as the agent user, which has read-only access to `security.json` (I25, I29c); only the main user's settings UI may write it (`securityWriter`, boundary test). So the Models page writes **its own store**, `<dataDir>\web\models.json` (presets + custom sources) and `<dataDir>\web\model-keys.json` (sealed keys). The gateway merges these with the `security.json` presets. **The Telegram agent does not read the web store**: Telegram bots keep using `security.json` presets only. To use a fetched proxy/LM Studio/Strata preset on Telegram, the owner clicks "Copy for settings UI" on the Models page, pastes the JSON into the settings UI Models form (port 47007), and applies it with the existing `/applysettings` restart (I25d). Custom-provider presets cannot go to Telegram (no key path there). | Keeps I25 and the boundary test intact. Alternative (out of scope): a main-user import step that copies web presets into `security.json`. |
| D4 | **Preset id.** `<prefix>-<model slug>`, matching `PRESET_ID_PATTERN` (`^[a-z][a-z0-9-]{0,23}$`, `src/bots/schema.ts:27`). Prefixes: `claude`, `codex`, `ag` (Antigravity), `lms` (LM Studio), `strata`, custom = the source id. Over 24 chars or colliding: cut to 19 chars + `-` + 4 hex of `sha256(sourceId + "\n" + modelId)`; on a second collision 6 hex. An existing preset with the same source and model id is reused (so `claude-sonnet`, `claude-opus`, `strata` keep their ids). `claude/default` becomes `claude-default`, labelled "Claude default (the proxy picks the model)". | Deterministic and collision-safe. |
| D5 | `Caps.presets` limit 20 -> **128** (`src/web/schemas.ts:152`); web store holds at most **64** presets and **8** custom sources. | 18 proxy models + LM Studio + security presets exceed 20. |
| D6 | **Hot reload (closes checker N4 for the gateway).** The gateway re-reads `security.json` presets and `termsAccepted` when the file hash changes (checked every 10 s and on each Models page load) and rebuilds the merged catalogue at once after every Models page write. An invalid `security.json` keeps the last good snapshot (audited, banner on the Models page). The Telegram agent keeps the existing path: restart via `/applysettings`. | |
| D7 | **Classification comes from the source, never from fetched data.** The fetch is server-side; fetched strings are untrusted (limits in MS1). A custom URL fetch is owner-only (SSRF, I60). | |
| D8 | **Removing a preset in use** is refused with the list of bots using it (HTTP 409); the owner may repeat it with `force: true` (step-up, typed confirmation in the UI). Then the M1 per-turn route re-check drops the missing link (`missing`), and paid grants for that preset are deleted. `security.json` presets cannot be removed here (read-only rows). | |
| D9 | **Non-loopback custom URLs must be `https`** and pass the existing SSRF guard (`checkUrl`, `src/web/runtime/ssrf.ts:61`) with the provider host as the only allowed name: no private, LAN, tailnet, loopback or link-local address. A LAN LM Studio is therefore not supported in this ticket. A source's base URL cannot be edited (remove and add again), so existing presets are never silently redirected. A loopback custom source may be marked "treat as cloud" (privacy may only go up). | |
| D10 | Embedding models are hidden (LM Studio `type: embeddings`, ids matching `/embed/i`). Codex bare and `codex/` ids are one row (existing `normalize`, `src/proxy/discover.ts:26`); the stored model id is the `codex/` form. | |

## 2. Out of scope

- Tailscale, Telegram live checks, the L2/L3 live phases of M2.
- Telegram bots using web-store presets, and any write to `security.json` from the gateway (D3).
- Price tables, per-token cost display, a currency budget (paid caps stay token caps, S38).
- Loading or unloading LM Studio models through its API or `lms` (LM Studio's own JIT does it); LM Studio on another host; a second LM Studio runner.
- New ACP providers beyond `codex`, `claude`, `antigravity` (an unknown proxy prefix is shown but cannot be ticked).
- Non-OpenAI-compatible APIs (Anthropic native, Gemini native).
- Changes in `C:\projects\Personal\api-acp-proxy` (MA1 stays separate).
- Telegram hot reload of presets or terms.

## 3. Files and modules

New:
- `src/models/sources.ts` (pure): source types, built-in sources from config, `classify`, `presetIdFor`, family defaults, fetched-body parsers and limits.
- `src/web/models/store.ts`: strict parse and atomic write of `models.json` and `model-keys.json`, audit hash.
- `src/web/models/catalog.ts`: `PresetCatalog` (merge, hot reload, endpoints).
- `src/web/models/fetch.ts`: server-side fetch per source kind.
- `src/web/routes/models.ts`: the owner routes.
- `ui/web/models.js`: the Models page.
- `test/web/models.test.ts` (unit + route tests; see section 6).

Changed:
- `src/bots/schema.ts`: `WEB_PRESET_KINDS = ["local","acp","custom"]`; `PresetConfig.kind` type widened; `PRESET_KINDS` unchanged (so `security.json`'s schema enum, `src/settings/schema.ts:154`, keeps refusing `custom`). `presetFromDoc` (line 223) must not map an unknown kind to `local`: an unknown kind yields an issue in `validateBotsDoc`.
- `src/models/presets.ts`: `presetProblem` accepts `custom` (rules in MS1).
- `src/web/main.ts`: build a `PresetCatalog` instead of the boot-time `presets` array (line 151); `endpointResolver` reads the catalogue on each call and resolves `custom` presets; the proxy watcher looks up the proxy URL on each tick.
- `src/web/chat/openaiEngine.ts`: optional `ModelEndpoint.preflight` called before each request.
- `src/web/app.ts`: mount `modelsRoutes`; owner effective caps in `userCaps` (line 107); `knownPresets` from the catalogue.
- `src/web/chat/service.ts` (`#user`, line 151): effective caps.
- `src/web/capabilities.ts`: `effectiveCaps(user, presetIds)`.
- `src/web/auth.ts:42-44`: `ownerCaps().presets` becomes `[]` (ignored for the owner role; kept so `users.json` still parses).
- `src/web/schemas.ts:152`: 20 -> 128.
- `src/web/users.ts` (`listUsers`): owner row reports `presets: "all"`.
- `src/web/runtime/paidRoutes.ts`: `dropPreset(presetId)`.
- `src/web/paths.ts`: `modelsFile`, `modelKeysFile`.
- `ui/web/app.js` (route `#/admin/models`, nav link for the owner), `ui/web/admin.js` (link to Models, per-user "Models" checklist using the existing `/api/admin/users/caps`), `ui/web/app.css` (table, badges).
- `README.md` (web section): the Models page, D3 and the live steps of section 9.

Not changed: `src/settings/securityWriter.ts` and its import boundary; the Telegram agent (`src/agent/**`, `src/bots/runtime.ts`); `api-acp-proxy`.

## 4. Data contracts (shared by all tasks)

```ts
// src/models/sources.ts
export type SourceKind = "acp-proxy" | "lmstudio" | "strata" | "custom";
export const BUILTIN_SOURCE_IDS = ["acp-proxy", "lmstudio", "strata"] as const; // reserved, never a custom id
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]{1,11}$/;                       // custom ids, also the preset prefix

export interface ModelSource {
  id: string;                    // "acp-proxy" | "lmstudio" | "strata" | custom id
  kind: SourceKind;
  label: string;                 // built-ins: fixed text; custom: owner text, 1..40 chars, control chars stripped
  baseUrl: string;               // ".../v1"; built-ins from config (proxy: URL of an existing acp preset, else http://127.0.0.1:8787/v1;
                                 // lmstudio/strata: model.runners.<name>.baseUrl; absent block = source "not set up")
  keyRef?: "proxyApiKey" | "lmStudioApiToken" | "strataApiKey" | `webkey:${string}`;
  privacy: "local" | "cloud";    // DERIVED: acp-proxy cloud; lmstudio/strata local; custom: literal host 127.0.0.1, [::1] or localhost
                                 // -> local unless treatAsCloud; anything else -> cloud
  billing?: "subscription" | "paid"; // custom cloud only: required, set by the owner (D1)
  treatAsCloud?: boolean;        // custom loopback only
}

export interface Classified {      // from (source, modelId) ONLY; no field of the fetched payload is an input
  kind: "acp" | "local" | "custom";
  runner?: "lmstudio" | "strata";
  providerId?: "codex" | "claude" | "antigravity"; // acp only: from the model id prefix ("claude/", "antigravity/", "codex/" or bare);
                                                   // any other prefix -> blocked "unknown proxy provider"
  apiKeyRef?: string;               // acp: "proxyApiKey"; custom with a key: "webkey:<sourceId>"; local: none
  privacy: "local" | "cloud";       // = source.privacy
  needsTerms: boolean;              // claude, antigravity (TERMS_PROVIDERS)
  paidAllowed: boolean;             // privacy === "cloud"
  defaults: { contextWindow: number; maxTokens: number };
}

// One row of a fetch answer (server -> UI)
export interface FetchedRow {
  modelId: string;                  // <= 128 chars, /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/, else dropped and counted
  group: "claude" | "codex" | "antigravity" | "lmstudio" | "strata" | "custom";
  loaded?: boolean;                 // LM Studio only
  contextHint?: number;             // LM Studio loaded_context_length, integer 512..10_000_000, else omitted
  presetId?: string;                // an existing preset with the same source + model id
  proposedId: string;               // D4
  classified: Pick<Classified, "kind" | "privacy" | "needsTerms" | "paidAllowed" | "defaults">;
  termsOk: boolean;                 // needsTerms && termsAccepted.<provider> (from security.json)
  blocked?: string;                 // fixed sentence, e.g. "unknown proxy provider"; a blocked row cannot be ticked
}

// <dataDir>\web\models.json (strict: unknown keys or a bad value -> whole file rejected, web presets off, banner, audit)
interface ModelsFile {
  v: 1;
  sources: { id: string; label: string; baseUrl: string; billing?: "subscription" | "paid"; treatAsCloud?: boolean; hasKey: boolean }[]; // custom only, <= 8
  presets: { id: string; sourceId: string; modelId: string; label: string; contextWindow: number; maxTokens: number; billing: "subscription" | "paid" }[]; // <= 64
}
// <dataDir>\web\model-keys.json: { v: 1, keys: { [sourceId]: string /* SecretBox-sealed with web.key, I53 */ } }
```

A stored preset is turned into a `PresetConfig` **at every load** by `classify(source, modelId)` plus the stored `id`, `label`, `contextWindow`, `maxTokens`, `billing`; `billing: "paid"` is dropped (preset refused, audited) when `paidAllowed` is false. `kind`, `privacy`, `providerId`, `apiKeyRef`, `runner`, `baseUrl` are never stored. A web preset whose id collides with a `security.json` preset is skipped (security wins) with a warning.

Family defaults (D2): `claude/*` 200000 / 8192; `codex/*` and bare gpt ids 200000 / 8192; `antigravity/*` 1000000 / 8192; LM Studio loaded: `contextHint` / 4096, not loaded: 8192 / 2048; Strata: the runner block's values; custom: 32768 / 4096. Bounds when editing: contextWindow 1024..2_000_000, maxTokens 256..min(contextWindow / 2, 200_000).

Label (default): `"<source label>: <modelId>"`, cut to 60 chars; owner-editable, 1..60 chars, control characters stripped. The UI always renders with `textContent` (I57).

Fetch limits (all sources): `redirect: "error"`, 10 s timeout, body read cap 1 MB, at most 500 rows (more: first 500 and a note), at most one fetch per source per 3 s. Errors are fixed sentences ("not reachable", "the key was refused (401)", "not an OpenAI-compatible model list", "LM Studio wants an API token: add lmStudioApiToken to secrets.json"), redacted with `createRedactor` and never echo the body.

API routes (all `auth: "owner"`; every write `stepUp: true`; bodies are JSON objects; errors `{error, message}`):

| Route | Body | Answer |
|---|---|---|
| `POST /api/admin/models/list` | `{}` | `{sources: SourceView[], presets: PresetView[], banners: string[]}`. `SourceView = {id, kind, label, baseUrl, privacy, billing?, hasKey, setUp: boolean, proxyAuth?: Record<provider, auth_method>}`; `PresetView = {id, label, sourceId, modelId, origin: "settings" \| "web", kind, privacy, billing, contextWindow, maxTokens, needsTerms, termsOk, usedBy: number, copyJson?: string}` (`copyJson` = the `security.json` preset JSON for acp/local web presets, D3) |
| `POST /api/admin/models/fetch` | `{sourceId}` | `{rows: FetchedRow[], ignored: number, note?: string}` |
| `POST /api/admin/models/presets/add` | `{sourceId, models: [{modelId, label?, contextWindow?, maxTokens?, billing?}]}` (1..50; a model id not in the last fetch = "add by id") | `{added: [{presetId, modelId}], skipped: [{modelId, reason}]}` |
| `POST /api/admin/models/presets/update` | `{presetId, label?, contextWindow?, maxTokens?, billing?}` (web presets only) | `{ok: true}` |
| `POST /api/admin/models/presets/remove` | `{presetId, force?: true}` | `{ok: true}` or 409 `{error: "in_use", bots: [{user: login, bot: name}]}` |
| `POST /api/admin/models/sources/add` | `{label, baseUrl, apiKey?, billing?, treatAsCloud?}` | `{sourceId}` |
| `POST /api/admin/models/sources/update` | `{sourceId, label?, apiKey?, billing?}` (no `baseUrl`, D9) | `{ok: true}` |
| `POST /api/admin/models/sources/remove` | `{sourceId, force?: true}` | as presets/remove (all its presets) |

Audit lines (web audit, no bodies, no keys): `models_fetch {sourceId, rows}`, `models_add {sourceId, ids}`, `models_update {presetId, fields}`, `models_remove {presetId, force, bots}`, `models_source_add|update|remove {sourceId, privacy, billing, keyChanged}`, `models_saved {sha256}`, `models_reload {file, ok}`.

## 5. Tasks

Order: MS1 first; MS2 and MS3 in parallel after MS1; MS4 after MS2 and MS3; MS5 in parallel with MS4 (it codes against the route table of section 4); MS6 last.

### MS1 Source library and preset kinds (pure) [x] DONE
Result: `corepack yarn build` 0 errors; `node --test dist/test/web/models.test.js dist/test/bots/config.test.js` 28/28 pass; full `corepack yarn test` 1592 tests, 1591 pass, 0 fail, 1 skipped (baseline 1589, +3 new table tests; the AC8 assertion extends an existing test). Deviations: `ModelSource.defaults?` added (Strata runner values, since `classify` has no config); `Classified.blocked?` added; unreachable runner block gives `baseUrl: ""` (`isSetUp`); `classify` re-derives privacy from kind/baseUrl/treatAsCloud instead of trusting `source.privacy`; `presetIdFor` takes an optional 5th `existing` argument; no de-duplication of the prefix in ids (`claude-claude-...` is hashed when too long, per D4 literally).
- Inputs: `src/bots/schema.ts`, `src/models/presets.ts`, `src/proxy/discover.ts` (`normalize`), `src/proxy/health.ts` (`parseModelIds`), section 4.
- Do: create `src/models/sources.ts` with `builtinSources(config, securityPresets)`, `classify(source, modelId)`, `presetIdFor(sourceId, group, modelId, takenIds)`, `familyDefaults`, `parseProxyModels(body)`, `parseLmStudioModels({v1?, v0?, openai?})` (LM Studio order: `GET <origin>/api/v1/models` `models[].{key,type,loaded_instances,max_context_length}`, then `GET <origin>/api/v0/models` `data[].{id,type,state,loaded_context_length}`, then `GET /v1/models` ids only with `loaded` unknown), `parseOpenAiModels(body)`, all applying the row limits. Add `WEB_PRESET_KINDS` and `kind: "custom"` to `PresetConfig`. `presetProblem`: `custom` needs `apiKeyRef` absent or `webkey:<id>`, privacy `cloud` when `baseUrl` is not a literal loopback host, no `providerId`, never needs terms; `acp`/`local` rules unchanged; `billing: "paid"` only with privacy `cloud`. `presetFromDoc`: unknown kind is kept as given so `validateBotsDoc` reports it (a `custom` preset in `security.json` is refused: "custom providers are managed on the web Models page").
- Outputs: the types and functions of section 4, exported. No I/O.
- Contract: MS2 and MS3 call `classify`, `presetIdFor`, the parsers; nothing else derives kind/privacy/provider.

### MS2 Web store, catalogue, hot reload, endpoints [x] DONE
Result: `corepack yarn build` 0 errors; `node --test dist/test/web/models.test.js` 4/4 pass (new `catalog reload and tamper`); full `corepack yarn test` 1593 tests, 1592 pass, 0 fail, 1 skipped (+1 test; the `termsAccepted` grep test forced the word out of a catalog.ts comment). Not run: main.ts boot against a real config (no server started), preflight at chat time (AC5, MS6). Deviations: audit kinds `models_*` added to `AUDIT_KINDS`; `endpointResolver` moved to `src/web/models/catalog.ts` and re-exported from `main.ts`; catalog takes injected `loadSecurity`/`securityHash`/`box`, reads the `models_saved` line from the audit folder, and `reloadSecurity()` also re-checks models.json (hash, so live tamper is seen); on tampered/invalid state `update()` starts from an empty draft (clean slate); tamper disables ALL web presets, not only custom ones (AC7 wording); the SSRF preflight is set only for non-literal-loopback custom sources (a loopback source marked treat-as-cloud would always be refused by `checkUrl`) and also requires https; a keyed source whose key cannot be unsealed has no endpoint; a cloud custom source without `billing` makes its presets paid; `app.ts` only gained the optional `catalog` option (exposed as `WebApp.catalog`).
- Inputs: MS1; `src/web/main.ts:80-92,151-180`; `src/web/store.ts` (atomic write), `src/web/crypto.ts` (`SecretBox`), `src/web/audit.ts`.
- Do: `src/web/models/store.ts` (strict parse of both files, atomic write, `models_saved` hash; at load a hash different from the last `models_saved` line disables custom sources and their presets until the owner saves again, banner "models.json was changed outside the Models page"). `src/web/models/catalog.ts`: `PresetCatalog {presets(): PresetConfig[]; terms(): TermsAccepted; sources(): ModelSource[]; banners(): string[]; endpoint(id): ModelEndpoint | undefined; reloadSecurity(): void; afterWrite(): void}`; security snapshot via the same `loadConfig` + `parseBots` path as boot, re-read when the `security.json` sha256 changes (10 s timer, `unref`). `endpoint` for `custom`: base URL of the source, key unsealed per call (never cached in a log or error), `viaProxy: false`, `paid` from billing, and for cloud sources `preflight = () => checkUrl(baseUrl, [host], dnsResolver)` -> refusal string. `openaiEngine.ts`: call `ep.preflight` before `fetch`; a refusal is a `down` failure with the fixed notice (falls to the next chain link). `main.ts`: pass `catalog.presets`, `catalog.terms`, `catalog.endpoint`; proxy watcher reads the proxy URL from `catalog.sources()` per tick; add `lmStudioApiToken`, `strataApiKey`, `proxyApiKey` usage unchanged (L8: no new secret kinds in the gateway besides the sealed custom keys).
- Outputs: `PresetCatalog` instance in `runWeb`, passed to `startWebApp` (new option `catalog`, while `presets`/`terms` remain as functions for the tests).
- Contract: MS4 calls `catalog.afterWrite()` after every write; all readers call `presets()` per request (no captured arrays).

### MS3 Fetchers
- Inputs: MS1; `src/proxy/health.ts` (`fetchHealth`, the `get` helper), `src/web/runtime/ssrf.ts`.
- Do: `src/web/models/fetch.ts` `fetchModels(source, keys, deps) -> {rows, ignored, note?} | {error}`. acp-proxy: `GET /v1/models` with `proxyApiKey` plus `/healthz` for `auth_method` (Claude with `api_key`: rows get the note "the proxy's Claude login is an API key: refused unless marked paid", MA2). lmstudio: the three-step order of MS1 with `lmStudioApiToken` if present; a 401 gives the fixed token sentence. strata: `GET /v1/models` with `strataApiKey`. custom: `checkUrl` first for cloud sources (https only), then `GET <baseUrl>/models` with the unsealed key. All with the limits of section 4, `redirect: "error"`, no cookies, User-Agent `agent-007`. Note on the proxy's 3 s model wait: "a provider may be missing; fetch again".
- Outputs: `FetchedRow[]` with `presetId`, `proposedId`, `termsOk` filled from the catalogue.
- Contract: never returns or logs a key or the raw body.

### MS4 Routes and caps
- Inputs: MS2, MS3; `src/web/routes/admin.ts` (pattern `admin()` wrapper), `src/web/app.ts`, `src/web/users.ts`, `src/web/chat/service.ts`, `src/web/runtime/paidRoutes.ts`.
- Do: `src/web/routes/models.ts` with the route table of section 4 (owner, step-up on writes; input validation with the limits of section 4; `presets/add` re-classifies on the server and ignores any client field other than those listed; `sources/add` validates URL (http(s), no credentials, no query/fragment, path ends `/v1` or is accepted as given), refuses http on a non-loopback host, runs `checkUrl` for cloud, requires `billing` for cloud, seals `apiKey` (1..512 chars) into `model-keys.json`; `remove` scans every user's bots (`ChatService.bots(userId)` over `users.json`) for the preset in `preset`/`cloudFallback`/`fallback`, D8; `force` also calls `paid.dropPreset`). `effectiveCaps(user, ids)` in `capabilities.ts`: owner -> `presets = all catalogue ids`, others unchanged; used in `app.ts` `userCaps` and `ChatService.#user`. `Caps.presets` max 128. `UserAdmin.setCaps` validates against the catalogue ids. Owner row in `listUsers`: `presets: "all"`.
- Outputs: routes mounted in `startWebApp`; `/api/bots/options` shows new presets to the owner at once and to a user only after caps.
- Contract: response shapes exactly as section 4 (MS5 depends on them).

### MS5 Models page UI
- Inputs: the route table of section 4; `ui/web/admin.js`, `ui/web/account.js` (`withStepUp`), `ui/common/dom.js` helpers (copied flat into `dist/ui/web` by `scripts/settings/copy-ui.mjs`), Scriptorium `src/renderer/ui/ModelsDialog.tsx` for layout.
- Do: `ui/web/models.js` at `#/admin/models` (owner only; link in the nav and on the Admin page). Layout like Scriptorium: left list of sources (label, cloud/local badge, "not set up" / "no key" / "fetch failed" chip, "Add provider" button); right pane for the selected source: header with badges (cloud or local, billing, "needs terms acknowledgment in the settings UI" for Claude/Antigravity, Claude API-key note), **Fetch models** (only on press), filter box, "show not added only", table (tick, model id, loaded/not loaded for LM Studio, context, badges, existing preset id or proposed id, blocked reason), **Add selected** (step-up), **Add a model by its id** (text + Add). Below: the source's presets (id, label edit, context, max tokens, Paid toggle where `paidAllowed`, "used by N bots", Copy for settings UI (acp/local only), Remove with a typed-confirmation second step on 409). Add provider form: Name, Base URL, API key (password; after save only "key saved" and "Replace key"), Billing radio (required for a non-loopback URL), "Treat as cloud" (loopback only), with the egress note "Cloud: your bots' messages and tool results go to <host>; check that provider's terms." Admin user card: "Models…" button with a checklist of catalogue presets (badges) posting the existing `/api/admin/users/caps`. No `innerHTML` (I57), CSS in `app.css`.
- Outputs: the page; no new dependency.
- Contract: shows only fields from the API; never stores a key client-side after submit (input cleared).

### MS6 Tests, docs, review
- Inputs: MS1 to MS5; the `test-discipline` skill; `test/web/app.ts` and `test/web/helpers.ts` (fake app, fake upstream servers).
- Do: write the tests of section 6, update `README.md`, run `fnm exec --using default yarn build` and the full `yarn test` (count must not drop), run a security review of the diff (SSRF, key handling, classification), record results in this folder.
- Outputs: green build and tests; a short results table appended to this plan.

## 6. Acceptance criteria and the tests that prove them

Few tests, each covering one risk; all in `test/web/models.test.ts` unless named. Fakes only (local HTTP servers on 127.0.0.1, fake resolver).

| AC | Criterion | Test |
|---|---|---|
| AC1 | Classification comes only from the source: a fetched payload with `privacy`, `owned_by: "anthropic"` on a `codex/` id, `billing`, or an HTML string cannot change kind/privacy/provider/billing; unknown proxy prefix is blocked; loopback custom = local, other host = cloud, `treatAsCloud` only raises. | `classify: source decides, payload cannot` (one table test) |
| AC2 | Preset ids are valid, deterministic and collision-safe; existing `claude-sonnet`/`claude-opus`/`strata` reused; `claude/default` -> `claude-default`; `claude/claude-haiku-4-5-20251001` <= 24 chars. | `presetIdFor` table test |
| AC3 | Parsers enforce limits and LM Studio shapes: v1 / v0 / `/v1/models` fallback, loaded flag, embeddings hidden, bad ids dropped and counted, 500-row cap. | `parsers` table test |
| AC4 | End to end without restart: owner fetches from a fake proxy and a fake LM Studio, ticks two models, `/api/bots/options` for the owner lists them at once; an `admin` role gets 403; a write without step-up gets `step_up_required`; a user sees the preset only after caps are granted. | `owner fetch, tick, use; users need caps` (route test) |
| AC5 | Custom provider safety: http on a non-loopback host refused; a host resolving to a private address refused at save and at chat time (preflight, falls back); the key never appears in any API response, `models.json`, the audit or a log; `baseUrl` cannot be updated; a cloud custom source without `billing` is refused; a paid custom preset is dropped (`paid_off`) without an owner grant. | `custom provider: SSRF, key secrecy, billing` |
| AC6 | Removing a preset in use answers 409 with the bots; `force` removes it, deletes its paid grants, and the next turn of that user bot is refused or falls back per M1. | `remove in use` |
| AC7 | Hot reload: a changed `security.json` (new preset, terms flag off) is seen by the gateway without restart; an invalid one keeps the last good snapshot with a banner; a tampered `models.json` (hash mismatch or an extra `privacy` key) disables web presets. | `catalog reload and tamper` |
| AC8 | `security.json` still refuses `kind: "custom"` and paid presets on Telegram routes; the `securityWriter` boundary test still passes. | one assertion added to `test/bots/config.test.ts`; existing boundary test unchanged |
| AC9 | Build 0 errors, full suite green, test count not lower than before (1587 at 0ffaf08), I57 grep test (no innerHTML) passes on `models.js`. | `yarn build`, `yarn test`, existing `test/web/ui.test.ts` grep |
| AC10 | Live: section 9 completed by the user. | UM1 to UM8 |

## 7. Invariant changes

- **I38 amended:** presets live in `security.json` (Telegram and web) **and** in the web store `<dataDir>\web\models.json` (web gateway only; written only by the Models routes, owner + step-up; never read by the Telegram agent). The gateway never writes `security.json` (I25 unchanged).
- **I39 / I58 amended:** a third preset kind, `custom` (an OpenAI-compatible endpoint with an optional own key), exists **only in the web gateway**. A non-loopback custom source must declare billing; a paid preset (proxy or custom cloud) is used only with an S38 owner grant with headroom. `security.json` keeps the kinds `local` and `acp`.
- **I40 amended:** the gateway also calls the proxy's `GET /v1/models` and `/healthz` on an owner's Fetch; still never `/v1/mcp`.
- **I56 extended:** every Models write (add, update, remove, sources, keys) needs owner role + fresh step-up.
- **I59 (new):** kind, privacy, provider id, key reference, runner and base URL of a preset come from its source definition at every load, never from fetched data or a stored field; fetched strings are untrusted (pattern, length, row and size limits) and rendered as text only.
- **I60 (new):** a custom cloud source is `https`, passes `checkUrl` with its own host as the only allowed name at save, at fetch and before every chat request; only the literal hosts `127.0.0.1`, `[::1]`, `localhost` count as local; its base URL is immutable; its key is sealed with `web.key` in `model-keys.json`, used only server-side and never returned, logged or audited.
- **I61 (new):** the owner's effective presets are all configured presets; any other user's are exactly `caps.presets` (max 128), and the M1 per-turn re-check applies to all.
- **I62 (new, closes N4 for the gateway):** the gateway's preset and terms view follows `security.json` and `models.json` without a restart; an invalid file keeps the last good view. The Telegram agent still loads `security.json` once (I25d).
- **I42 (web reading, unchanged rule):** every cloud preset, including custom ones, shows the cloud badge and egress note; web bots have no private roots (UserFs only), so no new egress of private folders.

## 8. Risks

| R | Risk | Mitigation |
|---|---|---|
| R1 | A loopback custom URL that relays to a cloud vendor (LiteLLM, a local proxy) is labelled local. | "Treat as cloud" option and a note in the Add provider form; the owner is responsible (documented). |
| R2 | DNS rebinding between `checkUrl` and `fetch` (global fetch cannot pin the address). | Owner-only URLs, check before every request, https with certificate validation; residual, documented. |
| R3 | The agent user (an approved shell command) can edit `models.json` and append to the audit, so tamper detection is not proof. | Classification is recomputed at load, base URL edits need the file, keys are sealed; same honest limit as I43 and `users.json` caps. |
| R4 | Wrong context defaults cause overflow or late compaction, especially LM Studio JIT loads with its own default context. | D2 values, editable; LM Studio note; UM5 checks a real chat. |
| R5 | LM Studio's `/api/v1` and `/api/v0` field names differ by version. | Three-step fallback; UM3 confirms on the installed version. |
| R6 | 13 Claude + 2 Antigravity presets without terms flags would be dropped (`terms`) on every turn. | Rows show "needs terms"; ticking still allowed; banner points to the settings UI terms form. Live `security.json` already has both flags. |
| R7 | Proxy model list misses a slow provider (3 s wait). | Note and re-fetch. |
| R8 | Many presets crowd the bot editor select. | Labels sorted by source; out of scope to redesign. |
| R9 | Telegram users expect the new presets there. | D3 and the Copy for settings UI button; stated on the page. |

## 9. User steps for the live check (nothing here is run by an agent)

Prerequisites: build done; api-acp-proxy running with Codex, Antigravity and Claude logged in; LM Studio running on 127.0.0.1:1234 with at least two downloaded models (one loaded) and **Just-in-Time model loading on** (Developer -> Server settings).

- **UM1** `yarn web:local`; sign in as owner at `http://127.0.0.1:47009`; open Admin -> Models.
- **UM2** Select "ACP proxy", press Fetch models: expect 3 Codex, 2 Antigravity, 13 Claude rows; `claude-sonnet` and `claude-opus` shown as existing presets; Claude rows show the terms state.
- **UM3** Select "LM Studio", press Fetch models: every downloaded chat model listed, the loaded one marked "loaded", no embedding models. If a 401 appears, add `lmStudioApiToken` to `.local\secrets\secrets.json` and restart.
- **UM4** Tick one Codex, one Antigravity, one new Claude model (for example `claude-haiku-4-5-20251001`) and one not-loaded LM Studio model; Add selected (step-up). Check the ids and context values; adjust context for the LM Studio one if needed.
- **UM5** Without restarting, go to Bots, create a bot per new preset (or switch one bot through them) and send "Say hi in five words." Each answers; the LM Studio one loads the model first (slower first reply).
- **UM6** Add provider: a loopback one (for example LM Studio again at `http://127.0.0.1:1234/v1`, shows local) and, if you have one, a cloud key (for example OpenRouter `https://openrouter.ai/api/v1`, Billing "Paid per use"): Fetch, tick one, confirm the key is never shown again, and that a bot on the paid preset is refused until you enable it in Admin -> Paid routes with caps.
- **UM7** Try to remove a preset a bot uses: expect the list of bots; cancel.
- **UM8** In the settings UI (47007) untick `termsAccepted.antigravity`, save; within 10 s the Models page shows the Antigravity preset as "needs terms" and a chat on it falls back. Re-tick it.

Report back: which steps passed, any wrong context values, and the LM Studio version.
