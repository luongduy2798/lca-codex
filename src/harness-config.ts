import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureApiToken } from "./api-auth";
import { installCodexIntegration, preflightCodexIntegration } from "./codex-integration";
import { atomicWriteFile, expandUserPath, type AppConfig } from "./config";

type JsonObject = Record<string, unknown>;

export interface HarnessSetupResult {
  harness: "codex" | "claude-code" | "cline";
  path: string;
  detail: string;
}

export interface HarnessSetupOptions {
  model?: string;
  replaceCodexRoute?: boolean;
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as JsonObject;
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    return jsonObject(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${path}: ${detail}`);
  }
}

function nestedObject(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  return jsonObject(value, label);
}

function runtimeBaseUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function claudeLifecycleHookCommand(): string {
  return `bun run ${shellQuote(resolve(import.meta.dir, "../scripts/claude-code-lifecycle-hook.ts"))}`;
}

function withoutClaudeLifecycleHooks(settings: JsonObject): JsonObject {
  const hooks = nestedObject(settings.hooks, "Claude Code hooks");
  const command = claudeLifecycleHookCommand();
  const next = { ...hooks };
  for (const event of ["Stop", "SessionEnd", "SubagentStop"] as const) {
    const existing = hooks[event];
    if (existing === undefined) continue;
    if (!Array.isArray(existing)) throw new Error(`Claude Code hooks.${event} must be an array`);
    const entries = existing.flatMap(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [entry];
      const hookList = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(hookList)) return [entry];
      const retained = hookList.filter(hook => !(
        hook && typeof hook === "object" && !Array.isArray(hook)
        && (hook as { type?: unknown }).type === "command"
        && (hook as { command?: unknown }).command === command
      ));
      return retained.length > 0 ? [{ ...entry, hooks: retained }] : [];
    });
    if (entries.length > 0) next[event] = entries;
    else delete next[event];
  }
  return next;
}

export function claudeCodeSettingsPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  const directory = configured
    ? resolve(expandUserPath(configured))
    : join(homedir(), ".claude");
  return join(directory, "settings.json");
}

export function clineProviderSettingsPath(): string {
  const configured = process.env.CLINE_PROVIDER_SETTINGS_PATH?.trim();
  if (configured) return resolve(expandUserPath(configured));
  return join(homedir(), ".cline", "data", "settings", "providers.json");
}

export function setupClaudeCodeHarness(
  config: AppConfig,
  options: HarnessSetupOptions = {},
): HarnessSetupResult {
  const path = claudeCodeSettingsPath();
  const settings = readJsonObject(path);
  const settingsWithoutHooks = { ...settings };
  delete settingsWithoutHooks.hooks;
  const hooks = withoutClaudeLifecycleHooks(settings);
  const env = nestedObject(settings.env, `${path} env`);
  const model = options.model?.trim() || "lca-token";
  const token = ensureApiToken().token;
  const next = {
    ...settingsWithoutHooks,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: runtimeBaseUrl(config),
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: model,
    },
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    harness: "claude-code",
    path,
    detail: `Anthropic base URL ${runtimeBaseUrl(config)} with model alias ${model}; browser execution lifecycle remains WebSocket-owned`,
  };
}

export function setupClineHarness(
  config: AppConfig,
  options: HarnessSetupOptions = {},
): HarnessSetupResult {
  const path = clineProviderSettingsPath();
  const root = readJsonObject(path);
  const providers = nestedObject(root.providers, `${path} providers`);
  const existingProvider = nestedObject(providers["openai-compatible"], `${path} openai-compatible provider`);
  const model = options.model?.trim() || "lca-token";
  const baseUrl = `${runtimeBaseUrl(config)}/v1`;
  const token = ensureApiToken().token;
  const next = {
    ...root,
    version: 1,
    lastUsedProvider: "openai-compatible",
    modes: root.modes === undefined ? {} : nestedObject(root.modes, `${path} modes`),
    providers: {
      ...providers,
      "openai-compatible": {
        ...existingProvider,
        settings: {
          provider: "openai-compatible",
          apiKey: token,
          model,
          baseUrl,
          headers: {},
          azure: { useIdentity: false },
        },
        updatedAt: new Date().toISOString(),
        tokenSource: "manual",
      },
    },
  };
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    harness: "cline",
    path,
    detail: `OpenAI Compatible base URL ${baseUrl} with model ${model}`,
  };
}

export function setupCodexHarness(
  config: AppConfig,
  options: HarnessSetupOptions = {},
): HarnessSetupResult {
  const installOptions = { replaceExistingRoute: options.replaceCodexRoute === true };
  preflightCodexIntegration(config, installOptions);
  const journal = installCodexIntegration(config, installOptions);
  return {
    harness: "codex",
    path: journal.configPath,
    detail: `Responses compatibility route ${journal.installed.openai_base_url}`,
  };
}

export function setupAllHarnesses(
  config: AppConfig,
  options: {
    claudeModel?: string;
    clineModel?: string;
    replaceCodexRoute?: boolean;
  } = {},
): HarnessSetupResult[] {
  preflightCodexIntegration(config, { replaceExistingRoute: options.replaceCodexRoute === true });
  return [
    setupCodexHarness(config, { replaceCodexRoute: options.replaceCodexRoute }),
    setupClaudeCodeHarness(config, { model: options.claudeModel }),
    setupClineHarness(config, { model: options.clineModel }),
  ];
}
