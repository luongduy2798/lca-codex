const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FACTORY_RESET_CLEANUP_ARG,
  assertSafeResetPath,
  cleanupFactoryResetPaths,
  factoryResetRelaunchArgs,
} = require("../electron/factory-reset.cjs");

test("factory reset cleanup removes launcher-owned data roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-factory-reset-"));
  const coreHome = path.join(root, ".lca-codex");
  const userData = path.join(root, "launcher", "lca-codex");
  const logs = path.join(root, "logs", "LCA Codex");
  for (const target of [coreHome, userData, logs]) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "persisted.txt"), "old data");
  }
  cleanupFactoryResetPaths([coreHome, userData, logs]);
  assert.equal(fs.existsSync(coreHome), false);
  assert.equal(fs.existsSync(userData), false);
  assert.equal(fs.existsSync(logs), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("factory reset refuses filesystem roots and the user home directory", () => {
  assert.throws(() => assertSafeResetPath(path.parse(process.cwd()).root), /unsafe path/);
  assert.throws(() => assertSafeResetPath(os.homedir()), /unsafe path/);
});

test("factory reset refuses ordinary personal folders", () => {
  assert.throws(() => assertSafeResetPath(path.join(os.homedir(), "Documents")), /unsafe path/);
  assert.throws(() => assertSafeResetPath(path.join(os.homedir(), "Desktop")), /unsafe path/);
});

test("factory reset refuses LCA-looking paths that resolve outside LCA-owned data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-factory-reset-link-"));
  const personal = path.join(root, "personal");
  const ownedLink = path.join(root, "lca-codex");
  fs.mkdirSync(personal, { recursive: true });
  try {
    fs.symlinkSync(personal, ownedLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("Creating directory links requires additional privileges on this Windows host");
      return;
    }
    throw error;
  }
  assert.throws(() => assertSafeResetPath(ownedLink), /unsafe real path/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("factory reset relaunch args contain one cleanup marker and reopen visibly", () => {
  assert.deepEqual(
    factoryResetRelaunchArgs(["electron", "app", "--hidden", FACTORY_RESET_CLEANUP_ARG]),
    ["app", FACTORY_RESET_CLEANUP_ARG],
  );
});
