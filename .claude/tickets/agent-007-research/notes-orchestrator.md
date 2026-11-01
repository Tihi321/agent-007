# Local model as 24/7 orchestrator (agent-007)

Research only, 2026-10-27. Nothing was installed or run. Local files were only read: the user's `api-acp-proxy` and `creative-hub` repos, plus a listing of the DeepSeek Harness install. Builds on `notes-pi.md` and `notes-pi-durable.md`.

**Tags**
- **[P]** primary: official docs, repo, npm registry, or the user's own local file (path given).
- **[S]** secondary: blogs, aggregators, search snippets.
- **(est.)** estimate or inference, not sourced.

**Caveats**
- Pages were read through WebFetch, which summarises them with a small model. Treat any single quote as near-verbatim.
- Some sections came from two parallel research forks. Their claims kept their URLs, and a few doubtful ones were dropped.

## 0. What changes the picture (verified locally)

**Creative hub is the user's own repo,** `C:\projects\Personal\creative-hub`.
- **Services:** its tools are HTTP MCP servers on 127.0.0.1, listed in `.mcp.json` [P] (local file `C:\projects\Personal\creative-hub\.mcp.json`):
  - scriptorium :7341, book-translator :47811 (bearer token), vn-studio :7459, pixel-studio :7457;
  - chiptune-studio :7458, vibetts :7723, comfy-mcp :7460, flow-music-mcp :7462.
- **Authentication:** only book-translator has an `Authorization` header in that file. All the other servers are unauthenticated on localhost [P] (same file).
- **Rules in its `CLAUDE.md`** [P] (local file `C:\projects\Personal\creative-hub\CLAUDE.md`, lines 7-8):
  - "Video spends Flow credits: agree a budget first (default 150 per production)".
  - `scripts/video-plan.mjs` keeps the estimate and each call's `max_credits`.
  - "Never start Scriptorium without asking".
