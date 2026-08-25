import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync } from "node:fs";
import { Writable } from "node:stream";
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
  defaultChromeExecutable,
  expandUserPath,
  getConfigPath,
  getProductHome,
  getProfileName,
  listProfiles,
  loadConfig,
  setActiveProfile,
} from "./config";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runCommand } from "./process";
import {
  DEFAULT_PORT,
  PRODUCT_DISPLAY_NAME,
  PRODUCT_ID,
  PRODUCT_PROFILE_ENV,
  assertProfileName,
} from "./product";
import {
  cancelBrowserTurns,
  getServiceStatus,
} from "./service";
import { existingBridgeSetupCredentials, setup, type SetupOptions } from "./setup";
import {
  installRuntimeKeyBytes,
  managedRuntimeKeyPath,
  tunnelStatus,
} from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { restartRuntimeStack, startRuntimeStack, stopRuntimeStack } from "./runtime-lifecycle";
import { apiTokenPath, ensureApiToken, readApiToken, removeApiToken, rotateApiToken } from "./api-auth";
import { uninstallProfile } from "./uninstall";
import { VERSION } from "./version";

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";

interface MenuItem<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

class TuiExit extends Error {}

export function tuiSupported(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true && typeof stdin.setRawMode === "function";
}

function styled(value: string, code: string): string {
  if (process.env.NO_COLOR !== undefined) return value;
  return `${code}${value}${RESET}`;
}

function renderScreen(title: string, body: string[] = []): void {
  stdout.write(CLEAR);
  stdout.write(`${styled(`${PRODUCT_DISPLAY_NAME} ${VERSION}`, BOLD)}\n`);
  stdout.write(`${styled(title, BOLD)}\n`);
  if (body.length > 0) stdout.write(`\n${body.join("\n")}\n`);
}

async function readKey(): Promise<{ name?: string; ctrl?: boolean; sequence?: string }> {
  return await new Promise(resolveKey => {
    const listener = (sequence: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      stdin.off("keypress", listener);
      resolveKey({ ...key, sequence: key.sequence ?? sequence });
    };
    stdin.on("keypress", listener);
  });
}

async function selectMenu<T extends string>(
  title: string,
  items: MenuItem<T>[],
  body: string[] = [],
  initialValue?: T,
): Promise<T | undefined> {
  if (!tuiSupported()) throw new Error("The TUI requires an interactive terminal");
  if (items.length === 0) return undefined;
  let index = Math.max(0, initialValue ? items.findIndex(item => item.value === initialValue) : 0);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(HIDE_CURSOR);
  try {
    while (true) {
      renderScreen(title, body);
      stdout.write("\n");
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex]!;
        const selected = itemIndex === index;
        const marker = selected ? "❯" : " ";
        const label = selected ? styled(` ${item.label} `, REVERSE) : item.label;
        stdout.write(`${marker} ${label}${item.detail ? ` ${styled(item.detail, DIM)}` : ""}\n`);
      }
      stdout.write(`\n${styled("↑/↓ move  Enter select  Esc/q back", DIM)}\n`);
      const key = await readKey();
      if (key.ctrl && key.name === "c") throw new TuiExit();
      if (key.name === "up" || key.sequence === "k") index = (index - 1 + items.length) % items.length;
      else if (key.name === "down" || key.sequence === "j") index = (index + 1) % items.length;
      else if (key.name === "home") index = 0;
      else if (key.name === "end") index = items.length - 1;
      else if (key.name === "return" || key.name === "enter") return items[index]!.value;
      else if (key.name === "escape" || key.sequence === "q") return undefined;
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(SHOW_CURSOR);
  }
}

async function linePrompt(question: string, defaultValue?: string): Promise<string> {
  if (!tuiSupported()) throw new Error("The TUI requires an interactive terminal");
  stdout.write(SHOW_CURSOR);
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` ${styled(`[${defaultValue}]`, DIM)}` : "";
    const answer = (await reader.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    reader.close();
  }
}

async function hiddenPrompt(question: string): Promise<string> {
  if (!tuiSupported()) throw new Error("The TUI requires an interactive terminal");
  stdout.write(SHOW_CURSOR);
  stdout.write(`${question}: `);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try {
    return (await reader.question("")).trim();
  } finally {
    reader.close();
    stdout.write("\n");
  }
}

async function pause(message = "Press Enter to continue"): Promise<void> {
  await linePrompt(message);
}

