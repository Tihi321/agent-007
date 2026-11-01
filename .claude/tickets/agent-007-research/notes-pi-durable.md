# Pi Durable deep-dive (agent-007)

Research only. Nothing installed, cloned or run, and LM Studio was not touched. Date: 2026-10-26. This file builds on `notes-pi.md` and `research.md` and does not repeat them.

All sources were read through WebFetch, which summarises pages with a small model. Identifiers below were asked for "exactly", and most were cross-checked across two or more files, but treat any single quote as near-verbatim. Tags: **[V]** read in primary source or docs; **[S]** secondary source or search snippet; **[U]** my inference or estimate, not verified.

Short names used below, each with its URL:
- **README** = https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- **spec** = https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md. Section anchors such as `#72-hooks` are derived from the spec's headings by GitHub's anchor rules; I did not click them.
- **CHANGELOG** = https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/CHANGELOG.md
- **types.ts** = https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts

## Verdict first

**Yes, with caveats. Build on Pi Durable rather than on plain Pi SDK, if you are going to own TypeScript code at all.** nanobot (research.md) is still the least-effort path, and nothing here changes that ranking for "least code". Among the Pi options, though, Pi Durable already ships the three primitives this agent needs and the Pi SDK lacks:
- a `beforeTool` hook with durable `api.memo` for an approval gate;
- durable sleeping tasks (`runtime.sleepUntil`) for a scheduler;
- crash-resume of turns and pending deliveries.

This reverses REQ-0001's "Pi Durable later" advice. The reasons are in section 7: Telegram bots on Pi Durable already exist, LM Studio can be configured in code, and the needed primitives are built in.

It also uses Node's built-in `node:sqlite`, so there is no native module to compile on Windows. "Start on Pi SDK and migrate later" means writing the session layer twice; sumire's migration archived all old transcripts. The caveats: pin exact versions, keep Pi Durable behind one adapter module, no bash or CodingTools, and do a Windows smoke test first. Details are in section 7.

---

## 1. Who builds on Pi Durable

Adoption is **early but real** for a package released 2026-10-01: most projects are under 4 weeks old, and several have 0-40 stars. Three projects already combine Telegram with Pi Durable: pi-durable-telegram and sumire are Telegram-first, and mikan is multi-channel. None of them documents Windows or LM Studio support.

| Project | What it does | Chat front end | Local model | Activity / pinning |
|---|---|---|---|---|
| **smixs/pi-durable-telegram** [V] https://github.com/smixs/pi-durable-telegram | Always-on agent "that lives on your server and answers you in Telegram". One durable conversation per allowed private chat. Streaming drafts with a stop button, queueing while busy, `/new /stop /compact /status`, media in, files out. Plugins (`search`, `mcp`, `skills`, `helpers`, `reminders`) are off by default. | Telegram (grammY 1.46.0, long polling), allowlist `TELEGRAM_ALLOWED_USER_IDS` [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/docs/configuration.md | **No.** Providers are resolved by name from pi-ai's built-in catalog only (`loadProvider`); no baseUrl or models.json path [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/agent/models.ts | 37 stars, 113 commits, v0.1.8 on 2026-10-24 [V] https://api.github.com/repos/smixs/pi-durable-telegram/commits?per_page=5. Pins **pi-durable 1.2.0** (current is 1.4.0) [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/package.json. Linux + systemd only; no approval flow; the agent "can do anything your user can". Forks: jemyzhang [S] https://github.com/jemyzhang/pi-durable-telegram and dandreevv [S] https://github.com/dandreevv/pi-durable-telegram. |
| **narumiruna/sumire** PR #75 [V] https://github.com/narumiruna/sumire/pull/75 | Telegram AI bot moved its conversations onto Pi Durable. SQLite per chat (WAL, synchronous=NORMAL), single process owner, recovery of admitted work and pending delivery, 903 tests. Notes "Telegram delivery and local acknowledgement are not atomic", so duplicates are possible. | Telegram | Not stated | Merged 2026-10-06, pinned **1.0.2**. Repo has 0 stars and 505 commits; Docker Compose; Node 26 [V] https://github.com/narumiruna/sumire |
| **geminixiang/mikan** [V] https://github.com/geminixiang/mikan | Team agent for Slack, Telegram, Discord and GitHub; harness "built on pi-durable and pi-ai"; `event` tool for one-shot or recurring runs | Telegram and others | Not mentioned | 9 stars, 1,401 commits, pm2, Node 24.15+, needs Docker/Podman/nerdctl |
| **cosmyo/ha-pi-durable** (Hearth Pi) [V] https://github.com/cosmyo/ha-pi-durable | Home Assistant app; "human-reviewed light/switch actions". Tools *file proposals* (`ha_propose_service`, ...), and a human approves them in the UI. "Interrupted dispatch is unknown and never automatically retried." | Web UI | **Yes, but unreleased:** `local.ts` registers an `openai-completions` provider at `${url}/v1`, probes `/api/v0/models` to fingerprint LM Studio, and sets compat flags (see section 3) [V] https://raw.githubusercontent.com/cosmyo/ha-pi-durable/main/hearth_pi/src/local.ts | 10 stars, 104 commits, v0.8.2, "technical preview" |
| **disler/pi-durable-news-agent** [V] https://github.com/disler/pi-durable-news-agent | Proactive news agent: a cron tick every minute does an idempotent `POST /v1/workflows/news-sweep` and ranks stories. Two SQLite files (`agent.sqlite` for pi-durable, `dna.sqlite` for the app). | Vue web UI, pi-tui, CLI | No (OpenRouter required) | 130 stars, 41 forks, **1 commit**; launchd/systemd only |
| **finnvoor/PiDurableKit** [V] https://github.com/finnvoor/PiDurableKit | pi-durable on JavaScriptCore with a Swift API (iOS/macOS) | SwiftUI | Apple on-device FoundationModels and custom OpenAI/Anthropic-compatible providers | 288 stars, 38 commits |
| Others listed by piindex [S] https://piindex.dev/topics/pi-durable/ | pi-pocket (phone web UI, pins 1.0.2), oppi (iOS client), pi-imessage, pi-fabric, webfox, the Cloudflare Agents SDK `PiHarness` adapter, `@netzlabor/pi-durable-postgres` storage, rivet-dev, roamgate, pi-on-cf, antiproton, sift, pi-durable-subagents, pi-durabletask-mcp | various | none flagged as local | reviewed 2026-10-07 |
| **Earendil's own demos** [V] https://earendil.com/posts/pi-durable/ | Vacation planner TUI (~1,300 lines, `packages/coding-agent/src/experimental/vacation/main.ts`), small coding agent (`.../experimental/durable/main.ts`), 31 examples in `packages/durable/test/examples` [V] https://api.github.com/repos/earendil-works/pi/contents/packages/durable/test/examples | TUI | No | The post promises "a Slack bot or a GitHub triage bot" in coming weeks |

