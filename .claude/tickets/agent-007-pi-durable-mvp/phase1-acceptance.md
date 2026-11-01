# Phase 1 acceptance checklist (Gate G1)
> **Live order (2026-11-01, deviations 189 to 191):** local Strata and offline checks first, then the Milestone 2 web UI, then the Tailscale test, then Telegram. Every Telegram or phone item below is **DEFERRED until after M2 web UI + Tailscale (deviation 191)**. Admin, ACL and install steps stay your steps. P0.1 is closed (Node via fnm, deviation 189). UI-10: the per-agent default brain is the ACP proxy (Sonnet or Opus), set in Milestone 2; Strata `qwen3.8-flash-next-iq3_s` stays the local eval and fallback model (deviation 190).

You run this. Nothing in it was run on the real deployment: the code and every offline check are done (see plan section 14), but the live runner, the real Telegram bot, the scheduled task, the reboot and `node.exe` kills need you. Record each result in the "Result" column. G1 passes when every item below is PASS, `check-acl.ps1` exits 0 and the Phase 1 items of plan section 9 are ticked. Then ask for `changelog.md` and for Phase 2 to start.

Paths below use the defaults (agent user `agent007`, data root `C:\Users\agent007\AppData\Local\agent-007`). If your `config.json` uses other values, use those. Read the agent's logs and audit files from an **elevated** PowerShell (the agent profile is not readable by your normal user).

```powershell
$data   = 'C:\Users\agent007\AppData\Local\agent-007'
$audit  = Get-ChildItem "$data\audit\shell-*.jsonl" | Sort-Object Name | Select-Object -Last 1
$log    = Get-ChildItem "$data\logs\agent-*.jsonl"  | Sort-Object Name | Select-Object -Last 1
Get-Content $audit.FullName | ConvertFrom-Json | Format-Table ts, event, id, approved, by, exitCode -AutoSize
Get-Content $log.FullName -Tail 40
```

## 0. Before you start: Gate G0 and install (user steps, all open)

These come from the plan (sections 5 and 6, Slice 7). None was done by the implementers.