- **Skills:** `make-video` and `make-visual-novel` [P] (local folder `C:\projects\Personal\creative-hub\.claude\skills\`).

**The user's "ACP proxy" is their own app,** `C:\projects\Personal\api-acp-proxy`, package `codex-subscription-openai-proxy` 0.1.0.
- **What it is:** a localhost OpenAI-compatible proxy (Models, Chat Completions, Responses) on top of ACP agents [P] (local file `C:\projects\Personal\api-acp-proxy\README.md`):
  - Codex via `@agentclientprotocol/codex-acp` 2.3.0;
  - Claude via `@agentclientprotocol/claude-agent-acp` 0.91.0;
  - Antigravity via `agy_acp_server`.
- **It is deliberately text-only and stateless** [P] (same README, "Claude", "Codex" and "Supported API"):
  - Claude's built-in tools are disabled, and permission requests are answered "cancelled".
  - `settingSources: []`, so CLAUDE.md, hooks and `.mcp.json` are ignored.
  - Sessions run in disposable temp working dirs (`PROXY_WORK_ROOT`).
  - Codex runs read-only with `approval_policy: "never"` and shell tools removed.
- **It is also an MCP server** at `POST /v1/mcp`, with tools `list_models`, `ask_model` and `generate_image` [P] (same README, "MCP server (for harnesses)").
- **Its README itself warns:** "Using a Claude subscription through third-party tooling may conflict with Anthropic's consumer terms" [P] (same README, "Claude terms / risk").

## 1. MCP client in Pi / Pi Durable

### 1.1 What exists

**Pi coding agent: built-in since v0.99 (2026-09-29) / 1.0.**
- Pi 1.0 lists "Codemode (native support for MCP ...)" and deferred tool loading [P] https://earendil.com/posts/pi-1-0/.
- The "You Said No MCP!" reversal shipped with v0.99.0 [S] https://ai-tldr.dev/releases/earendil-pi-0-99-mcp-codemode/.
- **Config:** `~/.pi/agent/mcp.json` or `.pi/mcp.json` with `"mcpServers"`. Transports are stdio and Streamable HTTP; legacy SSE is rejected [P] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/mcp.md.
- **Exposure:** the default is `codemode`. Alternatives are `deferred` (via `tool_search`), `direct` and `hidden`. Text results over 20 KB are trimmed in context [P] same URL.
- **SDK sessions do not load MCP by default.** You must add the MCP, codemode and tool-search extensions yourself [P] same URL.
- **Permissions:** MCP calls go through the normal `tool_call` pipeline, so permission-gate extensions apply. MCP hints (`readOnlyHint`, `destructiveHint`) are readable by extensions [P] same URL.

**First-party MCP client package: `@earendil-works/pi-mcp` 1.4.0** (same version as pi-durable 1.4.0). Node ≥22.19; its only dependency is `cross-spawn` [P] https://raw.githubusercontent.com/earendil-works/pi/main/packages/mcp/package.json. Per its README [P] https://raw.githubusercontent.com/earendil-works/pi/main/packages/mcp/README.md:
- It does **not** depend on `@modelcontextprotocol/sdk`.
- API: `McpClient`, `StdioTransport`, `StreamableHttpTransport` (injectable `fetch`, `authProvider`), `listTools`, `callTool(name,args,{signal})`, `toLlmContent`.
- Protocol 2025-11-25, with progress, cancellation and OAuth (`/oauth`).
- **No** legacy SSE, sampling or MCP Tasks.
- The README shows how to wrap each MCP tool as an agent tool, sanitising names to 64 chars.

**Pi Durable itself:**
- **Ships:** `createCodemodeExtension` (`@earendil-works/pi-durable/codemode`), `createToolSearchExtension()` (`/tool-search`), and `deferred: true` tools. "A `deferred: true` tool is not offered to the model until it is loaded", and `tool_search` loads matches via `control.addTools` [P] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md.
- **Does not ship:** an MCP extension. You wrap `pi-mcp` tools with `defineTool` yourself [P] same URL (only CodingTools, codemode and tool-search ship).

**Community packages:**
- **pi-mcp-adapter** (nicobailon, MIT) [P] https://registry.npmjs.org/pi-mcp-adapter/latest and https://github.com/nicobailon/pi-mcp-adapter:
  - npm latest **7.0.0**; built on `@modelcontextprotocol/client` 2.3.1 and `ext-tasks`; ~1.6k stars, 753 commits.
  - One ~200-token proxy tool plus lazy server start, `directTools`, and MCP Tasks.
  - It is a **Pi coding-agent extension**; Pi Durable is not mentioned. No Windows notes.
  - pi.dev listed 5.4.0 on 2026-10-20 at ~1.6M downloads/month [S] https://pi.dev/packages/pi-mcp-adapter, so it moves fast.
- **pi-durabletask-mcp** (repo name; the README calls it "pi-durateam") runs the **opposite direction**: Claude Code or Codex is the MCP client delegating work *to* Pi agents [P] https://github.com/Nyarlathoteppppp/pi-durabletask-mcp.
  - "Requires macOS or Linux"; 16 stars; MIT. Not useful here.
  - Listed on piindex [S] https://piindex.dev/topics/pi-durable/.

### 1.2 Effort to add MCP tools to a Pi Durable harness

**Route A (recommended): `@earendil-works/pi-mcp`.**
- Same vendor and version lock as pi-durable, no extra SDK.
- Steps: connect `StreamableHttpTransport` per creative-hub server, `listTools()`, map each tool to `defineTool({ name: mcp__<server>__<tool>, parameters: <JSON schema>, replay: "unsafe", deferred?: true, execute: callTool })`, install it in an extension, and add `createToolSearchExtension()`.
- **About 150-300 LOC, 0.5-1 day (est.).**

**Route B: `@modelcontextprotocol/sdk`** (npm latest 1.32.2, Node ≥18 [P] https://registry.npmjs.org/@modelcontextprotocol/sdk/latest).
- The same mapping plus schema conversion to TypeBox or raw JSON schema.
- **About 200-350 LOC, about 1 day (est.).**
- Only worth it if you need a feature pi-mcp lacks (MCP Tasks, legacy SSE).

**Gotchas (est.):**
- Keep tools `replay: "unsafe"` so a crash never re-fires a credit-spending Flow call. Pi Durable's default is already `"unsafe"` [P] (notes-pi-durable.md, types.ts).
- Long Flow or ComfyUI jobs need a per-call timeout well above 60 s. Forward `progress` notifications to Telegram via `api.output()`.

### 1.3 Progressive discovery and tool count for a ~30B local model

**Evidence that tool count matters:**
- **Anthropic:** tool search raised Opus 4 from 49% to 74% on MCP evals. They recommend it from 10 or more tools, or more than 10K tokens of definitions [P] https://www.anthropic.com/engineering/advanced-tool-use.
- **RAG-MCP:** retrieval-first tool selection reached 43.13% against a 13.62% baseline, with less than half the prompt tokens [P] https://arxiv.org/html/2505.03275v1.

**The hub's raw surface is large.** chiptune-studio alone exposes ~50 tools (`new_song`, `write_pattern`, `export_wav`, ...), visible in this session's MCP tool list (local observation). The eight servers together likely run to several hundred tools (est.).

**Recommendation (est.):**
- Give the orchestrator **≤8-10 direct tools**: `dispatch_job`, `job_status`, `cancel_job`, `ask_user`, `list_templates`, plus a few curated "macro" MCP tools.
- Mark everything else `deferred: true` behind `tool_search`.
- Avoid `codemode` for the local model until tested: writing correct JavaScript against tool declarations is closer to coding than to routing.

## 2. ACP (Agent Client Protocol)

### 2.1 Spec and SDK

**Spec.** Stable is **v1**. **ACP v2 has been a Draft since 2026-07-20** [P] https://agentclientprotocol.com/updates.

Recent stabilisations [P] same URL:

| Date | Stabilised |
|---|---|
| 2026-04-22 | `session/resume` |
| 2026-04-23 | `session/close` |
| 2026-06-29 | `$/cancel_request` |
| 2026-07-22 | Elicitation |
| 2026-09-17 | Tool Call Names |

- The ACP Registry launched 2026-03-09 [P] same URL.
- The Rust and TypeScript SDKs reached 1.0 on 2026-06-25 [P] same URL.

**TypeScript SDK: `@agentclientprotocol/sdk`, npm latest 2.0.2.** Peer dependency `zod`; repo agentclientprotocol/typescript-sdk [P] https://registry.npmjs.org/@agentclientprotocol/sdk/latest.
- The fluent `client()` / `agent()` API replaces the deprecated `ClientSideConnection` / `AgentSideConnection` [P] https://agentclientprotocol.com/libraries/typescript.
- Note: the user's proxy pins `^1.4.0`. 2.x is a major bump, so check the changelog before sharing code [P] (local `api-acp-proxy\package.json`; npm registry above).

### 2.2 How a client drives an agent

The lifecycle is `initialize` → optional `authenticate` → `session/new` (with `cwd` and MCP servers) or `session/load` → `session/prompt` → `session/update` notifications → the `session/prompt` response carries a stop reason [P] https://agentclientprotocol.com/protocol/overview.
- **Cancel:** `session/cancel` is a notification [P] same URL.
- **Client-side methods:** `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release` [P] same URL.

**`sessionUpdate` kinds** [P] https://agentclientprotocol.com/protocol/prompt-turn:
- `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`;
- `tool_call`, `tool_call_update`, `plan`;
- `available_commands_update`, `current_mode_update`, `config_option_update`;
- `session_info_update`, `usage_update`, `notice`, `compaction_update`.

**StopReason values:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` [P] same URL.

**On cancel** the client MUST answer every pending permission request with `cancelled`, and the agent replies to `session/prompt` with `cancelled` [P] same URL.

**`session/request_permission`** [P] https://agentclientprotocol.com/protocol/tool-calls:
- Params: `{sessionId, toolCall: ToolCallUpdate, options: PermissionOption[]}`, where each option is `{optionId, name, kind}`.
- `kind` is one of `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- The response `outcome` is `{outcome:"selected", optionId}` or `{outcome:"cancelled"}`.
- Tool call `status`: `pending` | `in_progress` | `completed` | `failed`.
- `kind`: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`.

### 2.3 Claude Code over ACP

**Package: `@agentclientprotocol/claude-agent-acp`, latest 0.97.0** (preview 0.97.1-preview.7). Bin `claude-agent-acp`; Apache-2.0; Node ≥22 [P] https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/latest and https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk` 0.3.310 and `@agentclientprotocol/sdk` 2.0.2 [P] same URLs.
- **Maintainers:** benbrandt, aguzubiaga, cirwin, under the agentclientprotocol org [P] same URLs.
- **History:** renamed from `@zed-industries/claude-code-acp` → `claude-agent-acp` [S] https://git.secluded.site/zed/commit/f64484a9e384ef82d2856fa66c149e4776e302ea.
- **Features** [P] https://github.com/agentclientprotocol/claude-agent-acp:
  - permission requests, client MCP servers and `/mcp`;
  - interactive and background terminals, slash commands;
  - TODO/plan, subagent sessions;
  - the v2 session set (`new`, `list`, `resume` with replay, `close`, `fork`);
  - `CLAUDE_AGENT_ACP_PROTOCOL=v1|v2|auto`.
- **Windows:** the README says nothing. **Practical evidence:** the user's own proxy bundles it and its desktop build targets Windows x64 [P] (local `api-acp-proxy\README.md`, "Desktop app (Windows)").

**Auth.** The adapter wraps the Agent SDK, which runs the Claude Code binary. It therefore picks up whatever that binary would use: the `/login` credentials in `%USERPROFILE%\.claude\.credentials.json`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY`.
- The proxy documents exactly these three, plus `CLAUDE_CONFIG_DIR` [P] (local `api-acp-proxy\README.md`, "Claude", step 3).
- It also documents `claude-ai-login` and `console-login` auth methods [P] (same README).
- Precedence and storage [P] https://code.claude.com/docs/en/authentication.
- For terms, see §3.2.

### 2.4 Other harnesses that speak ACP, and DeepSeek

The official agents list includes Gemini CLI and "Claude Code (Adapter via Zed's SDK adapter)", among others [P] https://agentclientprotocol.com/overview/agents.

| Harness | ACP | DeepSeek? | Source |
|---|---|---|---|
| Codex CLI | via `@agentclientprotocol/codex-acp` (ChatGPT login, `CODEX_API_KEY`, custom gateway) | via custom provider, `wire_api="responses"`; reportedly only deepseek-v4-flash worked [S] | [P] https://github.com/agentclientprotocol/codex-acp; [S] https://aireiter.com/blog/deepseek-codex-setup |
| Gemini CLI | yes | no path found | [P] https://agentclientprotocol.com/overview/agents |
| OpenCode | `opencode acp`; headless `opencode run --format json` | yes; listed by DeepSeek | [P] https://opencode.ai/docs/acp/, https://opencode.ai/docs/cli/, https://api-docs.deepseek.com/quick_start/agent_integrations/deepseek_harness |
| Goose | `goose acp` | custom OpenAI-compatible provider | [S] https://goose-docs.ai/docs/gdk/acp/, https://www.withone.ai/connect/goose/deep-seek |
| Qwen Code | experimental `qwen serve` | OpenAI-compatible; DeepSeek not named | [P] https://github.com/QwenLM/qwen-code |
| Pi | community adapters only (§2.5) | any pi-ai OpenAI-compatible provider | [P] https://github.com/svkozak/pi-acp |
| **DeepSeek Harness (`dsh`)** | `dsh --profile acp` (ACP v1 over stdio) | native | §4 |
| Claude Code on DeepSeek | via claude-agent-acp | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` | [P] https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code |

### 2.5 Does Pi / Pi Durable speak ACP?

**Pi core: no ACP.** The Pi 1.0 post does not mention ACP [P] https://earendil.com/posts/pi-1-0/. The CLI integration doc lists only interactive, print, JSON, RPC and SDK modes [P] https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/cli-integration.md.

**Community ACP *server* adapters for the Pi coding agent:**
- **svkozak/pi-acp** spawns `pi --mode rpc`. It has no `fs/*` or `terminal/*` delegation, and ACP-sent MCP servers are not passed through [P] https://github.com/svkozak/pi-acp.
- **victor-software-house/pi-acp** embeds the SDK; "pi does not request permission from ACP clients" [S] https://github.com/victor-software-house/pi-acp.
- Also: DxTa/pi-acp, @geohar/pi-acp, the Rust pi-acpinator, and acp-go-pi [S] (search results, same query).

**Pi Durable:** no ACP client or server found [S] https://piindex.dev/topics/pi-durable/ (none listed). To drive Claude Code or `dsh` from Pi Durable, you write the ACP **client** yourself with `@agentclientprotocol/sdk`, inside a Pi Durable task (§5.2).

### 2.6 What "ACP proxy" usually means

1. **ACP proxy chains**, an RFD that is still a draft [P] https://agentclientprotocol.com/rfds/proxy-chains.
   - A **conductor** sits between client and agent and runs a chain of proxies (`proxy/initialize`, `proxy/successor`).
   - Proxies can inject context or prompts, filter or transform responses, and add MCP tools via MCP-over-ACP.
   - Implementations: the Rust `sacp-conductor` (being renamed `agent-client-protocol-conductor`) [P] same URL; the TypeScript `@thinkwell/conductor` [S] https://cdn.jsdelivr.net/npm/@thinkwell/conductor@0.5.7/README.md.
   - Useful later for a "policy proxy" that rewrites or denies permission requests in front of any agent (est.).
2. **ACP → OpenAI-compatible HTTP bridges.** These turn agents into "models":
   - **the user's own `api-acp-proxy`** (§0);
   - acp2api [S] https://github.com/neprel/acp2api;
   - ACPBox [S] https://pypi.org/project/acpbox/.
3. **ACP → library bridges:** the AI SDK community ACP provider [S] https://ai-sdk.dev/providers/community-providers/acp.
4. **Adapters** that make a non-ACP agent speak ACP. These are sometimes loosely called proxies: claude-agent-acp, codex-acp, pi-acp (above).
5. **Chat-gateway control planes:** OpenClaw's `@openclaw/acpx` drives Claude Code, OpenCode, Gemini CLI and others over ACP, with chat or thread `bindings[]` [P] https://docs.openclaw.ai/tools/acp-agents.

## 3. Driving Claude Code programmatically

Installed here: Claude Code 2.1.310 at `C:\Users\Infplane\.local\bin\claude.exe` (coordinator's local scout). Every doc feature cited below with a minimum version ≤2.1.310 should be present.

### 3.1 Options compared

| | `claude -p` stream-json | Agent SDK (TS) | ACP via claude-agent-acp | Remote Control / Channels |
|---|---|---|---|---|
| Package / entry | CLI | `@anthropic-ai/claude-agent-sdk`; bundles a native binary per platform; `pathToClaudeCodeExecutable` to reuse the installed one [P] https://code.claude.com/docs/en/agent-sdk/typescript | `claude-agent-acp` (§2.3) | `claude remote-control`; Channels `--channels plugin:telegram@claude-plugins-official` |
| Progress events | `--output-format stream-json --verbose --include-partial-messages`; `system/init` (tools, MCP status, `mcp_server_errors`), `stream_event`, assistant/user messages with `parent_tool_use_id` for subagents, `system/api_retry`, final `result` with cost and `permission_denials` [P] https://code.claude.com/docs/en/headless | Same messages as typed `SDKMessage`s (`SDKSystemMessage`, `SDKPartialAssistantMessage`, `SDKTaskProgressMessage`, `SDKResultMessage`, ...) [P] typescript ref above | `session/update`: chunks, `tool_call`/`tool_call_update` with kind and status, `plan`, `usage_update` (§2.2) | Claude app / claude.ai UI; Channels relay to Telegram |
| Permissions | `--permission-mode` (`default`/manual, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`), `--allowedTools`/`--disallowedTools`, `--permission-prompt-tool` (MCP tool), `PermissionRequest` hook, `--permission-prompts none`. Since v2.1.302, `-p` starts in Manual and denies anything unapproved [P] headless doc | Evaluation order: hooks → deny → ask → mode → allow → `canUseTool(toolName, input, {signal, suggestions})` returning `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}`. The callback "can stay pending indefinitely"; use a `PreToolUse` hook `defer` for very long waits [P] https://code.claude.com/docs/en/agent-sdk/permissions, https://code.claude.com/docs/en/agent-sdk/user-input | `session/request_permission` with allow/reject once/always options (§2.2) | Remote Control forwards prompts to phone/web [P] https://code.claude.com/docs/en/remote-control; Channels has "permission relay" to Telegram [P] https://code.claude.com/docs/en/channels |
| cwd | process cwd; `--add-dir` | `cwd` option | `session/new` `cwd` (+ `additionalDirectories`, stabilised 2026-06-01 [P] https://agentclientprotocol.com/updates) | directory where started; `--spawn same-dir/worktree` |
| Resume | `--resume <id>` / `--continue`; `--resume` also accepts a transcript path [P] headless doc | `resume`, `forkSession`, `continue` [P] typescript ref | `session/resume`, `session/load` (v1); `session/list` | `--continue` / `--session-id` [P] remote-control doc |
| Cancel | SIGINT ends the turn; SIGTERM exits 143 and leaves the turn unfinished [P] headless doc | `interrupt()` (streaming input), `abortController`, `close()` [P] typescript ref | `session/cancel` | from the app |
| Auth | any (§3.2); `--bare` reads only `ANTHROPIC_API_KEY` or `apiKeyHelper`, never OAuth or `CLAUDE_CODE_OAUTH_TOKEN` [P] headless doc, authentication doc | API key per docs; the binary also reads OAuth (§3.2) | same as SDK | **subscription only; API keys not supported** [P] remote-control doc |
| Fit for a 24/7 job runner | good, simplest | best control in-process | best if one client drives Claude **and** `dsh`/OpenCode | not a job API: one live session per process, human-driven |

**Windows caveats:**
- **Shell:** native Windows uses Git Bash for the Bash tool if present, else the PowerShell tool. Sandboxing is **not supported on native Windows**, only in WSL2 [P] https://code.claude.com/docs/en/setup.
- **Signals:** Node's `subprocess.kill()` on Windows ignores signal semantics and kills the process abruptly. So "SIGINT to end the turn cleanly" is not available for a `claude -p` child [P] https://nodejs.org/api/child_process.html#subprocesskillsignal. Prefer the SDK's `interrupt()` or ACP `session/cancel` (est.).
- **Untrusted folders:** without `--bare`, a `-p` run executes the project's `.claude/settings.json` hooks and connects its `.mcp.json` servers with no trust dialog [P] headless doc. That is fine for the user's own creative hub, but dangerous for any untrusted folder.
- **Shared OAuth lock:** concurrent Claude processes share an OAuth refresh lock (`~/.claude/.oauth_refresh.lock`). The user's proxy maps the resulting "another Claude Code process is refreshing it" error to a retry [P] (local `api-acp-proxy\README.md`, "Busy login"). Expect the same with parallel jobs.

### 3.2 Subscription login vs API key, and terms

**Precedence:**
1. cloud provider;
2. `ANTHROPIC_AUTH_TOKEN`;
3. `ANTHROPIC_API_KEY` (always used in `-p` when present);
4. `apiKeyHelper`;
5. `CLAUDE_CODE_OAUTH_TOKEN`, a one-year token from `claude setup-token` that "can only make model requests";
6. profiles;
7. `/login` subscription OAuth.

Source [P] https://code.claude.com/docs/en/authentication.

**Docs: Agent SDK** [P] https://code.claude.com/docs/en/agent-sdk/overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods..."

**Docs: legal page** [P] https://code.claude.com/docs/en/legal-and-compliance:
- OAuth is "intended exclusively for purchasers of ... subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications".
- Developers "should use API key authentication"; Anthropic does not permit "route requests through Free, Pro, or Max plan credentials on behalf of their users".
- It also says this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

**Reading (est., not legal advice):**
- **Lowest risk:** the user's own personal orchestrator launching the **unmodified `claude` binary** (`claude -p` or claude-agent-acp, which runs the binary) under their own login, for their own jobs, at human-scale volume. That is the case the docs explicitly carve out.
- **Gray:** building on the Agent SDK with subscription OAuth.
- **Clean:** an API key.
- **Risky:** 24/7 high-volume automation may fall outside "ordinary, individual usage".
- The user's proxy README flags the same risk (§0).

### 3.3 Running under a different Windows user

**Credentials are per Windows profile**, in `%USERPROFILE%\.claude\.credentials.json`, restricted by the profile ACL. `CLAUDE_CONFIG_DIR` moves them [P] https://code.claude.com/docs/en/authentication. A job under another Windows user does **not** see the interactive user's login.

**Options:**
- **(a)** Sign in once as that user (`claude auth login`) with the same Claude account.
- **(b)** Give the service user a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, stored as that user's secret. It works for model calls and local MCP, but not for Remote Control or claude.ai connectors, and not with `--bare` [P] same URL.
- **(c)** An API key.

**Recommendation (est.):** (a) or (b) for a dedicated low-privilege `agent007` Windows user that owns only `creative-hub` and the output folders. Copying another user's `.credentials.json` is fragile because the refresh token rotates.

### 3.4 Remote Control and Channels

**Remote Control** [P] https://code.claude.com/docs/en/remote-control:
- Needs a Pro/Max/Team/Enterprise subscription; API keys are not supported.
- Server mode is `claude remote-control`, with `--spawn same-dir|worktree|session`, `--capacity` (default 32) and `--permission-mode`.
- Driven from claude.ai/code or the Claude app, not by an API. It is a good *manual* fallback for the user to take over a job from their phone.

**Channels** (research preview) [P] https://code.claude.com/docs/en/channels:
- The plugin `telegram@claude-plugins-official` (needs Bun) feeds one live session from Telegram, with a pairing-code allowlist and permission relay.
- It is not a job queue, and it would compete with agent-007's own bot token. Use a different bot if at all (est.).

## 4. DeepSeek harnesses

**DeepSeek Harness (`dsh`) is DeepSeek's official, MIT, "developer preview" agent harness.** "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" [P] https://github.com/deepseek-ai/deepseek-harness, https://api-docs.deepseek.com/quick_start/agent_integrations/deepseek_harness.

**The installed copy is the official nightly build** [P] (local `C:\Users\Infplane\AppData\Local\Programs\DeepSeek Harness\resources\app-update.yml`):
- feed `download.deepseek.com/dsh-desk/feeds/win-x64/`;
- publisher Hangzhou DeepSeek AI Co.

**How the shim runs:** `dsh.cmd` runs the Electron exe with `ELECTRON_RUN_AS_NODE=1`, so no separate Node is needed. It bundles Node 24.21.0 [P] (local `resources\runtime\cli\bin\dsh.cmd`, `resources\runtime\versions.json`).

**Profiles**, from docs embedded in `app.asar` [P] (local grep, same install):
- **`--profile headless`:** one task per call; `--json` event stream; `--session-id` to resume; exit code 0/1.
- **`--profile acp`:** "Serve automation clients over Agent Client Protocol stdio". ACP v1: `initialize` → `session/new` (absolute `cwd`, stdio/HTTP MCP servers) → `session/prompt` → `session/close`. `session/list` and `session/resume` are supported, and it implements `session/request_permission`.
- Others: `web`, `sdk`, `tui`, `desktop`.

**Providers:**
- `DEEPSEEK_API_KEY` [P] (local asar strings).
- Any OpenAI- or Anthropic-compatible base URL [P] (same). So it could point at LM Studio or Strata (est., untested).
- It depends on `@earendil-works/pi-ai` ^1.1.0, the same LLM layer as Pi Durable [P] (same).

**Gaps:**
- It is not on the official ACP agents list [P] https://agentclientprotocol.com/overview/agents.
- The app version is unknown (`version` 44.7.0 is probably Electron) (est.).

**Other DeepSeek-capable, scriptable harnesses:** see the table in §2.4.
- DeepSeek's own integration list: Claude Code, Codex, OpenCode, OpenClaw, Hermes, Reasonix, WorkBuddy/CodeBuddy, Qoder, DeepSeek Harness [P] https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code.
- Its Anthropic endpoint maps `claude-opus*` → deepseek-v4-pro and `claude-sonnet*`/`claude-haiku*` → deepseek-flash. It ignores `mcp_servers`, `cache_control` and `budget_tokens` [P] https://api-docs.deepseek.com/guides/anthropic_api.

**Recommendation (est.):**
- Drive `dsh --profile acp` with the **same ACP client** as claude-agent-acp.
- Fallbacks: `dsh --profile headless --json`, then OpenCode.
- Pin and test after every nightly update.

## 5. Local model as orchestrator

### 5.1 Evidence on reliability

**Qwen3.6-35B-A3B model card** [P] https://huggingface.co/Qwen/Qwen3.6-35B-A3B:

| Benchmark | Score |
|---|---|
| SWE-bench Verified | 73.4 |
| Terminal-Bench 2.0 | 51.5 |
| TAU3-Bench | 67.2 |
| MCP-Atlas | 62.8 |
| MCPMark | 37.0 |
| Tool Decathlon | 26.9 |
| DeepPlanning | 25.9 |
| Claw-Eval Pass^3 | 50.0 |

- The card recommends the `qwen3_coder` tool-call parser and ≥128K context for thinking mode [P] same URL.

**Qwen3-30B-A3B-2507** [S] https://arxiv.org/pdf/2511.05951 (Table 2):
- BFCL v3: 65.1 Instruct, 72.4 Thinking.
- τ-bench Airline: 40.0 Instruct, 48.0 Thinking.

**Reading (est.):**
- Single-step tool selection is decent, but long multi-step tool chains are much weaker than the coding scores suggest.
- So the "classify → pick one of a few tools → fill a typed template" dispatch is plausible, and open-ended multi-tool production runs are not.
- That argues for handing whole productions to Claude Code or `dsh`.

**Gaps:**
- No benchmark tests a ~30B local model specifically as a router or dispatcher. The user needs a 20-50 prompt routing eval through LM Studio/Strata and pi-ai (est.).
- The "Qwen3.8-Flash-Next" model served by Strata was not researched in this pass. No benchmark numbers are given for it.

**Pi-specific risk:** pi-ai does not recover tool calls the model emits as text (#6635). The server's tool-call parser is the only line of defence [P] https://github.com/earendil-works/pi/issues/6635 (via notes-pi-durable.md).

### 5.2 Patterns

**Published patterns:**
- Anthropic's "routing" pattern "classifies an input and directs it to a specialized followup task" [P] https://www.anthropic.com/engineering/building-effective-agents.
- Its "orchestrator-workers" pattern has "a central LLM dynamically breaks down tasks, delegates them to worker LLMs" [P] same URL.
- LangGraph now recommends "using the supervisor pattern directly via tools" [P] https://github.com/langchain-ai/langgraph-supervisor-py.

**Durable job tree on Pi Durable (est.):**
1. The orchestrator conversation calls `dispatch_job({template, params})`.
2. The tool validates the template and params, gets a Telegram approval if the template needs one, and creates a `defineTask` job (`tx.createTask(Job, input, { ownership: { kind: "conversation" }, background: true })`).
3. The task phases are: `start` (spawn the runner over ACP or the CLI, store sessionId) → `run` (stream updates to a `JobDoc` and Telegram; answer permissions) → `collect` (artifacts and summary) → `done`.
4. Each phase commits state via `runtime.commit`. On crash, `resume()` reruns the phase, which re-attaches with `session/resume` or `--resume <id>` instead of starting a new job.

The primitives are in notes-pi-durable.md: `defineTask`, `runtime.commit`, `sleepUntil`, `waitForTask`, `beforeTool` + `api.memo` [P] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md.

**Prior art (Telegram → Claude Code):**
- **RichardAtCT/claude-code-telegram:** MIT, v1.3.0, Python, Agent SDK with CLI fallback. Has `ALLOWED_USERS`, `CLAUDE_ALLOWED_TOOLS`, `APPROVED_DIRECTORY`, a per-user cost cap, an audit log, topics per project, and cron. systemd only [P] https://github.com/RichardAtCT/claude-code-telegram. **The best feature template.**
- **Official Claude Code Channels** (§3.4).
- **TopSpeed0/ClaudeCodeTelgMCP:** Windows-oriented, `claude -p` task daemon plus a PowerShell restart loop [S] https://github.com/TopSpeed0/ClaudeCodeTelgMCP.
- **fitz123/claude-code-bot** [S] https://awesome.ecosyste.ms/projects/github.com%2Ffitz123%2Fclaude-code-bot.
- **Pi-side Telegram bots:** pi-durable-telegram, sumire, mikan, TelePi (notes-pi*.md).

**None of these** dispatches from a *local-model* orchestrator to Claude Code. That combination is new (est.).

## 6. Security notes

**Threat model: the "lethal trifecta."** Private data + untrusted content + an exfiltration path = injectable [S] https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/. agent-007 has all three:
- private data: files and credentials;
- untrusted content: MCP outputs, web results, generated scripts, forwarded Telegram messages;
- exfiltration paths: Claude Code's network tools, Flow uploads.

**Prompt injection via MCP outputs.**
- Claude Code docs: "Avoid piping untrusted content directly to Claude", and use VMs for untrusted work [P] https://code.claude.com/docs/en/security.
- MCP spec: local HTTP servers SHOULD require an auth token, and DNS rebinding can reach a localhost server [P] https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices.
- **Seven of the eight hub servers have no auth** (§0). Any local process, or a rebinding web page if they skip the `Origin` check, can call `flow-music-mcp` and spend credits (est.). Ask for Origin validation and a bearer token on them.

**Permission modes to avoid for orchestrated jobs:**
- **`bypassPermissions`.** `allowedTools` "does not constrain" it, and subagents inherit it [P] https://code.claude.com/docs/en/agent-sdk/permissions.
- **`auto`.** A classifier decides instead of the user, and native Windows has no sandbox to back it up [P] same URL and https://code.claude.com/docs/en/setup.

**Use instead (est.):**
- **Supervised jobs:** `default` + `canUseTool` (or ACP `request_permission`) → Telegram.
- **Unattended template jobs:** `dontAsk` + explicit scoped `allowedTools` + `--permission-prompts none` [P] https://code.claude.com/docs/en/headless.
- **Everywhere:** deny rules such as `Bash(*hub.ps1 start scriptorium*)` and `mcp__flow-music-mcp__*` unless the template enables Flow.
- **Caveat:** deny rules match the command *as written* [P] https://code.claude.com/docs/en/agent-sdk/permissions. So prefer removing Bash entirely for creative jobs (`disallowedTools: ["Bash"]`) and give the orchestrator its own allowlisted `hub_start(service)` tool.

**Job templates and allowlists (est.).** The local model never writes a free-form Claude prompt with free-form permissions. It picks a **template id** and fills typed **params**. Each template fixes:
- runner, cwd and model;
- permission mode and allowed/denied tools;
- MCP servers;
- budget and timeout;
- whether approval is needed.

User text goes in a delimited "brief" field. The template prompt tells Claude to treat the brief as content, not instructions.

**ACP permission → Telegram buttons:**
- **Buttons:** render each `PermissionOption` as an inline button. `callback_data` is limited to "1-64 bytes" [P] https://core.telegram.org/bots/api#inlinekeyboardbutton. So store `{jobId, sessionId, toolCallId, optionId}` server-side under a short random key, and put only that key in the button.
- **Acknowledge:** always call `answerCallbackQuery`; "Telegram clients will display a progress bar until you call answerCallbackQuery" [P] https://core.telegram.org/bots/api#callbackquery.
- **Drop the "always" options (est.).** In the SDK path, "approve and remember" writes rules to `.claude/settings.local.json` [P] https://code.claude.com/docs/en/agent-sdk/user-input, so a tap would widen permissions persistently.
- **Re-check the allowlisted user id** on every callback (est.).
- **Show** kind, title and a truncated `rawInput` (command, path) plus the job's cwd (est.).
- **On job cancel**, answer every pending permission request with `{outcome:"cancelled"}`; the spec requires it [P] https://agentclientprotocol.com/protocol/prompt-turn.
- **On orchestrator crash** the ACP child dies with any pending request. After restart, use `session/resume` and let the agent re-ask. Store decisions with `api.memo` keyed by toolCallId so a replay doesn't re-prompt (est.).
- **Timeouts:** the SDK callback can wait indefinitely [P] https://code.claude.com/docs/en/agent-sdk/user-input. Put a deadline on approvals (for example 30 min → reject) (est.).

**Flow credits and budget guards (iii)** (est., built on the hub's own rules in §0):
1. A per-job `budget_credits` param (default 150, matching the hub's CLAUDE.md), recorded in a durable `BudgetDoc`, with a daily cap across jobs.
2. **Orchestrator direct calls:** a `beforeTool` hook on `mcp__flow-music-mcp__*` blocks any call without `max_credits`, or with `max_credits` above the remaining budget, and asks for Telegram approval above a threshold. `replay: "unsafe"` stops a crash from re-firing a call.
3. **Claude Code jobs:** Flow tools are disallowed unless the template enables them. When enabled, a `PreToolUse` hook (or `canUseTool`) checks `max_credits` against the job budget passed via env.
4. Post-hoc: parse credits spent from tool results into the ledger, and report them in the final Telegram message.
5. **Not verified:** the exact flow-music-mcp tool schema and whether it reports spent credits. Read its tool list before relying on `max_credits` field names.

**Scriptorium:** only the user can start it. `hub_start("scriptorium")` always needs Telegram approval, mirroring "Never start Scriptorium without asking" [P] (local `creative-hub\CLAUDE.md`).

## 7. Settings UI, model-editable settings, personas

### 7.1 A settings UI

**Prior art:**
- **pi-pocket** (MIT, on Pi Durable) [P] https://github.com/TannerMidd/pi-pocket:
  - A web UI with per-session model choice, a providers sheet, skills, and extensions reloadable at runtime.
  - Auth is an owner-key sign-in link (`--rotate-token`).
  - Modes: `local` (127.0.0.1:8787), `lan`, `cloudflare`, `tailscale`. Windows is listed as supported.
- **Hearth Pi (ha-pi-durable)** [P] https://github.com/cosmyo/ha-pi-durable:
  - Settings UI at `127.0.0.1:8099`. Permissions are "authenticated owner settings" stored in the Durable store with a revision; a policy change invalidates pending proposals.
  - **The closest prior art for "the model can't touch security settings".**
- **OpenClaw Control UI** [P] https://docs.openclaw.ai/web/control-ui:
  - Per-agent and global settings (models, skills, MCP).
  - "A direct loopback connection does not bypass token or password auth."
- **pi-durable-telegram:** env-file configuration only [P] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/docs/configuration.md.

**Telegram-native:**
- Inline keyboards are enough for toggles and pickers.
- Mini Apps need server-side `initData` HMAC validation [P] https://core.telegram.org/bots/webapps, and in practice a public HTTPS URL [S] https://github.com/feathers-studio/telegraf-docs/blob/master/examples/mini-apps/README.md. Defer them (est.).

**Localhost UI security:**
- Bind 127.0.0.1, validate `Origin`, authenticate [P] https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.
- Use a Host-header allowlist against DNS rebinding [S] https://github.com/nccgroup/singularity/wiki/%5BAnnouncement-Blog-Post%5D--Singularity-of-Origin:-A-DNS-Rebinding-Attack-Framework.
- CSRF [P] https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html:
  - a token or custom header;
  - "`Origin: null`" is not same-origin;
  - `Sec-Fetch-Site`;
  - no state change on GET.
- Do not trust `X-Forwarded-*` (est.).

**Proposal (est.):**
- A small HTTP server in the same process (≈400-700 LOC), with JSON-schema forms for:
  - personas;
  - the MCP server list;
  - runners and models;
  - job templates;
  - schedules;
  - budgets.
- The user's `api-acp-proxy` already has a settings window and `safeStorage`-encrypted keys [P] (local README), so its UI code is reusable.

### 7.2 The model changing settings

**How others do it:**
- **OpenClaw** has agent-facing `config.patch` / `config.apply` with `baseHash` concurrency [P] https://docs.openclaw.ai/gateway/configuration/config-rpc.
  - Two 2026 CVEs bypassed its denylist of protected paths [S] https://corgea.com/advisories/vulnerabilities/CVE-2026-45001, https://corgea.com/advisories/vulnerabilities/CVE-2026-45006.
  - The fix moved to an **allowlist** of "narrow agent-tunable prompt/model settings" [S] https://osv.dev/vulnerability/GHSA-7jm2-g593-4qrc.
  - The agent may not rewrite `tools.exec.ask` or `tools.exec.security` [P] https://docs.openclaw.ai/help/faq/config-basics.
- **nanobot's `my` skill** can set only `model_preset` (preset ids) and `max_iterations`, and `allow_set=false` makes it read-only [P] https://raw.githubusercontent.com/HKUDS/nanobot/main/nanobot/skills/my/SKILL.md.
- **Letta:** memory blocks the agent self-edits, plus `read_only` blocks for policy [P] https://docs.letta.com/guides/agents/memory-blocks.
- **Claude Code:** subagents and output styles are files that Claude can write. The docs say to enforce with hooks, not instructions [P] https://code.claude.com/docs/en/sub-agents, https://code.claude.com/docs/en/output-styles.

**Evaluating the proposed rule** (the model may change preferences and personas, never security settings; changes go through Telegram approval and the audit log; personas only narrow). **Verdict: sound, and it matches where OpenClaw ended up after its CVEs.** Make it concrete (est.):

1. **Two files.**
   - `security.json` holds the user allowlist, deny paths, approval policy, runner endpoints and executables, budgets, and secrets references. It lives outside every tool-reachable path, no tool writes it, and it is editable only in the authenticated UI or by hand.
   - `prefs.json` and `personas/*.json` hold everything else.
2. **Code-defined writable-path allowlist.** It lives in code, not config, and is validated by JSON Schema.
3. **Tools:** `get_settings` (redacted), `list_personas`, `propose_setting(path, value, reason)`, `propose_persona(draft)`, `switch_persona(id)`. There is no direct persisted `set_*`.
   - Each proposal → Telegram diff with Approve / Reject → append-only JSONL audit `{ts, persona, diff, approver, tg_message_id}`.
   - Pure-cosmetic prefs (tone, verbosity) may auto-apply with logging only, to limit approval fatigue.
4. **Narrow-only:** effective = security ∩ persona. Tool, MCP and path sets intersect, and budgets take the min.
   - A widening persona **fails validation** visibly; it is not silently clipped.
   - Treat runner and model choice as security unless picked from an admin-defined preset list, because "narrower" is undefined for them.
5. **Guard placement:** the approval/guard extension is always forced into the effective extension set *after* the persona merge. Pi Durable hooks only run in conversations that select their extension, and a guard left out of an explicit selection "runs without that guard" [P] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md and spec §12 (via notes-pi-durable.md).

### 7.3 Personas and specialists on the fly

**Pi Durable per-conversation config:**
- `configure()` keys: `model`, `thinkingLevel`, `extensions`, `tools`, `modelTools`, `instructions`, `cwd`, with `null` restoring the host default [P] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md.
- `createConversation()`, `fork()` and `root()` accept the same `agent` change [P] same URL.

**Mapping (est.):**
- A persona = `{instructions, model preset, tool allowlist, MCP server/tool allowlist, job-template ids, runner ids, memory scope key, budget}`.
- Switching = `conversation.configure(...)`, or a child conversation for a specialist subtask.

**Switching UX:**
- `/persona <name>` with an inline-keyboard picker.
- Or one persona per Telegram topic. `message_thread_id` exists "for supergroups and private chats" [P] https://core.telegram.org/bots/api. Map (chatId, threadId) → conversation + persona (est.).

**Model-drafted personas:** `propose_persona` → a rendered diff (prompt, tools, MCP, runner, budget) → Approve / Edit / Reject → write the file and an audit entry (est.).

**Passing personas to Claude Code jobs:** Claude Code subagents take frontmatter `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `skills`, `maxTurns`, and a session-only `--agents` JSON [P] https://code.claude.com/docs/en/sub-agents.
- So a persona can be rendered into a per-job `--agents` definition.
- Whitelist `permissionMode` values: never `bypassPermissions` (est.).

**Prior art:**
- crewAI `role`/`goal`/`backstory`/`tools`/`allow_delegation` [P] https://docs.crewai.com/en/concepts/agents.
- OpenClaw per-agent `tools.allow`/`deny` and an elevated gate that "can only narrow" the global one [P] https://docs.openclaw.ai/concepts/multi-agent.
- Letta shared memory blocks [P] https://docs.letta.com/guides/agents/memory-blocks.

## 8. Answers to the scout-driven questions

**(i) Call the hub's HTTP MCP servers directly, or hand productions to Claude Code?** Both, split by job size (est.).
- **Direct from the orchestrator** via `@earendil-works/pi-mcp` `StreamableHttpTransport` (§1.2). Use it for **single-shot, low-risk** jobs:
  - a TTS line (vibetts);
  - a quick chiptune loop (`compose_track` + `render_audio`);
  - one ComfyUI image;
  - status checks.
  - Expose these as a few curated macro tools; keep the rest deferred.
- **Whole productions go to Claude Code in `creative-hub`:** a song with lyrics, art and video; a visual novel; a book. Claude Code already has the skills (`make-video`, `make-visual-novel`), the CLAUDE.md rules and the budget script.
  - Multi-step chains are where the local model is weakest (§5.1).
  - It keeps one place for production logic.
- **Costs of going direct:** you re-implement the hub's guardrails (Flow budget, Scriptorium rule) in the orchestrator, and the local model sees raw tool outputs (injection surface).
- **Cost of Claude Code:** subscription usage plus the terms nuance in §3.2.

**(ii) Use the user's acp-proxy as an OpenAI-compatible endpoint?**
- **Yes, as a *model*, not as a job runner.** pi-ai can add it as an `openai-completions` provider (`http://127.0.0.1:7461/v1`, ids like `claude/sonnet`, `codex/...`) for:
  - a stronger planner or reviewer;
  - a fallback "brain" when the local model is unsure;
  - Codex/Antigravity image generation (via `/v1/mcp` `generate_image`).
  - Sources [P] (local `api-acp-proxy\README.md`, "Models and providers", "MCP server (for harnesses)").
- **It cannot run productions.** Sessions are stateless and text-only, with built-in tools off, permissions auto-"cancelled", `settingSources: []` (no CLAUDE.md, skills or `.mcp.json`), and a temp cwd [P] (same README, "Claude" safety notes).
- **Driving claude-agent-acp directly with the ACP SDK gives:**
  - `session/update` progress (tool calls, plan, usage) for Telegram;
  - `request_permission` mapped to buttons;
  - `cwd` = creative hub, so the skills and MCP load;
  - `session/resume` after a crash;
  - `session/cancel`.
- **Practical shortcut (est.):** reuse the proxy's ACP plumbing (spawning codex-acp/claude-agent-acp on Windows, auth states, OAuth-lock retry, process-tree kill) in agent-007's runner module, but with tools and permissions turned **on** and routed to Telegram.
  - The proxy pins claude-agent-acp 0.91.0 and SDK ^1.4.0, while npm is at 0.97.0 / 2.0.2 [P] (local package.json; npm registry).

**(iii) Flow budget guards:** see §6, "Flow credits and budget guards".

## 9. Feasibility summary

| Capability | Supported today? | How | Effort estimate (est.) | Main risk |
|---|---|---|---|---|
| MCP tools in Pi Durable | Partly: client package plus deferred/tool-search built in; no MCP extension | `@earendil-works/pi-mcp` + `defineTool` wrappers + `createToolSearchExtension()` | 150-300 LOC, 0.5-1 day | Tool overload for a 30B model; credit-spending calls replayed (keep `replay:"unsafe"`) |
| Direct hub MCP calls (simple jobs) | Yes | Streamable HTTP to 127.0.0.1 servers; 5-8 curated macro tools | +100-200 LOC | Unauthenticated localhost servers; raw outputs as injection |
| Claude Code jobs via `claude -p` | Yes | stream-json, `--resume`, `dontAsk` + scoped allowedTools, cwd = creative-hub | 150-250 LOC, 1 day | No clean turn-cancel on Windows; no mid-run approvals without a permission-prompt tool |
| Claude Code jobs via ACP (claude-agent-acp) | Yes (Windows shown by the user's proxy) | `@agentclientprotocol/sdk` client; `session/update` → Telegram; `request_permission` → buttons | 400-700 LOC, 2-4 days (shared with `dsh`) | Adapter churn (0.91 → 0.97 in weeks); SDK 1.x → 2.x |
| Claude Code via Agent SDK | Yes | `query()` with `cwd`, `canUseTool`, `resume`, `interrupt()` | 250-400 LOC | Terms: SDK + subscription OAuth is gray; API key is clean |
| DeepSeek runner | Yes (preview) | `dsh --profile acp` (same ACP client) or `--profile headless --json` | 0.5-1 day on top of the ACP client | Nightly developer-preview breaking changes |
| acp-proxy as a model endpoint | Yes | pi-ai `openai-completions` provider at `:7461/v1` | ~50 LOC config | Text-only, cannot run productions; subscription-terms risk the proxy README itself flags |
| Telegram progress and approvals | Yes | edit-in-place status message; inline buttons with server-side ids; `answerCallbackQuery` | 300-450 LOC (bridge) + 120-200 (approval) | Approval fatigue; stale approvals after restart |
| Durable job queue / task tree | Yes (primitives) | Pi Durable `defineTask` phases, `waitForTask`, `resume()` | 200-400 LOC | Pi Durable API churn (pin 1.4.0); Windows harness untested upstream |
| Local Qwen as dispatcher | Partly | ≤10 direct tools, typed templates, routing eval | 1-2 days + eval set | Multi-step tool reliability (MCPMark 37, Pass^3 50) |
| Flow credit guard | Not built in | `beforeTool` / `PreToolUse` check of `max_credits` against `BudgetDoc`; approval above a threshold | 100-150 LOC | Unknown flow-music-mcp schema; out-of-band calls bypass the guard |
| Settings UI | No turnkey for Pi Durable | localhost server + token + Host/Origin checks + CSRF; Telegram keyboards | 400-700 LOC | DNS rebinding or CSRF reaching a control plane that launches Claude Code |
| Model-editable settings | Pattern exists elsewhere | `propose_setting` / `propose_persona`, code allowlist, `security.json` not tool-reachable, audit JSONL | 250-400 LOC | Denylist drift (OpenClaw CVEs): use an allowlist |
| Personas / specialists | Yes (primitives) | persona JSON → `configure()` / child conversation; `/persona` or topics; render to Claude `--agents` | 200-350 LOC | A persona deselecting the guard extension; prompt text steering within its permissions |
| Run jobs under another Windows user | Yes | dedicated user with its own `claude auth login` or `CLAUDE_CODE_OAUTH_TOKEN` | hours (setup) | Token rotation; no native-Windows sandbox |

## 10. Recommended architecture

**One Node process** (Pi Durable 1.4.0 pinned, SQLite, single-owner lock, Task Scheduler) runs as a dedicated low-privilege Windows user. It hosts four things:
- the Telegram bridge;
- an authenticated 127.0.0.1 settings UI;
- an **orchestrator conversation**;
- a **runner module**.

**The orchestrator conversation** runs the local Qwen on LM Studio/Strata through pi-ai. Its direct tools are about ten: `dispatch_job`, `job_status`, `cancel_job`, `ask_user`, `list_templates`, `propose_setting`, `propose_persona`, and a handful of curated creative-hub MCP macros via `@earendil-works/pi-mcp`. Everything else is `deferred` behind `tool_search`.

**The local model only routes:**
- it answers small things itself;
- it calls a macro tool for single-shot media;
- for anything multi-step it picks a **job template** and fills typed params.

**`dispatch_job` creates a durable `Job` task** whose phases start a runner, stream progress to a Telegram status message, map permission requests to inline buttons, collect artifacts and report back.

**The runner module is one ACP client** (`@agentclientprotocol/sdk`), reusing plumbing from the user's own api-acp-proxy:
- it spawns `claude-agent-acp` with `cwd = creative-hub` for productions;
- or `dsh --profile acp` for DeepSeek;
- with `claude -p --output-format stream-json` as the fallback.

**Each template fixes** runner, cwd, permission mode (`default` with Telegram approval, or `dontAsk` with scoped allow rules; never `bypassPermissions` or `auto`), denied tools (Bash, Flow unless enabled, Scriptorium start), budget and timeout.

**Security policy** lives in a `security.json` no tool can write. Personas and prefs are model-proposable, but every change needs a Telegram approval and an audit log entry, and personas can only narrow permissions. The guard extension is force-installed after every persona merge.

**The user's acp-proxy is optional:** a second-opinion *model* endpoint, not a runner.

**Before building:**
- run a 30-50 prompt routing eval of the local model through pi-ai;
- confirm the flow-music-mcp schema (`max_credits`);
- add a token and Origin check to the hub's HTTP MCP servers.
