# Local inference for a Windows 11 personal agent (research notes)

Research date: 2026-10-26. Research only; nothing installed or run.
Legend: [P] = primary source (vendor docs / model card). [S] = secondary (blog, forum, community benchmark). [U] = unverified or my inference. Where sources conflict I say so.
Caveat on the model landscape: it moves monthly. Qwen3.8-27B is about 10 weeks old at time of writing and has thin independent evidence. Re-check before buying hardware.

---

## 0. Bottom line

1. Serving: use **LM Studio llmster (headless)** if you want least setup, JIT loading and an Anthropic-compatible endpoint. Use **llama.cpp llama-server (+ llama-swap)** if you want the most control over chat templates, KV cache, MoE offload flags. Ollama is fine but has the weakest control over context and had the most parser complaints for newer models. vLLM via WSL2 only makes sense at 24 GB+ for batch/parallel serving; it is overkill for one user.
2. Model: the **Qwen3.5/3.6/3.8 family is the default pick at nearly every tier**, because it has the strongest published tool-calling and agentic numbers among models that fit consumer hardware, Apache-2.0, 262K native context. Tier picks are in section 3.
3. Honest gap: local models are usable for a narrow, supervised, tool-allowlisted agent. They are not a drop-in for a frontier API on long-horizon, messy, or injection-exposed work. Use local-default with API escalation (section 4).

---

## 1. Serving options on Windows

### 1.1 LM Studio headless (llmster)

