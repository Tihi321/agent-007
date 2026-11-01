# agent-007

A personal 24/7 AI agent for a Windows 11 PC. It is built on Pi Durable 1.4.0, talks to you through Telegram, and uses a
local model (LM Studio or Strata, loopback only). Long jobs (Claude Code, DeepSeek, creative-hub MCP tools) run in a
separate job runner that you approve from Telegram.

Status: everything has been built and tested offline. No live run (real model, Telegram, job runner) has been done yet,
so expect first-install rough edges and work through the acceptance checklists in `.claude/tickets/` as you go.

## Requirements

- Windows 11, Node.js `>=24.14.0 <25` (the repo is developed with fnm) and Yarn 4 (`corepack enable`, the version is pinned in `packageManager`), PowerShell 7 for the deploy scripts.
- A Telegram bot token from @BotFather and your numeric Telegram user id.
- A local model runner on loopback: LM Studio (127.0.0.1:1234) or Strata (127.0.0.1:8080).
- Optional: the `claude` CLI for Claude jobs, a DeepSeek key for DeepSeek jobs, the creative-hub MCP servers.

## Build and test (no services needed)

```powershell
yarn install --immutable
yarn build           # tsc, then copies the settings UI assets
yarn test               # node --test over dist/test (one test is skipped without Windows developer mode)
yarn check:adapter   # only src/pi/adapter.ts may import the Pi packages
```

## Run locally without deploying

```powershell
yarn build
yarn setup:local    # creates .local/ (git-ignored): config, settings/security.json, secrets skeleton; never overwrites
yarn web:local      # web gateway on http://localhost:47009 against .local/ (ACL checks off)
yarn web-owner-code --data-dir .local\data    # one-time owner claim code, then open /claim
```

Fill the `CHANGE-ME` values in `.local/secrets/secrets.json` (the ACP proxy key for the Claude presets; the Strata key if it
asks for one). The Claude presets stay refused until you set `termsAccepted.claude` to `true` in `.local/settings/security.json`.
`yarn start:local` runs the Telegram agent the same way (needs a real bot token and your Telegram id).

## Install

The install is a set of elevated PowerShell scripts that create a low-privilege `agent007` user, lock down folders and
register scheduled tasks. Every script supports `-WhatIf`. Follow `deploy/README-ops.md` in order; the short version:

1. Copy `config/config.example.json` to `C:\ProgramData\agent-007\config\config.json` and replace every `CHANGE-ME`.
2. Find your Telegram id with `node dist/scripts/whoami-telegram.js` (it only prints ids and never replies), then put it
   in `telegram.allowedUserIds`.
3. Run `deploy\setup-agent-user.ps1`, `grant-folder-acls.ps1`, `new-secrets.ps1`, `deploy-app.ps1`, `register-task.ps1`.
4. For jobs, run `deploy\jobrunner\install-jobrunner.ps1` as the main user, then edit `jobrunner.json` (copied from
   `config/jobrunner.example.json`).
5. Run `deploy\check-acl.ps1` (read-only) and fix anything it reports.

Kill switches, uninstall and the optional extra bots are in `deploy/README-ops.md`.

## Use

