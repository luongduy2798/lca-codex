import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir, getProductHome, getProfileName } from "./config";
import { runCommand, runChecked } from "./process";
import { PRODUCT_HOME_ENV, PRODUCT_ID, PRODUCT_PROFILE_ENV } from "./product";

function label(): string {
  return `io.github.luongduy2798.${PRODUCT_ID}.${getProfileName()}.daemon`;
}

function systemdUnitName(): string {
  return `${PRODUCT_ID}-${getProfileName()}.service`;
}

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
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

async function bootstrapService(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown launchctl bootstrap failure";
  while (Date.now() < deadline) {
    const result = runCommand("launchctl", ["bootstrap", launchDomain(), path]);
    if (result.status === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`launchctl bootstrap ${launchDomain()} ${path} failed after ${timeoutMs}ms: ${lastError}`);
}

async function waitForServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getServiceStatus().loaded) throw new Error(`service did not stop ${label()} after ${timeoutMs}ms`);
}

function plist(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = [...config.runtimeCommand, "serve"];
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
  <string>${xml(join(logDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "daemon.stderr.log"))}</string>
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

function systemd(config: AppConfig): string {
  const args = [
    "/usr/bin/env",
    "xvfb-run",
    "-a",
    "-s",
    "-screen 0 1440x1000x24 -nolisten tcp",
    ...config.runtimeCommand,
    "serve",
  ].map(systemdQuote).join(" ");
  return `[Unit]
Description=LCA Token background Responses runtime (${getProfileName()})
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

export function serviceDefinition(config: AppConfig, platform = process.platform): string {
  if (platform === "darwin") return plist(config);
  if (platform === "linux") return systemd(config);
  throw new Error(`Managed background services are not supported on ${platform}`);
}

function assertSupported(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Managed background services are not supported on ${process.platform}; run ${PRODUCT_ID} serve directly`);
  }
}

export function getServiceStatus(): ServiceStatus {
  if (process.platform === "darwin") {
    const path = plistPath();
    const result = runCommand("launchctl", ["print", serviceTarget()]);
    return { supported: true, installed: existsSync(path), loaded: result.status === 0, label: label(), definitionPath: path };
  }
  if (process.platform === "linux") {
    const path = systemdPath();
    const result = runCommand("systemctl", ["--user", "is-active", systemdUnitName()]);
    return { supported: true, installed: existsSync(path), loaded: result.status === 0, label: systemdUnitName(), definitionPath: path };
  }
  return { supported: false, installed: false, loaded: false, label: label() };
}

export function installService(config: AppConfig): ServiceStatus {
  assertSupported();
  assertDurableRuntimeCommand(config.runtimeCommand);
  const path = process.platform === "darwin" ? plistPath() : systemdPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = serviceDefinition(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getServiceStatus();
  if (process.platform === "darwin") {
    if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  } else {
    runChecked("systemctl", ["--user", "daemon-reload"]);
    if (!status.loaded) runChecked("systemctl", ["--user", "enable", "--now", systemdUnitName()]);
  }
  return getServiceStatus();
}

export function serviceHealthIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === PRODUCT_ID
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true
    && health.broker_ready === true;
}

