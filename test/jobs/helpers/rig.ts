/**
 * A real Pi Harness (SQLite file) with the S14 jobs extension, over a fake OpenAI-compatible model (only used by the tests
 * that drive the model), a `FakeRunner` and a fake transport. "Restart" = `close()` then `openJobsRig` on the same dir and
 * the same `FakeRunner`. Nothing here contacts Telegram, starts a job or spends credits.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier } from "../../../src/contracts.js";
import type { JobApprovalTransport, JobRunnerClient, JobTemplateSummary } from "../../../src/jobs/contracts.js";
import { flowLedgerDoc, readLedger } from "../../../src/jobs/ledger.js";
import type { LedgerDoc } from "../../../src/jobs/ledger.js";
import { createJobsExtension, staticTemplates } from "../../../src/jobs/tools.js";
import type { FlowEstimator, JobsExtension, JobsExtensionDeps, TemplateSource } from "../../../src/jobs/tools.js";
import type { JobTaskInput } from "../../../src/jobs/task.js";
import {
  BACKGROUND_CONTEXT,
  Harness,
  ToolTask,
  createRegistry,
  createRunnerModels,
  defineExtension,
  hook,
  openNodeSqliteStorage,
} from "../../../src/pi/adapter.js";
import type { Conversation, Extension, TaskId } from "../../../src/pi/adapter.js";
import { memoryLogger } from "../../telegram/helpers/fakeTelegram.js";
import { ALL_TEMPLATES } from "./fixtures.js";

export const ctx = BACKGROUND_CONTEXT;
export const MODEL_ID = "fake-model";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "a7-jobs-"));
}

export interface JobsRigOptions {
  dir: string;
  client: JobRunnerClient;
  transport: JobApprovalTransport;
  templates?: readonly JobTemplateSummary[] | TemplateSource;
  /** Base URL of a fake OpenAI server; omit for tests that never run the model. */
  baseUrl?: string;
  notifier?: Notifier;
  flowEstimator?: FlowEstimator;
  /** Installed as well (for example a fake Flow tool); they share the host default selection. */
  extensions?: Extension[];
  /** Install the Flow guard's `beforeTool` as a ToolTask hook. */
  flowHook?: boolean;
  overrides?: Partial<JobsExtensionDeps>;
}

export interface JobsRig {
  dir: string;
  harness: Harness;
  root: Conversation;
  jobs: JobsExtension;
  log: ReturnType<typeof memoryLogger>;
  notes: string[];
  /** Creates the Job task straight in the root conversation (the way `dispatch_job` does), returns its id. */
  createJob(input: JobTaskInput): Promise<TaskId>;
  wait(id: TaskId): ReturnType<Harness["waitForTask"]>;
  ledger(): Promise<LedgerDoc>;
  close(): Promise<void>;
}

export async function openJobsRig(o: JobsRigOptions): Promise<JobsRig> {
  const log = memoryLogger();
  const notes: string[] = [];
  const { models } = createRunnerModels({ id: "lmstudio", baseUrl: o.baseUrl ?? "http://127.0.0.1:9/v1", modelId: MODEL_ID, apiKey: "k-test-1234", contextWindow: 8192, maxTokens: 512 });
  const jobs = createJobsExtension({
    templates: o.templates === undefined ? staticTemplates(ALL_TEMPLATES) : Array.isArray(o.templates) ? staticTemplates(o.templates) : (o.templates as TemplateSource),
    client: o.client,
    transport: o.transport,
    notifier: o.notifier ?? { notify: async (_c, t) => void notes.push(t) },
    flowEstimator: o.flowEstimator,
    logger: log,
    approvalTimeoutSec: 60,
    progressIntervalSec: 0.02,
    pollMs: 40,
    retryDelayMs: 10,
    flowServerId: "flow-music-mcp",
    ...o.overrides,
  });
  const registry = createRegistry();
  registry.install(jobs.extension);
  if (o.flowHook) registry.install(defineExtension({ name: "flow-hook", hooks: [hook(ToolTask, { beforeTool: jobs.flowGuard.beforeTool })] }));
  for (const e of o.extensions ?? []) registry.install(e);
  const storage = await openNodeSqliteStorage(join(o.dir, "agent.sqlite"));
  const harness = await Harness.open(storage, { models, registry, settings: { stream: { timeoutMs: 20_000 } } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "lmstudio", modelId: MODEL_ID } } });
  harness.resume();
  let closed = false;
  return {
    dir: o.dir,
    harness,
    root,
    jobs,
    log,
    notes,
    createJob: (input) =>
      root.commit((tx) => tx.createTask(jobs.jobTask, input, { ownership: { kind: "conversation" }, background: true }), ctx),
    wait: (id) => harness.waitForTask(id, ctx),
    ledger: async () => readLedger(await harness.snapshot(flowLedgerDoc, ctx)),
    close: async () => {
      if (closed) return;
      closed = true;
      await harness.close(ctx);
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
