import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function isolatedEnv(root: string): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: join(root, "home"),
    LCA_TOKEN_HOME: join(root, "lca-token"),
    LCA_TOKEN_PROFILE: undefined,
    CODEX_HOME: join(root, "codex"),
  };
}

test("CLI identifies itself as LCA Token and does not expose Codex route or Electron lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-cli-help-"));
  try {
    const result = await runCli(["--help"], isolatedEnv(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lca-token");
    expect(result.stdout).toContain("Headless ChatGPT Web runtime");
    expect(result.stdout).toContain("Control Center TUI");
    expect(result.stdout).toContain("Setup Wizard TUI");
    expect(result.stdout).toContain("auth <status|login|import|export|logout>");
    expect(result.stdout).toContain("api key <status|create|rotate|revoke|path>");
    expect(result.stdout).toContain("start|stop|restart");
    expect(result.stdout).toContain("service <status|install|cancel-turns>");
    expect(result.stdout).toContain("tunnel <status|key-import>");
    expect(result.stdout).not.toContain("service <status|install|start|restart|stop|cancel-turns>");
    expect(result.stdout).not.toContain("tunnel <status|start|restart|stop|key-import>");
    expect(result.stdout).not.toContain("api token <status|create|rotate|revoke|path>");
    expect(result.stdout).not.toContain("--public-url");
    expect(result.stdout).not.toContain("route <");
    expect(result.stdout).not.toContain("Electron");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-interactive default invocation prints help instead of entering the TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-cli-default-"));
  try {
    const result = await runCli([], isolatedEnv(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Control Center TUI");
    expect(result.stdout).toContain("Usage:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit TUI command fails closed without an interactive terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-cli-tui-"));
  try {
    const result = await runCli(["tui"], isolatedEnv(root));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TUI requires an interactive terminal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], isolatedEnv(root));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--port must be an integer from 1 to 65535");
    expect(result.stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profiles are isolated under the LCA Token home and can be made active", async () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-cli-profile-"));
  try {
    const env = isolatedEnv(root);
    const create = await runCli(["profile", "create", "work"], env);
    expect(create.exitCode).toBe(0);
    expect(create.stdout).toContain("Created profile work");

    const use = await runCli(["profile", "use", "work"], env);
    expect(use.exitCode).toBe(0);
    expect(use.stdout).toContain("Active profile: work");

    const show = await runCli(["profile", "show"], env);
    expect(show.exitCode).toBe(0);
    expect(show.stdout.trim()).toBe("work");

    const path = await runCli(["config", "path"], env);
    expect(path.exitCode).toBe(0);
    expect(path.stdout.trim()).toBe(join(root, "lca-token", "profiles", "work", "config.json"));

    const explicit = await runCli(["--profile", "personal", "config", "path"], env);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout.trim()).toBe(join(root, "lca-token", "profiles", "personal", "config.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