async function yesNo(title: string, body: string[], defaultYes = false): Promise<boolean> {
  const value = await selectMenu(title, [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ], body, defaultYes ? "yes" : "no");
  return value === "yes";
}

function safeConfig() {
  if (!existsSync(getConfigPath())) return undefined;
  try { return loadConfig(); } catch { return undefined; }
}

function statusLabel(ok: boolean, yes: string, no: string): string {
  return ok ? `✓ ${yes}` : `· ${no}`;
}

export function tuiOverviewLines(): string[] {
  const config = safeConfig();
  const service = getServiceStatus();
  const tunnelService = getTunnelServiceStatus();
  return [
    `Profile        ${getProfileName()}`,
    `Configuration  ${statusLabel(Boolean(config), "ready", "not configured")}`,
    `Daemon         ${statusLabel(service.loaded, "running", service.installed ? "stopped" : "not installed")}`,
    `Tunnel         ${statusLabel(tunnelService.running, "running", tunnelService.installed ? "stopped" : "not installed")}`,
    `ChatGPT auth   ${statusLabel(Boolean(config && browserLoginStateExists(config)), "verified", "not configured")}`,
    `API key        ${statusLabel(Boolean(readApiToken()), "configured", "missing")}`,
    `Endpoint       ${config ? `http://${config.host}:${config.port}/v1/agent` : `127.0.0.1:${DEFAULT_PORT}`}`,
  ];
}

async function chooseSetupProfile(): Promise<void> {
  const pinned = process.env[PRODUCT_PROFILE_ENV]?.trim();
  if (pinned) {
    renderScreen("Setup Wizard · Profile", [
      `This process is pinned to profile ${JSON.stringify(getProfileName())} by ${PRODUCT_PROFILE_ENV}.`,
      "The wizard will configure that profile.",
    ]);
    await pause();
    return;
  }

  const active = getProfileName();
  const profiles = listProfiles();
  const items: MenuItem<string>[] = profiles.map(profile => ({
    value: profile,
    label: profile === active ? `${profile} (active)` : profile,
  }));
  items.push({ value: "__create__", label: "Create a new profile" });
  const selected = await selectMenu("Setup Wizard · Profile", items, [
    "Each profile has isolated browser state, API credentials, tunnel state, and services.",
  ], profiles.includes(active) ? active : "__create__");
  if (!selected) throw new TuiExit();
  if (selected === "__create__") {
    const name = assertProfileName(await linePrompt("New profile name", active));
    mkdirSync(join(getProductHome(), "profiles", name), { recursive: true, mode: 0o700 });
    setActiveProfile(name);
    return;
  }
  setActiveProfile(selected);
}

function assertTunnelId(value: string): string {
  if (!/^tunnel_[a-f0-9]{32}$/.test(value)) throw new Error("Tunnel id must match tunnel_<32 lowercase hex characters>");
  return value;
}

function assertPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be an integer from 1 to 65535");
  return port;
}

async function runtimeKeyOptions(existingRuntimeKey: boolean): Promise<Pick<SetupOptions, "runtimeKeyFile" | "runtimeKeyValue">> {
  const choices: MenuItem<"reuse" | "paste" | "file">[] = [
    ...(existingRuntimeKey ? [{ value: "reuse" as const, label: "Reuse the existing private runtime key" }] : []),
    { value: "paste", label: "Paste a runtime key", detail: "hidden input" },
    { value: "file", label: "Import a runtime key from a file" },
  ];
  const choice = await selectMenu("Setup Wizard · Tunnel credential", choices, [
    "Use a runtime key with only the tunnel permissions required by LCA Token.",
    "The key is copied into profile-private storage and is never shown again by the TUI.",
  ], existingRuntimeKey ? "reuse" : "paste");
  if (!choice) throw new TuiExit();
  if (choice === "reuse") return {};
  if (choice === "paste") {
    const value = await hiddenPrompt("Runtime key (hidden)");
    if (!value) throw new Error("Runtime key cannot be empty");
    return { runtimeKeyValue: value };
  }
  const path = resolve(await linePrompt("Runtime key file path"));
  if (!existsSync(path)) throw new Error(`Runtime key file does not exist: ${path}`);
  return { runtimeKeyFile: path };
}

