# Polish verdict (piece 9, read-through pass)

Nothing live was exercised: no model call, no Telegram, no job runner, no claude/dsh, no service started. This is a read-through plus offline checks.

## Verification (2026-10-31)
- `npm run build`: exit 0. `npm test`: 1415 tests, 1414 pass, 0 fail, 1 skipped (symlink). `npm run check:adapter`: PASS (adapter and ACP boundaries).
- Outputs: `.claude/temp/build-9b.txt`, `test-9b.txt`, `adapter-9b.txt`.

## Fixed
- `README.md` was a one-line title. It now has requirements, build/test, install order (pointing at `deploy/README-ops.md`), usage, npm script table and layout.
- `/help` (src/telegram/commands.ts) listed 4 of 9 commands. It now lists all: /new, /stop, /status, /model, /persona, /settings, /proposals, /applysettings, /killshell.
- Unknown-command reply (src/telegram/bot.ts) was a stale partial list that omitted /model; it now says "Send /help for the list." (test still matches `^Unknown command`).
- Scratch cleanup in `.claude/temp/`: removed dbg*.mjs, plan-edit.mjs, s2x/s3/s11 build and test outputs, b*/c*/e*/t*/h-* txt and log files, base-/final-* outputs, the old *-9a.txt outputs. 234 files down to 128 (before my own -9b outputs).

## Reviewed, no change needed
- No TODO/FIXME/debugger. `console.log` only in CLI entry points and eval scripts where it is the output. The settings UI JS has no debug output.
- Telegram error replies are short and consistent; callback toasts are consistent ("Approved", "Expired. A new request was sent.").

## Left for the user to decide (not changed)
- Unsure about in `.claude/temp/`, not deleted: the one-shot edit*/patch*/fix*/s4fix* scripts, plan-edit*.cjs, plan-*.mjs, apply-plan.mjs, plan.before-s15.md, dxdiag.txt, acl-probe.ps1, probe.mjs, show.mjs, types.cjs, plan-parts.txt, rows.txt, matrix.md, gen-matrix.mjs, phase2-contracts.md, s11-core-contracts.md, and the subfolders (config, ui, multibot-eval, soak, tsprobe, fx1). Most look dead; none is referenced by the build. Kept: plan.bak.md, s20-contracts.md.

## Remaining, ranked
1. Every live gate is open (G0 to G4, U49 to U59, S24.3, S25.3). Nothing about real model behaviour, Telegram delivery, ACLs or the scheduled tasks is known. S27 eval and acceptance not run.
2. Known Phase 2 gaps: there is no live Flow estimator (U38); dsh stays refused until probed live (U39); S15.3 and S19.6 not built. Fixed since this pass (piece 9a): the claude version guard is enabled in `createDriver` (`src/jobrunner/drivers/claude/index.ts:32-42`, persisted to `<dataDir>/claude-version-guard.json`), the driver uses `engines.claude.path` as its command, and the `dsh:probe` CLI exists (inert without `--live`). The guard and the probe are untested live.
3. Open decisions from the handoff: retry semantics (deviation 98), bus-audit ACL row (deviation 102), persona preset drift, shared `prefs.json` race check.
4. Docs: no live-tested install walkthrough; README and `deploy/README-ops.md` are written from the scripts, not from a real install. The BotFather command menu (`setMyCommands`) was not checked against the new /help list.
5. The `smoke:*`, eval and `bakeoff` npm scripts call real local models; the README says so, but there is no guard.

## Verdict
polished enough for a first live install: yes, with conditions. The code builds clean and the offline suite is green, the user-facing text is now consistent and there is a README. It is not proof of working: the first live install should be supervised, start with `-WhatIf` runs, `check-acl.ps1` and the phase 1 acceptance checklist, and expect to fix issues the offline tests could not reveal.
