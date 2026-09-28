function createRuntimeLifecycleCoordinator({
  runtimeHost,
  runtimeSupervisor,
  logger,
  publishRuntimeState = () => {},
  publishToolHealth = () => {},
  updateBridgeState = () => {},
  applyRuntimeUpgradeState = () => {},
  startCatalogVerificationMonitor = () => {},
  stopCatalogVerificationMonitor = () => {},
  abortBrowserTurns = () => {},
}) {
  let toolHealthGeneration = 0;
  let manualGeneration = 0;
  let manualStartPromise = null;
  let manualStopPromise = null;
  const assertGeneration = generation => {
    if (generation !== manualGeneration) throw new Error("Runtime start was cancelled by Stop");
  };

  const invalidateToolHealth = ({ reset = false } = {}) => {
    toolHealthGeneration += 1;
    runtimeHost.stopCodexToolHealthProbe?.();
    if (reset) {
      runtimeHost.resetCodexToolHealth();
      publishToolHealth(runtimeHost.codexToolHealthSnapshot());
    }
    return toolHealthGeneration;
  };

  const checkToolsAfterStart = (generation) => {
    void Promise.resolve()
      .then(() => generation === toolHealthGeneration ? runtimeHost.checkCodexTools() : null)
      .then((report) => {
        if (generation !== toolHealthGeneration) return;
        publishToolHealth(report);
      })
      .catch((error) => {
        if (generation !== toolHealthGeneration) return;
        logger?.warn?.("codex.tool_health_check_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const startGracefully = async ({ reclaimExternalDaemon = false } = {}) => {
    const generation = manualGeneration;
    let runtimeStarted = false;
    const healthGeneration = invalidateToolHealth({ reset: true });
    try {
      const before = await runtimeSupervisor.observeRuntime();
      assertGeneration(generation);
      if (before.lifecycle === "foreign") {
        throw new Error(before.detail || "The configured Responses port is owned by another process");
      }
      if (before.lifecycle === "stale" || before.owner === "external-runtime"
        || (reclaimExternalDaemon && before.lifecycle === "degraded")) {
        await runtimeSupervisor.stopRuntime({
          forceOwnedDaemon: reclaimExternalDaemon,
          reclaimExternalDaemon,
        });
        const cleaned = await runtimeSupervisor.observeRuntime();
        if (cleaned.lifecycle === "foreign" || cleaned.lifecycle === "stale") {
          throw new Error(cleaned.detail || "Previous runtime could not be cleaned safely");
        }
      }
      const upgrade = await runtimeHost.upgradeManagedRuntime();
      assertGeneration(generation);
      applyRuntimeUpgradeState(upgrade);
      const status = await runtimeSupervisor.startRuntime({ reclaimExternalDaemon });
      assertGeneration(generation);
      runtimeStarted = status.lifecycle === "ready";
      publishRuntimeState(status);
      if (runtimeStarted) {
        const bridge = await runtimeHost.activateRuntimeBridge();
        assertGeneration(generation);
        updateBridgeState(bridge);
        startCatalogVerificationMonitor();
        // Tool health is diagnostic, not a readiness gate. Start returns as soon as the
        // runtime and reversible Codex bridge are ready; the bounded probe publishes later.
        checkToolsAfterStart(healthGeneration);
      }
      return status;
    } catch (error) {
      if (generation !== manualGeneration) throw error;
      invalidateToolHealth();
      stopCatalogVerificationMonitor();
      let message = error instanceof Error ? error.message : String(error);
      try {
        const bridge = await runtimeHost.deactivateRuntimeBridge("runtime-start-fail-safe");
        updateBridgeState(bridge);
      } catch (restoreError) {
        message += `; restoring native Codex after startup failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
      }
      if (runtimeStarted) {
        try {
          const stopped = await runtimeSupervisor.stopRuntime();
          publishRuntimeState(stopped);
        } catch (stopError) {
          message += `; stopping the runtime after startup failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
        }
      }
      throw new Error(message);
    }
  };

  const stopGracefully = async ({ restoreCodex = true } = {}) => {
    invalidateToolHealth();
    try {
      await runtimeHost.cancelActiveOperation();
    } catch (error) {
      logger?.warn?.("runtime.operation_cancel_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    let bridgeDeactivated = false;
    try {
      if (restoreCodex) {
        const bridge = await runtimeHost.deactivateRuntimeBridge();
        updateBridgeState(bridge);
        bridgeDeactivated = true;
      }
      stopCatalogVerificationMonitor();
      const status = await runtimeSupervisor.stopRuntime();
      publishRuntimeState(status);
      return status;
    } catch (error) {
      // A restart keeps the route active. If its stop phase fails, restore the monitor that was
      // paused for the transition. A normal stop with a successfully restored native route does
      // not reconnect unless the supervisor proves its compensation returned the runtime to ready.
      let message = error instanceof Error ? error.message : String(error);
      let restoreCatalogMonitor = !restoreCodex || !bridgeDeactivated;
      if (restoreCodex && bridgeDeactivated) {
        try {
          const runtime = await runtimeSupervisor.observeRuntime();
          if (runtime.lifecycle === "ready") {
            const bridge = await runtimeHost.activateRuntimeBridge("runtime-stop-rollback");
            updateBridgeState(bridge);
            restoreCatalogMonitor = true;
          }
        } catch (rollbackError) {
          message += `; restoring the Codex route after stop failure also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
        }
      }
      if (restoreCatalogMonitor) startCatalogVerificationMonitor();
      throw new Error(message);
    }
  };

  const cleanupManual = () => {
    if (manualStopPromise) return manualStopPromise;
    invalidateToolHealth({ reset: true });
    stopCatalogVerificationMonitor();
    runtimeSupervisor.cancelPendingStart();
    // Begin synchronously so another Start cannot enter while cleanup is pending.
    manualStopPromise = (async () => {
      const failures = [];
      const attempt = async fn => {
        try { return await fn(); } catch (error) { failures.push(error.message || String(error)); }
      };
      await attempt(() => abortBrowserTurns());
      await attempt(() => runtimeHost.cancelActiveOperation());
      await attempt(async () => {
        const bridge = await runtimeHost.deactivateRuntimeBridge();
        updateBridgeState(bridge);
      });
      // Native-route restoration must never prevent cleanup of the actual runtime.
      const status = await attempt(() => runtimeSupervisor.stopAllRuntimes());
      if (status) publishRuntimeState(status);
      if (failures.length) throw new Error(failures.join("; "));
      return status;
    })().finally(() => { manualStopPromise = null; });
    return manualStopPromise;
  };

  const stopManual = () => {
    manualGeneration += 1;
    return cleanupManual();
  };

  const startManual = () => {
    if (manualStartPromise || manualStopPromise) return Promise.reject(new Error("A runtime lifecycle operation is already running"));
    const generation = ++manualGeneration;
    manualStartPromise = (async () => {
      let replacementAttempted = false;
      try {
        await cleanupManual();
        assertGeneration(generation);
        const upgrade = await runtimeHost.upgradeManagedRuntime();
        assertGeneration(generation);
        applyRuntimeUpgradeState(upgrade);
        replacementAttempted = true;
        const status = await runtimeSupervisor.startRuntime();
        assertGeneration(generation);
        if (status.lifecycle !== "ready") throw new Error(status.detail || "Fresh runtime is not ready");
        const bridge = await runtimeHost.activateRuntimeBridge();
        assertGeneration(generation);
        updateBridgeState(bridge);
        publishRuntimeState(status);
        startCatalogVerificationMonitor();
        checkToolsAfterStart(toolHealthGeneration);
        return status;
      } catch (error) {
        if (generation !== manualGeneration || !replacementAttempted) throw error;
        try { await cleanupManual(); } catch (cleanupError) {
          throw new Error(`${error.message}; runtime cleanup failed: ${cleanupError.message}`);
        }
        throw error;
      }
    })().finally(() => { manualStartPromise = null; });
    return manualStartPromise;
  };

  const start = (options = {}) => options.manual ? startManual() : startGracefully(options);
  const stop = (options = {}) => options.manual ? stopManual() : stopGracefully(options);
  const restart = async ({ manual = false } = {}) => {
    if (manual) return startManual();
    await stopGracefully({ restoreCodex: false });
    return startGracefully();
  };

  const quit = async ({ commit } = {}) => {
    if (typeof commit !== "function") throw new Error("Runtime quit requires a commit callback");
    await stop({ restoreCodex: true });
    await commit();
    return { ok: true };
  };

  return {
    start,
    stop,
    restart,
    quit,
    invalidateToolHealth,
  };
}

module.exports = { createRuntimeLifecycleCoordinator };
