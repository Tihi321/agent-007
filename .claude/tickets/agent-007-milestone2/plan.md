# Milestone 2: remote multi-user web access over Tailscale

Status: IMPLEMENTED OFFLINE up to gate G5 (see section 16). NOT done: MA1 (proxy repo), all user steps, live gates G6a/G6b. The plan text below is unchanged. Originally: PLAN ONLY (revised 2026-11-01). Starts after Milestone 1's offline gates and its non-Telegram live items; the deferred Telegram live items now run LAST, after M2 (section 15). Research: `research-acp-proxy.md`. Parent plan: `.claude/tickets/agent-007-pi-durable-mvp/plan.md` (IDs used there: D1-D12, I1-I46, UI-1-UI-32, S1-S27, U1-U59, G0-G4; this file continues from I47, UI-33, S28, U60, G5).

## 0. Scope statement (one line)

Narrow vs full reading: I build the **full** reading. The agent's own web app is reachable by other people on the tailnet, each person signs in, gets their own bots, chats (streaming, history, approvals) and data, and the owner invites and revokes them. It is a new chat product, not only a remote copy of the owner's settings UI.

## 0a. Decisions of 2026-11-01 (user)

1. **Default brain = the ACP proxy, Claude Sonnet or Opus**, chosen **per agent (bot)** in the bot editor (UI). Local Strata stays as the fallback and eval model. Which of Sonnet/Opus per bot is left to M2 (UI-45).
2. **Add Anthropic to the ACP proxy.** Finding: the Claude provider already exists in the proxy (AAP-04, disabled by default, terms-gated), so this is mainly enable + subscription login + verification, plus two small proxy-repo changes (step MA1). See `research-acp-proxy.md`.
3. **Node is installed with fnm.** P0.1 (machine-wide Node install) is CLOSED BY DECISION: Node v24.14.0 via fnm is the supported setup; no machine-scope install is required. Run Node/npm as `fnm exec --using default <command>`.
4. **Telegram later.** The M2 web bot interface comes first; once it works: test Tailscale, then Telegram.
5. ~~Invariant kept: a paid API key is never a brain or fallback (D12, I39).~~ **SUPERSEDED by item 6 (user, 2026-11-01).** The Claude *brain* (Sonnet/Opus) still uses the **subscription** route only (MA1, UI-46).
6. **Fallback chain (user, 2026-11-01), per bot, in order:** (a) brain = Claude Sonnet/Opus via the ACP proxy (subscription); (b) cloud fallback = any model routed through the ACP proxy, including paid routes (DeepSeek API, Anthropic API credits, Gemini), chosen per bot in the editor; every paid route is **off by default**, turned on by the owner, and must carry a spending cap (per day and per month) enforced and shown in the UI, hard-stopping at the cap; (c) local last resort = Strata `qwen3.8-flash-next` or Qwen 3.8 27B on LM Studio (better quality, slower), chosen per bot. A local model failing the M1 eval bars is non-blocking (M1 deviation 192). D12/I39 must be revised in the M2 invariants (section 9) to: "a paid route is never used unless the owner enabled it for that bot and its cap has headroom; usage is audited." The full eval bars are re-run on the Sonnet brain in M2 (routing + settings evals, which were not completed on Strata in M1).

## 1. Research summary (what the references do, what we take)