Send your bot a message. Commands: `/new`, `/stop`, `/status`, `/model`, `/persona`, `/settings`, `/proposals`,
`/applysettings`, `/killshell`; `/help` lists them. Every shell command and every job needs your approval in Telegram.
The settings web UI is served by the job runner on loopback port 47008 (the job runner's IPC port is 47007).

## Web gateway: the Models page

Owner only: Admin -> Models (`#/admin/models`). Every change needs a fresh step-up. It manages the models of the **web**
gateway; nothing here restarts anything.

- **Sources:** ACP proxy (Codex, Antigravity, Claude), LM Studio, Strata, and **Add provider** for any OpenAI-compatible
  base URL. Press **Fetch models** (only on press), tick the ones you want and **Add selected**, or **Add a model by its id**.
  Fetched ids and labels are untrusted text; kind, privacy, provider and key come from the source, never from the fetched list.
- **Where it is stored:** `<dataDir>\web\models.json` (presets and custom providers) and `<dataDir>\web\model-keys.json`
  (provider API keys, sealed with the web key, never shown back or logged). Only the Models page writes them; if
  `models.json` is changed by hand, all web presets are switched off with a banner until you save from the page again.
- **Local or cloud:** only the literal hosts `127.0.0.1`, `[::1]` and `localhost` are local. Any other host is cloud (cloud
  badge, your bots' messages go to that host). A loopback provider can be marked **Treat as cloud**; privacy only goes up.
- **Billing:** proxy, LM Studio, Strata and loopback presets are "subscription". A cloud custom provider must declare
  "Free or subscription" or "Paid per use" when added. A paid preset runs only after an owner grant in Admin -> Paid routes.
- **Cloud custom URLs** must be `https` and pass the SSRF guard (no private, LAN, tailnet, loopback or link-local address),
  at save, at fetch and before every chat request. A LAN LM Studio is not supported. The base URL cannot be edited: remove
  the provider and add it again.
- **Effect:** Models writes apply at once; `security.json` presets and `termsAccepted` are re-read within 10 s. An invalid
  `security.json` keeps the last good view and shows a banner. The owner sees every preset; other users need the preset
  in their caps (Admin -> user -> Models...). Removing a preset a bot uses answers with the list of bots; repeat with
  confirmation to force it (the bots then fall back, and paid grants for it are deleted).
- **Telegram:** bots there use only `security.json` presets. For a proxy, LM Studio or Strata preset click **Copy for
  settings UI**, paste it into the settings UI Models form (port 47008), save and run `/applysettings`. Custom-provider
  presets cannot go to Telegram.
- **Claude and Antigravity** presets need `termsAccepted.<provider>` in the settings UI, else they are refused.
- **LM Studio:** every downloaded chat model is listed (embeddings hidden), loaded ones are marked, and LM Studio loads
  others on first use (turn on Just-in-Time loading; the first reply is slow). On a 401 add `lmStudioApiToken` to
  `secrets.json`. The context shown is the loaded one, else 8192: set it to the context LM Studio loads the model with.

Live check (not yet done; run in order, `yarn web:local`, proxy and LM Studio running):

- [ ] UM1 sign in as owner at `http://127.0.0.1:47009`, open Admin -> Models.
- [ ] UM2 ACP proxy -> Fetch: 3 Codex, 2 Antigravity, 13 Claude rows; `claude-sonnet`, `claude-opus` shown as existing.
- [ ] UM3 LM Studio -> Fetch: all chat models, loaded one marked, no embeddings.
- [ ] UM4 Tick one Codex, one Antigravity, one new Claude and one not-loaded LM Studio model; Add selected; check ids and context.
- [ ] UM5 Without a restart, make a bot per new preset and send "Say hi in five words."; each answers.
- [ ] UM6 Add provider: a loopback one (local badge) and, if you have a key, a cloud one with "Paid per use"; the key is never shown again and the paid bot is refused until Paid routes allows it.
- [ ] UM7 Remove a preset a bot uses: the bot list appears; cancel.
- [ ] UM8 Untick `termsAccepted.antigravity` in the settings UI; within 10 s the Models page shows "needs terms". Re-tick it.

## Scripts (`yarn <name>`)

| Script | What it does |
|---|---|
| `setup:local`, `web:local`, `start:local` | dev setup in `.local/`, and the web gateway / agent against it |
| `start` | the agent (`dist/src/main.js`); normally started by the scheduled task |
| `jobrunner` | the job runner (`dist/src/jobrunner/main.js`) |
| `smoke:*`, `smoke:all` | Pi Durable smoke checks (they use a local model or stubs; read the script first) |
| `routing-eval`, `multibot-eval`, `settings-eval` | model evals; they call the configured local model, so run them on purpose |
| `bakeoff`, `e2e:runner` | model bake-off and runner end-to-end checks |
| `migrate-settings`, `migrate-bots` | one-time migrations (dry run by default, `--apply` to write) |
| `dsh:probe` | live probe that decides whether DeepSeek jobs may be enabled |
| `proxy:check` | setup check for the ACP proxy brain |
| `verify-audit` | verifies the settings audit chain |

## Layout

- `src/` agent, Telegram bridge, job runner, settings UI backend, bots, bot bus, models, proxy, GPU gate.
- `ui/settings/` the settings web UI (plain HTML, CSS and JS).
- `config/` example configs, persona examples and job templates. `prompts/` system prompt parts.
- `deploy/`, `scripts/` install scripts and developer tools. `test/` the test suite.
