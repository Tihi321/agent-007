# Multi-bot research (agent-007)

Date: 2026-10-29. Read-only research; nothing installed or started. Tags: **[V]** read in a primary source (URL or local file:line); **[S]** secondary source; **[U]** UNVERIFIED (inference). WebFetch summarises pages with a small model, so treat single quotes as near-verbatim. The user is "they". New decision **D12**: bots may use the ACP proxy as brain (Codex, Claude, Antigravity through subscriptions) and local models (Strata `127.0.0.1:8080`, LM Studio `127.0.0.1:1234`) stay switchable per bot.

Plan references: `plan.md` (pi-durable-mvp) D3/D8 (:198,:203), I13 (:224), I16 (:227), I18 (:229), I22-I27, I29 (:240), section 4.2 ACL table (:346-365), S9.3 IPC (:1451-1455), S17-S19 (:1608-1648).

## 1. Telegram

| Question | Answer | Source |
|---|---|---|
| Can a bot receive another bot's messages? | **Default no.** The FAQ still says bots do not see other bots' messages in any privacy mode. **Since Bot API 10.0 (2026-05-08) it is opt-in:** turn on *Bot-to-Bot Communication Mode* for the bot in @BotFather. In groups, a bot with the mode on sees another bot's messages when it is mentioned (`/cmd@Bot`), replied to, or (if it is a group admin or has privacy mode off) all of them. In private chats a bot can `sendMessage` to another bot's `@username` if **both** have the mode on. | [V] https://core.telegram.org/bots/features ("Bot-to-Bot Communication"); changelog https://core.telegram.org/bots/api-changelog (10.0: "send messages to other bots via username if both bots enabled bot-to-bot communication", "see certain messages sent by other bots in groups"); FAQ https://core.telegram.org/bots/faq (older "will not see messages from other bots") |
| Loops | Telegram itself warns the feature "can easily result in infinite interaction loops" and recommends dedup, a reply rate limit (about one reply every few seconds per bot), a max interaction depth or timeout, per sender and per receiver. Unhandled loops can bring "platform restrictions". | [V] https://core.telegram.org/bots/features |
| Managed bots | 9.6 (2026-04-03): a bot with *Bot Management Mode* can create and manage other bots for owners (`getManagedBotToken`, `replaceManagedBotToken`, `https://t.me/newbot/<manager>/<new>` links). 10.0 adds `BotAccessSettings`, `get/setManagedBotAccessSettings`. Not needed here: the user creates each bot in BotFather. Auto-creating bots would hand the agent tokens, which the plan forbids (UI-3). | [V] changelog + features page above |
| Business bots | Business bots may reply to other bots if the mode is on (10.0). Irrelevant to us. | [V] changelog |
| Other new features that matter | 10.2/10.3 "Ephemeral messages" (group messages only one chosen user and the bot see); Guest Mode (a bot answers one mention in a chat it is not in). Not needed. | [V] changelog |
| Rate limits | Per chat about 1 message/s (bursts then 429); **group: no more than 20 messages/minute** (the FAQ words it for "a group", whether per bot or per group is [U]); bulk about 30 messages/s; paid broadcasts need 100k Stars and 100k MAU (irrelevant). Flood limits in the test environment may be stricter. 10.x added no new limit figures. | [V] https://core.telegram.org/bots/faq (the features page has no figures) |
| Several tokens in one process | Each token has its own `getUpdates` stream; one process can run one grammY `Bot` per token, each with `bot.start()`. The only hard rule is **one poller per token** (a second poller gets a 409). Hermes enforces the same: a second gateway on the same token is refused. Not shown in grammY docs by name [U]; aiogram documents the one-poller-per-token rule. | [S] https://hermes-agent.nousresearch.com/docs/user-guide/profiles ; aiogram long-polling docs; grammY multi-token [U] |

Consequences for the design:
- **Do not use Telegram as the bot-to-bot transport.** It adds loops, rate limits, `/setjoingroups` exposure (plan UI-3 sets it to Disable) and a prompt-injection channel from any bot in a shared group. Keep Bot-to-Bot Communication Mode **off** for every bot. The plan's numeric user-id allowlist (D6) already drops any `from.id` that is not the user, so a bot's message in a shared room is never processed.
- A "bot room" is a **mirror only** (section 5.7).

## 2. Pi Durable 1.4.0

