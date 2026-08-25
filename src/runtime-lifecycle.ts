import type { AppConfig } from "./config";
import {
  getServiceStatus,
  startService,
  stopService,
  type ServiceStatus,
} from "./service";
import {
  stopTunnel,
  tunnelStatus,
  waitForTunnelReady,
  type TunnelRuntimeStatus,
} from "./tunnel";
import {
  getTunnelServiceStatus,
  startTunnelService,
  stopTunnelService,
  type TunnelServiceStatus,
} from "./tunnel-service";

export interface RuntimeStackStatus {
  daemon: ServiceStatus;
  tunnel: {
    service: TunnelServiceStatus;
    runtime: TunnelRuntimeStatus;
  };
}

export interface RuntimeLifecycleOps {
  getServiceStatus: () => ServiceStatus;
  startService: (config: AppConfig) => Promise<ServiceStatus>;
  stopService: (config?: AppConfig) => Promise<ServiceStatus>;
  getTunnelServiceStatus: () => TunnelServiceStatus;
  startTunnelService: () => TunnelServiceStatus;
  stopTunnelService: () => Promise<TunnelServiceStatus>;
  stopTunnel: (config: AppConfig) => void;
  tunnelStatus: (config: AppConfig) => TunnelRuntimeStatus;
  waitForTunnelReady: (config: AppConfig) => Promise<TunnelRuntimeStatus>;
}

const DEFAULT_OPS: RuntimeLifecycleOps = {
  getServiceStatus,
  startService,
  stopService,
  getTunnelServiceStatus,
  startTunnelService,
  stopTunnelService,
  stopTunnel,
  tunnelStatus,
  waitForTunnelReady,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackStatus(config: AppConfig, ops: RuntimeLifecycleOps, runtime?: TunnelRuntimeStatus): RuntimeStackStatus {
  return {
    daemon: ops.getServiceStatus(),
    tunnel: {
      service: ops.getTunnelServiceStatus(),
      runtime: runtime ?? ops.tunnelStatus(config),
    },
  };
}

async function cleanupFailedStart(config: AppConfig, ops: RuntimeLifecycleOps): Promise<string[]> {
  const errors: string[] = [];
  try {
    await ops.stopTunnelService();
  } catch (error) {
    errors.push(`tunnel service cleanup: ${errorMessage(error)}`);
  }
  try {
    ops.stopTunnel(config);
  } catch (error) {
    errors.push(`tunnel runtime cleanup: ${errorMessage(error)}`);
  }
  try {
    await ops.stopService(config);
  } catch (error) {
    errors.push(`daemon cleanup: ${errorMessage(error)}`);
  }
  return errors;
}

export async function startRuntimeStack(
  config: AppConfig,
  ops: RuntimeLifecycleOps = DEFAULT_OPS,
): Promise<RuntimeStackStatus> {
  await ops.startService(config);
  try {
    ops.startTunnelService();
    const runtime = await ops.waitForTunnelReady(config);
    if (!runtime.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${runtime.detail}`);
    return stackStatus(config, ops, runtime);
  } catch (error) {
    const cleanupErrors = await cleanupFailedStart(config, ops);
    const cleanup = cleanupErrors.length > 0 ? `; cleanup also failed: ${cleanupErrors.join("; ")}` : "";
    throw new Error(`Failed to start runtime stack: ${errorMessage(error)}${cleanup}`);
  }
}

export async function stopRuntimeStack(
  config: AppConfig,
  ops: RuntimeLifecycleOps = DEFAULT_OPS,
): Promise<RuntimeStackStatus> {
  const errors: string[] = [];
  try {
    await ops.stopService(config);
  } catch (error) {
    errors.push(`daemon: ${errorMessage(error)}`);
  }
  try {
    await ops.stopTunnelService();
  } catch (error) {
    errors.push(`tunnel service: ${errorMessage(error)}`);
  }
  try {
    ops.stopTunnel(config);
  } catch (error) {
    errors.push(`tunnel runtime: ${errorMessage(error)}`);
  }
  if (errors.length > 0) throw new Error(`Failed to stop runtime stack: ${errors.join("; ")}`);
  return stackStatus(config, ops);
}

export async function restartRuntimeStack(
  config: AppConfig,
  ops: RuntimeLifecycleOps = DEFAULT_OPS,
): Promise<RuntimeStackStatus> {
  await stopRuntimeStack(config, ops);
  return startRuntimeStack(config, ops);
}
