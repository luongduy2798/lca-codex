import {
  LCA_CODEX_BASE_MODEL,
  resolveLcaCodexReasoningMode,
  type LcaCodexAdapterEffort,
  type LcaCodexReasoningMode,
} from "../../lca-codex-models";

export const LCA_CODEX_MODEL_ID = LCA_CODEX_BASE_MODEL;

export interface LcaCodexCapabilities {
  localToolsEnabled: boolean;
  /** Live indexed thinking-slider positions. New callers should always provide this. */
  effortLevelCount?: number;
  /** Legacy compatibility for persisted/test callers; only used when effortLevelCount is absent. */
  proAvailable?: boolean;
}

export interface LcaCodexModelMode {
  modelId: string;
  effort: LcaCodexAdapterEffort;
  displayLabel: LcaCodexReasoningMode["displayLabel"];
  uiEffortIndex: LcaCodexReasoningMode["uiEffortIndex"];
  localTools: boolean;
}

export function resolveLcaCodexModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: LcaCodexCapabilities,
): LcaCodexModelMode {
  if (modelId !== LCA_CODEX_MODEL_ID) {
    throw new Error(`LCA Codex model is not supported: ${modelId}`);
  }
  const effortLevelCount = capabilities.effortLevelCount
    ?? (capabilities.proAvailable === true ? 5 : 3);
  const mode = resolveLcaCodexReasoningMode(reasoning, effortLevelCount);
  return {
    modelId,
    effort: mode.adapterEffort,
    displayLabel: mode.displayLabel,
    uiEffortIndex: mode.uiEffortIndex,
    localTools: capabilities.localToolsEnabled,
  };
}