Sources: [Hermes dashboard docs (mirror)](https://download.hermesedi.duckdns.org/.hermes/hermes-agent/website/docs/user-guide/features/web-dashboard.md), [hermes_client](https://github.com/lotsoftick/hermes_client/wiki), [hermes-webui](https://github.com/dtera/hermes-webui), [Grok companions overview](https://www.layer3labs.io/guides/grok-companions-explained), [Tailscale Serve](https://tailscale.com/kb/1312/serve), [Open WebUI Tailscale SSO notes](https://docs.openwebui.com/tutorials/auth-sso/tailscale).

- Hermes Agent (Nous): the official `hermes dashboard` (port 9119) is an admin panel (config, keys, MCP, sessions, logs, analytics, cron, skills) plus a Chat tab. It has profiles (each with its own home dir, config, sessions), a profile switcher, a recent-sessions list (model, message count, tokens, preview) and resume-by-URL. Community UIs map one "agent" to one profile and stream over SSE; one adds session tags and projects and a token-usage ring. Chat is not supported on native Windows in the official one. Takeaways: profile = isolated bot, session list with preview and resume link, token meter, SSE streaming.
- Grok companions: fixed named characters with a face, voice and fixed personality, a mode inside the app. I could not confirm that users can define their own, or that the feature is still current. Takeaways only: a character card (name, avatar, one-line tagline) and a persona the user feels they "own". No voice or animated avatar in M2.
- Tailscale: Serve adds `Tailscale-User-Login` and `Tailscale-User-Name` headers on tailnet traffic only; Funnel traffic has none; tagged devices get none. Tailscale says a backend trusting the headers must listen on localhost only, since otherwise anyone who can reach it directly can forge them.

Features chosen (our own UI, not a clone):
1. Bot cards (avatar, name, tagline, model badge) in a left list, "new bot" button.
2. Bot editor: name, avatar (preset gallery or small upload, re-encoded), persona prompt, model preset (from the caps the owner gave the user), tool allowlist (checkboxes limited to the user's caps), memory on/off, starter prompts.
3. Chat per bot, with several threads per bot; thread list with title, preview, time, rename, delete, pin; search; export.
4. Streaming tokens (SSE), stop button, regenerate, tool-call chips, approval cards (same Approve / Deny / Why as Telegram), usage meter against the user's quota.
5. Mobile-first layout (the user opens it from a phone on the tailnet).
Not in M2: voice, animated avatars, public bot sharing between users, a bot marketplace, group chats between users.

## 2. Architecture

```
other device (tailnet, signed in to Tailscale)
   |  https://<host>.<tailnet>.ts.net  (tailnet cert, WireGuard)
   v
tailscaled on the agent PC:  tailscale serve --bg https / http://127.0.0.1:47009
   |  adds Tailscale-User-Login / -Name, proxies to loopback only
   v
Web gateway (new, 127.0.0.1:47009, node:http, runs in the job runner process family)
   |  authn (identity header check + app login + session), authz (role + user caps), CSRF, rate limit, audit
   v
Per-user runtime facade  --->  BotManager / BotBus / Harness  (in-process, user-scoped bot ids)
   |                             data: %LOCALAPPDATA%\agent-007\users\<userId>\...
   v
Owner settings UI (47008) stays separate, loopback only, never exposed through serve.
```

Decisions:
- **New gateway app on its own port 47009; do not expose 47008.** The owner settings UI runs with full rights and edits security.json (I25 series). Exposing it is the largest single risk, so it stays loopback-only and unproxied (assert in a test that `tailscale serve` config never targets 47008). Only user management actions that need the owner (invite, revoke, caps) are done in the gateway by an owner-role session, and they never touch security.json directly; they write a separate `users.json` (see 3).
- **Tech: same as the repo.** `node:http` plus vanilla JS, no framework, no dependency, strict CSP, no `innerHTML` (I25a). A chat UI is bigger than the settings forms; keep a small hand-written component layer (`ui/web/`), copied to `dist/ui/web/` by the existing copy step. Only added dependency candidate is a WebAuthn verifier (`@simplewebauthn/server`); decision UI-34 below. Default if no dependency is wanted: password + TOTP with `node:crypto` only.
- **Gateway process.** Runs inside the job runner (as the 47008 UI does) or the agent process? Chat needs the live Harness, which lives in the agent process. So the gateway lives in the **agent process** and exposes only the chat and bot APIs; the job runner is reached only through the existing IPC and its existing approval flow (UI-35 records the choice).
- **Native Windows is fine** (no PTY, unlike Hermes chat): chat is built on our Harness, not a terminal.

## 3. Data model (new files, all append-only or atomic-write, ACL rows added to `check-acl.ps1`)

- `users.json` (owner-written only): `{ users: { <userId>: { login, displayName, role: owner|admin|user, status: active|disabled, caps {presets[], tools[], maxBots, maxChatsPerDay, maxTokensPerDay, maxJobsPerDay: 0, storageMB}, createdAt, invitedBy } } }`. `userId` is a random 128-bit id, never the login string (logins can be reused or renamed).
- `invites.json`: `{ id, codeHash (sha256 of a 160-bit code), role, caps, expiresAt (default 24 h), usedBy?, tailscaleLoginPin? }`. The code is shown once to the owner, single use.
- `credentials.json`: per user, WebAuthn credentials (id, publicKey, signCount) or `{ passwordHash (scrypt), totpSecret (encrypted at rest, DPAPI or secrets store) }`, plus recovery codes (hashed).
- `sessions.json` (or in memory plus file): `{ idHash, userId, createdAt, lastSeen, ip, uaHash, expiresAt }`.
- `web-audit\` JSONL, append-only, I29/I45 style: login ok/fail, lockout, invite create/use/revoke, user change, bot create/edit/delete, tool-call denials, approvals, quota hits. No message bodies (only sha256 and length).
- Per user tree `%LOCALAPPDATA%\agent-007\users\<userId>\`: `bots\<botId>\{state\agent.sqlite, memory\MEMORY.md, skills\, workspace\, logs\}`, `prefs.json`, `threads\`, `uploads\`, `quota.json`. Same shape as the I43 per-bot directories, one level deeper.

## 4. Mapping to existing machinery

- **Bots.** Owner bots stay in `security.json` `bots.<id>` (S20). Users' bots are NOT written to security.json (that would put user input in the owner's trust file and require restarts). They are `userBots` records under `users\<userId>\bots\<id>\bot.json`, validated by the same schema code as S20.1 but with a hard-coded ceiling: route limited to presets in the user's caps, `tools` subset of the user caps, `readRoots` = only the user's own `workspace\` and `uploads\`, `shared` none, `edges` none (no `ask_bot` to anyone else's bot), no Telegram token (web only). BotManager gets a second registration source (`registerUserBot(userId, cfg)`), with the runtime bot id namespaced `u:<userId>:<botId>` so a collision with owner bot ids is impossible and BotBus can never address across users.
- **Prefs, memory, skills.** `prefs.json` per user (the in-process race is closed by the per-file lock + updateAudited, M1 dev 130–134; M2 must add cross-process safety only if the gateway runs as a separate process (UI-35); user prefs are per-user files so they avoid it). Memory store and `MEMORY.md` per bot dir (I43 already isolates per bot). Owner memory and `FACTS.md` are never mounted for user bots.
- **Files.** Path resolution reuses the I43 resolver rooted at the user dir; a path test proves `..`, junctions and symlinks cannot leave it. Owner allowlist folders and `folders.deny` apply on top.
- **Approvals.** The approval gate (src/approval) today routes to the owner's Telegram. For users: tool approvals for a non-owner are **shown in the web chat to that user** for what the user is allowed to do (e.g. a read-only research tool that needs "ask first"), and anything that touches the host, jobs or spend is simply not available to non-owners (see 5). Owner-side approvals stay on Telegram. A user can never approve on behalf of another user or the owner (token bound to `userId`, I47).
- **Job quotas.** Default `maxJobsPerDay: 0`; `dispatch_job` is not loaded for user bots. If the owner later grants jobs, each job still needs the owner's Telegram approval (D8 unchanged) and counts against the user's quota.
- **Model capacity.** One local model server serves everybody. A per-user concurrency of 1 chat turn and a global queue reuse I44 priorities: the owner's Telegram message stays P0, user chat turns sit between peer P1 and P2 (I51) so a guest cannot starve the owner.

## 5. Tool and peer rules for non-owners (extends I36)

Non-owner default (user and admin roles alike; admin only manages users, it adds no host power): no `shell`, no file write outside the user's workspace, no `dispatch_job`, no Flow, no `ask_bot` / `list_bots` to owner bots, no MCP servers except ones the owner added to a `userSafeMcp` list, no owner `remember`, no web fetch beyond a configured allowlist (SSRF guard to private ranges, loopback and tailnet 100.64.0.0/10, including the Strata and LM Studio ports). The always-loaded cap (I27: 10 per bot) applies per user bot. Cloud presets are available to a user only if the owner lists them in that user's caps (cost and data-egress decision, UI-38). The owner can always read the web audit log, never chat bodies unless the user exports them (privacy default, UI-39).

## 6. Auth: layers, in order, all must pass

1. **Network.** Reachable only through the tailnet. `tailscale serve` only; no `tailscale funnel` (a startup check runs `tailscale serve status --json` and refuses to start the gateway, with a loud audit line, if any Funnel entry exists or the gateway bound to a non-loopback address). Windows Firewall: no inbound rule for 47009 (nothing to open, since serve connects to loopback). Tailscale ACL (owner pastes into the admin console, we only print it): allow only `autogroup:member` or a named group `group:agent007-users` to `tag:agent007-host:443`, deny everything else, and tag the PC with `tag:agent007-host` after checking the tagged-device header caveat (tagged nodes get no identity headers for traffic from them, but the header concerns the client side; the host being tagged is fine). Node sharing to outside tailnets works with headers too; keep sharing off unless wanted (UI-33).
2. **Tailscale identity.** The gateway accepts `Tailscale-User-Login` only if the TCP peer is loopback AND (a) the request carries the serve-specific `X-Forwarded-*` shape and (b) a `tailscale whois <peer>` check via `127.0.0.1` local API agrees (as OpenClaw does). Requests with the header from anywhere else are rejected and audited. The login must match a user record or a pending invite; unknown login gets a generic 403 page with no hint whether a user exists.
3. **App login.** Passkey (WebAuthn, RP ID = the ts.net hostname, user verification required) is the default; fallback password (scrypt, min 12 chars) + TOTP. A session requires login to match the Tailscale identity bound to the user record (an attacker on a stolen tailnet device still needs the passkey or password+TOTP).
4. **Session.** Random 256-bit id in a `__Host-` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`), server-side record, idle timeout 8 h, absolute 7 d, rotate on login and privilege change, revoke on disable, "sign out everywhere".
5. **CSRF and origin.** Per-session CSRF token header on every state-changing request, `Origin` must equal the serve host, SSE and fetch only same-origin, strict CSP, `frame-ancestors 'none'`, no CORS.
6. **Abuse limits.** Per-login and per-IP token buckets, exponential lockout (5 fails then 15 min, doubling, cap 24 h) with the owner notified on Telegram, body size caps, SSE connection cap per user, per-user turn and token quotas.
7. **Audit.** Everything above to `web-audit\`, append-only grant like `bus-audit` (the dev-102 gap is already closed script-side per S28; the new audit folders reuse Set-AppendOnlyDirAcl / Test-AuditFolder).
8. **Fail closed.** No users file, corrupt users file, clock skew beyond a bound, `tailscale` CLI missing, or serve status unreadable all mean the gateway does not listen. Kill switch: the existing Telegram `/killswitch` also drops all web sessions; owner CLI `web-lockdown` does the same.

**Owner bootstrap.** First run: gateway starts in "unclaimed" mode and listens on loopback only with `serve` NOT configured. The owner runs `npm run web-owner-code` on the PC, which prints a one-time code (also valid only from loopback, 10 min); in a browser **on the PC** they open `http://127.0.0.1:47009/claim`, enter the code, register a passkey (or password+TOTP), and receive recovery codes. Only after that does the setup script offer to run `tailscale serve`. The owner Tailscale login is recorded and pinned. Recovery path: physical access to the PC and `web-owner-code --reset` (needs the Windows owner account; audited).

**User invites.** Owner (in the gateway, owner session, re-auth by passkey for sensitive actions) creates an invite: pick Tailscale login (optional pin), role, caps, expiry. The code is shown once and sent by the owner out of band. The invitee opens the URL from their tailnet device, the Tailscale identity is pinned to the invite, they enter the code and enroll a passkey or password+TOTP. Revoke: disable the user, kill sessions, keep data (archive) or delete data (typed confirmation, deletion audited, files wiped).

## 7. Web UI (extend vs new)

New app `ui/web/` served by the new gateway, sharing design tokens and the small helper modules with `ui/settings/` (copied into a shared `ui/common/` in S33; no framework). The settings UI is not extended because it serves a different trust level (owner, full rights, loopback) and a different task (forms, diffs, audit).

Screens: sign-in / claim / accept-invite; Bots (list + editor); Chat (thread list, messages, composer, approval cards, usage meter); Account (devices and sessions, passkeys, export my data, delete my data); Admin for the owner (users, invites, caps, audit view, lockdown button). Layout: two-pane on desktop, single column with drawer on mobile, 44 px touch targets, dark and light, keyboard accessible, `aria-live` for streaming. Streaming over SSE with `Last-Event-ID` resume; the thread transcript is stored server-side so reload loses nothing. Markdown rendered by a small safe renderer (no HTML pass-through, links `rel=noopener`, images blocked unless same-origin upload).

## 8. Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | Someone not on the tailnet | Serve is tailnet-only; no Funnel; no inbound port; startup check |
| T2 | Tailnet member who is not invited | Identity header must match a user; generic 403; ACL group restriction |
| T3 | Forged `Tailscale-User-Login` by a LAN or local process | Loopback-only bind plus whois cross-check; residual: another local process on the PC can forge (accepted, same as any local malware; app login still required) |
| T4 | Stolen tailnet device or stolen session cookie | Passkey or TOTP bound to the identity; short idle timeout; device list and revoke; `__Host-` cookie, SameSite=Strict |
| T5 | Cross-user data access (IDOR, path traversal, bot id guessing) | Every route resolves the user from the session, never from a path param; ids namespaced `u:<userId>:`; path-root tests; per-user SQLite files |
| T6 | Prompt injection making a user's bot reach host power | Non-owner tool set has no host tools at all (capability absent, not policy-denied); SSRF guard; no cross-bot edges; I36 taint rules carried over |
| T7 | A user's persona prompt jailbreaks the owner bot | Different bot id and runtime; no shared memory or peer edge; persona text is data inside that user's bot only |
| T8 | Resource exhaustion of the single local model | Per-user concurrency 1, quotas, global queue priority below the owner |
| T9 | XSS and CSRF | Strict CSP, no innerHTML, safe Markdown, CSRF token, origin check |
| T10 | Invite theft or replay | Hashed code, single use, 24 h expiry, login pin, rate limit |
| T11 | Brute force | Rate limit, lockout, passkeys have no password to brute force |
| T12 | Privacy: owner reading users' chats, or logs leaking bodies | Audit has hashes only; owner has no chat-read UI (UI-39) |
| T13 | Gateway compromise reaches owner secrets | Gateway runs with the same Windows user (v1 residual risk, as UI-28); owner secrets are never loaded into user bot contexts; documented; option of a separate Windows user left to UI-36 |
| T14 | Cost and egress through cloud presets | Presets only by owner caps; owner approval for cloud on non-owner (UI-38); every turn re-checks the route and tools against the CURRENT caps, terms and paid grants (existing bots included); paid routes off per bot until the owner sets a daily and monthly cap (I58, S38) |

## 9. New invariants (continue after I46)

- **I47** Every gateway request resolves to exactly one `userId` from a verified session; no handler accepts a userId, botId or path from the client without checking that it belongs to the session user.
- **I48** The gateway binds only to 127.0.0.1; startup refuses any non-loopback bind, any Funnel entry in serve status, and any serve target other than 47009 (never 47008 or 47007).
- **I49** `Tailscale-User-*` headers are trusted only when the peer is loopback and the whois check agrees; otherwise they are ignored and audited.
- **I50** Non-owner bots never have shell, host file write, `dispatch_job`, Flow, owner `remember`, or any edge to a bot they do not own. The capability is absent from the registry, not just denied (test enumerates the registry).
- **I51** Scheduling: owner Telegram P0; peer P1; user web turns sit between P1 and P2; per-user concurrency 1.
- **I52** User data lives only under `users\<userId>\`; deleting a user removes that tree; no user path appears in security.json or the owner's settings UI.
- **I53** Credentials, TOTP secrets, invite codes and session ids are stored hashed or encrypted and never logged or returned after creation.
- **I54** Web audit is append-only and contains no message bodies.
- **I55** Failing closed: any missing, corrupt or unreadable auth input disables the gateway rather than opening it.
- **I56** Owner-only actions (invite, caps, delete user, lockdown) require an owner role and a fresh passkey or TOTP confirmation (under 5 minutes old).
- **I57** The web UI follows I25a (no framework, strict CSP, no innerHTML), and the new gateway adds no dependency other than the WebAuthn verifier if UI-34 says so.
- **I58** (replaces D12/I39's "a paid API key is never a brain or fallback", user 2026-11-01, section 0a item 6) A paid route is never used unless the owner enabled it for that bot and its cap has headroom; usage is audited. A paid preset is marked `billing: "paid"`; only web bots can be granted one (an owner Telegram bot listing it is refused by the loader, since no cap exists there yet). The route of every turn is computed from the current caps, terms and grants, never from what the bot was saved under.

## 9a. Anthropic brain through the ACP proxy (steps MA1-MA4, done BEFORE S28)

Where: proxy repo `C:\projects\Personal\api-acp-proxy` (MA1 only; read-only until the user approves changes there, UI-46) vs this repo `C:\projects\Personal\agent-007` (MA2-MA4).

| Step | Repo | What | Done when | Tests |
|---|---|---|---|---|
| MA1 | proxy repo | (a) `providers.claude.authPolicy: "subscription"` (default for new installs): strip `ANTHROPIC_API_KEY` from the child env, refuse to start with `api_key_not_allowed` if the `apiKey` setting is set, hide the `console-login` method. (b) `GET /healthz` adds `providers.claude.auth_method` (`subscription`, `oauth_token`, `api_key`, `none`), never a secret. (c) Confirm `/v1/models` lists `claude/sonnet` and an Opus id for the user's plan. | With the policy on and `ANTHROPIC_API_KEY` in the env, the child does not get it; healthz shows the auth method; proxy README updated | `tests/claude.test.ts` plus a fake-ACP case for env stripping and healthz; no real login in tests |
| MA2 | agent-007 | `src/proxy/health.ts` parses optional `auth_method`; setup check and `/status` report it; **refuse** the Claude preset (mark "needs attention", no calls) when it is `api_key`; missing (older proxy) is a warning, not a block. Presets `claude-sonnet` and `claude-opus` (kind `acp`, providerId `claude`, `apiKeyRef: proxyApiKey`, privacy `cloud`, `autoFallback: false`; `contextWindow`/`maxTokens` set by hand, U52) documented in `config/config.example.json` comments and offered as templates in the settings UI preset form. `termsAccepted.claude` stays UI-only (I41, UI-24). | Preset forms create both presets; the loader still refuses any other `apiKeyRef` and a Claude preset without the terms flag | Presets/loader tests extended; `matchPresets` with `claude/sonnet` and the Opus id; setupCheck fake-proxy test with and without `auth_method` |
| MA3 | agent-007 | Per-agent default brain in the bot editor (owner settings UI forms now, the M2 web editor in S35): `route.primary` = a Claude preset, `route.allowed` = Sonnet, Opus, Strata, `route.fallback` = the Strata preset with `autoFallback: true` (cloud to local narrows privacy, so no new egress). I42 applies: a Claude-primary bot is cloud-capable, so its `readRoots` are `cloudSafeRoots` and `shell`/`dispatch_job` stay off unless the UI-25 relax flag is set (at most one shell bot, UI-47). The editor shows a cloud badge and a one-line egress note. Strata stays the eval model (S27 and the multi-bot eval keep running on it). | A new bot can be created with Sonnet or Opus as default and a Strata fallback; on 503 `provider_auth_required` or proxy down, I39 falls back to Strata once and tells the user once | Route/UI tests with a fake proxy: primary Claude, proxy 503, fallback to Strata; shell on a Claude-primary bot refused without relax; editor form fixture |
| MA4 | agent-007 | Comparison eval: run the S27 tool-use eval and the multi-bot routing eval on `claude-sonnet` through the proxy. The pass bar stays defined on Strata. | Result file in the ticket folder; no gate depends on it | Harness runs against the fake proxy offline; the real run is user step U67 to U70 |

User steps (nothing run by the agent): **U67** in the proxy app: enable Claude, accept the terms, log in with **Claude subscription** (not Console, no API key; prefer a dedicated config dir to avoid `provider_busy` with Claude Code), set `PROXY_CLAUDE_MAX_CONCURRENT` low (proposed 2). **U68** re-check Anthropic's terms for this use (U58 extended to Claude) and set `termsAccepted.claude` in the settings UI. **U69** run `scripts/proxy/check-port.ps1`, copy the proxy key into `secrets.json` yourself, run the setup check, confirm `claude/sonnet` and the Opus id are listed. **U70** make a test bot with Sonnet primary and Strata fallback; stop the proxy and confirm the fallback.

## 10. Steps (S28 onward; each: owner files, done-criteria, tests; all offline-testable with fakes first)

| Step | What | Done when | Tests |
|---|---|---|---|
| S28 | Foundations: `users.json`, `invites.json`, `credentials.json`, `sessions` stores; `userId`; ACL rows in `check-acl.ps1` (new user/auth audit folders reuse `Set-AppendOnlyDirAcl` / `Test-AuditFolder`; the dev 102 `bus-audit` gap is already closed script-side); paths helper for `users\<id>\` | Schemas validate; corrupt file means loader error; ACL script dry-run lists the new rows | Schema fuzz; atomic write; I52, I53 tests |
| S29 | Gateway skeleton `src/web/`: loopback-only server, router, security headers, CSRF, origin check, rate limiter, body caps, audit writer, fail-closed startup (I48, I55) | Server refuses non-loopback host and serve-status with Funnel (fake status JSON); headers asserted | Header, CSRF, origin, rate-limit, lockout unit tests; `grep` test for innerHTML/eval |
| S30 | Tailscale integration module + scripts `deploy/web/tailscale-serve.ps1` (prints ACL snippet, prints the exact `tailscale serve` command, `-DryRun` default, `--remove`), identity verifier with `whois` fake | Dry run prints commands and changes nothing; verifier matrix passes (loopback+whois ok, header from other peer rejected, tagged device, Funnel) | I49 matrix; script `-WhatIf` test with fake `tailscale.exe` shim |
| S31 | Owner bootstrap and auth: claim flow, passkey (or password+TOTP) per UI-34, sessions, recovery codes, `web-owner-code` CLI | Claim works only from loopback within 10 min; second claim refused; session cookie flags correct | WebAuthn with software authenticator fixture; TOTP vectors; session rotation tests |
| S32 | User management: invites, accept flow, roles, caps, disable/revoke, delete with confirmation, per-user limits, step-up (I56) | Invite single use and expiring; revoked user's sessions die at once | Replay, expiry, pin mismatch, IDOR tests, role matrix |
| S33 | Per-user runtime: `userBots`, `registerUserBot`, namespacing, per-user dirs, user caps ceiling over S20 schema, non-owner tool registry (I50), SSRF guard, queue priority (I51) | A user bot cannot be built with a tool or root outside caps; registry test shows no host tools; two users cannot see each other's files, memory, threads | Cross-user isolation suite (path, symlink, id guess, BotBus address), registry enumeration, scheduler fairness with fake model |
| S34 | Chat API: threads, messages, SSE streaming with resume, stop, regenerate, approval cards via web for user-scoped approvals, usage and quota | Streaming works against the fake harness; reload restores thread; quota blocks with a clear message; approval token bound to userId | SSE tests, approval-token tests, quota tests |
| S35 | Web UI `ui/web/`: sign-in/claim/invite, Bots list+editor, Chat, Account, Admin; mobile layout; shared tokens in `ui/common/`; copy step | Screens render against a fake gateway; keyboard and screen-reader basics; Lighthouse-style a11y checklist done by hand | DOM tests (jsdom-free, string assertions as in S18), CSP grep, size budget |
| S36 | Hardening and review: security review pass over the diff, red-team script of T1-T14 against a local fake tailnet harness, privacy export and delete, docs `deploy/web/README` with the user steps | All T-rows have a passing test or a recorded accepted residual risk | Red-team suite; `npm test`, `check:adapter` stay green |
| S38 | Paid-route spending caps (section 0a item 6, I58): `billing: "paid"` on a preset; a bot chain of main, cloud fallback, local fallback; every paid route OFF per bot until the OWNER enables it (step-up) with a required per-day and per-month token cap; a per-bot usage ledger; hard stop at the cap (turn refused, or the chain falls back with one notice; the engine clamps `max_tokens` to the headroom and ends the answer when it is used up); audited (`paid_grant`, `paid_usage`, `paid_cap_hit`); shown in the bot editor, the bot cards, the chat usage line and an owner Admin section. Also M1: each turn re-checks route and tools against the CURRENT caps and terms. | A paid route never answers without an owner grant with headroom; lowering caps changes the next turn of existing bots | `test/web/paid.test.ts`, `test/web/redteam.test.ts` T14, `test/web/engine.test.ts` (M2 budget), `test/bots/config.test.ts` (I58 loader) |
| S37 | Live acceptance (user steps), in this order: L1 web UI on the PC over loopback, L2 Tailscale, L3 Telegram | Gates G6a, G6b and section 15 | U60+ checklist, reordered below |

U60 to U66 (user steps, nothing run by the agent), now in phases. **L1, loopback only, no Tailscale yet:** claim the owner account on the PC at `http://127.0.0.1:47009/claim`; create a bot, pick Sonnet or Opus in the editor, chat, see history after reload (needs MA1 to MA3 and U67 to U70). **L2, Tailscale, after L1 passes:** install Tailscale and sign in; enable MagicDNS and HTTPS certs in the admin console; paste the ACL snippet; run `tailscale-serve.ps1` (dry run, then real) [GO]; invite a second person or a second own device; test from a phone. **L3, Telegram:** section 15.

## 11. Gates

- **G5 (offline gate, end of S36):** build 0 errors; full test suite green including cross-user isolation, I47-I57 tests, red-team suite; `check:adapter` PASS; security review has no open high or medium; scripts dry-run clean; the Milestone 1 test count has not dropped.
- **G6a (live gate, local web UI, first):** claim works on loopback only; owner login and lockout behave; a bot with Claude Sonnet or Opus as default chats with streaming; stopping the proxy falls back to Strata once with a message; reload restores history; the per-bot model choice persists; a Claude-primary bot cannot get `shell` without the relax flag; healthz `auth_method` is `subscription`.
- **G6b (live gate, Tailscale, second):** items (1) to (8) below, over the tailnet.
- **G6 item list (run after G6a; item 9 belongs to L3, Telegram, last):** (1) from a second tailnet device the app loads over HTTPS and from a non-tailnet device it does not load at all; (2) a tailnet member without an invite gets the generic 403; (3) `tailscale serve status` shows only 47009 and no Funnel; (4) owner passkey login and lockout behave; (5) an invited user creates a bot, chats with streaming on a phone, sees history after reload; (6) that user cannot see the owner's or another user's bots, files or memory (manual probes); (7) revoke kills the session within one request; (8) a prompt-injection probe in a user bot cannot run shell or reach 127.0.0.1:8080/1234; (9) owner Telegram turns stay responsive while a user chats.

## 12. Open decisions for the user (UI-33 onward)

- **UI-33** Tailscale sharing and ACLs: only your own tailnet members (proposed), or allow node-sharing to other tailnets? Use `tag:agent007-host` plus a group (proposed)?
- **UI-34** Login method: passkeys (WebAuthn, adds one dependency, proposed) or password+TOTP with no dependency? Passkeys and Windows Hello on the PC: confirm how the owner will sign in on the PC itself.
- **UI-35** Gateway placement: in the agent process (proposed, needs the live Harness) or a separate process talking over IPC (more isolation, more work).
- **UI-36** Keep one Windows user (proposed, residual risk T13) or run the gateway under its own Windows user (needs a plan revision, like UI-28).
- **UI-37** Roles: is `admin` needed (proposed: yes, can invite and disable but not change caps above their own, no host settings), or owner and user only?
- **UI-38** (revised 2026-11-01) The owner's own bots default to Claude Sonnet/Opus (section 0a). **User caps stay as the owner sets them;** the suggestion for a new user remains local presets only (Strata), N bots (proposed 3), token/day and chats/day numbers, jobs 0. A Claude preset in a user's caps spends the OWNER's Claude subscription and sends that user's data to Anthropic; lending a personal subscription to other people is the case most likely to break Anthropic's terms. So: never by default, only per user by an explicit owner cap, with the quota shown. Decision wanted.
- **UI-39** Privacy: owner cannot read users' chats (proposed) or may, with a visible banner and audit?
- **UI-40** (revised 2026-11-01) Which brain serves users: Strata (proposed for users; 1 concurrent user turn globally at first, `localBotsOnStrata` interplay) while owner bots default to Claude through the proxy. If a user cap lists a Claude preset, the proxy's per-provider cap (`PROXY_CLAUDE_MAX_CONCURRENT`) is shared with the owner's bots; owner priority (I51) is enforced by agent-007's own gate, since the proxy queue is FIFO.
- **UI-41** Web tools for user bots: none (proposed) or a fetch/search allowlist?
- **UI-42** Avatars: preset gallery only (proposed) or uploads (needs image re-encode)?
- **UI-43** Hostname and cert: use the default `<host>.<tailnet>.ts.net` (proposed) or a custom name via serve services?
- **UI-44** Data retention and deletion defaults for revoked users (archive 30 days then delete, proposed).

- **UI-45** Default for `main` and new owner bots, Sonnet or Opus (per-bot choice in the editor; proposed: Sonnet default, Opus per bot, because of subscription limits)?
- **UI-46** Approve MA1 in the proxy repo (subscription-only policy, `auth_method` in healthz)? Proposed yes. Alternative: no proxy change, the user guarantees no `ANTHROPIC_API_KEY` in the proxy's settings or environment, and agent-007 cannot verify it.
- **UI-47** A Claude-primary bot is cloud-capable (I42): keep `main`'s shell and jobs off, give shell to a separate local-only bot (proposed), or set the UI-25 relax flag on `main`?
- **UI-48** The earlier default (Codex as proxy brain, UI-24) is superseded for new bots; keep Codex as an allowed, non-default preset (proposed)?

## 13. Risks

- Largest: the gateway sits in a process with the owner's rights; one bug in path handling or tool registry exposes the PC. Mitigation: capability absence (I50), isolation suite, security review S36, optional separate Windows user (UI-36).
- WebAuthn on a `ts.net` RP ID is bound to the exact hostname; renaming the machine or tailnet invalidates passkeys (needs recovery codes and an owner re-enrol path).
- Tailscale behaviour (header population, `whois`, serve JSON shape) can change with versions; pin a minimum version and make the verifier fail closed.
- One local model for everyone: latency for guests and contention with the owner; quotas and priority only soften it.
- Scope growth: a chat product is large; S35 must stay within the no-framework rule or the framework decision gets reopened as a UI-xx.
- Milestone 1 blockers, status as of 2026-10-31 (see parent plan §14 deviations):
  - Resolved offline: shared `prefs.json` race in-process (per-file lock plus `updateAudited`, dev 130-134); bus-audit ACL script side (dev 140-141, 160-161); persona preset drift (dev 142); retry semantics (dev 98 RESOLVED).
  - Remaining live user steps: the live `bus-audit` ACL grant; cross-process `prefs.json` writes are still open (user prefs here are per-user files, so they avoid it).
  - Live S27 eval (Strata) remains an M1 item. It no longer waits on Telegram, but the Strata fallback/eval model should pass before MA3 is relied on. The first LM Studio run failed at 74.1%; a Strata re-run was in progress.
  - Anthropic via proxy: terms risk (U58, U68); silent API-key billing if `ANTHROPIC_API_KEY` reaches the proxy (MA1); login contention with Claude Code (`provider_busy`); subscription rate limits for a Sonnet/Opus default brain; cloud egress for Claude-brained bots (I42).
- Hermes and Grok details came from third-party summaries and one doc mirror; features were picked as inspiration only, so errors there do not affect the design.

## 14. Rules carried over

Pixotope and work data off-limits; no installs, system changes, firewall, ACL, scheduled-task or registry edits by the agent; scripts are written and dry-run only; tokens never through chat; all secrets via the secrets prompt; user runs everything marked [GO] (and elevated steps [ADMIN]).

## 15. M1 live items that move after M2 (Telegram last)

Live order: **L1 local web UI, then L2 Tailscale (G6 tailnet checks), then L3 Telegram.** Reason (decision 2026-11-01): the M2 bot interface lets the owner test everything without Telegram first. These M1 live items are deferred until after G6b, in this order:

| Item | Source | Notes |
|---|---|---|
| Telegram live acceptance on the real deployment, the Telegram/phone-facing items of S8.3 (1 to 14) | G1, `phase1-acceptance.md` | Items needing no Telegram (ACL, `check-acl.ps1`, runner suite S8.2, restart/reboot) stay in M1 and run before L1 |
| Phone items (settings UI from the phone, Approve/Deny/Why, job progress messages) | G2, G3, G4 (`phase2-acceptance.md`, `phase3-acceptance.md`) | |
| `/status`, `/model`, `/killswitch` live | G2 to G4 | The web kill switch (S31, S36) is tested first in L1/L2 |
| Multi-bot: one Telegram token per bot, room mirror | G4 | After the web chat shows the bots work |
| G6 item (9): owner Telegram stays responsive while a guest chats | G6 | |

Not deferred: P0.1 (closed by decision, Node via fnm), the live S27 eval on Strata, U52/U56/U58 proxy checks (needed for MA2 to MA4), the `bus-audit` ACL grant. The Telegram token setup (`deploy\new-secrets.ps1`) can wait until L3.

## 16. Implementation status (worker run, 2026-11-01, branch agent-007-milestone2)

Scope of this run: MA2, MA3, MA4 (offline harness), S28 to S36, up to the offline gate G5. NOT in scope and NOT done: MA1 (lives in `C:\projects\Personal\api-acp-proxy`, not touched), S37 and every U step, live gates G6a/G6b, Tailscale commands, Telegram. Nothing paid was called; no server was left running; every test uses fakes.

### Checklist

| Step | Result | Commit | Evidence |
|---|---|---|---|
| MA2 | DONE (offline) | bcde31a | `test/proxy/ma2.test.ts` (5 tests): healthz `auth_method` parsed; setup check reports it; Claude preset refused (no proxy call, falls back) on `api_key`; older proxy = warning only; `claude-sonnet`/`claude-opus` templates in the Models form and `config.example.json`. |
| MA3 | DONE (offline) | 8ae734b | `test/bots/brain.test.ts` (5 tests): `src/bots/brain.ts` route builder, shell/dispatch_job stripped on a cloud bot, loader refuses them without relax, proxy 503 and a downed proxy fall back to Strata once with one notice, cloud badge + egress note, bots-form templates. |
| MA4 | DONE offline; real run NOT DONE (user steps U67 to U70) | a83fe92 | `test/proxy-eval.test.ts` (4 tests): `--proxy-port` on the routing, multi-bot, settings and bake-off scripts, proxy pre-check; `claude-sonnet-eval-results.md` says the real run is pending. |
| S28 | DONE | 157bb24 | `test/web/foundations.test.ts` (7): schemas, fuzz, corrupt file = loader error, atomic write, I52/I53/I54, ACL script rows (`check-acl.ps1`, `grant-folder-acls.ps1`). |
| S29 | DONE | 76ab190 | `test/web/gateway.test.ts` (12): headers on every response, Host, CSRF, origin, rate limit, lockout (5 then 15 min, doubling, 24 h cap), SSE slots, serve-status matrix (Funnel, 47008, 47007), fail-closed start, no innerHTML/eval. |
| S30 | DONE | 9917b5b | `test/web/tailscale.test.ts` (7): I49 matrix, whois parsing, version pin, `deploy/web/tailscale-serve.ps1` dry run and `-Apply`/`-Remove` against a fake `tailscale.cmd` shim. |
| S31 | DONE | 465a41a | `test/web/auth.test.ts` (10): TOTP RFC vectors, WebAuthn with a software authenticator (every failure mode), claim (loopback only, 10 min, single use, second claim refused, reset), login matrix, lockout + owner told, sessions (idle 8 h, absolute 7 d, hashed ids, rotation), cookie flags over HTTP, CLI. |
| S32 | DONE | 430ca51 | `test/web/users.test.ts` (9): invites single use / expiry / pin / replay / parallel finish, role matrix, disable kills sessions, delete with typed confirmation, 30-day retention, step-up, IDOR. |
| S33 | DONE | a442e01 | `test/web/runtime.test.ts` (9): ceiling, namespacing, registry enumeration (I50), `UserFs` escapes incl. a junction, cross-user isolation, SSRF guard, scheduler fairness (I51). |
| S34 | DONE | 22b7806 | `test/web/chat.test.ts` (10) + `test/web/engine.test.ts` (5): threads, SSE + resume, stop, regenerate, approval tokens bound to the userId, quotas, IDOR, I39 fallback in the engine. |
| S35 | DONE (no real browser) | 3654858 | `test/web/ui.test.ts` (6): static CSP/no-innerHTML/size rules, safe Markdown, a full journey (claim, bot, chat, reload, sign out) in a fake DOM against the real gateway, label/landmark checks. |
| S36 | DONE, with one medium residual (see G5) | see git log | `test/web/redteam.test.ts` (15) for T1 to T14 against a fake tailnet, `test/web/ops.test.ts` (4), `security-review.md`, `deploy/web/README.md`. |
| S37 | NOT DONE: live acceptance is user steps (U60 to U70) | - | - |
| MA1 | NOT DONE: other repo, not touched | - | - |

### Verification (G5)

- Build: `npm run build` finished with 0 errors (`tsc -p .` then the UI copy).
- Full suite `npm test`: 1568 tests, 1558 pass, 9 fail. The 9 failures are exactly the ones that fail on the untouched branch start (baseline 1460 tests, 1450 pass, 9 fail; see deviation 11), so the Milestone 1 count did not drop (+108 tests). The web suite alone (`dist/test/web`) is 94 tests, all passing, including the cross-user isolation tests, the I47 to I57 tests and the red-team suite.
- `npm run check:adapter`: PASS (adapter boundary and ACP boundary).
- Scripts: `deploy/web/tailscale-serve.ps1` dry run prints and changes nothing (also tested with a fake `tailscale.cmd`); `check-acl.ps1` and `grant-folder-acls.ps1` rows are covered by script-text tests only (not run elevated).
- Security review (`security-review.md`): no open HIGH. Four findings fixed (F1 session/identity binding was HIGH, F2 to F4 MEDIUM). Residual MEDIUM risks R1 (hand-written WebAuthn verifier), R2 (same Windows user as the agent) and R8 (owner priority not enforced across processes): **ACCEPTED by the user 2026-11-01**.
- G5 RESULT: every mechanical criterion passes; R1, R2 and R8 were ACCEPTED by the user on 2026-11-01, so "no open high or medium" holds.

### Checker findings fixed (2026-11-01, after G5)

M1 per-turn route/tools re-check against current caps and terms; M2 paid-route caps (S38, I58); L1 `__proto__`-safe admin lookups; L2 lockout notices to the owner through the agent (control folder `owner-notices`); L3 disable, kill switch and lockdown stop running turns; L4 passkey step-up in the UI; L5 short WebAuthn authData is a 401 and a per-key challenge cap; L6 an open invite admits nobody until its code is presented (then pinned to that login); L7 proxy refusal keyed by provider id and a health re-read on 503; L8 the gateway keeps only the model keys (no Telegram token); L9 `.gitattributes` forces LF. Each has a test that fails before the fix. Details: `security-review.md`, section "Checker findings".
- UNTESTED (needs the real thing): a real browser (layout, contrast, passkey prompts), a real Tailscale serve/whois, the real proxy and Claude login, Strata under load, the elevated ACL scripts, the Telegram kill-switch path end to end.

### Deviations from the plan text, and why

1. MA2: preset templates are shown as copyable JSON under the Models form (and in `config.example.json`), not as a button that fills the form; the generic form renderer has no template action and I did not extend it. A new proxy failure kind `refused` ("needs attention") was added so the refusal flows through the existing fallback code.
2. MA3: the owner settings UI "bot editor" is the generic Bots form; the default-brain logic is `src/bots/brain.ts` plus two read-only bot templates in that form. The per-bot Sonnet/Opus choice with badge and egress note is in the web editor (S35).
3. S28: authenticator secrets are encrypted with AES-256-GCM under `web\web.key` (a 32-byte file in the agent data root, ACL row added), not DPAPI (no native module).
4. `check-acl.ps1` has the rows for `web-audit` and the `web\` files; it was not run elevated here (UNTESTED live).
5. S31 (UI-34): passkeys are verified by a small in-repo ES256 verifier (`webauthn.ts`) instead of adding `@simplewebauthn/server`. Reason: I57 (no dependency) and no installs. Recorded as residual R1 in the review.
6. S33: user bots register in `UserBotRegistry` (`registerUserBot`), not in `BotManager`, because BotManager is built around a Telegram token per bot.
7. S34 (UI-35): the gateway is its own process (`npm run web`), and web chat uses an OpenAI-compatible streaming engine against Strata / the proxy instead of the Pi Harness. Consequences: no durable resume of a half-written web answer; owner priority (I51) is enforced inside the web process only (residual R8). The kill switch is coupled through the flag file.
8. S34: only the `write_file` tool asks first. The scheduler's web class (1.5) is real inside the web scheduler; there is no half class in the shared gate.
9. S35: the shared `ui/common/` (tokens.css, dom.js) is used by the web UI; the settings UI was not refactored onto it (it keeps its own copies) to avoid touching a working owner UI. The "Lighthouse-style a11y checklist by hand" was replaced by automated structural checks (labels, landmarks, aria-live, 44 px CSS); a real-browser pass is a user step.
10. Fixes found while testing, beyond the plan text: sessions are bound to the Tailscale identity (F1); `GET /api/me` for CSRF recovery (F2); a body read deadline (F4); kill-switch coupling (F3). See `security-review.md`.
11. Baseline: before this run `npm test` already had 9 failing tests (line endings in two snapshot and script-text tests and the PowerShell installer tests under this checkout); they are unchanged and not caused by this work. `phase2-e2e` and two jobrunner tests are load-sensitive: they failed or hung once on this heavily loaded machine and pass alone.

### Decisions UI-33 to UI-48 (the plan's proposed option unless noted)

UI-33: own tailnet members only; `tag:agent007-host` + `group:agent007-users` (printed by the script, never applied). UI-34: passkeys + password/TOTP fallback; no dependency (deviation 5); on the PC the owner signs in at `http://localhost:47009` (password + TOTP, or a passkey made at that address). UI-35: proposed agent process; DEVIATED to a separate process (deviation 7). UI-36: one Windows user (R2). UI-37: `admin` role exists (invite users, disable, caps not above their own). UI-38: new-user default caps = local presets only, 3 bots, jobs 0; a Claude preset only by explicit owner cap. UI-39: the owner cannot read chats. UI-40: users on Strata, one web turn at a time globally. UI-41: no web tools for user bots (the SSRF guard exists for later). UI-42: preset avatar gallery. UI-43: default `<host>.<tailnet>.ts.net`. UI-44: archive 30 days then delete. UI-45: Sonnet default, Opus per bot. UI-46: MA1 not done here (other repo); agent-007 handles both an updated and an older proxy. UI-47: shell only on a separate local-only bot; a Claude-primary bot gets no shell/dispatch_job unless relaxed. UI-48: Codex stays an allowed non-default preset (no change).

### Extra ideas, not built

Independent review of `webauthn.ts`; a global SSE cap; a gate lease over IPC so owner priority holds across processes; a separate Windows user for the gateway; a per-user usage graph; a QR code for the authenticator key (needs a generator); group chats and bot sharing (out of scope per section 1).
