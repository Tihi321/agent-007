---
status: draft
request: REQ-0016
repos: [agent-007]
branch: none
updated: 2026-11-11
---
# agent-007 recurring tasks: plan

Ticket folder: `.claude/tickets/REQ-0016-recurring-tasks/`. Evidence (file:line refs) is in `research.md`; the refs this plan builds on
were re-read on master 1d1591f. Requirements R1-R4 and draft AC1-AC5: `.claude/director/requests/REQ-0016-recurring-tasks.md`.

Workers must not run `yarn build` / `yarn test` in the main checkout (its `dist/` serves the user's running gateway). Work in a worktree
on the branch `agent-007-recurring-tasks` (cut by `implement`). Node: `fnm exec --using default yarn ...` if `node` is not on PATH.
Only `src/pi/adapter.ts` may import Pi (`yarn check:adapter`); nothing in this plan needs a new adapter export.

## Decisions made in this plan (with the reason)

1. **Storage and scheduling: a Pi doc plus an in-process scheduler**, not a Pi Durable Task per schedule.
   - Store: one durable doc `a7.tasks` (`defineDoc`, scope `session`, like `chatMapDoc` `src/telegram/conversations.ts:29-35` and
     `settingsProposalsDoc` `src/settings/proposals.ts:54-60`) in each bot's own Harness (`agent.sqlite`). Writes go through
     `harness.commit(tx => tx.doc(tasksDoc))`, reads through `harness.snapshot(tasksDoc)`, both already exported by the adapter.
   - Scheduler: `TaskScheduler` with an injected `GateClock` (`src/gate/clock.ts`, `realClock` unref'd timers) that ticks every 15 s
     and compares the WALL CLOCK with each task's stored `nextFireAt`. A fire calls `bridge.injectInput(conversationId, text, requestId)`
     (`src/telegram/bot.ts:289-298`) with `requestId = task:<taskId>:<fireAt>`; `submitInput` dedups a known requestId
     (`bot.ts:221`), so a fire is never submitted twice, even across a restart.
   - Why not a Task per schedule: the adapter does not pass `now`/`setTimer` to `Harness.open` (`src/agent/harness.ts:414-425`), so
     tests could not drive time without changing harness startup; pause/resume/delete would mean cancelling and recreating durable
     tasks; the crash-loop guard parks a task after 5 restarts (pi-durable README:216), which would silently kill a schedule; the fire
     itself (a Telegram submit) is a non-durable side effect anyway. A doc plus a tick is simple, testable with `FakeClock`, and a
     sleep/wake jump is handled because each tick re-reads `Date.now()` (a long single timer would not be).
2. **Schedule format: structured, not cron.** The tool takes `{ kind, at?, time?, days?, everyMinutes? }`:
   - `once` + `at: "YYYY-MM-DDTHH:MM"` (local wall time, no offset); `daily` + `time: "HH:MM"` (every day); `weekly` + `time` + `days`
     (`mon`..`sun`, at least one; "every weekday" = mon-fri); `interval` + `everyMinutes` (60..10080).
   - Stored form (`TaskSchedule`): `once {at}`, `daily {time, days}` (weekly is daily with a day list; daily stores all 7 days),
     `interval {minutes, anchor}` (anchor = the confirm time). Why: a small local model fills named fields far more reliably than
     cron syntax, and every field is checked with a clear error the model can repair.
   - Time zone: the PC's local time at fire time (JS local `Date` fields; the runtime prompt section already shows the time zone,
     `src/prompt/sections.ts:166-171`). The IANA name (`Intl.DateTimeFormat().resolvedOptions().timeZone`) is shown on the card and in
     `/tasks`, never stored as the rule. DST: a wall time that does not exist (spring forward, 02:30) fires at the shifted local time
     JS gives (03:30); a wall time that occurs twice (fall back) fires once, at the first occurrence. `interval` is plain elapsed time
     and ignores DST.
   - Limits (`DEFAULT_TASK_LIMITS`, code constants, test-overridable): at most **10** tasks per bot (active plus paused), interval
     at least **60** minutes, `once` at least 1 minute and at most 366 days ahead, at most **48** fires per bot per local day (more
     are skipped and audited), instruction at most 1000 characters, title at most 60, one pending proposal per chat, at most 5
     proposals per chat per hour. A `once` task becomes `done` after its fire.
3. **Where a fire lands: the task records `chatId` (and the creating conversation, for the record only).** A fire goes to that chat's
   CURRENT conversation (`bridge.ensureConversation(chatId)`), so after `/new` it lands in the new conversation; the fired message is
   self-contained (decision 6), so it needs no earlier context. Proposals stay valid across `/new` (they belong to the chat) and expire
   after 10 minutes. "Chat gone": if `chatId` is no longer in `telegram.allowedUserIds` at fire time, the task is paused with reason
   `chat_not_allowed` (audited) and nothing is submitted. If `injectInput` throws or returns false for a reason other than a duplicate,
   the fire is `failed`; after 3 failed fires in a row the task is paused with reason `fire_failed`, audited, and a plain notice is sent
   to the chat (best effort). Only private chats exist (the callback rule `chat.id === from.id`, `src/telegram/settingsUi.ts:153-158`).
4. **Taint and peers: two layers that hold on both install kinds, without fixing the general one-bot taint gap.**
   - `schedule_task` (and the other reserved `TIMER_TOOLS`) is added to `TAINT_BLOCKED_TOOLS` (`src/botbus/capabilities.ts:23`;
     move the `TIMER_TOOLS` declaration above it). `PEER_EXTRA_FORBIDDEN` keeps `TIMER_TOOLS` (`:29`), and `schedule_task` is also
     added to `PEER_FORBIDDEN_TOOLS` (`src/bots/schema.ts:54`) so the settings validator refuses an edge that allows it
     (`schema.ts:544`). On a multi-bot install the bus guard (`src/agent/multibot.ts:410`, `bus.guard` `src/botbus/bus.ts:145-154`)
     then blocks it in peer turns and tainted chains.
   - A tool-local `TaskGuard` (new, `src/tasks/guard.ts`) runs on BOTH install kinds: its `afterTool` marks the conversation
     `ingested` after any content-ingesting tool (`isIngestingTool`, `capabilities.ts:39-42`), its `beforeTool` blocks
     `schedule_task` in an `ingested` or a `scheduled` (fired) conversation, and a user's own new message (not injected, and no turn of
     that conversation still running) clears both marks. The marks are durable (in the `a7.tasks` doc). This covers only
     `schedule_task`; shell and the other gated tools on a one-bot install stay as they are (listed in Out of scope).
   - The user's Save tap on the proposal card is the final guard on both kinds: nothing is stored before it, and the card shows the
     exact instruction and schedule.
   - One-bot installs have no peer turns at all (no bus), so "peer" applies only to multi-bot.
