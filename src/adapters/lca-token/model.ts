import {
  LCA_TOKEN_BACKEND_MODEL,
  resolveLcaTokenReasoningMode,
  type LcaTokenAdapterEffort,
  type LcaTokenReasoningMode,
} from "../../lca-token-models";

export const LCA_TOKEN_MODEL_ID = LCA_TOKEN_BACKEND_MODEL;

export interface LcaTokenCapabilities {
  localToolsEnabled: boolean;
  proAvailable: boolean;
}

export interface LcaTokenModelMode {
  modelId: string;
  effort: LcaTokenAdapterEffort;
  displayLabel: LcaTokenReasoningMode["displayLabel"];
  uiEffortIndex: LcaTokenReasoningMode["uiEffortIndex"];
  localTools: boolean;
}

export function resolveLcaTokenModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: LcaTokenCapabilities,
): LcaTokenModelMode {
  if (modelId !== LCA_TOKEN_MODEL_ID) {
    throw new Error(`Lca Token model is not supported: ${modelId}`);
  }
  const mode = resolveLcaTokenReasoningMode(reasoning, capabilities.proAvailable);
  return {
    modelId,
    effort: mode.adapterEffort,
    displayLabel: mode.displayLabel,
    uiEffortIndex: mode.uiEffortIndex,
    localTools: mode.adapterEffort === "max" ? false : capabilities.localToolsEnabled,
  };
}
