# agent-007: personal local-model agent on this PC, over Telegram

Date: 2026-10-26. Research synthesis of `notes-pi.md`, `notes-landscape.md`, `notes-inference.md` and `system-inventory.md` (same folder). Nothing was installed or started.
Tags: [V] verified from a primary source in the notes or on this machine ("V local" = read on this PC); [P] primary source such as a vendor doc or model card (as tagged in notes-inference); [S] secondary source; [U] unverified, or my inference.

## TL;DR

- **Stack:** **nanobot** (HKUDS, Python, MIT) as the agent and Telegram bridge, talking to the **LM Studio** server already running on `127.0.0.1:1234` through nanobot's built-in `lm_studio` provider. It runs natively on Windows under a separate low-privilege Windows user. Install it with `uv`, which is already present; no Node, Docker or WSL needed.
- **Why nanobot:** it is the only option that ships everything you asked for on this machine's existing toolchain: a Telegram channel with a numeric `allowFrom` allowlist, memory files (`USER.md`, `MEMORY.md`), cron, and workspace restriction. The other two options either need Node plus building Telegram, memory and scheduling yourself (Pi) or carry a much bigger attack surface (OpenClaw).
- **Model:** provisional primary is **nail-qwen3.6-35b-a3b-mtp** (Qwen3.6-35B-A3B base, 22 GB, MoE with 3B active, which suits bandwidth-limited unified memory). Run it head to head with **ista-daslab-qwen3.8-27b** (IQ3_XXS). If neither passes the tool-call test, download an official **Qwen3.6-27B at Q8** (about 29 GB). The machine has room for it.
- **Hardware finding:** the iGPU has **96 GiB dedicated** out of 128 GiB physical RAM (BIOS carve-out), so every model fits. Memory bandwidth limits speed, not capacity. Start at 64K context.
- **Pi / Pi Durable:** Pi (SDK plus a TelePi-style bridge) is plan B if you want to own every line. Pi Durable is a later option (crash-resume, durable timers) and is experimental today.

## 1. Options compared