5. **Confirm flow.** `schedule_task` is non-blocking (like `propose_setting`): it validates, stores a `pending` proposal (deadline
   now + 10 min), sends a plain-text card to the chat with **Save** / **Discard** (`tk:s:<pid>` / `tk:x:<pid>`), and returns at once
   telling the model that nothing is saved until the user taps Save. A tap counts only from an allowlisted user in their own private
   chat, before the deadline, while the proposal is `pending`; Save re-checks the task cap. The card is edited to "Saved", "Discarded"
   or "Expired" (a 30 s reap marks expired ones). Audit: one JSON line per event in `<auditDir>\tasks-YYYYMM.jsonl` (append-only,
   synchronous, redacted; same pattern as `src/logging/audit.ts`) for proposed, created, discarded, expired, paused, resumed, deleted,
   fired, fire_failed, auto_paused, skipped_cap. `created` carries the full instruction; the others carry ids, actor and reason.
6. **Fired-turn framing.** The injected text (built by `scheduledRunMessage`, `src/tasks/prompt.ts`) starts with
   `[agent-007 scheduled run, not typed by the user just now]`, names the task id, title and due time, says the user saved this
   instruction earlier and that this run cannot create or change tasks, adds a `late` line for a catch-up ("This run is late: it was due
   at <time>, <n> hours ago, while the PC was asleep or off. Missed runs are not repeated; this is the only catch-up run."), then the
   instruction inside `<saved_instruction>...</saved_instruction>` with `<`, `>` and `&` escaped. **A fired turn cannot create tasks**
   (the `scheduled` mark of decision 4): no self-propagation, and a fired turn has no live user to read the card.
   - On a multi-bot install a fire first starts a fresh user-origin chain (`bus.beginUserTurn`) when no turn of that conversation is
     running, the same rule `hostExtension` uses for user messages (`multibot.ts:478-482`). Reason: the instruction is the user's own
     confirmed words; without this a fire would inherit an old tainted chain and every gated tool would vanish, breaking R1. Content
     ingested during the run taints it as usual. (Flagged for the user's review in Risks.)
   - Approval-gated tools ask as usual; with the user away they time out to deny (shell 600 s, jobs 1800 s; research section 4). Accepted.
7. **Web Tasks page: the control folder, not IPC.** The IPC protocol is agent <-> job runner only (`src/ipc/protocol.ts:1-17`), and the
   gateway already talks to the agent through `<controlDir>` (the kill flag; `owner-notices`, `src/approval/ownerNotices.ts`). So:
   - the agent writes a read-only snapshot `<controlDir>\tasks\<botId>.json` (atomic temp + rename) at start and after every change;
   - the gateway writes one request file per action into `<controlDir>\tasks\requests\` (`<ms>-<8 hex>.json`, exact key set
     `{action, botId, taskId}`, at most 50 pending, at most 1 KiB); the agent polls every 3 s, applies valid requests younger than 1 hour
     through the same service as Telegram (actor `web`), deletes every file it read, and drops anything that does not parse exactly.
   - Routes are owner-only (`auth: "owner"`); delete also needs a fresh step-up (`stepUp: true`), like other irreversible owner writes.
     The web can list, pause, resume and delete, never create or edit. A write to the folder can at worst pause or delete a task, never
     create one or change an instruction.
8. **Multi-bot: per-bot stores.** Each bot's tasks live in its own Harness doc, are fired into its own bridge and conversations, show in
   its own `/tasks`, and have their own cap and daily count. One snapshot file per bot; one request watcher per process routes by
   `botId`. Why: a turn runs in exactly one bot's Harness (`src/bots/paths.ts`), the bot allowlist (`narrowExtension`,
   `src/bots/registry.ts:27-31`) decides whether a bot has `schedule_task` at all, and nothing crosses bots.

## Invariants this feature adds (cite as TK1..TK6)

- TK1 Nothing is stored as a task without the allowlisted user's Save tap on its card, in their own private chat, before the deadline.
- TK2 `schedule_task` is never usable in a peer turn, a tainted chain (multi-bot), an `ingested` conversation (both kinds) or a fired
  (scheduled) run.
- TK3 A `(taskId, fireAt)` pair is submitted at most once (requestId dedup); a pending fire left by a crash is re-submitted with the
  same requestId.
- TK4 However many runs were missed, one tick fires a task at most once and moves `nextFireAt` past now; a paused span is never caught up.
- TK5 A fired turn's text says it is a scheduled (and, when so, late) run, and carries only the instruction the user saved.
- TK6 The web gateway can only pause, resume or delete through the control folder; it never writes the doc and never creates a task.

## Scope

- One deferred model tool `schedule_task` (name from `TIMER_TOOLS`), in a new extension `a7-tasks`, found through `tool_search`.
- The `a7.tasks` doc, the proposal card with Save / Discard, the tasks audit file.
- The scheduler: on-time fires, one late catch-up after sleep/off, pending-fire recovery after a crash, auto-pause rules, daily cap.
- The fired-turn framing; approval-gated tools in a fired turn ask as usual.
- Telegram `/tasks`: list with Pause / Resume / Delete (delete asks once more), `/status` line.
- Web: an owner-only Tasks page (list, pause, resume, delete) over the control folder.
- Wiring for the one-bot path (`src/agent/harness.ts`) and per bot for the multi-bot path (`src/agent/multibot.ts`); the tool-name lists.

## Out of scope

- The general one-bot taint gap: no taint tracking for shell, dispatch_job, browser or settings tools on a one-bot install
  (`createBusGuard` only at `multibot.ts:410`). Only `schedule_task` gets the local guard here.
- Creating or editing a task from the web UI, or from `/tasks`; editing a saved task at all (delete and re-create instead).
- Cron syntax, monthly or yearly rules, several times per day in one task, end dates, a per-task or user-set time zone.
- Running scheduled work while the PC sleeps (waking the PC, Windows Task Scheduler entries per task); more than one catch-up run.
- A plain reminder without a model turn (`notifier.notify`); auto-approval of any tool in a fired turn; a "quiet hours" rule.
- The other reserved names `set_timer`, `remind_me`, `cron` (stay reserved, unregistered); timers for peer turns (I33 unchanged).
- Tasks for web-chat user bots (`USER_TOOL_UNIVERSE` unchanged); config keys for the limits.
- Cleaning up snapshot files of bots that were removed.

## Files and modules

New:
- `src/tasks/contracts.ts` (T1): names, ids, types, limits, the interfaces between tasks. Pure, no imports.
- `src/tasks/schedule.ts` (T1): parse, next fire, describe. Pure (no Pi, no fs).
- `src/tasks/store.ts`, `src/tasks/audit.ts`, `src/tasks/service.ts`, `src/tasks/guard.ts` (T2).
- `src/tasks/scheduler.ts`, `src/tasks/prompt.ts` (T3).
- `src/tasks/tool.ts` (T4), `src/telegram/tasksUi.ts` (T4).
- `src/tasks/control.ts` (T5; node:fs only, imported by the gateway), `src/web/routes/tasks.ts`, `ui/web/tasks.js` (T5).
- `src/tasks/wire.ts` (T6): `createTasks`, the fire sink.
- Tests: `test/tasks/{schedule,service,guard,scheduler,control}.test.ts`, `test/telegram/tasksUi.test.ts`,
  `test/web/tasks-routes.test.ts`, `test/integration/tasks-e2e.test.ts`.

Changed (owner task):
- `src/botbus/capabilities.ts` [T1].
- `src/web/app.ts`, `src/web/audit.ts` (`task_request` kind), `ui/web/app.js`, `ui/web/sidebar.js`, `ui/web/app.css` [T5].
- `src/agent/harness.ts`, `src/agent/multibot.ts`, `src/settings/catalog.ts`, `src/jobs/contracts.ts`, `src/bots/schema.ts`,
  `src/web/capabilities.ts`, pinned-list tests (`test/integration/phase3-registry.test.ts`, `test/integration/phase4-wiring.test.ts`,
  `test/botbus/bus.test.ts`, and any other test that pins these lists) [T6].

## Tasks for workers

Order: **T1 alone first** (contracts and the pure schedule code). Then **T2, T3, T4, T5 in parallel** (disjoint files; each codes
against `src/tasks/contracts.ts`, not against another task's code; each tests with in-memory fakes of the other tasks' interfaces).
Then **T6** last (wiring, name lists, integration test). If a parallel task needs a change in a file it does not own, it reports it
instead of editing. Tests follow the `test-discipline` skill: only the tests named here.

### T1: contracts, schedule math, taint list (serial, first)

- Inputs: this plan; `src/botbus/capabilities.ts:18-36`; `src/gate/clock.ts`; `test/gate/fakes.ts:6-40`.
- Outputs:
  - `src/tasks/contracts.ts` exporting exactly:
    ```ts
    export const SCHEDULE_TASK_TOOL = "schedule_task";
    export const TASKS_EXTENSION_NAME = "a7-tasks";
    export const TASK_ID_RE = /^t[a-z2-7]{9}$/;      // "t" + 9 base32 chars
    export const PROPOSAL_ID_RE = /^p[a-z2-7]{9}$/;
    export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    export type Weekday = (typeof WEEKDAYS)[number];
    export type TaskSchedule =
      | { kind: "once"; at: string }                        // "YYYY-MM-DDTHH:MM", local wall time
      | { kind: "daily"; time: string; days: Weekday[] }    // "HH:MM"; days non-empty, sorted mon..sun, unique
      | { kind: "interval"; minutes: number; anchor: number }; // anchor: epoch ms (set on Save; 0 in a proposal)
    export interface TaskScheduleInput { kind: string; at?: string; time?: string; days?: string[]; everyMinutes?: number }
    export interface TaskLimits {
      maxTasks: number; minIntervalMinutes: number; maxIntervalMinutes: number; onceMinAheadMs: number; onceMaxAheadDays: number;
      maxFiresPerDay: number; instructionMax: number; titleMax: number; proposalTtlMs: number; maxProposalsPerHour: number;
      lateAfterMs: number; tickMs: number; maxFailures: number; maxFiresPerTick: number;
    }
    export const DEFAULT_TASK_LIMITS: TaskLimits = { maxTasks: 10, minIntervalMinutes: 60, maxIntervalMinutes: 10080,
      onceMinAheadMs: 60_000, onceMaxAheadDays: 366, maxFiresPerDay: 48, instructionMax: 1000, titleMax: 60,
      proposalTtlMs: 600_000, maxProposalsPerHour: 5, lateAfterMs: 300_000, tickMs: 15_000, maxFailures: 3, maxFiresPerTick: 3 };
    export type TaskStatus = "active" | "paused" | "done";
    export type PausedReason = "user" | "chat_not_allowed" | "fire_failed";
    export interface LastFire { fireAt: number; firedAt: number; late: boolean; state: "pending" | "submitted" | "failed"; error: string | null }
    export interface ScheduledTask {
      id: string; botId: string; chatId: number; createdInConversation: string; title: string; instruction: string;
      schedule: TaskSchedule; status: TaskStatus; pausedReason: PausedReason | null; createdAt: number; updatedAt: number;
      nextFireAt: number | null; lastFire: LastFire | null; failures: number; fires: number;
    }
    export interface TaskProposal {
      id: string; botId: string; chatId: number; conversationId: string; title: string; instruction: string; schedule: TaskSchedule;
      createdAt: number; deadline: number; messageId: number | null; status: "pending" | "saved" | "discarded" | "expired"; taskId: string | null;
    }
    export interface ConvFlags { scheduled: { taskId: string; fireAt: number } | null; ingested: boolean }
    export interface TasksValue {
      tasks: Record<string, ScheduledTask>; proposals: Record<string, TaskProposal>; flags: Record<string, ConvFlags>;
      day: { date: string; fires: number };            // local "YYYY-MM-DD" and fires so far that day
    }
    export interface TaskStore { read(): Promise<TasksValue>; update<T>(fn: (draft: TasksValue) => T): Promise<T> } // update = one commit
    export type TaskAuditEventName = "proposed" | "created" | "discarded" | "expired" | "paused" | "resumed" | "deleted"
      | "fired" | "fire_failed" | "auto_paused" | "skipped_cap";
    export interface TaskAuditEvent { event: TaskAuditEventName; botId: string; by: "user" | "web" | "agent" | "scheduler";
      taskId?: string; proposalId?: string; chatId?: number; reason?: string; fireAt?: number; late?: boolean; title?: string;
      instruction?: string; schedule?: string }
    export interface TaskAudit { write(e: TaskAuditEvent): void }
    export type TaskActor = { kind: "telegram"; userId: number; chatId: number } | { kind: "web" };
    export interface ProposeInput { botId: string; chatId: number; conversationId: string; title: string; instruction: string; schedule: unknown }
    export type ProposeResult = { ok: true; proposal: TaskProposal; nextFireAt: number } | { ok: false; error: string };
    export type DecideResult = { result: "saved"; task: ScheduledTask } | { result: "discarded" }
      | { result: "expired" | "not_pending" | "not_allowed" | "cap_reached" };
    export type ActionResult = { ok: true; task: ScheduledTask | null } | { ok: false; error: "not_found" | "not_allowed" | "once_in_past" | "bad_state" };
    export interface TaskServiceApi {
      propose(input: ProposeInput): Promise<ProposeResult>;
      setProposalMessage(proposalId: string, messageId: number): Promise<void>;
      decide(proposalId: string, decision: "save" | "discard", actor: { userId: number; chatId: number }): Promise<DecideResult>;
      reapProposals(): Promise<TaskProposal[]>;            // marks and returns the newly expired ones
      list(chatId?: number): Promise<ScheduledTask[]>;     // sorted by nextFireAt (null last), then createdAt
      pause(taskId: string, actor: TaskActor): Promise<ActionResult>;
      resume(taskId: string, actor: TaskActor): Promise<ActionResult>;
      remove(taskId: string, actor: TaskActor): Promise<ActionResult>;
      onChange(listener: () => void): () => void;
    }
    export interface TaskCardTransport {
      presentProposal(p: TaskProposal, info: { scheduleText: string; nextFireText: string; expiresText: string; zone: string }): Promise<number | null>;
      markProposal(p: TaskProposal, outcome: "saved" | "discarded" | "expired"): Promise<void>;
      notify(chatId: number, text: string): Promise<void>;
    }
    export type FireOutcome = "submitted" | "duplicate" | "no_chat";
    export interface FireSink { fire(task: ScheduledTask, text: string, requestId: string, fireAt: number): Promise<FireOutcome> } // throws = failed
    export interface TaskView { id: string; title: string; instruction: string; scheduleText: string; status: TaskStatus;
      pausedReason: PausedReason | null; nextFireAt: number | null; nextFireText: string; lastFireAt: number | null; lastLate: boolean;
      lastState: LastFire["state"] | null }
    export interface TaskSnapshot { v: 1; botId: string; writtenAt: number; zone: string; tasks: TaskView[] }
    export interface TaskRequest { action: "pause" | "resume" | "delete"; botId: string; taskId: string }
    export function emptyTasks(): TasksValue  // { tasks: {}, proposals: {}, flags: {}, day: { date: "", fires: 0 } }
    export function taskRequestId(taskId: string, fireAt: number): string // `task:${taskId}:${fireAt}`
    ```
    (Only `emptyTasks` and `taskRequestId` are functions; the rest are types and constants. If a Pi doc type rejects a nested object
    at compile time in T2, T2 stores that field as JSON text like `ProposalRecord.diff` and keeps these public types.)
  - `src/tasks/schedule.ts`:
    - `parseScheduleInput(input: unknown, now: number, limits: TaskLimits): { ok: true; schedule: TaskSchedule } | { ok: false; error: string }`.
      Kinds `once`, `daily`, `weekly`, `interval` (case-insensitive). `time` must match `^([01]\d|2[0-3]):[0-5]\d$`; `days` accept
      `mon`..`sun` (and full English names, lowercased), weekly needs at least one; `at` must be a real calendar date
      `YYYY-MM-DDTHH:MM`, at least `onceMinAheadMs` and at most `onceMaxAheadDays` ahead; `everyMinutes` an integer in
      `[minIntervalMinutes, maxIntervalMinutes]`. Interval gets `anchor: 0`. Errors are one sentence the model can act on, for
      example `"everyMinutes must be at least 60"`.
    - `nextFireAfter(s: TaskSchedule, after: number): number | null`: the first fire instant strictly after `after`. `once`: the
      instant of `at` (local `new Date(y, m-1, d, hh, mm)`) if it is after `after`, else null. `daily`: for day offsets 0..8 from the
      local date of `after`, `new Date(y, m-1, d+off, hh, mm).getTime()`, the first one after `after` whose requested calendar day is
      in `days`. `interval`: `anchor + k*minutes*60000` for the smallest k >= 1 with a value after `after`.
    - `describeSchedule(s): string` ("every day at 07:30", "every Monday at 09:00", "Mon, Wed, Fri at 18:00", "on weekdays at 08:00",
      "once on Tue 17 Nov 2026 at 09:00", "every 2 hours", "every 90 minutes"), `formatLocal(ms): string` ("Mon 17 Nov 2026 09:00"),
      `localZoneName(): string` (IANA name, or "local time").
  - `src/botbus/capabilities.ts`: move `TIMER_TOOLS` above `TAINT_BLOCKED_TOOLS` and set
    `TAINT_BLOCKED_TOOLS = [...existing, ...BROWSER_TOOL_NAMES, ...TIMER_TOOLS]`; update the I36(3) and `TIMER_TOOLS` comments
    ("`schedule_task` exists from REQ-0016").
  - Test `test/tasks/schedule.test.ts` (set `process.env.TZ = "Europe/Berlin"` on the first line; `node --test` runs each file in its
    own process): (1) one table test of `parseScheduleInput`: accepted weekly mon 09:00, daily, once tomorrow, interval 60; refused
    interval 30, once in the past, `25:00`, weekly without days, kind `cron`; (2) `nextFireAfter` for weekly Monday 09:00 from a
    Sunday before the 2026-10-25 fall-back and from a Sunday before the 2027-03-28 spring-forward (both give 09:00 local), and daily
    02:30 on 2027-03-28 gives 03:30 local, and interval returns anchor + k*minutes.
- Contract: T2-T6 import only `src/tasks/contracts.ts` and `src/tasks/schedule.ts` from T1.

### T2: store, audit, service, guard (parallel)

- Inputs: T1 outputs; `src/settings/proposals.ts:54-125` (doc and store pattern); `src/logging/audit.ts` (append pattern);
  `src/agent/busGuard.ts` (hook shapes); `src/agent/multibot.ts:474-500` (the active-turn rule).
- Outputs:
  - `src/tasks/store.ts`: `tasksDoc = defineDoc<TasksValue>({ kind: "a7.tasks", version: 1, scope: "session", initial: emptyTasks,
    checkpointWhen: (_v, _o, info) => info.deltasSinceBase >= 25 })`; `harnessTaskStore(getHarness: () => Harness | undefined): TaskStore`
    (throws "the Harness is not open yet" when absent; `update` runs `fn` inside one `harness.commit` and prunes proposals that are
    not pending and older than 7 days, and `done` tasks older than 7 days); `memoryTaskStore(): TaskStore` (structuredClone in and out).
  - `src/tasks/audit.ts`: `createTaskAudit({ dir, redact, now? }): TaskAudit` writing `tasks-YYYYMM.jsonl` (UTC month) with
    `{ ts: ISO, ...event }`, `appendFileSync` flag `a`, `redactDeep`; `memoryTaskAudit(): TaskAudit & { events: TaskAuditEvent[] }`.
  - `src/tasks/service.ts`: `class TaskService implements TaskServiceApi` with
    `constructor(d: { store: TaskStore; audit: TaskAudit; botId: string; allowedUserIds: () => readonly number[]; now: () => number;
    newId?: (prefix: "t" | "p") => string; limits?: TaskLimits; logger: Logger })`.
    - `propose`: title trimmed, 1..`titleMax`; instruction trimmed, 1..`instructionMax`; `parseScheduleInput`; refuse when
      `chatId` is not allowlisted, when the chat already has a pending proposal, when the chat had `maxProposalsPerHour` proposals in
      the last hour, or when the bot already has `maxTasks` tasks (active plus paused). Stores the proposal (deadline = now +
      `proposalTtlMs`), audits `proposed` (by `agent`), returns `nextFireAt` (for interval: now + minutes).
    - `decide`: actor must be allowlisted and `actor.chatId === actor.userId === proposal.chatId`, else `not_allowed`; not pending =
      `not_pending`; past deadline = mark `expired`, `expired`; save re-checks `maxTasks` (`cap_reached`). Save creates the task
      (interval anchor = now; `nextFireAt = nextFireAfter(schedule, now)`), marks the proposal `saved` with `taskId`, audits `created`
      with title, instruction and `describeSchedule`. Discard audits `discarded`.
    - `pause` / `resume` / `remove`: a telegram actor may act only on tasks whose `chatId` equals `actor.chatId` and who is
      allowlisted (`not_allowed`); web may act on any task of this bot. Pause: active -> paused (`pausedReason: "user"`). Resume:
      paused -> active with `nextFireAt = nextFireAfter(schedule, now)` (no catch-up of the paused span); a `once` whose time has
      passed = `once_in_past`; `failures` reset to 0. Remove deletes the record. Each audits with `by: "user"` or `"web"`.
    - `onChange` listeners run after every successful write (errors in a listener are swallowed).
  - `src/tasks/guard.ts`: `createTaskGuard(d: { store: TaskStore; logger: Logger; isIngesting?: (tool: string) => boolean })` returns
    `{ beforeTool: BeforeToolHandler; afterTool: AfterToolHandler; bridgeExtension(): BridgeExtension; markScheduled(conversationId:
    string, taskId: string, fireAt: number): Promise<void> }` (types from `src/pi/adapter.ts` and `src/telegram/bot.ts`).
    - `beforeTool`: only for `SCHEDULE_TASK_TOOL`; reads `flags[String(api.conversationId)]`; `scheduled` -> block
      `"A scheduled run cannot create tasks. The user can ask for a new task in their own message."`; `ingested` -> block
      `"This turn read outside content (web, mail or a tool server), so it cannot create a task. Ask the user to send the request again
      in a new message."`; a store error blocks (fail closed).
    - `afterTool`: when `isIngesting(call.name)` (default `isIngestingTool` from `src/botbus/capabilities.ts`) and the flag is not set
      yet, set `ingested: true`; return nothing (the result is unchanged); a store error is logged, never thrown.
    - `bridgeExtension()`: `beforeSubmit` and `afterSubmit` that count running turns per conversation exactly like `hostExtension`
      (`multibot.ts:478-500`); on a NOT injected submit with no running turn of that conversation, delete `flags[conversationId]`.
      `beforeSubmit` must never throw (a throw would refuse the user's message): catch and log.
    - `markScheduled`: sets `flags[conversationId] = { scheduled: { taskId, fireAt }, ingested: false }`.
  - Tests (in-memory store, fake clock):
    - `test/tasks/service.test.ts`: (1) propose -> save creates a task with the right `nextFireAt`, audit `proposed` + `created`;
      a tap after the deadline is `expired`; another user or a group chat is `not_allowed`; the 11th save is `cap_reached`;
      (2) pause then resume three weeks later: `nextFireAt` is the next occurrence after the resume time; a telegram actor of another
      chat gets `not_allowed`; remove deletes and audits.
    - `test/tasks/guard.test.ts`: one test: an ingesting tool marks the conversation and `schedule_task` is blocked; a user message
      while a turn is still running does not clear it; one after the turn ended does; `markScheduled` blocks; other tools are never
      blocked.
- Contract: T6 builds `TaskService`, `harnessTaskStore`, `createTaskAudit`, `createTaskGuard` exactly as above.

### T3: scheduler and fired-turn text (parallel)

- Inputs: T1 outputs; `src/gate/clock.ts`; `test/gate/fakes.ts` (`FakeClock`); `src/agent/phase2.ts:105-112` (wrapper style).
- Outputs:
  - `src/tasks/prompt.ts`: `scheduledRunMessage(t: { id: string; title: string; instruction: string }, fireAt: number, late: boolean,
    now: number): string`, the text of decision 6; the hours-late figure rounded to one decimal (minutes when under 2 hours);
    `escapeInstruction(s)` replaces `&`, `<`, `>` with entities.
  - `src/tasks/scheduler.ts`: `class TaskScheduler` with
    `constructor(d: { store: TaskStore; audit: TaskAudit; sink: FireSink; cards?: Pick<TaskCardTransport, "notify">; clock: GateClock;
    botId: string; allowedUserIds: () => readonly number[]; limits?: TaskLimits; logger: Logger; onChange?: () => void })` and
    `start(): Promise<void>`, `stop(): void`, `tick(): Promise<number>` (fires submitted this tick).
    - `start`: first re-submits every task whose `lastFire.state === "pending"` (same requestId; `duplicate` counts as submitted), then
      `tick()`, then re-arms `clock.setTimer(limits.tickMs, ...)` after each tick (a tick never overlaps another).
    - `tick`, for active tasks with `nextFireAt !== null && nextFireAt <= now`, oldest first, at most `maxFiresPerTick`:
      1. `chatId` not allowlisted -> `status: "paused"`, `pausedReason: "chat_not_allowed"`, audit `auto_paused`; next task.
      2. day rollover: when `formatDate(now)` differs from `day.date`, reset `day = { date, fires: 0 }`. If `day.fires >=
         maxFiresPerDay`: move `nextFireAt` to `nextFireAfter(schedule, now)` without firing, audit `skipped_cap`.
      3. one commit: `lastFire = { fireAt: nextFireAt, firedAt: now, late: now - fireAt > lateAfterMs, state: "pending", error: null }`,
         `nextFireAt = nextFireAfter(schedule, now)` (so every missed run is skipped), `status = "done"` when that is null, `fires++`,
         `day.fires++`.
      4. `sink.fire(task, scheduledRunMessage(...), taskRequestId(id, fireAt), fireAt)`; `submitted`/`duplicate` -> `state:
         "submitted"`, `failures = 0`, audit `fired` (with `late`); throw or `no_chat` -> `state: "failed"`, `error` (first 200 chars),
         `failures++`, audit `fire_failed`; at `maxFailures` -> paused `fire_failed`, audit `auto_paused`, `cards.notify(chatId,
         "Scheduled task \"<title>\" was paused after 3 failed runs. Use /tasks to resume or delete it.")`.
      5. `onChange()` after any write.
  - Test `test/tasks/scheduler.test.ts` (memory store, `FakeClock`, a recording fake sink):
    (1) on time: a weekly task fires once at its minute with requestId `task:<id>:<fireAt>`, text has the scheduled marker and no late
    line, `nextFireAt` moves one week; a second tick in the same minute fires nothing;
    (2) sleep: advance the clock's `now` three weeks without ticking (construct `FakeClock`-like `{ now, setTimer }` with a settable
    time), then `tick()` -> exactly one fire, late line naming the original due time, `nextFireAt` after now; the next tick fires
    nothing; a `once` task missed the same way fires once late and becomes `done`;
    (3) a task with `lastFire.state === "pending"` (crash between commit and submit) is re-submitted by `start()` with the same
    requestId; a sink that throws 3 times pauses the task and notifies; a removed user pauses with `chat_not_allowed` without a fire.
- Contract: T6 builds `TaskScheduler` with a real `FireSink` (decision 6) and `realClock`.

### T4: the tool and the Telegram UI (parallel)

- Inputs: T1 outputs; `src/settings/tools.ts:28-36,110-141` (deferred tool and `chatOf` pattern); `src/telegram/settingsUi.ts:150-200`
  (callback auth); `src/telegram/modelUi.ts:150-162` (`BridgeExtension` shape); `src/telegram/bot.ts:86-117`.
- Outputs:
  - `src/tasks/tool.ts`: `createTasksExtension(d: { service: TaskServiceApi; cards: TaskCardTransport | undefined; chats: ChatLookup;
    botId: string; now: () => number; logger: Logger }): Extension` named `TASKS_EXTENSION_NAME` with ONE tool `schedule_task`,
    `deferred: true`. Parameters (Type): `title` (string, max 60), `instruction` (string, max 1000, "the complete instruction in the
    user's words, as it should run later with no other context"), `schedule` (object: `kind` enum `once|daily|weekly|interval`, optional
    `at`, `time`, `days` (array of weekday strings, max 7), `everyMinutes` integer). Description must contain the words "schedule",
    "recurring", "reminder", "remind me", "every", "timer" so `tool_search` finds it, and say it only proposes: the user must tap Save.
    Execute: no chat for the conversation or no `cards` -> error text "Scheduling needs the Telegram chat."; `service.propose`;
    on error return the error as `isError` text; else `cards.presentProposal` and `service.setProposalMessage`; return
    `"Sent the user a card: <title>, <scheduleText>, first run <nextFireText>. Nothing is saved until they tap Save (the card expires at
    <hh:mm>). Do not call schedule_task again for this request."`.
  - `src/telegram/tasksUi.ts`: `class TelegramTasksUi implements TaskCardTransport` with
    `constructor(d: { api: Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery">; allowedUserIds: readonly number[];
    logger: Logger; service: TaskServiceApi; now: () => number })` and `extension(): BridgeExtension` (prefixes `["tk:"]`, `/tasks`
    in `commandList` ("List, pause, resume or delete scheduled tasks"), `registerCommands`, `callback`, `statusLines`:
    `"Tasks: <a> active, <p> paused; next <formatLocal>"` or `"Tasks: none"`).
    - Card (plain text, no `parse_mode`): `New scheduled task proposed by the agent`, blank, `<title>`, `When: <scheduleText>
      (<zone>)`, `First run: <nextFireText>`, `It will run as a full agent turn. Tools that need your approval will still ask.`, blank,
      `Instruction:`, the instruction verbatim, blank, `Expires <hh:mm>.`; buttons `Save` (`tk:s:<pid>`), `Discard` (`tk:x:<pid>`).
      `markProposal` edits the card to its head plus `Saved.` / `Discarded.` / `Expired.` without buttons.
    - `/tasks`: one message listing this chat's tasks (`service.list(chatId)`): per task `<n>. <title>: <scheduleText>; next
      <nextFireText>` plus `(paused)` / `(paused: chat not allowed)` / `(paused after failed runs)` / `(done)`; keyboard one row per task
      `[Pause|Resume <n>] [Delete <n>]` (`tk:p:<tid>`, `tk:r:<tid>`, `tk:d:<tid>`); delete edits to `Delete "<title>"?` with
      `[Yes, delete]` (`tk:D:<tid>`) `[Back]` (`tk:l`); after any action the list is redrawn by editing the message. No tasks:
      `No scheduled tasks. Ask me, for example "remind me every Monday at 9 to check the backups".`
    - Callback auth exactly as `settingsUi.ts:153-158` (allowlisted `from.id`, and `chat.id === from.id`); anything else, a malformed
      id (`TASK_ID_RE`, `PROPOSAL_ID_RE`) or an unknown code is answered with no change. All callback data under 64 bytes.
  - Tests:
    - `test/telegram/tasksUi.test.ts` (fake api, fake `TaskServiceApi`): (1) the card text contains the instruction verbatim and the
      two buttons; a Save tap by the allowlisted user calls `decide(pid, "save", {userId, chatId})` and edits the card to `Saved.`; a
      tap from another user or a group chat calls nothing; (2) `/tasks` lists two tasks with the right buttons; Pause calls `pause`
      with a telegram actor; Delete asks first and only `tk:D:` calls `remove`.
- Contract: T6 builds one `TelegramTasksUi` per bridge and passes it as `cards` to the tool and the scheduler.

### T5: control folder channel and the web Tasks page (parallel)

- Inputs: T1 outputs; `src/approval/ownerNotices.ts` (the file pattern to copy); `src/web/routes/owner.ts`, `src/web/app.ts:60-135`,
  `src/web/server.ts:55-60,285` (auth and step-up); `src/web/audit.ts:12-66`; `ui/web/jobs.js`, `ui/web/account.js:11-30`
  (`withStepUp`), `ui/web/app.js:186-200`, `ui/web/sidebar.js:50-56`; `test/web/owner-artifacts.test.ts` (route test pattern).
- Outputs:
  - `src/tasks/control.ts` (node:fs, node:path, node:crypto only; imports T1 types and `describeSchedule`/`formatLocal`/`localZoneName`
    only):
    `tasksControlDir(controlDir)` = `<controlDir>\tasks`; `toTaskView(t: ScheduledTask): TaskView`;
    `writeTaskSnapshot(controlDir, snap: TaskSnapshot): void` (botId must match `BOT_ID_PATTERN`, temp + rename, never throws, logs
    nothing); `readTaskSnapshots(controlDir): TaskSnapshot[]` (files `<botId>.json` only, at most 64 KiB each, strict parse, bad
    files skipped); `writeTaskRequest(controlDir, r: TaskRequest): boolean` (refuses bad action, botId or `TASK_ID_RE` taskId; at most
    50 pending; name `<ms>-<8 hex>.json`); `drainTaskRequests(controlDir, apply: (r: TaskRequest) => Promise<void>, now: number):
    Promise<number>` (oldest first; every file read is deleted; exact key set `action,botId,taskId`; at most 1 KiB; older than 1 hour by
    the name's ms = dropped); `watchTaskRequests(o: { controlDir; apply; intervalMs?: number (3000); now?: () => number; onError? }):
    { stop(): void; poll(): Promise<number> }` (no overlapping polls, unref'd interval).
  - `src/web/routes/tasks.ts`: `taskRoutes(stack: WebStack, o: { controlDir: string; now?: () => number }): Record<string, RouteDef>`:
    - `GET /api/owner/tasks` (`auth: "owner"`): `{ bots: readTaskSnapshots(controlDir) }`.
    - `POST /api/owner/tasks/toggle` (`auth: "owner"`): body `{ botId, taskId, action: "pause" | "resume" }`.
    - `POST /api/owner/tasks/delete` (`auth: "owner"`, `stepUp: true`): body `{ botId, taskId }`.
    - Both POSTs check the ids' shape and that the task is in that bot's current snapshot (else 404), call `writeTaskRequest`
      (false -> 503 `{ error: "busy" }`), write one web audit event `{ kind: "task_request", user, detail: { botId, taskId, action } }`,
      and answer 202 `{ queued: true }`.
  - `src/web/audit.ts`: add `"task_request"` to `AUDIT_KINDS`. `src/web/app.ts`: mount `taskRoutes` when `o.controlDir` is set.
  - `ui/web/tasks.js`: `renderTasks(ctx)`: per bot a section (bot id as heading only when there is more than one), per task title,
    schedule text, next run (`nextFireText`), status, the instruction in a `<details>`; buttons Pause / Resume (toggle) and Delete
    (browser `confirm`, then `withStepUp` from `account.js`); after a 202, re-fetch after 2 s and show "Queued. The agent applies it
    within a few seconds while it runs." Show the snapshot age ("updated <n> min ago") and, when older than 5 minutes, "The agent may not
    be running." Every value set as text. Empty: "No scheduled tasks. Ask the agent in Telegram to create one."
  - `ui/web/app.js`: route `#/tasks` (owner only, else the bots page); `ui/web/sidebar.js`: owner menu item `Tasks` after
    `Browser sessions`; `ui/web/app.css`: minimal styles reusing the jobs page classes where possible.
  - Tests:
    - `test/tasks/control.test.ts`: one test: `writeTaskRequest` then `drainTaskRequests` delivers the request and deletes the file; a
      file with an extra key, an oversize file, a stale name and a bad task id are deleted and not applied; snapshots round-trip and a
      bad snapshot file is skipped.
    - `test/web/tasks-routes.test.ts`: owner GET returns the snapshot; a non-owner session gets 403; toggle writes one request file and
      answers 202; delete without a fresh step-up is refused and writes nothing; an unknown task id is 404.
- Contract: T6 calls `writeTaskSnapshot`, `toTaskView` and `watchTaskRequests`; the gateway gets `controlDir` as today (`src/web/main.ts:196`).

### T6: wiring, name lists, integration test (serial, last)

- Inputs: everything above; `src/agent/harness.ts:65-140,320-470`; `src/agent/multibot.ts:380-470,575-630`;
  `src/bots/runtime.ts:205-220` (`afterOpen` runs before `bridge.attach` and `bridge.start`); `test/integration/rig.ts` (`E2e`).
- Outputs:
  - `src/tasks/wire.ts`: `createTasks(d: { botId: string; config: Config; logger: Logger; redact: Redactor; bridge?: TelegramBridge;
    getHarness: () => Harness | undefined; beforeFire?: (conversationId: string) => void; options?: TasksOptions }): TasksHandle` where
    `TasksOptions = { clock?: GateClock; now?: () => number; limits?: Partial<TaskLimits>; newId?: (p: "t" | "p") => string;
    store?: TaskStore }` and `TasksHandle = { extension: Extension; beforeTool: BeforeToolHandler; afterTool: AfterToolHandler;
    service: TaskService; scheduler: TaskScheduler; start(): Promise<void>; close(): Promise<void> }`.
    - Builds the store (`harnessTaskStore(getHarness)` unless given), audit (`config.paths.auditDir`), service, guard, Telegram UI
      (when a bridge exists; `bridge.extend(ui.extension())` and `bridge.extend(guard.bridgeExtension())` inside `createTasks`, so
      before `attach`), the tool extension, the scheduler.
    - The fire sink: `conversationId = await bridge.ensureConversation(task.chatId)`; `beforeFire?.(conversationId)`;
      `await guard.markScheduled(conversationId, task.id, fireAt)`; `bridge.injectInput(conversationId, text, requestId)` -> true =
      `submitted`, false = `duplicate` when `await bridge.delivery()?.known(requestId)` is true, else `no_chat`.
    - `service.onChange` and the scheduler's `onChange` write `writeTaskSnapshot(config.paths.controlDir, ...)`.
    - `start()`: write the snapshot, start a 30 s proposal reap (`reapProposals` then `ui.markProposal(p, "expired")`), then
      `scheduler.start()`. `close()`: stop timers and the scheduler.
  - `src/agent/harness.ts` (one-bot): `StartOptions.tasks?: TasksOptions`; `AgentHandle.tasks?: TasksHandle`; create tasks after
    `createPhase3` with `botId: MAIN_BOT_ID`; `extraBeforeTool: [tasks.beforeTool, ...p3.beforeTool, ...p2.beforeTool]`,
    `extraAfterTool: [tasks.afterTool]`; `registry.install(tasks.extension)` after `p3.extension`; after `br.start()`:
    `await tasks.start()` and one `watchTaskRequests` routing `botId === "main"` to `service.pause/resume/remove(taskId, { kind: "web" })`;
    stop both in `stop()`. With `telegram: false` the scheduler is not started.
  - `src/agent/multibot.ts`: per bot in the factory, `createTasks({ botId: self, config: botConfig, bridge, getHarness: () =>
    rt()?.harness, beforeFire: (conv) => { if ((activeTurns.get(`${self}|${conv}`) ?? 0) === 0) bus.beginUserTurn(self, conv); },
    options: a.tasks })`; add `tasks.beforeTool` first in `extraBeforeTool`, `extraAfterTool: [busGuard.afterTool, tasks.afterTool]`,
    `tasks.extension` in the returned installs (it goes through `narrowExtension`, so a bot without `schedule_task` in its tools has no
    tool, but its `/tasks` still works); keep `tasks` on `BotParts`; start each bot's tasks once its bridge has started (after
    `manager.start()` resolves, for every running bot); one process-wide `watchTaskRequests` with `config.paths.controlDir` that routes
    by `botId` to the running bot's service (unknown bot = dropped); stop all in `stop()`. Pass `tasks` through `MultiBotArgs`.
    `AgentHandle.tasks` getter returns the main bot's.
  - Name lists: `KNOWN_TOOLS` + `"schedule_task"` and `SENSITIVE_TOOLS` + `"schedule_task"` (`src/settings/catalog.ts`);
    `DEFERRED_KNOWN_TOOLS` + `"schedule_task"` (`src/jobs/contracts.ts:47`); `PEER_FORBIDDEN_TOOLS` + `"schedule_task"`
    (`src/bots/schema.ts:54`); `HOST_TOOL_NAMES` + `"schedule_task"` (`src/web/capabilities.ts:13`). `MAIN_DEFAULT_TOOLS` follows
    `KNOWN_TOOLS` (the implicit main bot gets it); an explicit bot gets it only when its `tools` lists it (the settings UI).
  - Pinned tests updated, not duplicated: `phase3-registry.test.ts` installed list gains `"a7-tasks"` last; the names equal
    `KNOWN_TOOLS`; the non-deferred set is still exactly the 10; `bus.test.ts:127` loop and the taint test at `:137` gain
    `"schedule_task"`; any other pinned list a build turns up.
  - Test `test/integration/tasks-e2e.test.ts` (`E2e.open` with a scripted `viaToolSearch` behaviour and `start: { tasks: { clock, now } }`
    over a settable fake clock): (1) AC1+AC2: the user says "remind me every Monday at 9 to check the backups"; the model calls
    `schedule_task` (weekly mon 09:00); one card with Save arrives; `rig.tap("tk:s:<pid>")`; the task is stored with `nextFireAt` = next
    Monday 09:00 local; set the clock to that minute and `rig.agent.tasks.scheduler.tick()`; the model's next request contains the
    scheduled marker and the instruction; the script then calls `shell`; an approval card arrives and the fake shell runner is NOT called
    until the card is approved; (2) AC5: after Save, `rig.restart()`; the task is still listed; set the clock 3 weeks ahead and tick
    twice: exactly one injected turn with the late line, `nextFireAt` in the future; (3) AC3 one-bot: after a scripted ingesting tool
    call (`fetch_url` or an MCP tool of the fake hub, whichever the rig supports) in the same turn, `schedule_task` returns the block
    text and no card is sent.
- Verification: `yarn build`, `yarn test`, `yarn check:adapter` in the worktree; all green.

## Acceptance criteria

Tests run offline with `node --test` over `dist/test`. Time is driven by `FakeClock` / an injected `now`; no test sleeps for a schedule.

| # | Criterion | Proof |
|---|---|---|
| AC1 | "Remind me every Monday at 9" leads to a `schedule_task` proposal, a card with Save/Discard, a stored task after Save only, and a fire at Monday 09:00 PC-local time (DST-correct) | `tasks-e2e.test.ts` (1); `schedule.test.ts` (2) for the DST weeks; `service.test.ts` (1) for expiry, wrong user, cap |
| AC2 | A fire runs as a full agent turn in the chat's current conversation, framed as a scheduled run; an approval-gated tool still needs the user's yes | `tasks-e2e.test.ts` (1): framed text reaches the model, shell card appears, runner not called before Approve; `scheduler.test.ts` (1) for requestId and framing |
| AC3 | A peer turn, a tainted chain (multi-bot), a turn that read outside content (both kinds) and a fired run cannot create a task | `bus.test.ts` peer and taint tests with `schedule_task`; `guard.test.ts`; `tasks-e2e.test.ts` (3); the Save tap (TK1) in `service.test.ts` (1) |
| AC4 | `/tasks` and the web Tasks page list tasks and pause, resume and delete them; only the allowlisted user / the owner can; web delete needs step-up | `tasksUi.test.ts` (2); `service.test.ts` (2); `control.test.ts`; `tasks-routes.test.ts` |
| AC5 | Tasks survive a restart; any number of missed runs collapse into one late run; a crash between commit and submit re-submits once | `tasks-e2e.test.ts` (2); `scheduler.test.ts` (2) and (3) |

## Risks

- **Fresh chain on fire (multi-bot, decision 6)** treats the saved instruction as user authority for that run. The alternative (inherit
  the last chain) would block every gated tool after any tainted conversation. The user should confirm this choice.
- **Prompt injection at creation on a one-bot install**: only `schedule_task` is guarded locally; a poisoned page could still steer the
  wording the model proposes in a later clean turn. The card shows the exact instruction and the user decides. Every fire replays that
  text, so `/tasks` and the web page show it in full.
- **Unattended cost**: each fire is a model turn on the local GPU. Bounded by 10 tasks, a 60-minute minimum, 48 fires per day, 3 fires
  per tick (a wake after a long sleep staggers catch-ups over a few ticks).
- **Approval noise**: a fired turn that needs shell or a job sends a card that times out to deny when the user is away (accepted in R1).
- **Sleep**: nothing fires while the PC sleeps or the app is closed; the first tick after wake (within 15 s) fires the catch-up. A clock
  change by the user moves fires the same way.
- **Delivery dedup durability**: TK3 relies on `delivery.known` surviving a restart (research: delivery is registered durably). T6's
  restart test covers it; if it does not hold, stop and report.
- **Web request latency**: actions apply within about 3 s while the agent runs; queued requests older than 1 hour are dropped, so an
  agent that is off for long does not apply a surprise delete later.
- Shared files: `capabilities.ts` is T1's; the name lists and harness/multibot are T6's only.

## Manual live-verification checklist (the user)

- M1 In Telegram (one-bot install): "remind me every Monday at 9 to check the backups". A card arrives with the instruction, "every
  Monday at 09:00 (<zone>)" and the first run. Tap Discard: nothing in `/tasks`. Ask again, tap Save: `/tasks` lists it.
- M2 Ask for a task due in 2 minutes ("once today at hh:mm, tell me a joke"). The turn arrives on time, says it is a scheduled run.
- M3 Ask for a once task that runs a shell command ("at hh:mm run `dir` in the workspace"). At fire time an approval card arrives; do not
  answer: after the timeout the command is denied and nothing ran.
- M4 Create a task due in 5 minutes, put the PC to sleep for 15 minutes, wake it: exactly one run arrives, marked late.
- M5 Quit the app (or stop the scheduled task) across two due times of an interval task, start it again: one late run, then the next
  run at the normal time.
- M6 `/tasks`: Pause, Resume, Delete (confirm). Check `audit\tasks-YYYYMM.jsonl` has created, paused, resumed, deleted lines.
- M7 Web UI as owner: Tasks page lists the same tasks; Pause and Resume apply within a few seconds (Telegram `/tasks` agrees); Delete asks
  for the authenticator code or passkey. A non-owner account has no Tasks menu item.
- M8 After `/new`, the next fire lands in the new conversation and still makes sense on its own.
- M9 Ask it to read a web page and in the same message "and remind me about it every day": the schedule is refused with the "read outside
  content" text; a new plain message creates the proposal.
- M10 Multi-bot install (if used): a task made in bot B fires in bot B's chat only; a peer ask cannot create one.
