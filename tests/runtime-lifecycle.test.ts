import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import {
  restartRuntimeStack,
  startRuntimeStack,
  type RuntimeLifecycleOps,
} from "../src/runtime-lifecycle";

const config = {} as AppConfig;

const daemonStatus = {
  supported: true,
  installed: true,
  loaded: true,
  label: "daemon",
};

const tunnelServiceStatus = {
  supported: true,
  installed: true,
  loaded: true,
  running: true,
  label: "tunnel",
};

const readyTunnel = {
  ok: true,
  processRunning: true,
  healthy: true,
  ready: true,
  detail: "ready",
};

function lifecycleOps(actions: string[], tunnelReady = readyTunnel): RuntimeLifecycleOps {
  return {
    getServiceStatus: () => daemonStatus,
    startService: async () => {
      actions.push("start-daemon");
      return daemonStatus;
    },
    stopService: async () => {
      actions.push("stop-daemon");
      return { ...daemonStatus, loaded: false };
    },
    getTunnelServiceStatus: () => tunnelServiceStatus,
    startTunnelService: () => {
      actions.push("start-tunnel-service");
      return tunnelServiceStatus;
    },
    stopTunnelService: async () => {
      actions.push("stop-tunnel-service");
      return { ...tunnelServiceStatus, loaded: false, running: false };
    },
    stopTunnel: () => {
      actions.push("stop-tunnel-runtime");
    },
    tunnelStatus: () => tunnelReady,
    waitForTunnelReady: async () => {
      actions.push("wait-tunnel-ready");
      return tunnelReady;
    },
  };
}

describe("unified runtime lifecycle", () => {
  test("restart tears down and recreates both daemon and tunnel/MCP layers", async () => {
    const actions: string[] = [];
    await restartRuntimeStack(config, lifecycleOps(actions));
    expect(actions).toEqual([
      "stop-daemon",
      "stop-tunnel-service",
      "stop-tunnel-runtime",
      "start-daemon",
      "start-tunnel-service",
      "wait-tunnel-ready",
    ]);
  });

  test("failed tunnel startup rolls the daemon back instead of leaving a half-started stack", async () => {
    const actions: string[] = [];
    const notReady = {
      ok: false,
      processRunning: true,
      healthy: true,
      ready: false,
      detail: "not ready",
    };
    await expect(startRuntimeStack(config, lifecycleOps(actions, notReady))).rejects.toThrow(
      "Failed to start runtime stack",
    );
    expect(actions).toEqual([
      "start-daemon",
      "start-tunnel-service",
      "wait-tunnel-ready",
      "stop-tunnel-service",
      "stop-tunnel-runtime",
      "stop-daemon",
    ]);
  });
});