| | (a) nanobot + LM Studio | (b) Own thin bridge on the Pi SDK (TelePi as template) | (c) OpenClaw, hardened |
|---|---|---|---|
| **Setup effort** | Low. Python ≥3.11 package with Windows x64 wheels and a PowerShell installer [V] ([repo](https://github.com/HKUDS/nanobot)); Python 3.13 and uv are already here. Config: `lm_studio` preset at `http://localhost:1234/v1` [V] ([providers.md](https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/providers.md)), Telegram `token` + `allowFrom` [V] ([chat-apps.md](https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/chat-apps.md)). | Medium to high. Install Node ≥22.19 [V] ([repo](https://github.com/earendil-works/pi)); Git Bash is present. Write a grammY bot of roughly a few hundred lines [U estimate] around `createAgentSession()` [V] ([sdk.md](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md)), using TelePi's `src/pi-session.ts` as the template ([TelePi](https://github.com/jellydn/TelePi)). LM Studio via `models.json` [V] ([models.md](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md)). | Medium. Install Node 24+ [V], then Windows Hub / PowerShell CLI or WSL2 [V] ([windows](https://docs.openclaw.ai/platforms/windows)). Many settings to change from their defaults before it is safe. |
| **What is missing** | A per-command approval gate for shell is **not documented** in the notes; only `restrictToWorkspace` and `exec.sandbox` [V] ([configuration.md](https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/configuration.md)). Empty-`allowFrom` behaviour and the exec sandbox on Windows are unverified. Missed cron runs are not replayed [V]. | Telegram, persistent user memory, scheduling and the approval gate all have to be built by you [V] (notes-pi §4). Pi has no permission system [V]. | Nothing feature-wise: Telegram (grammY, long polling) [V] ([telegram](https://docs.openclaw.ai/channels/telegram)), memory + `memory_search` [V], cron + proactive checks [V], exec approvals [V]. |
| **Security posture** | Good starting point: allowlist + pairing, workspace restriction, SSRF guard [V]. Shell sandbox still allows network [V]. WebUI access = admin, so keep it on loopback or off [V]. | Whatever you build, which can be the tightest of the three (you choose every tool). Pi runs with the user's rights and its README recommends containers [V]. Third-party Pi packages run arbitrary code [V]. | Worst defaults: exec `security=full`, `ask=off` on the gateway host [V] ([exec-approvals](https://docs.openclaw.ai/tools/exec-approvals)). 2026 RCE CVE, hundreds of malicious ClawHub skills [S] ([bitdoze](https://www.bitdoze.com/openclaw-security-guide/)). Indirect prompt injection documented [S] ([CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection-2026061/)). Has `openclaw security audit` [V]. |
| **Windows-native fit** | Native (wheels, PowerShell installer) [V]. Sandbox behaviour on Windows [U]. | Native with Git Bash (`shellPath`), optional PowerShell tool [V] ([windows](https://pi.dev/docs/latest/windows)). No Telegram bridge is verified on Windows [V absence]. | Native via Windows Hub / Tauri / PowerShell CLI; docs call WSL2 the most Linux-compatible [V]. |
| **Lock-in / maintenance risk** | 0.x (v0.3.5, 2026-09-15), very active [V]. Small enough to read [V]. Config is markdown + JSON, so it is easy to leave. | Low lock-in (your code, MIT), but you maintain it. Pi changed org/npm scope (@mariozechner → @earendil-works) [V]; SDK stability in 1.0 is not stated [U]. A thin own bridge limits the breakage [notes-pi]. | Weekly releases with breaking and security fixes [V]; very large codebase [V/S]. Heaviest to keep patched. |

**Pick: (a) nanobot.** It needs the fewest new runtimes on this PC and ships Telegram, memory, cron and an allowlist. It is small enough to audit. Its one real gap (no documented shell approval gate) can be closed on day one: start with shell **off**, give it only explicit read-only tools, and verify in phase 0 whether exec can be disabled or gated. **Fall back to (b)** if nanobot cannot turn shell off or gate it, or if you would rather own the code. Use (c) only if you later want 20+ channels or its full feature set, and accept the hardening work that comes with it.

**Where Pi Durable fits:** not now. The README says "Experimental. The API changes without notice between releases". It has no messaging connector, does not document local-model setup, and needs one process per storage [V] ([README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md), [post](https://earendil.com/posts/pi-durable/)). It becomes relevant later if you want long-running tasks that survive a crash or reboot (checkpointed steps, `harness.resume()`, timers that survive restarts, several clients steering one agent) [V]. By then the API should have settled, and it pairs with option (b), not (a).

## 2. Model plan for this machine

**Hardware:** 128 GiB LPDDR5X-8000, of which **96 GiB is dedicated to the iGPU** (registry `qwMemorySize` 96.00 GiB; dxdiag Dedicated 98083 MB) and 31.65 GiB is left for Windows. Details are in `system-inventory.md`. Plan model + KV within 96 GiB. Speed is bound by memory bandwidth, so prefer MoE models with few active parameters. The notes list Strix Halo 128 GB reference speeds of 48-65 tok/s for small or MoE models and about 28 tok/s for 122B-class [S/U] ([jdhodges](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)), and flag prompt processing as the weak point on unified memory [U].

| Role | Model (already on disk unless noted) | Why | Caveat |
|---|---|---|---|
| **Primary (provisional)** | `nail-qwen3.6-35b-a3b-mtp` (UD-Q4_K_XL, 22 GB) | Base Qwen3.6-35B-A3B: vendor TAU3 67.2, MCP-Atlas 62.8, 262K ctx, Apache-2.0 [P] ([card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)). With 3B active it is the fastest shape for this bandwidth. | "Nail" is a community derivative of unknown training [U]. Tool calling for 35B-A3B is called "mixed" in loops [S] ([insiderllm](https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/)). LM Studio flags this file `trainedForToolUse=false` [V local]; whether that means the generic tool parser is used is [U]. |
| **Head-to-head / fallback** | `ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp` (IQ3_XXS, 10.5 GB) | Qwen3.8-27B has the highest vendor agent numbers (Terminal Bench 2.1 73.0, OSWorld-Verified 84.3) [P] ([card](https://huggingface.co/Qwen/Qwen3.8-27B)). Dense models are called "steadier" in loops [S]. | 3-bit quant. The notes warn tool-call formatting degrades at Q4 and suggest Q6 for long agent runs [S] ([computingforgeeks](https://computingforgeeks.com/ollama-models-cheat-sheet/)), so IQ3 is a further risk [U]. Dense, so slower here. |
| **Recommended download if both fail** | Official Qwen3.6-27B at Q8_0 (about 29 GB) or Q6_K (22 GB) | The notes' best-evidenced single-model agent pick, and their choice for the 64 GB+ unified tier [S/P] (notes-inference §3). Fits easily. | Needs a download (your call). Qwen3.8-27B at Q8 is the newer alternative with thinner evidence [S]. |
| **Deep / slow tier (test only)** | `ornith-1.5-122b` (UD-IQ3_XXS, 47 GB) | Fits with room. A 122B-class MoE was the notes' pick for 96-128 GB [S]. | The model is not covered by any source; that it is a Qwen3.5-122B derivative is a guess from its `qwen35moe` architecture [U]. |
| **Vision (phase 2)** | `minicpm-v-4.7-35b-a3b` (Q4_K_S, 19.6 GB) | For photos sent over Telegram. Fits alongside the primary. | Not covered by the notes [U]. |
| **Embeddings** | `text-embedding-nomic-embed-text-v1.5` | Already present for memory search if nanobot or your tools use it. | Whether nanobot's memory uses embeddings is not covered by the notes [U]. |
| **Do not use for the agent** | `gemma-4-e4b-...-uncensored-heretic`, `qwen3.8-27b-blackfrost-abliterated` | "Uncensored" / "abliterated" builds have had refusal behaviour removed. The notes say local models already lack hosted safety filters and are easier to hijack [V] ([OpenClaw local-models](https://docs.openclaw.ai/gateway/local-models)), so this agent should not use a model with even less resistance [U, my reasoning]. The E4B model is also small; the notes call sub-9B models suitable for narrow, scripted tool use only [S]. | Fine for other uses. |

**Bake-off list (phase 0):** nail-qwen3.6-35b-a3b-mtp, ista-daslab-qwen3.8-27b, ornith-1.5-122b, lfm2.5-24b-a2b, recursivesi/flint. The last two are not covered by the notes, so they are cheap extra candidates only. Optionally add tiel-coder-35b-a3b-mtp. The acceptance bar from the notes is 30-50 cases with the agent's *real* tool schemas and system prompt, at least 95% single-step pass, and no loops on 10 multi-step tasks [U, notes' proposal] (notes-inference §5). A text-only check proves nothing [V] ([OpenClaw local-models](https://docs.openclaw.ai/gateway/local-models)).

**LM Studio settings:**
- **Bind:** already `127.0.0.1:1234` [V local]. Keep it. Also turn on "Require Authentication" (Bearer / `x-api-key`) [V] ([claude-code integration](https://lmstudio.ai/docs/integrations/claude-code)), so other local processes cannot use it without a key.
- **Context:** set it explicitly per model. Start at 65536, raise to 131072 after it passes the tests. Never rely on the JIT default (not documented) [V absence] ([ttl-and-auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)). Keep KV cache at q8_0 or better, because aggressive KV quantisation hurts tool calling [V] ([llama.cpp function-calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)).
- **Parallel slots:** 1-2, so each request keeps the full context [U] ([parallel-requests](https://lmstudio.ai/docs/app/advanced/parallel-requests): default 4; how the context is split across slots is not documented). The currently loaded model runs at 2.
- **JIT / TTL:** JIT is on [V local]. JIT models unload after 60 min idle and Auto-Evict keeps one [V]. For an always-on agent, load the primary explicitly (`lms load` with no `--ttl`), so the first message after idle does not pay a cold load [V] ([ttl doc](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict); OpenClaw docs give the same advice).
- **Headless autostart on Windows:** the documented Windows route is the desktop app with "run the LLM server on login" [V] ([headless](https://lmstudio.ai/docs/developer/core/headless)). No LM Studio autostart entry exists today [V local]. This machine's `lms` has **no `daemon` subcommand** [V local], so the `lms daemon up` llmster route in the notes does not apply as-is. Fallback: a Task Scheduler "At log on" task under the interactive user running `lms server start` then `lms load <model>` [U].
- **Logging:** `logSensitiveData` is `true` [V local]. Check whether this writes prompt or Telegram text to disk; if it does, turn it off [U].
- **Runtime:** ROCm llama.cpp 2.64.0 is selected; Vulkan 2.63.0 is also installed [V local]. The notes say Vulkan works for AMD [P] ([Ollama windows](https://docs.ollama.com/windows)) but have **no ROCm-vs-Vulkan data for Strix Halo** [U]. Benchmark both in phase 0, then pin the winning runtime version and re-run the tool-call test after every runtime update, because parser regressions happen [S] (notes-inference §4.1).
- **MTP:** several files are "MTP" builds (multi-token prediction heads). Whether LM Studio's runtime uses them for speed is [U].

## 3. "Knows my system": what it means concretely

Give it, in this order:
1. **Profile file** (`USER.md` in nanobot [V]): who you are, how you want answers, your folders' purpose, your machines. You write it and review its diffs. The agent may propose edits but should not silently rewrite it, because memory files are read into every prompt and can be poisoned [S] ([CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection-2026061/)).
2. **Read-only system-facts file**, generated by a script *you* run on a schedule (not by the agent): hardware (`system-inventory.md` is a start), OS build, disk free, installed dev tools, LM Studio models and state, a folder map. The agent reads facts instead of probing the system with a shell [U, design choice].
3. **Allowed folders:** one agent workspace (read/write), plus an explicit, short list of read-only folders you choose. Turn on `restrictToWorkspace` [V]. On native Windows, treat workspace restriction as advisory and back it with NTFS permissions of the separate agent user [U] (notes-landscape §4.4).
4. **Tools:** read/list/search files in allowed folders; a small set of read-only status commands (disk free, top processes, `lms ps`, uptime) wrapped as named tools, not free shell; write only inside the workspace; scheduled reports via cron [V].

Do NOT give it: admin rights; your own Windows account; browser profiles, password manager data, SSH/GPG keys, `.env` files, cloud CLIs or credentials; `~/.lmstudio` (it holds a local token in plaintext [V local]); the nanobot config holding the bot token; your OneDrive root; work data (`C:\Pixotope`, work repos) unless you decide otherwise; RustDesk or any remote-access tooling; third-party skills or plugins; free outbound shell or network.

## 4. Security baseline (must-dos)

1. **Telegram allowlist by numeric user id**, not username. Never leave `allowFrom` empty, since its semantics are [U]. After first use, disable pairing for strangers; no groups [V] ([chat-apps.md](https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/chat-apps.md); notes-landscape §4.1).
2. **Long polling, no webhook**: no inbound port, no tunnel [V] (notes-landscape §4.6). nanobot's webhook is optional [V]; that polling is its default is my reading [U].
3. **Approval gate for shell and destructive actions.** MVP: shell off. If enabled later: allowlist-only commands plus a Telegram inline-button approval for anything else. Note that approval via the same Telegram chat is only as strong as the allowlist [V] ([Claude Code channels](https://code.claude.com/docs/en/channels) shows the same weakness).
4. **Separate low-privilege Windows user** (`agent007`, standard user, NTFS access only to its workspace and chosen read-only folders), or WSL2 with only the workspace mounted [V] (notes-landscape §4.4). Never run it under your admin account.
5. **No third-party skills/plugins/MCP servers you have not read**, with pinned versions [V/S] ([bitdoze](https://www.bitdoze.com/openclaw-security-guide/); notes-pi §4.3).
6. **Token handling:** the bot token lives in a file only the agent service account can read and the agent's tools cannot reach (outside the workspace). It never goes into git, memory files or chat. Rotate it via BotFather if it leaks [V] ([goose gateway](https://goose-docs.ai/docs/experimental/remote-access/telegram-gateway)).
7. **LM Studio bound to localhost** (already true [V local]) with Require Authentication on [V].
8. **Treat inbound content as untrusted:** forwarded messages, files, web pages. Review `MEMORY.md`/`USER.md` diffs weekly [S] (CSA).
9. **Kill switch** that does not depend on Telegram: stop the scheduled task or service locally [V] (notes-landscape §4.9).

## 5. Hybrid escalation to a frontier API

Not worth it for the MVP. The memory constraint that drives escalation on 8-24 GB GPUs does not apply here: with 96 GiB you can run a Q8 27B or a 122B MoE locally, and sending Telegram content to an API undercuts the "local" goal. The remaining gaps, though, are exactly the ones the notes say local models lose on: long-horizon reliability, looping, and resistance to prompt injection [S/U] (notes-inference §4.1). If you add web reading or ever enable shell, add escalation in phase 2 as an explicit user command (`/pro`) rather than automatic routing. nanobot already has an Anthropic-compatible provider with `apiBase` [V] ([providers.md](https://raw.githubusercontent.com/HKUDS/nanobot/main/docs/providers.md)). Rule-based routing (parse failure, loop guard, destructive action, untrusted content) belongs in your own code, because gateway fallbacks trigger only on provider errors [V] ([OpenClaw local-models](https://docs.openclaw.ai/gateway/local-models)).

## 6. Proposed next step (planning only; nothing executed)

**Phase 0: smoke test (no agent, no Telegram).**
- Write a 30-50 case tool-call suite (Python, against `http://127.0.0.1:1234/v1/chat/completions` with the real tool schemas you plan to give nanobot).
- Run it on the bake-off models at 64K context, parallel 1, on ROCm and then Vulkan. Measure decode tok/s and time to first token on a 10-15K-token prompt.
- Read nanobot's docs/source to confirm: exec can be disabled or gated; empty `allowFrom` semantics; polling is the default; where the token is stored.
- Create the bot with BotFather and record your numeric Telegram user id.
- *Done when:* one model scores ≥95% single-step and is loop-free on 10 multi-step tasks; a runtime and version are pinned; the nanobot answers are written down. If no local model passes, decide on the Qwen3.6-27B Q8 download.

**Phase 1: MVP.**
- Create the `agent007` standard Windows user and workspace.
- Install nanobot with `uv` for that user, pinned version. Configure: `lm_studio` provider, Telegram with `allowFrom=[your id]`, pairing off, `restrictToWorkspace: true`, shell off, read-only status tools, `USER.md` and the system-facts file.
- Autostart LM Studio (app login setting) and nanobot (Task Scheduler at logon); turn on LM Studio auth.
- *Done when:* from your phone the bot answers within your latency target; a message from a second Telegram account is ignored; a request to read outside the allowed folders is refused; a request to run a shell command is refused or asks for approval; everything comes back after a reboot.

**Phase 2: memory and scheduling.**
- Turn on memory consolidation (`/dream`, `MEMORY.md`) [V]. Add one or two cron jobs (for example a daily disk/LM Studio health digest) [V], optional image handling with MiniCPM-V, and optional `/pro` escalation.
- Set up a weekly memory-diff review and an audit log of tool calls.
- *Done when:* the digest arrives on 3 consecutive days; memory survives a restart; one week of memory diffs reviewed with nothing unexpected. Revisit Pi SDK / Pi Durable only if you hit a wall here.

## 7. Open questions

1. What should "knows my system" cover: this PC's state only, or also personal data (notes, calendar, email)? Which folders may it read, and is Pixotope/work data off-limits?
2. For the MVP, is a read-only agent acceptable (no shell, writes only in its workspace), or do you need it to run commands from day one?
3. Are you OK with a separate standard Windows user for the agent? The alternative is WSL2, which adds setup.
4. If the downloaded models fail the tool-call test, may it download an official Qwen3.6-27B Q8 (about 29 GB)? And should the agent run only while you are logged in, or 24/7?
5. Is a frontier API ever allowed for `/pro` escalation, and if so which provider?

## 8. Unverified items that matter for the pick

- nanobot: whether shell/exec can be fully disabled or gated per command; empty `allowFrom` behaviour on Telegram; `tools.exec.sandbox` on Windows; long polling as the default (notes say only "webhook optional") (notes-landscape §5).
- Tool-calling quality of the community derivatives on disk (Nail, GSQ-RCO IQ3_XXS, Ornith, Flint, LFM2.5): no source covers them. LM Studio's `trainedForToolUse=false` flag on the Nail file may mean the generic parser is used.
- ROCm vs Vulkan speed and stability on Strix Halo; whether MTP heads are used by LM Studio.
- Windows headless autostart for LM Studio: no documented Task Scheduler recipe [V absence]; `lms daemon` is not in this machine's CLI.
- Whether `logSensitiveData: true` writes prompt text to LM Studio logs.
- Pi (option b): SDK/RPC stability in 1.0 is not stated; whether context files/skills load in SDK mode with a custom cwd; no Telegram bridge tested on Windows; TelePi's license is not shown (notes-pi "Unverified").
- OpenClaw (option c): CVE-2026-25253 severity differs across blogs; no NVD page read.
- Benchmarks used for model picks are vendor numbers or small secondary tests; none measures long agent loops on this hardware.