Community signal: the HN thread has 515 points and 77 comments [V] https://news.ycombinator.com/item?id=49925969. In it, rcarmo is "ripping out the guts of piclaw" to use Pi Durable, and saagarjha plans to replace a home-made equivalent. Mario Zechner (badlogic) says of the storage API: "Things are still not settled". No comment mentions Windows or local models. Blog write-ups exist [S]: https://stacktoheap.com/blog/2026/10/05/pi-durable/, https://blog.bokvi.com/blog/pi-durable-agent-harness/, https://www.mindstudio.ai/blog/pi-durable-long-running-agents.

Not checked: npm dependents (npmjs returned 403), X/Twitter, and GitHub code search (needs auth).

**Takeaway:** Telegram + Pi Durable has been built at least three times (pi-durable-telegram, sumire, mikan). Nobody has published Pi Durable + LM Studio + Windows + Telegram. The closest pieces are pi-durable-telegram for the bot shape and Hearth Pi's `local.ts` for LM Studio config.

## 2. Architecture, concretely

Package `@earendil-works/pi-durable` **1.4.0**, MIT, `engines.node >=22.19.0`. Its deps are pinned to the same version: `@earendil-works/chord`, `pi-ai`, `pi-codemode` and `pi-telemetry` (all 1.4.0), plus `typebox`, `diff` and `@silvia-odwyer/photon` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/package.json. About 15,000 lines of source, excluding tests [V] https://earendil.com/posts/pi-durable/ (via notes-pi; not re-read in this pass). The normative spec is `docs/spec.md` (324 KB) [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/docs/spec.md.

