const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  bridgeStatus,
  readCliSetting,
  removeBridge,
  repairBridge,
  removeCliSetting,
  setCliSetting,
  setupBridge,
} = require("../electron/codex-lifecycle-bridge.cjs");

const proxySourcePath = path.resolve(__dirname, "../electron/codex-cli-proxy.cjs");

test("VS Code setting edits preserve JSONC comments and can restore absence", () => {
  const initial = `{
  // keep this comment
  "editor.fontSize": 14
}\n`;
  const configured = setCliSetting(initial, "/tmp/lca-codex-proxy");
  assert.match(configured, /keep this comment/);
  assert.equal(readCliSetting(configured), "/tmp/lca-codex-proxy");
  const restored = removeCliSetting(configured);
  assert.equal(readCliSetting(restored), undefined);
  assert.match(restored, /"editor\.fontSize": 14/);
  assert.match(restored, /keep this comment/);
});

test("legacy manual Lca proxy configuration migrates to managed state and removes cleanly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-lifecycle-legacy-"));
  const coreHome = path.join(root, "lca-home");
  const homeDir = path.join(root, "user");
  const settingsPath = path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  const extensionRoot = path.join(homeDir, ".vscode", "extensions", "openai.chatgpt-test");
  const legacyProxyPath = path.join(coreHome, "bin", "lca-codex-proxy");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `{\n  "chatgpt.cliExecutable": ${JSON.stringify(legacyProxyPath)}\n}\n`);
  try {
    setupBridge({ coreHome, proxySourcePath, electronExecutable: process.execPath, homeDir, platform: "darwin" });
    removeBridge({ coreHome, proxySourcePath, homeDir, platform: "darwin" });
    assert.equal(readCliSetting(fs.readFileSync(settingsPath, "utf8")), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Configured VS Code proxy self-heals when the renamed executable is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-vscode-proxy-repair-"));
  const coreHome = path.join(root, ".lca-codex");
  const homeDir = path.join(root, "user");
  const settingsPath = path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  const extensionRoot = path.join(homeDir, ".vscode", "extensions", "openai.chatgpt-test");
  const expectedProxy = path.join(coreHome, "bin", "lca-codex-proxy");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `{\n  "chatgpt.cliExecutable": ${JSON.stringify(expectedProxy)}\n}\n`);
  try {
    const before = bridgeStatus({ coreHome, proxySourcePath, homeDir, platform: "darwin" });
    assert.equal(before.configured, true);
    assert.equal(before.installed, false);

    const repaired = repairBridge({ coreHome, proxySourcePath, electronExecutable: process.execPath, homeDir, platform: "darwin" });
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.installed, true);
    assert.equal(repaired.configured, true);
    assert.equal(fs.existsSync(expectedProxy), true);

    const second = repairBridge({ coreHome, proxySourcePath, electronExecutable: process.execPath, homeDir, platform: "darwin" });
    assert.equal(second.repaired, false);
    assert.equal(second.state, "configured");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manual VS Code advanced setup installs only the proxy and cleanup removes a later manual setting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-vscode-advanced-manual-"));
  const coreHome = path.join(root, "lca-home");
  const homeDir = path.join(root, "user");
  const settingsPath = path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  const extensionRoot = path.join(homeDir, ".vscode", "extensions", "openai.chatgpt-test");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, "{}\n");
  try {
    const installed = setupBridge({ coreHome, proxySourcePath, electronExecutable: process.execPath, homeDir, platform: "darwin", configureSettings: false });
    assert.equal(installed.installed, true);
    assert.equal(installed.configured, false);
    assert.equal(readCliSetting(fs.readFileSync(settingsPath, "utf8")), undefined);

    fs.writeFileSync(settingsPath, setCliSetting(fs.readFileSync(settingsPath, "utf8"), installed.proxyPath));
    assert.equal(bridgeStatus({ coreHome, proxySourcePath, homeDir, platform: "darwin" }).state, "configured");

    removeBridge({ coreHome, proxySourcePath, homeDir, platform: "darwin" });
    assert.equal(readCliSetting(fs.readFileSync(settingsPath, "utf8")), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Automatic VS Code advanced setup installs a durable proxy and restores the previous setting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-lifecycle-bridge-"));
  const coreHome = path.join(root, "lca-home");
  const homeDir = path.join(root, "user");
  const settingsPath = path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json");
  const extensionRoot = path.join(homeDir, ".vscode", "extensions", "openai.chatgpt-test");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `{\n  "chatgpt.cliExecutable": "/previous/codex"\n}\n`);
  try {
    const installed = setupBridge({ coreHome, proxySourcePath, electronExecutable: process.execPath, homeDir, platform: "darwin", configureSettings: true });
    assert.equal(installed.installed, true);
    assert.equal(installed.state, "configured");
    assert.equal(installed.configured, true);
    assert.equal(installed.settingsPath, settingsPath);
    assert.equal(readCliSetting(fs.readFileSync(settingsPath, "utf8")), installed.proxyPath);
    assert.equal(fs.existsSync(installed.proxyPath), true);

    const removed = removeBridge({ coreHome, proxySourcePath, homeDir, platform: "darwin" });
    assert.equal(removed.installed, false);
    assert.equal(readCliSetting(fs.readFileSync(settingsPath, "utf8")), "/previous/codex");
    assert.equal(bridgeStatus({ coreHome, proxySourcePath, homeDir, platform: "darwin" }).state, "not-configured");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
