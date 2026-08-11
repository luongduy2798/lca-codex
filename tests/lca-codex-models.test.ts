import { describe, expect, test } from "bun:test";
import {
  availableLcaCodexReasoningModes,
  LCA_CODEX_BASE_MODEL,
  LCA_CODEX_MODEL,
  LCA_CODEX_REASONING_MODES,
  requireLcaCodexModel,
  resolveLcaCodexContextLimits,
  resolveLcaCodexReasoningMode,
} from "../src/lca-codex-models";
import { defaultConfig } from "../src/config";
import { routeLcaCodexRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("single LCA Codex model", () => {
  test("exposes one stable model and maps reasoning to browser modes", () => {
    expect(LCA_CODEX_MODEL).toEqual({
      slug: "lca-codex",
      displayName: "LCA Codex",
      description: "LCA Codex through the native Codex harness.",
    });
    expect(LCA_CODEX_REASONING_MODES.map(mode => [mode.codexEffort, mode.adapterEffort, mode.displayLabel])).toEqual([
      ["low", "low", "Instant"],
      ["medium", "medium", "Medium"],
      ["high", "high", "High"],
      ["xhigh", "xhigh", "Extra High"],
      ["ultra", "max", "Pro"],
    ]);
    expect(requireLcaCodexModel("lca-codex")).toBe(LCA_CODEX_MODEL);
    expect(() => requireLcaCodexModel("lca-codex/high")).toThrow("model is not enabled");
  });

  test("advertises Pro-only reasoning levels only when the account supports them", () => {
    expect(availableLcaCodexReasoningModes(false).map(mode => mode.codexEffort)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(availableLcaCodexReasoningModes(true)).toEqual(LCA_CODEX_REASONING_MODES);
    expect(() => resolveLcaCodexReasoningMode("xhigh", false)).toThrow("Extra High effort is not available");
    expect(() => resolveLcaCodexReasoningMode("max", false)).toThrow("Pro effort is not available");
    expect(resolveLcaCodexReasoningMode("ultra", true).adapterEffort).toBe("max");
  });

  test("keeps the mode-specific runtime context limits", () => {
    for (const effort of ["low", "medium"] as const) {
      expect(resolveLcaCodexContextLimits(effort)).toEqual({
        contextWindow: 150_000,
        autoCompactTokenLimit: 135_000,
      });
    }
    expect(resolveLcaCodexContextLimits("high")).toEqual({
      contextWindow: 185_000,
      autoCompactTokenLimit: 166_500,
    });
    expect(resolveLcaCodexContextLimits("xhigh")).toEqual({
      contextWindow: 256_000,
      autoCompactTokenLimit: 230_400,
    });
    expect(resolveLcaCodexContextLimits("max")).toEqual({
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
    });
  });

  test("routes the single model while preserving the selected reasoning mode", () => {
    const request = parsed("lca-codex", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const model = routeLcaCodexRequest(request, defaultConfig());

    expect(model.slug).toBe("lca-codex");
    expect(request.modelId).toBe(LCA_CODEX_BASE_MODEL);
    expect(request.options.reasoning).toBe("low");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("maps Pro to the browser max effort and fails closed for unsupported routed slugs", () => {
    const config = defaultConfig();
    config.proAvailable = true;
    const request = parsed("lca-codex", "max");
    expect(routeLcaCodexRequest(request, config).slug).toBe("lca-codex");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeLcaCodexRequest(parsed("lca-codex/pro"), config))
      .toThrow("model is not enabled");
  });
});
