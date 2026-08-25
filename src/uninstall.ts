import { existsSync, rmSync } from "node:fs";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { getServiceStatus, stopService, uninstallService } from "./service";
import { stopTunnel } from "./tunnel";
import { getTunnelServiceStatus, uninstallTunnelService } from "./tunnel-service";

export async function uninstallProfile({ keepData = false }: { keepData?: boolean } = {}): Promise<void> {
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  if (config) {
    const service = getServiceStatus();
    if (service.supported && service.loaded) await stopService(config);
    const tunnelService = getTunnelServiceStatus();
    if (tunnelService.supported && (tunnelService.installed || tunnelService.loaded)) await uninstallTunnelService();
    if (config.tunnel) stopTunnel(config);
    if (service.supported && service.installed) await uninstallService(config);
  }
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
}
