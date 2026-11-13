# REQ-0016 research: recurring tasks and reminders

## Question
What time/scheduling machinery, turn entry points, tool/approval/taint rules, persistence and UI surfaces exist today that a "remind me every Monday at 9" / "check X every morning" feature would build on? (Mapping only, no design.)

## Answer
- No scheduler for user tasks exists. `TIMER_TOOLS` (`set_timer`, `schedule_task`, `remind_me`, `cron`) are reserved only (`src/botbus/capabilities.ts:25-29`); `PeerCaps.timers` is hard `false` (`:88`). Confirmed.
- Pi Durable 1.4.0 has durable one-shot sleeps in Tasks (`runtime.sleepUntil(until, checkpoint, ctx)`, `Harness.wake()`, `onWake`, injectable `now`/`setTimer`): `node_modules/@earendil-works/pi-durable/README.md:140-166`, CHANGELOG 1.4.0. No cron/recurrence, no "timer fires a conversation turn". Recurrence would be a Task that sleeps, fires, computes next time, sleeps again. Confirmed (docs); not run.
- The existing "synthetic turn" is `bridge.injectInput(conversationId, text, requestId)` (`src/telegram/bot.ts:289-298`, interface `:133`). It is the natural firing entry point (used for job results, `src/agent/phase2.ts:174,196`).
- Recommended entry: a scheduler component (started in phase3/phase2 style, `src/agent/phase3.ts:316-397` pattern for unref'd timers) that calls `injectInput` with idempotent `requestId` like `task:<id>:<fireAt>`. Storage: a Pi `defineDoc` (like `chatMapDoc`, `src/telegram/conversations.ts:33`) or a Pi Task per schedule; the alternative is a JSON/SQLite file under `stateDir`. Decision left to the plan.

## Path through the code

### 1. Existing time machinery (all confirmed)
- `src/agent/harness.ts:21` only a comment on the scheduled task restarting the process. No timers.
- `src/agent/phase3.ts:316-397`: three `setInterval`s, unref'd: proposal reap 30s, template refresh 5min, ACL check 1h. Cleared at `:396`.
- `src/gate/gate.ts` + `src/gate/clock.ts`: `GateClock {now, setTimer}`, model-queue aging and notices (`gate.ts:185,281-341`). Not user scheduling. `realClock` is a reusable timer-injection pattern.
- `src/jobrunner/main.ts:2`, `src/main.ts:7-13`: "scheduled task" = Windows Task Scheduler that runs/restarts the process (`deploy/register-task.ps1:10,55`: startup trigger + delay 60s, RestartCount 3, ExecutionTimeLimit unlimited). No agent-level schedules.
- `src/ipc/client.ts`: connect/retry/request timeouts only. `src/botroom/mirror.ts:81`: a setTimeout for mirror rate pacing. `src/web/runtime/scheduler.ts`: `TurnScheduler`, fair queue for web chat turns, not time-based.
- `src/desktop/supervisor.ts`: child-process restart/backoff (exit codes 0,1,2,3,4).
- `src/prompt/sections.ts:166-171`: the runtime section prints the current time with time zone (`timeZone` option or system tz). Useful: the model already knows "now" and tz.

### 2. How a turn starts
- Telegram long poll -> `bot.on("message:text")` (`src/telegram/bot.ts:360`): drops stale >24h updates (`:362`), command check (`:366`), `admit` (`:253`) -> `submitInput` (`:220`): dedup via `delivery.known(requestId)`, run each `BridgeExtension.beforeSubmit` (persona; a throw refuses), `streams.watch`, `conv.submit({type:"input", content, whenBusy:"followUp", requestId}, BACKGROUND_CONTEXT)` (`:242`), `delivery.admit` (answer delivery registered durably), `afterSubmit`.
- Non-user turns that exist today: (a) `injectInput` -> same `submitInput(..., injected=true)`: job results, "browser ready", settings follow-ups (`phase2.ts:174,196`, `phase3.ts:296`). It needs the conversation to map to a chat (`chatLookup`, `bot.ts:292-296`; no chat = dropped with a warn). (b) peer turns: `src/agent/peerRuntime.ts:167` submits `<peer_message>` text as user-role data; `ctx.bind(conversationId)` first so the guard knows the chain.
- Injected text is a user-role message to the model; nothing in `submitInput` marks it untrusted beyond what the caller wraps (job results are wrapped by `jobResultMessage`). A schedule message would need its own wrapper.
- Multi-bot: each bot has its own bridge/harness/sqlite (`src/bots/paths.ts`; `src/agent/multibot.ts`); a schedule belongs to one bot and its chat.
- Web chat is a separate engine (`src/web/chat/service.ts:317-346`, `buildUserToolbox` in `src/runtime/tools.ts`), not the Pi agent; it does not get a7 tools. Inferred from imports; not traced in full.

### 3. Tool registration, offering and rules
- `createA7Extension` (`src/agent/extension.ts:98-171`) builds the fixed tool list and one combined `beforeTool` (`composeBeforeTool(...extraBeforeTool, gate.beforeTool)`, `:165`). Other tools come from `createPhase2` (jobs, MCP, browser) and `createPhase3` extensions installed in the registry (`harness.ts:395-400`). A new tool is a new extension (or part of phase3) with its own `defineTool`, installed there.
- Always-loaded set is exactly 10 (`ALWAYS_LOADED`, `MAX_ALWAYS_LOADED=10`, `src/jobs/contracts.ts:29-42`); a new tool must be `deferred: true` (found via `tool_search`), and appear in `KNOWN_TOOLS` (`src/settings/catalog.ts:10`) or bots/personas cannot allow it (`CODE_TOOL_NAMES`, `src/bots/schema.ts:34`). `DEFERRED_KNOWN_TOOLS` at `src/jobs/contracts.ts:47`. Tests count these (plan: `test/integration/phase4-wiring.test.ts`, per summary in plan.md:2078).
- Invariants are documented in `.claude/tickets/agent-007-pi-durable-mvp/plan.md` (table at ~`:289-372`). Relevant: I27 (always-loaded cap, deferred), I33 (`:315`: "Peer-triggered turns cannot start timers"), I36 (`:318`: monotone narrowing; peer turns never get shell/write/dispatch/remember; tainted chain has no approval-gated tool), I34 (peer text is data), I35 (no approval relayed), footgun 30 (never pass explicit `extensions`), deviation 80 (`:2309`: taint also applies to a USER chain after a content-ingesting tool for that message).
- Enforcement: peer: `isForbiddenForPeer` includes `TIMER_TOOLS` (`capabilities.ts:34-36`). Taint: `TAINT_BLOCKED_TOOLS` (`capabilities.ts:23`) = shell, dispatch_job, hub_start, propose_*, switch_persona, browser tools. **Timer tools are NOT in `TAINT_BLOCKED_TOOLS`**, so today a tainted user turn (after web/MCP read) would still be offered a timer tool unless it is added. Taint tracking (`bus.noteToolUse`) is wired only in the multi-bot path (`createBusGuard` used only at `src/agent/multibot.ts:410`); a one-bot install has no taint tracking. Confirmed by grep.
- Also `PEER_FORBIDDEN_TOOLS` and `PRIVILEGED_TOOLS`/`SENSITIVE_TOOLS` lists (`src/bots/schema.ts:36-53`, `catalog.ts:64`) should be checked when adding the name (not read in full).

### 4. Approvals with no user present
- Shell gate (`src/approval/gate.ts`): sends an approval card to the chat, waits until `askedAt + shell.approvalTimeoutSec` (default 600, `src/config/schema.ts:337`), then denies with `by:"timeout"`; after a restart past the deadline `restart-expired` (`gate.ts:155-176`). No chat -> block (`:170-174`). Decision memoised in Pi `api.memo`. Kill switch blocks.
- Jobs (`src/jobs/approval.ts`): default `jobs.approvalTimeoutSec` 1800 (`schema.ts:406`); no answer = reject (`:105,159,185`). Never "always allow"; every job and shell command needs a fresh tap.
- So a scheduled turn that calls `shell`/`dispatch_job` with the user away: card sent, turn blocks for 10 to 30 min, then denied. Nothing runs unattended. Confirmed by reading; not run. The fired turn is not "foreground", but `whenBusy:"followUp"` queues it behind a running turn.

### 5. Persistence and restarts
- Dirs (`src/config/schema.ts:347-359`): `programDataDir` (`%ProgramData%\agent-007`, config/secrets), `dataDir` (`%LOCALAPPDATA%\agent-007` for desktop; root via AGENT007_HOME, `src/desktop/paths.ts`), `stateDir` (`state\agent.sqlite` = Pi storage, `harness.ts:403`), `auditDir`, `controlDir` (kill flag), `runDir` (agent.lock), `memoryFile`. Per bot: `<dataDir>\bots\<id>\state\` (`src/bots/paths.ts`).
- Durable state patterns: Pi docs (`defineDoc`, e.g. chat map), Pi tasks (job tasks, `src/jobs/task.ts`, resumed by `harness.resume()` at `harness.ts:429`), JSON files with atomic rename (settings/prefs/proposals), audit log (`src/logging/audit.ts`; settings has a hash chain in `src/settings/chain.ts`/`audit.ts`).
- Restart: `Harness.resume()` restarts pending tasks; sleeping tasks wake when `now >= until` (README:140-166), so a missed fire time fires late on next start (catch-up semantics must be chosen). Crash-loop guard parks a task after `restartLimit` 5 (README:216). The process is supervised: Task Scheduler (service path) or Supervisor (desktop; Electron launcher spawns node agent with `--personal`, `src/desktop/main.ts:188`). A sleeping/hibernated PC means the agent does not run at all; Pi `setTimeout` timers do not fire during sleep, and on wake `Date.now()` jumps, so due items must be detected by comparing wall clock, not only by a single long timer. Inferred (Node behaviour); not tested. Pi's `nativeTimer` splits long delays into steps (`timers.d.ts`).
- Telegram updates older than 24h are dropped (`bot.ts:75,362`), irrelevant to injected turns.

### 6. User-facing surfaces
- Telegram: built-in commands `COMMAND_LIST` (`src/telegram/commands.ts:11-15`: new, stop, status, killshell; help/start `:101`). Extension commands via `BridgeExtension.registerCommands` + `commandList` + `prefixes` for inline-button callbacks (`bot.ts:94-117`, e.g. `/model` `modelUi.ts:152`, `/persona` `personaUi.ts:158`, settings `settingsUi.ts:302`, jobs UI `src/telegram/jobUi.ts`). A `/tasks` list with delete buttons fits as a new BridgeExtension with prefix e.g. `tk:`. `bridge.extend` must be called before `attach` for commands.
- Web: gateway `src/web/app.ts` with routes under `src/web/routes/` (admin, auth, chat, models, owner, paid, privacy); static UI `ui/web/*.js` (jobs.js, models.js, sidebar.js, bots.js...). No tasks page. Settings UI for job runner is separate (`src/jobrunner/settingsUi`). Whether the web gateway can reach the agent process's state: gateway and agent are separate processes (desktop: separate Supervisors, `desktop/main.ts:186-190`), so a web task list needs a shared store or IPC. Inferred.

### 7. Tests
- `node --test dist/test/**/*.test.js` after `tsc` (`package.json` scripts: build, test). Layout mirrors src: `test/{agent,approval,botbus,gate,jobs,telegram,web,integration,...}`; integration wiring tests in `test/integration/` (phase4-wiring etc.).
- Fake time: `FakeClock` implementing `GateClock` in `test/gate/fakes.ts:6-40` (manual `advance`); `now: () => number` injection in bridge (`bot.ts:74`), approval gate (`gate.ts` deps `now`, `pollMs`), gate tests, botbus limits (`test/botbus/limits.test.ts`), ipc. No `mock.timers` / sinon-style fake timers found in test (grep for useFakeTimers/mock.timers returned nothing in the matches list). Pi accepts `now`/`setTimer` on `Harness.open` for a fake clock (README:164), but `src/pi/adapter.ts` / harness.ts do not pass them today (harness.ts:414-425 passes models, registry, settings, onReport only).
- Rule: only `src/pi/adapter.ts` may import Pi (`test/adapter-boundary.test.ts`, `yarn check:adapter`); `defineTask` is already re-exported (`adapter.ts:30,145`); `sleepUntil` is a method on `TaskRuntime` (type exported?). Check that `Harness.wake` / `now` / `setTimer` option types are reachable via the adapter before relying on them (not verified).

## Reproduction
Not applicable (mapping task). Nothing was run; all by reading.

## What the plan needs
1. Decide scheduler model: (A) app-level scheduler loop + doc/JSON store + `injectInput`; (B) one Pi Task per schedule using `sleepUntil` (durable, crash-loop guard, wake/resume built in; recurrence in own code; needs adapter exports and a Harness clock decision).
2. Time semantics: time zone (store IANA tz + wall-clock rule, not UTC offset), DST, missed fires after downtime/sleep (skip, fire once late, fire all), minimum interval, max tasks, per-task and per-day caps.
3. Fired-turn trust: define a wrapper like job results; scheduled turn should run with a defined tool set (probably taint-blocked set applied, no gated tool without a live user, or explicit list).
4. Creation-time gate: tool creation should be user-originated only: add timer tools to `TAINT_BLOCKED_TOOLS` (or equivalent), keep in `TIMER_TOOLS`, deferred, show confirmation to user (card or echo) for creation. A fired scheduled turn must not itself be allowed to create new schedules (no self-propagation).
5. Files touched likely: new `src/schedule/*` (store, parser, scheduler), a new extension in `src/agent/` or phase3, `src/settings/catalog.ts` (`KNOWN_TOOLS`), `src/jobs/contracts.ts` (deferred list), `src/botbus/capabilities.ts`, new BridgeExtension for `/tasks`, `src/agent/harness.ts` + `multibot.ts` wiring (both paths), prompt section/`prompts/` text, tests + wiring-test tool counts.
6. Surfaces: `/tasks` in Telegram (list, pause, delete); web page optional, needs shared store or IPC.

## Risks
- Prompt injection: tainted-turn timer creation (see 3: not blocked today; one-bot installs have no taint tracking at all, so the creation tool should depend on user-origin by design, not on taint state). Injected content stored in a task prompt replays every fire: store the user's wording and show it in `/tasks`.
- Runaway frequency and cost: every fire is a model turn on a local GPU shared via the gate (`src/gate`); needs min interval, caps, circuit breaker (pattern: botbus limits `src/botbus/limits.ts`).
- Multi-bot: schedule must record bot id and chat; a peer turn must never create one (I33); schedules are per bot sqlite; `main` getters throw if main is not running (`harness.ts:281-285`).
- Desktop exe vs service: desktop agent runs only while the app and PC are up (sleep = no fires); the service path uses Task Scheduler restart. Two modes, same code, but lock `agent.lock` ensures one instance (`harness.ts:150`).
- Duplicate fire on restart: need idempotent `requestId` (`delivery.known`, `bot.ts:221` already dedups).
- Chat busy / `/new`: `injectInput` uses the chat's current conversation; scheduled turns land in an unrelated conversation context after `/new`; no chat = silently dropped (`bot.ts:292-296`).
- Approval gated actions in a fired turn time out after 10 to 30 min and the user may later tap a stale card: nothing runs without a tap, but cards could be noisy.

## Open questions
- Does the user want scheduled work to run in the user's current conversation or a dedicated one? (affects context and `/new`)
- Time zone source: system tz or user-set? (only `prompt/sections.ts` reads tz today)
- Can the web UI be the creation surface, or Telegram only?
- Do `Harness.open` option types `now`/`setTimer`/`onWake` and `TaskRuntime.sleepUntil` pass through `src/pi/adapter.ts` types? (not checked)
- Does a fired reminder require the model at all (plain notify via `bridge.notifier`) or always a turn?
- Is `PRIVILEGED_TOOLS` (`src/bots/schema.ts:36`) the right home for the new tool?

## Extra ideas
- Plain "reminder" (no model call) via `notifier.notify` vs "task" (model turn): cheaper, safer first slice.
- Reuse `GateClock`/`FakeClock` for scheduler tests.

## Discoveries
- `TAINT_BLOCKED_TOOLS` does not list the reserved timer names (see 3).
- No project-root CLAUDE.md exists (the brief's "read CLAUDE.md first" had nothing to read).
- Taint tracking exists only in the multi-bot path (`multibot.ts:410`); one-bot installs run with no taint tracking, so I36(3) is not enforced there for gated tools (shell is still approval-gated). Confirmed by grep for `createBusGuard`; the one-bot path was not examined for another mechanism.