**Harness and context.** Every call takes a chord `context`; the examples use `BACKGROUND_CONTEXT` from `@earendil-works/chord/context` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/13-chat.ts.
- `Harness.open(storage, { models, registry, settings?, env?, identity?, setTimer?, onWake?, readOnly? }, context)` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts
- Harness methods [V] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md:
  - `root(context, { agent })` and `createConversation(options, context)`;
  - `conversation(id, context)`, as used by pi-durable-telegram [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/channel/conversations.ts;
  - `resume()`, `close(context)`, `waitForTask(id, context)`, `waitForIdle(context)`;
  - `snapshot(Doc, id, context)`, `watchDoc`, `observeConversation`;
  - `wake()`, `retryTask(id)`, `abortTask`, `inspect()`, `usage(context)`, `submission(id, context)`.
- Settings can be getters, read on each use (`toolExecution`, `retry.maxRetries`, `stream.timeoutMs`) [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/06-configuration.ts

**Conversation.**
- Methods: `submit(draft, context)` returns a `Submission` with `wait(context)` and `abort(context)`. Also `commit(tx => ..., context)`, `configure(changes, context)`, `entries(query, limit, cursor, context)`, `watch(context)`, `reset`, `compact`, `fork(entryId, ...)` and `abort(context, { background })` [V] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md.
- Per-conversation config keys: `model: { provider, modelId }`, `thinkingLevel`, `tools` (array, or `null` for the host default), `extensions` (array, or `{ add, remove }`), and `cwd` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/06-configuration.ts and https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/25-coding-agent.ts. The README also lists "instructions"; the exact key is unverified [U].
- Submissions [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts and spec §6 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#6-submissions-and-inbox:
  - `{ requestId?, type: "input", content, whenBusy?: "steer" | "followUp" | "reject" }`, or `{ type: "write", entry }`.
  - `requestId` "deduplicates within one conversation before any write".
  - Busy inputs queue in a durable inbox (`InboxDoc`). Steers join at the next post-tools boundary; follow-ups wait for the end of the run.
  - `"reject"` throws `ConversationBusy`.

**Tree.** Conversations have ownership `ownerless`, `conversation` or task-owned. Aborts propagate bottom-up, waits can be `failFast` or `allSettled`, and `fork(entryId)` branches a transcript [V] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md.

**Tasks.** Everything is a task: generation (`pi.generation`), tool (`pi.tool`), compaction, and your own.
- `defineTask<Input, Checkpoint, Result>({ name, version, initial, phases: { [phase]: (task, runtime, ctx) => ... }, abort })` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/11-tasks.ts
- Phases persist progress with `runtime.commit(...)`.
- Create a task with `tx.createTask(Task, input, { ownership: { kind: "conversation" }, background? })`. "Nothing runs until resume() or a call that waits for progress" [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/11-tasks.ts.

**Storage backends** (export subpaths): memory, `storage/sqlite/node`, `storage/sqlite/cloudflare`, `storage/jsonl/node`, `storage/indexeddb` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/package.json. A Postgres backend exists in the community [S] https://github.com/j-koester/pi-durable-postgres.
- SQLite: `openNodeSqliteStorage(path, { walAutoCheckpointPages?, busyTimeoutMs? = 5000, prefix? })`. It uses **`node:sqlite` `DatabaseSync`** (not better-sqlite3), `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, and `BEGIN IMMEDIATE` per commit. It has no exclusive locking mode and no platform-specific code [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/chord/src/sqlite/node.ts and https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/storage/sqlite/node.ts.
- JSONL: `main.jsonl` plus `doc-<id>.jsonl` and `task-<id>.jsonl` sidecars. `fsync` defaults to false, so it covers process crashes only, not power loss [V] spec §11.3 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#113-jsonl.

**Resume semantics:**
- After a crash, open a new Harness on the same storage and call `harness.resume()`; `waitForTask` also starts scheduling [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/12-recovery.ts.
- Interrupted model requests are resent with the same pinned model [V] spec §8.3 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#83-generation.
- A tool reruns only if declared `replay: "safe"` (the default is `"unsafe"`); otherwise the model gets an interrupted result [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts and https://earendil.com/posts/pi-durable/.
- `beforeTool` is **not** rerun on recovery once the call's final arguments are stored [V] spec §7.3 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#73-tools.
- A task cut off by 5 crashes in a row is parked (`restartLimit`) until `retryTask` [V] CHANGELOG 1.4.0 https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/CHANGELOG.md.
- A storage error ends the Harness with `SessionFailed`; reopen rather than retry [V] spec §12 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#12-api-footguns.

**Tools and extensions** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/define.ts
- Helpers: `defineExtension({ name, tools, sections?, hooks?, wraps?, tasks? })`, `defineTool({ name, description, parameters: Type.Object(...), replay?, executionMode?, execute(args, api, context) })`, `section(key, render, { tag? })`, `hook(TaskType, handlers)`, `wrapTool(tool, fn)`, and `registry.install(ext)`.
- `ToolExecutionApi` gives `output(chunk)`, `commit`, `createTask`, `waitForTask`, `executeTool`, `env` and `now()` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts.
- `ToolExecutionResult = { output?, isError?, details?, control?: { terminate?, handoff?, addTools? } }` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts.
- Built-in `CodingTools` (`read`, `write`, `edit`, `bash`) live under `./tools`. `NodeExecutionEnv({ cwd, shellPath?, shellEnv?, watch? })` has **no root or path restriction** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/env/node.ts

**Client attach** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/20-late-join.ts
- Attach is **in-process**: a second client, such as a Telegram bot, is another consumer of the same `Harness` object.
- Two styles:
  1. `conversation.watch(context)` gives a structural view (`view.value.entries`, `view.value.docs["pi.live"]` as `LiveState`, then `view.start(cb)`).
  2. `watchEvents(harness, conversationId, context)` gives an event stream (`stream.snapshot`, then `stream.start(batch => ...)` with `message_update` / `text_delta` and `tool_execution_update`).
- `LiveDoc` receives throttled partial answers [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/examples/15-real-model.ts.
- Another *process* can attach only read-only: `readOnly: true` opens "a viewer of a session another process drives" [V] spec §4 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#4-transactions-and-storage-ownership. That this sentence sits in §4 rather than §1-3 is [U]; WebFetch saw it in the first 100k characters.
- One process must own a storage; the README states this, and there is no built-in cross-process lock [V] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md (via notes-pi).
- Note: the blog's attach example uses `thread.viewState()` (https://earendil.com/posts/pi-durable/), which the Unreleased changelog section removes ("`Conversation.viewState()` ... removed") [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/CHANGELOG.md. So the post is already stale.

**Timers and scheduling** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/test/harness-sleep.test.ts
- Inside a task phase: `await runtime.sleepUntil(untilMs, nextCheckpoint, ctx)`. The stored state becomes `{ status: "sleeping", until, checkpoint }`, and the sleep survives reopen.
- Without `onWake`, the Harness arms its own `setTimeout` (`hostTimers`, `nativeTimer` with chunking for long delays) [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/timers.ts.
- With `onWake(wake)`, the host arms its own wake-up from `wake.at` and calls `resume()` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts.
- `TaskRuntime.sleep()` was **removed in 1.4.0**, replaced by `sleepUntil` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/CHANGELOG.md. pi-durable-telegram's reminders still call `runtime.sleep`, pinned to 1.2.0 [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/plugins/reminders/task.ts. A live example of the churn.

**Approval / "ask user" hooks**
- There is no built-in approval or permission system. The spec's "Permissions" example is literally `beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined)` [V] spec §7.1 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#71-extensions-registry-and-agent-resolution.
- `ToolHooks.beforeTool(call, api: HookApi, context) => { arguments?, block?: string } | undefined` is async. The first `block` wins, and a throw blocks [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts and spec §7.2 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#72-hooks.
- `HookApi.memo(name, context)` and `memo(name, candidate, context)` give "durable first-writer-wins decisions" [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts and spec §7.2 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#72-hooks.
- The post's example awaits `askInSlack(call)` inside `beforeTool` and stores the answer with `api.memo`, so "after a restart, the hook finds the stored answer instead of asking again" [V] https://earendil.com/posts/pi-durable/.
- So human-in-the-loop = an async `beforeTool` awaiting your UI, plus a memo. The post's memo key `"approval:deploy"` is not per call; use `approval:${call.id}` [U].
- `afterTool` can replace results. `GenerationHooks` has `beforeRequest`, `afterResponse`, `onYield` (can inject a `continue` user message) and `afterTools` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts.
- Footgun 30: a guard extension left out of an explicit `extensions` array selection "runs without that guard" [V] spec §12 https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#12-api-footguns. Install the approval hook so it is always selected.

## 3. Local LM Studio via pi-ai

**Yes, fully programmatic; no `models.json` needed.** pi-ai's README "Custom Providers > createProvider()" Ollama example (quoted line by line) [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md, adapted to LM Studio. **Adapted from sources, never run [U]:**

```ts
// ADAPTED FROM SOURCES, NEVER RUN. Verify against the pinned pi-ai version.
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const qwen: Model<"openai-completions"> = {
  id: "<exact LM Studio model id>", name: "...", api: "openai-completions", provider: "lmstudio",
  baseUrl: "http://127.0.0.1:1234/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536, maxTokens: 8192,
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
};
const lmstudio = createProvider({
  id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1",
  auth: { apiKey: { name: "LM Studio", resolve: async () => ({ auth: {} }) } },   // keyless
  // or: auth: envApiKeyAuth("LM Studio", ["LM_STUDIO_API_KEY"]) once LM Studio auth is on
  models: [qwen], api: openAICompletionsApi(),
});
const models = createModels(); models.setProvider(lmstudio);
// Harness.open(storage, { models, registry }, ctx); harness.root(ctx, { agent: { model: { provider: "lmstudio", modelId: qwen.id } } })
```

- The `compat` values are Hearth Pi's choice for LM Studio, Ollama, llama.cpp and vLLM ("matches Pi's built-in llama.cpp provider") [V] https://raw.githubusercontent.com/cosmyo/ha-pi-durable/main/hearth_pi/src/local.ts. pi-ai's README recommends `supportsDeveloperRole: false` and `supportsReasoningEffort: false` for Ollama, vLLM and SGLang [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md. `fetchModels` plus `models.refresh()` exist for discovery [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md. Hearth reads the context length from LM Studio's `/api/v0/models` `max_context_length` [V] https://raw.githubusercontent.com/cosmyo/ha-pi-durable/main/hearth_pi/src/local.ts.
- `packages/ai/src/api/openai-completions.lazy.ts` exists, and so do `anthropic-messages`, `openai-responses` and others [V] https://api.github.com/repos/earendil-works/pi/contents/packages/ai/src/api. Using `anthropic-messages` against LM Studio's `/v1/messages` is possible in principle but untested [U].
- **Tool-call format: Chat Completions (`openai-completions`)** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/src/api/openai-completions.ts:
  - Request: `tools` from `convertTools(...)`. `strict` is sent only if `compat.supportsStrictMode !== false`, and the auto-detected default is false. `tool_choice` is only sent if set; `parallel_tool_calls` is never sent.
  - Streaming: `delta.tool_calls` are matched by `index`, then `id`, and arguments accumulate. `finish_reason` `tool_calls` maps to `toolUse`.
  - Reasoning is read from `reasoning_content`, `reasoning` or `reasoning_text`. There is no `<think>` tag parsing.
  - `detectCompat` has **no** localhost, LM Studio or 1234 rule, so set `compat` yourself.
- Known local-model issues in the Pi tracker. The search found 57 hits for "LM Studio" (https://api.github.com/search/issues?q=repo:earendil-works/pi+%22LM+Studio%22). Per-item URLs are built from the numbers in that result; GitHub redirects `/issues/N` to `/pull/N` for PRs. Each line is [V] for the title, state and date as the search API returned them:
  - #6635 https://github.com/earendil-works/pi/issues/6635: tool-call JSON emitted in `content` is not recovered (PR not merged). If LM Studio fails to parse a model's tool call, pi-ai will not rescue it.
  - #9409 https://github.com/earendil-works/pi/issues/9409: reasoning models can wedge at the context ceiling (open).
  - #10885 https://github.com/earendil-works/pi/issues/10885: llama.cpp overflow is not detected, so compaction never triggers (open).
  - #11388 https://github.com/earendil-works/pi/issues/11388 (2026-10-25): `httpIdleTimeoutMs` acts as a total deadline (coding-agent setting; closed not planned).
  - #2257 https://github.com/earendil-works/pi/issues/2257: earlier 300 s undici timeout (closed completed).
  - #7668 https://github.com/earendil-works/pi/issues/7668: first-class LM Studio provider "not planned".
  - For Durable, set a generous `settings.stream.timeoutMs` and a conservative `contextWindow` [U].

## 4. Telegram client design

There is an existing client: **smixs/pi-durable-telegram**. It is not usable as-is here: Linux/systemd only, its lock reads `/proc`, it has no custom or local provider, no approval gate, and full `bash` by default [V section 1]. Its design is a good template. Sketch for agent-007 (TypeScript, one process):

1. **Transport and allowlist.** grammY `bot.start()` long polling (no webhook or open port). The first middleware drops any update whose `from.id` is not in `ALLOWED_USER_IDS` (numeric); private chats only. pi-durable-telegram silently ignores others and never stores their messages [V] https://github.com/smixs/pi-durable-telegram. The token comes from a file outside every allowed folder.
2. **Chat to conversation.** A durable `ChatMap` doc `{ chats: { [chatId]: conversationId } }`. On a miss, in **one** `harness.commit`: `tx.createConversation({ ownership: { kind: "ownerless" } })`, configure model/cwd, and write the map. This is the pi-durable-telegram pattern [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/channel/conversations.ts. `/new` creates a fresh conversation and remaps (or `conversation.reset()`).
3. **Admit messages idempotently.** `conv.submit({ type: "input", content, whenBusy: "followUp", requestId: \`tg:${chatId}:${message_id}\` }, ctx)`. A redelivered update after a crash dedups by requestId. Record `{ submissionId, chatId }` in a `PendingDelivery` doc. Callback taps use `requestId: tg:${chatId}:cq:${query.id}` (pi-durable-telegram) [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/channel/tap.ts.
4. **Streaming and progress.** Use `watchEvents(harness, convId, ctx)`: accumulate `message_update` `text_delta`, and `editMessageText` a placeholder at most every ~1.5 s. Show `tool_execution_update` as a "⏳ running read_file…" line. Then `submission.wait()` and send the final text in chunks of 4096 or less. pi-durable-telegram uses native drafts when `TELEGRAM_RICH=auto`, else edits in place [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/docs/configuration.md. For an MVP, edits are enough.
5. **Tool approval through inline buttons.** An extension `approval` with `hook(ToolTask, { beforeTool: async (call, api, ctx) => ... })`:
   - Return `undefined` for tools not in `NEEDS_APPROVAL`.
   - Otherwise check `await api.memo(\`approval:${call.id}\`, ctx)`.
   - If there is no memo, send "Allow `<tool>` with `<args, truncated>`?" with `[Approve] [Deny]` (`callback_data` `ap:<shortId>:y|n`, max 64 bytes). Await a Promise that the grammY `callback_query` handler resolves (check `from.id` again). Time out after N minutes as a deny.
   - Store the result with `api.memo(name, decision, ctx)`, then return `{ block: "User denied" }` or `undefined`.
   - On a crash while waiting, the hook reruns and asks again [V] spec §7.2 "a crash before the consuming commit may rerun them" https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#72-hooks. Stale buttons answer "expired".
   - Gate tools are `replay: "unsafe"`, so an interrupted approved call is reported as interrupted, not silently rerun [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/harness/types.ts (`replay` default `unsafe`).
   - Untested: long awaits inside `beforeTool` (minutes) have no documented timeout, but are not shown in any example either [U].
6. **Crash and resume.** On start: open SQLite, take a single-instance lock, `harness.resume()`. Then for each `PendingDelivery`: `harness.submission(id, ctx)`, `wait`, send, delete the record. Delivery is at-least-once; mark sent chunks as pi-durable-telegram's `send-phase.ts` does ("a rare duplicate beats a lost answer") [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/delivery/send-phase.ts. sumire notes the same non-atomicity [V] https://github.com/narumiruna/sumire/pull/75.
7. **Proactive or scheduled path.** A `defineTask` `"a7.schedule"` with one phase:
   - `runtime.sleepUntil(next, { phase: "wait", due: next }, ctx)`, then in one commit admit an input into the chat's conversation (`requestId: sched:${id}:${due}`). Record a `PendingDelivery` and checkpoint the next occurrence.
   - This is exactly the pi-durable-telegram `tg.remind` design: it watches the doc for cancellation, prefixes "late: the service was down" if more than 2 min overdue, and re-checks the allowlist on fire [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/plugins/reminders/task.ts.
   - Optionally a no-model path that sends fixed text with `bot.api.sendMessage` straight from the task.

## 5. Windows

- **Storage:** `node:sqlite` is built into Node, so there is **no native addon to compile** [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/chord/src/sqlite/node.ts. `node:sqlite` is "Stability: 1.2 - Release candidate" in current docs. It was unflagged in v22.13.0 / v23.4.0 ("still experimental") and became RC in v25.7.0 [V] https://nodejs.org/api/sqlite.html. On Node 22.19 or 24 it may print an ExperimentalWarning [U]. Use Node 24 LTS or newer (`engines >=22.19.0`) [U on the exact winget id].
- **Platform code:** `NodeExecutionEnv` has explicit win32 handling [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/env/node.ts:
  - Git for Windows `bash.exe` discovery (else `shell_unavailable`; never cmd or PowerShell);
  - `taskkill /F /T` for process trees, `detached` off on win32, `windowsHide`;
  - `~\` path expansion and a symlink check in place of `O_NOFOLLOW`.
  - Git Bash is present on this PC at `C:\Program Files\Git\bin\bash.exe` [V local] (system-inventory.md:15), which is one of the paths the discovery checks. The MVP does not need `bash` at all.
- **CI coverage:** the `env.yml` matrix runs Durable **env** conformance tests on `windows-latest` and `windows-11-arm` [V] https://raw.githubusercontent.com/earendil-works/pi/main/.github/workflows/env.yml. The main `ci.yml` runs the Durable suite (harness, SQLite, JSONL) on **ubuntu-latest only**, Node 22 [V] https://raw.githubusercontent.com/earendil-works/pi/main/.github/workflows/ci.yml. **The harness and SQLite storage on native Windows are untested upstream.**
- **Single owner:** you must enforce "one process per storage" yourself. pi-durable-telegram's lock uses `process.kill(pid, 0)` plus `/proc` start time [V] https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/src/runtime/lock.ts, which is Linux-flavoured. On Windows use an exclusive `openSync(path, "wx")` lock with a PID check, plus Task Scheduler's "Do not start a new instance" [U].
- **Paths:** keep the DB on a local non-synced path, for example `%LOCALAPPDATA%\agent-007\agent.sqlite`, not OneDrive. WAL sidecar files plus a sync client is asking for trouble [U]. Your own read tools must do `realpath` containment checks (Windows `\\?\`, junctions, case-insensitivity), because `NodeExecutionEnv` does none [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/src/env/node.ts (no restriction); the listed pitfalls are [U].
- **Always-on options** (all untested here):
  - **Task Scheduler "At log on"** under the dedicated low-privilege user: `node dist\main.js`, "restart on failure", "do not start new instance". This is the recommendation, consistent with LM Studio needing an interactive session (research.md). Note that Windows stops are usually hard kills, which is exactly what Durable's resume covers [U].
  - **NSSM:** a real service without login (nssm.cc returned 503 during research, so its maintenance state is unverified).
  - **pm2:** "PM2 has no built-in startup support for Windows"; pm2-installer is the suggested route, and pm2-windows-service is deprecated [S] https://npmjs.com/package/pm2-windows-service, https://awesome.ecosyste.ms/projects/github.com%2Fjessety%2Fpm2-installer. mikan uses pm2 [V] https://github.com/geminixiang/mikan.
- **Node is not installed** on this PC. Every Pi path adds Node ≥22.19 (recommend 24 LTS) [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/package.json.

## 6. Code estimate (MVP, TypeScript on Pi Durable)

Basis: **R** = shape read in source (API exists, and a comparable implementation was measured); **G** = guess. Comparable sizes from the GitHub tree API:
- pi-durable-telegram `src/` is 83 files, ~275 KB, roughly 7,000 lines, a full product [V] https://api.github.com/repos/smixs/pi-durable-telegram/git/trees/main?recursive=1. Its reminders plugin is ~17.7 KB (~450 lines).
- TelePi `src/` is 43 files, ~345 KB, roughly 9,000 lines [V] https://api.github.com/repos/jellydn/TelePi/git/trees/main?recursive=1.
- Bytes to lines assumes ~35-40 bytes per line [U].

Every number cell is labelled. **R** = the feature or config key was read in source or docs (the URL is given or is in research.md / notes-pi). **G** = the size is a guess. A cell like "R/G" means the mechanism was read but the line count is guessed.

| Module | Pi Durable MVP | Basis | Plain Pi SDK (TelePi-style) | nanobot |
|---|---|---|---|---|
| Telegram bridge (grammY polling, allowlist, chat map, idempotent submit, edit-streaming, chunking, `/new /stop /status`, pending-delivery recovery) | 350-500 | R (API) / G (size) | 300-450, no delivery recovery. **R/G**: SDK `createAgentSession`/`prompt` read in notes-pi; size guessed (TelePi's full bot is ~345 KB) | 0 code, config `token` + `allowFrom`. **R**: research.md, https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/chat-apps.md |
| LM Studio model config | 40-80 | R (pi-ai README, Hearth `local.ts`) | ~15 lines `models.json`, 0 code. **R/G**: format read in https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md; line count guessed | ~5 lines config (`lm_studio` preset). **R/G**: preset read in https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/providers.md; line count guessed |
| Read-only tools: system facts, allowed-folder read, search | 200-300 | G (`defineTool` shape R) | 200-300 (`customTools`). **R/G**: `customTools` read in https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md; size guessed | 0-200: built-ins plus `restrictToWorkspace`; custom tools in Python if needed. **R/G**: `restrictToWorkspace` read in https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/configuration.md; whether custom tools are needed, and their size, is a guess |
| Memory file (USER.md/MEMORY.md as prompt `section`, plus a gated `remember` tool) | 60-100 | R (`section`) / G | 20-60 (context files). **G**: whether the SDK loads context files with a custom cwd is unverified (notes-pi) | 0, built-in USER.md/MEMORY.md. **R**: research.md |
| Approval gate (`beforeTool` + `api.memo` + inline keyboard) | 120-180 | R (hook API, post example) / G | 150-250: Pi extension `tool_call` blocking; no durable memo. **G**: the blocking event is recalled, not re-read | Not available; would need a patch or fork. **R**: the gap is from research.md; the patch size is not estimated |
| Scheduler (`defineTask` + `sleepUntil` + admit + delivery) | 120-200 | R (`tg.remind`, sleep tests) / G | 100-180, not durable (cron lib + JSON file). **G** | 0, built-in cron; missed runs not replayed. **R**: research.md |
| Service wrapper (main, lock, resume, logging, Task Scheduler script) | 100-150 | G | 80-120. **G** | ~20-line Task Scheduler script. **G** |
| **Total** | **~1,000-1,500 LOC** | sum of the above; mostly G | **~850-1,350 LOC, with no crash-resume. G** (sum of guessed sizes) | **~50-100 lines of config, plus a possible patch for approval. G** (config counts guessed; the patch is not sized) |

Plus tests (G): about 300-600 lines for the Durable path if you test crash-resume and approval.

## 7. Verdict

**Yes, with caveats. Build on Pi Durable now instead of on plain Pi SDK.** This is a statement about the Pi family; nanobot is still the lowest-effort overall pick in research.md.

**This reverses REQ-0001's advice** (research.md: "Pi Durable is a later option", plan B = plain Pi SDK). REQ-0001 rested on three things: no messaging connector, no documented local-model setup, and experimental status. This pass found that:
- Telegram front ends on Pi Durable already exist to copy from;
- LM Studio can be configured in code through `createProvider`;
- the approval, scheduler and resume primitives the MVP needs are built in, where on the Pi SDK they would be hand-built.

The experimental-API risk remains and is handled by pinning (risk 1).

Why:
- The approval gate, the durable scheduler and crash-safe delivery are first-class here (`beforeTool` + `api.memo`, `sleepUntil`, `resume()`, `requestId`). On the Pi SDK you would hand-build weaker versions of each.
- Three Telegram-capable Pi Durable projects exist to crib from (pi-durable-telegram, sumire, mikan).
- `node:sqlite` avoids native builds on Windows.
- Migrating later from Pi SDK sessions means a rewrite and abandoning transcripts, as sumire did.

Risks, named:
1. **API churn (high).** 9 releases in 25 days.
   - 1.0.3 changed the env interfaces. 1.1.0 changed storage order and `context({at})`. 1.2.0 renamed `ToolExecutionResult.content` to `output` and made the tool unions tagged. 1.4.0 removed `TaskRuntime.sleep()`, migrated the SQLite schema to v2 (unreadable by ≤1.3.0), and requires `checkpointWhen`. Unreleased removes `Conversation.viewState()` [V] https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/CHANGELOG.md.
   - README: "The API changes without notice between releases". The two Telegram-first bots are pinned to old versions: sumire 1.0.2 (https://github.com/narumiruna/sumire/pull/75) and pi-durable-telegram 1.2.0 (https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/package.json). mikan's pin was not checked.
   - New contributors' issues are auto-closed, for example #11446 [V] https://github.com/earendil-works/pi/issues/11446.
   - Mitigation: pin `pi-durable`, `pi-ai` and `chord` to the same exact version; isolate Pi Durable calls in one adapter module; back up the `.sqlite` before any upgrade.
2. **Node install (low to medium).** Adds a runtime to the box (Node 24 LTS). Every Pi option shares this; nanobot avoids it.
3. **Maturity on Windows (medium).** Harness and SQLite tests are not run on Windows in CI. The lock and service wrapper are yours. Single-process ownership is enforced by you. synchronous=NORMAL can lose the newest commit on power loss [V] https://github.com/earendil-works/pi/blob/main/packages/durable/README.md (via notes-pi).
4. **No permission system (high if tools grow).** There is only `beforeTool` block or rewrite. `NodeExecutionEnv` has no path restrictions. A guard is skipped if left out of an explicit extension selection. Mitigation: no `CodingTools` or `bash`; own read-only tools with realpath containment; the approval hook installed in the host-default selection; a dedicated low-privilege Windows user (research.md hardening list).
5. **Local tool-call quality (medium).** pi-ai does not recover tool calls emitted as text (#6635); LM Studio's parser is the only line of defence. Run the phase-0 tool-call eval from research.md through pi-ai's exact request shape.

When to choose otherwise:
- If you do not want to write or maintain about 1-1.5k lines of TypeScript, stay with nanobot.
- If you want a working Telegram bot today and accept Linux, run pi-durable-telegram in WSL2. It needs a patch for a custom LM Studio provider, and it reaches Windows LM Studio via the host IP [U].

## Unverified

- Whether long (minutes) awaits inside `beforeTool` are safe: no timeout, lease or heartbeat is documented. The spec only says hooks may rerun after a crash.
- Exact behaviour of a duplicate `requestId` submit (returns the existing submission, or throws?). The spec does not say.
- The exact per-conversation "instructions" config key; how `tx.entry(AssistantEntry, answered.answer)` behaves (read vs write) in 13-chat.ts.
- Pi Durable harness and SQLite on native Windows (CI does not run them); `node:sqlite` ExperimentalWarning on Node 22/24; WAL behaviour on this PC.
- Whether LM Studio 0.4.26 needs other `compat` flags (for example `requiresToolResultName`) for the chosen model; whether `anthropic-messages` works against LM Studio `/v1/messages`.
- The default `settings.stream.timeoutMs` and whether it can cut off slow local first tokens.
- Plain-Pi-SDK approval via an extension `tool_call` event: recalled, not re-read in this session.
- Line counts converted from byte sizes; all LOC estimates marked G are guesses.
- Service options (Task Scheduler, NSSM, pm2-installer) not tested. NSSM site unreachable (503).
- npm dependents count (403), X/Twitter posts and GitHub code search: not checked.
- WebFetch summarises pages; quoted code was requested line by line but may contain small transcription errors.
