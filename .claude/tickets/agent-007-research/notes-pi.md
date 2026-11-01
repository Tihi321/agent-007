# Pi / Pi Durable research notes (agent-007)

Research only; nothing installed or run. Date of research: 2026-10-26. Everything below is from WebFetch/WebSearch summaries (fetched through a small summarising model), so details such as exact flags should be re-checked against the primary docs before building.

## Verdict (short)

- Pi (the coding agent / harness) is a credible BASE for this goal: MIT, TypeScript, embeddable via SDK and RPC, speaks OpenAI-compatible endpoints (LM Studio) via models.json, works on native Windows (needs a bash; Git for Windows suffices), has file/shell tools, persistent tree sessions, skills, context files, extensions.
- Pi Durable (the post the user linked) is NOT the right base today: it is explicitly experimental ("API changes without notice"), has no chat/gateway integration, no documented local-model setup, and is about crash-resume for multi-client agent apps, which this user does not need at first. Start on Pi (SDK); treat Durable as a later option.
- Telegram front ends already exist in several community forms (pi-telebridge, TelePi, pi-telegram-plus, pi-telegram-manager, pi-gateway). None is verified on Windows. A thin own bridge on the SDK is small (a few hundred lines, estimate) and probably the safer choice.
- Biggest risks: shell access from chat with no permission system (YOLO by default), and local-model tool-calling quality. Both need explicit mitigation (allowlist + approval gate + sandbox; test models first).
- Alternative to compare (other researcher's scope): OpenClaw, an MIT gateway with Telegram and Windows support, built on Pi per Ronacher.

## 1. The post: "Pi Durable"

Source: https://earendil.com/posts/pi-durable/ (fetched; published Thu 1 Oct 2026 by Earendil Engineering, the same day as Pi 1.0).

- What: an experimental TypeScript framework for building long-running, durable agentic applications, including coding agents. Separate package from the Pi coding agent; shares code (e.g. pi-ai) and principles (minimalism, malleability). Lessons are expected to flow back into Pi.
- Architecture: Harness = storage + machinery to run many conversations in parallel. Conversations are recorded transcripts with their own settings (model, thinking level, extensions, tools, cwd). Everything (model call, tool call, compaction) is a "task". Storage backends: memory, SQLite, JSONL (plus a conformance suite); can run on Node, Bun or Cloudflare Durable Objects. Execution environments abstract files/shell (local Node env, or remote). Extensions = named bundles of prompt sections, tools, hooks, tasks. Ownership tree of tasks/conversations (aborting a parent cleans children). Typed JSON "documents" (e.g. todos) committed atomically with the transcript.
- Durability meaning: each step is checkpointed before proceeding; transcript and app state commit atomically; after a crash a new process opens the same storage and `harness.resume()` continues unfinished tasks. Cut-off model requests are resent (partial answer kept, marked aborted). Tool calls rerun only if marked `replay: "safe"`, otherwise the model is told the call was interrupted. `requestId` gives idempotent submissions. Background compaction; timers survive restarts; tasks can wait on tasks. Multiplayer: many clients can attach, watch, steer, queue follow-ups.
- Run: `npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord`; open a harness over a storage backend, register tools/extensions, create or resume a root conversation. Demos (coding agent, vacation planner) run from a Pi checkout at v1.0.0. About 15,000 lines of source excluding tests.
- License: the post does not state one; the Pi 1.0 post says Pi and Pi Durable are both MIT (https://earendil.com/posts/pi-1-0/).
- Maturity: experimental ("the API might still change"). Package README (https://github.com/earendil-works/pi/blob/main/packages/durable/README.md): "Experimental. The API changes without notice between releases"; one process must own a storage (no cross-process locking); SQLite WAL synchronous=NORMAL (newest commit may be lost on power failure); JSONL keeps history in memory; a storage error ends the Harness; no messaging connector; local-model setup not documented (model access goes through pi-ai providers).

Relationship check (verified from the post, not assumed): the post says Earendil is the company behind Pi. The Pi repo is https://github.com/earendil-works/pi (old home badlogic/pi-mono; mirrors show the npm scope moving from @mariozechner to @earendil-works). One secondary report says Earendil acquired Pi from Mario Zechner on April 8 2026 and Zechner leads Pi's technical direction there (https://finder.techleap.nl/news/note/pi-the-austrian-built-agent-powering-openclaw-s-viral-rise, search snippet; secondary). That Armin Ronacher co-founded Earendil comes only from a secondary profile (https://notes.dsebastien.net/30+Areas/36+People/Mario+Zechner, search snippet; unverified from a primary source).

## 2. Pi itself

Repo: https://github.com/earendil-works/pi (MIT, ~118k stars, ~7.1k commits, Node >= 22.19; new contributors' issues/PRs are auto-closed). Packages: pi-coding-agent, pi-ai (multi-provider LLM API), pi-agent-core (agent loop/tools/state), pi-tui, chord, pi-durable, pi-telemetry. Pi 1.0 released 1 Oct 2026 (https://earendil.com/posts/pi-1-0/): "hardened, minimal, extensible"; adds Codemode native MCP, virtual models, deferred tool loading. (In Jan 2026 Pi had no MCP by design: https://lucumr.pocoo.org/2026/1/31/pi/.)

- Design: four default tools (read, write, edit, bash) and a very short system prompt (Ronacher post).
- Providers: 15+ providers incl. Anthropic, OpenAI, Google, OpenRouter, Ollama (https://pi.dev). Custom providers via `~/.pi/agent/models.json` with `api` types `openai-completions`, `openai-responses`, `azure-openai-responses`; docs name Ollama, LM Studio, vLLM, SGLang as examples; `/model` reloads the file (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md). llama.cpp has a dedicated integration (`/llama`) in the same doc.
- LM Studio: a how-to shows provider `lmstudio`, baseUrl `http://localhost:1234/v1`, api `openai-completions`, any apiKey string, model id must exactly match LM Studio's id (https://discuss.pytorch.kr/t/gemma-4-pi-coding-agent-feat-lm-studio/10009). Community extensions pi-lmstudio (https://cdn.jsdelivr.net/npm/pi-lmstudio@1.3.0/README.md) and pi-lm-providers (hides models without tool support; https://pi.dev/packages/pi-lm-providers?page=28) exist (search snippets).
- Small local models: no benchmark found. The Gemma 4 guide reports no measured tool-call reliability and says frontier models still lead on consistency. pi-telegram-manager says it was tested with Qwen3.6-35B-A3B at 131k context and is designed for small local models (https://pi.dev/packages/pi-telegram-manager). Pi's very short system prompt is a plus for small context windows. UNVERIFIED: real tool-call failure rate on the user's hardware/model; must be tested.
- Extension/tool model: TypeScript extensions add tools, slash commands, events, TUI; packaged as Pi packages via npm/git; skills and prompt templates; hot reload (https://pi.dev, https://lucumr.pocoo.org/2026/1/31/pi/). Third-party Pi packages execute arbitrary code (warning on pi.dev package listings).
- SDK: `createAgentSession()` in `@earendil-works/pi-coding-agent` (Node/Bun, in-process); `prompt()`, `abort()`, events, `agent_settled`; tool control (`tools`, `noTools`, `excludeTools`, `customTools`); custom cwd; MCP/Codemode not loaded by default in SDK sessions (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md).
- RPC: `pi --mode rpc` JSONL over stdin/stdout; commands prompt/steer/follow_up/abort/new_session/get_state/bash etc.; `RpcClient` helper for TypeScript (https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md). The doc says nothing about Windows beyond LF/CRLF framing.
- Sessions/memory: sessions are trees in single JSONL files, persisted by default, fork/clone/resume/compact (SDK doc, https://pi.dev). No built-in long-term memory of who the user is beyond context files/skills/extensions; you would add a memory extension or notes file (pi-telegram-manager ships its own memory DB as one example). UNVERIFIED whether AGENTS.md-style context files and skills load in SDK mode with a custom cwd (SDK doc says default resource discovery is used).
- Windows: native Windows supported with a PowerShell installer; needs a bash (Git for Windows suffices; `shellPath` setting); optional PowerShell tool enabled via `defaultTools` (https://pi.dev/docs/latest/windows). Repo has .bat/.ps1 test scripts (https://github.com/earendil-works/pi).
- Security: no permission system, runs with launching user's rights; README recommends containers/sandboxes (https://github.com/earendil-works/pi). The Gemma 4 guide mentions permission-gate and sandbox extensions and cco container isolation, noting permission-gate is not a full sandbox.

## 3. Telegram front ends

All community, none official, none verified on Windows (READMEs silent on Windows).
- pi-telebridge (MIT): extension relaying a LIVE pi session to a bot; single allowed chat_id; needs a session running with `/telegram` on, so not a headless daemon (https://cdn.jsdelivr.net/npm/pi-telebridge@1.4.0/README.md).
- TelePi (https://github.com/jellydn/TelePi, a fork of benedict2310/TelePi): standalone grammY bot wrapping the Pi SDK AgentSession/SessionManager; user-ID allowlist (TELEGRAM_ALLOWED_USER_IDS); per-chat sessions; voice/image; handoff/handback; launchd/systemd/Docker only, Windows not mentioned; license not stated on page. Best reference for the SDK approach.
- pi-telegram-plus (kdejaeger fork): extension inside a pi session mirroring the TUI with inline keyboards; first Telegram user to message is auto-authorised (weak); license not stated (https://cdn.jsdelivr.net/gh/kdejaeger/pi-telegram-plus@master/README.md).
- pi-telegram-manager (MIT, v0.8.1, 15 Aug 2026, experimental): built for local models; personal plus "secretary" modes; memory DB; restricts the model to messaging tools in manager mode but is not a sandbox (https://pi.dev/packages/pi-telegram-manager).
- @gamalan/pi-gateway: Telegram/Slack/Discord bridge with UID allowlist (search snippet: https://pi.dev/packages/@gamalan/pi-gateway?page=3).
- OpenClaw (https://github.com/openclaw/openclaw): MIT, Telegram plus 20+ channels, Windows PowerShell installer, ~393k stars, local models as plugins; built on Pi per Ronacher (https://lucumr.pocoo.org/2026/1/31/pi/), although its README only thanks Mario for pi. Runs tools on the host unless sandboxed. The "full product" alternative; heavier (Node 24+).

Glue estimate for an own bridge (estimate, not sourced): grammY long-polling bot, user-ID allowlist, map chat id to a SessionManager file, call `session.prompt()` and send `message_end` text back (split at 4096 chars), `/new` and `/abort`, plus an approval flow (inline keyboard) wrapping bash/write tools. A few hundred lines of TypeScript; TelePi's `src/pi-session.ts` is the template. Run via Task Scheduler or a Windows service. RPC mode is the fallback if a separate process is preferred (use LF-only JSONL framing, not Node readline).

## 4. Fit verdict

Strengths: MIT; minimal and hackable; first-class OpenAI-compatible/LM Studio config; SDK and RPC; native Windows; tree sessions with compaction; skills and extensions let the agent know your system; active ownership (Earendil, 1.0 on 1 Oct 2026); large community.
Gaps: no built-in Telegram; no built-in persistent user memory; no scheduler/proactive triggers unless added (TelePi has a prompt inbox for cron-style input); Windows needs Git Bash and the shell tool is bash-flavoured (PowerShell tool optional); Pi Durable not ready and not needed yet; sparse docs on small-model behaviour.
Risks:
1. Shell via chat: no permission system, runs as your user. Mitigate with a strict Telegram user-ID allowlist (not "first user wins"), approval gate for bash and writes outside a workspace, a low-privilege Windows user or WSL/container/VM, bot token kept out of agent-readable files, and treating inbound files/forwarded messages as prompt-injection vectors. OpenClaw's README gives the same warning.
2. Local tool calling: LM Studio parses model text into tool_calls (from search snippet of LM Studio docs); quality varies by model and template. Plan an eval of 3-4 candidate models (e.g. Qwen3.x MoE, Gemma 4) on the user's GPU; 64k-128k context desirable (Gemma 4 guide: 128k context costs about 8 GB extra VRAM).
3. Supply chain: Pi packages/extensions run arbitrary code; README suggests `npm install -g --ignore-scripts` and notes transitive deps are not pinned. Pin versions.
4. Churn: Pi changed org/scope (@mariozechner to @earendil-works); community Telegram extensions pin Pi version ranges (pi-telegram-plus: >=0.76 <0.82). An own thin bridge on the SDK reduces breakage.

## Unverified / not found

- Primary-source statement on SDK/RPC stability in Pi 1.0 (1.0 post does not mention SDK/RPC).
- Any Windows testing of the Telegram extensions.
- Licenses of TelePi and pi-telegram-plus (not shown on fetched pages).
- Benchmarks of small local models on Pi.
- Whether the SDK auto-loads context files/skills with a cwd override.
- Exact date and terms of the Earendil acquisition and Ronacher's co-founder role (secondary sources only).
- https://rfc.earendil.com/posts/pi-1-0/ returned an unrelated shell page; https://earendil.com/posts/pi-1-0/ worked.
- WebFetch output is model-summarised; quotes and flags not re-read in raw form.
