# REQ-0017: Open source agents vs agent-007 (memory, routines, worktrees, skills)

Question: check Hermes Agent, n8n Nod and other open source agents; compare features (memory, routines, worktrees, ...) with
agent-007; say what we could adopt.
Date: 2026-11-11/12. Labels: [V] read on an official page or in our code, [I] inferred or secondary.
Earlier work this builds on: REQ-0013 (OpenBot), REQ-0015 (Nod), REQ-0016 (recurring tasks plan, draft, not implemented).

## Answer

agent-007 is ahead on hardening (approval on every shell/job, low-privilege install, audit chain, taint tracking, durable
runtime) and behind on four product features that almost every other agent now has: schedules, a real memory, skills, and
isolated parallel coding work. None of the others is a replacement (none has our Windows-native, local-first, approval-first
design), but their mechanisms are small and well documented, so we can copy the designs. Order to adopt: (1) recurring tasks,
(2) memory upgrade, (3) worktree per coding job, (4) skills, (5) approval scopes.

## 1. Where agent-007 stands today (inventory on master 1d1591f, [V])

| Area | State | Evidence |
|---|---|---|
| Memory | partial: `remember` appends dated notes to MEMORY.md (16 KB cap, 500 chars a note, secret-shaped notes refused); always injected, wrapped untrusted; per-persona scope files. USER.md is read-only. No list/edit/forget for the user, no search over past conversations, no auto-extraction | src/tools/memory.ts:1-12, 60-74; src/personas/memory.ts:1-35; src/prompt/sections.ts:128-134 |
| Routines | missing: timer tool names only reserved; REQ-0016 plan is draft, no branch | src/botbus/capabilities.ts:25-26 |
| Worktrees / job isolation | partial: jobs run in an allowlisted cwd, no worktree or branch; maxConcurrent default 1 per engine | src/jobrunner/cwd.ts:55-95; src/jobrunner/limits.ts:11, 213-216 |
| Subagents | missing: only `ask_bot` to a named peer bot | src/botbus/tools.ts:56 |
| Skills | missing: `bots\<id>\skills\` folder exists in the layout, no loader | src/bots/paths.ts:6, 53 |
| Compaction | have (Pi harness, at 75% of the window) | src/prompt/budget.ts:11-20 |
| Channels | Telegram, web. No voice input, no image input; TTS only through an MCP macro | src/mcp/macros.ts:128-135 |
| Approval scopes | one-shot per command; no "always allow" rules | src/approval/gate.ts:1-12 |

## 2. Hermes Agent (Nous Research, MIT) [V from hermes-agent.nousresearch.com/docs]

- Memory: two small files in `~/.hermes/memories/`: MEMORY.md (2,200 chars) and USER.md (1,375 chars). Injected as a
  frozen snapshot at session start (writes land on disk at once but reach the prompt next session, which keeps the prompt
  prefix cache). Tool actions `add` / `patch` / `remove` with a target; no auto-compaction: a write over the limit fails and
  the agent must consolidate. Entries scanned for injection, credential exfiltration and invisible Unicode. Optional
  `memory.write_approval` stages writes for `/memory approve|reject`. A background review after a turn may save memory or
  update skills (can run on a cheaper model).
- Session search: every session in SQLite with FTS5; the agent searches and scrolls raw past messages.
- Routines (cron): `in 30m`, `every 2h`, `weekdays at 9am`, raw cron. Jobs in `cron/jobs.json`, a 60 s tick, each run is a
  fresh session with a self-contained prompt and optional attached skills. Delivery to the origin chat or a named target.
  `[SILENT]` suppresses delivery. Missed runs: one catch-up inside a window of half the period (2 min to 2 h). Preflight
  checks (key, skills, delivery target) before spending tokens. Cron runs cannot create cron jobs. Script-only jobs with no
  model. Retry 5/15/30 min; a nudge after 3 failures.
- Skills: `SKILL.md` folders with YAML frontmatter, three-level progressive disclosure (list, view, view file). The agent
  creates and patches its own skills (`skill_manage`); optional write approval; hub installs are scanned.
- Delegation and worktrees: `delegate_task` spawns up to 10 children with fresh context; only the summary returns.
  `delegation.worktree_isolation: true` gives each child its own git worktree and branch from HEAD; clean ones are pruned.
  Also `hermes -w` and kanban tasks in `.worktrees/<id>/` [I: from mirrors of the docs].
- Other: 7+ chat channels, voice and wake word, checkpoints with `/rollback`, hooks, MCP, five terminal backends.

## 3. Nod (n8n labs, Apache 2.0)

Covered in REQ-0015. In short: scheduled checks that speak only on change, per-note visible/editable memory with the source
message, Gmail/Slack/Notion/Calendar connectors, a rule check before each action. No worktrees, no skills by that name [V].

## 4. Others (survey, see the claims' labels)

| Project | Memory | Routines | Isolation | Skills |
|---|---|---|---|---|
| OpenClaw (MIT, most active) [V] | MEMORY.md, USER.md, daily notes; hybrid search in SQLite; silent memory flush before compaction; nightly gated "dreaming" that promotes notes, with revert and untrusted-provenance filter | at / every / cron; missed runs skipped; `NO_REPLY`; alert after 2 failures, auto-disable after 10; heartbeat is just a 30-min cron job | sandbox off by default; exec allowlist with glob + arg regex, ask on-miss | SKILL.md, hub, agent-made skills with undo |
| Goose (Apache 2.0) [V partial] | category files, all loaded into the prompt | cron on YAML recipes | not verified | recipes |
| OpenHands (MIT) [V] | none found | natural-language schedules, fresh sandbox per run | Docker per conversation | SKILL.md with `triggers` / `paths` |
| Letta Code (Apache 2.0) [V] | git-backed Markdown, one memory per file, root files always in prompt; reflection subagents | not covered | git worktrees for the memory agents [I] | SKILL.md inside the memory repo |
| Agent Zero (MIT) [V] | vector DB with a dashboard to search/edit/delete | cron / planned / ad-hoc; dedicated chat per task | Docker, snapshots | on demand |
| nanobot (MIT) [V] | MEMORY.md + append-only history.jsonl searched by tool; "Dream" consolidation | tasks; missed runs not replayed | workspace-only files | `$skill` |
| Claude Code (reference) [V] | MEMORY.md index (200 lines / 25 KB) + topic files read on demand | /loop, desktop tasks, cloud routines; no catch-up | subagents with `isolation: worktree`, auto-removed when unchanged | SKILL.md |
| NanoClaw, ZeroClaw [V partial] | per-group file / SQLite + embeddings | cron, "script gates" that skip waking the agent | container per group / OS sandboxes | - |

Not verified: Goose subagents and missed runs; OpenHands durable memory; Leon and Khoj details; exact OpenClaw memory budget.

## 5. Side by side

| Feature | Hermes | Nod | OpenClaw | agent-007 |
|---|---|---|---|---|
| Curated memory file in the prompt | yes, tiny caps | yes | yes | yes (16 KB, append-only) |
| Agent can edit / remove a memory | yes | yes | yes | no |
| User can see / edit / forget | commands | UI, with source | files, `/context` | no |
| User profile the agent maintains | USER.md | writing style | USER.md | no (read-only file) |
| Search over past conversations | FTS5 | yes (claimed) | hybrid | no |
| Automatic saving (review, flush, dreaming) | background review | yes | flush + dreaming | no |
| Memory-poisoning defence | pattern scan, write approval | benchmarked | provenance filter | untrusted wrapper, secret filter |
| Schedules | yes | yes | yes | no (planned, REQ-0016) |
| Skills | yes, self-written | "learned tasks" | yes | no |
| Subagents | yes | no | yes | peers only |
| Git worktrees for parallel code work | opt-in | no | no | no |
| Approve every risky action by default | no (opt-in modes) | yes | no (default full) | yes |
| Always-allow rules | yes | rules | allowlist | no |
| Hardened install, audit chain, taint | no | not stated | partial | yes |
| Crash-resume durable runtime | no (restart marks runs unknown) | not stated | no | yes |

## 6. What to adopt (ranked)

1. **Recurring tasks: finish REQ-0016, plus four small additions from this survey.** The plan already covers storage, limits,
   taint and pause-after-3-failures. Add: (a) a silent marker so "check X, tell me only on change" does not message every
   fire (Hermes `[SILENT]`, OpenClaw `NO_REPLY`); (b) an explicit missed-run rule: one catch-up inside a window, otherwise
   skip (Hermes); (c) fires cannot create tasks (Hermes); (d) fresh context per fire as an option (Agent Zero default).
   Check each against the plan before implementing; (c) may already follow from the taint rules.
2. **Memory upgrade**, in three steps of rising cost:
   - a. `forget` / `edit` for the agent (match by unique substring, Hermes `patch`/`remove`), `/memory` in Telegram and a web
     page listing every note with edit and delete (Nod, Agent Zero). Touches src/tools/memory.ts, src/telegram/commands.ts,
     src/web/routes. Small.
   - b. Writable USER.md with its own small cap, and optional staged writes ("approve this memory") reusing the existing
     proposals pattern (src/settings/proposals.ts). Small to medium.
   - c. Search over past conversations as a tool (SQLite FTS5 over Telegram conversations and web threads; raw messages, no
     summarising; results wrapped untrusted). This is what answers "what did we decide last week". Medium; needs a look at
     what Pi Durable exposes through src/pi/adapter.ts.
   - Later, only if a-c prove too manual: a memory flush before compaction, then gated consolidation (OpenClaw: operations
     not prose, reject if more than 25% dropped, snapshot to revert, never learn from untrusted or scheduled sessions).
     Small local models are weak at this; do not start here.
   - Smaller caps are a feature for local models: Hermes uses about 1,300 tokens in total where our cap allows about 4,000.
3. **Worktree per coding job.** Opt-in per job: when the cwd is a git repo, the job runner creates a worktree and branch,
   runs Claude Code / DeepSeek there, reports the branch, and removes the worktree if nothing changed (Hermes, Claude Code).
   It makes `maxConcurrent > 1` safe and keeps a job from touching a checkout in use. Touches src/jobrunner/cwd.ts (the
   allowlist must cover the worktree root), src/jobrunner/drivers/claude, src/jobs/task.ts (result shape). Medium.
4. **Skills.** A loader for the `skills\` folders that already exist in the bots layout: `SKILL.md` with name and
   description, only the list in the prompt, body loaded by a tool. Agent-written skills only through the existing
   `propose_*` approval path. Attach a skill to a recurring task (Hermes). Medium; value depends on how well the local
   model follows long procedures.
5. **Approval scopes**: "allow once / always for this exact command pattern", revocable, stored as rules (OpenClaw glob +
   arg regex where every `&&` segment must match; already idea 1 in REQ-0013). Medium, security-sensitive.

Not worth it now: 20 chat channels, vector databases and external memory providers, skill hubs, nested subagents, containers
or Docker sandboxes, nightly dreaming, wake word.

## 7. Limits of this research

- Docs and READMEs only; nothing was cloned, installed or run. Vendor numbers are unchecked.
- Hermes `-w` flag and kanban worktrees come from mirrors of its docs; the delegation worktree option is from the official page.
- agent-007 state is from a grep-level inventory, not a full read of src/agent; the Pi Durable API for session search was not checked.
- Effort labels are estimates.

Sources: hermes-agent.nousresearch.com (/, /docs/user-guide/features/memory, /cron, /skills, /delegation, /overview);
nod.n8n.io; docs.openclaw.ai (concepts/memory, concepts/dreaming, automation/cron-jobs, tools/exec-approvals, tools/skills);
code.claude.com/docs/en/memory and /sub-agents; docs.openhands.dev/overview/skills; docs.letta.com/letta-code/memfs;
agent-zero.ai/p/docs/task-scheduler; GitHub READMEs of goose, nanobot, nanoclaw, zeroclaw, khoj, leon.
