# Phase 4 pause notes (2026-10-30)

The user paused the work while S21–S25 ran in parallel. Each worker was asked to stop at a safe point and report. These are their reports, condensed. Contracts for S21–S25: `.claude/temp/s20-contracts.md`.

## S20: bot foundation (DONE offline)
- Build 0 errors; `npm test` 1116 tests, 1115 pass, 1 skipped (symlink); `check:adapter` PASS.
- plan.md S20.1–S20.5 ticked, deviations 63–76.
- UNTESTED live: the real-install migration, the two-bot hard-kill check (U49/U50 stay OPEN; the fallback is one process per bot), the real `check-acl.ps1` run, BotFather and the tokens (user steps).
- `startAgent` and `src/main.ts` are unchanged; S26 wires the manager in.

## S22: model presets and switching (PARTIAL; nothing tested; no plan ticks)
- Written and compiling: `src/models/{presets,routes,fallback,switch}.ts`.
  - `presets.ts`: `resolveActivePreset`, `presetProblem`, `routeProblems`, `activePresetProblem`, `hasLocalRoute`, `compactionOverrides`, `presetRef`.
  - `routes.ts`: `switchVerdict` (reuses `botRows(...).classify`), `pickerEntries`, `fallbackCandidates`.
  - `fallback.ts`: pure `decide(error, preset, route, ctx)` implementing the I39 rows; `FallbackEngine`.
  - `switch.ts`: `ModelSwitcher` per bot (`ensureApplied`, `switchByUser`, `liveModelRef`, `setFallback` / `clearFallback`).
- NOT STARTED:
  - `test/models/**`, including the S22.1 done-check cases and the table tests for fallback;
  - `src/telegram/modelUi.ts` (S22.2);
  - S22.4 settings forms: `bots`, `termsAccepted` (with `ack` text), `botBus`, `botRoom` and `gate` descriptors under `src/jobrunner/settingsUi/forms/`, registered in `shippedForms`;
  - removing the `PHASE4_PENDING_FORMS` skip in `test/settingsUi/forms.test.ts`;
  - a test that no allowlist row or tool can set `termsAccepted`;
  - U51 offline evidence;
  - plan ticks and deviations.
- Deviations to record:
  - The pref `bots.<id>.activePreset` is the source of truth; conversations follow it via `beforeSubmit` on the next message, and a persona's `modelPreset` can be overridden by it after a restart.
  - A `route.fallback` entry is used only when `autoFallback` is true; candidates keep the configured order.
- Needs in files it doesn't own:
  - `src/bots/schema.ts`: the loader does not refuse a fallback entry with `autoFallback: false`; there is only a runtime warning.
  - `src/personas/apply.ts` and S26: pass `switcher.liveModelRef()` as `PersonaApplier.baseModel`, or a persona change resets the model to the primary.
- S26 wiring:
  - Per bot, create `ModelSwitcher` and `FallbackEngine`, with `propose` bound to the engine whose rows come from `botRows`.
  - Register `rt.bridge.extend(ui.extension())` in `afterOpen`, after the persona extension.
  - S23's `errors.ts` must map proxy errors to the `fallback.ts` Failure kinds.

## S23: ACP proxy brain (PARTIAL; nothing tested; no plan ticks)
- Build: 0 TS errors project-wide (`.claude/temp/s23-build.txt`). `check:adapter` was not run.
- Written and compiling, all in `src/proxy/`:
  - `errors.ts`: I39 kinds, plus `markedMessage` so Pi's retry regex can't retry non-retryable failures.
  - `limiter.ts`: `ProviderLimiter` / `ProxyLimiters`, limit 1..4 (default 3), per-bot concurrency 1, P0–P3 with aging, a depth cap, abort while queued.
  - `health.ts`: loopback-only endpoint, `/healthz` and `/v1/models`, `ProxyStatus`.
  - `discover.ts`: `matchPresets`, `checkProxy`, `formatSetupReport`.
  - `provider.ts`: `proxyProvidersForBot`, `limitProxyModels`, `createProxyBrain`.
  - `setupCheck.ts`: a user-run command.
- NOT STARTED:
  - `test/proxy/**`: limit never exceeded and P0 before P2; error mapping; the key never appears; a fake proxy that sees only the allowed URLs and no sampling fields.
  - `scripts/proxy/check-port.ps1`: reads `server.port` only from `%APPDATA%\api-acp-proxy\settings.json` and prints only the port; the `PROXY_PORT` env var overrides it.
  - plan ticks and deviations.
