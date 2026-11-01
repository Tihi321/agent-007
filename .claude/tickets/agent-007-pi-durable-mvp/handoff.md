# Handoff: agent-007 on Pi Durable (refreshed 2026-11-01, paused mid-gate work; live S27.1 PASSED, smoke 6/7)

Offline build is finished. Latest gates (2026-10-31): `npm test` 1450 tests, 1449 pass, 1 skipped (symlink); `check:adapter` PASS. Today: pieces 8a, 9a, 9b, 10, 11, 12 to 20 done (see REQ-0007 log), deviations up to 186. Live S27.1 multi-bot eval PASSED: Strata, `qwen3.8-flash-next-iq3_s`, 100/108 (92.6%), safety 45/45, max 5 tool calls (`multibot-eval-results.md`). Earlier LM Studio `nail-qwen3.6-35b-a3b-mtp` run FAILED at 74.1% before eval fixes. UI-10 (G0 model) is still the user's pick; Strata `qwen3.8-flash-next-iq3_s` is suggested.

The user paused again on 2026-11-01. Nothing is running, no processes left, nothing committed, no source edits since the last handoff.

**S4 crash-resume root cause (analysis, from `.claude/temp/smoke/s4/a/a7.sqlite`): NOT a resume bug.** Resume worked: no duplicate submit, `pi.generation` restarted, fresh request at seq 15. The resumed run was still streaming at the timeout (960 partial revisions, about 10,144 chars of thinking, about 694 chars of answer). The model reasons even with thinking off, and the 600-word prompt needs about 3,300+ tokens against `maxTokens` 4096. Harness cause: `scripts/smoke/s4-crash-resume.ts` uses `opts.timeoutMs` (default 180000, line 157) for both the parent wait and the stream timeout. Not ruled out: an orphaned Strata sequence from the killed child (U28) slowing the resumed request.

**Resolved 2026-11-01:** stall-based wait chosen and built (deviation 187); S4 PASS live.

Strata was down during this pause (`/health` connection refused). The user must start it before any live re-run.

## Gate work in progress ("G0 to G4, and all on milestone 1")

Scout found 88 open items: A 11 (agent-doable offline), B 13 (live on Strata), C 64 (user-only).

- **A, all done, PASS:** P0.2 PASS; U52 7461 appears only in a comment; S13 dsh refused PASS; G3 rollback rehearsal PASS; stale records fixed.
- **B, live on Strata:**
  - P0.3b PASS (/health, /v1/models, n_ctx 131072).
  - Report: `phase0-report.md` (partial). Logs: `.claude/temp/gate-smoke.txt`, `.claude/temp/smoke/*.json`.
  - NOT RUN: P0.5 bakeoff, S16.1 routing eval, G3 settings-eval. Scripts only hit the model runner and use fake tools. Pass `--runner strata --model qwen3.8-flash-next-iq3_s` explicitly.
- **Held for the user's go:** S23 `proxy:check`, S25.3 GPU measurements, real `claude` runs, anything contacting Telegram.

## Piece 23 done (2026-11-01)

- S4 crash-resume PASS live on Strata (`qwen3.8-flash-next-iq3_s`): 61 s kill-to-done (deviation 187, stall-based wait). P0.4 is now 7/7.
- `tools` config key classified as security in `src/settings/split.ts` (deviation 188); migration of the example config rehearsed OK.
- `npm test`: 1456 tests, 1454 pass, 1 fail (`check-jobrunner`, under investigation), 1 skipped (symlink).
- User decisions 2026-11-01 recorded as deviations 189 to 191 (plan section 14): Node via fnm (P0.1 closed); per-agent default brain = ACP proxy Sonnet/Opus, deferred to Milestone 2 (Anthropic to be added to the proxy), Strata stays the local eval and fallback model; live gate order below.

## Resume here (ordered)

Live gate order (deviation 191): M1 offline and local Strata checks, then M2 web UI, then Tailscale test, then Telegram.

1. Investigate and fix the failing `check-jobrunner` test; rerun `npm test` (target: only the symlink skip).
2. Local Strata checks, one at a time, with Strata running and the user's go: P0.5 bakeoff, S16.1 routing eval, G3 settings-eval. Pass `--runner strata --model qwen3.8-flash-next-iq3_s` explicitly. Then update plan section 14 and `phase0-report.md` (still partial).
3. Milestone 2 web UI (`.claude/tickets/agent-007-milestone2/plan.md`): includes the per-agent default brain (ACP proxy Sonnet/Opus) and adding Anthropic to the ACP proxy.
4. Tailscale test, then Telegram.
5. User steps that do not need Telegram stay open (admin, ACL, install: P0.7 Strata spike, UI-1/2/8 config, S7 admin install with `-WhatIf` first, `check-acl` exit 0, G3 migration and ACL spike). P0.1 is closed (fnm).
6. DEFERRED until after M2 web UI + Tailscale: every Telegram or phone live item. G1 UI-3 BotFather, UI-4 id lookup, S8.3 phone 1 to 14, `/status`; G2 S10.4, S12.3, S12.4, S16.2 phone items; G3 sections 4 and 5 phone checks; G4 items 1, 3, 4, 5 (and 2, 6, 7, 9); S24.3; U49, U50, U54. Each acceptance file has a banner saying so.
7. The live S27.1 eval is DONE (Strata); rerun only if the brain/model for the eval changes:
   `node dist/scripts/multibot-eval/run.js --mode live --confirm-live --runner strata --model <model id> --label rerun --results .claude/tickets/agent-007-pi-durable-mvp/multibot-eval-results.md`
   Bar: at least 90% overall, 100% on the 15 safety cases, no run over 8 tool calls.

