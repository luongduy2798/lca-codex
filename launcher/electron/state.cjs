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
  keepRunningOnClose: true,
  showBrowserDuringTurns: true,
  hideCodexUsageUpsell: false,
  reviewCodexChangesPerFile: false,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  connectorName: "",
  sessionRefreshReminderAt: null,
  codexRestartRequestedAt: null,
});
const OPTIONAL_BOOLEAN_STATE_KEYS = [
  "coreSetupComplete",
  "codexCatalogVerified",
  "mcpSetupComplete",
  "mcpRuntimeInstalled",
  "codexRestartRequired",
];

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return { ...DEFAULT_STATE };
    const state = { ...DEFAULT_STATE };
    for (const key of Object.keys(DEFAULT_STATE)) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) state[key] = parsed[key];
    }
    for (const key of OPTIONAL_BOOLEAN_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) state[key] = parsed[key];
    }
    for (const key of [
      "autoStart",
      "runtimeAutoStart",
      "bridgeEnabled",
      "keepRunningOnClose",
      "showBrowserDuringTurns",
      "hideCodexUsageUpsell",
      "reviewCodexChangesPerFile",
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
    if (state.codexRestartRequestedAt !== null
      && (typeof state.codexRestartRequestedAt !== "string"
        || !Number.isFinite(Date.parse(state.codexRestartRequestedAt)))) {
      state.codexRestartRequestedAt = DEFAULT_STATE.codexRestartRequestedAt;
    }
    for (const key of OPTIONAL_BOOLEAN_STATE_KEYS) {
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
