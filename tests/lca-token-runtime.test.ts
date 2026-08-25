import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getConfigDir, getProductHome } from "../src/config";
import { serviceDefinition } from "../src/service";
import { createTunnelConfig } from "../src/tunnel";
import { tunnelServiceDefinitionForPlatform } from "../src/tunnel-service";

const roots: string[] = [];
const previousHome = process.env.LCA_TOKEN_HOME;
const previousProfile = process.env.LCA_TOKEN_PROFILE;

afterEach(() => {
  if (previousHome === undefined) delete process.env.LCA_TOKEN_HOME;
  else process.env.LCA_TOKEN_HOME = previousHome;
  if (previousProfile === undefined) delete process.env.LCA_TOKEN_PROFILE;
  else process.env.LCA_TOKEN_PROFILE = previousProfile;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function selectProfile(profile = "work") {
  const root = mkdtempSync(join(tmpdir(), "lca-token-runtime-"));
  roots.push(root);
  process.env.LCA_TOKEN_HOME = join(root, "state");
  process.env.LCA_TOKEN_PROFILE = profile;
  return { root, home: join(root, "state"), profile };
}

test("default runtime uses a dedicated per-profile headless namespace", () => {
  const { home } = selectProfile();
  const config = defaultConfig();
  expect(getProductHome()).toBe(home);
  expect(getConfigDir()).toBe(join(home, "profiles", "work"));
  expect(config).toMatchObject({
    host: "127.0.0.1",
    port: 8317,
    appName: "lca-token",
    browserHost: "managed-chrome",
  });
  expect(config.storageStatePath).toBe(join(home, "profiles", "work", "browser", "storage-state.json"));
  expect(config.brokerSocketPath).toBe(join(home, "profiles", "work", "runtime", "turn-broker.sock"));
});

test("tunnel identity is isolated by LCA Token profile", () => {
  const { home } = selectProfile("team-a");
  const key = join(home, "profiles", "team-a", "secrets", "runtime.key");
  mkdirSync(join(home, "profiles", "team-a", "secrets"), { recursive: true });
  writeFileSync(key, "secret");
  const tunnel = createTunnelConfig({
    binaryPath: "/usr/local/bin/tunnel-client",
    runtimeKeyFile: key,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  });
  expect(tunnel.profileName).toBe("lca-token-team-a");
  expect(tunnel.alias).toBe("lca-token-team-a");
  expect(tunnel.profileDir).toBe(join(home, "profiles", "team-a", "tunnel", "profiles"));
});

test("Linux daemon service runs headed Chrome inside Xvfb and carries the isolated profile environment", () => {
  const { home } = selectProfile("server");
  const config = defaultConfig();
  config.runtimeCommand = ["/opt/lca-token/bin/bun", "/opt/lca-token/app/cli.js"];
  const unit = serviceDefinition(config, "linux");
  expect(unit).toContain("Description=LCA Token background Responses runtime (server)");
  expect(unit).toContain("ExecStart=\"/usr/bin/env\" \"xvfb-run\" \"-a\" \"-s\" \"-screen 0 1440x1000x24 -nolisten tcp\"");
  expect(unit).toContain("\"/opt/lca-token/bin/bun\" \"/opt/lca-token/app/cli.js\" \"serve\"");
  expect(unit).toContain(`LCA_TOKEN_HOME=${home}`);
  expect(unit).toContain("LCA_TOKEN_PROFILE=server");
  expect(unit).not.toContain("LCA_CODEX_");
  expect(unit).not.toContain("Electron");
});

test("Linux tunnel service exposes only the tunnel profile, never tunnel credentials", () => {
  const { home } = selectProfile("server");
  const config = defaultConfig();
  const key = join(home, "profiles", "server", "secrets", "runtime.key");
  mkdirSync(join(home, "profiles", "server", "secrets"), { recursive: true });
  writeFileSync(key, "super-secret-runtime-key");
  config.tunnel = createTunnelConfig({
    binaryPath: "/opt/lca-token/bin/tunnel-client",
    runtimeKeyFile: key,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  });
  const unit = tunnelServiceDefinitionForPlatform(config, "linux");
  expect(unit).toContain("lca-token-server");
  expect(unit).toContain("LCA_TOKEN_PROFILE=server");
  expect(unit).not.toContain(config.tunnel.tunnelId);
  expect(unit).not.toContain(config.tunnel.runtimeKeyFile);
  expect(unit).not.toContain("super-secret-runtime-key");
  expect(unit).not.toContain("LCA_CODEX_");
});
