import type { AppConfig } from "./config";
import { loadConfig, getProfileName } from "./config";
import { browserLoginStateExists } from "./browser-login";
import { readApiToken } from "./api-auth";
import { PRODUCT_ID } from "./product";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";

export interface StatusReport {
  ok: boolean;
  profile: string;
  runtime: {
    ready: boolean;
    managedServiceRunning: boolean;
  };
  authentication: {
    chatgpt: boolean;
    apiToken: boolean;
  };
  tunnel: {
    ready: boolean;
    managedServiceRunning: boolean;
  };
  endpoints: {
    models: string;
    responses: string;
    chatCompletions: string;
    codexModels: string;
    codexResponses: string;
    codexCompact: string;
    codexSearch: string;
  };
}

async function responsesProxyReady(config: AppConfig): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.service === PRODUCT_ID
      && body.status === "ok"
      && body.mode === config.mode
      && body.version === config.releaseVersion
      && body.accepting_turns === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function agentEndpoints(config: Pick<AppConfig, "host" | "port">): StatusReport["endpoints"] {
  const root = `http://${config.host}:${config.port}/v1`;
  const agentBase = `${root}/agent`;
  return {
    models: `${agentBase}/models`,
    responses: `${agentBase}/responses`,
    chatCompletions: `${root}/chat/completions`,
    codexModels: `${root}/models`,
    codexResponses: `${root}/responses`,
    codexCompact: `${root}/responses/compact`,
    codexSearch: `${root}/alpha/search`,
  };
}

export async function runStatus(config = loadConfig()): Promise<StatusReport> {
  const runtimeService = getServiceStatus();
  const tunnelService = getTunnelServiceStatus();
  const [runtimeReady, tunnelRuntime] = await Promise.all([
    responsesProxyReady(config),
    Promise.resolve(tunnelStatus(config)),
  ]);
  const chatgpt = browserLoginStateExists(config);
  const apiToken = Boolean(readApiToken());
  const report: StatusReport = {
    ok: runtimeReady && chatgpt && apiToken && tunnelRuntime.ok,
    profile: getProfileName(),
    runtime: {
      ready: runtimeReady,
      managedServiceRunning: runtimeService.loaded,
    },
    authentication: {
      chatgpt,
      apiToken,
    },
    tunnel: {
      ready: tunnelRuntime.ok,
      managedServiceRunning: tunnelService.running,
    },
    endpoints: agentEndpoints(config),
  };
  return report;
}

function state(value: boolean, ready: string, notReady: string): string {
  return value ? ready : notReady;
}

function managedServiceSuffix(running: boolean): string {
  return running ? "managed service running" : "managed service not running";
}

export function formatStatusReport(report: StatusReport): string {
  return [
    `Profile: ${report.profile}`,
    `Runtime: ${state(report.runtime.ready, "ready", "not ready")} (${managedServiceSuffix(report.runtime.managedServiceRunning)})`,
    `ChatGPT auth: ${state(report.authentication.chatgpt, "authenticated", "missing")}`,
    `API key: ${state(report.authentication.apiToken, "configured", "missing")}`,
    `Tunnel: ${state(report.tunnel.ready, "ready", "not ready")} (${managedServiceSuffix(report.tunnel.managedServiceRunning)})`,
    "Agent API endpoints:",
    `  GET  ${report.endpoints.models}`,
    `  POST ${report.endpoints.responses}`,
    `  POST ${report.endpoints.chatCompletions}`,
    "Codex compatibility endpoints:",
    `  GET  ${report.endpoints.codexModels}`,
    `  POST ${report.endpoints.codexResponses}`,
    `  POST ${report.endpoints.codexCompact}`,
    `  POST ${report.endpoints.codexSearch}`,
    "Curl examples — Agent API (set LCA_API_KEY to your lcat_... API key first):",
    `  curl -sS ${report.endpoints.models} \\`,
    '    -H "Authorization: Bearer $LCA_API_KEY"',
    "",
    `  curl -sS ${report.endpoints.responses} \\`,
    '    -H "Authorization: Bearer $LCA_API_KEY" \\',
    '    -H "Content-Type: application/json" \\',
    `    -d '{"model":"${PRODUCT_ID}","stream":false,"input":"Say exactly: LCA Token API works"}'`,
    "",
    `  curl -sS ${report.endpoints.chatCompletions} \\`,
    '    -H "Authorization: Bearer $LCA_API_KEY" \\',
    '    -H "Content-Type: application/json" \\',
    `    -d '{"model":"${PRODUCT_ID}","stream":false,"messages":[{"role":"user","content":"Say exactly: LCA Token API works"}]}'`,
    "Curl examples — Codex compatibility (set CODEX_BEARER_TOKEN to the Bearer credential supplied by Codex):",
    `  curl -sS ${report.endpoints.codexModels} \\`,
    '    -H "Authorization: Bearer $CODEX_BEARER_TOKEN"',
    "",
    `  curl -sS ${report.endpoints.codexResponses} \\`,
    '    -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \\',
    '    -H "Content-Type: application/json" \\',
    `    -d '{"model":"${PRODUCT_ID}","stream":false,"input":"Say exactly: LCA Token Codex route works"}'`,
    "",
    `  curl -sS ${report.endpoints.codexCompact} \\`,
    '    -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \\',
    '    -H "Content-Type: application/json" \\',
    `    -d '{"model":"${PRODUCT_ID}","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Summarize this context"}]}]}'`,
    "",
    `  curl -sS ${report.endpoints.codexSearch} \\`,
    '    -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \\',
    '    -H "Content-Type: application/json" \\',
    '    -d \'{"query":"OpenAI Codex"}\'',
    `Status: ${report.ok ? "ready" : "not ready"}`,
    "",
  ].join("\n");
}
