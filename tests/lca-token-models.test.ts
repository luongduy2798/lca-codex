import { describe, expect, test } from "bun:test";
import {
  availableLcaTokenReasoningModes,
  LCA_TOKEN_BACKEND_MODEL,
  LCA_TOKEN_MODEL,
  LCA_TOKEN_REASONING_MODES,
  requireLcaTokenModel,
  resolveLcaTokenContextLimits,
  resolveLcaTokenReasoningMode,
} from "../src/lca-token-models";
import { defaultConfig } from "../src/config";
import { routeLcaTokenRequest } from "../src/server";
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

describe("single Lca Token model", () => {
  test("exposes one stable model and maps reasoning to browser modes", () => {
    expect(LCA_TOKEN_MODEL).toEqual({
      slug: "lca-token",
      displayName: "Lca Token",
      description: "Lca Token through the native Codex harness.",
    });
    expect(LCA_TOKEN_REASONING_MODES.map(mode => [mode.codexEffort, mode.adapterEffort, mode.displayLabel])).toEqual([
      ["low", "low", "Instant"],
      ["medium", "medium", "Medium"],
      ["high", "high", "High"],
      ["xhigh", "xhigh", "Extra High"],
      ["ultra", "max", "Pro"],
    ]);
    expect(requireLcaTokenModel("lca-token")).toBe(LCA_TOKEN_MODEL);
    expect(() => requireLcaTokenModel("lca-token/high")).toThrow("model is not enabled");
  });

  test("advertises Pro-only reasoning levels only when the account supports them", () => {
    expect(availableLcaTokenReasoningModes(false).map(mode => mode.codexEffort)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(availableLcaTokenReasoningModes(true)).toEqual(LCA_TOKEN_REASONING_MODES);
    expect(() => resolveLcaTokenReasoningMode("xhigh", false)).toThrow("Extra High effort is not available");
    expect(() => resolveLcaTokenReasoningMode("max", false)).toThrow("Pro effort is not available");
    expect(resolveLcaTokenReasoningMode("ultra", true).adapterEffort).toBe("max");
  });

  test("keeps the mode-specific runtime context limits", () => {
    for (const effort of ["low", "medium"] as const) {
      expect(resolveLcaTokenContextLimits(effort)).toEqual({
        contextWindow: 150_000,
        autoCompactTokenLimit: 135_000,
      });
    }
    expect(resolveLcaTokenContextLimits("high")).toEqual({
      contextWindow: 185_000,
      autoCompactTokenLimit: 166_500,
    });
    expect(resolveLcaTokenContextLimits("xhigh")).toEqual({
      contextWindow: 256_000,
      autoCompactTokenLimit: 230_400,
    });
    expect(resolveLcaTokenContextLimits("max")).toEqual({
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
    });
  });

  test("routes the single model while preserving the selected reasoning mode", () => {
    const request = parsed("lca-token", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const model = routeLcaTokenRequest(request, defaultConfig("browser-only"));

    expect(model.slug).toBe("lca-token");
    expect(request.modelId).toBe(LCA_TOKEN_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("maps Pro to the browser max effort and fails closed for stale routed slugs", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const request = parsed("lca-token", "max");
    expect(routeLcaTokenRequest(request, config).slug).toBe("lca-token");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeLcaTokenRequest(parsed("lca-token/pro"), config))
      .toThrow("model is not enabled");
  });
});