- Facts read from the proxy's source (`C:\projects\Personal\api-acp-proxy\src\settings.ts`, `server.ts`; source only, not `settings.json`):
  - `/healthz` returns `{status, uptime_seconds, providers?: {id:{active,queued,max_concurrent,max_queue}}}`, which partly answers U52.
  - The port key is `server.port` (default 8787), overridden by `PROXY_PORT`.
  - The default 503 code is `backend_unavailable`.
- Deviations to record:
  1. A 401 maps to `bad_key` and may fall back after retries; I39 does not cover this case.
  2. `setupCheck.ts` was added; the plan has no such command.
  3. `extraProviders` is optional, since `providersForBot` already builds the `acp-*` providers; this one adds a loopback re-check and an unavailable-preset filter.
- S26 wiring:
  - One `createProxyBrain({presets, secrets, proxyMaxConcurrent, maxQueue, agingMs, redact, onFailure, priorityFor})` per host; spread `extraProviders` and `decorateModels` into `createHarnessBotFactory`.
  - Compose its decorator with S25's gate.
  - Supply `priorityFor`: the default is stream P0 and complete P3; peer-initiated and background turns get P2.
  - Feed `onFailure` into the S22 `FallbackEngine`.
  - Show `status.snapshot()` and `limiters.stats()` in `/status`.
  - Optional npm script `proxy:check`.
- Open point: the Harness's own retry still applies to retryable text, so "wait for Retry-After, retry up to twice" is not exactly enforced.

## S21: BotBus and router (EARLY; no sub-step done; no tests; no plan ticks)
- Written and compiling:
  - `src/botbus/contracts.ts`:
    - types `BotBus`, `BotChannel`, `Envelope`, `EnvelopeDraft`, `ChainInfo`, `AskResult`, `PeerCaps`, `BotRuntime.runPeerTurn`, `PeerTurnContext`, `BusError` (plan codes plus `bad_request`, `unavailable`, `refused`);
    - `parseDraft`, which strips identity and taint claims from a bot's body into `ignoredClaims`;
    - `wrapPeerMessage`, `escapePeerText`, `PEER_PREAMBLE_TEXT`, `peerConversationKey`;
    - only one message type, `ask`, and no "approv*" name anywhere.
  - `src/botbus/capabilities.ts`:
    - `computePeerCaps`: intersects the receiver with every bot on the path and every edge's `allow`, then removes `PEER_FORBIDDEN_TOOLS`, Flow tools, macros and timers; with taint it also removes `TAINT_BLOCKED_TOOLS`; at the hop limit it removes `ask_bot` and `list_bots`; readRoots become `cloud_safe` when the receiver is cloud-capable;
    - `isIngestingTool`, `isForbiddenForPeer`, `summarizePeer`.
- NOT STARTED:
  - `src/botbus/{bus,router,limits,loops,tools,audit,chains,refs,index}.ts`; `chains.ts` and `refs.ts` were added to the plan's file list;
  - `test/botbus/**`, including `fakes.ts` with `FakeBotBus` and `FakeBotRuntime`;
  - plan ticks and deviations.
- S21.1 through S21.5 are all NOT DONE.
- Design decisions (future S21 deviations):
  - Sends are identity-bound: `channel(self).send(draft, {conversationId, callId})`.
  - Bus envelopes always have `origin: "peer"`; only `beginUserTurn` creates a user chain. A send from a conversation with no known chain is a tainted peer chain.
  - Chain persistence stores stamps only, never bodies, through a `ChainStore` (in memory or file-backed), so `contextOf` returns the same chain and taint after a restart.
  - The guard hook is `bus.guard(bot, conv, tool, {peerConversation})`; `bus.noteToolUse` taints on content-ingesting tools.
  - The message budget counts asks, not replies.
- S26 wiring:
  - `createBotBusExtension({bus, self})` into `extensionsFor`; `bus.register(id, runtime)` in `afterOpen`;
  - `beginUserTurn` on each user message; `guard` and `noteToolUse` from the a7 guard;
  - the `PEER_PREAMBLE_TEXT` preamble; a peer turn applies `caps.tools` and `caps.readRoots`.

## S25: GPU gate (PARTIAL; core done and tested; no plan ticks)
- Tests: 24 of 24 pass in `test/gate/{queue,gate}.test.ts`. `src/gate/**` and `test/gate/**` compile with 0 errors.
- DONE (S25.1 core): `src/gate/{clock,queue,gate}.ts`.
  - Four priority classes with aging; one gate per runner; per-bot concurrency 1; the depth cap refuses P2 and P3 only.
  - Stickiness after a tool-use call; abort while waiting; `release({aborted})`.
  - Wait notice for P0 and P1 after `waitNoticeSec`, at most once per bot per 60 s.
  - The tests cover the S25.1 done-check plus a 120-request random schedule.
