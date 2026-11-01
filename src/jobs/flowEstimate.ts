/**
 * The agent's Flow estimator (S14.4, U38): asks the job runner for the read-only `video-plan` estimate of a template and
 * returns the number the approval card shows. Any failure becomes a `FlowEstimateError` with a message the user can act on;
 * nothing is guessed and no default is used.
 */
import type { FlowEstimator } from "./tools.js";
import { FlowEstimateError } from "./tools.js";
import type { JobRunnerClient } from "./contracts.js";

export const FLOW_ESTIMATE_TIMEOUT_MS = 45_000;

export function createRunnerFlowEstimator(client: Pick<JobRunnerClient, "state" | "flowEstimate">, timeoutMs = FLOW_ESTIMATE_TIMEOUT_MS): FlowEstimator {
  return async ({ template, params }) => {
    if (client.state !== "online") throw new FlowEstimateError("the job runner is offline, so the estimate cannot be read.");
    try {
      const r = await client.flowEstimate({ templateId: template.id, params }, { timeoutMs });
      if (typeof r?.credits !== "number" || !Number.isFinite(r.credits) || r.credits <= 0) throw new FlowEstimateError("the job runner returned no usable number.");
      return r.credits;
    } catch (e) {
      if (e instanceof FlowEstimateError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new FlowEstimateError(`${msg.replace(/\s+/g, " ").slice(0, 300)}${/[.!?]$/.test(msg) ? "" : "."}`);
    }
  };
}
