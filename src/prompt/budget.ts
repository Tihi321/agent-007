/**
 * Context budget (S5.3). Pi Durable 1.4.0 compacts a conversation when its context passes `contextWindow - reserveTokens`
 * (U10 settled by `dist/harness/types.d.ts`: `HarnessSettings.compaction.modelOverrides`, keyed by the exact
 * "provider/modelId", each field overriding the harness-wide one). We set the blocking threshold at 75% of the model's
 * `contextWindow`, so `reserveTokens = contextWindow - threshold`.
 *
 * `contextWindow` and `maxTokens` come from `config.model.runners.<runner>` (the G0 values in `bakeoff-results.md`);
 * S6 passes `selectRunner(...).provider` here. This module imports no Pi code.
 */

export const COMPACTION_THRESHOLD_RATIO = 0.75;
/** A background compaction starts this share of the window below the blocking threshold. */
export const BACKGROUND_RATIO = 0.1;
/** Recent context a summary keeps verbatim: a quarter of the window, at most Pi's default of 20,000 tokens. */
export const KEEP_RECENT_MAX_TOKENS = 20_000;

/** The context size (tokens) at which a request blocks to compact: 0.75 x `contextWindow`. */
export function compactionThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new RangeError(`contextWindow must be a positive number, got ${contextWindow}`);
  return Math.floor(contextWindow * COMPACTION_THRESHOLD_RATIO);
}

export interface CompactionPolicyOverride {
  reserveTokens: number;
  keepRecentTokens: number;
  backgroundTokens: number;
}

/** The per-model override Pi takes: `reserveTokens` is the room above the threshold, so the threshold is 75%. */
export function compactionOverride(contextWindow: number): CompactionPolicyOverride {
  const threshold = compactionThreshold(contextWindow);
  return {
    reserveTokens: contextWindow - threshold,
    keepRecentTokens: Math.min(KEEP_RECENT_MAX_TOKENS, Math.floor(contextWindow * 0.25)),
    backgroundTokens: Math.floor(contextWindow * BACKGROUND_RATIO),
  };
}

export interface ModelBudgetInput {
  /** The provider id (the runner name). */
  id: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

/** The `compaction` block for `Harness.open` settings: `{ modelOverrides: { "<provider>/<modelId>": override } }`. */
export function compactionSettings(model: ModelBudgetInput): { modelOverrides: Record<string, CompactionPolicyOverride> } {
  if (model.maxTokens >= model.contextWindow) throw new RangeError("maxTokens must be smaller than contextWindow");
  return { modelOverrides: { [`${model.id}/${model.modelId}`]: compactionOverride(model.contextWindow) } };
}

/**
 * Checks the room left for an answer: the reply (`maxTokens`) must fit between the threshold and the window.
 * Returns a message when it does not, for S6 to report at start.
 */
export function budgetProblem(model: ModelBudgetInput): string | undefined {
  const room = model.contextWindow - compactionThreshold(model.contextWindow);
  if (model.maxTokens > room) return `maxTokens (${model.maxTokens}) is larger than the room above the compaction threshold (${room}); lower maxTokens or raise contextWindow`;
  return undefined;
}
