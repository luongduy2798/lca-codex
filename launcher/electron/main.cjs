const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
} = require("electron");
const { BrowserHost } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  ACTIVITY_STALL_MS,
  createLogger,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { createRuntimeLifecycleCoordinator } = require("./runtime-lifecycle.cjs");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const { CodexUsageUpsellPatcher } = require("./codex-ui-patch.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}
const CORE_HOME = process.env.LCA_CODEX_HOME?.trim()
  ? resolveUserPath(process.env.LCA_CODEX_HOME.trim())
  : path.join(os.homedir(), ".lca-codex");
const CODEX_HOME = process.env.CODEX_HOME?.trim()
  ? resolveUserPath(process.env.CODEX_HOME.trim())
  : path.join(os.homedir(), ".codex");
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
// Transparent raster generated from the same BrandMark glyph rendered in the sidebar.
const MAC_TRAY_ICON_PNG = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAE1klEQVR4nL2Ya4hVVRTHf+feuTPjqxx7OFoj9rIHFgj5gBiw14cMStFKCkqFiKIgrZiCPiRRoxUUko8mEyxloowYSyF7gn6YaiKSsgdZVkT2IDOTcixPH9Z/z1733HPnqS643LPXXnut/157PfY5CYOnRP8FIAWODEHXkCgBijn8YhX+MaVi5nkYcDEw0fELHCdgwchJwBLgN+AAdlwp0AG0ZOTDr+ZogyzofxHwpwB8DGwHHgI2OmBPAlOr6EmIsTdoKgrQvTL4JXBZjtwUoEsy/wJtwAZgK7A2A7JQsbqfVHLGUmAzMNwpLVG+42VET6XAYaDbjVcCYwcDyru2BvhACs8Xr9YpHAnMB36WzPvAA8AFAj8COANo1/x3wCRnp19gwv84YKkUfYMFdMGBmSV+CnwE3NqH7kWS3a1N9RlTQaAIvEJ09X/AOsmUMK89SzyW1X3oLAkAwN1aN1/jqtnnwWzSonbgdT3f7nbzoHhvEo/RV+6rsKNb7PSHmCsAXwN7ZauqlwraRfDMC+KP0/haJ9sO/IB5KlAJuBrLwsNE736KxVSgIpZ5qXQH22UU3HaNBF/DArIIjBfveie/GVjlxucBnVihfERrmrE6FYCtAk6U/D3iXZqx30M1mNvWSXC0m2sU7zrHWw2s0fNyZ3RLVrGMvqX5/QKzETgEjJFMxZEFhG9ol6OIbswDNA/4A8uwH4G52JF2AfuABTnApgBfOfB7gbo8QMHweKzCbtM4xMepUnCDW7hCvCec0kC3YTF0M9EDgUYAj8vOfuCcDIaeQQI0Ab9gPQqi1yZIwSzH3wo873YXmmhQ3ElsIa1UHk2L5j/EYrUi04I37pLgTCdwrniPOvlWzEtFYnsJmysK0BLgFuAL7BjnSmfw6A5yMs27KsHiAuBOCddhNWMpcAfwOTAbKw/dkk0zgI4A9ZJdj2XgTqy2nYwdZ4JdV8BaTLBfpigBzgR2ycgcjxxoAJ4h1pjl4oe7jq9Je7A2EXgrc7xRjyXFbqoUyBAzV2rxASxFsyk5RsC6sbrl6XTgJa2f7Xb+HOa5RmerFvgEC+4aJ1sGKAEup/wKsQO4iEp6Cjvid7EKfSPwj4z8hWVloLXS1eh4DQL5EzEOcz00k3gkrQ7YBuDsDKg6LGBT7CZ5n/i7KK9FHlAwOgFr2is09kdeBmiOFofjOAvrayl2TB3AZOA04GXgoAyOdro+wzIsC6jJbWSbeBPFq9rPrpDgY8QrA8D9WLAGjx3EetVkzYedn4LF3005gIbJ8BZiA0/ywHiETVhBe0fjegd2OJbK24EZOTqasRhKgUucsTXivUhsuJuIN8+ql7RgeDEWcMvcXKlSvIeasD4YvLcgo68Ti5cwv97N9XljLGCp/bsWt2BeyqMG4GHsHS3Fdj9NcyFIm7GsS7HaNNat79edOhzdVOBXKXoVK2ozsGAehd179hAv9tOdjlBnIPa1toyNAb2fBVCTiLc7/zvknudlgJTc+guBv7H6dALVvwv0i/zCaVimdABPUx4vbVhpyNJC4lEupJdsGgj15trpwHsOWBfwNhZHO8X7nthChgzGk/9g4D8cjMQaZzvxRXEf8C12Oxjm1h9zyhqpxV6Jsvzj+s0owTxW0YeILw4DVni0KNxnwoUt7UW2Kv0Pauo192+fGvIAAAAASUVORK5CYII=";

app.setName("LCA Codex");
if (process.platform === "win32") app.setAppUserModelId("dev.lcacodex.launcher");
const configuredUserData = process.env.LCA_CODEX_LAUNCHER_DATA_DIR?.trim();
const launcherUserData = configuredUserData
  ? resolveUserPath(configuredUserData)
  : path.join(app.getPath("appData"), "lca-codex");
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let browserHost = null;
let runtimeHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let runtimeLifecycle = null;
let launcherStateStore = null;
let tray = null;
let latestTrayRuntimeStatus = null;
let latestTrayActivity = null;
let trayActivityTimer = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let runtimeStatusTimer = null;
let runtimeStatusInFlight = false;
let updateController = null;
let codexUsageUpsellPatcher = null;
let codexUsageUpsellTimer = null;
let codexUsageUpsellInFlight = false;
let codexUsageUpsellReloadRequired = false;
let codexUsageUpsellLastError = null;
let lastCodexUsageUpsellStatus = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function codexUsageUpsellStatus() {
  if (codexUsageUpsellLastError) {
    return {
      state: "error",
      version: null,
      extensionPath: null,
      bundlePath: null,
      backupAvailable: false,
      reloadRequired: codexUsageUpsellReloadRequired,
      message: codexUsageUpsellLastError,
    };
  }
  if (!codexUsageUpsellPatcher) {
    return {
      state: "not-found",
      version: null,
      extensionPath: null,
      bundlePath: null,
      backupAvailable: false,
      reloadRequired: codexUsageUpsellReloadRequired,
      message: null,
    };
  }
  try {
    return {
      ...codexUsageUpsellPatcher.inspect(),
      reloadRequired: codexUsageUpsellReloadRequired,
      message: null,
    };
  } catch (error) {
    return {
      state: "error",
      version: null,
      extensionPath: null,
      bundlePath: null,
      backupAvailable: false,
      reloadRequired: codexUsageUpsellReloadRequired,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function publishCodexUsageUpsellStatus(status = codexUsageUpsellStatus()) {
  const serialized = JSON.stringify(status);
  if (serialized !== lastCodexUsageUpsellStatus) {
    lastCodexUsageUpsellStatus = serialized;
    send("launcher:codex-usage-upsell-state", status);
  }
  return status;
}

function syncCodexUsageUpsellPatch({ logger, stateStore } = {}) {
  if (!codexUsageUpsellPatcher || codexUsageUpsellInFlight) return codexUsageUpsellStatus();
  codexUsageUpsellInFlight = true;
  try {
    let status = codexUsageUpsellPatcher.inspect();
    const state = stateStore.read();
    if (state.hideCodexUsageUpsell === true && status.state !== "applied") {
      const result = codexUsageUpsellPatcher.apply();
      if (result.mutated) codexUsageUpsellReloadRequired = true;
      status = result;
    }
    codexUsageUpsellLastError = null;
    const { mutated: _mutated, ...statusResult } = status;
    return publishCodexUsageUpsellStatus({
      ...statusResult,
      reloadRequired: codexUsageUpsellReloadRequired,
      message: null,
    });
  } catch (error) {
    codexUsageUpsellLastError = error instanceof Error ? error.message : String(error);
    logger.warn("codex.ui_usage_upsell_sync_failed", { message: codexUsageUpsellLastError });
    return publishCodexUsageUpsellStatus(codexUsageUpsellStatus());
  } finally {
    codexUsageUpsellInFlight = false;
  }
}

function startCodexUsageUpsellMonitor({ logger, stateStore }) {
  if (codexUsageUpsellTimer) clearInterval(codexUsageUpsellTimer);
  codexUsageUpsellTimer = setInterval(() => {
    if (stateStore.read().hideCodexUsageUpsell === true) {
      syncCodexUsageUpsellPatch({ logger, stateStore });
    } else {
      publishCodexUsageUpsellStatus();
    }
  }, 60_000);
  codexUsageUpsellTimer.unref?.();
}

function stopCodexUsageUpsellMonitor() {
  if (codexUsageUpsellTimer) clearInterval(codexUsageUpsellTimer);
  codexUsageUpsellTimer = null;
}

async function publishRuntimeStatus() {
  if (!runtimeSupervisor) {
    return {
      configured: false,
      lifecycle: "stopped",
      owner: "none",
      mode: null,
      detail: null,
      daemon: { pid: null, healthy: false, acceptingTurns: null },
      tunnel: null,
      port: { host: "127.0.0.1", port: null, occupied: false, identity: "none" },
    };
  }
  const status = await runtimeSupervisor.observeRuntime();
  send("launcher:runtime-state", status);
  updateTrayRuntimeStatus(status);
  return status;
}

function stopRuntimeStatusMonitor() {
  if (runtimeStatusTimer) clearInterval(runtimeStatusTimer);
  runtimeStatusTimer = null;
}

function startRuntimeStatusMonitor({ logger, stateStore }) {
  stopRuntimeStatusMonitor();
  const tick = async () => {
    if (runtimeStatusInFlight || !runtimeSupervisor) return;
    runtimeStatusInFlight = true;
    try {
      const status = await publishRuntimeStatus();
      const current = stateStore.read();
      const verificationPending = current.coreSetupComplete === true
        && (current.codexRestartRequired === true || current.codexCatalogVerified !== true);
      if (status.lifecycle === "ready" && verificationPending && !catalogVerificationTimer) {
        startCatalogVerificationMonitor({ logger, stateStore });
      } else if (status.lifecycle !== "ready" && catalogVerificationTimer) {
        stopCatalogVerificationMonitor();
      }
    } catch (error) {
      // Runtime observation is diagnostic and must never make the launcher unusable.
    } finally {
      runtimeStatusInFlight = false;
    }
  };
  runtimeStatusTimer = setInterval(() => { void tick(); }, 3_000);
  runtimeStatusTimer.unref?.();
  void tick();
}

function codexRestartPending(patch = {}) {
  return {
    ...patch,
    codexCatalogVerified: false,
    codexRestartRequired: true,
    codexRestartRequestedAt: new Date().toISOString(),
  };
}

function runtimeBridgeChanged(result) {
  return result?.route?.changed === true || result?.vscode?.changed === true;
}

function updateRuntimeBridgeState(result, stateStore) {
  if (!stateStore) return null;
  const patch = { bridgeEnabled: result?.route?.active === true };
  const state = stateStore.update(runtimeBridgeChanged(result) ? codexRestartPending(patch) : patch);
  send("launcher:state-changed", state);
  return state;
}

function applyRuntimeUpgradeState(upgrade, { logger, stateStore }) {
  if (!upgrade?.updated) return;
  const state = stateStore.update(codexRestartPending({
    bridgeEnabled: upgrade.bridgeEnabled,
    mcpRuntimeInstalled: true,
  }));
  send("launcher:state-changed", state);
  logger.info("runtime.release_upgraded", {
    fromVersion: upgrade.fromVersion,
    toVersion: upgrade.toVersion,
    mode: upgrade.mode,
    bridgeEnabled: upgrade.bridgeEnabled,
  });
}

async function startManagedRuntime() {
  if (!runtimeLifecycle) throw new Error("Runtime lifecycle is not initialized");
  return runtimeLifecycle.start();
}

async function stopManagedRuntime({ restoreCodex = true } = {}) {
  if (!runtimeLifecycle) throw new Error("Runtime lifecycle is not initialized");
  return runtimeLifecycle.stop({ restoreCodex });
}

async function restartManagedRuntime() {
  if (!runtimeLifecycle) throw new Error("Runtime lifecycle is not initialized");
  return runtimeLifecycle.restart();
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  const check = async () => {
    const current = stateStore.read();
    const verificationPending = current.codexRestartRequired === true || current.codexCatalogVerified !== true;
    if (current.coreSetupComplete !== true || !verificationPending) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) return;
      const lastRequestAt = Date.parse(health.last_successful_model_catalog_request_at ?? "");
      const restartRequestedAt = Date.parse(current.codexRestartRequestedAt ?? "");
      const requestIsFresh = Number.isFinite(restartRequestedAt)
        ? Number.isFinite(lastRequestAt) && lastRequestAt >= restartRequestedAt
        : true;
      if (!requestIsFresh) return;
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
        codexRestartRequestedAt: null,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

function trayImage() {
  const image = process.platform === "darwin"
    ? nativeImage.createFromBuffer(Buffer.from(MAC_TRAY_ICON_PNG, "base64")).resize({ width: 18, height: 18 })
    : nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  if (image.isEmpty()) throw new Error("Tray icon could not be loaded");
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function trayRuntimeTitle(status) {
  const labels = {
    stopped: "Stopped",
    starting: "Starting…",
    ready: "Ready",
    stopping: "Stopping…",
    degraded: "Degraded",
    error: "Error",
    stale: "Stale",
    foreign: "Unavailable",
  };
  return labels[status?.lifecycle] || "Checking…";
}

function trayRuntimeLabel(status) {
  return `Runtime: ${trayRuntimeTitle(status)}`;
}

function truncateTrayText(value, maxChars = 44) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function trayActivity(record) {
  const traceId = typeof record?.detail?.traceId === "string" ? record.detail.traceId : "";
  if (traceId.startsWith("health-")) return null;
  const fixed = {
    "lca_codex.turn_started": { label: "Turn started", terminal: false, stallable: true },
    "lca_codex.turn_send_accepted": { label: "Waiting for ChatGPT", terminal: false, stallable: true },
    "lca_codex.turn_first_response": { label: "ChatGPT responding", terminal: false, stallable: true },
    "lca_codex.turn_first_reasoning": { label: "Thinking", terminal: false, stallable: true },
    "lca_codex.turn_first_text": { label: "Writing response", terminal: false, stallable: true },
    "lca_codex.network_turn_created": { label: "ChatGPT turn created", terminal: false, stallable: true },
    "lca_codex.network_turn_streaming": { label: "ChatGPT streaming", terminal: false, stallable: true },
    "lca_codex.network_turn_completed": { label: "ChatGPT network completed", terminal: false, stallable: false },
    "lca_codex.turn_completed": { label: "Task completed", terminal: true, stallable: false },
    "lca_codex.turn_failed": { label: "Task failed", terminal: true, stallable: false },
    "lca_codex.turn_retry_scheduled": { label: "Retrying task", terminal: false, stallable: true },
    "lca_codex.turn_retry_stopped": { label: "Retry stopped", terminal: true, stallable: false },
    "browser.turn_started": { label: "Opening ChatGPT", terminal: false, stallable: false },
  };
  if (fixed[record?.event]) return fixed[record.event];
  if (record?.event === "browser.turn_ended") {
    return {
      label: record.detail?.status === "completed" ? "ChatGPT completed" : "ChatGPT ended",
      terminal: true,
      stallable: false,
    };
  }
  if (record?.event === "lca_codex.tool_started" || record?.event === "lca_codex.tool_completed") {
    const tool = truncateTrayText(record.detail?.tool || "tool", 24);
    const terminal = record.event === "lca_codex.tool_completed";
    return {
      label: terminal ? `${tool} completed` : `Running ${tool}`,
      terminal,
      stallable: !terminal && record.detail?.layer !== "codex",
    };
  }
  return null;
}

function updateTrayTitle() {
  if (process.platform !== "darwin" || !tray || typeof tray.setTitle !== "function") return;
  const runtime = trayRuntimeTitle(latestTrayRuntimeStatus);
  tray.setTitle(latestTrayActivity ? `${runtime} · ${latestTrayActivity}` : runtime);
}

function updateTrayMenu(status) {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayRuntimeLabel(status), enabled: false },
    { type: "separator" },
    { label: "Quit LCA Codex", click: () => { void requestQuit(); } },
  ]));
}

function updateTrayRuntimeStatus(status) {
  latestTrayRuntimeStatus = status;
  updateTrayMenu(status);
  updateTrayTitle();
}

function clearTrayActivityAfter(delayMs) {
  trayActivityTimer = setTimeout(() => {
    trayActivityTimer = null;
    latestTrayActivity = null;
    updateTrayTitle();
  }, delayMs);
  trayActivityTimer.unref?.();
}

function publishTrayActivity(record) {
  if (process.platform !== "darwin") return;
  const activity = trayActivity(record);
  if (!activity) return;
  if (trayActivityTimer) clearTimeout(trayActivityTimer);
  trayActivityTimer = null;
  latestTrayActivity = truncateTrayText(activity.label);
  updateTrayTitle();
  if (activity.terminal) {
    clearTrayActivityAfter(8_000);
    return;
  }
  if (!activity.stallable) return;
  trayActivityTimer = setTimeout(() => {
    trayActivityTimer = null;
    latestTrayActivity = "Stalled";
    updateTrayTitle();
    clearTrayActivityAfter(8_000);
  }, ACTIVITY_STALL_MS);
  trayActivityTimer.unref?.();
}

function createTray(logger) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip("LCA Codex");
    updateTrayRuntimeStatus(latestTrayRuntimeStatus);
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: "LCA Codex",
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  handle("launcher:snapshot", async () => ({
    state: stateStore.read(),
    runtime: await runtimeSupervisor.observeRuntime(),
    browser: browserHost?.snapshot() ?? null,
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false,
    logs: [],
    urls: { connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
    codexUsageUpsell: codexUsageUpsellStatus(),
  }));

  handle("launcher:runtime-status", () => publishRuntimeStatus());
  handle("launcher:runtime-start", () => startManagedRuntime({ logger, stateStore }));
  handle("launcher:runtime-stop", () => stopManagedRuntime({ logger, stateStore }));
  handle("launcher:runtime-restart", () => restartManagedRuntime({ logger, stateStore }));

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (_event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds));
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal());
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async () => {
    const operationName = "mcp-verification";
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const runtime = await publishRuntimeStatus();
      if (runtime.lifecycle === "ready") startCatalogVerificationMonitor({ logger, stateStore });
      else stopCatalogVerificationMonitor();
      publishOperation({ name: operationName, status: "completed", message: "Runtime and connector verified" });
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishOperation({ name: operationName, status: "failed", message });
      throw error;
    }
  });

  handle("launcher:doctor", () => runtimeHost.doctor());
  handle("launcher:codex-config", () => runtimeHost.codexConfigSnapshot());
  handle("launcher:codex-tool-health", () => runtimeHost.codexToolHealthSnapshot());
  handle("launcher:codex-tool-health-check", async () => {
    const report = await runtimeHost.checkCodexTools();
    send("launcher:codex-tool-health-state", report);
    return report;
  });
  handle("launcher:vscode-advanced-config", () => runtimeHost.vscodeAdvancedSnapshot());
  handle("launcher:vscode-advanced-setup", async () => {
    const configured = runtimeHost.setupVsCodeAdvanced();
    try {
      const runtime = await runtimeSupervisor.observeRuntime();
      if (runtime.lifecycle === "ready") return configured;
    } catch (error) {
      logger.warn("codex.vscode_runtime_status_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return runtimeHost.suspendVsCodeAdvanced();
  });
  handle("launcher:vscode-advanced-proxy-install", () => runtimeHost.installVsCodeAdvancedProxy());
  handle("launcher:vscode-advanced-remove", () => runtimeHost.removeVsCodeAdvanced());
  handle("launcher:codex-config-save", async (_event, content) => {
    const config = await runtimeHost.saveCodexConfig(content);
    const state = stateStore.update(codexRestartPending());
    send("launcher:state-changed", state);
    const runtime = await publishRuntimeStatus();
    if (runtime.lifecycle === "ready" && config.state === "configured") startCatalogVerificationMonitor({ logger, stateStore });
    else stopCatalogVerificationMonitor();
    return { config, state };
  });
  handle("launcher:cancel-turns", () => runtimeHost.cancelBrowserTurns());
  handle("launcher:restore-native-codex", async () => {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Restore native Codex"],
      defaultId: 0,
      cancelId: 0,
      title: "Restore native Codex",
      message: "Remove the LCA Codex-managed models and restore Codex's previous native route?",
      detail: "The local runtime will be stopped. MCP, tunnel credentials, runtime setup, unrelated Codex settings, and the ChatGPT login profile are preserved. Restart Codex once after restoring.",
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    await stopManagedRuntime({ restoreCodex: false });
    await runtimeHost.restoreNativeCodex();
    const state = stateStore.update(codexRestartPending({
      coreSetupComplete: false,
      bridgeEnabled: false,
    }));
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:uninstall-integration", async () => {
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Uninstall LCA Codex"],
      defaultId: 0,
      cancelId: 0,
      title: "Uninstall LCA Codex",
      message: "Remove the LCA Codex runtime, MCP configuration, and managed Codex route?",
      detail: "This is the full uninstall action. Tunnel/runtime configuration owned by LCA Codex will be removed.",
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update(codexRestartPending({
      coreSetupComplete: false,
      bridgeEnabled: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
    }));
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async () => {
    const beforeState = stateStore.read();
    try {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) throw new Error("Sign in to ChatGPT before installing the Codex integration");
      if (!(smokePassedThisSession || smokePassedForCurrentVersion(beforeState))) {
        throw new Error("Run the browser smoke test before installing the Codex integration");
      }
      const connect = beforeState.bridgeEnabled === true && beforeState.mcpRuntimeInstalled === true;
      let result;
      try {
        result = await runtimeHost.setupCore({ connect });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("--replace-codex-route")) throw error;
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          buttons: ["Cancel", "Replace existing route"],
          defaultId: 0,
          cancelId: 0,
          title: "Replace the existing Codex route?",
          message: "Codex already uses another model route.",
          detail: "LCA Codex can replace it reversibly and restore the current route when you uninstall or restore native Codex.",
          noLink: true,
        });
        if (confirmation.response !== 1) {
          throw new Error("Codex integration setup was cancelled; the existing route was preserved");
        }
        result = await runtimeHost.setupCore({ connect, replaceExistingRoute: true });
      }
      const coreState = {
        bridgeEnabled: connect,
        coreSetupComplete: true,
      };
      const state = stateStore.update(connect ? codexRestartPending(coreState) : coreState);
      send("launcher:state-changed", state);
      await browserHost.returnToIdle().catch((error) => {
        logger.warn("browser.idle_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      await publishRuntimeStatus();
      stopCatalogVerificationMonitor();
      return { ok: true, stdout: result.stdout, restartRequired: connect };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stopCatalogVerificationMonitor();
      send("launcher:state-changed", beforeState);
      await publishRuntimeStatus().catch((statusError) => {
        logger.warn("runtime.status_after_setup_failure_failed", {
          message: statusError instanceof Error ? statusError.message : String(statusError),
        });
      });
      await browserHost.returnToIdle().catch((idleError) => {
        logger.warn("browser.idle_cleanup_failed", {
          message: idleError instanceof Error ? idleError.message : String(idleError),
        });
      });
      publishOperation({ name: "core-setup", status: "failed", message });
      throw error;
    }
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    const beforeState = stateStore.read();
    if (beforeState.coreSetupComplete !== true) {
      throw new Error("Configure Codex before setting up MCP");
    }
    await browserHost.reveal();
    const result = await runtimeHost.setupMcp({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
      appName: typeof input?.connectorName === "string" ? input.connectorName : "",
    });
    const state = stateStore.update(codexRestartPending({
      bridgeEnabled: true,
      connectorName: runtimeHost.mcpConnectorName(),
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
    }));
    send("launcher:state-changed", state);
    const runtime = await publishRuntimeStatus();
    if (runtime.lifecycle === "ready") startCatalogVerificationMonitor({ logger, stateStore });
    else stopCatalogVerificationMonitor();
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:codex-usage-upsell-hidden", async (_event, enabled) => {
    const desired = enabled === true;
    let state = stateStore.update({ hideCodexUsageUpsell: desired });
    send("launcher:state-changed", state);
    try {
      const result = desired ? codexUsageUpsellPatcher.apply() : codexUsageUpsellPatcher.restore();
      if (result.mutated) codexUsageUpsellReloadRequired = true;
      codexUsageUpsellLastError = null;
      const { mutated: _mutated, ...statusResult } = result;
      const status = publishCodexUsageUpsellStatus({
        ...statusResult,
        reloadRequired: codexUsageUpsellReloadRequired,
        message: null,
      });
      return { state, status };
    } catch (error) {
      codexUsageUpsellLastError = error instanceof Error ? error.message : String(error);
      if (!desired) {
        state = stateStore.update({ hideCodexUsageUpsell: true });
        send("launcher:state-changed", state);
      }
      publishCodexUsageUpsellStatus(codexUsageUpsellStatus());
      throw error;
    }
  });
  handle("launcher:set-preference", async (_event, key, value) => {
    if (key !== "runtimeAutoStart" && key !== "keepRunningOnClose" && key !== "showBrowserDuringTurns") {
      throw new Error("Unknown preference");
    }
    const desired = value === true;
    const state = stateStore.update({ [key]: desired });
    if (key !== "runtimeAutoStart" || !desired) return state;
    try {
      await startManagedRuntime({ logger, stateStore });
      return stateStore.read();
    } catch (error) {
      const rolledBack = stateStore.update({ runtimeAutoStart: false });
      send("launcher:state-changed", rolledBack);
      throw error;
    }
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:activity-chats-page", (_event, input) => logger.activityChatsPage(input));
  handle("launcher:activity-chat-tasks", (_event, input) => logger.activityChatTasks(input));
  handle("launcher:activity-task-records", (_event, input) => logger.activityTaskRecords(input));
  handle("launcher:activity-system-records", () => logger.activitySystemRecords());
  handle("launcher:activity-delete", (_event, input) => logger.deleteActivity(input));
  handle("launcher:open-logs", async () => {
    const error = await shell.openPath(path.dirname(logger.filePath));
    if (error) throw new Error(`Could not open the launcher log directory: ${error}`);
    return logger.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation();
    if (activeOperation) {
      loggerForQuit()?.warn?.("launcher.quit_during_operation", { operation: activeOperation });
    }
    const commit = async () => {
      stopCatalogVerificationMonitor();
      stopRuntimeStatusMonitor();
      stopCodexUsageUpsellMonitor();
      quitting = true;
      browserHost?.destroy();
      await browserControl?.close().catch(() => {});
      exitCommitted = true;
      app.quit();
    };
    try {
      if (runtimeLifecycle) await runtimeLifecycle.quit({ commit });
      else await commit();
    } catch (error) {
      loggerForQuit()?.error?.("runtime.shutdown_failed_on_quit", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

function loggerForQuit() {
  return runtimeSupervisor?.logger || runtimeHost?.logger || null;
}

async function start() {
  cdpPort = await findFreePort();
  if (process.platform === "linux") app.commandLine.appendSwitch("class", "lca-codex");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  await app.whenReady();
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };

  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  launcherStateStore = stateStore;
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const autostart = getAutostart(app);
  if (autostart.supported && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => {
      send("launcher:log", record);
      publishTrayActivity(record);
    },
    threadIndexPath: path.join(CODEX_HOME, "session_index.jsonl"),
  });
  codexUsageUpsellPatcher = new CodexUsageUpsellPatcher({ logger });
  syncCodexUsageUpsellPatch({ logger, stateStore });
  startCodexUsageUpsellMonitor({ logger, stateStore });
  const startHidden = process.argv.includes("--hidden");
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
  }).start();
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    publishState: (state) => send("launcher:browser-state", state),
  });
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    publishOperation,
    publishRuntimeState: (state) => send("launcher:runtime-state", state),
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    codexHome: CODEX_HOME,
    coreHome: CORE_HOME,
    publishOperation,
    supervisor: runtimeSupervisor,
  });
  runtimeLifecycle = createRuntimeLifecycleCoordinator({
    runtimeHost,
    runtimeSupervisor,
    logger,
    publishRuntimeState: (state) => send("launcher:runtime-state", state),
    publishToolHealth: (state) => send("launcher:codex-tool-health-state", state),
    updateBridgeState: (bridge) => updateRuntimeBridgeState(bridge, stateStore),
    applyRuntimeUpgradeState: (upgrade) => applyRuntimeUpgradeState(upgrade, { logger, stateStore }),
    startCatalogVerificationMonitor: () => startCatalogVerificationMonitor({ logger, stateStore }),
    stopCatalogVerificationMonitor,
  });
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  if (!launcherSmokeTest) {
    void browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.LCA_CODEX_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute LCA_CODEX_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    app.quit();
    return;
  }
  void (async () => {
    try {
      const advanced = runtimeHost.repairVsCodeAdvanced();
      if (advanced.repaired) {
        logger.info("codex.vscode_proxy_repaired", { proxyPath: advanced.proxyPath });
      }
    } catch (error) {
      logger.warn("codex.vscode_proxy_repair_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const route = await runtimeHost.bridgeStatus();
      if (route.installed) {
        const current = stateStore.read();
        if (current.bridgeEnabled !== route.active) {
          const state = stateStore.update({ bridgeEnabled: route.active });
          send("launcher:state-changed", state);
        }
      }
    } catch (error) {
      logger.warn("bridge.route_status_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const runtime = await publishRuntimeStatus();
    startRuntimeStatusMonitor({ logger, stateStore });
    if (stateStore.read().runtimeAutoStart === true) {
      try {
        await startManagedRuntime({ logger, stateStore });
      } catch (error) {
        logger.error("runtime.auto_start_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (runtime.lifecycle !== "ready") {
      try {
        const bridge = await runtimeHost.deactivateRuntimeBridge("runtime-startup-native-restore");
        updateRuntimeBridgeState(bridge, stateStore);
      } catch (error) {
        logger.warn("bridge.startup_native_restore_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })().catch((error) => {
    logger.error("runtime.initial_observation_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  app.on("activate", () => showMainWindow());
  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    dialog.showErrorBox("LCA Codex could not start", message);
  } catch {}
  app.exit(1);
});
