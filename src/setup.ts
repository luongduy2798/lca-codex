import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AppConfig } from "./config";
import {
  currentRuntimeCommand,
  defaultConfig,
  getConfigPath,
  loadConfig,
  saveConfig,
} from "./config";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  storedBrowserLoginCapabilities,
} from "./browser-login";
import {
  getServiceStatus,
  installService,
  serviceHealthIsReady,
  stopService,
  waitForServiceReady,
} from "./service";
import { connectTunnel, createTunnelConfig, installRuntimeKey, installRuntimeKeyBytes, installTunnelClient, managedRuntimeKeyPath, stopTunnel, tunnelAliasNeedsRebind, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, installTunnelService, restartTunnelService, stopTunnelService, tunnelServiceDefinitionMatches } from "./tunnel-service";
import { PRODUCT_ID } from "./product";
import { VERSION } from "./version";

export interface SetupOptions {
  port?: number;
  chromeExecutablePath?: string;
  appName?: string;
  replaceCodexRoute?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: "full";
  configPath: string;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  codexRestartRequired: false;
  connectorSetupRequired: boolean;
}

export interface ExistingBridgeSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export function existingBridgeSetupCredentials(existing: AppConfig | undefined): ExistingBridgeSetupCredentials {
  const tunnel = existing?.tunnel;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfig();
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectAvailable(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? rejectAvailable(error) : resolveAvailable()));
  });
}

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return serviceHealthIsReady(health, config);
}

function baseConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  const config = existing ? structuredClone(existing) : defaultConfig();
  config.mode = "full";
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
    config.port = options.port;
  }
  if (options.chromeExecutablePath) config.chromeExecutablePath = options.chromeExecutablePath;
  config.browserHost = "managed-chrome";
  if (options.appName) config.appName = options.appName;
  config.autoApproveToolCalls = true;
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

async function configureTunnel(config: AppConfig, existing: AppConfig | undefined, options: SetupOptions): Promise<void> {
  const existingTunnel = existing?.tunnel;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error("The ChatGPT Web bridge requires --tunnel-id. Create it at https://platform.openai.com/settings/organization/tunnels");
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  if (!runtimeKeyFile && existsSync(managedRuntimeKeyPath())) runtimeKeyFile = managedRuntimeKeyPath();
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue);
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error("The ChatGPT Web bridge requires a runtime key. Import it interactively or pass --runtime-key-file; create it at https://platform.openai.com/settings/organization/api-keys");
  }
  const installedBinary = await installTunnelClient();
  config.tunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName: existingTunnel?.profileName,
    alias: existingTunnel?.alias,
  });
}

async function bootstrapTunnelProfile(config: AppConfig): Promise<void> {
  let bootstrapError: unknown;
  try {
    // `runtimes connect` writes the native profile and returns success only after its managed
    // runtime is running, healthy, and ready. Setup stops that validation runtime transactionally;
    // the managed tunnel service reconnects the same alias after configuration is committed.
    connectTunnel(config);
  } catch (error) {
    bootstrapError = error;
  }
  try {
    stopTunnel(config);
  } catch (stopError) {
    if (bootstrapError) {
      const primary = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      const cleanup = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primary}; temporary tunnel cleanup also failed: ${cleanup}`);
    }
    throw stopError;
  }
  if (bootstrapError) throw bootstrapError;
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const existing = loadExistingConfig();
  const config = baseConfig(existing, options);
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Managed headless setup is not supported on ${process.platform}; run ${PRODUCT_ID} serve directly`);
  }
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  const beforeService = getServiceStatus();

  let proAvailable = storedBrowserLoginCapabilities(config).proAvailable;
  const hasLoginState = browserLoginStateExists(config);
  const capabilityProbeRequired = hasLoginState && proAvailable === undefined;
  if (capabilityProbeRequired) {
    proAvailable = (await inspectBrowserLoginCapabilities(config)).proAvailable;
  }
  config.proAvailable = proAvailable === true;
  await configureTunnel(config, existing, options);

  // Setup owns the lifecycle for the selected profile. A loaded daemon is interrupted and stopped
  // before tunnel/config replacement so stale browser turns cannot pin the old runtime forever.
  if (beforeService.loaded) await stopService(existing);
  await assertPortAvailable(config.host, config.port);

  saveConfig(config);

  let tunnelReady: boolean | null = null;
  {
    const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    const tunnelService = getTunnelServiceStatus();
    const needsProfile = !existsSync(profilePath);
    const needsTunnelRebind = tunnelAliasNeedsRebind(config);
    const needsOwnershipMigration = !tunnelService.installed || !tunnelService.loaded || !tunnelServiceDefinitionMatches(config);
    if (needsOwnershipMigration || needsProfile || needsTunnelRebind) {
      if (tunnelService.loaded) await stopTunnelService();
      await bootstrapTunnelProfile(config);
      installTunnelService(config);
    } else if (refreshTunnelWorker) {
      await restartTunnelService();
    }
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
    tunnelReady = true;
  }

  installService(config);
  await waitForServiceReady(config);
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    serviceLoaded: getServiceStatus().loaded,
    tunnelReady,
    codexRestartRequired: false,
    connectorSetupRequired: true,
  };
}