- Written but UNTESTED:
  - `models.ts`: `createGateDecorator({gate, hints})`, the `decorateModels` hook, gating only `lmstudio` and `strata`;
  - `hints.ts`: `PriorityHints.begin` (default P2 for turns, P3 for `complete*`);
  - `status.ts`: `localTopology`, `queueDepths`, `botGateView`, `gateStatusLines`;
  - `stream.ts`: a duck-typed stand-in for Pi's event stream.
- NOT STARTED:
  - `test/gate/models.test.ts`: slot held until the stream ends; pass-through of other methods and ungated providers; `/stop` and aborts freeing the slot; busy turned into an error event; a crashing stream releasing the slot; `complete*` at P3;
  - tests for `hints.ts` and `status.ts`, including the `localBotsOnStrata` refusal;
  - S25.3 live measurements ([GO]);
  - plan ticks and deviations.
- Deviations to record:
  - S25-1: the adapter has no export for Pi's stream class, so `stream.ts` duck-types it with one cast. Optional fix: export `createAssistantMessageEventStream` from `src/pi/adapter.ts`.
  - S25-2: the wait notice has a 60 s per-bot cooldown.
  - S25-3: P0 and P1 are never refused by the depth cap.
- S26 wiring:
  - One `LocalGate` with `resolvedBots.gate`. `onWait` needs a late lookup by bot id, because a bot's `rt.bridge.notifier` exists only after the bot is built.
  - One `PriorityHints`; `decorateModels: createGateDecorator({gate, hints})`, composed with S23's decorator.
  - Wrap each turn in `hints.begin`: P0 for a Telegram user message, P1 or P2 for peer turns, P2 for background turns.
  - Feed `gateStatusLines` and `localTopology` into `/status`.
- Reported problem (now resolved): `check:adapter` failed on S24's test file. S24 fixed it and reports `check:adapter` PASS.

## S24: bot room mirror (S24.1 and S24.2 DONE offline; S24.3 is a user step)
- Tests: 31 of 31 pass in `test/botroom/{format,mirror,inbound}.test.ts`. `check:adapter` PASS on both checks.
- Files: `src/botroom/{format,mirror,index}.ts`, `test/botroom/{helpers,format.test,mirror.test,inbound.test}.ts`.
- plan.md: S24.1 and S24.2 ticked, with deviation "S24-1". The section 14 S24 rows are NOT added.
- S24.1, the mirror:
  - Line format `[from → to, hop n, chain id8] text…`; batches of up to 5 lines per post.
  - Rate limiting: posts spaced at 60/maxPerMinute with a sliding-window guard, capped at 20 per minute; a bounded queue (a burst of 100 gives 15 posts plus one "dropped" line).
  - Failures: a 429 waits `retry_after` and retries once; other failures are dropped and counted.
  - Redaction runs before truncation.
  - Only ask, reply, refused and failed events are mirrored. It uses only `Api.sendMessage`: no `getUpdates`, no handlers.
- S24.2: inbound drops tested. The code was already in S20's `allowlist.ts`.
- S24.3: user's live step (create the mirror bot and the room; record U55). UNTESTED.
- Deviations to record:
  - S24-1: S21's bus did not exist yet, so S24 defined its own read-only `BusAuditSource { subscribe(listener) → unsubscribe }` with `BusAuditEvent { kind, from, to, hop, chainId, text?, reason? }`.
  - "summary" mode shows the first line, at most min(maxChars, 80) characters; "truncated" shows up to maxChars.
- S26 wiring:
  - Once the bus exists, call `startBotRoomMirror({botRoom, mirrorToken: secrets.mirrorBotToken, source, logger, redact})`. It returns undefined when the room is disabled. Call `.stop()` on shutdown.
  - `source` adapts S21's audit stream to `BusAuditSource`, passing text or a short reason only, never taint, body fields or approvals. Add one test with S21's `FakeBotBus`.
- Housekeeping: S24 reported a possible stray `python -` process (an empty heredoc) that it was not allowed to kill. It is left for the user to check.

## Build state at pause
- S24 saw one TS error, `src/models/routes.ts(22,53)` TS4104 (S22's file). S22's own `tsc --noEmit` afterwards reported 0 errors, so it may have been fixed by S22's last edit. Re-check with a clean build first on resume.
- The full `npm test` was not run after S21–S25 started. The last full run (after S20) was 1116 tests: 1115 pass, 1 skipped.