async function setupWizard(): Promise<void> {
  if (!tuiSupported()) throw new Error("The setup wizard requires an interactive terminal");
  await chooseSetupProfile();

  const existing = safeConfig();
  if (!existing?.acknowledgedUnofficialAt) {
    const acknowledged = await yesNo("Setup Wizard · Unofficial software", [
      "LCA Token automates your ChatGPT Web session and can break when the UI changes.",
      "It must not be used to evade usage limits or access controls.",
      "Continue and store this acknowledgement?",
    ]);
    if (!acknowledged) throw new TuiExit();
  }

  renderScreen("Setup Wizard · Runtime", ["Configure the loopback runtime. Defaults are safe for a local agent harness."]);
  const port = assertPort(await linePrompt("Responses port", String(existing?.port ?? DEFAULT_PORT)));
  const appName = await linePrompt("ChatGPT connector name", existing?.appName ?? PRODUCT_ID);
  if (!appName || appName.length > 80) throw new Error("Connector name must be 1-80 characters");
  const chromeExecutablePath = resolve(expandUserPath(await linePrompt(
    "Chrome/Chromium executable",
    existing?.chromeExecutablePath ?? defaultChromeExecutable(),
  )));

  renderScreen("Setup Wizard · Tunnel", [
    "LCA Token uses an outbound OpenAI tunnel for the ChatGPT connector bridge.",
    "No public inbound listener is created.",
  ]);
  const tunnelId = assertTunnelId(await linePrompt("Tunnel id", existing?.tunnel?.tunnelId));
  const reusable = existingBridgeSetupCredentials(existing);
  const hasManagedRuntimeKey = reusable.runtimeKey
    || (!existing?.tunnel?.runtimeKeyFile && existsSync(managedRuntimeKeyPath()));
  const runtimeKey = await runtimeKeyOptions(hasManagedRuntimeKey);

  const summary = [
    `Profile: ${getProfileName()}`,
    `Endpoint: http://127.0.0.1:${port}/v1/agent`,
    `Connector: ${appName}`,
    `Chrome: ${chromeExecutablePath}`,
    `Tunnel: ${tunnelId}`,
    `Runtime key: ${Object.keys(runtimeKey).length > 0 ? "replace/import" : "reuse existing"}`,
    `ChatGPT auth: ${existing && browserLoginStateExists(existing) ? "verified state already present" : "login/import required"}`,
    "Auto-approve Allow once: enabled (broker-scoped)",
    "Loaded daemon: active turns will be interrupted and the runtime will be restarted automatically",
  ];
  renderScreen("Setup Wizard · Applying", [
    ...summary,
    "",
    "Applying this profile configuration now. Runtime success is reported only after daemon and tunnel readiness are verified.",
  ]);
  const result = await setup({
    port,
    appName,
    chromeExecutablePath,
    tunnelId,
    ...runtimeKey,
    acknowledgedUnofficial: true,
  });
  const apiToken = ensureApiToken();

  const done = [
    "✓ Setup complete",
    `Profile: ${getProfileName()}`,
    `Config: ${result.configPath}`,
    `Daemon: ${result.serviceLoaded ? "running" : "not running"}`,
    `Tunnel: ${result.tunnelReady ? "ready" : "not verified"}`,
  ];
  if (apiToken.created) {
    done.push("", "API key — shown once; store it securely:", apiToken.token);
  } else {
    done.push("", `API key already configured at ${apiTokenPath()}. Existing key value was not displayed.`);
  }
  if (!browserLoginStateExists(loadConfig())) done.push("", "ChatGPT auth is still missing. Open ChatGPT authentication in the Control Center and choose Login to ChatGPT, or import a verified storage-state file.");
  if (result.connectorSetupRequired) done.push("", "Attach this tunnel to the ChatGPT connector once from Settings → Connectors.");
  renderScreen("Setup Wizard · Complete", done);
  await pause();
}

export async function runSetupWizard(): Promise<void> {
  try {
    await setupWizard();
  } catch (error) {
    if (!(error instanceof TuiExit)) throw error;
  }
}

