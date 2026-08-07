export const LCA_TOKEN_MODEL_SLUG = "lca-token";
export const LCA_TOKEN_MODEL_PREFIX = `${LCA_TOKEN_MODEL_SLUG}/`;
export const LCA_TOKEN_MODEL_DISPLAY_NAME = "Lca Token";
export const LCA_TOKEN_MODEL_DESCRIPTION = "Lca Token through the native Codex harness.";
export const LCA_TOKEN_BACKEND_MODEL = "gpt-5.6-sol";

export type LcaTokenCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type LcaTokenAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const LCA_TOKEN_INSTANT_MEDIUM_CONTEXT_WINDOW = 150_000;
export const LCA_TOKEN_HIGH_CONTEXT_WINDOW = 185_000;
export const LCA_TOKEN_EXTRA_HIGH_CONTEXT_WINDOW = 256_000;
export const LCA_TOKEN_PRO_CONTEXT_WINDOW = 272_000;

export interface LcaTokenContextLimits {
  contextWindow: number;
  autoCompactTokenLimit: number;
}

/** Resolve the product limit for the selected visible Lca Token mode. */
export function resolveLcaTokenContextLimits(
  effort: LcaTokenAdapterEffort,
): LcaTokenContextLimits {
  const contextWindow = effort === "max"
    ? LCA_TOKEN_PRO_CONTEXT_WINDOW
    : effort === "xhigh"
      ? LCA_TOKEN_EXTRA_HIGH_CONTEXT_WINDOW
      : effort === "high"
        ? LCA_TOKEN_HIGH_CONTEXT_WINDOW
        : LCA_TOKEN_INSTANT_MEDIUM_CONTEXT_WINDOW;
  return {
    contextWindow,
    // Leave ten percent for Codex to submit and receive the compact checkpoint before the hard cap.
    autoCompactTokenLimit: Math.floor(contextWindow * 0.9),
  };
}

export interface LcaTokenReasoningMode {
  codexEffort: LcaTokenCodexEffort;
  adapterEffort: LcaTokenAdapterEffort;
  displayLabel: "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4;
  requiresPro: boolean;
}

/** One public model; reasoning selects the ChatGPT browser mode. */
export const LCA_TOKEN_REASONING_MODES: readonly LcaTokenReasoningMode[] = [
  { codexEffort: "low", adapterEffort: "low", displayLabel: "Instant", uiEffortIndex: 0, requiresPro: false },
  { codexEffort: "medium", adapterEffort: "medium", displayLabel: "Medium", uiEffortIndex: 1, requiresPro: false },
  { codexEffort: "high", adapterEffort: "high", displayLabel: "High", uiEffortIndex: 2, requiresPro: false },
  { codexEffort: "xhigh", adapterEffort: "xhigh", displayLabel: "Extra High", uiEffortIndex: 3, requiresPro: true },
  { codexEffort: "ultra", adapterEffort: "max", displayLabel: "Pro", uiEffortIndex: 4, requiresPro: true },
];

export function availableLcaTokenReasoningModes(proAvailable: boolean): readonly LcaTokenReasoningMode[] {
  return proAvailable
    ? LCA_TOKEN_REASONING_MODES
    : LCA_TOKEN_REASONING_MODES.filter(mode => !mode.requiresPro);
}

export function resolveLcaTokenReasoningMode(
  reasoning: string | undefined,
  proAvailable: boolean,
): LcaTokenReasoningMode {
  const effort = reasoning === "ultra" ? "max" : reasoning ?? "high";
  const mode = LCA_TOKEN_REASONING_MODES.find(candidate => candidate.adapterEffort === effort);
  if (!mode) throw new Error(`Lca Token effort is not supported: ${effort}`);
  if (mode.requiresPro && !proAvailable) {
    throw new Error(`${mode.displayLabel} effort is not available for this account`);
  }
  return mode;
}

export interface LcaTokenModelDescriptor {
  slug: string;
  displayName: string;
  description: string;
}

export const LCA_TOKEN_MODEL: LcaTokenModelDescriptor = {
  slug: LCA_TOKEN_MODEL_SLUG,
  displayName: LCA_TOKEN_MODEL_DISPLAY_NAME,
  description: LCA_TOKEN_MODEL_DESCRIPTION,
};

/** Treat stale lca-token/* slugs as owned so they fail locally instead of leaking upstream. */
export function isLcaTokenModelSlug(modelId: string): boolean {
  return modelId === LCA_TOKEN_MODEL_SLUG || modelId.startsWith(LCA_TOKEN_MODEL_PREFIX);
}

export function requireLcaTokenModel(modelId: string): LcaTokenModelDescriptor {
  if (modelId !== LCA_TOKEN_MODEL_SLUG) {
    throw new Error(`Lca Token model is not enabled: ${modelId}`);
  }
  return LCA_TOKEN_MODEL;
}
