import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDurableRuntimeCommand,
  defaultBrokerEndpoint,
  defaultConfig,
  expandUserPath,
  isWindowsPipeEndpoint,
  installedBunExecutable,
  providerConfig,
  resolveBrokerEndpoint,
  runtimeCommandForProcess,
} from "../src/config";
import { processRunning } from "../src/process";

const roots: string[] = [];
afterEach(() => {
  delete process.env.LCA_CODEX_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("managed runtime commands reject every ephemeral path component", () => {
  expect(() => assertDurableRuntimeCommand(["/private/tmp/lca-codex"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath, "/tmp/build/app/cli.js"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath])).not.toThrow();
});

test("Windows Bun shims resolve to the installed Bun executable before service setup", () => {
  const ephemeralBun = join(tmpdir(), "bun-node-test", "bun");
  expect(runtimeCommandForProcess({
    executable: ephemeralBun,
    bunExecutable: process.execPath,
    entry: import.meta.path,
  })).toEqual([process.execPath, import.meta.path]);
  expect(() => runtimeCommandForProcess({
    executable: ephemeralBun,
    entry: import.meta.path,
  })).toThrow("ephemeral path");
});

test("installed Bun discovery ignores a temporary self-extract executable", () => {
  const root = join(tmpdir(), `lca-codex-bun-discovery-${process.pid}-${Date.now()}`);
  const ephemeralBun = join(root, "bun-node-test", "bun.exe");
  roots.push(root);
  mkdirSync(join(root, "bun-node-test"), { recursive: true });
  writeFileSync(ephemeralBun, "");
  expect(installedBunExecutable({
    platform: "win32",
    pathValue: "",
    candidates: [ephemeralBun, process.execPath],
  })).toBe(process.execPath);
});

test("Windows uses a stable native named pipe for the outer Codex tool broker", () => {
  const first = defaultBrokerEndpoint("C:\\Users\\alice\\.lca-codex", "win32");
  const second = defaultBrokerEndpoint("C:\\Users\\alice\\.lca-codex", "win32");
  expect(first).toBe(second);
  expect(isWindowsPipeEndpoint(first)).toBe(true);
  expect(resolveBrokerEndpoint(first)).toBe(first);
  expect(defaultBrokerEndpoint("/home/alice/.lca-codex", "linux")).toEndWith(join("runtime", "turn-broker.sock"));
});

test("permission-denied process probes preserve ownership evidence", () => {
  expect(processRunning(123, () => {
    const error = new Error("access denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  })).toBe(true);
  expect(processRunning(123, () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  })).toBe(false);
  expect(processRunning(0)).toBe(false);
});

test("user-home expansion accepts native Unix and Windows separators", () => {
  expect(expandUserPath("~/runtime")).toBe(join(homedir(), "runtime"));
  expect(expandUserPath("~\\runtime")).toBe(join(homedir(), "runtime"));
});

test("launcher browser ownership is explicit in provider configuration", () => {
  const config = defaultConfig();
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = "/Users/example/.lca-codex/runtime/launcher-browser.json";
  expect(providerConfig(config).lcaCodex).toMatchObject({
    browserHost: "launcher",
    browserHostDescriptorPath: config.browserHostDescriptorPath,
  });
});