async function authMenu(): Promise<void> {
  const config = safeConfig();
  if (!config) {
    renderScreen("ChatGPT authentication", ["No valid configuration exists. Run Setup Wizard first."]);
    await pause();
    return;
  }
  const action = await selectMenu("ChatGPT authentication", [
    { value: "login", label: "Login to ChatGPT", detail: "isolated LCA Token Chrome profile" },
    { value: "import", label: "Import and verify storage state", detail: "for another trusted machine/server" },
    { value: "export", label: "Export storage state", detail: "sensitive credential" },
    { value: "logout", label: "Logout / remove stored session" },
  ], [statusLabel(browserLoginStateExists(config), "Verified session is configured", "No verified session is configured")]);
  if (!action) return;
  renderScreen("ChatGPT authentication");
  if (action === "login") {
    if (browserLoginStateExists(config) && !await yesNo("Replace the current ChatGPT session?", [
      "The existing verified session remains active unless the new login is verified successfully.",
      "Continue with a new isolated login profile?",
    ])) return;
    renderScreen("ChatGPT login", [
      "LCA Token will open a dedicated Chrome profile that is separate from your normal browser profile.",
      "Sign in to ChatGPT in that Chrome window and leave it open when the ChatGPT composer is visible.",
      "Then return to this terminal and press Enter. LCA Token will close only that dedicated Chrome window,",
      "verify the isolated profile in a background Chrome renderer,",
      "save portable storage state for this LCA Token profile, and remove the temporary login profile.",
    ]);
    await pause("Press Enter to open Chrome");
    const result = await bootstrapBrowserLogin(config, {
      waitForLoginCompletion: async () => {
        renderScreen("ChatGPT login", [
          "Finish signing in inside the dedicated Chrome window.",
          "When ChatGPT is ready and the composer is visible, return here.",
          "Do not close Chrome yourself; after Enter, LCA Token closes only its temporary window and verifies the isolated profile in background Chrome.",
        ]);
        await pause("Press Enter to close Chrome and verify");
        renderScreen("ChatGPT login", ["Closing the dedicated Chrome window, then verifying its isolated profile in background Chrome…"]);
      },
    });
    stdout.write(`ChatGPT login verified and stored at ${result.storageStatePath}\n`);
  } else if (action === "import") {
    const source = resolve(expandUserPath(await linePrompt("Storage-state JSON path")));
    const result = await importBrowserLoginState(config, source);
    stdout.write(`Imported and verified at ${result.storageStatePath}\n`);
  } else if (action === "export") {
    const destination = resolve(expandUserPath(await linePrompt(
      "Export destination",
      defaultBrowserLoginExportPath(config),
    )));
    exportBrowserLoginState(config, destination);
    stdout.write(`Exported sensitive storage state to ${destination}\n`);
  } else if (await yesNo("Remove ChatGPT session?", ["This removes the stored browser login state for the active profile."])) {
    logoutBrowserLogin(config);
    stdout.write("ChatGPT login state removed.\n");
  }
  await pause();
}

async function runtimeMenu(): Promise<void> {
  const config = safeConfig();
  if (!config) {
    renderScreen("Runtime stack", ["No valid configuration exists. Run Setup Wizard first."]);
    await pause();
    return;
  }
  const daemon = getServiceStatus();
  const tunnel = getTunnelServiceStatus();
  const action = await selectMenu("Runtime stack", [
    { value: "start", label: "Start runtime stack", detail: "daemon + tunnel/MCP" },
    { value: "restart", label: "Restart runtime stack", detail: "restarts daemon + tunnel/MCP and interrupts active turns" },
    { value: "stop", label: "Stop runtime stack", detail: "stops daemon + tunnel/MCP and interrupts active turns" },
    { value: "cancel", label: "Cancel active browser turns", detail: "explicit interruption" },
  ], [
    `Daemon: ${daemon.loaded ? "running" : daemon.installed ? "stopped" : "not installed"}`,
    `Tunnel: ${tunnel.running ? "running" : tunnel.installed ? "stopped" : "not installed"}`,
  ]);
  if (!action) return;
  renderScreen("Runtime stack");
  if (action === "cancel") {
    if (!await yesNo("Cancel active browser turns?", [
      "This explicitly interrupts browser generations currently owned by the daemon.",
      "Use it only when those turns should be abandoned.",
    ])) return;
    stdout.write(`${JSON.stringify({ cancelledBrowserTurns: await cancelBrowserTurns(config) }, null, 2)}\n`);
  } else {
    const next = action === "start"
      ? await startRuntimeStack(config)
      : action === "restart"
        ? await restartRuntimeStack(config)
        : await stopRuntimeStack(config);
    stdout.write(`${JSON.stringify(next, null, 2)}\n`);
  }
  await pause();
}