Facts:
- LM Studio 0.4.0 (2026-01-28) introduced **llmster**, the app core packaged as a standalone daemon that runs without the GUI; CLI is `lms daemon up`, `lms server start` [P] https://lmstudio.ai/blog/0.4.0 and https://lmstudio.ai/changelog/lmstudio-v0.4.0
- Windows install one-liner is reported as `irm https://lmstudio.ai/install.ps1 | iex`, then `lms daemon up` / `lms daemon status` [S, via search summary of https://lmstudio.ai/docs/developer/core/headless_llmster and https://lmstudio.ai/docs/advanced/headless]. I could not confirm the exact line on the docs page itself; verify before use.
- **Start-at-boot is only documented for Linux (systemd).** For Windows, the documented route is the desktop app with "run the LLM server on login" ticked; the app then minimises to tray [P] https://lmstudio.ai/docs/developer/core/headless and https://lmstudio.ai/docs/developer/core/headless_llmster . No Windows service or Task Scheduler recipe is documented [P, absence]. Recommendation [U]: a Task Scheduler "At log on" task running `lms daemon up` then `lms server start` (and optionally `lms load <model> --ttl 0`), under your interactive user so GPU access works. A true Session-0 Windows service with GPU access is riskier [U].
- "Your last server state will be saved and restored on app or service launch." [P] https://lmstudio.ai/docs/developer/core/headless
- **JIT loading:** an inference call loads a model if not loaded. JIT models auto-unload after **60 min idle** by default; Auto-Evict (default on) keeps at most **1** JIT model in memory. Models loaded with `lms load` have no TTL unless you pass `--ttl`. `ttl` (seconds) can also be sent in the request body [P] https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict . Consequence for an always-on agent: first message after idle pays a cold load (tens of seconds for a 16-30 GB model [U]); OpenClaw docs also advise keeping the model loaded for this reason [P] https://docs.openclaw.ai/gateway/local-models
- **Endpoints:** OpenAI-compatible `/v1/chat/completions` and `/v1/responses` with `tools` [P] https://lmstudio.ai/docs/developer/openai-compat/tools ; **Anthropic-compatible `POST /v1/messages`** since 0.4.1 (2026-01-30), usable with Claude Code via `ANTHROPIC_BASE_URL=http://localhost:1234` [P] https://lmstudio.ai/docs/developer/anthropic-compat and https://lmstudio.ai/blog/claudecode . Docs page does not detail tool use / streaming on the Messages endpoint [P, absence], so test it. Optional "Require Authentication" accepts `x-api-key` or Bearer.
- **Tool calling:** parsed into `message.tool_calls`; "native" for models whose template LM Studio understands (Qwen, Llama 3.x, Mistral listed), "default" generic prompt-injected format otherwise; if parsing fails the call text lands in `content` [P] https://lmstudio.ai/docs/developer/openai-compat/tools . Streaming tool-call argument fragments for compatible models improved in newer builds [S, changelog summary] https://lmstudio.ai/changelog . Known parser regression example: gpt-oss-20b native-format parse errors in a newer parser [S] https://github.com/lmstudio-ai/lmstudio-js/issues/493
- **Parallel requests:** since 0.4.0, continuous batching, "Max Concurrent Predictions" default **4**, llama.cpp engine (MLX batching added in 0.4.2 build 2, text-only) [P] https://lmstudio.ai/docs/app/advanced/parallel-requests and https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.2 . Docs do not say how context is divided across slots or give an `lms load` flag [P, absence]. [U] On llama.cpp a unified KV cache is typically split across slots, so set slots to 1-2 for a single-user agent to keep full context per request.
- **Context:** you set context length at load time (UI or `lms load --context-length`) [U on flag name]. JIT default context selection is not documented [P, absence] - **set per-model defaults explicitly**; a small default silently breaks agent loops (see Ollama below).
- **Multi-model:** several models can be loaded if Auto-Evict is off or loaded explicitly; JIT with Auto-Evict swaps one at a time.
- Versioning note: latest I could confirm in official changelogs is 0.4.25 (2026-09-19); a third-party review claims 0.4.26 on 2026-10-13 [U] https://www.promptquorum.com/power-local-llm/lm-studio-review
- **Also exists:** "LM Studio Bionic" (launched 2026-07-16), a *separate* agent app for open models (Work and Code projects; local, Secure Cloud, or remote via LM Link; Windows x64/ARM64 reported) [P/S] https://lmstudio.ai/blog/introducing-lm-studio-bionic , https://lmstudio.ai/docs/bionic , https://9to5mac.com/2026/07/16/lm-studio-expands-beyond-chat-with-bionic-a-new-ai-agent-app-for-open-models/ . Docs I could read do not mention Telegram or headless operation; it is a GUI agent, not a replacement for a Telegram-driven agent. It can coexist with LM Studio per its docs.
- Setup effort: lowest. Always-on reliability: good once the login task exists; weakest point is lack of a documented Windows service. Tool-call reliability: depends on LM Studio's parser per model; third-party tests show template-compat failures for niche function-calling fine-tunes (Hammer, xLAM) [S] https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/

### 1.2 Ollama

- Windows installer runs as a background tray app, no admin needed, API on `http://localhost:11434`. For a real system service, use the standalone zip with `ollama serve` under NSSM [P] https://docs.ollama.com/windows
- **Default context is 4k under 24 GiB VRAM, 32k at 24-48 GiB, 256k at 48+ GiB**; Ollama itself recommends >=64k for agents/coding tools; change via app slider or `OLLAMA_CONTEXT_LENGTH` [P] https://docs.ollama.com/context-length . This is the number-one cause of "agent gets dumb/forgets tools" with Ollama [U inference from the 4k default plus typical system-prompt size].
- OpenAI-compatible API; **Anthropic Messages compatibility** exists (streaming, tools, tool results, thinking supported; `tool_choice` not) [S mirror] https://docs.ollama.com/api/anthropic-compatibility
- Tool-calling quirks on newer models: reports of Gemma 4 tool calls landing in the reasoning field on Ollama, and Gemma 4 26B writing plans but not calling tools via OpenCode while raw curl worked [S] https://www.kartit.net/blog/gemma4-26b-macbook (via search summary). Qwen3.6 35B-A3B text works in Ollama; vision fails (no mmproj sidecar) [S] https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/
- Multi-model: yes, keep-alive based. Setup effort: very low. Always-on: good via tray autostart; service needs NSSM. Control over templates/KV/MoE offload: lowest of the four.

### 1.3 llama.cpp llama-server

- `--jinja` required for tool calling; native handlers for Llama 3.x, Hermes, Qwen 2.5, Mistral Nemo, Command R7B, GPT-OSS (Harmony), DeepSeek R1 (WIP); other templates fall back to a "Generic" format (more tokens, less reliable). Parallel tool calls are off unless `"parallel_tool_calls": true`. `--chat-template-file` overrides a bad template. **Aggressive KV quantisation (e.g. `-ctk q4_0`) can substantially degrade tool calling** [P] https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md
- Known template/parser friction: Qwen's XML tool-call format (`<tool_call><function=...>`) historically could not be parsed by some llama.cpp server paths [S] https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates/discussions/45 ; some builds b8954-b8967 broke web-search tool calls for Qwen3.6-35B-A3B, fixed on mainline [S] https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/ . Practical rule: pin a known-good build, re-test tool calls after every update.
- MoE offload (`--n-cpu-moe N`) is the key lever for 8-16 GB GPUs. CUDA build beat Vulkan on speed and context in one 3090 test [S] https://www.gilesthomas.com/2026/07/benchmarking-qwen-3-6-35b-moe-rtx-3090 . Avoid CUDA 13.2 builds with low-bit quants (reported gibberish) [S] insiderllm link above.
- **llama-swap**: Go proxy that swaps llama-server instances by `model` field, TTL unload, `matrix` to keep several loaded, serves OpenAI and Anthropic routes (`/v1/messages`, `count_tokens`); Windows binaries / WinGet [P] https://github.com/mostlygeek/llama-swap . No service recipe documented; use Task Scheduler or NSSM [U].
- Setup effort: highest of the three simple options, best control. Always-on: excellent (single binary, no GUI).

### 1.4 vLLM via WSL2

- vLLM tool parsers: `qwen3_xml` (Qwen3-Coder), `openai` (gpt-oss), `glm45` / `glm47` (GLM-4.5/4.6 vs 4.7 and 4.7-Flash), `mistral`, `hermes`; `--enable-auto-tool-choice` mandatory [P] https://docs.vllm.ai/en/latest/features/tool_calling.html . Qwen3.6/3.8 model cards say `--reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder` [P] https://huggingface.co/Qwen/Qwen3.6-35B-A3B , https://github.com/QwenLM/Qwen3.8
- WSL2 GPU passthrough reportedly runs at 90-100% of native for llama.cpp; need `.wslconfig` memory limits and `autoMemoryReclaim` for always-on use [S] https://insiderllm.com/guides/wsl2-local-ai-windows-guide/ . vLLM needs compute capability >=7.5 per one P40 report [S] https://github.com/schmared/tesla-p40-wsl2-cuda-llamacpp . Native-ish alternative: Docker Model Runner supports vLLM on Windows [S] https://www.docker.com/blog/docker-model-runner-vllm-windows
- Best tool-call fidelity (official parsers per model, constrained decoding via XGrammar) and best batching. Worst: VRAM headroom (vLLM wants to pre-allocate), WSL boot-at-login complexity, GGUF-style CPU MoE offload is not its strength [U]. Only worth it for 24 GB+ with multiple concurrent agents.

### 1.5 Comparison

| | LM Studio llmster | Ollama | llama-server (+llama-swap) | vLLM (WSL2) |
|---|---|---|---|---|
| Setup effort | Low | Lowest | Medium | High |
| Windows autostart | Login task only (undocumented for daemon) | Tray autostart; NSSM for service | Task Scheduler/NSSM (DIY) | WSL + scheduled start (DIY) |
| Tool-call reliability | Per-model parser; good for Qwen/Mistral, regressions seen | OK; newer-model parser bugs reported | Good with `--jinja` + pinned build + right template | Best (official parsers) |
| Context handling | Set at load; JIT default unclear | Default 4k/32k/256k by VRAM; must raise | Explicit `-c`, KV type, MoE offload | Explicit, pre-allocates |
| Multi-model | JIT swap, 1 at a time by default | Keep-alive, multiple | llama-swap matrix | One model per process |
| Anthropic `/v1/messages` | Yes (0.4.1+) | Yes | Via llama-swap (and llama-server per llama-swap's claim) | Not covered in sources read |

---

## 2. Models that actually do agentic tool calling

### 2.1 Evidence base and its quality

- Official, model-card level: Qwen3.6-35B-A3B: SWE-bench Verified 73.4, Terminal-Bench 2.0 51.5, TAU3 67.2, MCP-Atlas 62.8 [P] https://huggingface.co/Qwen/Qwen3.6-35B-A3B . Qwen3.6-27B (dense): SWE-bench Verified 77.2, Terminal-Bench 2.0 59.3 [P] https://huggingface.co/Qwen/Qwen3.6-27B . Qwen3.8-27B: SWE-bench Pro 61.7, Terminal Bench 2.1 73.0, OSWorld-Verified 84.3; no TAU/BFCL listed [P] https://huggingface.co/Qwen/Qwen3.8-27B . Gemma 4 26B-A4B tau2 68.2%, 31B dense 76.9% [P] https://huggingface.co/google/gemma-4-26B-A4B-it . GLM-4.7-Flash tau2-Bench 79.5 vs 49.0 (Qwen3-30B-A3B-Thinking-2507) and 47.7 (gpt-oss-20b), vendor-reported [S] https://dev.co/ai/llms/glm-4-7-flash-gguf (Unsloth mirror of card). All are vendor numbers.
- BFCL-v4 for Qwen3.5: 397B-A17B 0.729, 27B 0.685, 9B 0.661, 4B 0.503, 2B 0.436 [S, SEO-style aggregator, dated 2026-07-18; not verified against Berkeley leaderboard] https://d-central.tech/local-llm-agent-capability/ . I did not find a primary BFCL or tau-bench row for Qwen3.6/3.8 or gpt-oss; treat BFCL numbers as indicative.
- Independent small test: 13 models, 40 deterministic tool-call cases, LM Studio 0.4.6, Q4_K_M, March 2026. Qwen3.5 4B 97.5%, GLM-4.7-Flash 95%, Nemotron Nano 4B 95%, Mistral Nemo 12B 92.5%, Qwen3 8B 85%, gpt-oss-20B 85% (2/8 on multi-tool), Mistral Small 3.2 24B 42.5%. Author: size did not predict quality; template compat dominates [S] https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/ . Narrow test (8 simple tools, single-shot), so it says nothing about long loops.
- Real-world loop quality: Qwen3.6 27B described as high on standard MCP servers (file/bash/web) but degrading on bespoke tools, and can loop on a failing test 10+ times [S] https://vantaige.io/blog/qwen-3-6-beellama-star-elastic-local-agentic-2026 (source has internal inconsistencies, affiliate links; low trust). Qwen3.6-35B-A3B tool-calling "mixed", 27B dense "steadier" [S] https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/ . A forum post claims 97/100 on NVIDIA tool-eval-bench for 35B-A3B FP8 with the qwen3_coder parser [U, forum, via search summary].

### 2.2 Per-model notes

- **Qwen3.8-27B** (dense, Apache-2.0, 2026-08-14, 262K ctx, thinking on by default, `reasoning_effort` xhigh/medium/low). Newest and highest vendor numbers. Q4_K_M about 16 GB, Q5 ~19, Q6 ~22, Q8 ~29 GB [S] https://huggingface.co/Preyazz/Qwen3.8-27B-GGUF . Model card does not state tool-call flags; the repo README gives `qwen3_coder` for vLLM/SGLang and mentions llama.cpp support only for Qwen3.5 [P] https://github.com/QwenLM/Qwen3.8 . Community GGUFs exist (Unsloth) [S] https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/main ; `--jinja` mandatory [S]. **Treat as "promising, validate locally"** - no independent agent-loop evidence found.
- **Qwen3.6-27B** (dense, April 2026): best-evidenced single-GPU agent model. vLLM/SGLang: `--tool-call-parser qwen3_coder --reasoning-parser qwen3`. Speeds on 24 GB cards in sources conflict: ~35 tok/s vanilla on 3090 vs ~120 on 4090 vs 85 sustained on 3090 with speculative/MTP forks [S] https://vantaige.io/blog/qwen-3-6-beellama-star-elastic-local-agentic-2026 . Budget 30-60 tok/s on stock llama.cpp [U].
- **Qwen3.6-35B-A3B** (MoE, 3B active, Apache-2.0, 262K ctx): speed champion. 3090 fully on GPU: 122-157 tok/s but only ~50-90K context fits; offloading 10-12 layers' FFN to CPU gives full 262K at 66-89 tok/s [S] https://www.gilesthomas.com/2026/07/benchmarking-qwen-3-6-35b-moe-rtx-3090 and https://insiderllm.com/guides/best-way-run-qwen-3-6-35b-moe-locally/ . RTX 3060 12 GB: ~38 tok/s (UD-Q4_K_M, `-ncmoe 24`) and 46.8 tok/s (IQ4_XS, `-ncmoe 18`, 32 GB DDR4) [S] same insiderllm page and https://reddit.sentinel-team.org/posts/1t7l56a/snapshots/2026-05-15T23%3A40%3A01.25497Z . 8 GB: 25-30 tok/s at 32K ctx with 64 GB DDR4 (RTX 3070, IQ4_XS), "8.7 to 40+ tok/s with -ncmoe" on a 3070 Ti [S, anecdotal/member-only] https://medium.com/coding-nexus/one-flag-tripled-my-tokens-per-second-on-an-8gb-gpu-238f55d1e3bd . Thinking on by default (`enable_thinking: false` to disable; `preserve_thinking` recommended for agents) [P]. Recommended sampling: thinking general temp 1.0/top_p 0.95/top_k 20/presence 1.5; precise coding temp 0.6 [P] model card.
- **Qwen3.5 family** (Feb 2026): 0.8B-9B, 27B, 35B-A3B, 122B-A10B, 397B-A17B [P] https://github.com/QwenLM/Qwen3.8 . Small ones (4B, 9B) are the only credible agent models below ~8 GB; 4B hit 97.5% on the simple 40-case test but BFCL-v4 0.503 and "marginal" for real use [S above]. Qwen docs: use non-thinking plus grammar-constrained decoding under 8B [S] d-central.
- **Gemma 4** (Apache-2.0; E2B, E4B, 12B Unified, 26B-A4B MoE, 31B dense; 256K ctx on 26B/31B): native structured tool use, configurable thinking [P] https://huggingface.co/google/gemma-4-26B-A4B-it . tau2 68.2 (26B-A4B) / 76.9 (31B) is credible but behind Qwen on coding/terminal evals. Quirks: needs `--jinja` and a recent llama.cpp; Ollama parser reports; a HF forum post claims malformed tool calls/loops under long context + reasoning, and that proxies (LiteLLM, agent clients) can corrupt Gemma's non-JSON tool syntax [S, unverified] https://discuss.huggingface.co/t/successfully-running-gemma4-26b-on-prem-looking-to-discuss-deployment-struggles-stable-setups/176145 , https://github.com/ggml-org/llama.cpp/issues/22786 . 12B QAT Q4_0 6.5 GB: 90 tok/s on RTX 3080 Ti at 16K (one source) vs ~15-17 tok/s estimate on 12 GB cards (calculated source) [S, conflict] https://atomic.chat/blog/guides/best-local-llm-12gb ; no tool-call measurements found.
- **gpt-oss-20B / 120B** (Aug 2025; Harmony format; MXFP4; 20B fits 16 GB, 120B "single 80 GB GPU"; low/medium/high reasoning via system prompt) [P] https://huggingface.co/openai/gpt-oss-120b . Fast (65 tok/s on Strix Halo test) but scored 2/8 on multi-tool chaining in the independent test [S jdhodges]. Dated by 2026 standards; one roundup says it trails coding-specialist picks on agentic SWE-bench [S] https://www.morphllm.com/best-ollama-models (page returned 429 when fetched; claim is from search summary). Harmony needs correct template: llama.cpp has native handler [P]; LM Studio parser regression reported [S]. 120B ~65 GB download [S]; 120B with 24 GB GPU + 64 GB RAM: reports range from 1.6 to ~15 tok/s [S] https://www.hardware-corner.net/guides/gpt-oss-offloading-moe-layers/ .
- **GLM-4.7-Flash** (30B-A3B MoE, MIT, ~200K ctx per one source): 95% on the 40-case test at 52 tok/s (128 GB Strix Halo, Q4_K_M, 18 GB) [S jdhodges]; vendor tau2 79.5. Needs vLLM/SGLang main branch and `glm47` parser; llama.cpp had a looping bug fixed 2026-01-21 (re-download GGUFs); Unsloth suggests temp 0.7, top_p 1.0, min_p 0.01 for tool calling [S] https://dev.co/ai/llms/glm-4-7-flash-gguf . Reasonable alternative to Qwen3.6-35B-A3B at the 16-24 GB tier.
- **GLM-4.5-Air** (106B/12B active): needs 64-96 GB class memory [S] d-central. **GLM-5.2** (753B-A40B, MIT, released June 2026) is server-class, no Air variant found [S] https://rits.shanghai.nyu.edu/ai/glm-5-2-z-ais-open-weights-coder-beats-gpt-5-5-at-1-6-the-cost/ .
- **Devstral Small 2 (24B)**: Apache-2.0, 256K ctx, "single RTX 4090 or 32 GB Mac", agentic coding focus [S community card] https://huggingface.co/kevinbtalbert/Devstral-Small-2-24B-Instruct-2512 . No independent tool-call reliability test found. Mistral Small 3.2 24B did poorly (42.5%) on the 40-case test under LM Studio [S jdhodges]. Coding specialist; not a general assistant pick over Qwen3.6-27B.
- **Qwen3-Coder / Coder-Next**: vLLM parser `qwen3_xml`; Qwen3-Coder-Next sizing for 48 GB tier is suggested in one roundup but VRAM unverified [U].
- **Nemotron 3 Nano MoE (25 GB)**: 85%, weak format compliance (6/8) [S jdhodges]; skip. **DeepSeek-R1 distills**: poor tool-calling [S]. **Hammer / xLAM function-calling fine-tunes**: failed under LM Studio due to template mismatch [S].
- **Qwen3.8-2.4T-A95B, Kimi K3, DeepSeek V4 Flash**: not local-feasible on consumer hardware [P/S] https://github.com/QwenLM/Qwen3.8 , https://lmstudio.ai/blog .

### 2.3 Generic quirks worth designing around

- Always `--jinja` (llama.cpp); verify `Chat format` is not `Generic` in server logs; check `/props` [P].
- Thinking models burn tokens and may leak `<think>` into parsers; for an assistant prefer thinking on for planning turns and off for simple tool turns [U].
- Do not quantise KV below q8_0 for agent use [P llama.cpp doc]. One roundup warns tool-call formatting can degrade at Q4 and suggests Q6 for long agentic runs [S] https://computingforgeeks.com/ollama-models-cheat-sheet/ (via search summary).
- Agent system prompt + tool schemas eat context: Ollama says >=64K; Gemma-in-Codex write-up says 32K practical minimum [S] https://codex.danielvaughan.com/2026/04/10/gemma-4-local-model-codex-cli ; OpenClaw says test with real prompts, text-only checks prove nothing [P] https://docs.openclaw.ai/gateway/local-models
- Parallel tool calls: Qwen3.5 4B fires dependent calls too eagerly [S jdhodges]; keep `parallel_tool_calls` off by default [P llama.cpp doc] and enable only for independent calls.
- CUDA 13.2 + low-bit quants gibberish; build pinning [S insiderllm].

---

## 3. Per-VRAM-tier recommendations

Numbers are community-reported ballparks, not controlled benchmarks; they vary with RAM speed, quant, context. "System RAM" matters for MoE offload: assume 32 GB minimum, 64 GB comfortable.

| Tier | Best pick | Quant / flags | Practical context | Expected tok/s | Tool-calling notes |
|---|---|---|---|---|---|
| **8 GB** | Qwen3.6-35B-A3B with MoE offload (needs 32-64 GB RAM). Fallback if RAM is short: Qwen3.5-9B Q4/Q6 | IQ4_XS or UD-Q4, `--n-cpu-moe` high, `-fa on`, KV q8_0 | 32K realistic; 128K possible with slower speed | ~25-40 (anecdotal) for 35B-A3B; dense 9B fully on GPU likely 40+ [U] | 9B: BFCL-v4 0.661 (secondary). 35B-A3B "mixed" in loops; test hard. Below 9B (4B/2B) is for narrow, scripted tool use only |
| **12 GB** | Qwen3.6-35B-A3B | UD-Q4_K_M `-ngl 99 -ncmoe 24 -fa 1` (38 tok/s) or IQ4_XS `-ncmoe 18` (46.8) | 16-32K comfortably, 65K with q8_0 KV and tighter offload | ~38-47 on RTX 3060 12 GB | Same as above. Alt: Gemma 4 12B QAT Q4_0 (fits with room) but no tool-call evidence |
| **16 GB** | Qwen3.6-35B-A3B (Q3_K_M fits; Q4 with `--cpu-moe` + 32 GB RAM) | UD-Q3_K_M or Q4 + offload | 32-64K | ~25-50 (community estimates) | Alt: GLM-4.7-Flash (95% in small test; MIT); gpt-oss-20b (~12 GB, 65 tok/s, weak multi-tool). Qwen3.8-27B Q3 fits but with little context [S pasqualepillitteri] |
| **24 GB** | **Qwen3.6-27B Q4_K_M** (best-evidenced); trial **Qwen3.8-27B Q4_K_M** (~16 GB) | Q4_K_M, `-fa on`, KV q8_0, headless (no display on the card if possible) | 64-120K (KV compression forks claim more; stock: plan ~64K) | ~35-60 stock llama.cpp (sources conflict 35-120) | SWE-bench Verified 77.2, TB2 59.3 (vendor). Can loop on failing tasks; add loop guards. Speed option: Qwen3.6-35B-A3B Q4 fully on GPU, 122-157 tok/s at ~50K ctx |
| **32 GB** (5090) | Qwen3.8-27B or Qwen3.6-27B at Q6 (22 GB) or Q8 (29 GB, tight) | Q6_K with big context, KV q8_0 | 128K+ | Dense 27B ~50-100 [U]; 35B-A3B ~170 tok/s on 5090 (one source) | Higher quant helps tool-call formatting (see warning on Q4 degradation) |
| **48+ GB** (2x24, A6000, 48 GB card) | Qwen3.8-27B Q8 with 128K+ KV; for more capacity Qwen3.5-122B-A10B at ~Q3/Q4 (~70 GB) needs 64-96 GB total | Q8_0 / split across GPUs | 128-262K | 27B Q8 split ~30-50 [U]; 122B-A10B on DGX Spark 40-52 tok/s | gpt-oss-120b (~65 GB) and GLM-4.5-Air fit at 64-96 GB but are not better agent picks than Qwen per available evidence |
| **Unified memory 64-128 GB** (Mac, Strix Halo, DGX Spark) | 64 GB: Qwen3.6-27B/3.8-27B Q8 or 35B-A3B Q6-Q8. 96-128 GB: Qwen3.5-122B-A10B Q4 | llama.cpp / LM Studio (MLX on Mac) | 128K+ | 122B-A10B on Spark: 40-52 tok/s (vLLM/SGLang tuned); Strix Halo 128 GB: GLM-4.7-Flash 52, gpt-oss-20b 65, Qwen3.5-4B 48 (jdhodges); Strix Halo 122B-class ~28 (unverified) | Prompt processing is the weak point on bandwidth-limited unified memory [U]. Sources: https://forums.developer.nvidia.com/t/qwen3-5-122b-a10b-on-single-spark-up-to-51-tok-s-v2-1-patches-quick-start-benchmark/365639/228 , https://www.contextstudios.ai/local-ai/0xsero--qwen3.5-99b-reap-q4km-gguf-strix-halo |
| **CPU only** | Qwen3.5-4B or 9B Q4 (dense), or Qwen3.6-35B-A3B Q4 if >=32 GB RAM (3B active makes CPU decode tolerable) | llama.cpp, all threads | 16-32K | Single-digit to ~15-17 tok/s (one GTX 1060 6 GB + large RAM report: 17 tok/s at 256K) [S, anecdotal] | Prompt processing will be slow (agent prompts are 5-15K tokens); realistic only for low-urgency chat/automation |

Notes:
- If the hardware inventory shows an AMD or Intel GPU: llama.cpp Vulkan works (Ollama also uses Vulkan on Windows for Radeon [P https://docs.ollama.com/windows]); CUDA is faster where available (3090 test) [S].
- Always size for the full agent prompt: tool schemas + memory + history. Plan for 32K minimum, 64K comfortable.

---

## 4. Honest gap and hybrid pattern

### 4.1 Where local models still fall short (always-on personal agent)

- **Capability gap:** Epoch AI estimate cited by WhatLLM: open-weight models lag the closed frontier by roughly four months, and public benchmarks may flatter open models [S] https://whatllm.org/blog/open-source-vs-proprietary-llms-2026 . Frontier lead persists on contamination-resistant tests: SWE-bench Pro Claude Opus 4.8 69.2 vs GLM-5.2 62.1 [S] https://dev.to/michael_lee_4c5625964438c/how-to-read-a-2026-ai-benchmark-chart-without-getting-fooled-2m5p . An older Codesota snapshot showed ~30 points on Terminal-Bench between best open and best closed [S] https://www.codesota.com/benchmark/terminal-bench . **Important:** those open results are the 750B-class models (GLM-5.2) that you cannot run locally; the consumer-sized models you can run (27-35B) score lower than the headline open-weight numbers.
- **Consumer-sized specifics (all vendor numbers):** Qwen3.6-27B Terminal-Bench 2.0 59.3 (equals Claude Opus 4.5 per Qwen's table) [P]. Vendor tables are best case; real harness differences are large.
- **Long-horizon reliability:** small and mid models loop on failing steps, mis-handle bespoke tool schemas, and degrade at long context [S vantaige, insiderllm]. Single-shot tool-call accuracy (97% on easy tests) does not predict 30-step success.
- **Prompt injection / safety:** local models have no hosted safety filters; OpenClaw's own docs say you must manage tool permissions and injection defenses yourself and keep agents narrow [P] https://docs.openclaw.ai/gateway/local-models . For an agent reading Telegram messages, web pages and files with shell access, injection resistance is a frontier-model strength and a local-model weakness [U; I found no benchmark on this].
- **Latency and uptime:** cold loads after idle, thinking-token latency, and a single GPU shared with your normal desktop use (a desktop session consumes ~4.4 GB VRAM on a 3090 [S insiderllm]).
- **Maintenance:** parser/template regressions after runtime updates (llama.cpp b8954-b8967 breakage, LM Studio gpt-oss parser regression) mean you must pin versions and run a tool-call smoke test on each update.

### 4.2 Hybrid pattern that is worth it

Local-default, API-escalate. Keep the router in your own agent code, not only in a gateway, because OpenClaw-style fallbacks trigger on provider error, not on task difficulty or context size [P] https://docs.openclaw.ai/gateway/local-models .

Escalate to the frontier API when any of these fire (my proposed rules [U]):
1. Tool-call parse failure or schema-invalid arguments after 1 retry.
2. Loop guard: same tool + same args N times, or N steps without progress.
3. Task tagged as high-stakes or destructive (shell writes outside a sandbox, deleting files, sending messages, spending money) - plan and review on API, even if cheap steps run locally.
4. Untrusted content in context (web pages, inbound email, forwarded files): use the stronger model to decide on tool use.
5. Context would exceed the local model's reliable window (~64K).
6. User override (`/pro`, `/deep`), or explicit "think hard" tasks.

Cheap local work: summarising, classification, triage, routine file ops with tight tool allowlist, cron-style checks, drafting. Expensive API work: multi-file refactors, planning, ambiguous requests, anything touching credentials.

Plumbing options: both LM Studio and llama-swap expose `/v1/messages` (Anthropic-style), so an Anthropic-SDK-based agent can point at local or at the real API by swapping `ANTHROPIC_BASE_URL` and model name [P] https://lmstudio.ai/docs/developer/anthropic-compat , https://github.com/mostlygeek/llama-swap . Claude Code with local servers has been reported to need a LiteLLM proxy in some setups (Anthropic-format calls) [S vantaige]; LM Studio 0.4.1+ and Ollama now offer native endpoints so this may be unnecessary - test.

---

## 5. Suggested defaults to carry forward (pending the hardware inventory)

- Runtime: LM Studio llmster with a Task Scheduler "at logon" job and the model loaded with `--ttl` large or `0`/no TTL; keep a llama-server + llama-swap config as plan B. [U on Task Scheduler recipe]
- Model: Qwen3.6-27B (24+ GB) or Qwen3.6-35B-A3B (8-16 GB with `--n-cpu-moe`); evaluate Qwen3.8-27B head-to-head on the real agent harness.
- Context: 64K minimum configured explicitly; KV cache q8_0 at most aggressive; parallel slots 1-2.
- Acceptance test before trusting a model: a 30-50 case tool-call suite with the agent's *real* tool schemas and system prompt, including multi-step chains and a long-context run. Pass rate target >=95% single-step, loop-free on 10 multi-step tasks.
- Safety: tool allowlist, sandboxed shell, Telegram user-ID allowlist, confirmation on destructive actions; treat all fetched content as untrusted.

## 6. Source-quality warnings

- d-central.tech, vantaige.io, insiderllm.com, gpuprix.com, bestllmfor.com, verdent.ai and similar are SEO/affiliate-adjacent aggregators; I used them only for pointers and flagged numbers [S].
- The LM Studio changelog page at lmstudio.ai/changelog now appears to be for the separate Bionic product (versions 1.1.x), not LM Studio 0.4.x; I used per-version pages for LM Studio and flagged the 0.4.26 claim [U].
- Several fetched pages were summarised by a small model; quoted figures should be re-read on the source page before committing money or architecture to them.
