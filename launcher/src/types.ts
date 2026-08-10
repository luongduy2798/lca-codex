export type Surface = "browser" | "setup" | "codex" | "mcp" | "runtime" | "activity" | "settings";

export interface LauncherState {
  version: 1;
  autoStart: boolean;
  runtimeAutoStart: boolean;
  bridgeEnabled: boolean;
  keepRunningOnClose: boolean;
  showBrowserDuringTurns: boolean;
  hideCodexUsageUpsell: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  codexRestartRequestedAt: string | null;
  mcpGuideStep: number;
  connectorName: string;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface ActivityChatSummary {
  id: string;
  kind: "chat" | "trace" | "system";
  threadId: string | null;
  title: string;
  taskCount: number;
  eventCount: number;
  lastAt: string;
}

export interface ActivityChatPage {
  chats: ActivityChatSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ActivityTaskSummary {
  traceId: string;
  threadId: string | null;
  chatTitle: string | null;
  startedAt: string;
  lastAt: string;
  durationMs: number;
  attempt: number;
  tools: Array<{
    source: "lca" | "codex";
    tool: string;
    count: number;
  }>;
  source: "chatgpt" | "lca" | "codex" | "system";
  status: "running" | "waiting" | "stalled" | "failed" | "completed";
  eventCount: number;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export interface RuntimeStatus {
  configured: boolean;
  lifecycle: "stopped" | "starting" | "ready" | "stopping" | "degraded" | "error" | "stale" | "foreign";
  owner: "current-launcher" | "stale-launcher" | "compatible-runtime" | "foreign" | "none";
  mode: "browser-only" | "full" | null;
  detail: string | null;
  daemon: {
    pid: number | null;
    healthy: boolean;
    acceptingTurns: boolean | null;
  };
  tunnel: {
    pid: number | null;
    state: string | null;
    ready: boolean;
  } | null;
  port: {
    host: string;
    port: number | null;
    occupied: boolean;
    identity: "lca-codex" | "foreign" | "none";
  };
}

export interface VsCodeAdvancedSnapshot {
  state: "configured" | "installed" | "inconsistent" | "not-configured";
  installed: boolean;
  configured: boolean;
  managed: boolean;
  vscodeDetected: boolean;
  proxyPath: string;
  settingsPath: string;
  errors: string[];
  reloadRequired: boolean;
}

export interface CodexConfigSnapshot {
  state: "configured" | "disconnected" | "inconsistent" | "not-configured";
  installed: boolean;
  active: boolean;
  configPath: string;
  exists: boolean;
  content: string;
  routeUrl?: string;
  errors: string[];
}

export type CodexToolHealthStatus = "working" | "available" | "failed" | "missing" | "unknown";

export interface CodexToolHealthItem {
  name: "exec_command" | "write_stdin" | "apply_patch" | "view_image";
  status: CodexToolHealthStatus;
  detail: string;
}

export interface CodexToolHealthReport {
  checkedAt: string | null;
  activeTurn: boolean;
  live: boolean;
  traceId: string | null;
  tools: CodexToolHealthItem[];
}

export interface CodexUsageUpsellStatus {
  state: "not-found" | "unsupported" | "available" | "applied" | "error";
  version: string | null;
  extensionPath: string | null;
  bundlePath: string | null;
  backupAvailable: boolean;
  reloadRequired: boolean;
  message: string | null;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | { status: "available" | "downloading" | "installing"; version: string }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  state: LauncherState;
  runtime: RuntimeStatus;
  browser: BrowserState | null;
  mcpCredentialsConfigured: boolean;
  logs: LogRecord[];
  urls: {
    connectors: string;
    tunnels: string;
    keys: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  update: UpdateState;
  codexUsageUpsell: CodexUsageUpsellStatus;
}

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  runtimeStatus(): Promise<RuntimeStatus>;
  startRuntime(): Promise<RuntimeStatus>;
  stopRuntime(): Promise<RuntimeStatus>;
  restartRuntime(): Promise<RuntimeStatus>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  codexConfig(): Promise<CodexConfigSnapshot>;
  codexToolHealth(): Promise<CodexToolHealthReport>;
  checkCodexTools(): Promise<CodexToolHealthReport>;
  vscodeAdvancedConfig(): Promise<VsCodeAdvancedSnapshot>;
  setupVsCodeAdvanced(): Promise<VsCodeAdvancedSnapshot>;
  installVsCodeAdvancedProxy(): Promise<VsCodeAdvancedSnapshot>;
  removeVsCodeAdvanced(): Promise<VsCodeAdvancedSnapshot>;
  saveCodexConfig(content: string): Promise<{ config: CodexConfigSnapshot; state: LauncherState }>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    connectorName: string;
  }): Promise<{ ok: boolean; stdout: string }>;
  setMcpStep(step: number): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean }>;
  setPreference(key: "runtimeAutoStart" | "keepRunningOnClose" | "showBrowserDuringTurns", value: boolean): Promise<LauncherState>;
  setCodexUsageUpsellHidden(enabled: boolean): Promise<{ state: LauncherState; status: CodexUsageUpsellStatus }>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  logs(limit?: number): Promise<LogRecord[]>;
  activityChatsPage(input?: { cursor?: string; limit?: number }): Promise<ActivityChatPage>;
  activityChatTasks(input: { chatId: string }): Promise<ActivityTaskSummary[]>;
  activityTaskRecords(input: { traceId: string }): Promise<LogRecord[]>;
  activitySystemRecords(): Promise<LogRecord[]>;
  openLogs(): Promise<string>;
  installUpdate(): Promise<boolean>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onRuntimeState(listener: (state: RuntimeStatus) => void): () => void;
  onCodexToolHealthState(listener: (state: CodexToolHealthReport) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onCodexUsageUpsellState(listener: (state: CodexUsageUpsellStatus) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
