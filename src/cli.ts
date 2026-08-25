#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  bootstrapBrowserLogin,
  browserLoginStateExists,
  checkBrowserEngine,
  defaultBrowserLoginExportPath,
  exportBrowserLoginState,
  importBrowserLoginState,
  logoutBrowserLogin,
} from "./browser-login";
import {
  getConfigPath,
  getProductHome,
  getProfileName,
  listProfiles,
  loadConfig,
  setActiveProfile,
} from "./config";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runChatGptMcpMain } from "./adapters/lca-codex/mcp-main";
import { runCommand } from "./process";
import { PRODUCT_HOME_ENV, PRODUCT_ID, PRODUCT_PROFILE_ENV, SOURCE_CLI_COMMAND, assertProfileName } from "./product";
import { startServer } from "./server";
import { formatStatusReport, runStatus } from "./status";
import {
  cancelBrowserTurns,
  getServiceStatus,
  installService,
  waitForServiceReady,
} from "./service";
import { existingBridgeSetupCredentials, setup, type SetupOptions } from "./setup";
import { installRuntimeKeyBytes, managedRuntimeKeyPath, tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { restartRuntimeStack, startRuntimeStack, stopRuntimeStack } from "./runtime-lifecycle";
import { VERSION } from "./version";
import { apiTokenPath, ensureApiToken, readApiToken, removeApiToken, rotateApiToken } from "./api-auth";
import { runSetupWizard, runTui, tuiSupported } from "./tui";
import { uninstallProfile } from "./uninstall";

const HELP = `${PRODUCT_ID} ${VERSION}

Headless ChatGPT Web runtime for Responses-compatible agent harnesses.

Usage:
  ${SOURCE_CLI_COMMAND}                         Open the interactive Control Center TUI
  ${SOURCE_CLI_COMMAND} tui                     Open the interactive Control Center TUI
  ${SOURCE_CLI_COMMAND} setup                   Open the Setup Wizard TUI in an interactive terminal
  ${SOURCE_CLI_COMMAND} setup --tunnel-id ID --runtime-key-file PATH [options]
  ${SOURCE_CLI_COMMAND} auth <status|login|import|export|logout> [PATH]
  ${SOURCE_CLI_COMMAND} status
  ${SOURCE_CLI_COMMAND} doctor [--json]
  ${SOURCE_CLI_COMMAND} start|stop|restart
  ${SOURCE_CLI_COMMAND} service <status|install|cancel-turns>
  ${SOURCE_CLI_COMMAND} tunnel <status|key-import>
  ${SOURCE_CLI_COMMAND} connector <status|setup>
  ${SOURCE_CLI_COMMAND} api key <status|create|rotate|revoke|path>
  ${SOURCE_CLI_COMMAND} browser check
  ${SOURCE_CLI_COMMAND} profile <show|list|create|use> [NAME]
  ${SOURCE_CLI_COMMAND} config path
  ${SOURCE_CLI_COMMAND} serve
  ${SOURCE_CLI_COMMAND} uninstall --yes

Setup options:
  --port NUMBER                Loopback Responses port (default: 8317)
  --chrome PATH                Chrome/Chromium executable
  --app-name NAME              ChatGPT connector name (default: lca-token)
  --tunnel-id ID               Existing OpenAI tunnel id
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice

Global:
  --home PATH                  Override ~/.lca-token
  --profile NAME               Select an isolated profile (default: active/default)
  -h, --help
  -v, --version

`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(question)).trim(); }
  finally { reader.close(); }
}

async function secretPrompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  stdout.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await reader.question("")).trim(); }
  finally {
    reader.close();
    stdout.write("\n");
  }
}

