const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;

const DEFAULT_STATE = Object.freeze({
  version: 1,
  autoStart: false,
  runtimeAutoStart: false,
  bridgeEnabled: true,
  keepRunningOnClose: false,
  showBrowserDuringTurns: true,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  connectorName: "",
  sessionRefreshReminderAt: null,
});

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return { ...DEFAULT_STATE };
    const legacyRuntimeLifecycle = !Object.prototype.hasOwnProperty.call(parsed, "runtimeAutoStart");
    const state = { ...DEFAULT_STATE, ...parsed };
    delete state.language;
    delete state.onboardingComplete;
    delete state.githubOpened;
    if (legacyRuntimeLifecycle) {
      // Older releases defaulted to a background-service UX. Migrate once to the new
      // manual-first lifecycle so closing an upgraded launcher does not silently keep it alive.
      state.runtimeAutoStart = false;
      state.keepRunningOnClose = false;
    }
    for (const key of [
      "autoStart",
      "runtimeAutoStart",
      "bridgeEnabled",
      "keepRunningOnClose",
      "showBrowserDuringTurns",
      "browserSmokePassed",
      "sidebarOpen",
    ]) {
      if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
    }
    if (state.browserSmokeVersion !== null
      && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
      state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
    }
    if (!Number.isFinite(state.sidebarWidth)
      || state.sidebarWidth < SIDEBAR_MIN_WIDTH
      || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
      state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
    }
    if (!Number.isInteger(state.mcpGuideStep) || state.mcpGuideStep < 0 || state.mcpGuideStep > 2) {
      state.mcpGuideStep = DEFAULT_STATE.mcpGuideStep;
    }
    if (typeof state.connectorName !== "string" || state.connectorName.length > 80) {
      state.connectorName = DEFAULT_STATE.connectorName;
    } else {
      state.connectorName = state.connectorName.trim();
    }
    if (state.sessionRefreshReminderAt !== null
      && (typeof state.sessionRefreshReminderAt !== "string"
        || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
      state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
    }
    for (const key of [
      "coreSetupComplete",
      "codexCatalogVerified",
      "mcpSetupComplete",
      "mcpRuntimeInstalled",
      "codexRestartRequired",
    ]) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath) {
  let state = readState(filePath);
  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      writeState(filePath, next);
      state = next;
      return structuredClone(next);
    },
  };
}

module.exports = {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
};
