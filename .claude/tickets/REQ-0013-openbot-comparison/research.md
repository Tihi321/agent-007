# REQ-0013: Is CopilotKit/OpenBot better than agent-007?

Question: is https://github.com/CopilotKit/OpenBot "something better than what we have, similar and more expanded"?

Method: GitHub API (`gh api`) for metadata, plus a shallow `git clone --depth 1` into `.claude/temp/openbot/` (read only, nothing run or installed). WebFetch was not available in this session. The clone has one commit, so history figures come from the API. Labels: **[V]** verified from the repo or API, **[I]** inferred. agent-007 claims come from its README, package.json and `src/` layout.

## Answer

OpenBot is not a better version of agent-007. It is a different product: a team and enterprise "AI coworkers" workspace with browser-using agents in containers, built around CopilotKit's own service. It overlaps with agent-007 only on "agent with human approvals". Do not replace agent-007. Borrow a few ideas.

## 1. What OpenBot is

- A modular, self-hostable workspace where "AI coworkers" each get their own computer (a container with its own Chromium, files and tools). Every action is decided by policy before it runs and recorded after. [V] (GitHub description; README; docs/architecture.md)
- Stack: TypeScript, Bun workspaces, a React app, a Hono API server, PostgreSQL, a Tauri desktop app, an Expo mobile app, a Chrome extension (the Recorder), Helm/Kubernetes. [V] (package.json; directory listing; docs/architecture.md:3)
- Bots are built in, or any agent that speaks AG-UI (CopilotKit's protocol) connects: LangGraph, Claude SDK, ADK, Mastra, CrewAI and others. Directories `agent-*` hold adapters. [V] (README; repo tree)
- Models: OpenAI, Claude, Gemini, or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`. [V] (docs/configuration.md:73,267)
- Front ends: Mac/Windows desktop and the web are shipped. iOS, Android, Slack and Teams are "early access" sign-ups in the README. I found no Telegram in README or docs. [V]
- Tools: MCP, plus plugins (Composio, Arcade, Notion, Google Drive). Routines (scheduled instructions) and goals are built in. [V] (docs/routines.md; docs/plugins/)
- Approvals: a policy order in `server/src/approvals/policy.ts` (kinds of action, rules, auto-review, "extra vigilant"). Cards offer Allow once, Allow for this conversation, Always allow, and Deny. Everything lands in an audit trail. [V] (docs/approvals.md)
- Maturity: MIT license, created 2026-08-17, 10,885 stars, 1,348 forks, v1.0.2 released 2026-11-11, pushed the same day, about 1,074 commits, 73 open issues, not archived. [V] (GitHub API)
- Important catch: durable threads, memory and "Learning" live in **CopilotKit Intelligence**, which is separately licensed and not MIT. A free local license exists for personal use, with a trial for Kubernetes and a paid production license. [V] (README lines 97-115; docs/architecture.md:24)

## 2. Side by side

| Dimension | OpenBot | agent-007 |
|---|---|---|
| Purpose | Team/enterprise workspace of AI coworkers that operate a browser and tools [V] | One person's 24/7 agent on one Windows 11 PC [V README] |
| Architecture | App + Hono server + Postgres + worker + supervisor + per-bot computer containers; Intelligence service [V] | Pi Durable 1.4.0 agent, Telegram bridge, separate job runner, web gateway, Electron tray app [V README/package.json] |
| Stack | TypeScript on Bun; Rust/Tauri desktop; Docker/Podman/k3d; Postgres [V] | TypeScript on Node 24, Yarn 4, SQLite via Pi Durable, Electron [V package.json] |
| Model providers | OpenAI, Anthropic, Google, OpenAI-compatible endpoint (a local server is possible) [V]. Provider-specific code paths (Responses vs Chat) [V] | Local only on loopback (LM Studio, Strata) for Telegram bots; ACP proxy (Codex, Antigravity, Claude); web Models page with custom providers, SSRF guard, paid-route grants [V README] |
| Front ends | Desktop, web; mobile/Slack/Teams in early access [V] | Telegram (primary), web UI, Tailscale web UI, tray exe, settings UI [V README] |
| Tools / MCP | MCP, plugins, browser computer, routines, goals [V] | Shell tool, job runner for Claude Code / DeepSeek / creative-hub MCP [V README] |
| Memory | Via Intelligence service. The personal edition has no memory at all (`editionHasMemory`) [V docs/architecture.md:370-376] | Not read in depth. Persona and session handling exist in `src/personas`, `src/runtime` [I: from the src layout] |
| Scheduling / durability | Routines on a schedule; durable threads delegated to Intelligence [V] | Pi Durable: crash-resume, durable timers; smoke tests s4/s5 for crash-resume and long hooks [V package.json scripts] |
| Security / approval | Policy engine, granular approval cards, audit trail, org sign-in, roles in team edition [V] | Every shell command and job needs a Telegram approval; low-privilege `agent007` user, ACL checks, owner claim, settings audit chain, kill switches [V README] |
| Deployment target | Mac/Windows desktop (needs Podman/Docker, a dedicated Podman machine on Windows), Kubernetes via Helm [V CHANGELOG; docs/desktop-install.md] | Windows 11 only; scheduled tasks, or a per-user exe without admin or Docker [V README] |
| License | MIT for the template; Intelligence separately licensed [V] | Private repo [V package.json `private: true`] |
| Maturity | Public 1.0.x, a funded company behind it, daily releases, large user base [V] | Built and tested offline; no live run yet [V README] |

## 3. Who is ahead where

OpenBot is ahead:
- Browser-operating agents with a live view, handover when the agent is stuck, and a "teach a bot" recorder. [V]
- Granular approval UX (once / conversation / always) and a broader audit story. [V]
- Multiple front ends, polished signed installers, release engineering, docs, community, and real-world use. [V]
- Bring-your-own-agent through AG-UI. [V]

agent-007 is ahead (for this user's problem):
- Telegram as the front end, which OpenBot does not ship. [V absence in docs]
- Local-model-first, loopback-only design and a model-source model (privacy badges, SSRF guard, paid-route grants) built for it. [V README]
- No Docker, Podman, Postgres or external licensed service. A single Windows PC with a hardened low-privilege-user install option. [V]
- Crash-resume on a durable runtime, and approval-gated job runner for Claude Code, DeepSeek and creative-hub MCP. [V README]
- OpenBot's personal edition has no memory, and its stack depends on Intelligence. [V]

No overlap:
- OpenBot's enterprise features: company sign-in, roles, Kubernetes, Slack/Teams, mobile.
- agent-007's Claude Code job runner and creative-hub MCP integration; Tailscale tailnet mode.

## 4. Verdict: borrow ideas; do not replace; do not simply ignore

Reason: replacing would cost the local-only, Telegram, no-Docker, Windows-native design that is the point of agent-007, and would add a dependency on a separately licensed service. But a mature project has solved a few problems we have not. [I for the touch points below; I did not read agent-007's code in depth, only the layout and README.]

Ideas to borrow:
1. Approval scopes: "allow once / allow for this conversation / always allow, saved as a revocable rule", with the grant visible next to the chat. Touches `src/approval/` and the Telegram bridge in `src/telegram/` (inline buttons), and the settings UI rules. Reference: docs/approvals.md, `server/src/approvals/policy.ts`.
2. Action classes that always ask regardless of rules (delete, send to others, pay, change credentials). Touches `src/approval/` policy and `src/tools/`/`src/shell/`.
3. An auditable per-action decision record shown in the UI (we already have a settings audit chain; extend it to approvals/tool calls). Touches `src/settings/` audit and the web UI.
4. Routines/goals as agent-creatable, user-visible standing instructions with a list/edit UI. Touches `src/runtime` (Pi Durable timers) and `src/web`. Reference: docs/routines.md.
5. Optional later: browser-operating agent with handover, as a job-runner tool. Touches `src/jobrunner/` and `src/mcp/`. Large effort; only if wanted.
6. Desktop install hygiene (the Windows "start fresh" and uninstall-with-data cases in OpenBot's CHANGELOG) as a checklist for the exe. Touches `src/desktop/`. Reference: CHANGELOG.md Unreleased.

Ignore: Kubernetes/Helm, Intelligence, AG-UI adapters, Slack/Teams, mobile.

## 5. Unknowns

- I did not run OpenBot. Whether it works with a purely local model on Windows with tool calling is unknown. The docs say OpenAI-compatible endpoints work. [I]
- I did not confirm the exact "free local Intelligence license" terms, or how renewal works offline (README says renewal needs internet). [V partial]
- Star count may be inflated by trending/marketing; I have not checked contributor count or issue quality.
- No Telegram support found by grep of README/docs; the code (`server/src`) was not searched exhaustively.
- Commit count (about 1,074) is from the API pagination link; clone is shallow.
- agent-007 memory and scheduling details were taken from the layout and README, not from reading `src/`.
- Ticket folders in `.claude/tickets/` were listed, but I read only `agent-007-research/research.md` (head); the other plans and acceptance docs were not read.