Source: README https://github.com/earendil-works/pi/blob/main/packages/durable/README.md and the earlier deep-dive `notes-pi-durable.md` (section 2, :47-118).

| Question | Answer |
|---|---|
| Several agents in one process? | **Yes, two ways.** (a) One `Harness` (opened on one storage) hosts many **conversations**; each has its own agent settings, stored in its `pi.agent` doc. (b) Several `Harness.open(storage, ...)` instances in one process, one per storage. (b) is not shown in the README [U]; nothing forbids it, but the README says one process must own a storage, and Windows is untested upstream (`notes-pi-durable.md:192`). |
| Per-agent model, tools, prompt | `conversation.configure({ model: {provider, modelId}, thinkingLevel, extensions, tools, modelTools, instructions, cwd, maxTurns })`; `null` restores the host default; accepted at `root()`, `createConversation()` and `fork()` too. The `Harness` holds `models` (a pi-ai `Models` registry), `registry`, `settings`, `env`. |
| Memory / storage paths | The **storage opener** sets the path (`openNodeSqliteStorage(path)`); the `Harness` does not. `env` gets conversation id and `cwd`, so a per-conversation environment is possible. For hard separation use one storage (one `agent.sqlite`) per bot. Conversations in one storage share one database. |
| Model per agent, runtime switch | Yes: `configure({ model })` applies from the next model request. Provider and model must exist in the `models` registry (our local runners and the ACP proxy are `openai-completions` providers via `createProvider`, notes-pi-durable.md:122-146). Interrupted requests are re-sent with the **same pinned model** (spec 8.3), so a switch does not rewrite an in-flight request. Compaction can use per-model overrides (`settings.compaction.modelOverrides`). |
| Sub-agent, agent-to-agent, handoff | **Nothing built in.** README pattern: a tool calls `api.commit()` with `ownership: {kind:"task", taskId}` to create a child conversation and drives it with `api.conversation(id)` (examples `21-subagent-foreground`, `22-subagent-background`, `27-reviewer`). `fork()` branches a transcript. `reset(note)` / `control.handoff` resets context, it does not move work to another agent. Community packages exist (`pi-durable-subagents` per piindex, [S]). So bot-to-bot messaging must be our own tool. |
| Natural shape | **One Harness plus SQLite per bot, one process owns them all (or one process per bot).** Not "one Harness, one conversation per bot": that shares a storage and a registry, so no memory separation. See "Recommended architecture". |

## 3. Hermes Agent and Grok (design reference only)

