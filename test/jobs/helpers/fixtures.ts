/** Fixtures for the S14 tests: templates, job inputs, events. Nothing here starts a job or spends credits. */
import type { JobEvent, JobRequest, JobTemplateSummary } from "../../../src/jobs/contracts.js";
import type { JobTaskInput } from "../../../src/jobs/task.js";

export const CWD = "C:\\projects\\Personal\\creative-hub";

export function template(over: Partial<JobTemplateSummary> & { id: string }): JobTemplateSummary {
  return {
    title: over.id,
    description: `The ${over.id} template.`,
    engine: "claude",
    params: { type: "object", properties: { idea: { type: "string", maxLength: 200 } }, required: ["idea"], additionalProperties: false },
    flow: { enabled: false },
    paidModels: false,
    autostart: [],
    cloud: ["claude-subscription"],
    cwd: CWD,
    enabled: true,
    ...over,
  };
}

export const TPL_PLAIN = template({ id: "chiptune-loop", title: "Chiptune loop", description: "Make a short chiptune loop." });
export const TPL_BOOK = template({ id: "book-step", title: "Book step", description: "Run one Scriptorium step.", paidModels: true });
export const TPL_VN = template({ id: "vn-from-idea", title: "Visual novel from an idea", description: "A visual novel.", autostart: ["pixel-studio", "chiptune-studio", "comfyui"] });
export const TPL_FLOW = template({
  id: "video-short",
  title: "Short video",
  description: "A short video with Flow clips.",
  flow: { enabled: true, estimate: 40, maxCredits: 150 },
  cloud: ["claude-subscription", "google-flow"],
});
export const TPL_FLOW_PLAN = template({ id: "video-plan-job", flow: { enabled: true, estimator: "video-plan", maxCredits: 150 }, cloud: ["claude-subscription", "google-flow"] });
export const TPL_DSH = template({ id: "dsh-draft", engine: "dsh", cloud: ["deepseek-api"], enabled: false });
export const TPL_HUB = template({ id: "hub-start-vibetts", engine: "hub", cloud: [] });
export const ALL_TEMPLATES = [TPL_PLAIN, TPL_BOOK, TPL_VN, TPL_FLOW, TPL_FLOW_PLAN, TPL_DSH, TPL_HUB];

export function jobInput(tpl: JobTemplateSummary, over: Partial<JobTaskInput> = {}): JobTaskInput {
  const request: JobRequest = over.request ?? { templateId: tpl.id, params: { idea: "a lighthouse keeper" }, brief: "Make it about a lighthouse keeper who talks to gulls." };
  return {
    jobId: over.jobId ?? "job-aaaaaaaaaaaa",
    conversationId: over.conversationId ?? "1",
    request,
    template: tpl,
    createdAt: over.createdAt ?? Date.now(),
    ...(over.flowEstimateCredits !== undefined ? { flowEstimateCredits: over.flowEstimateCredits } : {}),
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event without its `jobId`, `seq` and `ts` (the fake runner fills them in). */
export type EventBody = DistributiveOmit<JobEvent, "jobId" | "seq" | "ts">;
