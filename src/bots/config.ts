/**
 * The `Config` one bot's tools and prompt are built from (S20.1, S20.3): the host `Config` with the bot's own folders, its
 * effective read roots and its shell switch. Everything the host shares stays shared on purpose: the data root (so the in-process
 * deny of the whole data root, which covers every `bots\*`, still applies), the control dir (the kill switch is ONE flag for the
 * host: `/killshell` in any bot turns shell off in every bot), the audit dir, the run dir, `programDataDir` and `userFile`.
 *
 * For the implicit `main` of a one-bot install the result equals the host config, so the Phase 1 to 3 behaviour is unchanged.
 *
 * Pure: types and `win32` joins only.
 */
import type { Config } from "../config/schema.js";
import { botPaths } from "./paths.js";
import { effectiveReadRoots, effectiveTools } from "./schema.js";
import type { PresetConfig, ResolvedBot } from "./schema.js";

export function configForBot(base: Config, bot: ResolvedBot, presets: readonly PresetConfig[] = []): Config {
  const p = botPaths(base.paths.dataDir, bot.id, bot.layout);
  const tools = effectiveTools(bot);
  const primary = presets.find((x) => x.id === bot.route.primary);
  const runner = primary?.kind === "local" && primary.runner !== undefined && (primary.runner === "lmstudio" || primary.runner === "strata") && base.model.runners[primary.runner] ? primary.runner : base.model.runner;
  return {
    ...base,
    model: { ...base.model, runner },
    folders: { allow: effectiveReadRoots(bot).map((r) => ({ ...r })), deny: [...base.folders.deny] },
    shell: { ...base.shell, enabled: base.shell.enabled && tools.includes("shell"), ...(bot.approvalTimeoutSec !== undefined ? { approvalTimeoutSec: bot.approvalTimeoutSec } : {}) },
    // the legacy layout keeps the host's own (possibly hand-edited) folders
    paths: bot.layout === "legacy" ? { ...base.paths } : { ...base.paths, stateDir: p.stateDir, workspaceDir: p.workspaceDir, memoryFile: p.memoryFile, logsDir: p.logsDir },
  };
}
