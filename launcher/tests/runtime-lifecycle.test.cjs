const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeLifecycleCoordinator } = require("../electron/runtime-lifecycle.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const calls = [];
  const runtimeStates = [];
  const toolHealth = [];
  const health = deferred();
  const runtimeHost = {
    stopCodexToolHealthProbe() { calls.push("health:stop"); },
    resetCodexToolHealth() { calls.push("health:reset"); },
    codexToolHealthSnapshot() { return { checkedAt: null, live: false, tools: [] }; },
    async checkCodexTools() { calls.push("health:check"); return health.promise; },
    async upgradeManagedRuntime() { calls.push("runtime:upgrade"); return { updated: false }; },
    async activateRuntimeBridge() { calls.push("bridge:activate"); return { route: { active: true } }; },
    async deactivateRuntimeBridge(name) { calls.push(name ? `bridge:deactivate:${name}` : "bridge:deactivate"); return { route: { active: false } }; },
    async cancelActiveOperation() { calls.push("runtime:cancel-operation"); },
  };
  const runtimeSupervisor = {
    async observeRuntime() { calls.push("runtime:observe"); return { lifecycle: "stopped", owner: "none" }; },
    async startRuntime() { calls.push("runtime:start"); return { lifecycle: "ready" }; },
    async stopRuntime() { calls.push("runtime:stop"); return { lifecycle: "stopped" }; },
  };
  const coordinator = createRuntimeLifecycleCoordinator({
    runtimeHost,
    runtimeSupervisor,
    logger: { warn() {} },
    publishRuntimeState: state => runtimeStates.push(state),
    publishToolHealth: state => toolHealth.push(state),
    updateBridgeState: bridge => calls.push(`bridge:state:${bridge.route.active}`),
    applyRuntimeUpgradeState: () => calls.push("runtime:upgrade-state"),
    startCatalogVerificationMonitor: () => calls.push("catalog:start"),
    stopCatalogVerificationMonitor: () => calls.push("catalog:stop"),
  });
  return { calls, coordinator, health, runtimeHost, runtimeStates, runtimeSupervisor, toolHealth };
}

test("runtime start is ready before the bounded Codex tool-health probe finishes", async () => {
  const current = fixture();
  const status = await current.coordinator.start();

  assert.equal(status.lifecycle, "ready");
  // The unresolved health promise proves Start did not await the diagnostic probe.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current.calls.includes("health:check"), true);
  assert.deepEqual(current.toolHealth, [{ checkedAt: null, live: false, tools: [] }]);

  current.health.resolve({ checkedAt: "2026-08-10T12:00:00.000Z", live: true, tools: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current.toolHealth.at(-1).live, true);
});

test("runtime stop invalidates a slow health result so stale diagnostics cannot republish", async () => {
  const current = fixture();
  await current.coordinator.start();
  await new Promise(resolve => setImmediate(resolve));
  await current.coordinator.stop();

  current.health.resolve({ checkedAt: "2026-08-10T12:00:00.000Z", live: true, tools: [] });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(current.toolHealth, [{ checkedAt: null, live: false, tools: [] }]);
  assert.deepEqual(current.calls.slice(-6), [
    "health:stop",
    "runtime:cancel-operation",
    "bridge:deactivate",
    "bridge:state:false",
    "catalog:stop",
    "runtime:stop",
  ]);
  assert.equal(current.runtimeStates.at(-1).lifecycle, "stopped");
});

test("runtime startup compensation restores native Codex and stops a daemon after bridge activation fails", async () => {
  const current = fixture();
  current.runtimeHost.activateRuntimeBridge = async () => {
    current.calls.push("bridge:activate");
    throw new Error("synthetic bridge startup failure");
  };

  await assert.rejects(current.coordinator.start(), /synthetic bridge startup failure/);
  assert.equal(current.calls.includes("bridge:deactivate:runtime-start-fail-safe"), true);
  assert.equal(current.calls.includes("runtime:stop"), true);
  assert.equal(current.runtimeStates.at(-1).lifecycle, "stopped");
});

test("runtime restart keeps the Codex route managed between stop and fresh start", async () => {
  const current = fixture();
  await current.coordinator.restart();

  assert.equal(current.calls.includes("bridge:deactivate"), false);
  assert.equal(current.calls.includes("runtime:stop"), true);
  assert.equal(current.calls.includes("bridge:activate"), true);
});

test("a failed restart stop restores the catalog monitor for the still-active route", async () => {
  const current = fixture();
  current.runtimeSupervisor.stopRuntime = async () => {
    current.calls.push("runtime:stop");
    throw new Error("active turn still running");
  };

  await assert.rejects(current.coordinator.restart(), /active turn still running/);
  assert.equal(current.calls.includes("bridge:deactivate"), false);
  assert.equal(current.calls.at(-1), "catalog:start");
});

test("a failed normal stop reconnects the route only after runtime compensation is ready", async () => {
  const current = fixture();
  current.runtimeSupervisor.stopRuntime = async () => {
    current.calls.push("runtime:stop");
    throw new Error("active turn still running");
  };
  current.runtimeSupervisor.observeRuntime = async () => {
    current.calls.push("runtime:observe-compensation");
    return { lifecycle: "ready", owner: "current-launcher" };
  };

  await assert.rejects(current.coordinator.stop(), /active turn still running/);
  assert.deepEqual(current.calls.slice(-5), [
    "runtime:stop",
    "runtime:observe-compensation",
    "bridge:activate",
    "bridge:state:true",
    "catalog:start",
  ]);
});

test("launcher quit commits only after native Codex and the runtime are stopped", async () => {
  const current = fixture();
  let committed = false;
  await current.coordinator.quit({
    commit: async () => {
      committed = true;
      current.calls.push("quit:commit");
    },
  });

  assert.equal(committed, true);
  assert.ok(current.calls.indexOf("bridge:deactivate") < current.calls.indexOf("runtime:stop"));
  assert.ok(current.calls.indexOf("runtime:stop") < current.calls.indexOf("quit:commit"));
});

test("launcher quit never commits when native Codex restoration fails", async () => {
  const current = fixture();
  current.runtimeHost.deactivateRuntimeBridge = async () => {
    current.calls.push("bridge:deactivate");
    throw new Error("synthetic native restore failure");
  };
  let committed = false;

  await assert.rejects(current.coordinator.quit({
    commit: async () => { committed = true; },
  }), /synthetic native restore failure/);
  assert.equal(committed, false);
  assert.equal(current.calls.includes("runtime:stop"), false);
});