async function setupCommand(args: string[]): Promise<void> {
  const portRaw = takeOption(args, "--port");
  let acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = { ...(portRaw ? { port: Number(portRaw) } : {}) };
  const appName = takeOption(args, "--app-name");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const chrome = takeOption(args, "--chrome");
  if (chrome) options.chromeExecutablePath = resolve(chrome);
  if (appName) options.appName = appName;
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = resolve(runtimeKeyFile);
  // Legacy setup flags are accepted as no-ops. Setup now always owns daemon restart lifecycle
  // and always enables broker-scoped ChatGPT "Allow once" confirmation clicks.
  takeFlag(args, "--auto-approve-tool-calls");
  takeFlag(args, "--restart-service");
  assertNoArgs(args);

  if (!acknowledged) {
    stdout.write(
      "This is independent, unofficial software. It automates your ChatGPT session, can break when the UI changes, "
      + "and must not be used to evade usage limits or access controls.\n",
    );
    acknowledged = await confirm("Continue and store this acknowledgement?");
  }
  if (!acknowledged) throw new Error("Setup cancelled: acknowledgement was not provided");
  options.acknowledgedUnofficial = true;

  const existing = existsSync(getConfigPath()) ? loadConfig() : undefined;
  const reusableCredentials = existingBridgeSetupCredentials(existing);
  const needsTunnelId = !options.tunnelId && !reusableCredentials.tunnelId;
  const needsRuntimeKey = !options.runtimeKeyFile
    && !reusableCredentials.runtimeKey
    && !existsSync(managedRuntimeKeyPath());
  if ((needsTunnelId || needsRuntimeKey) && stdin.isTTY) {
    stdout.write("The ChatGPT Web bridge needs an OpenAI tunnel and a runtime key with Tunnels Read + Use.\n");
    if (needsTunnelId) options.tunnelId = await prompt("Tunnel id: ");
    if (needsRuntimeKey) options.runtimeKeyValue = await secretPrompt("Runtime key (hidden): ");
  }

  const result = await setup(options);
  const apiToken = ensureApiToken();
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Profile: ${getProfileName()}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  if (apiToken.created) {
    stdout.write("API key (shown once; store it securely):\n");
    stdout.write(`${apiToken.token}\n`);
  }
  if (!browserLoginStateExists(loadConfig())) {
    stdout.write(`ChatGPT session is not configured. Import one with: ${SOURCE_CLI_COMMAND} auth import PATH\n`);
  }
  if (result.connectorSetupRequired) {
    stdout.write("Attach the configured tunnel to the ChatGPT connector once at https://chatgpt.com/#settings/Connectors\n");
  }
}

