# Handoff (agent-007)

## Repo state (verified)
- Main checkout: `C:\projects\Personal\agent-007`, branch `master` at `544ba5a` (M2, model-sources, web-ui-redesign, extras all merged).
- Uncommitted: modified `.claude/tickets/agent-007-milestone2/claude-sonnet-eval-results.md`; untracked `.claude/tickets/agent-007-pi-durable-mvp/s27-strata-eval-results.md`, `.claude/tickets/agent-007-windows-exe/`, `.claude/worktrees/`.
- Worktree (locked): `.claude/worktrees/agent-a7ea26c48b3214ab6` on `agent-007-eval-prompt-fixes` at `7802ad0`, clean tree, 4 commits ahead of master.

## Done
M1, M2, yarn local run, model sources (ACP proxy models, LM Studio, fetch models), Strata evals (s27-strata-eval-results.md), web UI redesign, markdown fix + extras, Sonnet comparison (claude-sonnet-eval-results.md).

## In progress: eval prompt fixes
Branch `agent-007-eval-prompt-fixes` commits so far: S3 (never copy a job path into ask_user; Pixotope path/safety), S1 (fake prefs start at verbosity normal; no style card), S7 (propose_persona no hidden preset id; no persona card), D3 (list_templates shows param descriptions), ME1 (skipping a doomed third ask also passes). S3/S1/S7 failed on both models; D3 and ME1 on Sonnet only.
The agent stopped on a usage limit mid Sonnet routing eval rerun.
Next:
1. Inspect the worktree (git log/diff; outputs in `.claude/temp/strata-evals` and `.claude/temp/ma4`).
2. Discard any runs with limit errors.
3. Finish reruns: Sonnet routing, settings, multi-bot; Strata routing, settings.
4. Write `eval-prompt-fixes-results.md` with before/after scores.
5. ASK the user before merging.

## Planned only (do NOT build until user says go)
Windows exe: `.claude/tickets/agent-007-windows-exe/{research,plan}.md`. Electron tray launcher, NSIS per-user installer plus portable exe, bundled node.exe, data in `%LOCALAPPDATA%\agent-007` with root.json picker, `--personal` flag skips settings ACL check; tasks T4, T7, T5, T6. Director request REQ-0012.

## User's live testing pending
Rebuild/restart web:local; redesign checklist WU1-WU12 (`.claude/tickets/agent-007-web-ui-redesign/plan.md` section 10); Models page UM1-UM8; passkeys/invites; bus-audit admin ACL script.

## Last
Tailscale (G6b), then Telegram.

## Environment
- Node via fnm (`fnm exec --using default ...`), Yarn 4 via corepack.
- `.local/` dev data (`yarn setup:local`, `yarn web:local`); gateway 127.0.0.1:47009, settings 47008, runner 47007.
- ACP proxy 127.0.0.1:8787 (`C:\projects\Personal\api-acp-proxy`), Strata 8080, LM Studio 1234. Proxy Claude shares the Max usage limit with Claude Code.

## Constraints
Subscription only, no paid calls; never print secrets or the proxy key; do not touch `.local/` or the running gateway on 47009; never force-push; builds in worktrees, merges in main checkout git-only; director mode: request files only via director-scribe, plans need user yes.
