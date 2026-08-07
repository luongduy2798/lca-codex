const { contextBridge, ipcRenderer } = require("electron");

function subscription(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexWebLauncher", {
  snapshot: () => ipcRenderer.invoke("launcher:snapshot"),
  runtimeStatus: () => ipcRenderer.invoke("launcher:runtime-status"),
  startRuntime: () => ipcRenderer.invoke("launcher:runtime-start"),
  stopRuntime: () => ipcRenderer.invoke("launcher:runtime-stop"),
  restartRuntime: () => ipcRenderer.invoke("launcher:runtime-restart"),
  openExternal: (url) => ipcRenderer.invoke("launcher:open-external", url),
  setBrowserBounds: (bounds) => ipcRenderer.invoke("launcher:browser-bounds", bounds),
  setBrowserSurfaceActive: (active) => ipcRenderer.invoke("launcher:browser-surface-active", active),
  showBrowser: () => ipcRenderer.invoke("launcher:browser-show"),
  hideBrowser: () => ipcRenderer.invoke("launcher:browser-hide"),
  navigateBrowser: (action) => ipcRenderer.invoke("launcher:browser-navigate", action),
  selectBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-select", tabId),
  closeBrowserTab: (tabId) => ipcRenderer.invoke("launcher:browser-tab-close", tabId),
  openLogin: () => ipcRenderer.invoke("launcher:browser-login"),
  logoutChatGpt: () => ipcRenderer.invoke("launcher:browser-logout"),
  dismissSessionReminder: () => ipcRenderer.invoke("launcher:session-reminder-dismiss"),
  smokeTest: () => ipcRenderer.invoke("launcher:browser-smoke"),
  verifyMcp: () => ipcRenderer.invoke("launcher:mcp-verify"),
  doctor: () => ipcRenderer.invoke("launcher:doctor"),
  codexConfig: () => ipcRenderer.invoke("launcher:codex-config"),
  saveCodexConfig: (content) => ipcRenderer.invoke("launcher:codex-config-save", content),
  cancelTurns: () => ipcRenderer.invoke("launcher:cancel-turns"),
  setBridgeEnabled: (enabled) => ipcRenderer.invoke("launcher:bridge-enabled", enabled),
  uninstallIntegration: () => ipcRenderer.invoke("launcher:uninstall-integration"),
  setupCore: () => ipcRenderer.invoke("launcher:setup-core"),
  setupMcp: (input) => ipcRenderer.invoke("launcher:setup-mcp", input),
  setMcpStep: (step) => ipcRenderer.invoke("launcher:set-mcp-step", step),
  setAutostart: (enabled) => ipcRenderer.invoke("launcher:autostart", enabled),
  setPreference: (key, value) => ipcRenderer.invoke("launcher:set-preference", key, value),
  setSidebarState: (state) => ipcRenderer.invoke("launcher:sidebar-state", state),
  logs: (limit) => ipcRenderer.invoke("launcher:logs", limit),
  openLogs: () => ipcRenderer.invoke("launcher:open-logs"),
  installUpdate: () => ipcRenderer.invoke("launcher:update-install"),
  windowState: () => ipcRenderer.invoke("launcher:window-state"),
  windowControl: (action) => ipcRenderer.send("launcher:window-control", action),
  onWindowStateChanged: (listener) => subscription("launcher:window-state-changed", listener),
  onStateChanged: (listener) => subscription("launcher:state-changed", listener),
  onRuntimeState: (listener) => subscription("launcher:runtime-state", listener),
  onBrowserState: (listener) => subscription("launcher:browser-state", listener),
  onOperation: (listener) => subscription("launcher:operation", listener),
  onLog: (listener) => subscription("launcher:log", listener),
  onUpdateState: (listener) => subscription("launcher:update-state", listener),
});
