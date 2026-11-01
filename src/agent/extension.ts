/**
 * The `a7` extension (S6.1, plan 4.1): the seven tools, the four prompt sections and the approval gate as a
 * `beforeTool` hook. It is installed in the host registry and used through the host default selection: no
 * conversation ever passes an explicit `extensions` array (spec footgun 30), so `/new` conversations are gated too.
 *
 * Phase 2 (S15.1, I27): `search_files`, `write_file`, `remember` and `shell` are registered `deferred: true` (their schemas are
 * unchanged, so the P0.5 freeze holds); the model finds them with `tool_search`. `system_facts`, `list_dir` and `read_file` stay
 * always loaded. The one combined `beforeTool` is the approval gate preceded by `extraBeforeTool` (the Flow guard, U43a).
 *
 * Decision (recorded in plan section 14): the read policy includes the agent workspace as the alias `workspace`
 * (`readPolicyFromConfig(config, { includeWorkspace: true })`), so the model can read back what `write_file` wrote and
 * the saved shell output files. The workspace is the one carve-out of the in-process deny for the agent data root, it
 * holds only what the agent itself wrote, and every read is wrapped as untrusted content.
 */
import type {
  ApprovalTransport,
  AuditLog,
  ChatLookup,
  KillSwitch,
  Logger,
  Notifier,
  PeerProvenance,
} from "../contracts.js";
import { createApprovalGate } from "../approval/gate.js";
import type { ApprovalGate } from "../approval/gate.js";
import { createApprovalTokens } from "../approval/tokens.js";
import type { ApprovalTokens } from "../approval/tokens.js";
import type { Config } from "../config/schema.js";
import type { Redactor } from "../logging/redact.js";
import { ToolTask, defineExtension, hook } from "../pi/adapter.js";
import type { section } from "../pi/adapter.js";
import type { AfterToolHandler, BeforeToolHandler, Extension, ToolRegistration } from "../pi/adapter.js";
import { DEFERRED_PHASE1_TOOLS } from "../jobs/contracts.js";
import { composeAfterTool, composeBeforeTool } from "./hooks.js";
import { buildPromptSections, promptDepsFromConfig } from "../prompt/sections.js";
import type { PromptDeps } from "../prompt/sections.js";
import { createShellRunner } from "../shell/runner.js";
import type { ShellRunner } from "../shell/runner.js";
import { createShellTool } from "../shell/tool.js";
import { createFolderTools } from "../tools/folders.js";
import { readPolicyFromConfig, writePolicyFromConfig } from "../tools/pathPolicy.js";
import type { PathPolicy } from "../tools/pathPolicy.js";
import { createRememberTool } from "../tools/memory.js";
import type { MemoryTarget } from "../tools/memory.js";
import { createSystemFactsTool } from "../tools/systemFacts.js";
import type { PsRunner } from "../tools/systemFacts.js";
import { createWriteFileTool } from "../tools/workspace.js";
import type { HealthStatus } from "../runtime/health.js";

export const A7_EXTENSION_NAME = "a7";

export interface A7Deps {
  config: Config;
  logger: Logger;
  redact: Redactor;
  audit: AuditLog;
  killSwitch: KillSwitch & { blockReason?: () => "killswitch" | "disabled" };
  /** The Telegram side: approval cards, "Saved to memory" notices and the conversation to chat lookup. */
  telegram: { approvalTransport: ApprovalTransport; notifier: Notifier; chatLookup: ChatLookup };
  /** The runner health monitor (S1.5), for `system_facts` fact `lmstudio`. */
  health?: { status(): HealthStatus } | undefined;
  /** The model id the conversations run on (for the runtime section and `system_facts`). */
  modelId: string;
  /** Test seams. */
  shellRunner?: ShellRunner;
  psRunner?: PsRunner;
  tokens?: ApprovalTokens;
  gatePollMs?: number;
  promptDeps?: Partial<PromptDeps>;
  /** Other guards composed into the single host `beforeTool`, before the approval gate (Phase 2: the Flow guard). */
  extraBeforeTool?: readonly BeforeToolHandler[];
  /**
   * Phase 3: sections rendered right after `preamble` and before `user_profile` (`persona`, `guardrails`, `style`; I27e). The Phase 1/2
   * order of the four base sections is unchanged.
   */
  afterPreamble?: readonly ReturnType<typeof section>[];
  /** Phase 3 (S19.5): where `remember` writes for a conversation's persona, and what the memory section shows. */
  memoryTarget?: ((conversationId: string) => MemoryTarget) | undefined;
  memoryFor?: PromptDeps["memoryFor"];
  /**
   * Phase 4 (S26.1): the read and write policies of one bot of a multi-bot install (`botReadPolicy` and `botWritePolicy`: the bot's own
   * workspace, sibling-bot denies, `shared`). Absent: the Phase 1 to 3 policies from `config`, byte for byte as before.
   */
  readPolicy?: PathPolicy | undefined;
  writePolicy?: PathPolicy | undefined;
  /** Phase 4: runs after every tool call (the bus taints the chain on a content-ingesting tool). */
  extraAfterTool?: readonly AfterToolHandler[];
  /** Phase 4 (S26.2): the peer replies a conversation's current turn received, quoted on the shell approval card. */
  provenanceFor?: ((conversationId: string) => readonly PeerProvenance[] | undefined) | undefined;
}