| | How it does "multiple bots" | Take-away |
|---|---|---|
| **Hermes Agent** (Nous Research) | **Profiles**: each profile is a separate `HERMES_HOME` directory with its own `config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron jobs and state DB. A different bot token per profile `.env`; one gateway per profile (`<profile> gateway start`); a second gateway on the same token is refused. Profiles are **not sandboxes** (same OS account, same filesystem rights). No direct profile-to-profile messaging is described; no shared memory by default (`--clone` copies MEMORY.md and USER.md once; external memory providers such as Honcho can share). `delegate_task` spawns a throwaway **child** with a fresh context, default depth 1, up to 10 in parallel; children cannot use `memory`, `send_message`, `clarify` or `cronjob`. | A bot = a directory + a token + a gateway. Delegation to a fresh, restricted child is the safe form of agent-to-agent. [V] https://hermes-agent.nousresearch.com/docs/user-guide/profiles , .../features/delegation |
| **Grok / xAI** | The API has **Grok 4.20 Multi-Agent** (beta Feb 2026, API 2026-03-31): several model-side agents (4 at low/medium effort, 16 at high) cooperate **inside one request** with web search, X search and tool orchestration; it is a reasoning mode, not separate bots. xAI's tools guide lists server-side tools and function calling; I found nothing about separate bots with their own memory or "companions" in xAI's docs. | Not a template for separate bots. [S] https://openrouter.ai/x-ai/grok-4.20-multi-agent ; xAI tools page https://docs.x.ai/docs/guides/tools/overview (no mention of multi-agent or companions); companions [U] |

## 4. ACP proxy as a bot brain

Source: `C:\projects\Personal\api-acp-proxy\README.md` and `src/`. All items [V] unless marked.

| Topic | Fact |
|---|---|
| Port / address | Code default is **8787** (`src/settings.ts:43`, README:67), host `127.0.0.1`. The plan's `7461` must be the user's configured port [U]; I did not read `settings.json` (it can hold a key). |
| Models | `GET /v1/models`; ids `<provider>/<id>` (`codex/...`, `claude/...`, `antigravity/...`); Codex ids are also bare. The list is discovered at runtime and depends on the plan, so it can change (README:73). The response has only `id`, `owned_by` (`server.ts:381`): no context window or max tokens, so each Pi `Model` entry must carry those by hand. An unknown id gives 404 `model_not_found`. |
| Concurrency | Cap **per provider**, default 4 (`PROXY_MAX_CONCURRENT`, per provider override `PROXY_<P>_MAX_CONCURRENT`); the rest wait in a **FIFO** (`src/limiter.ts`: strict order, no priority, no per-client fairness). Optional `PROXY_MAX_QUEUE` gives 429 `provider_queue_full`. `GET /healthz` shows `active/queued` per provider. Measured on this PC: Codex flat (about 2.1 s) up to 6 parallel; Antigravity 3.9 s alone, about 8 s at 4 to 6 (README:123). |
| Timeouts | `PROXY_TIMEOUT_MS` 5 min **including queue wait** (504 `request_timeout`). Tool-result wait `PROXY_TOOL_RESULT_TIMEOUT_MS` 10 min, cut to the agent's limit minus 30 s: **150 s Antigravity, 270 s Codex**, none for Claude. |
| Session reuse | **Off by default** (`PROXY_REUSE_SESSIONS`); each request is a fresh ACP session, and a request with tools never gets a warm one. If on: at most 8 kept, idle 10 min. Suspended tool turns count against the same 8. |
| Tool round trips | OpenAI function calling works for all three providers (README:201). Tools become an MCP server `client`; a tool call **ends the HTTP response** with `tool_calls` and the turn stays suspended until the next request brings the result. **Codex and Antigravity call one tool at a time** (each round trip is its own response); only Claude can call several. If the suspended turn is gone (restart, expiry, edited history) the proxy replays the whole history as text in a fresh session ("clients never break; they only lose the fast path"). **Consequence:** Pi's `beforeTool` Telegram approval happens while the turn is suspended; an approval that takes longer than about 150 s (Antigravity) or 270 s (Codex) cancels the held turn and the next request takes the slower text-replay path. Works, but costs latency and tokens. The plan's approval timeout default is 10 min (I12). |
| Other limits | Sampling params (`temperature`, `top_p`, penalties, `seed`) are a 400 unless `PROXY_IGNORE_SAMPLING=1`; `store: true`, `previous_response_id` rejected on Responses. Whether pi-ai's `openai-completions` sends any of them with `compat` flags needs a smoke test [U]. Function tools cannot be combined with image generation. `tool_choice: required` is best effort. Web search through Claude costs about 16 s vs 3 s (README:224). |
| Errors to route on | 503 `provider_auth_required` (Codex, Claude) or `auth_required` (Antigravity) = needs login; 503 `provider_busy` + `Retry-After: 30` (Claude OAuth refresh lock, shared with every other Claude Code process, plan I18); 429 `provider_queue_full`; 504 `request_timeout`; 404 `model_not_found`; 400 `model_not_capable`/`unsupported_parameter`. |
| Auth | `PROXY_API_KEY` / `server.apiKey`: one bearer for **all** `/v1/*` routes, compared with `timingSafeEqual` (`server.ts:56-61`). `/healthz` and `/playground` need no key. Stored encrypted with Electron `safeStorage`, so the main user must copy the value into the agent's `secrets.json`. **One key for every client: no per-bot key, no per-bot attribution or revocation**, and the activity log keeps only metadata. |
| Terms / risk | README: **Claude** "may conflict with Anthropic's consumer terms"; use at own risk or prefer an API key (README:154). **Antigravity**: Google's terms (clause 6) restrict powering other products and name third-party token replay as grounds for suspension; account-suspension reports in early 2026; use preferably not with an account you cannot lose (README:170). **Codex**: no risk section; OpenAI terms not checked [U]. Outside check [S]: Anthropic stated in Feb 2026 that Free/Pro/Max OAuth tokens are only for Claude Code and Claude.ai and that third-party use, including the Agent SDK, violates the consumer terms, with server-side blocks reported since Jan to Apr 2026; a later Agent SDK credit change is reported second-hand and unconfirmed (https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use ; https://github.com/NousResearch/hermes-agent/issues/25267). **Treat Claude-through-proxy as the highest-risk route and default it off; make it a separate explicit user opt-in.** |
| Safe to share between bots? | **Functionally yes**: requests are stateless and isolated (fresh session, empty temp dir, built-in tools removed, read-only, permissions answered "cancelled", README:233); a queue handles bursts. **Not safe from starvation**: strict FIFO with cap 4 means one chatty bot delays all others, and the creative-hub apps share the same proxy (README:115). Subscription **quota** (the real limit for 24/7 bots) is not tracked by the proxy [U]. Mitigate on our side: per-bot concurrency 1, a global bot-side limiter, and the priority queue in section 7. |
| Security notes for a shared key | The key also opens `/v1/mcp` (no setting to turn it off found, grep of `src/` for a toggle) where **`images[].path` reads any PNG/JPEG on the main user's disk for loopback callers** (README:274), and chat/Responses `image_url`, `mcp.server_url` make the **proxy (main user) fetch URLs** (README:189,220). A compromised agent holding the key therefore reaches files and network as the main user. Accepted-risk entry, same class as I16/I22. Use only `/v1/chat/completions`; ask the proxy owner for a separate "chat-only" key or an MCP off switch [U]. |
| Reach from the agent Windows user | The proxy is an Electron tray app started by the **main user** (own `%APPDATA%\api-acp-proxy`, own logins in `~/.codex` or its own `codex-home`, `~/.claude`, `~/.gemini`). Loopback TCP is not per-user on Windows, so the agent user's Node reaches `http://127.0.0.1:<port>/v1` with `Authorization: Bearer <key>`; the key goes into the agent's `secrets.json` (ACL R, plan 4.2:353). Without a key any local process can spend the subscriptions, so require one. Cloud brains are **down while the main user is logged off** (like the job runner), so every cloud route needs a local fallback or an "offline" message. |

## 5. Bot bus design (on top of I16)

I16 is a per-message HMAC TCP bus between the agent and the job runner. Keep the **same framing and checks** (S9.3: `{v,id,ts,nonce,type,body,mac}`, +/-60 s, nonce cache, 1 MB cap, constant-time MAC, HTTP-shaped input rejected) but run the **bus router in the agent host**, not in the job runner (which is the privileged main-user component). Start with an in-process `BotBus` interface (no sockets) and add the TCP/HMAC implementation only if bots are split into separate processes.

**5.1 Tools (deferred behind `tool_search`, so `ALWAYS_LOADED` stays at 10, I27):**
- `list_bots {}` returns `[{id, description, caps summary}]` for the bots this bot is **allowed** to ask (edges in `security.json`).
- `ask_bot { to: string, message: string, wait?: boolean = true, timeout_s?: number <= 120, attach_refs?: string[] }` returns `{ reply, from, chain_id, hop, budget_left }` or a typed error (`edge_denied`, `hop_limit`, `budget_exhausted`, `loop_detected`, `busy`, `timeout`). `attach_refs` are workspace file refs the receiver may read, never raw paths from the sender's side.
- No `approve_for` / `relay_approval` tool exists.

**5.2 Envelope and sender tagging.** The router stamps `from` from the **authenticated channel** (per-bot key or in-process identity), never from the body; `chain_id`, `hop`, `path[]` (bot ids visited), `origin` (`user | schedule | peer`), `taint` (bool). A per-bot HMAC key (not one shared key) so a compromised bot cannot forge another sender.

**5.3 Untrusted input handling.** The receiver's runtime wraps the message as a data block in a **user-role** turn, for example `<peer_message from="research" hop="1" taint="true">...</peer_message>`, never in the system prompt, and the receiver's instructions say a peer message is a request from a peer, not the user, and carries no authority. Escape or strip the closing tag in the body. Reply text coming back is wrapped the same way (the shell-capable bot's output is also data for the asker).

**5.4 Hop limit, budget, loops.**
- Hop limit 2 (user -> A -> B -> C; C cannot ask). No revisits: asking a bot already in `path[]` is rejected.
- Per **chain** (root user message) budget: at most 6 bus messages, at most 5 minutes, a token cap, and a credit cap for cloud routes; the router returns `budget_exhausted` to the asker, which must then answer the user.
- Per **edge** limits: one in-flight ask per (from,to), at least 5 s between asks, 30 asks/day, and a circuit breaker that pauses the edge and tells the user after 10 asks in 10 minutes.
- **Loop detection:** SHA-256 of `(from,to,normalised body)`; the second identical message in a chain, or ping-pong A-B-A-B within a chain, is blocked and counted; Telegram's own advice (dedup, depth, rate) maps one-to-one onto this.
- Peer-initiated turns cannot schedule timers or call `ask_bot` with `wait=false`, so nothing keeps looping unattended.

**5.5 No approval relaying.** An approval card is always produced by the bot that executes the tool, in its own Telegram chat with the user, and shows the **provenance** ("requested via bot research, hop 1" plus the quoted peer text). A bot can never answer, pre-answer or auto-approve another bot's card; approvals are not part of any bus message type. Telegram callback data is checked against the user id as today (S4).

**5.6 Prompt-injection spread (web-reading cloud bot asks a shell-capable bot).**
Proposed **capability rule (monotone narrowing):**
1. **Authority comes only from the user.** A user message typed into bot B's own chat starts a chain with `origin=user` and B's full effective capabilities.
2. A **peer-triggered turn** runs with `caps = caps(receiver) ∩ caps(every bot in path[]) ∩ edge.allow`, and additionally **without** `shell`, `write_file`, `dispatch_job`, writes to shared locations and any cloud-egress read of private folders, unless the edge is explicitly marked `elevated` in `security.json` (UI only).
3. **Taint:** `taint=true` if any bot in the chain used a content-ingesting tool (web search, MCP reading, fetched pages, email) or the original input came from such content. In a tainted turn **no approval-gated tool exists at all** (an approval card is itself a social-engineering target). The receiver replies with data only.
4. To do the shell work, the user sends their own message to the shell-capable bot (rule 1 gives it a fresh root). The web bot may suggest this ("ask ops to run X") but cannot cause it.
5. **Egress rule:** a bot whose route is a cloud preset gets a narrower read allowlist by default (private folders off); a bot's `readRoots` never exceed what its brain's privacy class allows (cloud presets send tool output to OpenAI, Google or Anthropic).
All of this is enforced in the router and the guard extension (forced after `configure()`, U43 and footgun 30), not in prompts. It also fits plan S19.1 ("effective permissions = security ∩ persona").

**5.7 Mirror to a Telegram "bot room".** One extra **write-only mirror bot** (its own token, no `getUpdates` loop, no commands) posts `[research -> ops, hop 1, chain 7f3] text...` into a private group or channel the user created. Individual bots never join any group (keeps `/setjoingroups` Disable, UI-3), Bot-to-Bot Communication Mode stays off, and incoming updates from bots are dropped. Batch lines and cap to about 15 messages/minute to stay under the 20 per minute group limit. Mirror failures never block the bus. Channel vs group is the user's choice; adding a bot to a channel with `/setjoingroups` disabled is [U]. Mirrored text is redacted like logs (no secrets, truncated).

**5.8 Audit.** Every bus message is appended to the existing append-only audit style (I29, U48): a bus audit JSONL with `chain_id`, from, to, hop, hash of body, decision (delivered, denied, reason). Bodies are kept only in the bots' own transcripts.

## 6. Memory separation per bot

Layout (proposed; plan 4.2 `%LOCALAPPDATA%\agent-007\` becomes per bot):

| Path | Content | Access |
|---|---|---|
| `%LOCALAPPDATA%\agent-007\bots\<botId>\state\agent.sqlite*` | That bot's Pi storage (its own `Harness`) | that bot's runtime only |
| `...\bots\<botId>\memory\MEMORY.md`, `USER.md` copy (optional) | Per-bot memory via `remember` (announced in chat, D7) | own read/write |
| `...\bots\<botId>\skills\` | Per-bot skills | own read, write only through `propose_*` |
| `...\bots\<botId>\workspace\`, `logs\` | Files and logs | own |
| `C:\ProgramData\agent-007\shared\FACTS.md`, `shared\skills\` | **Shared read-only facts and skills, written only by the user or an admin** (agent user R, no W; same ACL pattern as `config\`) | all bots with `shared.read: true`; loaded into the prompt like `USER.md`; no bot tool can write |
| `security.json` `bots.<id>` | token ref, preset route, allowed edges, read roots, caps | UI only (I25) |
| `secrets.json` `bots.<id>.telegramBotToken` | One token per bot | each runtime gets only its own |

Rules:
- The bot's tools resolve every path under its own `bots\<botId>\` plus its allowlisted roots; **in-process denies** for `bots\*` siblings, `secrets`, `settings`, other bots' sqlite (extend the S1.2 built-in denies). Add a path-policy test: bot A cannot read, list or search bot B's directory.
- **Honest limit:** all bots run as the same Windows user, so NTFS cannot separate them (same situation as the Strata files, plan :372). An approved shell command can read sibling dirs. Mitigation, in order: shell on at most one bot; that bot optionally runs under its **own** Windows user (`agent007-ops`) with its own profile dir and ACL, which is real separation; otherwise accept the residual risk (section 9 style entry).
- Cross-bot memory is **never read directly**; a bot that wants another's knowledge uses `ask_bot`. Shared writes are impossible by construction (only the user writes `FACTS.md`).
- Personas (S19) vs bots: a persona is a mode of one bot (one conversation and storage, `MEMORY.<scope>.md`, S19.4); a bot is its own token, storage, memory, route. Reuse the persona JSON schema and validator for the bot's prompt, tool and MCP allowlists; add `botId`, `telegramTokenRef`, `route`, `edges` on top.

## 7. Local GPU contention

Facts: Strata serves **one sequence at a time behind a FIFO** and holds about 84 GB of the 96 GiB pool (plan :19-22, :294, :596); LM Studio runs gemma-4-E4B (5.9 GB, context 131072, parallel 2; `system-inventory.md:31,69`). Whether both fit together alongside KV cache is open (plan U24/U25) [U].

Proposal: one **local-inference gate** in the agent host in front of each local runner (not per bot):
- **Priority classes (non-preemptive, aged):** P0 = the user's own message in a bot chat (interactive); P1 = turns in a chain started by the user (peer asks); P2 = peer-initiated or scheduled background turns; P3 = summaries, compaction, mirror digests. Aging prevents starvation. In-flight generation is not killed, except when the user sends `/stop` (abort).
- **Request granularity:** the gate sees each model call, not each conversation turn, so tool loops from two bots interleave. Prefer **stickiness** (finish the current bot's tool loop within a short window) because a different system prompt breaks any prompt prefix reuse and forces a full re-prefill [U: Strata's cache behaviour not checked; measure].
- Per bot concurrency 1; gate queue depth capped (reject P2/P3 beyond N, tell the asker `busy`).
- **User-facing latency:** if the queue wait is over about 10 s, the bot sends one "waiting for the model (2 ahead)" status and keeps the typing indicator; plan :405 already requires the stream timeout to cover a queued wait. A queued wait is not an outage (plan :796, :975).
- **Topology advice:** give the **interactive, user-facing bots a cloud route** (proxy) or the small LM Studio model (parallel 2), and let background or low-urgency bots use Strata. Strata should serve at most one or two bots in practice; with three or more local bots the p95 latency is the sum of everyone's generation times.

## 8. Model switching by design

**Where it lives.** Presets are a **security setting** in `security.json` (S17.1 already lists "model presets"; S19.1 says a persona's `modelPreset` must be one of them):

```
presets: { id, kind: "acp" | "local", baseUrl, modelId, providerId?: codex|claude|antigravity,
           apiKeyRef?, contextWindow, maxTokens, privacy: "cloud" | "local",
           autoFallback: boolean }          // default false for cloud
bots.<id>.route: { primary: presetId, allowed: [presetIds], fallback: [presetIds], onAuthRequired: "fallback" | "ask" | "fail" }
```
`bots.<id>.activePreset` (which of `allowed` is in use) is a **prefs-level** value in the bot's own profile. Pi side: one `createProvider` per runner (`acp` -> `openai-completions` at `http://127.0.0.1:<port>/v1`, `strata`, `lmstudio`), each preset a `Model` entry; switching = `conversation.configure({model})` for new requests. ACP model ids are checked against `GET /v1/models` at start and on a switch, not hard-coded (ids change with the plan).

**How it is switched.**
| Surface | Allowed change |
|---|---|
| Settings UI (job runner, I25) | Define or edit presets, routes, fallbacks, edges (security) |
| Telegram `/model` (per bot, inline picker) | Pick `activePreset` from the bot's `allowed`. **Same or narrower privacy class applies at once (audited); cloud -> from local = broader egress, so one approval card**, like `switch_persona` (S17.3) |
| `propose_setting {path: "bots.<id>.activePreset"}` | Same rule as `/model`; any `presets`, `route`, `fallback` path is rejected before any card (security path) |

**Fallback rules (never silently to a paid API key):**
| Failure | Action |
|---|---|
| 503 `provider_auth_required` / `auth_required` | No retry. Mark the preset "needs login" in `/status`, tell the user **once** ("Codex needs login; bot X is now on Strata" or "bot X is paused"), audit it. Fall back only to a preset in `route.fallback` with `autoFallback: true`; default is **local** only. |
| 503 `provider_busy` (Retry-After) | Wait and retry up to twice, then fallback as above. |
| 429 `provider_queue_full`, 504 `request_timeout` | One backoff retry, then fallback, or tell the user if the preset has no fallback. |
| 404 `model_not_found` | Refresh `/v1/models`; do **not** substitute another model on the same provider; fallback or ask. |
| Proxy down or main user logged off (connection refused) | Same as auth required. |
| 400 class errors | No fallback; a bug. |
| Any `kind: "api-key"` or per-token-billed preset | **Not allowed in `fallback` unless the user set `autoFallback: true` on that preset in the UI**; otherwise manual `/model` only with an approval card showing the cost class. The plan's rule (no cloud API key for the agent's model) stays the default. |
| Cloud -> cloud (different vendor) | Counts as new egress: needs `autoFallback: true` too. |
A switch in the middle of a conversation keeps the transcript; context windows differ, so set per-preset compaction thresholds (`settings.compaction.modelOverrides`); tool-call history written by one provider replayed to another is handled by pi-ai [U, test it].

**Plan impact:** D3 ("no cloud for the agent's own model") and I23/UI-15 (acp second opinion off) are superseded by D12 for bots that opt in; record that as a revised decision. Cloud-brained bots send tool output (file contents, command output) to the vendor, so the egress rule in 5.6 applies.

## Recommended architecture

1. **One bot = one directory + one Telegram token + one Pi `Harness`/SQLite + one route + one persona-style config.** Bots run in the **same agent host process** (one grammY `Bot` per token, each `bot.start()`; a `BotManager` owns them) for the first version; a split into one process per bot (or one extra Windows user for the shell bot) stays possible because the bus is an interface (`BotBus`) with an in-process and an HMAC-TCP implementation.
2. **Brain per bot via preset routes** in `security.json` (UI only), `activePreset` in prefs; ACP proxy via `127.0.0.1:<port>/v1/chat/completions` with the key in `secrets.json`; Strata and LM Studio the same shape. Auth failures fall back to local or tell the user, never to an API key.
3. **Bot bus in the agent host:** `ask_bot` / `list_bots` as deferred tools, router-stamped sender, hop limit 2, per-chain and per-edge budgets, loop detection, peer messages as untrusted data, **monotone-narrowing capability rule**, no approval relaying, taint blocks approval-gated tools, bus audit log. Telegram is a one-way **mirror bot**, not a transport.
4. **Memory:** per-bot dirs plus in-process denies; shared read-only `FACTS.md` and skills written only by the user; shell on at most one bot (own Windows user if the user wants real isolation).
5. **Local GPU:** a priority gate per runner (user turns first), cloud or small-model routes for interactive bots, Strata for background bots.
6. **Proxy fairness:** per-bot concurrency 1, global cap below the proxy's 4 per provider; Claude-through-proxy off by default.

## Open user decisions

1. Which bots first (names, roles) and which brain each (Codex, Antigravity, Claude, Strata, LM Studio).
2. **Claude and Antigravity subscriptions through the proxy**: accept the terms risk (Anthropic and Google both restrict third-party use of subscription logins), or Codex only? Default proposed: Claude off.
3. Cloud-brained bots and **private folders**: may a cloud bot read private allowlist folders (data goes to the vendor), or only a separate "cloud-safe" folder set?
4. Fallback policy per bot: local only, ask, or pause; is any paid API key allowed as a fallback (default no)?
5. Bot room: private group with the mirror bot, or a channel, or none; how much text to mirror?
6. Which bot (if any) gets `shell`, and whether it runs under its own Windows user.
7. Edges: which bots may ask which (default none); elevated edges (peer-triggered shell) allowed at all (default no).
8. Hop limit and budgets (proposed 2 hops, 6 messages, 5 minutes per chain).
9. Proxy hardening: set `PROXY_API_KEY`, ask for a chat-only key or an MCP off switch in the proxy; confirm the actual proxy port (8787 default vs 7461 in the plan).
10. One process (v1) vs one process per bot; and the number of local-brained bots allowed on Strata at once.
11. Whether the plan's D3/D8/I23/UI-15 are formally revised by D12 (needed before building).
