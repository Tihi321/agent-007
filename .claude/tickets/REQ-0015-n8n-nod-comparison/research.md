# REQ-0015: What is nod.n8n.io, and do we have it?

Question: "what about this https://nod.n8n.io, is this something that we have" (agent-007).
Date of research: 2026-11-11. Labels: [V] read directly, [I] inferred.

## Answer
Nod is n8n labs' free, open-source (Apache 2.0) personal agent that runs on your own Mac/Windows PC or server, does errands on real websites with its own browser, connects to Gmail/Slack/Notion/Drive/Calendar, and asks before acting. It is the same product category as agent-007 (personal, self-hosted, approval-gated, Telegram, local models allowed) but aimed at business errands and app integrations. agent-007 has the safety and runtime pieces and a browser (REQ-0014); it lacks scheduling, app connectors, a structured memory UI and a polished onboarding. Verdict: same category, not a replacement; borrow ideas.

## 1. What Nod is (all [V] from https://nod.n8n.io fetched 2026-11-11, raw HTML checked with curl, unless noted)
- Tagline: "Open source personal agent with its own computer"; "chases invoices, preps your calls and cancels trials, on real websites. On your machine, and it asks before it acts for you."
- Status: "Research preview"; GitHub star count shown 406 on page. Page's "Next on the list" (not yet built): managed hosting, phone calls, team sharing ("Today one owner per Nod"). No waitlist mentioned.
- Repo: https://github.com/n8n-io/nod, license Apache-2.0, 425 stars, last push 2026-11-11 (GitHub API, org n8n-io). [V]
- Platforms: macOS 14+, Windows 11 "preview", or your own server (one person).
- Price: free to download; you pay your model provider; a Usage view shows estimated model cost.
- Models: 30+ providers (OpenAI, Anthropic, Google, OpenRouter), ChatGPT Plus/Pro plan, or local via Ollama, LM Studio, vLLM, llama.cpp. Local needs tool calling and 64k context; "small models are less reliable at the safety check".
- Channels: the desktop app and Telegram. No voice yet (phone calls are "next"). Slack/Gmail are tools it uses, not chat channels.
- Integrations: Gmail, Slack, Notion, Drive, Calendar "with one sign-in" (page says app connections default to n8n and Composio); saved website logins.
- Features: scheduled/recurring checks (example: every 6 hours price-page watcher, "Edit schedule"); daily call briefs as PDF; drafts replies from your own sheets; every action checked against request and rules, asks when not covered.
- Memory: every note visible, editable, deletable with the source message; learns writing style from sent emails; "learns how to do a task" and repairs steps when a site changes. Data (DB, files, memory, logins) stored on the machine running it.
- Relation to n8n: "its own app, made by the team behind n8n"; you do not need n8n; "not the n8n AI Assistant". No workflow-builder link found. [V]
- Vendor benchmarks (self-reported, Oct 2026): 98% of 226 errands completed, 93.2% LongMemEval-S, 0 of 216 attack emails planted a false memory (WhisperBench). Not independently checked.

## 2. agent-007 (checked in src/, [V] unless marked)
- Telegram bot, local models on loopback, ACP proxy, web UI, Electron tray exe (README.md; src/telegram, src/web, src/desktop).
- Approvals: src/approval/gate.ts, tokens.ts, killSwitch.ts; Telegram approval UI src/telegram/approvalUi.ts; job approval src/jobs/approval.ts.
- Browser: nine deferred `browser_*` tools for the main agent, driving a browser job in the job runner, page text wrapped as untrusted, risky steps need a permission card (src/browser/tools.ts:1-9).
- Memory: `remember` appends dated notes to a MEMORY.md capped at 16 KB, refuses secret-looking notes, USER.md read-only (src/tools/memory.ts:1-6). Personas with scoped memory (src/personas/memory.ts). No per-note edit UI found. [I from file list]
- Scheduling: none for the agent. Timer tool names `set_timer, schedule_task, remind_me, cron` are reserved and "No such tool exists yet" (src/botbus/capabilities.ts:25-26). Windows Task Scheduler is only used to restart processes. grep for cron/remind/routine found no user-facing scheduler. [V]
- App connectors: no Gmail/Calendar/Slack/Composio/OAuth code in src/ (grep returned nothing relevant). Only generic MCP (src/mcp/client.ts, registry.ts). [V by grep]
- Extras: multi-bot bus (src/botbus), job runner for Claude Code / DeepSeek (src/jobrunner, src/jobs), web auth with TOTP/WebAuthn, Tailscale (src/web).

