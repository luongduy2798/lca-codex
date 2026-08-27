import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { setupClaudeCodeHarness } from "../src/harness-config";

test("Claude Code setup preserves user hooks and removes obsolete browser lifecycle hooks idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-claude-setup-"));
  const claudeDir = join(root, "claude");
  const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousHome = process.env.LCA_TOKEN_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.LCA_TOKEN_HOME = join(root, "lca-home");
  const settingsPath = join(claudeDir, "settings.json");
  const lifecycleHookCommand = `bun run '${resolve(import.meta.dir, "../scripts/claude-code-lifecycle-hook.ts")}'`;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    effortLevel: "high",
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "echo user-stop-hook" }] },
        { hooks: [{ type: "command", command: lifecycleHookCommand }] },
      ],
      SessionEnd: [{ hooks: [{ type: "command", command: lifecycleHookCommand }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: lifecycleHookCommand }] }],
    },
  }));

  try {
    const config = { ...defaultConfig(), port: 9123 };
    setupClaudeCodeHarness(config);
    setupClaudeCodeHarness(config);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      effortLevel?: unknown;
      env?: Record<string, string>;
      hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>;
    };
    expect(settings.effortLevel).toBe("high");
    expect(settings.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9123");
    expect(settings.env?.ANTHROPIC_MODEL).toBe("lca-token");
    expect(settings.env?.ANTHROPIC_AUTH_TOKEN?.startsWith("lcat_")).toBe(true);
    expect(settings.hooks?.Stop?.some(entry => entry.hooks?.some(hook => hook.command === "echo user-stop-hook"))).toBe(true);
    for (const event of ["Stop", "SessionEnd", "SubagentStop"] as const) {
      const lifecycleHooks = settings.hooks?.[event]
        ?.flatMap(entry => entry.hooks ?? [])
        .filter(hook => hook.type === "command" && hook.command?.includes("claude-code-lifecycle-hook.ts")) ?? [];
      expect(lifecycleHooks).toHaveLength(0);
    }
  } finally {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    if (previousHome === undefined) delete process.env.LCA_TOKEN_HOME;
    else process.env.LCA_TOKEN_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual Claude Code compatibility Stop hook posts an explicit task cancellation", async () => {
  let captured: { url: string; headers: Headers; body: unknown } | undefined;
  let resolveRequest!: () => void;
  const requested = new Promise<void>(resolveRequestPromise => { resolveRequest = resolveRequestPromise; });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = {
        url: new URL(req.url).pathname,
        headers: new Headers(req.headers),
        body: await req.json(),
      };
      resolveRequest();
      return Response.json({ status: "ok" });
    },
  });
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../scripts/claude-code-lifecycle-hook.ts"),
  ], {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_AUTH_TOKEN: "lcat_hook_test",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    child.stdin.write(JSON.stringify({
      session_id: "claude-session-hook-test",
      hook_event_name: "Stop",
    }));
    child.stdin.end();
    await Promise.race([
      requested,
      Bun.sleep(2_000).then(() => { throw new Error("Claude lifecycle hook did not call the server"); }),
    ]);
    expect(await child.exited).toBe(0);
    expect(captured?.url).toBe("/v1/agent/lifecycle");
    expect(captured?.headers.get("authorization")).toBe("Bearer lcat_hook_test");
    expect(captured?.headers.get("x-claude-code-session-id")).toBe("claude-session-hook-test");
    expect(captured?.headers.get("x-claude-code-agent-id")).toBeNull();
    expect(captured?.body).toEqual({ method: "task/stop" });
  } finally {
    child.kill();
    await server.stop(true);
  }
});

test("manual Claude Code compatibility SubagentStop hook keeps the subagent task identity", async () => {
  let agentId: string | null | undefined;
  let resolveRequest!: () => void;
  const requested = new Promise<void>(resolveRequestPromise => { resolveRequest = resolveRequestPromise; });
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      agentId = req.headers.get("x-claude-code-agent-id");
      resolveRequest();
      return Response.json({ status: "ok" });
    },
  });
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../scripts/claude-code-lifecycle-hook.ts"),
  ], {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      ANTHROPIC_AUTH_TOKEN: "lcat_hook_test",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    child.stdin.write(JSON.stringify({
      session_id: "claude-session-hook-test",
      agent_id: "claude-agent-hook-test",
      hook_event_name: "SubagentStop",
    }));
    child.stdin.end();
    await Promise.race([
      requested,
      Bun.sleep(2_000).then(() => { throw new Error("Claude subagent lifecycle hook did not call the server"); }),
    ]);
    expect(await child.exited).toBe(0);
    expect(agentId).toBe("claude-agent-hook-test");
  } finally {
    child.kill();
    await server.stop(true);
  }
});
