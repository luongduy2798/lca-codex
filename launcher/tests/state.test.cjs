const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("../electron/state.cjs");

const DEFAULT_EXPECTED = {
  version: 1,
  autoStart: false,
  runtimeAutoStart: false,
  bridgeEnabled: true,
  keepRunningOnClose: false,
  showBrowserDuringTurns: true,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  connectorName: "",
  sessionRefreshReminderAt: null,
  codexRestartRequestedAt: null,
};

test("launcher state persists manual runtime preferences atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-token-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), DEFAULT_EXPECTED);
    store.update({
      runtimeAutoStart: true,
      keepRunningOnClose: true,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      connectorName: "Duy Local Codex",
    });
    assert.deepEqual(createStateStore(file).read(), {
      ...DEFAULT_EXPECTED,
      runtimeAutoStart: true,
      keepRunningOnClose: true,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      connectorName: "Duy Local Codex",
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("persisted sidebar corruption is repaired without changing valid launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-token-sidebar-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: "yes",
      githubOpened: true,
      autoStart: "yes",
      runtimeAutoStart: "yes",
      keepRunningOnClose: "yes",
      browserSmokePassed: "yes",
      browserSmokeVersion: { invalid: true },
      sidebarOpen: "yes",
      sidebarWidth: 900,
      mcpGuideStep: 99,
      connectorName: 42,
      sessionRefreshReminderAt: "not-a-date",
      codexRestartRequestedAt: "not-a-date",
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), DEFAULT_EXPECTED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy background lifecycle preferences migrate to manual-first defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-token-legacy-lifecycle-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "en",
      onboardingComplete: true,
      githubOpened: true,
      autoStart: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: false,
      connectorName: "  My Connector  ",
    }));
    const state = createStateStore(file).read();
    assert.equal("language" in state, false);
    assert.equal("onboardingComplete" in state, false);
    assert.equal("githubOpened" in state, false);
    assert.equal(state.autoStart, true);
    assert.equal(state.runtimeAutoStart, false);
    assert.equal(state.keepRunningOnClose, false);
    assert.equal(state.showBrowserDuringTurns, false);
    assert.equal(state.connectorName, "My Connector");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session refresh reminders are deferred by exactly 48 hours", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  assert.equal(SESSION_REFRESH_REMINDER_INTERVAL_MS, 48 * 60 * 60 * 1000);
  assert.equal(nextSessionRefreshReminderAt(now), "2026-08-07T12:00:00.000Z");
  assert.throws(() => nextSessionRefreshReminderAt(Number.NaN), /must be finite/);
});