export async function waitForServiceReady(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (serviceHealthIsReady(body, config)) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Responses proxy did not become ready after service start: ${lastError}`);
}

export async function startService(config: AppConfig): Promise<ServiceStatus> {
  assertSupported();
  const path = process.platform === "darwin" ? plistPath() : systemdPath();
  if (!existsSync(path)) throw new Error(`Service is not installed: ${path}`);
  const status = getServiceStatus();
  if (!status.loaded) {
    if (process.platform === "darwin") runChecked("launchctl", ["bootstrap", launchDomain(), path]);
    else runChecked("systemctl", ["--user", "start", systemdUnitName()]);
  }
  await waitForServiceReady(config);
  return getServiceStatus();
}

export interface DrainLease {
  release: () => Promise<void>;
}

async function control(config: AppConfig, action: "drain" | "resume" | "cancel-browser-turns"): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

type LifecycleControl = (action: "drain" | "cancel-browser-turns") => Promise<Record<string, unknown>>;

export async function interruptServiceTurns(controlAction: LifecycleControl): Promise<number> {
  // Lifecycle commands are authoritative. Drain/cancel is the graceful path, but a stale
  // control endpoint must never prevent the service manager from terminating the daemon.
  try {
    await controlAction("drain");
  } catch {
    // The hard service stop below is still authoritative and will terminate active HTTP/browser work.
  }
  try {
    const result = await controlAction("cancel-browser-turns");
    const cancelled = result.cancelled_browser_turns;
    return Number.isInteger(cancelled) && (cancelled as number) >= 0 ? cancelled as number : 0;
  } catch {
    return 0;
  }
}

export async function cancelBrowserTurns(config: AppConfig): Promise<number> {
  const result = await control(config, "cancel-browser-turns");
  const cancelled = result.cancelled_browser_turns;
  if (!Number.isInteger(cancelled) || (cancelled as number) < 0) {
    throw new Error("daemon did not acknowledge browser-turn cancellation");
  }
  return cancelled as number;
}

export async function negotiateDrain(
  controlAction: (action: "drain" | "resume") => Promise<Record<string, unknown>>,
): Promise<DrainLease> {
  let drained = false;
  let drainAttempted = false;
  try {
    drainAttempted = true;
    const health = await controlAction("drain");
    drained = true;
    const activeHttp = health.active_http_turns;
    const activeBrowser = health.active_browser_turns;
    if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser) || health.accepting_turns !== false) {
      throw new Error("daemon did not acknowledge the drain contract");
    }
    if ((activeHttp as number) > 0 || (activeBrowser as number) > 0) {
      throw new Error(`daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`);
    }
    return { release: async () => { if (drained) { await controlAction("resume"); drained = false; } } };
  } catch (error) {
    let resumeError: unknown;
    if (drainAttempted) {
      try {
        await controlAction("resume");
        drained = false;
      } catch (caught) {
        resumeError = caught;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const compensation = resumeError
      ? `; compensating resume also failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`
      : "";
    throw new Error(`Refusing to stop or restart because atomic idleness could not be proven: ${message}${compensation}`);
  }
}

async function acquireDrain(config: AppConfig): Promise<DrainLease> {
  if (!getServiceStatus().loaded) return { release: async () => {} };
  return negotiateDrain(action => control(config, action));
}

async function interruptLoadedService(config?: AppConfig): Promise<void> {
  if (!getServiceStatus().loaded || !config) return;
  await interruptServiceTurns(action => control(config, action));
}

export async function assertServiceIdle(config: AppConfig): Promise<void> {
  const lease = await acquireDrain(config);
  await lease.release();
}

export async function restartService(config: AppConfig, runningConfig: AppConfig = config): Promise<ServiceStatus> {
  assertSupported();
  if (!getServiceStatus().loaded) return startService(config);
  await interruptLoadedService(runningConfig);
  if (process.platform === "darwin") {
    runChecked("launchctl", ["bootout", serviceTarget()]);
    await waitForServiceUnloaded();
    await bootstrapService(plistPath());
  } else {
    runChecked("systemctl", ["--user", "restart", systemdUnitName()]);
  }
  await waitForServiceReady(config);
  return getServiceStatus();
}

export async function stopService(config?: AppConfig): Promise<ServiceStatus> {
  assertSupported();
  if (getServiceStatus().loaded) {
    await interruptLoadedService(config);
    if (process.platform === "darwin") runChecked("launchctl", ["bootout", serviceTarget()]);
    else runChecked("systemctl", ["--user", "stop", systemdUnitName()]);
    await waitForServiceUnloaded();
  }
  return getServiceStatus();
}

export async function uninstallService(config: AppConfig): Promise<ServiceStatus> {
  assertSupported();
  if (getServiceStatus().loaded) {
    await interruptLoadedService(config);
    if (process.platform === "darwin") runChecked("launchctl", ["bootout", serviceTarget()]);
    else runChecked("systemctl", ["--user", "disable", "--now", systemdUnitName()]);
    await waitForServiceUnloaded();
  }
  rmSync(process.platform === "darwin" ? plistPath() : systemdPath(), { force: true });
  if (process.platform === "linux") runChecked("systemctl", ["--user", "daemon-reload"]);
  return getServiceStatus();
}
