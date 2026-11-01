# Changelog: agent-007 on Pi Durable (2026-10-31)

Nothing here was run live. Everything is offline-verified (stub models, no Telegram, no real claude/dsh).

## Built per phase

- **Phases 0 and 1 (MVP):** Pi Durable agent with Telegram interface, local models, 10 always-loaded tools (I27), adapter boundary (only `src/pi/adapter.ts` imports `@earendil-works/*`). Checklist: `phase1-acceptance.md`.
- **Phase 2 (orchestrator, job runner):** job runner with Claude Code and DeepSeek drivers, routing eval harness (`routing-eval-results.md`, no live result). Checklist: `phase2-acceptance.md`.
- **Phase 3 (settings UI, personas):** settings UI on port 47008, persona presets, `termsAccepted` ack-check fix in `src/jobrunner/settingsUi/routes.ts`. Checklist: `phase3-acceptance.md`.
- **Phase 4 (multi-bot, S20 to S26):**
  - S20 bot foundation: `BotManager`, bots schema, allowlist, per-bot ACL rows.
  - S21 BotBus and router (`src/botbus/**`): identity-bound sends, peer envelopes, persisted stamps only.
  - S22 model presets and switching (`src/models/**`, `src/telegram/modelUi.ts`).
  - S23 ACP proxy brain (`src/proxy/**`, `proxy:check`).
  - S24 bot room mirror (`src/botroom/**`).
  - S25 GPU gate (`src/gate/**`).
  - S26 integration: `startMultiBot` (`src/agent/multibot.ts`), `busGuard.ts`, `peerRuntime.ts`, `prompts/peers.md`, integration tests.

## 2026-10-31 additions

- **Piece 8a, S27 eval harness:** `scripts/multibot-eval/**` (36 prompts x 3 runs, stub runner only) and `phase4-acceptance.md` (live checklist S27.2). Deviations 107 to 113, row 124.
- **Piece 9a, Phase 2 gap fixes:** claude version guard enabled in `createDriver` (`src/jobrunner/drivers/claude/index.ts:32-42`, persisted to `<dataDir>/claude-version-guard.json`); driver uses `engines.claude.path` as its command; `dsh:probe` CLI (inert without `--live`). Deviations 120 to 123.
- **Piece 9b, polish pass:** `README.md` written (requirements, build/test, install order, scripts, layout); `/help` lists all 9 commands; unknown-command reply now "Send /help for the list."; `.claude/temp/` scratch cleanup (234 to 128 files). See `polish-verdict.md`.

## Verification

director-checker re-ran: `npm run build` 0 errors; `npm test` 1415 tests, 1414 pass, 1 skipped (symlink); `npm run check:adapter` PASS. Architecture checks PASS: adapter boundary, ACP boundary, I27, I36, no paid API key.

## Status list

**DONE offline:** Phases 0 to 3, S20 to S26, S27 harness and checklist (stub only), Phase 2 gap fixes (guard, claude path, dsh probe CLI), polish pass, verification.

**NOT DONE:**
- Live S27 eval.
- Live Flow estimator (U38).
- S15.3 (second-opinion endpoint).
- S19.6 (private-chat topics).
- `propose_skill` tool.
- Adapter export `createAssistantMessageEventStream` (deviation 106).
- Retry wrapper (deviation 98).
- Bus-audit ACL row and grant (deviation 102).

**UNTESTED:** every live check, gates G0 to G4, U49 to U59, S24.3, S25.3, S27 live, dsh probe live, claude guard live.
