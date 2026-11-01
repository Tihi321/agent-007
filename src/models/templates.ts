/**
 * MA2: preset templates for the Claude brain through the ACP proxy. Offered in the settings UI `models` form as copyable JSON and
 * documented in `config/config.example.json`. They are TEMPLATES: `contextWindow` and `maxTokens` are placeholders the user sets by
 * hand (U52), and a preset made from them is refused until the Claude acknowledgment is ticked in the Terms form (I41, UI-24).
 * `autoFallback` is false: a Claude preset is a brain, never a fallback target. The key reference is always `proxyApiKey` (D12).
 */
import type { PresetConfig } from "../bots/schema.js";

export const CLAUDE_PRESET_TEMPLATES: readonly PresetConfig[] = [
  { id: "claude-sonnet", kind: "acp", label: "Claude Sonnet (subscription, through the proxy)", baseUrl: "http://127.0.0.1:8787/v1", modelId: "claude/sonnet", providerId: "claude", apiKeyRef: "proxyApiKey", contextWindow: 200000, maxTokens: 8192, privacy: "cloud", autoFallback: false },
  { id: "claude-opus", kind: "acp", label: "Claude Opus (subscription, through the proxy)", baseUrl: "http://127.0.0.1:8787/v1", modelId: "claude/opus", providerId: "claude", apiKeyRef: "proxyApiKey", contextWindow: 200000, maxTokens: 8192, privacy: "cloud", autoFallback: false },
];

export interface FormTemplate {
  label: string;
  /** Where in the form it goes: the `presets` array. */
  target: string;
  json: string;
}

export function claudeFormTemplates(): FormTemplate[] {
  return CLAUDE_PRESET_TEMPLATES.map((p) => ({ label: p.label, target: "presets", json: JSON.stringify(p, null, 2) }));
}
