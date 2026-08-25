import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir, getProductHome, getProfileName } from "./config";
import { runCommand, runChecked } from "./process";
import { PRODUCT_HOME_ENV, PRODUCT_ID, PRODUCT_PROFILE_ENV } from "./product";

function label(): string {
  return `io.github.luongduy2798.${PRODUCT_ID}.${getProfileName()}.tunnel`;
}

function systemdUnitName(): string {
  return `${PRODUCT_ID}-${getProfileName()}-tunnel.service`;
}

export interface TunnelServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  definitionPath?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${label()}.plist`);
}

function systemdPath(): string {
  return join(homedir(), ".config", "systemd", "user", systemdUnitName());
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${launchDomain()}/${label()}`;
}

function settings(config: AppConfig) {
  if (!config.tunnel) throw new Error("The ChatGPT Web bridge requires tunnel configuration");
  return config.tunnel;
}

function assertSupported(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Managed tunnel service installation is not supported on ${process.platform}`);
  }
}

export function tunnelServiceDefinition(config: AppConfig): string {
  const tunnel = settings(config);
  const logDir = join(getConfigDir(), "logs");
  const args = [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label()}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${PRODUCT_HOME_ENV}</key>
    <string>${xml(getProductHome())}</string>
    <key>${PRODUCT_PROFILE_ENV}</key>
    <string>${xml(getProfileName())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "tunnel.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "tunnel.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%")}"`;
}

export function tunnelSystemdServiceDefinition(config: AppConfig): string {
  const tunnel = settings(config);
  const args = [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=LCA Token tunnel runtime (${getProfileName()})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args}
Environment=${systemdQuote(`${PRODUCT_HOME_ENV}=${getProductHome()}`)}
Environment=${systemdQuote(`${PRODUCT_PROFILE_ENV}=${getProfileName()}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function tunnelServiceDefinitionForPlatform(config: AppConfig, platform = process.platform): string {
  if (platform === "darwin") return tunnelServiceDefinition(config);
  if (platform === "linux") return tunnelSystemdServiceDefinition(config);
  throw new Error(`Managed tunnel service installation is not supported on ${platform}`);
}

export function getTunnelServiceStatus(): TunnelServiceStatus {
  if (process.platform === "linux") {
    const path = systemdPath();
    const result = runCommand("systemctl", ["--user", "is-active", systemdUnitName()]);
    return {
      supported: true,
      installed: existsSync(path),
      loaded: result.status === 0,
      running: result.status === 0,
      label: systemdUnitName(),
      definitionPath: path,
    };
  }
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, running: false, label: label() };
  }
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: label(),
    definitionPath: path,
  };
}

export function tunnelServiceDefinitionMatches(config: AppConfig): boolean {
  const path = process.platform === "darwin" ? plistPath() : systemdPath();
  return existsSync(path) && readFileSync(path, "utf8") === tunnelServiceDefinitionForPlatform(config);
}

export function installTunnelService(config: AppConfig): TunnelServiceStatus {
  assertSupported();
  const tunnel = settings(config);
  const profile = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
  if (!existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
  if (!existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
  const current = getTunnelServiceStatus();
  const path = process.platform === "darwin" ? plistPath() : systemdPath();
  const next = tunnelServiceDefinitionForPlatform(config);
  if (current.loaded && (!current.installed || readFileSync(path, "utf8") !== next)) {
    throw new Error("Refusing to replace a loaded tunnel service definition; stop it before installing the update");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  if (!current.installed || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  if (process.platform === "darwin") {
    if (!current.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  } else {
    runChecked("systemctl", ["--user", "daemon-reload"]);
    if (!current.loaded) runChecked("systemctl", ["--user", "enable", "--now", systemdUnitName()]);
  }
  return getTunnelServiceStatus();
}

export function startTunnelService(): TunnelServiceStatus {
  assertSupported();
  const path = process.platform === "darwin" ? plistPath() : systemdPath();
  if (!existsSync(path)) throw new Error("Tunnel service is not installed; rerun full setup");
  if (!getTunnelServiceStatus().loaded) {
    if (process.platform === "darwin") runChecked("launchctl", ["bootstrap", launchDomain(), path]);
    else runChecked("systemctl", ["--user", "start", systemdUnitName()]);
  }
  return getTunnelServiceStatus();
}

async function waitForTunnelServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getTunnelServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getTunnelServiceStatus().loaded) throw new Error(`tunnel service did not stop ${label()} after ${timeoutMs}ms`);
}

export async function stopTunnelService(): Promise<TunnelServiceStatus> {
  assertSupported();
  if (getTunnelServiceStatus().loaded) {
    if (process.platform === "darwin") runChecked("launchctl", ["bootout", serviceTarget()]);
    else runChecked("systemctl", ["--user", "stop", systemdUnitName()]);
    await waitForTunnelServiceUnloaded();
  }
  return getTunnelServiceStatus();
}

export async function restartTunnelService(): Promise<TunnelServiceStatus> {
  await stopTunnelService();
  return startTunnelService();
}

export async function uninstallTunnelService(): Promise<TunnelServiceStatus> {
  assertSupported();
  await stopTunnelService();
  if (process.platform === "linux") runCommand("systemctl", ["--user", "disable", systemdUnitName()]);
  rmSync(process.platform === "darwin" ? plistPath() : systemdPath(), { force: true });
  if (process.platform === "linux") runChecked("systemctl", ["--user", "daemon-reload"]);
  return getTunnelServiceStatus();
}
