# System inventory: agent-007 host

Date: 2026-10-26. Read-only checks only; nothing installed, started, stopped, loaded or unloaded.
Sources: a read-only scout pass (first section) plus the GPU-memory checks in the second section (commands listed).

## 1. Baseline (scout pass)

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26300 |
| CPU | AMD Ryzen AI Max+ 395 w/ Radeon 8060S (Strix Halo), 16 cores / 32 threads |
| RAM visible to Windows | 31.65 GB |
| GPU | Integrated AMD Radeon 8060S, unified memory. No NVIDIA GPU. |
| LM Studio | Installed and running, server on port 1234. CLI at `C:/Users/Infplane/.lmstudio/bin/lms` |
| Installed | Python 3.13.12, uv 0.12.2, git 2.55 (Git for Windows; `C:\Program Files\Git\bin\bash.exe` present), WSL2 Ubuntu (stopped) |
| Not installed | Node, npm, Docker, Ollama, llama.cpp (standalone) |
| Disk free | C: 227 GB of 1024, D: 620 of 883, F: 1260 of 1863 |

Downloaded models (`lms ls --json`, sizes in GiB as reported by the JSON; the scout's `lms ls` figures are in GB):

| Model key | Source repo (publisher/repo) | Arch | Params | Quant | Size | Max ctx | LM Studio "trainedForToolUse" | Vision |
|---|---|---|---|---|---|---|---|---|
| nail-qwen3.6-35b-a3b-mtp | peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP | qwen35moe | 35B-A3B | UD-Q4_K_XL | 22.1 | 262144 | false | yes |
| tiel-coder-35b-a3b-mtp | peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP | qwen35moe | 35B (A3B) | UD-Q4_K_XL | 22.0 | 262144 | false | yes |
| ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp | cruizba/ISTA-DASLab-Qwen3.8-27B-GSQ-RCO-GGUF-Unsloth-MTP | qwen35 | 27B dense | IQ3_XXS (+MTP) | 10.5 | 262144 | true | yes |
| qwen3.8-27b-blackfrost-abliterated-gsq-rco | 1105s110/Qwen3.8-27B-Blackfrost-Abliterated-GSQ-RCO-IQ3_XXS-GGUF | qwen35 | 27B dense | IQ3_XXS | 9.8 | 262144 | true | no |
| ornith-1.5-122b | unsloth/Ornith-1.5-122B-GGUF | qwen35moe | 122B (MoE) | UD-IQ3_XXS | 47.0 | 262144 | true | yes |
| minicpm-v-4.7-35b-a3b | openbmb/MiniCPM-V-4.7-35B-A3B-gguf | qwen35moe | 35B-A3B | Q4_K_S | 19.6 | 262144 | true | yes |
| lfm2.5-24b-a2b | LiquidAI/LFM2.5-24B-A2B-GGUF | lfm2moe | 24B-A2B | Q4_K_M | 13.5 | 131072 | true | no |
| recursivesi/flint | recursivesi/flint | flint | 40B | Q4_K_M | 22.5 | 262144 | true | no |
| gemma-4-e4b-it-ultra-uncensored-heretic | llmfan46/gemma-4-E4B-it-ultra-uncensored-heretic-GGUF | gemma4 | 7.5B (E4B) | Q4_K_M | 5.9 | 131072 | true | yes |
| text-embedding-nomic-embed-text-v1.5 | (embedding) | nomic-bert | n/a | Q4_K_M | 0.08 | 2048 | n/a | n/a |

Notes on the list:
- Every Qwen3.8-27B on disk is a 3-bit (IQ3_XXS) community re-quant. There is no official Qwen3.6-27B or Qwen3.8-27B at Q6/Q8.
- "Nail", "Tiel-Coder", "Ornith", "Flint", "Blackfrost" and "GSQ-RCO" are community derivatives or re-quants. None is covered by the research notes; what they change versus their base model is unknown.
- `trainedForToolUse=false` on the two peculiar-ragdoll Qwen3.6 35B-A3B files is LM Studio's metadata flag. Whether that makes LM Studio use its generic ("default") tool-call format instead of the native Qwen parser is unverified.

## 2. GPU-addressable memory (step 1 findings)

| Check | Command | Result |
|---|---|---|
| Installed physical RAM | `Get-CimInstance Win32_PhysicalMemory` | 8 x 16 GiB Samsung K3KLALA0EM-MGCU at 8000 MT/s = **128 GiB** (LPDDR5X-class soldered memory) |
| RAM visible to Windows | `Win32_ComputerSystem.TotalPhysicalMemory` | 31.65 GiB |
| Driver-reported dedicated VRAM | registry `HardwareInformation.qwMemorySize` under the display class key `0000` | **96.00 GiB** |
| dxdiag | `dxdiag /t .claude/temp/dxdiag.txt` | Memory 131072 MB; Available OS Memory 32406 MB; **Dedicated Memory 98083 MB**; Shared Memory 16203 MB; Display Memory 114287 MB; driver 32.0.12079.1014 (dated 2025-08-01) |
| LM Studio hardware survey | `lms runtime survey` | "AMD Radeon(TM) 8060S Graphics (ROCm, Integrated) 107.87 GiB"; RAM 31.65 GiB |
| WMI AdapterRAM | `Win32_VideoController` | 4 GiB (a 32-bit field that caps at 4 GiB, so it is not meaningful here) |

Interpretation:
- The BIOS/driver carve-out gives the iGPU **96 GiB of dedicated memory** out of 128 GiB. Windows and every app share the remaining ~32 GiB. The driver can also borrow up to ~16 GiB of shared system memory, which is why dxdiag shows 114 GB display memory and LM Studio's survey shows ~108 GiB. Borrowing that shared memory takes it from the ~32 GiB Windows side, so plan model + KV cache to fit in **96 GiB**.
- Capacity is not the constraint. Every model on disk fits fully on the GPU, including Ornith 122B (47 GiB), with tens of GiB left for KV cache. Two models can stay resident at once, for example a 22 GiB primary, a 20 GiB vision model and the embedding model.
- The constraint is memory bandwidth on unified memory. The inference notes flag prompt processing as the weak point on bandwidth-limited unified memory [U] and give Strix Halo 128 GB reference points: GLM-4.7-Flash 52 tok/s, gpt-oss-20b 65 tok/s, Qwen3.5-4B 48 tok/s ([jdhodges](https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/)), 122B-class about 28 tok/s (unverified). MoE models with few active parameters (A2B/A3B) will decode much faster here than a dense 27B. A dense 27B is still usable but slower.
- Context: with 96 GiB the notes' unified-memory tier applies (64-128 GB: Qwen3.6-27B/3.8-27B Q8 or 35B-A3B Q6-Q8, 128K+ context). For a single-user agent, 64K is the safe starting point and 128K is affordable in memory. The limit on long context here is prompt-processing time, not capacity.
- The ~32 GiB Windows side is enough for a Python agent, Telegram polling and the LM Studio GUI. It is tight if heavy desktop apps run on the same machine (Pixotope is installed and set to autorun).

## 3. LM Studio state (read from config files and `lms`, not changed)

| Item | Value | Source |
|---|---|---|
| App version | 0.4.26 build 4 | `~/.lmstudio/.internal/historical-version-info.json` (this confirms locally the 0.4.26 version the inference notes listed as unverified) |
| Server | running, port 1234, bound to **127.0.0.1** (netstat: `127.0.0.1:1234 LISTENING`) | `lms server status`, `http-server-config.json` (`networkInterface: 127.0.0.1`) |
| Server mode | Runs inside the GUI app (`LM Studio.exe`); `autoStartOnLaunch: true` | process list, `http-server-config.json` |
| JIT loading | on (`justInTimeModelLoading: true`) | `http-server-config.json` |
| Logging | `logSensitiveData: true`, `verbose: true` | `http-server-config.json` (whether this writes prompt text to log files is unverified) |
| CORS | off | `http-server-config.json` |
| Login autostart | No LM Studio entry in HKCU/HKLM Run, Startup folders or Task Scheduler | registry / Startup / `Get-ScheduledTask` |
| `lms` CLI | commands: chat, get, load, unload, ls, ps, import, server, log, link, runtime, clone, push, dev, login, logout, whoami. **No `daemon` subcommand** in this CLI build (commit dcefd5a), although the notes cite `lms daemon up` for the llmster headless daemon | `lms --help` |
| Currently loaded | gemma-4-e4b-it-ultra-uncensored-heretic, context 131072, parallel 2, TTL 477h/480h, idle | `lms ps` |
| Selected runtime | llama.cpp-win-x86_64-**amd-rocm**-avx2 @ 2.64.0 (GGUF) | `lms runtime ls`, `backend-preferences-v1.json` |
| Other runtimes installed | Vulkan llama.cpp 2.63.0 / 2.61.0 / ..., CPU avx2, several CUDA builds (unused, no NVIDIA GPU), earlier ROCm builds 2.60-2.63 | `lms runtime ls` |

Security notes from this pass:
- `~/.lmstudio/.internal/local-inference.json` holds a local access token in plaintext. Its value is not reproduced here. The agent must not be able to read `~/.lmstudio`.
- Other autostart entries seen: OneDrive, Edge, Pixotope daemon services, RustDesk tray (a remote-desktop tool), VibeFlow, VibeTTS, DeskMate. This is a work-and-personal machine; scope the agent's file access accordingly.
