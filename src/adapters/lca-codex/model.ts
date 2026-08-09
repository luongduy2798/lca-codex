import {
  LCA_CODEX_BACKEND_MODEL,
  resolveLcaCodexReasoningMode,
  type LcaCodexAdapterEffort,
  type LcaCodexReasoningMode,
} from "../../lca-codex-models";

export const LCA_CODEX_MODEL_ID = LCA_CODEX_BACKEND_MODEL;

export interface LcaCodexCapabilities {
  localToolsEnabled: boolean;
  proAvailable: boolean;
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
  const mode = resolveLcaCodexReasoningMode(reasoning, capabilities.proAvailable);
  return {
    modelId,
    effort: mode.adapterEffort,
    displayLabel: mode.displayLabel,
    uiEffortIndex: mode.uiEffortIndex,
    localTools: mode.adapterEffort === "max" ? false : capabilities.localToolsEnabled,
  };
}
