import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const adapterRoot = join(repoRoot, "src", "adapters", "lca-codex");

function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

const architecture = readSource(join(repoRoot, "docs", "architecture.md"));
const securityModel = readSource(join(repoRoot, "docs", "security-model.md"));
const cli = readSource(join(repoRoot, "src", "cli.ts"));
const agentCore = readSource(join(repoRoot, "src", "core", "agent.ts"));
const server = readSource(join(repoRoot, "src", "server.ts"));
const mcpServer = readSource(join(adapterRoot, "mcp-server.ts"));
const deferredToolInventory = readSource(join(adapterRoot, "deferred-tool-inventory.ts"));
const environment = readSource(join(adapterRoot, "environment.ts"));

function adapterSources(): Array<{ path: string; source: string }> {
  return readdirSync(adapterRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
    .map(entry => ({
      path: entry.name,
      source: readSource(join(adapterRoot, entry.name)),
    }));
}

function registeredToolBlock(name: string): string {
  const marker = `server.registerTool(\n    "${name}"`;
  const start = mcpServer.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mcpServer.indexOf("server.registerTool(", start + marker.length);
  return mcpServer.slice(start, next < 0 ? mcpServer.length : next);
}

test("architecture defines LCA Token as a terminal-first bridge with authenticated generic harness tools", () => {
  expect(architecture).toContain("LCA Token is a **terminal-first ChatGPT Web runtime and capability bridge**, not an agent harness");
  expect(architecture).toContain("Codex is no longer the only supported harness");
  expect(architecture).toContain("`src/core/agent.ts` is the first agent-neutral core boundary");
  expect(architecture).toContain("Prompt text has no authority. Tool authority comes from the authenticated harness control plane");
  expect(architecture).toContain("same ChatGPT browser generation continues");
  expect(architecture).toContain("The MCP meta-tool names are agent-neutral: `agent_bind_turn`");
  expect(securityModel).toContain("Callers do not submit `thread_id`, `turn_id`, `cwd`, roots, sandbox, or network policy fields");
  expect(agentCore).toContain('roots: []');
  expect(agentCore).toContain('sandboxPolicy: { type: "readOnly", networkAccess: false }');
  expect(server).toContain('url.pathname === "/v1/agent/responses"');
  expect(server).toContain('url.pathname === "/v1/chat/completions"');
  expect(server).toContain("apiTokenAuthorized(req)");
  expect(server).not.toContain("x-lca-agent-authority");
});

test("status is a compact command distinct from doctor diagnostics", () => {
  expect(cli).toContain('else if (command === "status") await statusCommand(args);');
  expect(cli).toContain('else if (command === "doctor") await doctorCommand(args);');
  expect(cli).not.toContain('command === "doctor" || command === "status"');
});

test("LCA Codex adapter does not independently discover AGENTS or skill files", () => {
  for (const { path, source } of adapterSources()) {
    expect(source, `${path} must not discover AGENTS.md itself`).not.toMatch(/AGENTS\.md/);
    expect(source, `${path} must not discover SKILL.md itself`).not.toMatch(/SKILL\.md/);
    expect(source, `${path} must not scan Codex skill directories`).not.toMatch(/(?:\.codex|\.agents)[/\\]skills|[/\\]skills[/\\]/);
  }
});

test("native tool relay is bounded by the current Codex registry or its advertised exec gateway", () => {
  expect(mcpServer).toContain("const directMatches = bound.tools\n        .map(tool => ({");
  expect(mcpServer).toContain('from "./deferred-tool-inventory"');
  expect(mcpServer).toContain("inventoryToolRank(");
  expect(deferredToolInventory).toContain("const blockedLogicalNames = new Set(");
  expect(deferredToolInventory).toContain("const isBlockedLogicalName = logicalName => blockedLogicalNames.has(logicalName)");
  expect(deferredToolInventory).toContain("!isBlockedLogicalName(identity(tool).logicalName)");
  expect(mcpServer).toContain("if (gateway && needle) {");
  expect(mcpServer).toContain("const discovered = discoveredGatewayTools.get(binding_id)?.get(wire_name);");
  expect(mcpServer).toContain("Harness tool is not available in this turn or has not been returned by agent_tool_inventory");
  expect(mcpServer).toContain("if (!gateway) {\n      throw new Error(`This harness turn did not advertise ${nestedToolName} or the native exec gateway`);");
  expect(mcpServer).toContain("await ensureGatewayToolReady(bindingId, bound, gateway, nestedToolName, sourceTool);");
});

test("bridge tool schemas cannot override Codex sandbox or approval policy", () => {
  for (const name of ["agent_exec", "agent_write_stdin", "agent_apply_patch", "agent_view_image", "agent_tool_call"]) {
    const block = registeredToolBlock(name);
    const schemaStart = block.indexOf("inputSchema:");
    const schemaEnd = block.indexOf("annotations:", schemaStart);
    expect(schemaStart).toBeGreaterThanOrEqual(0);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    const schema = block.slice(schemaStart, schemaEnd);
    expect(schema, `${name} must not accept a sandbox override`).not.toMatch(/\bsandbox\b|writable_roots|writableRoots/);
    expect(schema, `${name} must not accept an approval override`).not.toMatch(/approval|ask_for_approval|permission/i);
  }
});

test("trusted turn environment takes tools and sandbox from Codex instead of inventing defaults", () => {
  expect(environment.match(/tools: parsed\.context\.tools \?\? \[\]/g)?.length).toBe(3);
  expect(environment).toContain("throw new Error(\"LCA Codex turn requires one explicit trusted Codex sandbox mode\")");
  expect(environment).toContain("sandboxPolicy: { type: \"readOnly\", networkAccess }");
  expect(environment).toContain("sandboxPolicy: { type: \"workspaceWrite\", writableRoots: roots, networkAccess }");
  expect(environment).toContain("sandboxPolicy: { type: \"dangerFullAccess\" }");
});
