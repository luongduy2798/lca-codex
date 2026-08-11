import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const adapterRoot = join(repoRoot, "src", "adapters", "lca-codex");

function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

const architecture = readSource(join(repoRoot, "docs", "architecture.md"));
const mcpServer = readSource(join(adapterRoot, "mcp-server.ts"));
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

test("architecture defines LCA as a bridge and Codex as the sole harness and execution authority", () => {
  expect(architecture).toContain("Codex remains the only agent\nharness");
  expect(architecture).toContain("`lca-codex` never\ndiscovers AGENTS.md or chooses a skill itself");
  expect(architecture).toContain("preserving Codex\nsandbox, approvals, sessions, and tool lifecycle as the execution authority");
  expect(architecture).toContain("Tool calls and results remain in the same ChatGPT response while Codex executes them locally.");
  expect(architecture).toContain("`multi_agent = true` preserves routed subagent turns");
  expect(architecture).toContain("`multi_agent_v2 = false` keeps their payloads");
  expect(architecture).toContain("`remote_compaction_v2 = false` bounds retained Web image");
});

test("LCA Codex adapter does not independently discover AGENTS or skill files", () => {
  for (const { path, source } of adapterSources()) {
    expect(source, `${path} must not discover AGENTS.md itself`).not.toMatch(/AGENTS\.md/);
    expect(source, `${path} must not discover SKILL.md itself`).not.toMatch(/SKILL\.md/);
    expect(source, `${path} must not scan Codex skill directories`).not.toMatch(/(?:\.codex|\.agents)[/\\]skills|[/\\]skills[/\\]/);
  }
});

test("native tool relay is bounded by the current Codex registry or its advertised exec gateway", () => {
  expect(mcpServer).toContain("const tool = namedTool(bound, wire_name);");
  expect(mcpServer).toContain("if (!tool) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);");
  expect(mcpServer).toContain("if (!gateway) {\n      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);");
  expect(mcpServer).toContain("const matches = bound.tools.filter(tool =>");
});

test("bridge tool schemas cannot override Codex sandbox or approval policy", () => {
  for (const name of ["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image", "codex_tool_call"]) {
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
