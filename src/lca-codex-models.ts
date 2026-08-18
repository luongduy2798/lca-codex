export const LCA_CODEX_MODEL_SLUG = "lca-codex";
export const LCA_CODEX_MODEL_PREFIX = `${LCA_CODEX_MODEL_SLUG}/`;
export const LCA_CODEX_MODEL_DISPLAY_NAME = "LCA-5.6 Sol";
export const LCA_CODEX_MODEL_DESCRIPTION = "LCA Codex through the native Codex harness.";
export const LCA_CODEX_BASE_MODEL = "gpt-5.6-sol";

export type LcaCodexCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type LcaCodexAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Keep native Codex's normal 10% compaction headroom when LCA uses its advertised maximum. */
export const LCA_CODEX_AUTO_COMPACT_RATIO = 0.9;

export interface LcaCodexContextLimits {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

/**
 * Resolve the outer Codex lifetime limit from the native model catalog. Browser reasoning effort
 * does not change history size; lazy browser projection remains independently bounded.
 */
export function resolveLcaCodexContextLimits(
  _effort: LcaCodexAdapterEffort,
  nativeMaxContextWindow: unknown,
): LcaCodexContextLimits {
  if (typeof nativeMaxContextWindow !== "number"
    || !Number.isSafeInteger(nativeMaxContextWindow)
    || nativeMaxContextWindow <= 0) {
    throw new Error("Native Codex max_context_window must be a positive integer");
  }
  return {
    contextWindow: nativeMaxContextWindow,
    autoCompactTokenLimit: Math.floor(nativeMaxContextWindow * LCA_CODEX_AUTO_COMPACT_RATIO),
  };
}

export interface LcaCodexReasoningMode {
  codexEffort: LcaCodexCodexEffort;
  adapterEffort: LcaCodexAdapterEffort;
  displayLabel: "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4;
  requiresPro: boolean;
}

/** One public model; reasoning selects the ChatGPT browser mode. */
export const LCA_CODEX_REASONING_MODES: readonly LcaCodexReasoningMode[] = [
  { codexEffort: "low", adapterEffort: "low", displayLabel: "Instant", uiEffortIndex: 0, requiresPro: false },
  { codexEffort: "medium", adapterEffort: "medium", displayLabel: "Medium", uiEffortIndex: 1, requiresPro: false },
  { codexEffort: "high", adapterEffort: "high", displayLabel: "High", uiEffortIndex: 2, requiresPro: false },
  { codexEffort: "xhigh", adapterEffort: "xhigh", displayLabel: "Extra High", uiEffortIndex: 3, requiresPro: true },
  { codexEffort: "ultra", adapterEffort: "max", displayLabel: "Pro", uiEffortIndex: 4, requiresPro: true },
];

export function availableLcaCodexReasoningModes(proAvailable: boolean): readonly LcaCodexReasoningMode[] {
  return proAvailable
    ? LCA_CODEX_REASONING_MODES
    : LCA_CODEX_REASONING_MODES.filter(mode => !mode.requiresPro);
}

export function resolveLcaCodexReasoningMode(
  reasoning: string | undefined,
  proAvailable: boolean,
): LcaCodexReasoningMode {
  const effort = reasoning === "ultra" ? "max" : reasoning ?? "high";
  const mode = LCA_CODEX_REASONING_MODES.find(candidate => candidate.adapterEffort === effort);
  if (!mode) throw new Error(`LCA Codex effort is not supported: ${effort}`);
  if (mode.requiresPro && !proAvailable) {
    throw new Error(`${mode.displayLabel} effort is not available for this account`);
  }
  return mode;
}

export interface LcaCodexModelDescriptor {
  slug: string;
  displayName: string;
  description: string;
}

export const LCA_CODEX_MODEL: LcaCodexModelDescriptor = {
  slug: LCA_CODEX_MODEL_SLUG,
  displayName: LCA_CODEX_MODEL_DISPLAY_NAME,
  description: LCA_CODEX_MODEL_DESCRIPTION,
};

/** Reserve the lca-codex namespace so unsupported routed slugs cannot leak upstream. */
export function isLcaCodexModelSlug(modelId: string): boolean {
  return modelId === LCA_CODEX_MODEL_SLUG || modelId.startsWith(LCA_CODEX_MODEL_PREFIX);
}

export function requireLcaCodexModel(modelId: string): LcaCodexModelDescriptor {
  if (modelId !== LCA_CODEX_MODEL_SLUG) {
    throw new Error(`LCA Codex model is not enabled: ${modelId}`);
  }
  return LCA_CODEX_MODEL;
}