| Step | What you do | Done |
|---|---|---|
| P0.1 | CLOSED by decision 2026-11-01 (deviation 189): Node 24.14.0 via fnm, no machine-wide install. | closed |
| P0.3 / P0.3b | Harden LM Studio (auth on, loopback, logs). Optionally start Strata by hand for tests. | |
| P0.4 | Run the smoke scripts on the real runner: `npm run smoke:all` (S1 to S7). Write `phase0-report.md`. | |
| P0.5 | Run the bake-off, `npm run bakeoff`; write `bakeoff-results.md`. Set `contextWindow` and `maxTokens` in `config.json` from it (keep `contextWindow` at least 8K below the runner's loaded context). | |
| P0.7 | Optional: the 24/7 Strata spike. | |
| UI-10 | Decide the runner and model (LM Studio or Strata). Set `model.runner` and the model id in `config.json`. Decided 2026-11-01 (deviation 190): default brain is the ACP proxy (Sonnet or Opus), per agent, in Milestone 2; Strata stays the local eval and fallback model. | |
| UI-1, UI-2, UI-4, UI-8 | Fill `config.json`: allowed folders, deny paths, your numeric Telegram id (`node dist/scripts/whoami-telegram.js`), and `USER.md`. (the Telegram id lookup is DEFERRED until after M2 web UI + Tailscale (deviation 191)) | |
| UI-3 | Create the Telegram bot in BotFather (`/newbot`, then `/setjoingroups` Disable). Type the token only into the secrets prompt. **DEFERRED until after M2 web UI + Tailscale (deviation 191).** | |
| S7 | From an elevated shell, in order (see `deploy\README-ops.md`): `setup-agent-user.ps1`, `grant-folder-acls.ps1`, `new-secrets.ps1 -Runner <runner>`, `deploy-app.ps1`, `register-task.ps1`, then `check-acl.ps1` (exit 0). With Strata: `register-strata-task.ps1`. Try `-WhatIf` first. | |
| Start | `Start-ScheduledTask -TaskPath '\agent-007\' -TaskName 'agent'`, then send `/status` from your phone. **Phone part DEFERRED until after M2 web UI + Tailscale (deviation 191).** | |

## 1. Offline pre-checks on the dev PC (already green; rerun after any change)

```powershell
cd C:\projects\Personal\agent-007
fnm exec --using default cmd /c "npm run build"          # 0 errors
fnm exec --using default cmd /c "npm test"               # all pass; 1 symlink test may skip with a printed reason
fnm exec --using default cmd /c "npm run check:adapter"  # ADAPTER BOUNDARY PASS
```

| Item | Result |
|---|---|
| S8.1 `npm test`: zero failures, zero skips except the symlink test (it needs developer mode or admin) | |

## 2. S8.2 Manual `@runner` suite (real runner, fake Telegram)

(Runs against the local runner with a fake Telegram, so it is NOT deferred. Only an end-to-end variant that needs real Telegram is DEFERRED until after M2 web UI + Tailscale (deviation 191).)

Needs the runner up, and the dev files `%LOCALAPPDATA%\agent-007-dev\config.json` and `secrets.json` (the same ones the smoke scripts use). It contacts only the local runner, never Telegram.

```powershell
cd C:\projects\Personal\agent-007
fnm exec --using default cmd /c "npm run e2e:runner"                 # the configured runner
fnm exec --using default cmd /c "npm run e2e:runner -- --runner strata"   # or the other one
```

Expect six lines `E2E <check> PASS` (question, shell-approve, shell-deny, new-gated, restart-deadline, remember) and `E2E SUMMARY 6/6`. A small model may skip a tool call: rerun once, and report a repeat failure as FAIL with the printed reason.

| Item | Result |
|---|---|
| S8.2 `E2E SUMMARY 6/6 passed` on the G0-picked runner | |

## 3. S8.3 Acceptance on the real deployment, from your phone (DEFERRED until after M2 web UI + Tailscale (deviation 191))

Use your own Telegram account and the bot. For each item write PASS or FAIL and where the evidence is.

| # | Do this | Expect | Evidence | Result |
|---|---|---|---|---|
| 1 | Ask "How much free disk space is on C:?" | A correct answer (it uses `system_facts`). | The chat. Compare with `Get-PSDrive C`. | |
| 2 | From a second Telegram account, or in a group, message the bot. | No reply. One `warn` log line `telegram.dropped`, with no message content. | `Select-String telegram.dropped $log.FullName` | |
| 3 | Ask it to read a file outside the allowed folders (for example `C:\Windows\win.ini`), and a denied path nested inside an allowed folder. | Both refused ("access denied"). | The chat, and the agent log. | |
| 4 | Ask "Run `whoami`." | An approval card with the full command. Tap Approve. It runs and the answer shows `<pc>\agent007`. | The chat. | |
| 5 | Ask for another command and tap Deny. | Blocked, the agent says it was not run. | The chat. | |
| 6 | **Timeout.** In `config.json` set `shell.approvalTimeoutSec` to 60 (elevated edit), restart the task. Ask for a command and do not answer. Restore the value afterwards (and restart). | The card turns to "Expired", the command is denied at about 60 s. | Audit: `decided` with `by: "timeout"`. | |
| 7 | Read the shell audit file after items 4 to 6. | `requested` and `decided` lines for each; `started` and `finished` only where it ran (item 4). The audit holds **shell events only**: items 2 and 3 are in the agent log, not here. | `$audit` (command above). | |
| 8 | **[GO]** With an approval card pending: `Stop-ScheduledTask -TaskPath '\agent-007\' -TaskName 'agent'` then `Start-ScheduledTask ...`. | A new card arrives; the old card's buttons answer "Expired"; the "Expires" time is unchanged. | Two `requested` audit lines with the same `deadline` value. | |
| 9 | Send `/killshell` with a card pending. Then ask for a command. Then `/status`. | The pending card is cancelled. The next request is blocked at once with no card. `/status` says shell disabled. Deleting `<controlDir>\shell-disabled` (and restarting the task) re-enables it; Telegram cannot. | Audit: `blocked` lines. The flag file. | |
| 10 | Say "Remember that my favourite drink is tea." Then `/new` and ask "What is my favourite drink?". | `MEMORY.md` gains a line; the chat shows "Saved to memory: ...", once; after `/new` it knows. | `Get-Content "$data\memory\MEMORY.md"` | |
| 11 | **[GO]** Ask for a long answer ("write 600 words about tea"). While it streams, end `node.exe` of the agent in Task Manager (or `Stop-Process` as the agent user). | Within 5 minutes the answer arrives, possibly once duplicated. | The chat; the agent log shows a restart. | |
| 12 | **[GO]** Reboot with nobody logged on (leave the PC at the sign-in screen). From your phone send "hello" a few minutes later. | The agent is back. With Strata as the runner it answers. With LM Studio it either answers (if your UI-6 route lets it) or says "The model is offline" and answers after you log on and LM Studio starts. | `Get-ScheduledTask -TaskPath '\agent-007\'`; the chat. | |
| 13 | **Secrets and ACLs.** (a) As your normal (non-elevated) user, try `Get-Content C:\ProgramData\agent-007\secrets\secrets.json`. (b) Ask the agent to `read_file` that path. (c) Approve a shell `New-Item "C:\Program Files\agent-007\x.txt"`. (d) `read_file`/`list_dir` on `D:\Strata-data`, the Strata config copy, the Strata log and `~\.lmstudio`. (e) Approve a shell `Get-ChildItem C:\Users\<you>\.lmstudio`. (f) Strata only: approve `New-Item D:\Strata\x.txt`, and `curl` the model URL without the key. | (a) access denied. (b) refused by policy. (c) fails (no write). (d) refused by policy. (e) access denied, while Strata keeps running (group (b) paths have no NTFS deny). (f) fails (no write); the key-less request gets an auth error when a key is set. | The chat and `check-acl.ps1` output. | |
| 14 | `/status`, then a long question and `/stop`. | `/status` lists runner and model, up or down and since when, busy or idle, shell state and why, pending approvals, uptime and last error. `/stop` ends the answer. | The chat. | |

## 4. Gate G1 closing items

| Item | Result |
|---|---|
| `deploy\check-acl.ps1` exits 0 on the real layout (run elevated) | |
| Plan section 9: every Phase 1 item ticked (Telegram, secrets, runner, folder access, shell, kill switch, prompt injection, approval hook in the host default, dependencies) | |
| `package-lock.json` and the code are committed on the branch (you decide when; nothing was committed by the implementers) | |
| Machine-scope Node install and the `ExperimentalWarning` for `node:sqlite` accepted (Node 24.14 prints it at start; harmless) | |

## 5. Known limits to keep in mind while testing

- A real `Ctrl+C` / `SIGINT` stop was not exercised: on Windows a child process cannot be sent a signal, and the scheduled task ends the process hard. The shutdown path was tested through a fake process and an IPC `shutdown` message; the durable resume covers a hard stop.
- The offline restart tests stop the process gracefully (Harness closed). A hard `kill -9` is item 11 above and the Phase 0 S4/S5 smoke scripts.
- The `beforeRequest` health-gate fallback (S1.5) was not built; build it only if Phase 0 smoke S7 FAILS on the real runner (a request sent while the runner is down must wait and complete).
- `shell.enabled` and the other config values are read at start; changing `config.json` needs a task restart. The kill-switch flag file is checked live.
