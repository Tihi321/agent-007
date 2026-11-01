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

## Scripts (`yarn <name>`)

| Script | What it does |
|---|---|
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
