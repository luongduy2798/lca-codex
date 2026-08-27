import { expect, test } from "bun:test";
import { agentEndpoints, formatStatusReport, type StatusReport } from "../src/status";

test("status exposes generic agent and Codex compatibility endpoints", () => {
  expect(agentEndpoints({ host: "127.0.0.1", port: 8317 })).toEqual({
    models: "http://127.0.0.1:8317/v1/agent/models",
    responses: "http://127.0.0.1:8317/v1/agent/responses",
    lifecycle: "http://127.0.0.1:8317/v1/agent/lifecycle",
    chatCompletions: "http://127.0.0.1:8317/v1/chat/completions",
    anthropicMessages: "http://127.0.0.1:8317/v1/messages",
    anthropicCountTokens: "http://127.0.0.1:8317/v1/messages/count_tokens",
    codexModels: "http://127.0.0.1:8317/v1/models",
    codexResponses: "http://127.0.0.1:8317/v1/responses",
    codexCompact: "http://127.0.0.1:8317/v1/responses/compact",
    codexSearch: "http://127.0.0.1:8317/v1/alpha/search",
  });
});

test("compact status output is distinct from doctor diagnostics", () => {
  const report: StatusReport = {
    ok: true,
    profile: "codex",
    runtime: { ready: true, managedServiceRunning: true },
    authentication: { chatgpt: true, apiToken: true },
    tunnel: { ready: true, managedServiceRunning: true },
    endpoints: agentEndpoints({ host: "127.0.0.1", port: 8317 }),
  };
  const output = formatStatusReport(report);
  expect(output).toContain("Runtime: ready (managed service running)");
  expect(output).toContain("ChatGPT auth: authenticated");
  expect(output).toContain("API key: configured");
  expect(output).toContain("Tunnel: ready (managed service running)");
  expect(output).toContain("Agent API endpoints:");
  expect(output).toContain("GET  http://127.0.0.1:8317/v1/agent/models");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/agent/responses");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/agent/lifecycle");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/chat/completions");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/messages");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/messages/count_tokens");
  expect(output).toContain("Codex compatibility endpoints:");
  expect(output).toContain("GET  http://127.0.0.1:8317/v1/models");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/responses");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/responses/compact");
  expect(output).toContain("POST http://127.0.0.1:8317/v1/alpha/search");
  expect(output).toContain("Curl examples — Agent API (set LCA_API_KEY to your lcat_... API key first):");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/agent/models");
  expect(output).toContain('-H "Authorization: Bearer $LCA_API_KEY"');
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/agent/responses");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/chat/completions");
  expect(output).not.toContain("X-LCA-Agent-Authority");
  expect(output).toContain('-d \'{"model":"lca-token","stream":false,"input":"Say exactly: LCA Token API works"}\'');
  expect(output).toContain('-d \'{"model":"lca-token","stream":false,"messages":[{"role":"user","content":"Say exactly: LCA Token API works"}]}\'');
  expect(output).toContain("Curl examples — Codex compatibility (set CODEX_BEARER_TOKEN to the Bearer credential supplied by Codex):");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/models");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/responses");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/responses/compact");
  expect(output).toContain("curl -sS http://127.0.0.1:8317/v1/alpha/search");
  expect(output).toContain('-H "Authorization: Bearer $CODEX_BEARER_TOKEN"');
  expect(output).toContain('-d \'{"query":"OpenAI Codex"}\'');
  expect(output).toContain("Status: ready");
  expect(output).not.toContain("Doctor result:");
});