async function tunnelMenu(): Promise<void> {
  const config = safeConfig();
  if (!config) {
    renderScreen("Tunnel", ["No valid configuration exists. Run Setup Wizard first."]);
    await pause();
    return;
  }
  const service = getTunnelServiceStatus();
  const action = await selectMenu("Tunnel", [
    { value: "status", label: "Check tunnel runtime" },
    { value: "key", label: "Replace stored runtime key", detail: "hidden input" },
  ], [
    `Service: ${service.running ? "running" : service.installed ? "stopped" : "not installed"}`,
    config.tunnel ? `Alias: ${config.tunnel.alias}` : "Tunnel is not configured",
  ]);
  if (!action) return;
  renderScreen("Tunnel");
  if (action === "status") {
    stdout.write(`${JSON.stringify({ service: getTunnelServiceStatus(), runtime: tunnelStatus(config) }, null, 2)}\n`);
  } else {
    const key = await hiddenPrompt("New runtime key (hidden)");
    if (!key) throw new Error("Runtime key cannot be empty");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}. Rerun Setup Wizard to validate the tunnel with it.\n`);
  }
  await pause();
}

async function apiMenu(): Promise<void> {
  const action = await selectMenu("API key", [
    { value: "create", label: "Create key if missing" },
    { value: "rotate", label: "Rotate key", detail: "new value shown once" },
    { value: "revoke", label: "Revoke key" },
    { value: "path", label: "Show key file path" },
  ], [
    statusLabel(Boolean(readApiToken()), "Key is configured", "Key is missing"),
    "Existing key values are never displayed.",
  ]);
  if (!action) return;
  renderScreen("API key");
  if (action === "create") {
    const result = ensureApiToken();
    stdout.write(result.created
      ? `New API key — shown once; store it securely:\n${result.token}\n`
      : `API key already exists at ${apiTokenPath()}; existing value was not displayed.\n`);
  } else if (action === "rotate") {
    if (!await yesNo("Rotate API key?", ["Existing harnesses using the current key will stop authenticating."])) return;
    stdout.write(`New API key — shown once; update your harness securely:\n${rotateApiToken()}\n`);
  } else if (action === "revoke") {
    if (!await yesNo("Revoke API key?", ["Generic /v1/agent requests will fail until a new key is created."])) return;
    removeApiToken();
    stdout.write("API key revoked.\n");
  } else stdout.write(`${apiTokenPath()}\n`);
  await pause();
}

async function profilesMenu(): Promise<void> {
  const pinned = process.env[PRODUCT_PROFILE_ENV]?.trim();
  if (pinned) {
    renderScreen("Profiles", [`Profile selection is pinned to ${JSON.stringify(getProfileName())} by ${PRODUCT_PROFILE_ENV}.`]);
    await pause();
    return;
  }
  const active = getProfileName();
  const items: MenuItem<string>[] = listProfiles().map(profile => ({
    value: profile,
    label: profile === active ? `${profile} (active)` : profile,
  }));
  items.push({ value: "__create__", label: "Create new profile" });
  const choice = await selectMenu("Profiles", items, ["Switching profile changes which isolated runtime state this TUI manages."], active);
  if (!choice) return;
  if (choice === "__create__") {
    const name = assertProfileName(await linePrompt("New profile name"));
    mkdirSync(join(getProductHome(), "profiles", name), { recursive: true, mode: 0o700 });
    setActiveProfile(name);
  } else setActiveProfile(choice);
}

function openUrl(url: string): void {
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else stdout.write(`${url}\n`);
}

function openConnectorSettings(): void {
  openUrl("https://chatgpt.com/#settings/Connectors");
}

async function connectorMenu(): Promise<void> {
  const config = safeConfig();
  if (!config) {
    renderScreen("Connector", ["No valid configuration exists. Run Setup Wizard first."]);
    await pause();
    return;
  }
  const action = await selectMenu("Connector", [
    { value: "open", label: "Open ChatGPT connector settings" },
    { value: "details", label: "Show connector identity" },
  ], [`Connector: ${config.appName}`, `Tunnel alias: ${config.tunnel?.alias ?? "not configured"}`]);
  if (!action) return;
  renderScreen("Connector");
  if (action === "open") openConnectorSettings();
  else stdout.write(`${JSON.stringify({ connector: config.appName, tunnelAlias: config.tunnel?.alias ?? null }, null, 2)}\n`);
  await pause();
}

async function doctorScreen(): Promise<void> {
  renderScreen("Doctor", ["Running local health checks…"]);
  const report = await runDoctor();
  renderScreen("Doctor");
  stdout.write(formatDoctorReport(report));
  await pause();
}

async function maintenanceMenu(): Promise<void> {
  const action = await selectMenu("Advanced / maintenance", [
    { value: "browser", label: "Verify Chrome / Chromium launch" },
    { value: "config", label: "Show active config path" },
    { value: "tunnels", label: "Open tunnel settings" },
    { value: "runtime-keys", label: "Open runtime-key settings" },
    { value: "uninstall", label: "Uninstall this profile", detail: "services first; optional data removal" },
  ], [
    "These are human-facing maintenance operations that also exist in the Makefile/CLI facade.",
    "Foreground `serve` and the internal MCP transport are intentionally not launched from inside the TUI.",
  ]);
  if (!action) return;
  if (action === "config") {
    renderScreen("Advanced / maintenance");
    stdout.write(`${getConfigPath()}\n`);
    await pause();
    return;
  }
  if (action === "tunnels" || action === "runtime-keys") {
    renderScreen("Advanced / maintenance");
    openUrl(action === "tunnels"
      ? "https://platform.openai.com/settings/organization/tunnels"
      : "https://platform.openai.com/settings/organization/api-keys");
    await pause();
    return;
  }
  if (action === "browser") {
    const config = safeConfig();
    if (!config) throw new Error("No valid configuration exists. Run Setup Wizard first.");
    renderScreen("Advanced / maintenance", ["Launching the configured browser headlessly for a local engine check…"]);
    await checkBrowserEngine(config);
    stdout.write("Configured Chrome / Chromium launched successfully.\n");
    await pause();
    return;
  }

  const removeData = await yesNo("Remove private profile data too?", [
    "No keeps config, ChatGPT session state, API key, and tunnel credential after removing managed services.",
    "Yes also removes the active profile directory after services are safely uninstalled.",
  ], false);
  if (!await yesNo("Confirm uninstall", [
    removeData
      ? `Stop managed services and remove all private data for profile ${JSON.stringify(getProfileName())}?`
      : `Stop managed services for profile ${JSON.stringify(getProfileName())} and keep its private data?`,
    "Loaded services are removed only after LCA Token proves the daemon is idle.",
  ], false)) return;
  renderScreen("Advanced / maintenance");
  await uninstallProfile({ keepData: !removeData });
  stdout.write(removeData
    ? "Uninstalled and removed private profile data.\n"
    : "Uninstalled managed services; private profile data was preserved.\n");
  await pause();
}

async function runMenuAction(action: string): Promise<void> {
  try {
    if (action === "setup") await runSetupWizard();
    else if (action === "auth") await authMenu();
    else if (action === "runtime") await runtimeMenu();
    else if (action === "tunnel") await tunnelMenu();
    else if (action === "api") await apiMenu();
    else if (action === "profiles") await profilesMenu();
    else if (action === "connector") await connectorMenu();
    else if (action === "doctor") await doctorScreen();
    else if (action === "maintenance") await maintenanceMenu();
  } catch (error) {
    if (error instanceof TuiExit) return;
    renderScreen("Operation failed", [error instanceof Error ? error.message : String(error)]);
    await pause();
  }
}

export async function runTui(): Promise<void> {
  if (!tuiSupported()) throw new Error("The TUI requires an interactive terminal; use CLI subcommands for non-interactive automation");
  try {
    while (true) {
      const action = await selectMenu("Control Center", [
        { value: "setup", label: "Setup Wizard", detail: "guided configuration" },
        { value: "auth", label: "ChatGPT authentication" },
        { value: "runtime", label: "Runtime stack", detail: "daemon + tunnel/MCP lifecycle" },
        { value: "tunnel", label: "Tunnel", detail: "status / runtime key only" },
        { value: "api", label: "API key" },
        { value: "profiles", label: "Profiles" },
        { value: "connector", label: "Connector" },
        { value: "doctor", label: "Doctor / health checks" },
        { value: "maintenance", label: "Advanced / maintenance" },
        { value: "quit", label: "Quit" },
      ], tuiOverviewLines());
      if (!action || action === "quit") break;
      await runMenuAction(action);
    }
  } catch (error) {
    if (!(error instanceof TuiExit)) throw error;
  } finally {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
    stdout.write(`${SHOW_CURSOR}${RESET}`);
  }
}
