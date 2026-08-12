import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableLcaCodexReasoningModes,
  LCA_CODEX_MODEL,
  LCA_CODEX_MODEL_PREFIX,
  LCA_CODEX_MODEL_SLUG,
  resolveLcaCodexContextLimits,
} from "./lca-codex-models";

type JsonObject = Record<string, unknown>;

/** Keep the routed LCA Codex model at the front of Codex's spawn-agent override registry. */
export const LCA_CODEX_MODEL_PRIORITY = 0;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

function isOwnedLcaCodexSlug(modelSlug: string | undefined): boolean {
  return modelSlug === LCA_CODEX_MODEL_SLUG || modelSlug?.startsWith(LCA_CODEX_MODEL_PREFIX) === true;
}

function nativeTemplateCandidate(value: unknown, requireTools: boolean): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as JsonObject;
  const modelSlug = slug(model);
  if (!modelSlug || isOwnedLcaCodexSlug(modelSlug)) return false;
  if (model.visibility !== "list" || model.supported_in_api !== true) return false;
  if (!Array.isArray(model.supported_reasoning_levels)) return false;
  return !requireTools || (typeof model.tool_mode === "string" && model.tool_mode.length > 0);
}

function selectNativeTemplate(models: unknown[], _config: AppConfig): JsonObject {
  const candidates = models.filter(model => nativeTemplateCandidate(model, true)) as JsonObject[];
  const template = candidates[0];
  if (template) return template;
  throw new Error("Native Codex models response has no list-visible, API-supported, tool-capable model with reasoning metadata");
}

export function buildLcaCodexModel(
  templateValue: unknown,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = slug(template);
  if (!templateSlug || isOwnedLcaCodexSlug(templateSlug)) {
    throw new Error("LCA Codex model template must be a native Codex model");
  }
  const reasoningModes = availableLcaCodexReasoningModes(config.proAvailable);
  // Codex exposes context size per model, not per reasoning level. Browser reasoning effort no
  // longer changes how much native Codex history exists: the outer task owns one 272k lifetime and
  // compacts at 90%, while browser prompts stay independently bounded by lazy-context projection.
  const catalogLimits = resolveLcaCodexContextLimits("low");
  const model: JsonObject = {
    ...structuredClone(template),
    slug: LCA_CODEX_MODEL.slug,
    display_name: LCA_CODEX_MODEL.displayName,
    description: LCA_CODEX_MODEL.description,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: true,
    priority: LCA_CODEX_MODEL_PRIORITY,
    multi_agent_version: "v1",
    // All reasoning levels share the same connector/tool capability when it is enabled.
    tool_mode: template.tool_mode,
    upgrade: null,
    default_reasoning_level: "high",
    supported_reasoning_levels: reasoningModes.map(mode =>
      reasoningLevel(template, mode.codexEffort, mode.displayLabel)
    ),
    context_window: catalogLimits.contextWindow,
    max_context_window: catalogLimits.contextWindow,
    auto_compact_token_limit: catalogLimits.autoCompactTokenLimit,
    // LCA Codex has no Codex service tier. Never inherit the native template's Fast tiers.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => !isOwnedLcaCodexSlug(slug(model))),
  );
  const template = selectNativeTemplate(nativeModels, config);
  if (contextOverride) {
    // model_context_window is a single top-level Codex setting, not a per-model one. Apply it only
    // to native models; the routed LCA Codex model owns its conservative shared catalog window.
    for (const candidate of nativeModels) {
      const modelSlug = slug(candidate);
      if (!modelSlug) continue;
      const model = object(candidate, `native ${modelSlug} model`);
      const current = model.max_context_window;
      if (current !== undefined && current !== null
        && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) {
        throw new Error(`Native ${modelSlug} max_context_window must be a positive integer`);
      }
      if (current === undefined || current === null || current < contextOverride.contextWindow) {
        model.max_context_window = contextOverride.contextWindow;
      }
    }
  }
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, buildLcaCodexModel(template, config)],
  };
}
