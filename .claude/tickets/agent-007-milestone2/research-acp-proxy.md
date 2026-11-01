# Research: Anthropic (Sonnet/Opus) through the ACP proxy (2026-11-01, read-only)

Read: proxy `README.md`, `src/providers/claude.ts`, `src/server.ts` (/healthz), `tests/` listing; agent-007 `src/proxy/*`, `src/models/presets.ts`, `src/models/routes.ts`, `src/bots/schema.ts`, `src/bots/runtime.ts`, `config/config.example.json`, `ui/settings/app.js`, parent plan (D12, I39, I41, I42, UI-24, UI-25, UI-31, U52, U56, U58, deviations 130-132). NOT read: proxy `settings.json`, any key, token or .env. Nothing started. I could not confirm a running `api-acp-proxy` process (tasklist returned nothing for "acp"), so the live port, key and provider state are unverified.

## Where the proxy lives
`C:\projects\Personal\api-acp-proxy` (own git repo, yarn, Electron tray app plus headless CLI, default `http://127.0.0.1:8787`; settings in `%APPDATA%\api-acp-proxy\settings.json`, env overrides). Latest commit AAP-27. Tests in `tests/` (`claude.test.ts`, `tool-calling.test.ts` with a fake ACP fixture, `live.smoke.test.ts`).

## Providers today
Three built in: Codex (enabled by default, bundled `codex-acp`), **Claude (already merged: AAP-04, commit 737f031; `@agentclientprotocol/claude-agent-acp` 0.91.0 plus the native `claude` binary bundled), disabled by default**, and Google Antigravity (disabled). So "add Anthropic to the proxy" is NOT new provider code. It is: enable, acknowledge terms, log in, verify. Model ids are `claude/<id>` only (no bare alias), discovered at runtime from the agent; README examples `claude/default`, `claude/sonnet`. `claude/opus` is not named anywhere; it must be read from `GET /v1/models` (agent-007's `matchPresets` marks a preset unavailable if the id is not listed). Per-provider concurrency cap `PROXY_CLAUDE_MAX_CONCURRENT` (default 4), health at `/healthz` (per-provider active/queued only).

How Claude is run: text-only, built-in tools off, permission requests answered "cancelled", `settingSources: []`, `persistSession: false`; function tools (what agent-007 uses) go through a per-session `client` MCP server; tool calling for Claude is covered by `tool-calling.test.ts`.

## How agent-007 reaches it today
- `src/proxy/health.ts`: endpoint `http://127.0.0.1:<port>/v1`, GET `/healthz`, GET `/v1/models`, POST `/v1/chat/completions` only; default port constant 8787. `scripts/proxy/check-port.ps1` (user runs) prints the port; the proxy settings file is never read by an agent (U52).
- `src/proxy/setupCheck.ts` + `discover.ts`: compares `acp` presets with `/v1/models`; unavailable preset gets a reason. Key = `secrets.proxyApiKey` (I40).
- `src/models/presets.ts`: `presetProblem` refuses non-`acp`/`local` kinds, any `apiKeyRef` other than `proxyApiKey`, a `claude`/`antigravity` preset without `termsAccepted.<vendor>`. `src/bots/schema.ts` lines 56-61, 399-405, 444 are the loader versions of the same rules. `src/bots/runtime.ts`: provider id `acp-<providerId>`. `src/proxy/provider.ts` already has `ACP_CLAUDE` (modelId `claude/sonnet`). `routes.ts`: fallback only to `route.fallback` entries with `autoFallback: true`.
- Presets live in the user's `security.json` (written only by the owner settings UI forms, `PHASE4_SECURITY_KEYS` includes `bots`, `termsAccepted`). No preset ships in the repo, so "presets" = entries the owner adds.
- Parent plan: D12 made Codex the default proxy brain, Claude opt-in (I41, UI-24); every bot shipped with a local route. The 2026-11-01 decision supersedes the default (Claude Sonnet/Opus per bot) but not I39/D12 (no paid API key).

## What Anthropic needs, and the invariant
The proxy accepts three Claude credentials: `apiKey` setting / `ANTHROPIC_API_KEY` (per-token billing), `oauthToken` / `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, subscription), or the stored login in `~/.claude` or `configDir` (`claude auth login --claudeai` = subscription; `console-login` = Anthropic Console API billing). The proxy also passes any existing `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` from its environment.

Flags:
1. **Paid API key would breach I39/D12.** Only the subscription route is acceptable: `claude-ai-login`, or an OAuth token from `setup-token`. Never the `apiKey` field, never `console-login`.
2. **Silent switch risk.** agent-007 cannot see which credential the proxy uses (`/healthz` shows no auth info). If `ANTHROPIC_API_KEY` is set in the proxy's environment or settings, the Claude CLI may prefer it over the subscription login (my expectation, to be verified by the proxy owner/user, not confirmed here). Proposed proxy-side guard: a Claude `authPolicy: "subscription"` setting that strips `ANTHROPIC_API_KEY` from the child env and refuses to start if `apiKey` is set, plus `auth_method` (`subscription|oauth_token|api_key|none`) in `/healthz` so agent-007 `/status` and the setup check can refuse `api_key`.
3. **Terms.** Proxy README: using a Claude subscription through third-party tooling "may conflict with Anthropic's consumer terms"; parent plan notes reported blocks (UI-24, U58). Account at risk is the user's; sharing it with M2 guest users makes that worse (see plan UI-38).
4. **Login contention.** The same `~/.claude` login used by the user's own Claude Code sessions can produce `provider_busy` (OAuth refresh lock, 503 + `Retry-After: 30`). Proposed: dedicated `configDir` for the proxy (separate login, same account).
5. **Cloud egress.** A Claude-brained bot is cloud-capable (I42): tool output goes to Anthropic, `readRoots` become `cloudSafeRoots`, `shell`/`dispatch_job` need the UI-25 relax flag; at most one bot has `shell`.

## Gaps that need proxy-repo work (small)
- `auth_method` in `/healthz` and the subscription-only policy (item 2).
- Confirm `claude/sonnet` and an Opus id are listed for the user's plan; maybe pin stable aliases.
- Optional `PROXY_CLAUDE_MAX_CONCURRENT` default lower (subscription rate limits) .
- Everything else (enable, terms, login) is configuration, done by the user in the proxy app.