export interface A7Extension {
  extension: Extension;
  gate: ApprovalGate;
  tokens: ApprovalTokens;
}

export function createA7Extension(deps: A7Deps): A7Extension {
  const { config, logger, redact, audit, killSwitch } = deps;
  const getShellConfig = () => config.shell;
  const tokens = deps.tokens ?? createApprovalTokens();

  const readPolicy = deps.readPolicy ?? readPolicyFromConfig(config, { includeWorkspace: true });
  const writePolicy = deps.writePolicy ?? writePolicyFromConfig(config);

  const shellRunner = deps.shellRunner ?? createShellRunner({ workspaceDir: config.paths.workspaceDir, getShellConfig });

  const [listDir, readFile, searchFiles] = createFolderTools({ policy: readPolicy, limits: config.limits, logger });
  const systemFacts = createSystemFactsTool({
    runner: config.model.runner,
    modelId: deps.modelId,
    health: deps.health,
    redact,
    logger,
    ...(deps.psRunner ? { runPowerShell: deps.psRunner } : {}),
  });
  const writeFile = createWriteFileTool({ policy: writePolicy, logger });
  const remember = createRememberTool({ memoryFile: config.paths.memoryFile, notifier: deps.telegram.notifier, logger, ...(deps.memoryTarget ? { resolveTarget: deps.memoryTarget } : {}) });
  const shell = createShellTool({
    runner: shellRunner,
    approvals: tokens,
    killSwitch,
    audit,
    getShellConfig,
    cwd: config.paths.workspaceDir,
    logger,
    redact,
  });

  const gate = createApprovalGate({
    transport: deps.telegram.approvalTransport,
    killSwitch,
    chats: deps.telegram.chatLookup,
    approvals: tokens,
    audit,
    getShellConfig,
    cwd: config.paths.workspaceDir,
    logger,
    ...(deps.gatePollMs !== undefined ? { pollMs: deps.gatePollMs } : {}),
    ...(deps.provenanceFor ? { provenanceFor: deps.provenanceFor } : {}),
  });

  const sections = buildPromptSections({
    ...promptDepsFromConfig(config, { killSwitch, logger, modelId: deps.modelId }),
    // The runtime section names every alias the read tools accept, the workspace included.
    aliases: readPolicy.roots.map((r) => r.alias),
    ...(deps.memoryFor ? { memoryFor: deps.memoryFor } : {}),
    ...(deps.promptDeps ?? {}),
  });

  // Section order (I27e): preamble, [persona, guardrails, style], user_profile, memory, runtime.
  const orderedSections = [...sections.slice(0, 1), ...(deps.afterPreamble ?? []), ...sections.slice(1)];

  // Order = TOOL_SPECS (the bake-off order). Tool generics differ per schema, so the list is typed by the base registration.
  const all = [systemFacts, listDir, readFile, searchFiles, writeFile, remember, shell] as unknown as ToolRegistration[];
  const deferred = new Set<string>(DEFERRED_PHASE1_TOOLS);
  const tools = all.map((t) => (deferred.has(t.name) ? ({ ...t, deferred: true } as ToolRegistration) : t));

  const extension = defineExtension({
    name: A7_EXTENSION_NAME,
    tools,
    sections: orderedSections,
    hooks: [
      hook(ToolTask, {
        beforeTool: composeBeforeTool(...(deps.extraBeforeTool ?? []), gate.beforeTool),
        ...(deps.extraAfterTool && deps.extraAfterTool.length > 0 ? { afterTool: composeAfterTool(...deps.extraAfterTool) } : {}),
      }),
    ],
  });
  return { extension, gate, tokens };
}