## Open decisions and questions

- UI-10: DECIDED 2026-11-01 (deviation 190), default brain ACP proxy Sonnet/Opus per agent in Milestone 2; Strata is the local eval/fallback.
- ME3/ME6 eval case fix and re-run.
- Commit: whether, and on which branch.
- Retry semantics (deviation 98): accept, or ask for a retry wrapper (honour `Retry-After`, two tries).
- Bus audit ACL (deviation 102): `<dataDir>\bus-audit\` and `<dataDir>\bus\chains.json` need a `check-acl.ps1` row and the append-only grant.
- Persona preset drift: may a persona's `modelPreset` and `bots.<id>.activePreset` diverge after restart?
- Shared `prefs.json`: check it is race-free across bots.
- Leftover one-shot scripts in `.claude/temp/` (list in `polish-verdict.md`, "Left for the user to decide").

## Milestone 2 (planned only)

Plan at `.claude/tickets/agent-007-milestone2/plan.md` (REQ-0008, Tailscale web UI, decisions UI-33 to UI-44). Plan only; it starts after the Milestone 1 live gates pass. Request log: `.claude/director/requests/REQ-0008-milestone2-tailscale-web-ui.md`.

## Repository state

- Branch `agent-007-pi-durable-mvp`, base `master`, HEAD `6085da6`. All work is untracked and uncommitted (only `README.md` modified). Commit only when the user asks (Bash heredoc message, never silently create a branch, never force-push, never commit `.claude/director/`).

## Status by phase

| Phase | Offline status | Evidence | Acceptance file |
|---|---|---|---|
| 0 and 1 (MVP) | DONE offline; live smoke 7/7 (S4 PASS after deviation 187) | 333 tests at the time | `phase1-acceptance.md` |
| 2 (job runner) | DONE offline, gap fixes done | 814 tests at the time | `phase2-acceptance.md` |
| 3 (settings UI, personas) | DONE offline | 1047 tests at the time | `phase3-acceptance.md` |
| 4 S20 to S26 | DONE offline | 1397 tests at S26 | plan section 14 |
| 4 S27 | harness, checklist and live S27.1 eval DONE (PASS) | 100/108, safety 45/45 | `phase4-acceptance.md`, `multibot-eval-results.md` |
| Polish, verification, changelog | DONE | 1450 tests, 1449 pass, 1 skipped (symlink); `check:adapter` PASS | `polish-verdict.md`, `changelog.md` |

Gates G0 to G4 are open. The skipped test is the symlink test (needs Windows developer mode).

## NOT DONE

Failing `check-jobrunner` test (investigating); P0.5 bakeoff; S16.1 routing eval; G3 settings-eval; live Flow estimator (U38); S15.3; S19.6; `propose_skill`; adapter export `createAssistantMessageEventStream` (dev 106); retry wrapper (dev 98); bus-audit ACL row and grant (dev 102).

## UNTESTED

Gates G0 to G4, U49 to U59, S24.3, S25.3, S27.2 live acceptance steps, dsh probe live, claude guard live, S23 proxy, Telegram paths.

## Key decisions and facts

- Only `src/pi/adapter.ts` imports `@earendil-works/*`. I27: exactly 10 always-loaded tools per bot; `ask_bot` and `list_bots` are deferred.
- Rejected jobs are not reported back to the model. Taint rule kept as built (deviation 80, I36(3)).
- A paid API key is never a brain or fallback. Flow needs per-job credit approval.
- Peer turns never get shell, file write, `dispatch_job`, Flow or `remember` (I36).
- Settings UI port 47008 (47007 is the job runner IPC).
- I44 priorities: P0 user message; P1 peer turn in a user-started chain; P2 other peer turns and injected job results; P3 summaries.

## Tooling notes

- Node v24.14.0 via fnm. `fnm exec --using default npm` can fail with "program not found"; put the fnm Node directory on PATH instead. From PowerShell `fnm exec --using default cmd /c "npm run build"` worked earlier.
- Redirect long `npm` output to a file under `.claude/temp/`; piping into `tail` has hung background shells.
- The footgun-30 test greps `src/` for `extensions\s*:` on code lines, so name parameters `installs`.
- Never write the literal ACP SDK package prefix outside the two allowed folders (see `.claude/temp/s20-contracts.md`).

## Hard rules (from the user)

- Pixotope and work data are off-limits. Every shell command needs the user's approval; install or start nothing without asking.
- Tokens never pass through chat. Never read `~/.lmstudio`, `.env`, secret files or `*.jsonl` transcripts.
- Never modify `D:\Strata` or `D:\Strata-data`; never touch the creative-hub repo or start its services.
- Never run the real `claude` or `dsh`, contact Telegram, or call the real proxy without the user's go. Never use bypassPermissions or auto permission modes.
- No system changes (users, ACLs, scheduled tasks, firewall, registry). Write and dry-run scripts; the user runs them.
- Use they/them for the user.

## Files in this folder

- `plan.md` (about 420 KB; do not read whole; section 14 is the verification log, grep it).
- `changelog.md`, `polish-verdict.md`, `phase0-report.md` (partial), `phase{1,2,3,4}-acceptance.md`, `routing-eval-results.md`, `multibot-eval-results.md`, `phase3-detail.md`, `phase4-pause-notes.md` (historical).
- Request logs (never committed): `C:\projects\Personal\agent-007\.claude\director\requests\REQ-0007-implement-plan.md`, `REQ-0008-milestone2-tailscale-web-ui.md`.
