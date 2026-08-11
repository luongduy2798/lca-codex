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
}) {
  let toolHealthGeneration = 0;

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
      .then(() => runtimeHost.checkCodexTools())
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

  const start = async () => {
    let runtimeStarted = false;
    const healthGeneration = invalidateToolHealth({ reset: true });
    try {
      const before = await runtimeSupervisor.observeRuntime();
      if (before.lifecycle === "foreign") {
        throw new Error(before.detail || "The configured Responses port is owned by another process");
      }
      if (before.lifecycle === "stale" || before.owner === "external-runtime") {
        await runtimeSupervisor.stopRuntime();
        const cleaned = await runtimeSupervisor.observeRuntime();
        if (cleaned.lifecycle === "foreign" || cleaned.lifecycle === "stale") {
          throw new Error(cleaned.detail || "Previous runtime could not be cleaned safely");
        }
      }
      const upgrade = await runtimeHost.upgradeManagedRuntime();
      applyRuntimeUpgradeState(upgrade);
      const status = await runtimeSupervisor.startRuntime();
      runtimeStarted = status.lifecycle === "ready";
      publishRuntimeState(status);
      if (runtimeStarted) {
        const bridge = await runtimeHost.activateRuntimeBridge();
        updateBridgeState(bridge);
        startCatalogVerificationMonitor();
        // Tool health is diagnostic, not a readiness gate. Start returns as soon as the
        // runtime and reversible Codex bridge are ready; the bounded probe publishes later.
        checkToolsAfterStart(healthGeneration);
      }
      return status;
    } catch (error) {
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

  const stop = async ({ restoreCodex = true } = {}) => {
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

  const restart = async () => {
    await stop({ restoreCodex: false });
    return start();
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