async function authCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  const config = loadConfig();
  if (action === "status") {
    assertNoArgs(args);
    stdout.write(`${JSON.stringify({ profile: getProfileName(), authenticated: browserLoginStateExists(config), storageStatePath: config.storageStatePath }, null, 2)}\n`);
    return;
  }
  if (action === "login") {
    assertNoArgs(args);
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("auth login requires an interactive terminal");
    stdout.write("Opening a dedicated LCA Token Chrome profile. Sign in to ChatGPT there and leave that Chrome window open.\n");
    stdout.write("Your normal Chrome profile is not used. When ChatGPT is ready, return here and press Enter; LCA Token will close only that dedicated Chrome window, then verify its isolated profile in a background Chrome renderer.\n");
    const result = await bootstrapBrowserLogin(config, {
      waitForLoginCompletion: async () => {
        await prompt("After ChatGPT is signed in and the composer is visible, press Enter here to verify: ");
        stdout.write("Closing the dedicated Chrome window, then verifying its isolated profile in background Chrome…\n");
      },
    });
    stdout.write(`ChatGPT login verified and stored at ${result.storageStatePath}\n`);
    return;
  }
  if (action === "import") {
    const path = args.shift();
    assertNoArgs(args);
    if (!path) throw new Error("auth import requires a storage-state JSON path");
    const result = await importBrowserLoginState(config, resolve(path));
    stdout.write(`ChatGPT login imported and verified at ${result.storageStatePath}\n`);
    return;
  }
  if (action === "export") {
    const path = args.shift();
    assertNoArgs(args);
    const destination = path ? resolve(path) : defaultBrowserLoginExportPath(config);
    exportBrowserLoginState(config, destination);
    stdout.write(`ChatGPT storage state exported to ${destination}\n`);
    return;
  }
  if (action === "logout") {
    assertNoArgs(args);
    logoutBrowserLogin(config);
    stdout.write("ChatGPT login state removed for this profile.\n");
    return;
  }
  throw new Error("Auth command must be: status, login, import, export, or logout");
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function statusCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runStatus();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatStatusReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "start" || action === "restart" || action === "stop") {
    await runtimeLifecycleCommand([action]);
    return;
  }
  const config = action === "status" ? undefined : loadConfig();
  if (action === "cancel-turns") {
    const cancelled = await cancelBrowserTurns(config!);
    stdout.write(`${JSON.stringify({ cancelledBrowserTurns: cancelled }, null, 2)}\n`);
    return;
  }
  let status;
  if (action === "status") status = getServiceStatus();
  else if (action === "install") {
    installService(config!);
    await waitForServiceReady(config!);
    status = getServiceStatus();
  }
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function runtimeLifecycleCommand(args: string[]): Promise<void> {
  const action = args.shift();
  assertNoArgs(args);
  if (action !== "start" && action !== "restart" && action !== "stop") {
    throw new Error("Runtime lifecycle command must be: start, restart, or stop");
  }
  const config = loadConfig();
  const status = action === "start"
    ? await startRuntimeStack(config)
    : action === "restart"
      ? await restartRuntimeStack(config)
      : await stopRuntimeStack(config);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function tunnelCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "start" || action === "restart" || action === "stop") {
    await runtimeLifecycleCommand([action]);
    return;
  }
  if (action === "key-import") {
    const key = await secretPrompt("Runtime key (hidden): ");
    if (!key) throw new Error("A non-empty runtime key is required");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}\n`);
    return;
  }
  const config = loadConfig();
  if (action !== "status") throw new Error(`Unknown tunnel action: ${action}`);
  const status = tunnelStatus(config);
  const service = getTunnelServiceStatus();
  stdout.write(`${JSON.stringify({ service, runtime: status }, null, 2)}\n`);
  if (!service.running || !status.ok) process.exitCode = 1;
}

function connectorCommand(args: string[]): void {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = loadConfig();
  if (action === "setup") {
    stdout.write("Open https://chatgpt.com/#settings/Connectors and attach the tunnel to this connector:\n");
    stdout.write(`${config.appName}\n`);
    return;
  }
  if (action === "status") {
    stdout.write(`${JSON.stringify({ connector: config.appName, tunnelAlias: config.tunnel?.alias ?? null }, null, 2)}\n`);
    return;
  }
  throw new Error("Connector command must be: status or setup");
}

function profileCommand(args: string[]): void {
  const action = args.shift() ?? "show";
  if (action === "show") {
    assertNoArgs(args);
    stdout.write(`${getProfileName()}\n`);
    return;
  }
  if (action === "list") {
    assertNoArgs(args);
    const active = getProfileName();
    for (const profile of listProfiles()) stdout.write(`${profile === active ? "*" : " "} ${profile}\n`);
    return;
  }
  if (action === "create") {
    const name = args.shift();
    assertNoArgs(args);
    if (!name) throw new Error("profile create requires NAME");
    const profile = assertProfileName(name);
    mkdirSync(join(getProductHome(), "profiles", profile), { recursive: true, mode: 0o700 });
    stdout.write(`Created profile ${profile}\n`);
    return;
  }
  if (action === "use") {
    const name = args.shift();
    assertNoArgs(args);
    if (!name) throw new Error("profile use requires NAME");
    const profile = setActiveProfile(name);
    stdout.write(`Active profile: ${profile}\n`);
    return;
  }
  throw new Error("Profile command must be: show, list, create, or use");
}

function apiCommand(args: string[]): void {
  const resource = args.shift();
  const action = args.shift();
  assertNoArgs(args);
  if ((resource !== "key" && resource !== "token") || !action) throw new Error("API command must be: api key status|create|rotate|revoke|path");
  if (action === "status") {
    stdout.write(`${JSON.stringify({ configured: Boolean(readApiToken()), path: apiTokenPath() }, null, 2)}\n`);
    return;
  }
  if (action === "path") {
    stdout.write(`${apiTokenPath()}\n`);
    return;
  }
  if (action === "create") {
    const result = ensureApiToken();
    if (!result.created) {
      stdout.write(`API key already exists at ${apiTokenPath()}; rotate it to receive a new value.\n`);
      return;
    }
    stdout.write(`${result.token}\n`);
    return;
  }
  if (action === "rotate") {
    stdout.write(`${rotateApiToken()}\n`);
    return;
  }
  if (action === "revoke") {
    removeApiToken();
    stdout.write("API key revoked for this profile.\n");
    return;
  }
  throw new Error("API command must be: api key status|create|rotate|revoke|path");
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  assertNoArgs(args);
  if (!yes && !await confirm(`Stop services and remove ${PRODUCT_ID} profile ${getProfileName()}?`)) {
    throw new Error("Uninstall cancelled");
  }
  await uninstallProfile({ keepData });
  stdout.write(keepData ? "Uninstalled; private profile data was preserved.\n" : "Uninstalled and removed private profile data.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  const profile = takeOption(args, "--profile");
  if (home) process.env[PRODUCT_HOME_ENV] = resolve(home);
  if (profile) process.env[PRODUCT_PROFILE_ENV] = assertProfileName(profile);
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  const command = args.shift();
  if (!command) {
    if (tuiSupported()) await runTui();
    else stdout.write(HELP);
    return;
  }
  if (command === "help") stdout.write(HELP);
  else if (command === "tui") {
    assertNoArgs(args);
    await runTui();
  }
  else if (command === "setup" && args.length === 0 && tuiSupported()) await runSetupWizard();
  else if (command === "setup") await setupCommand(args);
  else if (command === "auth") await authCommand(args);
  else if (command === "status") await statusCommand(args);
  else if (command === "doctor") await doctorCommand(args);
  else if (command === "start" || command === "stop" || command === "restart") await runtimeLifecycleCommand([command, ...args]);
  else if (command === "service") await serviceCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "connector") connectorCommand(args);
  else if (command === "api") apiCommand(args);
  else if (command === "profile") profileCommand(args);
  else if (command === "config") {
    const action = args.shift();
    assertNoArgs(args);
    if (action !== "path") throw new Error("Config command must be: config path");
    stdout.write(`${getConfigPath()}\n`);
  } else if (command === "browser") {
    const action = args.shift();
    assertNoArgs(args);
    if (action !== "check") throw new Error("Browser command must be: browser check");
    await checkBrowserEngine(loadConfig());
    stdout.write("Playwright can launch the configured Chrome/Chromium executable.\n");
  } else if (command === "serve") {
    assertNoArgs(args);
    const config = loadConfig();
    const server = startServer(config);
    stdout.write(`${PRODUCT_ID} ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`);
    await new Promise<void>(() => {});
  } else if (command === "mcp") await runChatGptMcpMain(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else if (command === "open") {
    const target = args.shift();
    assertNoArgs(args);
    const urls: Record<string, string> = {
      tunnels: "https://platform.openai.com/settings/organization/tunnels",
      "runtime-keys": "https://platform.openai.com/settings/organization/api-keys",
      connectors: "https://chatgpt.com/#settings/Connectors",
    };
    const url = target ? urls[target] : undefined;
    if (!url) throw new Error("Choose one of: tunnels, runtime-keys, connectors");
    if (process.platform === "darwin") {
      const result = runCommand("open", [url]);
      if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
    } else stdout.write(`${url}\n`);
  } else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`${PRODUCT_ID}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
