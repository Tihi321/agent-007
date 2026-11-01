# Changelog: agent-007-model-sources

## 2026-11-01 - model sources (MS1-MS6)

Summary: the web gateway gets an owner-only Models page that fetches model lists from the ACP proxy, LM Studio, Strata and owner-added OpenAI-compatible providers; ticked models become web presets at once, without a restart. Telegram is unchanged (D3).

Repo `C:\projects\Personal\agent-007`, branch `agent-007-model-sources` (from master 37102df). Commits: a022858 MS1, 19ccb4f MS2, 16916dc MS3, 9201236 MS5, d03436f MS4, MS6 (docs, review fixes, results; see `git log`). Not pushed, not merged.

### Files
- `src/models/sources.ts` (new): source types, built-in sources from config, `classify` (kind, privacy, provider, key ref from the source only), D4 preset ids, family defaults, proxy / LM Studio (api/v1, api/v0, /v1/models) / OpenAI-compatible parsers with limits, `RESERVED_SOURCE_IDS`.
- `src/bots/schema.ts`: `WEB_PRESET_KINDS` with `custom`; unknown kinds are kept and reported; `security.json` still refuses `custom`.
- `src/models/presets.ts`: `presetProblem` rules for `custom`; `paid` only for cloud.
- `src/web/models/store.ts` (new): strict `models.json` / sealed `model-keys.json`, atomic write, `models_saved` hash, tamper and invalid-file detection (web presets off, banner).
- `src/web/models/catalog.ts` (new): `PresetCatalog` merging `security.json` and web presets (security wins), re-classification at every load, `security.json` hot reload by hash every 10 s (last good snapshot kept), custom endpoints with per-call key unseal and SSRF preflight.
- `src/web/models/fetch.ts` (new): server-side fetchers per source kind; redirect refused, 10 s timeout, 1 MB streamed cap, 500 rows, 3 s per-source rate limit, fixed error sentences.
- `src/web/routes/models.ts` (new): owner routes list/fetch/presets add-update-remove/sources add-update-remove, step-up on writes, 409 `in_use` with force, audit lines.
- `src/web/chat/openaiEngine.ts`: endpoint `preflight` before each request; endpoints with a preflight use `redirect: "error"` and fail as `down`.
- `src/web/main.ts`, `src/web/app.ts`: catalogue built at boot and read per request; routes mounted; proxy watcher reads the proxy URL per tick.
- `src/web/capabilities.ts`, `src/web/chat/service.ts`, `src/web/auth.ts`, `src/web/schemas.ts`, `src/web/users.ts`: owner effective presets = whole catalogue; `ownerCaps().presets` = []; caps presets max 128 checked against the catalogue; owner row `presets: "all"`.
- `src/web/runtime/paidRoutes.ts`: `dropPreset`. `src/web/audit.ts`: `models_*` kinds. `src/web/paths.ts`: `modelsFile`, `modelKeysFile`.
- `ui/web/models.js` (new), `ui/web/app.js`, `ui/web/admin.js`, `ui/web/app.css`: Models page, nav link, per-user Models checklist.
- `README.md`: "Web gateway: the Models page" with the UM1-UM8 checklist.
- Tests: `test/web/models.test.ts` (new: AC1, AC2, AC3, AC4, AC5, AC6, AC7), `test/bots/config.test.ts` (AC8 assertion), `test/web/app.ts` (optional `models` option for `makeApp`), `test/web/ui.test.ts` (owner editor now lists all presets).

### Deviations from the plan
- `ModelSource.defaults?` and `Classified.blocked?` added; a built-in without a runner block has `baseUrl: ""` (`isSetUp`).
- `fetchModels(source, deps)` takes the catalogue in `deps`; `proxyAuth` is exposed on `list` (UI reloads the list after a fetch).
- A tampered or invalid `models.json` disables all web presets, not only custom ones; `reloadSecurity` also re-checks `models.json`.
- Loopback custom sources (also "treat as cloud") skip `checkUrl`; a stored custom cloud source without billing makes its presets paid.
- `presets/remove` always drops paid grants; `presets/update` to subscription drops grants; `sources/update` billing paid raises all its presets to paid; `fetch` needs step-up.
- Security-review fixes beyond the plan text: redirect refusal for custom chat calls, `Object.hasOwn` key maps, reserved source ids (`claude`, `codex`, `ag`, `lms`, `strata`, `constructor`, `prototype`).

### Verification
- `corepack yarn build`: 0 errors.
- `corepack yarn test`: 1596 tests, 1595 pass, 0 fail, 1 skipped (baseline 1589 / 1588 / 1 skipped). Flakes did not occur.
- `securityWriter` boundary tests and `test/web/ui.test.ts` I57 grep passed.
- Read-only security review of the diff: no high findings; one medium and two low fixed (see plan section 10).
- Not run: the Models page in a browser, `runWeb` against a real config, real proxy / LM Studio / Strata / https provider; UM1-UM8 (user steps).

### Follow-ups / known limits
- Not fixed from the review: `isBlockedV6` gaps (`::/96`, `fec0::/10`) in `ssrf.ts`; loopback custom sources skip `BLOCKED_PORTS`; per-preset subscription on a paid source (owner choice); DNS rebinding residual (R2); custom key not in the gateway redactor.
- The builds replaced `dist/`, which the running `yarn web:local` gateway was started from; it keeps the old code in memory until restarted.
