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
    cancelPendingStart() { calls.push("runtime:cancel-start"); },
    async stopAllRuntimes() { calls.push("runtime:stop-all"); return { lifecycle: "stopped" }; },
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
    abortBrowserTurns: () => calls.push("browser:abort-all"),
  });
  return { calls, coordinator, health, runtimeHost, runtimeStates, runtimeSupervisor, toolHealth };
}

for (const action of ["start", "restart"]) {
  test(`manual ${action} always performs full cleanup, including when already ready`, async () => {
    const f = fixture();
    f.runtimeSupervisor.observeRuntime = async () => ({ lifecycle: "ready" });
    assert.equal((await f.coordinator[action]({ manual: true })).lifecycle, "ready");
    for (const name of ["runtime:cancel-start", "browser:abort-all", "bridge:deactivate", "runtime:stop-all"]) {
      assert.ok(f.calls.indexOf(name) >= 0);
      assert.ok(f.calls.indexOf(name) < f.calls.indexOf("runtime:start"));
    }
    assert.ok(f.calls.indexOf("runtime:stop-all") < f.calls.indexOf("runtime:upgrade"));
    assert.ok(f.calls.indexOf("runtime:start") < f.calls.indexOf("bridge:activate"));
  });
}

test("manual Stop still cleans all processes when native route restoration fails", async () => {
  const f = fixture();
  f.runtimeHost.deactivateRuntimeBridge = async () => { throw new Error("route restore failed"); };
  await assert.rejects(f.coordinator.stop({ manual: true }), /route restore failed/);
  assert.ok(f.calls.includes("runtime:stop-all"));
  assert.equal(f.runtimeStates.at(-1).lifecycle, "stopped");
  assert.equal(f.calls.includes("bridge:activate"), false);
});

test("cleanup failure prevents replacement and never resumes the old runtime", async () => {
  const f = fixture();
  f.runtimeSupervisor.stopAllRuntimes = async () => { throw new Error("verified PID did not exit"); };
  await assert.rejects(f.coordinator.start({ manual: true }), /verified PID/);
  assert.equal(f.calls.includes("runtime:start"), false);
  assert.equal(f.calls.includes("runtime:upgrade"), false);
  assert.equal(f.calls.includes("bridge:activate"), false);
});

test("Stop cancels a pending manual Start without queueing a replacement", async () => {
  const f = fixture();
  const pending = deferred();
  f.runtimeHost.upgradeManagedRuntime = () => pending.promise;
  const start = f.coordinator.start({ manual: true });
  const cancelled = assert.rejects(start, /cancelled by Stop/);
  await new Promise(resolve => setImmediate(resolve));
  await f.coordinator.stop({ manual: true });
  pending.resolve({ updated: false });
  await cancelled;
  assert.equal(f.calls.includes("runtime:start"), false);
  assert.equal(f.calls.includes("bridge:activate"), false);
});

test("late Ready and tool-health results cannot override a manual Stop", async () => {
  const f = fixture();
  const pending = deferred();
  f.runtimeSupervisor.startRuntime = () => pending.promise;
  const start = f.coordinator.start({ manual: true });
  const cancelled = assert.rejects(start, /cancelled by Stop/);
  await new Promise(resolve => setImmediate(resolve));
  await f.coordinator.stop({ manual: true });
  pending.resolve({ lifecycle: "ready" });
  f.health.resolve({ live: true });
  await cancelled;
  assert.equal(f.runtimeStates.at(-1).lifecycle, "stopped");
  assert.equal(f.calls.includes("bridge:activate"), false);
  assert.equal(f.toolHealth.at(-1).live, false);
});

test("duplicate Stops share cleanup and Stop during initial cleanup cancels Start", async () => {
  const f = fixture();
  const pending = deferred();
  let cleanupCount = 0;
  f.runtimeSupervisor.stopAllRuntimes = () => { cleanupCount++; return pending.promise; };
  const start = f.coordinator.start({ manual: true });
  const cancelled = assert.rejects(start, /cancelled by Stop/);
  await new Promise(resolve => setImmediate(resolve));
  const stop1 = f.coordinator.stop({ manual: true });
  const stop2 = f.coordinator.stop({ manual: true });
  assert.equal(stop1, stop2);
  await assert.rejects(f.coordinator.restart({ manual: true }), /already running/);
  pending.resolve({ lifecycle: "stopped" });
  await Promise.all([stop1, stop2, cancelled]);
  assert.equal(cleanupCount, 1);
  assert.equal(f.calls.includes("runtime:start"), false);
});

test("automatic start and Quit never opt into manual cleanup", async () => {
  const f = fixture();
  await f.coordinator.start();
  await f.coordinator.quit({ commit: async () => {} });
  assert.equal(f.calls.includes("runtime:stop-all"), false);
  assert.equal(f.calls.includes("browser:abort-all"), false);
});

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

for (const lifecycle of ["stale", "degraded"]) {
  test(`manual Start reclaims a ${lifecycle} runtime before upgrading and activating the route`, async () => {
    const current = fixture();
    let stopped = false;
    current.runtimeSupervisor.observeRuntime = async () => stopped
      ? { lifecycle: "stopped", owner: "none" }
      : { lifecycle, owner: lifecycle === "stale" ? "external-runtime" : "current-launcher" };
    current.runtimeSupervisor.stopRuntime = async (options) => {
      assert.deepEqual(options, { forceOwnedDaemon: true, reclaimExternalDaemon: true });
      current.calls.push("runtime:reclaim");
      stopped = true;
    };
    current.runtimeSupervisor.startRuntime = async (options) => {
      assert.deepEqual(options, { reclaimExternalDaemon: true });
      current.calls.push("runtime:start");
      return { lifecycle: "ready" };
    };

    assert.equal((await current.coordinator.start({ reclaimExternalDaemon: true })).lifecycle, "ready");
    assert.ok(current.calls.indexOf("runtime:reclaim") < current.calls.indexOf("runtime:upgrade"));
    assert.ok(current.calls.indexOf("runtime:upgrade") < current.calls.indexOf("runtime:start"));
    assert.ok(current.calls.indexOf("runtime:start") < current.calls.indexOf("bridge:activate"));
  });
}

test("automatic startup never opts into forced external-runtime recovery", async () => {
  const current = fixture();
  let stopped = false;
  current.runtimeSupervisor.observeRuntime = async () => stopped
    ? { lifecycle: "stopped", owner: "none" }
    : { lifecycle: "stale", owner: "external-runtime" };
  current.runtimeSupervisor.stopRuntime = async (options) => {
    assert.deepEqual(options, { forceOwnedDaemon: false, reclaimExternalDaemon: false });
    stopped = true;
  };
  await current.coordinator.start();
  assert.equal(stopped, true);
});

test("manual Start leaves an unrelated Responses port occupant untouched", async () => {
  const current = fixture();
  current.runtimeSupervisor.observeRuntime = async () => ({ lifecycle: "foreign", owner: "foreign" });
  await assert.rejects(current.coordinator.start({ reclaimExternalDaemon: true }), /owned by another process/);
  for (const action of ["runtime:stop", "runtime:start", "runtime:upgrade", "bridge:activate"]) {
    assert.equal(current.calls.includes(action), false);
  }
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