## 3. Feature table
| Feature | Nod | agent-007 |
|---|---|---|
| Personal, self-hosted, one owner | have | have |
| Telegram | have | have (primary) |
| Local models | have (64k ctx needed) | have (local-first, loopback guard) |
| Many cloud providers | have (30+) | partial (ACP proxy, custom providers, paid-route grants) |
| Browser on real sites | have (core) | have (REQ-0014, new, not live-tested) |
| Asks before acting | have | have (shell, jobs, browser steps) |
| Scheduled/recurring tasks | have | missing |
| Gmail/Slack/Notion/Calendar connectors | have | missing (MCP only) |
| Visible/editable memory | have | partial (flat file, 16 KB cap) |
| Learns tasks / writing style | have | missing |
| Cost/usage view | have | partial (job credit ledger, src/jobs/ledger.ts) |
| Injection/memory-poisoning eval | have (claimed) | partial (untrusted wrappers, provenance) |
| Mac support, polished installer | have | missing (Windows only, unsigned) |
| Code job runner (Claude Code/DeepSeek) | missing | have |
| Hardened low-privilege install, kill switches, audit chain | not stated | have |
| Multi-bot bus / personas | missing | have |
| Crash-resume durable runtime | not stated | have (Pi Durable) |
| Open source | Apache 2.0 | private |

## 4. Verdict
Not the same thing, but the closest public analogue found so far (closer than OpenBot, REQ-0013). Nod is a business-errand assistant with connectors and schedules; agent-007 is a hardened local runtime with a job runner. Nod is ahead on product breadth; agent-007 is ahead on security hardening, durability and developer-job tooling. Do not replace; borrow ideas. Nod is Apache 2.0, so reading its code is licence-safe [I: check terms before copying].

## 5. Ideas worth borrowing (ideas only)
1. Agent-creatable recurring tasks with a list/edit UI ("every 6h check X, tell me on change"), on Pi Durable timers. Touches src/botbus/capabilities.ts (reserved timer tools), src/agent/extension.ts, src/web/routes, src/telegram/commands.ts.
2. Visible per-note memory with source message, edit/forget. Touches src/tools/memory.ts, src/personas/memory.ts, src/web/routes.
3. One connector layer for Gmail/Calendar/Drive via MCP, each action approval-gated. Touches src/mcp/registry.ts, src/mcp/services.ts, src/approval/gate.ts.
4. Rule-based action check ("does this action match the request and rules; ask if not"), with a warning about small local models. Touches src/approval/gate.ts, src/gate/.
5. Replayable site recipes plus a memory-poisoning test set (their WhisperBench idea). Touches src/browser/tools.ts, src/jobs/browserContracts.ts, src/mcp/untrusted.ts.

## 6. Not verified / open
- Read only the landing page and GitHub API metadata; did not clone or read Nod's code, docs or license file. Benchmarks are vendor claims.
- Whether Nod's Windows build handles Telegram and local models well, and whether schedules survive restarts: untested.
- Whether the "n8n and Composio" connection layer needs an n8n/Composio account or cloud: page says only "default".
- Web search found no independent coverage of Nod.
- agent-007 memory and scheduler conclusions come from grep and file reads of a few files, not a full read of src/agent.
