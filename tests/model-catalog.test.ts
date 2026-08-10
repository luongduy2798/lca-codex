import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { resolveLcaCodexContextLimits } from "../src/lca-codex-models";
import {
  augmentNativeModelCatalog,
  LCA_CODEX_MODEL_PRIORITY,
} from "../src/model-catalog";

function source(): Record<string, unknown> {
  return {
    models: [
      { slug: "gpt-5.5", display_name: "5.5", priority: 1 },
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        base_instructions: "native harness",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium native" },
          { effort: "high", description: "High native" },
          { effort: "xhigh", description: "Extra high native" },
        ],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-compaction-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast", name: "Fast" }],
        default_service_tier: "fast",
      },
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", priority: 3 },
    ],
  };
}

describe("native /models augmentation", () => {
  test("preserves every native model in order and appends one LCA Codex model with reasoning choices", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.proAvailable = true;
    const result = augmentNativeModelCatalog(native, config);
    const models = result.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual(nativeSnapshot.models as Array<Record<string, unknown>>);
    expect(models).toHaveLength(4);
    const routed = models[3]!;
    const limits = resolveLcaCodexContextLimits("low");
    expect(routed).toMatchObject({
      slug: "lca-codex",
      display_name: "LCA Codex",
      tool_mode: "code_mode_only",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Instant" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra High" },
        { effort: "ultra", description: "Pro" },
      ],
      multi_agent_version: "v1",
      supported_in_api: true,
      priority: LCA_CODEX_MODEL_PRIORITY,
      context_window: limits.contextWindow,
      max_context_window: limits.contextWindow,
      auto_compact_token_limit: limits.autoCompactTokenLimit,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
    });
    expect(routed).not.toHaveProperty("comp_hash");
  });

  test("keeps the shared LCA Codex model in Codex's V1 spawn-agent model registry", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);

    expect(spawnOverrides).toEqual(["lca-codex", "gpt-5.6-sol"]);
  });

  test("is idempotent, removes stale routed slugs, and hides Pro-only reasoning when unavailable", () => {
    const config = defaultConfig();
    config.proAvailable = false;
    const polluted = source();
    (polluted.models as unknown[]).push(
      { slug: "foreign/gpt-5.6-sol", display_name: "foreign generic route" },
      { slug: "lca-codex/pro", display_name: "stale Pro route" },
      { slug: "lca-codex", display_name: "stale shared route" },
    );
    const first = augmentNativeModelCatalog(polluted, config);
    const second = augmentNativeModelCatalog(first, config);
    const models = second.models as Array<Record<string, unknown>>;
    const routed = models.filter(model => model.slug === "lca-codex");
    expect(routed).toHaveLength(1);
    expect(routed[0]!.tool_mode).toBe("code_mode_only");
    expect(routed[0]!.multi_agent_version).toBe("v1");
    expect(routed[0]!.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Instant" },
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
    ]);
    expect(routed[0]).toMatchObject({
      context_window: 150_000,
      auto_compact_token_limit: 135_000,
    });
    expect(models.some(model => model.slug === "lca-codex/pro")).toBe(false);
  });

  test("honors an explicit Codex context override without replacing or reordering native models", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      model: "lca-codex",
      contextWindow: 371_851,
    });
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual([
      { ...originalModels[0], max_context_window: 371_851 },
      { ...originalModels[1], max_context_window: 371_851 },
      { ...originalModels[2], max_context_window: 371_851 },
    ]);
    expect(models[1]!.context_window).toBe(300_000);
    expect(models[3]).toMatchObject({
      slug: "lca-codex",
      context_window: 150_000,
      max_context_window: 150_000,
      auto_compact_token_limit: 135_000,
    });
  });

  test("never lowers a native window that already exceeds the Codex context override", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models[0]!.max_context_window = 1_000_000;
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });

    expect((result.models as Array<Record<string, unknown>>)[0]!.max_context_window).toBe(1_000_000);
  });

  test("uses an available compatible official model when an account exposes a smaller catalog", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models.splice(1, 1);
    Object.assign(models[1]!, {
      visibility: "list",
      supported_in_api: true,
      tool_mode: "code_mode_only",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      shell_type: "shell_command",
    });

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const routed = (result.models as Array<Record<string, unknown>>)
      .find(model => model.slug === "lca-codex");
    expect(routed?.shell_type).toBe("shell_command");
    expect(routed?.tool_mode).toBe("code_mode_only");
  });

  test("follows official catalog order instead of preferring a named paid-tier model", () => {
    const native = source();
    const sourceModels = native.models as Array<Record<string, unknown>>;
    const sol = sourceModels[1]!;
    const terra = {
      ...structuredClone(sol),
      slug: "gpt-5.6-terra",
      display_name: "5.6 Terra",
      shell_type: "terra-shell",
    };
    native.models = [sourceModels[0], terra, sol];

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const routed = (result.models as Array<Record<string, unknown>>)
      .find(model => model.slug === "lca-codex");
    expect(routed?.shell_type).toBe("terra-shell");
  });

  test("fails closed when no official model satisfies the harness contract", () => {
    expect(() => augmentNativeModelCatalog({
      models: [{
        slug: "other",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: null,
      }],
    }, defaultConfig("full"))).toThrow("no list-visible, API-supported, tool-capable model");
  });
});
