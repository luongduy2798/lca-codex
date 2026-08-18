import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copy, type Copy } from "./i18n";
import { Icon, type IconName } from "./icons";
import type {
  ActivityChatSummary,
  ActivityDeleteInput,
  ActivityTaskSummary,
  BrowserState,
  CodexConfigSnapshot,
  CodexToolHealthReport,
  CodexToolHealthStatus,
  DoctorReport,
  LauncherSnapshot,
  LauncherState,
  LogRecord,
  OperationState,
  RuntimeStatus,
  Surface,
  VsCodeAdvancedSnapshot,
} from "./types";

const api = window.codexWebLauncher;
const PANEL_TRANSITION = { duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const;

export function App() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot | null>(null);
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot().then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      setBrowser(next.browser);
      setLogs(next.logs);
      setOperation(next.operation);
      if (next.operation?.status === "failed") setError(next.operation.message);
    }).catch((cause) => setError(messageOf(cause)));
    const unsubscribeState = api.onStateChanged((state) => {
      setSnapshot((current) => current
        ? {
            ...current,
            state,
            smokePassed: current.smokePassed
              || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
          }
        : current);
    });
    const unsubscribeRuntime = api.onRuntimeState((runtime) => {
      setSnapshot((current) => current ? { ...current, runtime } : current);
    });
    const unsubscribeBrowser = api.onBrowserState(setBrowser);
    const unsubscribeOperation = api.onOperation((next) => {
      setOperation(next);
      if (next.status === "failed") setError(next.message);
    });
    const unsubscribeLog = api.onLog((record) => setLogs((current) => [...current.slice(-299), record]));
    const unsubscribeUpdate = api.onUpdateState((update) => {
      setSnapshot((current) => current ? { ...current, update } : current);
    });
    const unsubscribeCodexUsageUpsell = api.onCodexUsageUpsellState((codexUsageUpsell) => {
      setSnapshot((current) => current ? { ...current, codexUsageUpsell } : current);
    });
    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeRuntime();
      unsubscribeBrowser();
      unsubscribeOperation();
      unsubscribeLog();
      unsubscribeUpdate();
      unsubscribeCodexUsageUpsell();
    };
  }, []);

  const updateState = useCallback((state: LauncherState) => {
    setSnapshot((current) => current
      ? {
          ...current,
          state,
          smokePassed: current.smokePassed
            || (state.browserSmokePassed === true && state.browserSmokeVersion === current.version),
        }
      : current);
  }, []);

  const removeActivityLogs = useCallback((input: ActivityDeleteInput) => {
    setLogs((current) => {
      if (input.scope === "all") return [];
      if (input.scope === "task") {
        return current.filter((record) => activityTraceId(record) !== input.traceId);
      }
      const deleted = new Set(groupActivityRecordsByChat(current).get(input.chatId) ?? []);
      return current.filter((record) => !deleted.has(record));
    });
  }, []);

  if (!api) return <FatalMessage message="Launcher IPC is unavailable." />;
  if (!snapshot) return <LaunchLoading />;

  return (
    <div className="app-root" data-platform={snapshot.platform} data-theme="dark">
      <LauncherShell
        browser={browser}
        copy={copy}
        logs={logs}
        onActivityDeleted={removeActivityLogs}
        operation={operation}
        setError={setError}
        snapshot={snapshot}
        updateState={updateState}
      />
      <AnimatePresence>
        {error ? <ErrorToast copy={copy} message={error} onDismiss={() => setError(null)} /> : null}
      </AnimatePresence>
    </div>
  );
}

function LauncherShell({
  browser,
  copy,
  logs,
  onActivityDeleted,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  browser: BrowserState | null;
  copy: Copy;
  logs: LogRecord[];
  onActivityDeleted: (input: ActivityDeleteInput) => void;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [surface, setSurface] = useState<Surface>(
    snapshot.state.coreSetupComplete
      && snapshot.state.codexCatalogVerified
      && snapshot.state.mcpSetupComplete
      ? "browser"
      : "setup",
  );
  const [codexRootRequest, setCodexRootRequest] = useState(0);
  const [browserSlot, setBrowserSlot] = useState<HTMLDivElement | null>(null);
  const [sessionReminderBusy, setSessionReminderBusy] = useState(false);
  const [sessionReminderDue, setSessionReminderDue] = useState(false);
  const browserSlotRef = useCallback((node: HTMLDivElement | null) => setBrowserSlot(node), []);
  const browserSurfaceActive = surface === "browser";
  const needsBrowser = browser?.authenticated !== true;
  const setupComplete = snapshot.state.coreSetupComplete === true
    && snapshot.state.codexCatalogVerified === true
    && snapshot.state.mcpSetupComplete === true;
  const needsSetup = !needsBrowser && !setupComplete;
  const mcpNeedsSetup = !needsBrowser && snapshot.state.mcpSetupComplete !== true;
  const mcpRuntimeNeedsAttention = snapshot.state.mcpRuntimeInstalled === true
    && ["degraded", "error", "stale", "foreign"].includes(snapshot.runtime.lifecycle);
  const updateVisible = ["available", "downloading", "installing"].includes(snapshot.update.status);
  const updateBusy = snapshot.update.status === "downloading" || snapshot.update.status === "installing";
  const updateVersion = "version" in snapshot.update ? snapshot.update.version : null;

  useLayoutEffect(() => {
    let cancelled = false;
    let animationFrame = 0;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (!browserSlot) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const rect = browserSlot.getBoundingClientRect();
        void api!.setBrowserBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }).catch((cause) => setError(messageOf(cause)));
      });
    };

    void api!.setBrowserSurfaceActive(browserSurfaceActive).then(() => {
      if (cancelled || !browserSurfaceActive || !browserSlot) return;
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(browserSlot);
      window.addEventListener("resize", measure);
    }).catch((cause) => setError(messageOf(cause)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [browserSlot, browserSurfaceActive, setError]);

  useEffect(() => {
    const reminderAt = snapshot.state.sessionRefreshReminderAt;
    const reminderTime = reminderAt === null ? Number.NaN : Date.parse(reminderAt);
    if (browser?.authenticated !== true || !Number.isFinite(reminderTime)) {
      setSessionReminderDue(false);
      return;
    }
    const delay = reminderTime - Date.now();
    if (delay <= 0) {
      setSessionReminderDue(true);
      return;
    }
    setSessionReminderDue(false);
    const timer = window.setTimeout(() => setSessionReminderDue(true), delay);
    return () => window.clearTimeout(timer);
  }, [browser?.authenticated, snapshot.state.sessionRefreshReminderAt]);

  const activateBrowser = useCallback(async (show = false) => {
    setSurface("browser");
    await api!.setBrowserSurfaceActive(true);
    if (show) await api!.showBrowser();
  }, []);

  const navigateSurface = (next: Surface) => {
    setSurface(next);
  };

  const navigateCodexRoot = () => {
    setCodexRootRequest((request) => request + 1);
    navigateSurface("codex");
  };

  const installUpdate = async () => {
    setError(null);
    try {
      await api!.installUpdate();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const dismissSessionReminder = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      updateState(await api!.dismissSessionReminder());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  const logoutChatGpt = async () => {
    if (sessionReminderBusy) return;
    setSessionReminderBusy(true);
    setError(null);
    try {
      const result = await api!.logoutChatGpt();
      updateState(result.state);
      navigateSurface("browser");
      await api!.setBrowserSurfaceActive(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSessionReminderBusy(false);
    }
  };

  return (
    <motion.main
      animate={{ opacity: 1 }}
      className="app-shell"
      initial={{ opacity: 0 }}
    >
      <TitleBar />

      <aside className="app-sidebar">
        <div className="sidebar-clip">
          <div className="sidebar-content">
            <div className="sidebar-brand-row">
              <div className="sidebar-brand-identity">
                <BrandMark small />
                <strong>{copy.product}</strong>
              </div>
            </div>

          <div className={`sidebar-runtime-card is-${snapshot.runtime.lifecycle}`}>
              <button
                className="sidebar-runtime-overview"
                onClick={() => navigateSurface("runtime")}
                title={snapshot.runtime.detail || copy.runtimeServiceSubtitle}
                type="button"
              >
                <strong className="sidebar-runtime-lifecycle">
                  <StateDot state={runtimeDotState(snapshot.runtime)} />
                  {runtimeLifecycleLabel(copy, snapshot.runtime)}
                </strong>
                <Icon name="chevron" />
              </button>
              <RuntimeActionButtons compact copy={copy} runtime={snapshot.runtime} setError={setError} />
            </div>

            <nav className="sidebar-nav" aria-label={copy.workspace}>
              <SidebarGroup label={copy.workspace}>
                <SidebarItem
                  active={surface === "browser"}
                  badge={needsBrowser
                    ? <ActionDot pulse tone="required" />
                    : <StateDot state={browserTone(browser)} />}
                  icon="browser"
                  label={copy.browser}
                  onClick={() => navigateSurface("browser")}
                  subtitle={`${copy.browserTabMax} ${browser?.maxTabs ?? 5}`}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.configuration}>
                <SidebarItem
                  active={surface === "setup"}
                  badge={needsSetup ? <ActionDot pulse tone="required" /> : null}
                  icon="setup"
                  label={copy.setup}
                  onClick={() => navigateSurface("setup")}
                />
                <SidebarItem
                  active={surface === "codex"}
                  badge={snapshot.state.coreSetupComplete
                    && snapshot.runtime.lifecycle === "ready"
                    && !snapshot.state.bridgeEnabled
                    ? <ActionDot tone="error" />
                    : null}
                  icon="setup"
                  label={copy.codexConfig}
                  onClick={navigateCodexRoot}
                />
                <SidebarItem
                  active={surface === "mcp"}
                  badge={mcpRuntimeNeedsAttention
                    ? <ActionDot tone="error" />
                    : mcpNeedsSetup
                      ? <ActionDot pulse tone="required" />
                      : null}
                  icon="mcp"
                  label="MCP"
                  onClick={() => navigateSurface("mcp")}
                />
              </SidebarGroup>
              <SidebarGroup label={copy.runtime}>
                <SidebarItem
                  active={surface === "runtime"}
                  badge={snapshot.runtime.lifecycle === "ready"
                    ? <ActionDot tone="success" />
                    : snapshot.runtime.lifecycle === "stopped"
                      ? null
                      : <ActionDot tone="error" />}
                  icon="activity"
                  label={copy.runtimeService}
                  onClick={() => navigateSurface("runtime")}
                />
                <SidebarItem active={surface === "activity"} icon="activity" label={copy.activity} onClick={() => navigateSurface("activity")} />
              </SidebarGroup>
            </nav>

            <div className="sidebar-footer">
              {updateVisible ? (
                <SidebarItem
                  active={false}
                  disabled={updateBusy || operation?.status === "running" || browser?.status === "running"}
                  icon="update"
                  label={updateBusy ? copy.updating : `${copy.updateAvailable} v${updateVersion}`}
                  onClick={() => void installUpdate()}
                  tone="update"
                />
              ) : null}
              <SidebarItem
                active={surface === "settings"}
                icon="settings"
                label={copy.settings}
                onClick={() => navigateSurface("settings")}
              />
            </div>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            animate={{ opacity: 1 }}
            className="surface-transition"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            key={surface}
            transition={{ duration: 0.16 }}
          >
            {surface === "browser" ? (
              <BrowserSurface
                browser={browser}
                browserSlotRef={browserSlotRef}
                copy={copy}
                setError={setError}
              />
            ) : null}
            {surface === "setup" ? (
              <SetupSurface
                activateBrowser={activateBrowser}
                browser={browser}
                copy={copy}
                operation={operation}
                setError={setError}
                showMcp={() => setSurface("mcp")}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "codex" ? (
              <CodexConfigSurface
                copy={copy}
                operation={operation}
                rootRequest={codexRootRequest}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "mcp" ? (
              <McpSurface
                copy={copy}
                onDone={() => setSurface("setup")}
                openConnectors={async () => {
                  await activateBrowser();
                  await api!.openChatGptConnectors();
                }}
                operation={operation}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "runtime" ? (
              <RuntimeServiceSurface
                copy={copy}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
            {surface === "activity" ? (
              <ActivitySurface copy={copy} logs={logs} onActivityDeleted={onActivityDeleted} setError={setError} />
            ) : null}
            {surface === "settings" ? (
              <SettingsSurface
                copy={copy}
                setError={setError}
                snapshot={snapshot}
                updateState={updateState}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {sessionReminderDue ? (
          <SessionRefreshReminder
            busy={sessionReminderBusy}
            copy={copy}
            onDismiss={() => void dismissSessionReminder()}
            onLogout={() => void logoutChatGpt()}
          />
        ) : null}
      </AnimatePresence>
    </motion.main>
  );
}

function TitleBar() {
  return <header className="app-titlebar draggable" />;
}

function runtimeLifecycleLabel(copy: Copy, runtime: RuntimeStatus) {
  if (!runtime.configured) return copy.runtimeNotConfigured;
  const labels: Record<RuntimeStatus["lifecycle"], string> = {
    stopped: copy.runtimeStopped,
    starting: copy.runtimeStarting,
    ready: copy.runtimeReady,
    stopping: copy.runtimeStopping,
    degraded: copy.runtimeDegraded,
    error: copy.runtimeError,
    stale: copy.runtimeStale,
    foreign: copy.runtimeForeign,
  };
  return labels[runtime.lifecycle];
}

function runtimeDotState(runtime: RuntimeStatus): "idle" | "ready" | "busy" | "error" {
  if (runtime.lifecycle === "ready") return "ready";
  if (runtime.lifecycle === "starting" || runtime.lifecycle === "stopping") return "busy";
  if (runtime.lifecycle === "stopped") return "idle";
  return "error";
}

function RuntimeActionButtons({
  compact = false,
  copy,
  runtime,
  setError,
}: {
  compact?: boolean;
  copy: Copy;
  runtime: RuntimeStatus;
  setError: (error: string | null) => void;
}) {
  const [activeAction, setActiveAction] = useState<"start" | "stop" | "restart" | null>(null);
  const busy = activeAction !== null;
  const run = async (action: "start" | "stop" | "restart") => {
    if (busy) return;
    setActiveAction(action);
    setError(null);
    try {
      if (action === "start") await api!.startRuntime();
      else if (action === "stop") await api!.stopRuntime();
      else await api!.restartRuntime();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const unavailable = !runtime.configured || runtime.lifecycle === "foreign";
  const stopping = runtime.lifecycle === "stopping";
  const showStart = runtime.lifecycle === "stopped" || runtime.lifecycle === "stale";
  const showRestart = ["ready", "degraded", "error"].includes(runtime.lifecycle);
  const showStop = !["stopped", "foreign"].includes(runtime.lifecycle);
  return (
    <div className={`runtime-actions${compact ? " is-compact" : ""}`}>
      {showStart ? (
        <button className="runtime-inline-button is-primary" disabled={busy || unavailable || stopping} onClick={() => void run("start")} type="button">
          {activeAction === "start" ? <ButtonSpinner /> : null}
          {activeAction === "start" ? copy.startingRuntime : copy.startRuntime}
        </button>
      ) : null}
      {showRestart ? (
        <button className="runtime-inline-button" disabled={busy || unavailable || stopping} onClick={() => void run("restart")} type="button">
          {activeAction === "restart" ? <ButtonSpinner /> : null}
          {activeAction === "restart" ? copy.restartingRuntime : copy.restartRuntime}
        </button>
      ) : null}
      {showStop ? (
        <button className="runtime-inline-button" disabled={busy || stopping || runtime.lifecycle === "foreign"} onClick={() => void run("stop")} type="button">
          {activeAction === "stop" ? <ButtonSpinner /> : null}
          {activeAction === "stop" ? copy.stoppingRuntime : copy.stopRuntime}
        </button>
      ) : null}
    </div>
  );
}

function SidebarGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="sidebar-group">
      <h2>{label}</h2>
      <div>{children}</div>
    </section>
  );
}

function SidebarItem({
  active,
  badge,
  disabled = false,
  icon,
  label,
  onClick,
  subtitle,
  tone,
}: {
  active: boolean;
  badge?: ReactNode;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  subtitle?: string;
  tone?: "update";
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`sidebar-item${active ? " is-active" : ""}${subtitle ? " has-subtitle" : ""}${tone === "update" ? " is-update" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon name={icon} />
      <span className="sidebar-item-copy">
        <span>{label}</span>
        {subtitle ? <small>{subtitle}</small> : null}
      </span>
      {badge ? <i className="sidebar-item-badge">{badge}</i> : null}
    </button>
  );
}

function BrowserSurface({
  browser,
  browserSlotRef,
  copy,
  setError,
}: {
  browser: BrowserState | null;
  browserSlotRef: (node: HTMLDivElement | null) => void;
  copy: Copy;
  setError: (error: string | null) => void;
}) {
  const visible = browser?.visible === true;
  const navigationLocked = browser?.status === "running" || browser?.status === "testing";
  const navigate = async (action: "back" | "forward" | "reload") => {
    try {
      await api!.navigateBrowser(action);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const toggle = async () => {
    try {
      if (visible) await api!.hideBrowser();
      else await api!.showBrowser();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const selectTab = async (tabId: string) => {
    try {
      await api!.selectBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const closeTab = async (tabId: string) => {
    try {
      await api!.closeBrowserTab(tabId);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <section className="browser-surface">
      <div className="browser-tab-strip" title={copy.browserTabLimit}>
        {(browser?.tabs ?? []).map((tab) => (
          <div
            className={`browser-tab no-drag${tab.active ? " is-active" : ""}`}
            key={tab.id}
            onClick={() => void selectTab(tab.id)}
            role="tab"
            aria-selected={tab.active}
          >
            <BrandMark small />
            <span title={tab.traceId ? `${tab.title} · ${tab.traceId}` : tab.title}>
              {browserTabTitleFromTitle(tab.title, copy)}
            </span>
            {tab.loading ? <i className="tab-spinner" /> : <StateDot state={browserTabTone(tab.status)} />}
            {tab.closable ? (
              <button
                aria-label={copy.hideTab}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
                title={copy.hideTab}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
        ))}
        <div className="browser-tab-drag draggable" />
      </div>
      <div className="browser-toolbar">
        <div className="browser-history">
          <IconButton
            disabled={navigationLocked || !browser?.canGoBack}
            icon="back"
            label={copy.back}
            onClick={() => void navigate("back")}
          />
          <IconButton
            disabled={navigationLocked || !browser?.canGoForward}
            icon="forward"
            label={copy.forward}
            onClick={() => void navigate("forward")}
          />
          <IconButton disabled={navigationLocked || !visible} icon="reload" label={copy.reload} onClick={() => void navigate("reload")} />
        </div>
        <div className="browser-address" title={browser?.url || copy.browserAddress}>
          <Icon name="globe" />
          <span>{formatBrowserAddress(browser?.url, copy)}</span>
        </div>
        <button className="toolbar-text-button" onClick={() => void toggle()} type="button">
          {visible ? copy.hideBrowser : copy.openChatgpt}
        </button>
        {browser?.loading ? <i className="browser-loading-line" /> : null}
      </div>
      <div className="browser-viewport" ref={browserSlotRef}>
        {!visible ? (
          <div className="browser-empty">
            <BrandMark />
            <h1>{browser?.authenticated ? copy.noActiveTask : copy.stepAccount}</h1>
            <p>{browser?.authenticated ? copy.noActiveTaskBody : copy.stepAccountBody}</p>
            <PrimaryButton onClick={() => void toggle()}>
              {browser?.authenticated ? copy.openChatgpt : copy.signIn}
            </PrimaryButton>
          </div>
        ) : (
          <div className="browser-underlay" aria-hidden="true">
            <span>{copy.loading}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function SetupSurface({
  activateBrowser,
  browser,
  copy,
  operation,
  setError,
  showMcp,
  snapshot,
  updateState,
}: {
  activateBrowser: (show?: boolean) => Promise<void>;
  browser: BrowserState | null;
  copy: Copy;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  showMcp: () => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [activeAction, setActiveAction] = useState<"login" | "smoke" | "install" | null>(null);
  const busy = activeAction !== null
    || operation?.status === "running"
    || browser?.status === "loading"
    || browser?.status === "testing"
    || browser?.status === "running";
  const run = async (name: "login" | "smoke" | "install", action: () => Promise<void>) => {
    if (busy) return;
    setActiveAction(name);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const openLogin = () => run("login", async () => {
    await activateBrowser();
    await api!.openLogin();
  });
  const smoke = () => run("smoke", async () => {
    await activateBrowser();
    await api!.smokeTest();
    updateState((await api!.snapshot()).state);
  });
  const install = () => run("install", async () => {
    await api!.setupCore();
    updateState((await api!.snapshot()).state);
  });
  const codexIntegrationInstalled = snapshot.state.coreSetupComplete === true;
  return (
    <ContentSurface
      eyebrow={copy.required}
      subtitle={copy.setupSubtitle}
      title={copy.setupTitle}
    >
      <SectionHeading label={copy.coreSetup} />
      <div className="setup-list">
        <SetupRow
          action={browser?.authenticated
            ? copy.signedIn
            : browser?.status === "loading" ? copy.checkingSignIn : copy.signIn}
          complete={browser?.authenticated === true}
          description={copy.stepAccountBody}
          disabled={busy}
          index={1}
          loading={activeAction === "login"}
          onAction={openLogin}
          title={copy.stepAccount}
        />
        <SetupRow
          action={snapshot.smokePassed ? copy.smokePassed : activeAction === "smoke" ? copy.runningSmoke : copy.runSmoke}
          complete={snapshot.smokePassed}
          description={copy.stepSmokeBody}
          disabled={busy || !browser?.authenticated}
          index={2}
          loading={activeAction === "smoke"}
          onAction={smoke}
          title={copy.stepSmoke}
        />
        <SetupRow
          action={codexIntegrationInstalled
            ? copy.installed
            : activeAction === "install" ? copy.installingModels : copy.install}
          complete={codexIntegrationInstalled}
          description={copy.stepInstallBody}
          disabled={busy || !snapshot.smokePassed}
          index={3}
          loading={activeAction === "install"}
          onAction={install}
          title={copy.stepInstall}
        />
        <SetupRow
          action={snapshot.state.mcpSetupComplete
            ? copy.mcpReady
            : snapshot.state.mcpRuntimeInstalled ? copy.finishMcpSetup : copy.configureMcp}
          complete={snapshot.state.mcpSetupComplete === true}
          description={copy.stepMcpBody}
          disabled={busy || !codexIntegrationInstalled}
          index={4}
          onAction={showMcp}
          title={copy.stepMcp}
        />
      </div>

      {snapshot.state.codexRestartRequired && snapshot.state.mcpSetupComplete ? (
        <CodexRestartGuide copy={copy} disabled={busy} setError={setError} snapshot={snapshot} />
      ) : null}

    </ContentSurface>
  );
}

function CodexRestartGuide({
  copy,
  disabled = false,
  setError,
  snapshot,
}: {
  copy: Copy;
  disabled?: boolean;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
}) {
  const [starting, setStarting] = useState(false);
  const runtimeReady = snapshot.runtime.lifecycle === "ready";
  const runtimeCanStart = snapshot.runtime.configured
    && ["stopped", "stale"].includes(snapshot.runtime.lifecycle);

  const startRuntime = async () => {
    if (disabled || starting || !runtimeCanStart) return;
    setStarting(true);
    setError(null);
    try {
      await api!.startRuntime();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="codex-next-steps">
      <header>
        <strong>{copy.codexNextSteps}</strong>
        <span>{copy.codexNextStepsBody}</span>
      </header>
      <div className={`codex-next-step${runtimeReady ? " is-complete" : ""}`}>
        <span className="codex-step-index">{runtimeReady ? <Icon name="check" /> : "1"}</span>
        <div>
          <strong>{runtimeReady ? copy.lcaServiceReady : copy.startLcaService}</strong>
          <p>{runtimeReady ? copy.lcaServiceReadyBody : copy.startLcaServiceBody}</p>
        </div>
        {!runtimeReady && runtimeCanStart ? (
          <SecondaryButton
            disabled={disabled || starting}
            loading={starting}
            onClick={() => void startRuntime()}
          >
            {starting ? copy.startingRuntime : copy.startLcaServiceAction}
          </SecondaryButton>
        ) : null}
      </div>
      <div className={`codex-next-step${runtimeReady ? "" : " is-pending"}`}>
        <span className="codex-step-index">2</span>
        <div>
          <strong>{copy.restartCodexStep}</strong>
          <p>{copy.restartCodexStepBody}</p>
          <div className="codex-restart-options">
            <div>
              <b>{copy.codexCli}</b>
              <span>{copy.codexCliRestart}</span>
            </div>
            <div>
              <b>{copy.vscode}</b>
              <span>{copy.vscodeRestart}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodexConfigSurface({
  copy,
  operation,
  rootRequest,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  operation: OperationState | null;
  rootRequest: number;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [config, setConfig] = useState<CodexConfigSnapshot | null>(null);
  const [toolHealth, setToolHealth] = useState<CodexToolHealthReport | null>(null);
  const [manualContent, setManualContent] = useState("");
  const [manualDirty, setManualDirty] = useState(false);
  const [mode, setMode] = useState<"automatic" | "manual">("automatic");
  const [subview, setSubview] = useState<"config" | "codex-tools" | "vscode-advanced">("config");
  const [advancedConfig, setAdvancedConfig] = useState<VsCodeAdvancedSnapshot | null>(null);
  const [activeAction, setActiveAction] = useState<"install" | "restore" | "refresh" | "save" | null>(null);
  const busy = activeAction !== null || operation?.status === "running";

  useEffect(() => {
    setSubview("config");
  }, [rootRequest]);

  const refresh = useCallback(async () => {
    const next = await api!.codexConfig();
    setConfig(next);
    return next;
  }, []);

  const reloadManual = useCallback(async () => {
    const next = await api!.codexConfig();
    setConfig(next);
    setManualContent(next.content);
    setManualDirty(false);
    return next;
  }, []);

  const refreshAdvanced = useCallback(async () => {
    const next = await api!.vscodeAdvancedConfig();
    setAdvancedConfig(next);
    return next;
  }, []);

  useEffect(() => {
    if (operation?.status === "running") return;
    let cancelled = false;
    void Promise.all([api!.codexConfig(), api!.vscodeAdvancedConfig(), api!.codexToolHealth()]).then(([next, advanced, health]) => {
      if (!cancelled) {
        setConfig(next);
        setManualContent(next.content);
        setManualDirty(false);
        setAdvancedConfig(advanced);
        setToolHealth(health);
      }
    }).catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    });
    return () => { cancelled = true; };
  }, [operation?.status, setError]);

  useEffect(() => api!.onCodexToolHealthState(setToolHealth), []);

  const run = async (name: "install" | "restore", action: () => Promise<void>) => {
    if (busy) return;
    const beforeConfig = config;
    const beforeManualContent = manualContent;
    const beforeManualDirty = manualDirty;
    setActiveAction(name);
    setError(null);
    try {
      await action();
      updateState((await api!.snapshot()).state);
      await refresh();
    } catch (cause) {
      setConfig(beforeConfig);
      setManualContent(beforeManualContent);
      setManualDirty(beforeManualDirty);
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const installModels = () => run("install", async () => { await api!.setupCore(); });
  const refreshFromToolbar = async () => {
    if (busy) return;
    setActiveAction("refresh");
    setError(null);
    try {
      await reloadManual();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const restoreNative = () => run("restore", async () => {
    const result = await api!.restoreNativeCodex();
    if (!result.cancelled) updateState(result.state);
  });
  const saveManual = async () => {
    if (busy || !manualDirty) return;
    setActiveAction("save");
    setError(null);
    try {
      const result = await api!.saveCodexConfig(manualContent);
      setConfig(result.config);
      updateState(result.state);
      setManualDirty(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const modelsInstalled = config?.installed === true;
  const statusLabel = config?.state === "configured"
    ? copy.codexConfigured
    : config?.state === "disconnected"
      ? copy.codexDisconnected
      : config?.state === "inconsistent"
        ? copy.codexInconsistent
        : copy.notConfigured;
  const advancedStatusLabel = advancedConfig?.state === "configured"
    ? copy.vscodeAdvancedConfigured
    : advancedConfig?.managed && advancedConfig?.installed
      ? copy.vscodeAdvancedReadyForStart
      : advancedConfig?.state === "installed"
        ? copy.vscodeAdvancedProxyInstalled
        : advancedConfig?.state === "inconsistent"
          ? copy.vscodeAdvancedNeedsRepair
          : copy.vscodeAdvancedNotInstalled;
  const toolHealthStatusLabel = codexToolHealthSummary(copy, toolHealth);

  if (subview === "codex-tools") {
    return (
      <CodexToolHealthSurface
        copy={copy}
        initialHealth={toolHealth}
        onBack={() => setSubview("config")}
        onHealthChange={setToolHealth}
        operation={operation}
        runtime={snapshot.runtime}
        setError={setError}
      />
    );
  }

  if (subview === "vscode-advanced") {
    return (
      <VsCodeAdvancedSurface
        copy={copy}
        onBack={() => {
          setSubview("config");
          void refreshAdvanced();
        }}
        operation={operation}
        setError={setError}
      />
    );
  }

  return (
    <ContentSurface narrow subtitle={copy.codexConfigSubtitle} title={copy.codexConfigTitle}>
      <div className="config-mode-toolbar">
        <div className="config-mode-tabs" role="tablist" aria-label={copy.codexConfig}>
          <button className={mode === "automatic" ? "is-active" : ""} onClick={() => setMode("automatic")} role="tab" type="button">
            {copy.automatic}
          </button>
          <button className={mode === "manual" ? "is-active" : ""} onClick={() => setMode("manual")} role="tab" type="button">
            {copy.manual}
          </button>
        </div>
        <button className="text-button config-refresh-button" disabled={busy} onClick={() => void refreshFromToolbar()} type="button">
          {activeAction === "refresh" ? <ButtonSpinner /> : null}
          {activeAction === "refresh" ? copy.refreshing : copy.refresh}
        </button>
      </div>

      {mode === "automatic" ? (
        <div className="codex-config-panel">
          <div className="config-status-card">
            <div>
              <span>{copy.status}</span>
              <strong>{statusLabel}</strong>
            </div>
            <StateDot state={config?.state === "configured" ? "ready" : config?.state === "inconsistent" ? "error" : "busy"} />
          </div>
          <div className="config-detail-list">
            <div><span>{copy.configPath}</span><code>{config?.configPath ?? "~/.codex/config.toml"}</code></div>
            <div><span>{copy.route}</span><code>{config?.active ? config.routeUrl ?? copy.previousRoute : copy.previousRoute}</code></div>
          </div>
          {config?.errors.length ? (
            <NoticeRow icon="alert" tone="warning">{config.errors.join("; ")}</NoticeRow>
          ) : null}
          {config?.state === "configured" && snapshot.state.codexRestartRequired ? (
            <CodexRestartGuide copy={copy} disabled={busy} setError={setError} snapshot={snapshot} />
          ) : null}
          <p className="config-explainer">{copy.codexAutomaticBody}</p>
          <div className="inline-actions config-actions">
            <SecondaryButton disabled={busy} loading={activeAction === "install"} onClick={() => void installModels()}>
              {activeAction === "install"
                ? modelsInstalled ? copy.reinstallingModels : copy.installingModels
                : modelsInstalled ? copy.reinstallModels : copy.install}
            </SecondaryButton>
            <SecondaryButton disabled={busy || !config?.installed} loading={activeAction === "restore"} onClick={() => void restoreNative()}>
              {activeAction === "restore" ? copy.restoringNative : copy.restorePreviousRoute}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div className="codex-config-panel">
          <p className="config-explainer">{copy.codexManualBody}</p>
          <div className="config-file-header">
            <span>{config?.configPath ?? "~/.codex/config.toml"}</span>
            <div className="inline-actions">
              {manualDirty ? <span className="config-dirty-label">{copy.unsavedChanges}</span> : null}
              <SecondaryButton disabled={busy || !manualDirty} loading={activeAction === "save"} onClick={() => void saveManual()}>
                {activeAction === "save" ? copy.saving : copy.save}
              </SecondaryButton>
            </div>
          </div>
          {!config?.exists && !manualContent ? <p className="config-empty-hint">{copy.emptyConfig}</p> : null}
          <textarea
            className="config-file-content config-file-editor"
            disabled={busy}
            onChange={(event) => {
              setManualContent(event.target.value);
              setManualDirty(true);
            }}
            spellCheck={false}
            value={manualContent}
          />
        </div>
      )}

      <SectionHeading label={copy.codexToolHealthSection} meta={copy.automatic} spaced />
      <button className="next-surface-row" onClick={() => setSubview("codex-tools")} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.codexToolHealthTitle}</strong>
          <small>{copy.codexToolHealthSubtitle}</small>
        </span>
        <em>{toolHealthStatusLabel}</em>
        <Icon name="chevron" />
      </button>

      <SectionHeading label={copy.vscodeAdvancedSection} meta={copy.optional} spaced />
      <button className="next-surface-row" onClick={() => setSubview("vscode-advanced")} type="button">
        <Icon name="setup" />
        <span>
          <strong>{copy.vscodeAdvancedTitle}</strong>
          <small>{copy.vscodeAdvancedSubtitle}</small>
        </span>
        <em>{advancedStatusLabel}</em>
        <Icon name="chevron" />
      </button>
    </ContentSurface>
  );
}

function codexToolHealthSummary(copy: Copy, report: CodexToolHealthReport | null): string {
  if (!report?.checkedAt) return copy.codexToolHealthNotChecked;
  if (report.tools.some((tool) => tool.status === "failed" || tool.status === "missing")) return copy.codexToolHealthIssues;
  if (report.tools.every((tool) => tool.status === "working" || tool.status === "available")) return copy.codexToolHealthHealthy;
  return copy.codexToolUnknown;
}

function codexToolHealthStatusLabel(copy: Copy, status: CodexToolHealthStatus): string {
  if (status === "working") return copy.codexToolWorking;
  if (status === "available") return copy.codexToolAvailable;
  if (status === "failed") return copy.codexToolFailed;
  if (status === "missing") return copy.codexToolMissing;
  return copy.codexToolUnknown;
}

function CodexToolHealthSurface({
  copy,
  initialHealth,
  onBack,
  onHealthChange,
  operation,
  runtime,
  setError,
}: {
  copy: Copy;
  initialHealth: CodexToolHealthReport | null;
  onBack: () => void;
  onHealthChange: (health: CodexToolHealthReport) => void;
  operation: OperationState | null;
  runtime: RuntimeStatus;
  setError: (error: string | null) => void;
}) {
  const [health, setHealth] = useState<CodexToolHealthReport | null>(initialHealth);
  const [checking, setChecking] = useState(false);
  const busy = checking || operation?.status === "running";
  const runtimeReady = runtime.lifecycle === "ready";

  const updateHealth = useCallback((next: CodexToolHealthReport) => {
    setHealth(next);
    onHealthChange(next);
  }, [onHealthChange]);

  useEffect(() => {
    let cancelled = false;
    void api!.codexToolHealth().then((next) => {
      if (!cancelled) updateHealth(next);
    }).catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    });
    const unsubscribe = api!.onCodexToolHealthState((next) => {
      if (!cancelled) updateHealth(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setError, updateHealth]);

  const check = async () => {
    if (busy || !runtimeReady) return;
    setChecking(true);
    setError(null);
    try {
      updateHealth(await api!.checkCodexTools());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setChecking(false);
    }
  };

  const summary = codexToolHealthSummary(copy, health);
  const summaryState = summary === copy.codexToolHealthHealthy
    ? "ready"
    : summary === copy.codexToolHealthIssues
      ? "error"
      : "busy";

  return (
    <ContentSurface narrow subtitle={copy.codexToolHealthSubtitle} title={copy.codexToolHealthTitle}>
      <button className="text-button nested-surface-back" onClick={onBack} type="button">
        <Icon name="back" />
        {copy.codexConfig}
      </button>
      <div className="codex-config-panel">
        <div className="config-status-card">
          <div>
            <span>{copy.status}</span>
            <strong>{summary}</strong>
          </div>
          <StateDot state={summaryState} />
        </div>
        <p className="config-explainer">{copy.codexToolHealthBody}</p>
        <div className="codex-tool-health-card">
          <header>
            <div>
              <strong>{copy.codexToolHealthTitle}</strong>
              <span>
                {health?.checkedAt
                  ? `${copy.codexToolHealthLastChecked}: ${new Date(health.checkedAt).toLocaleString()}`
                  : copy.codexToolHealthNotChecked}
              </span>
            </div>
            <SecondaryButton disabled={busy || !runtimeReady} loading={checking} onClick={() => void check()}>
              {checking ? copy.checkingCodexTools : copy.checkCodexTools}
            </SecondaryButton>
          </header>
          <div className="codex-tool-health-list">
            {health?.tools.map((tool) => (
              <div className="codex-tool-health-row" key={tool.name}>
                <code>{tool.name}</code>
                <span className={`codex-tool-health-status is-${tool.status}`}>{codexToolHealthStatusLabel(copy, tool.status)}</span>
                <small>{tool.detail}</small>
              </div>
            ))}
          </div>
        </div>
        {!runtimeReady ? <NoticeRow icon="alert" tone="warning">{copy.codexToolHealthRuntimeRequired}</NoticeRow> : null}
      </div>
    </ContentSurface>
  );
}

function VsCodeAdvancedSurface({
  copy,
  onBack,
  operation,
  setError,
}: {
  copy: Copy;
  onBack: () => void;
  operation: OperationState | null;
  setError: (error: string | null) => void;
}) {
  const [config, setConfig] = useState<VsCodeAdvancedSnapshot | null>(null);
  const [mode, setMode] = useState<"automatic" | "manual">("automatic");
  const [activeAction, setActiveAction] = useState<"setup" | "proxy" | "remove" | "refresh" | null>(null);
  const busy = activeAction !== null || operation?.status === "running";

  const refresh = useCallback(async () => {
    const next = await api!.vscodeAdvancedConfig();
    setConfig(next);
    return next;
  }, []);

  useEffect(() => {
    if (operation?.status === "running") return;
    let cancelled = false;
    void api!.vscodeAdvancedConfig().then((next) => {
      if (!cancelled) setConfig(next);
    }).catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    });
    return () => { cancelled = true; };
  }, [operation?.status, setError]);

  const run = async (name: "setup" | "proxy" | "remove", action: () => Promise<VsCodeAdvancedSnapshot>) => {
    if (busy) return;
    setActiveAction(name);
    setError(null);
    try {
      setConfig(await action());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const refreshFromToolbar = async () => {
    if (busy) return;
    setActiveAction("refresh");
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };

  const statusLabel = config?.state === "configured"
    ? copy.vscodeAdvancedConfigured
    : config?.managed && config?.installed
      ? copy.vscodeAdvancedReadyForStart
      : config?.state === "installed"
        ? copy.vscodeAdvancedProxyInstalled
        : config?.state === "inconsistent"
          ? copy.vscodeAdvancedNeedsRepair
          : copy.vscodeAdvancedNotInstalled;
  const proxyPath = config?.proxyPath ?? "~/.lca-codex/bin/lca-codex-proxy";
  const settingsPath = config?.settingsPath || "VS Code settings.json";
  const manualSnippet = `"chatgpt.cliExecutable": ${JSON.stringify(proxyPath)}`;

  return (
    <ContentSurface narrow subtitle={copy.vscodeAdvancedSubtitle} title={copy.vscodeAdvancedTitle}>
      <button className="text-button nested-surface-back" onClick={onBack} type="button">
        <Icon name="back" />
        {copy.codexConfig}
      </button>
      <div className="config-mode-toolbar">
        <div className="config-mode-tabs" role="tablist" aria-label={copy.vscodeAdvanced}>
          <button className={mode === "automatic" ? "is-active" : ""} onClick={() => setMode("automatic")} role="tab" type="button">
            {copy.automatic}
          </button>
          <button className={mode === "manual" ? "is-active" : ""} onClick={() => setMode("manual")} role="tab" type="button">
            {copy.manual}
          </button>
        </div>
        <button className="text-button config-refresh-button" disabled={busy} onClick={() => void refreshFromToolbar()} type="button">
          {activeAction === "refresh" ? <ButtonSpinner /> : null}
          {activeAction === "refresh" ? copy.refreshing : copy.refresh}
        </button>
      </div>

      {mode === "automatic" ? (
        <div className="codex-config-panel">
          <div className="config-status-card">
            <div>
              <span>{copy.status}</span>
              <strong>{statusLabel}</strong>
            </div>
            <StateDot state={config?.state === "configured" || (config?.managed && config?.installed) ? "ready" : config?.state === "inconsistent" ? "error" : "busy"} />
          </div>
          <div className="config-detail-list">
            <div><span>{copy.vscodeAdvancedSettingsPath}</span><code>{settingsPath}</code></div>
            <div><span>{copy.vscodeAdvancedProxyPath}</span><code>{proxyPath}</code></div>
          </div>
          <p className="config-explainer">{copy.vscodeAdvancedAutomaticBody}</p>
          <NoticeRow icon="alert" tone="warning">{copy.vscodeAdvancedFallback}</NoticeRow>
          {config?.errors.length ? <NoticeRow icon="alert" tone="warning">{config.errors.join("; ")}</NoticeRow> : null}
          {config?.reloadRequired ? <NoticeRow icon="alert" tone="warning">{copy.reloadVsCodeAdvanced}</NoticeRow> : null}
          <div className="inline-actions config-actions">
            <SecondaryButton disabled={busy} loading={activeAction === "setup"} onClick={() => void run("setup", () => api!.setupVsCodeAdvanced())}>
              {activeAction === "setup" ? copy.settingUpVsCodeAdvanced : config?.installed ? copy.repairVsCodeAdvanced : copy.setupVsCodeAdvanced}
            </SecondaryButton>
            <SecondaryButton disabled={busy || !config?.installed} loading={activeAction === "remove"} onClick={() => void run("remove", () => api!.removeVsCodeAdvanced())}>
              {activeAction === "remove" ? copy.removingVsCodeAdvanced : copy.removeVsCodeAdvanced}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div className="codex-config-panel">
          <p className="config-explainer">{copy.vscodeAdvancedManualBody}</p>
          <div className="config-detail-list">
            <div><span>{copy.vscodeAdvancedSettingsPath}</span><code>{settingsPath}</code></div>
            <div><span>{copy.vscodeAdvancedProxyPath}</span><code>{proxyPath}</code></div>
          </div>
          <div className="config-file-header"><span>{copy.vscodeAdvancedSnippet}</span></div>
          <pre className="config-file-content vscode-advanced-snippet">{manualSnippet}</pre>
          <NoticeRow icon="alert" tone="warning">{copy.vscodeAdvancedFallback}</NoticeRow>
          {config?.errors.length ? <NoticeRow icon="alert" tone="warning">{config.errors.join("; ")}</NoticeRow> : null}
          <div className="inline-actions config-actions">
            <SecondaryButton disabled={busy} loading={activeAction === "proxy"} onClick={() => void run("proxy", () => api!.installVsCodeAdvancedProxy())}>
              {activeAction === "proxy" ? copy.installingVsCodeProxy : copy.installVsCodeProxy}
            </SecondaryButton>
            <SecondaryButton disabled={busy || !config?.installed} loading={activeAction === "remove"} onClick={() => void run("remove", () => api!.removeVsCodeAdvanced())}>
              {activeAction === "remove" ? copy.removingVsCodeAdvanced : copy.removeVsCodeAdvanced}
            </SecondaryButton>
          </div>
        </div>
      )}
    </ContentSurface>
  );
}

function McpSurface({
  copy,
  onDone,
  openConnectors,
  operation,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  onDone: () => void;
  openConnectors: () => Promise<void>;
  operation: OperationState | null;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [step, setStep] = useState(Math.min(2, Math.max(0, snapshot.state.mcpGuideStep || 0)));
  const [tunnelId, setTunnelId] = useState("");
  const [runtimeKey, setRuntimeKey] = useState("");
  const [connectorName, setConnectorName] = useState(snapshot.state.connectorName);
  const [credentialsConfigured, setCredentialsConfigured] = useState(snapshot.mcpCredentialsConfigured);
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const [activeAction, setActiveAction] = useState<"connect" | "verify" | null>(null);
  const busy = activeAction !== null || operation?.status === "running";
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const steps = useMemo(() => [
    { title: copy.mcpStepOne, body: copy.mcpStepOneBody },
    { title: copy.mcpStepTwo, body: copy.mcpStepTwoBody },
    { title: copy.mcpStepThree, body: copy.mcpStepThreeBody },
  ], [copy]);

  const move = async (next: number) => {
    setStep(next);
    updateState(await api!.setMcpStep(next));
  };
  const safeMove = async (next: number) => {
    if (busy) return;
    setError(null);
    try {
      await move(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const openExternal = async (url: string) => {
    setError(null);
    try {
      await api!.openExternal(url);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const install = async () => {
    if (busy) return;
    setActiveAction("connect");
    setError(null);
    try {
      await api!.setupMcp({
        connectorName: connectorName.trim(),
        ...(credentialsConfigured && !replacingCredentials
          ? { replace: false }
          : { tunnelId, runtimeKey, replace: true }),
      });
      setRuntimeKey("");
      setTunnelId("");
      setCredentialsConfigured(true);
      setReplacingCredentials(false);
      updateState((await api!.snapshot()).state);
      await move(2);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const verify = async () => {
    if (busy || snapshot.runtime.lifecycle !== "ready") return;
    setActiveAction("verify");
    setError(null);
    setDoctor(null);
    try {
      setDoctor(await api!.verifyMcp());
      updateState((await api!.snapshot()).state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <ContentSurface fit subtitle={copy.mcpSubtitle} title="MCP">
      {snapshot.state.coreSetupComplete !== true ? (
        <NoticeRow icon="setup" tone="warning">{copy.stepInstallBody}</NoticeRow>
      ) : null}

      <div className="wizard-stepper" aria-label={`${step + 1} / 3`}>
        {steps.map((item, index) => (
          <button
            className={`${index === step ? "is-active" : ""}${index < step ? " is-complete" : ""}`}
            disabled={busy || index > step}
            key={item.title}
            onClick={() => void safeMove(index)}
            type="button"
          >
            <span>{index < step ? <Icon name="check" /> : index + 1}</span>
            <em>{item.title}</em>
          </button>
        ))}
      </div>

      <div className="mcp-stage">
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            animate={{ opacity: 1, x: 0 }}
            className="wizard-content"
            exit={{ opacity: 0, x: -8 }}
            initial={{ opacity: 0, x: 8 }}
            key={step}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <header>
              <span>0{step + 1}</span>
              <div>
                <h2>{steps[step]!.title}</h2>
                <p>{steps[step]!.body}</p>
              </div>
            </header>

            {step === 0 ? (
              <div className="inline-actions">
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.tunnels)}>
                  {copy.openTunnels}
                </SecondaryButton>
                <SecondaryButton icon="external" onClick={() => void openExternal(snapshot.urls.keys)}>
                  {copy.openKeys}
                </SecondaryButton>
              </div>
            ) : null}
            {step === 1 ? (
              <div className="mcp-config-fields">
                <div className="field-list">
                  <FieldRow label={copy.connectorName}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      maxLength={80}
                      onChange={(event) => setConnectorName(event.target.value)}
                      placeholder={copy.connectorNamePlaceholder}
                      spellCheck={false}
                      value={connectorName}
                    />
                  </FieldRow>
                </div>
                {credentialsConfigured && !replacingCredentials ? (
                <div className="saved-credentials">
                  <NoticeRow icon="check" tone="success">
                    <span>
                      <strong>{copy.credentialsConfigured}</strong>
                      <small>{copy.credentialsConfiguredBody}</small>
                    </span>
                  </NoticeRow>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setReplacingCredentials(true)}
                    type="button"
                  >
                    {copy.replaceCredentials}
                  </button>
                </div>
              ) : (
                <div className="field-list">
                  <FieldRow label={copy.tunnelId}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setTunnelId(event.target.value)}
                      placeholder="tunnel_…"
                      spellCheck={false}
                      value={tunnelId}
                    />
                  </FieldRow>
                  <FieldRow label={copy.runtimeKey}>
                    <input
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={(event) => setRuntimeKey(event.target.value)}
                      placeholder="sk-…"
                      spellCheck={false}
                      type="password"
                      value={runtimeKey}
                    />
                  </FieldRow>
                  {credentialsConfigured ? (
                    <button
                      className="text-button keep-credentials"
                      disabled={busy}
                      onClick={() => {
                        setTunnelId("");
                        setRuntimeKey("");
                        setReplacingCredentials(false);
                      }}
                      type="button"
                    >
                      {copy.keepCredentials}
                    </button>
                  ) : null}
                </div>
              )}
              </div>
            ) : null}
            {step === 1 ? <p className="mcp-step-two-hint">{copy.mcpStepTwoHint}</p> : null}
            {step === 2 ? (
              <div className="connector-actions">
                <div className="connector-name">
                  <span>{copy.connectorName}</span>
                  <code>{snapshot.state.connectorName || connectorName.trim()}</code>
                </div>
                <div className="inline-actions">
                  <SecondaryButton
                    icon="browser"
                    onClick={() => void (async () => {
                      setError(null);
                      try {
                        await openConnectors();
                      } catch (cause) {
                        setError(messageOf(cause));
                      }
                    })()}
                  >
                    {copy.openConnectors}
                  </SecondaryButton>
                </div>
                {doctor ? <DoctorSummary copy={copy} report={doctor} /> : null}
              </div>
            ) : null}
          </motion.section>
        </AnimatePresence>
      </div>

      <div className="wizard-footer">
        <button className="text-button" disabled={step === 0 || busy} onClick={() => void safeMove(step - 1)} type="button">
          {copy.previous}
        </button>
        {step === 0 ? <PrimaryButton disabled={busy} onClick={() => void safeMove(1)}>{copy.next}</PrimaryButton> : null}
        {step === 1 ? (
          <PrimaryButton
            disabled={
              busy
              || snapshot.state.coreSetupComplete !== true
              || !connectorName.trim()
              || connectorName.trim().length > 80
              || ((!credentialsConfigured || replacingCredentials) && (!tunnelId || !runtimeKey))
            }
            loading={activeAction === "connect"}
            onClick={() => void install()}
          >
            {activeAction === "connect" ? copy.connectingBridge : credentialsConfigured && !replacingCredentials ? copy.reconnect : copy.connect}
          </PrimaryButton>
        ) : null}
        {step === 2 ? (
          <PrimaryButton
            disabled={busy || snapshot.runtime.lifecycle !== "ready"}
            loading={activeAction === "verify"}
            onClick={() => void (doctor?.ok ? onDone() : verify())}
          >
            {activeAction === "verify"
              ? operation?.name === "mcp-verification" && operation.status === "running"
                ? operation.message
                : copy.verifyingRuntime
              : doctor?.ok ? copy.done : copy.verifyRuntime}
          </PrimaryButton>
        ) : null}
      </div>
    </ContentSurface>
  );
}

function RuntimeServiceSurface({
  copy,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const runtime = snapshot.runtime;
  const endpoint = runtime.port.port ? `${runtime.port.host}:${runtime.port.port}` : "—";
  return (
    <ContentSurface
      narrow
      subtitle={copy.runtimeServiceSubtitle}
      title={copy.runtimeServiceTitle}
    >
      <div className={`runtime-service-hero is-${runtime.lifecycle}`}>
        <div className="runtime-service-status">
          <StateDot state={runtimeDotState(runtime)} />
          <div>
            <strong>{runtimeLifecycleLabel(copy, runtime)}</strong>
            <small>{runtime.detail || copy.runtimeStatusHealthy}</small>
          </div>
        </div>
        <RuntimeActionButtons copy={copy} runtime={runtime} setError={setError} />
      </div>

      <SectionHeading label={copy.runtimeDetails} spaced />
      <div className="runtime-detail-list">
        <RuntimeDetail label={copy.runtimeEndpoint} value={endpoint} />
        <RuntimeDetail label={copy.runtimeResponses} value={runtime.daemon.pid ? `PID ${runtime.daemon.pid} · ${runtime.daemon.healthy ? copy.healthy : copy.needsAttention}` : copy.runtimeStopped} />
        <RuntimeDetail
          label={copy.runtimeBroker}
          value={runtime.broker
            ? `${runtime.broker.path} · ${runtime.broker.ready ? copy.runtimeReady : copy.needsAttention}`
            : copy.runtimeStopped}
        />
        <RuntimeDetail
          label={copy.runtimeTunnel}
          value={runtime.tunnel?.ready
            ? `${runtime.tunnel.pid ? `PID ${runtime.tunnel.pid} · ` : ""}${copy.runtimeReady}`
            : runtime.tunnel?.state && runtime.tunnel.state !== "stopped"
              ? `${runtime.tunnel.pid ? `PID ${runtime.tunnel.pid} · ` : ""}${runtime.tunnel.state}`
              : copy.runtimeStopped}
        />
        <RuntimeDetail label={copy.runtimeOwner} value={runtime.owner} />
      </div>

      <SectionHeading label={copy.runtimeBehavior} spaced />
      <div className="settings-list">
        <SettingRow body={copy.startRuntimeAutomaticallyBody} label={copy.startRuntimeAutomatically}>
          <Switch
            checked={snapshot.state.runtimeAutoStart}
            onChange={(checked) => void api!.setPreference("runtimeAutoStart", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
      </div>
    </ContentSurface>
  );
}

function RuntimeDetail({ description, label, value }: { description?: string; label: string; value: string }) {
  return (
    <div className={`runtime-detail-row${description ? " has-description" : ""}`}>
      <span>{label}</span>
      <div className="runtime-detail-value">
        <strong>{value}</strong>
        {description ? <small>{description}</small> : null}
      </div>
    </div>
  );
}

type ActivitySource = ActivityTaskSummary["source"];
type ActivityTaskStatus = ActivityTaskSummary["status"];
type ActivityToolSummary = ActivityTaskSummary["tools"][number];

interface ActivityTaskGroup extends ActivityTaskSummary {
  records: LogRecord[];
}

function ActivitySourceFlag({ source }: { source: ActivitySource }) {
  return (
    <span className={`activity-source-flag is-${source}`}>
      {activitySourceLabel(source)}
    </span>
  );
}

function ActivityRecordRow({ grouped, record }: {
  grouped: boolean;
  record: LogRecord;
}) {
  const source = activityRecordSource(record);
  return (
    <div className={`activity-row is-source-${source}`}>
      <ActivitySourceFlag source={source} />
      <StateDot state={record.level === "error" ? "error" : record.level === "warning" ? "busy" : "ready"} />
      <div>
        <strong>{humanEvent(record.event)}</strong>
        <span>{logDetail(record.event, record.detail, grouped)}</span>
      </div>
      <time>{formatTime(record.at)}</time>
    </div>
  );
}

function ActivityTaskCard({ copy, deleting, expanded, group, loading, onDelete, onToggle, records }: {
  copy: Copy;
  deleting: boolean;
  expanded: boolean;
  group: ActivityTaskSummary;
  loading: boolean;
  onDelete: () => void;
  onToggle: () => void;
  records: LogRecord[];
}) {
  const toolMeta = activityTaskToolMeta(group);
  return (
    <section className={`activity-task is-${group.status}`}>
      <button
        aria-expanded={expanded}
        className="activity-task-header"
        onClick={onToggle}
        type="button"
      >
        <Icon name="chevron" />
        <span className="activity-task-heading">
          <span className="activity-task-title-line">
            <strong title={activityTaskTooltip(group)}>{activityTaskTitle(group)}</strong>
            <span className={`activity-task-status is-${group.status}`}>
              {activityTaskStatusLabel(group)}
            </span>
          </span>
          <small>{activityTaskMeta(group)}</small>
          <small className="activity-task-tools" title={toolMeta}>{toolMeta}</small>
        </span>
        <time>{formatTime(group.startedAt)}</time>
      </button>
      <div className="activity-delete-action">
        <IconButton disabled={deleting} icon="trash" label={copy.deleteTaskActivity} onClick={onDelete} />
      </div>
      {expanded ? (
        <div className="activity-task-records">
          {loading ? (
            <div className="activity-chat-loading">
              <ButtonSpinner />
              <span>{copy.loadingActivityTask}</span>
            </div>
          ) : records.length > 0 ? (
            [...records].reverse().map((record, index) => (
              <ActivityRecordRow grouped key={`${record.at}-${record.event}-${index}`} record={record} />
            ))
          ) : (
            <div className="activity-chat-empty">{copy.noActivityEvents}</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ActivityChatCard({
  chat,
  copy,
  expanded,
  expandedTasks,
  deleting,
  loading,
  loadingTaskRecords,
  liveRecords,
  now,
  onDelete,
  onDeleteTask,
  onToggle,
  onToggleTask,
  systemRecords,
  taskRecords,
  tasks,
}: {
  chat: ActivityChatSummary;
  copy: Copy;
  deleting: boolean;
  expanded: boolean;
  expandedTasks: Record<string, boolean>;
  loading: boolean;
  loadingTaskRecords: Record<string, boolean>;
  liveRecords: LogRecord[];
  now: number;
  onDelete: () => void;
  onDeleteTask: (task: ActivityTaskSummary) => void;
  onToggle: () => void;
  onToggleTask: (task: ActivityTaskSummary) => void;
  systemRecords: LogRecord[];
  taskRecords: Record<string, LogRecord[]>;
  tasks: ActivityTaskSummary[];
}) {
  const liveActivity = useMemo(() => groupActivityLogs(liveRecords, now), [liveRecords, now]);
  const visibleTasks = useMemo(
    () => mergeActivityTaskSummaries(tasks, liveActivity.tasks),
    [tasks, liveActivity.tasks],
  );
  const liveTaskRecords = useMemo(
    () => new Map(liveActivity.tasks.map((task) => [task.traceId, task.records] as const)),
    [liveActivity.tasks],
  );
  const visibleSystemRecords = useMemo(
    () => mergeLogRecords(systemRecords, liveActivity.system),
    [systemRecords, liveActivity.system],
  );
  const taskLabel = chat.taskCount === 1 ? "1 task" : `${chat.taskCount} tasks`;
  const eventLabel = chat.eventCount === 1 ? "1 event" : `${chat.eventCount} events`;

  return (
    <section className="activity-task activity-chat">
      <button
        aria-expanded={expanded}
        className="activity-task-header activity-chat-header"
        onClick={onToggle}
        type="button"
      >
        <Icon name="chevron" />
        <span className="activity-task-heading">
          <span className="activity-task-title-line">
            <strong title={chat.threadId ? `Chat ID: ${chat.threadId}` : chat.title}>{chat.title}</strong>
          </span>
          <small>{chat.kind === "system" ? eventLabel : `${taskLabel} · ${eventLabel}`}</small>
        </span>
        <time>{formatTime(chat.lastAt)}</time>
      </button>
      {chat.kind !== "system" ? (
        <div className="activity-delete-action">
          <IconButton disabled={deleting} icon="trash" label={copy.deleteChatActivity} onClick={onDelete} />
        </div>
      ) : null}
      {expanded ? (
        <div className="activity-chat-body">
          {loading ? (
            <div className="activity-chat-loading">
              <ButtonSpinner />
              <span>{chat.kind === "system" ? copy.loadingActivityTask : copy.loadingActivityChat}</span>
            </div>
          ) : chat.kind === "system" ? (
            visibleSystemRecords.length > 0 ? (
              <div className="activity-task-records activity-chat-system-records">
                {[...visibleSystemRecords].reverse().map((record, index) => (
                  <ActivityRecordRow grouped={false} key={`${record.at}-${record.event}-${index}`} record={record} />
                ))}
              </div>
            ) : <div className="activity-chat-empty">{copy.noLogs}</div>
          ) : visibleTasks.length > 0 ? (
            visibleTasks.map((task) => {
              const expandedTask = expandedTasks[task.traceId] === true;
              const records = mergeLogRecords(
                taskRecords[task.traceId] ?? [],
                liveTaskRecords.get(task.traceId) ?? [],
              );
              return (
                <ActivityTaskCard
                  copy={copy}
                  deleting={deleting}
                  expanded={expandedTask}
                  group={task}
                  key={task.traceId}
                  loading={loadingTaskRecords[task.traceId] === true}
                  onDelete={() => onDeleteTask(task)}
                  onToggle={() => onToggleTask(task)}
                  records={records}
                />
              );
            })
          ) : (
            <div className="activity-chat-empty">{copy.noActivityTasks}</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ActivitySurface({
  copy,
  logs,
  onActivityDeleted,
  setError,
}: {
  copy: Copy;
  logs: LogRecord[];
  onActivityDeleted: (input: ActivityDeleteInput) => void;
  setError: (error: string | null) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [chats, setChats] = useState<ActivityChatSummary[]>([]);
  const [expandedChats, setExpandedChats] = useState<Record<string, boolean>>({});
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [chatTasks, setChatTasks] = useState<Record<string, ActivityTaskSummary[]>>({});
  const [taskRecords, setTaskRecords] = useState<Record<string, LogRecord[]>>({});
  const [systemRecords, setSystemRecords] = useState<LogRecord[] | null>(null);
  const [loadingChats, setLoadingChats] = useState<Record<string, boolean>>({});
  const [loadingTaskRecords, setLoadingTaskRecords] = useState<Record<string, boolean>>({});
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [deletingActivity, setDeletingActivity] = useState(false);
  const liveRecordsByChat = useMemo(() => groupActivityRecordsByChat(logs), [logs]);
  const liveChats = useMemo(() => summarizeActivityChatGroups(liveRecordsByChat), [liveRecordsByChat]);
  const visibleChats = useMemo(() => mergeActivityChatSummaries(chats, liveChats), [chats, liveChats]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setLoadingHistory(true);
    void api.activityChatsPage({ limit: 20 }).then((page) => {
      if (cancelled) return;
      setChats(page.chats);
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
    }).catch((cause) => {
      if (!cancelled) setError(messageOf(cause));
    }).finally(() => {
      if (!cancelled) setLoadingHistory(false);
    });
    return () => { cancelled = true; };
  }, [setError]);

  const toggleChat = (chat: ActivityChatSummary) => {
    const expanded = expandedChats[chat.id] === true;
    setExpandedChats((current) => ({ ...current, [chat.id]: !expanded }));
    const loaded = chat.kind === "system" ? systemRecords !== null : chatTasks[chat.id] !== undefined;
    if (expanded || loaded || loadingChats[chat.id] || !api) return;

    setLoadingChats((current) => ({ ...current, [chat.id]: true }));
    const request = chat.kind === "system"
      ? api.activitySystemRecords().then((records) => setSystemRecords(records))
      : api.activityChatTasks({ chatId: chat.id }).then((tasks) => {
          setChatTasks((current) => ({ ...current, [chat.id]: tasks }));
        });
    void request.catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoadingChats((current) => ({ ...current, [chat.id]: false })));
  };

  const toggleTask = (task: ActivityTaskSummary) => {
    const expanded = expandedTasks[task.traceId] === true;
    setExpandedTasks((current) => ({ ...current, [task.traceId]: !expanded }));
    if (expanded || taskRecords[task.traceId] !== undefined || loadingTaskRecords[task.traceId] || !api) return;

    setLoadingTaskRecords((current) => ({ ...current, [task.traceId]: true }));
    void api.activityTaskRecords({ traceId: task.traceId }).then((records) => {
      setTaskRecords((current) => ({ ...current, [task.traceId]: records }));
    }).catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoadingTaskRecords((current) => ({ ...current, [task.traceId]: false })));
  };

  const deleteActivity = async (input: ActivityDeleteInput, confirmation: string) => {
    if (!api || deletingActivity || !window.confirm(confirmation)) return;
    setDeletingActivity(true);
    try {
      await api.deleteActivity(input);
      onActivityDeleted(input);
      const page = await api.activityChatsPage({ limit: 20 });
      setChats(page.chats);
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
      setExpandedChats({});
      setExpandedTasks({});
      setChatTasks({});
      setTaskRecords({});
      setSystemRecords(null);
      setLoadingChats({});
      setLoadingTaskRecords({});
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDeletingActivity(false);
    }
  };

  const loadOlder = () => {
    if (!api || loadingHistory || !hasMoreHistory || !historyCursor) return;
    setLoadingHistory(true);
    void api.activityChatsPage({ cursor: historyCursor, limit: 20 }).then((page) => {
      setChats((current) => mergeActivityChatSummaries(current, page.chats));
      setHistoryCursor(page.nextCursor);
      setHasMoreHistory(page.hasMore);
    }).catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoadingHistory(false));
  };

  return (
    <ContentSurface subtitle={copy.activitySubtitle} title={copy.activityTitle}>
      <div className="section-heading activity-heading">
        <span>{copy.recentActivity}</span>
        <div className="inline-actions">
          <SecondaryButton
            disabled={deletingActivity || visibleChats.length === 0}
            icon="trash"
            onClick={() => void deleteActivity({ scope: "all" }, copy.confirmDeleteAllActivity)}
          >
            {copy.deleteAllActivity}
          </SecondaryButton>
          <SecondaryButton
            icon="external"
            onClick={() => void api!.openLogs().catch((cause) => setError(messageOf(cause)))}
          >
            {copy.openLogFolder}
          </SecondaryButton>
        </div>
      </div>
      <div className="activity-table">
        {!loadingHistory && visibleChats.length === 0 ? (
          <div className="surface-empty">
            <Icon name="logs" />
            <span>{copy.noLogs}</span>
          </div>
        ) : null}
        {visibleChats.map((chat) => {
          const liveRecords = liveRecordsByChat.get(chat.id) ?? [];
          return (
            <ActivityChatCard
              chat={chat}
              copy={copy}
              deleting={deletingActivity}
              expanded={expandedChats[chat.id] === true}
              expandedTasks={expandedTasks}
              key={chat.id}
              loading={loadingChats[chat.id] === true}
              loadingTaskRecords={loadingTaskRecords}
              liveRecords={liveRecords}
              now={now}
              onDelete={() => void deleteActivity({ scope: "chat", chatId: chat.id }, copy.confirmDeleteChatActivity)}
              onDeleteTask={(task) => void deleteActivity({ scope: "task", traceId: task.traceId }, copy.confirmDeleteTaskActivity)}
              onToggle={() => toggleChat(chat)}
              onToggleTask={toggleTask}
              systemRecords={systemRecords ?? []}
              taskRecords={taskRecords}
              tasks={chatTasks[chat.id] ?? []}
            />
          );
        })}
        {hasMoreHistory ? (
          <div className="activity-pagination">
            <SecondaryButton disabled={loadingHistory} onClick={loadOlder}>
              {loadingHistory ? copy.loadingOlderActivity : copy.loadOlderActivity}
            </SecondaryButton>
          </div>
        ) : null}
      </div>
    </ContentSurface>
  );
}

function SettingsSurface({
  copy,
  setError,
  snapshot,
  updateState,
}: {
  copy: Copy;
  setError: (error: string | null) => void;
  snapshot: LauncherSnapshot;
  updateState: (state: LauncherState) => void;
}) {
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [activeAction, setActiveAction] = useState<"doctor" | "factory-reset" | "upsell" | null>(null);
  const busy = activeAction !== null;

  const runDoctor = async () => {
    setActiveAction("doctor");
    try {
      setDoctor(await api!.doctor());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const setCodexUsageUpsellHidden = async (enabled: boolean) => {
    setActiveAction("upsell");
    setError(null);
    try {
      const result = await api!.setCodexUsageUpsellHidden(enabled);
      updateState(result.state);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActiveAction(null);
    }
  };
  const factoryReset = async () => {
    setActiveAction("factory-reset");
    setError(null);
    try {
      const result = await api!.factoryReset();
      if (result.cancelled) setActiveAction(null);
    } catch (cause) {
      setError(messageOf(cause));
      setActiveAction(null);
    }
  };
  return (
    <ContentSurface narrow title={copy.settingsTitle}>
      <SectionHeading label={copy.general} />
      <div className="settings-list">
        <SettingRow body={copy.launchAtLoginBody} label={copy.launchAtLogin}>
          <Switch
            checked={snapshot.state.autoStart}
            onChange={(checked) => void api!.setAutostart(checked)
              .then((result) => updateState(result.state))
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.startRuntimeAutomaticallyBody} label={copy.startRuntimeAutomatically}>
          <Switch
            checked={snapshot.state.runtimeAutoStart}
            onChange={(checked) => void api!.setPreference("runtimeAutoStart", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.keepRunningOnCloseBody} label={copy.keepRunningOnClose}>
          <Switch
            checked={snapshot.state.keepRunningOnClose}
            onChange={(checked) => void api!.setPreference("keepRunningOnClose", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow body={copy.showDuringTurnsBody} label={copy.showDuringTurns}>
          <Switch
            checked={snapshot.state.showBrowserDuringTurns}
            onChange={(checked) => void api!.setPreference("showBrowserDuringTurns", checked)
              .then(updateState)
              .catch((cause) => setError(messageOf(cause)))}
          />
        </SettingRow>
        <SettingRow
          body={`${copy.hideCodexUsageUpsellBody} ${codexUsageUpsellStatusText(copy, snapshot.codexUsageUpsell)}`}
          label={copy.hideCodexUsageUpsell}
        >
          <Switch
            checked={snapshot.state.hideCodexUsageUpsell}
            disabled={busy}
            onChange={(checked) => void setCodexUsageUpsellHidden(checked)}
          />
        </SettingRow>
      </div>

      <SectionHeading label={copy.diagnostics} spaced />
      <button className="diagnostic-row" disabled={busy} onClick={() => void runDoctor()} type="button">
        <Icon name="activity" />
        <span>
          <strong>{copy.runDoctor}</strong>
          <small>{doctor ? (doctor.ok ? copy.healthy : copy.needsAttention) : copy.status}</small>
        </span>
        {activeAction === "doctor" ? <ButtonSpinner /> : <Icon name="chevron" />}
      </button>
      {doctor ? <DoctorSummary copy={copy} report={doctor} /> : null}
      <button className="diagnostic-row" disabled={busy} onClick={() => void factoryReset()} type="button">
        <Icon name="trash" />
        <span>
          <strong>{copy.factoryReset}</strong>
          <small>{copy.factoryResetBody}</small>
        </span>
        {activeAction === "factory-reset" ? <ButtonSpinner /> : <Icon name="chevron" />}
      </button>

      <div className="about-row">
        <BrandMark small />
        <span>
          <strong>{copy.product}</strong>
          <small>{platformLabel(snapshot.platform)} · v{snapshot.version}</small>
        </span>
      </div>
    </ContentSurface>
  );
}

function ContentSurface({
  children,
  eyebrow,
  fit = false,
  narrow = false,
  subtitle,
  title,
}: {
  children: ReactNode;
  eyebrow?: string;
  fit?: boolean;
  narrow?: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="content-surface">
      <div className={`content-scroll${narrow ? " is-narrow" : ""}${fit ? " is-fit" : ""}`}>
        <header className="surface-header">
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}

function SetupRow({
  action,
  complete,
  description,
  disabled,
  index,
  loading = false,
  onAction,
  title,
}: {
  action: string;
  complete: boolean;
  description: string;
  disabled: boolean;
  index: number;
  loading?: boolean;
  onAction: () => void;
  title: string;
}) {
  return (
    <div className={`setup-row${complete ? " is-complete" : ""}`}>
      <span className="setup-index">{complete ? <Icon name="check" /> : index}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <SecondaryButton disabled={disabled || complete} loading={loading} onClick={onAction}>
        {action}
      </SecondaryButton>
    </div>
  );
}

function SectionHeading({ label, meta, spaced = false }: { label: string; meta?: string; spaced?: boolean }) {
  return (
    <div className={`section-heading${spaced ? " is-spaced" : ""}`}>
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function NoticeRow({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: IconName;
  tone: "warning" | "success";
}) {
  return (
    <div className={`notice-row tone-${tone}`}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

function codexUsageUpsellStatusText(copy: Copy, status: LauncherSnapshot["codexUsageUpsell"]) {
  const version = status.version ?? "unknown";
  let text: string;
  if (status.message) {
    text = copy.codexUsageUpsellError.replace("{message}", status.message);
  } else if (status.state === "applied") {
    text = copy.codexUsageUpsellApplied.replace("{version}", version);
  } else if (status.state === "available") {
    text = copy.codexUsageUpsellDetected.replace("{version}", version);
  } else if (status.state === "unsupported") {
    text = copy.codexUsageUpsellUnsupported.replace("{version}", version);
  } else {
    text = copy.codexUsageUpsellNotFound;
  }
  return status.reloadRequired ? `${text} ${copy.codexUsageUpsellReload}` : text;
}

function SettingRow({ body, children, label }: { body: string; children: ReactNode; label: string }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function FieldRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="field-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DoctorSummary({ copy, report }: { copy: Copy; report: DoctorReport }) {
  const visibleChecks = report.ok
    ? report.checks.slice(-6)
    : report.checks.filter((check) => check.status !== "ok");
  return (
    <div className={`doctor-summary${report.ok ? " is-healthy" : ""}`}>
      <header>
        <Icon name={report.ok ? "check" : "activity"} />
        <strong>{report.ok ? copy.healthy : copy.needsAttention}</strong>
      </header>
      <div>
        {visibleChecks.map((check) => (
          <p key={check.id}>
            <StateDot state={check.status === "ok" ? "ready" : check.status === "warning" ? "busy" : "error"} />
            <span>{check.message}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ButtonSpinner() {
  return <i aria-hidden="true" className="button-spinner" />;
}

function PrimaryButton({
  children,
  disabled = false,
  loading = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="button-primary" disabled={disabled} onClick={onClick} type="button">
      {loading ? <ButtonSpinner /> : null}
      <span>{children}</span>
    </button>
  );
}

function SecondaryButton({
  children,
  disabled = false,
  icon,
  loading = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  icon?: IconName;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="button-secondary" disabled={disabled} onClick={onClick} type="button">
      {loading ? <ButtonSpinner /> : icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

function Switch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

function StateDot({ state }: { state: "idle" | "ready" | "busy" | "error" }) {
  return <i aria-hidden="true" className={`state-dot is-${state}`} />;
}

function ActionDot({ pulse = false, tone }: { pulse?: boolean; tone: "required" | "optional" | "success" | "error" }) {
  return <i aria-hidden="true" className={`action-dot is-${tone}${pulse ? " is-pulse" : ""}`} />;
}

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark${small ? " is-small" : ""}`}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function ErrorToast({ copy, message, onDismiss }: { copy: Copy; message: string; onDismiss: () => void }) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="error-toast"
      exit={{ opacity: 0, y: 8 }}
      initial={{ opacity: 0, y: 8 }}
      transition={PANEL_TRANSITION}
    >
      <StateDot state="error" />
      <span>
        <strong>{copy.error}</strong>
        <p>{message}</p>
      </span>
      <button onClick={onDismiss} type="button">{copy.dismiss}</button>
    </motion.div>
  );
}

function SessionRefreshReminder({
  busy,
  copy,
  onDismiss,
  onLogout,
}: {
  busy: boolean;
  copy: Copy;
  onDismiss: () => void;
  onLogout: () => void;
}) {
  return (
    <motion.aside
      animate={{ opacity: 1, y: 0 }}
      aria-live="polite"
      className="session-refresh-reminder"
      exit={{ opacity: 0, y: -8 }}
      initial={{ opacity: 0, y: -8 }}
      transition={PANEL_TRANSITION}
    >
      <span className="session-refresh-reminder-icon"><Icon name="alert" /></span>
      <div className="session-refresh-reminder-copy">
        <strong>{copy.sessionReminderTitle}</strong>
        <p>{copy.sessionReminderBody}</p>
      </div>
      <div className="session-refresh-reminder-actions">
        <button className="text-button" disabled={busy} onClick={onDismiss} type="button">
          {copy.dismiss}
        </button>
        <button className="button-primary" disabled={busy} onClick={onLogout} type="button">
          {copy.logOut}
        </button>
      </div>
    </motion.aside>
  );
}

function LaunchLoading() {
  return (
    <main className="launch-loading">
      <BrandMark />
      <span />
    </main>
  );
}

function FatalMessage({ message }: { message: string }) {
  return (
    <main className="fatal-message">
      <BrandMark />
      <h1>LCA Codex</h1>
      <p>{message}</p>
    </main>
  );
}

function browserTone(browser: BrowserState | null): "idle" | "ready" | "busy" | "error" {
  if (!browser) return "idle";
  if (browser.status === "error") return "error";
  if (browser.status === "loading" || browser.status === "running" || browser.status === "testing") return "busy";
  if (browser.authenticated) return "ready";
  return "idle";
}

function browserTabTitleFromTitle(value: string | undefined, copy: Copy): string {
  const title = value?.trim();
  if (!title || title === "about:blank" || title.includes("lca-codex-browser-host")) return copy.temporaryChat;
  return title.replace(/\s*[|–-]\s*ChatGPT\s*$/i, "") || copy.temporaryChat;
}

function browserTabTone(status: BrowserState["tabs"][number]["status"]): "idle" | "ready" | "busy" | "error" {
  if (status === "error" || status === "aborted") return "error";
  if (status === "loading" || status === "running" || status === "testing") return "busy";
  if (status === "ready") return "ready";
  return "idle";
}

function formatBrowserAddress(url: string | undefined, copy: Copy): string {
  if (!url || url.startsWith("about:blank")) return copy.browserAddress;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "chatgpt.com" && parsed.searchParams.get("temporary-chat") === "true") {
      return `chatgpt.com  /  ${copy.temporaryChat}`;
    }
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return copy.browserAddress;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function platformLabel(value: string): string {
  return value === "darwin" ? "macOS" : value === "win32" ? "Windows" : value === "linux" ? "Linux" : value;
}

const CHATGPT_ACTIVITY_EVENTS = new Set([
  "lca_codex.turn_send_accepted",
  "lca_codex.turn_first_response",
  "lca_codex.turn_first_reasoning",
  "lca_codex.turn_first_text",
  "lca_codex.network_turn_created",
  "lca_codex.network_turn_streaming",
  "lca_codex.network_turn_completed",
  "lca_codex.network_observer_unavailable",
  "lca_codex.network_observer_reattached",
  "lca_codex.turn_completed",
  "lca_codex.turn_failed",
]);
const ACTIVITY_STALLED_MS = 30_000;

function activitySourceLabel(source: ActivitySource): string {
  if (source === "chatgpt") return "CHATGPT";
  if (source === "lca") return "LCA CODEX";
  if (source === "codex") return "CODEX NATIVE";
  return "SYSTEM";
}

function activityRecordSource(record: LogRecord): ActivitySource {
  if (record.event === "lca_codex.tool_started" || record.event === "lca_codex.tool_completed") {
    if (record.detail.layer === "codex") return "codex";
    if (record.detail.layer === "lca") return "lca";
  }
  if (CHATGPT_ACTIVITY_EVENTS.has(record.event)) return "chatgpt";
  if (record.event.startsWith("browser.") || record.event.startsWith("smoke.")) return "chatgpt";
  if (record.event.startsWith("lca_codex.")) return "lca";
  const line = typeof record.detail.line === "string" ? record.detail.line : "";
  if (/\bbrowser (?:turn|diagnostic)\b/.test(line)) return "chatgpt";
  if (/\bbroker\b|\[lca-codex-mcp\]/.test(line)) return "lca";
  if (record.event.startsWith("runtime.daemon_")
    || record.event.startsWith("connector.")
    || record.event.startsWith("bridge.")) return "lca";
  if (record.event.startsWith("codex.")) return "codex";
  return "system";
}

function activityTraceId(record: LogRecord): string | null {
  const explicit = typeof record.detail.traceId === "string" ? record.detail.traceId.trim() : "";
  if (explicit && explicit !== "unknown") return explicit;
  const line = typeof record.detail.line === "string" ? record.detail.line : "";
  const browserTurn = /\bbrowser turn ([A-Za-z0-9_-]{6,128})\b/.exec(line)?.[1];
  if (browserTurn && browserTurn !== "unknown") return browserTurn;
  const trace = /\btrace=([A-Za-z0-9_-]{6,128})\b/.exec(line)?.[1];
  return trace && trace !== "unknown" ? trace : null;
}

function activityTimestamp(record: LogRecord): number {
  const timestamp = Date.parse(record.at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function activityToolKey(record: LogRecord): string {
  const source = activityRecordSource(record);
  const callId = typeof record.detail.callId === "string" ? record.detail.callId : "";
  const tool = typeof record.detail.tool === "string" ? record.detail.tool : "tool";
  return `${source}:${callId || tool}`;
}

function buildActivityTaskGroup(traceId: string, input: LogRecord[], now: number): ActivityTaskGroup {
  const records = [...input].sort((left, right) => activityTimestamp(left) - activityTimestamp(right));
  const pendingTools = new Map<string, ActivitySource>();
  const toolCounts = new Map<string, ActivityToolSummary>();
  let status: "failed" | "completed" | undefined;
  let terminalAt: number | undefined;
  let phase: "running" | "waiting" = "running";
  let source: ActivitySource = "lca";
  let attempt = 1;
  let threadId: string | undefined;
  let chatTitle: string | undefined;
  let taskTitle: string | undefined;
  let sawStart = false;

  for (const record of records) {
    const recordSource = activityRecordSource(record);
    const recordAttempt = record.detail.attempt;
    const recordThreadId = record.detail.threadId;
    const recordChatTitle = record.detail.chatTitle;
    const recordTaskTitle = record.detail.taskTitle;
    if (typeof recordAttempt === "number" && Number.isFinite(recordAttempt)) {
      attempt = Math.max(attempt, Math.max(1, Math.round(recordAttempt)));
    }
    if (typeof recordThreadId === "string" && recordThreadId.trim()) threadId = recordThreadId.trim();
    if (typeof recordChatTitle === "string" && recordChatTitle.trim()) chatTitle = recordChatTitle.trim();
    if (typeof recordTaskTitle === "string" && recordTaskTitle.trim()) taskTitle = recordTaskTitle.trim();

    if (record.event === "lca_codex.turn_started") {
      sawStart = true;
      status = undefined;
      terminalAt = undefined;
      pendingTools.clear();
      phase = "running";
      source = "lca";
    } else if (record.event === "browser.turn_started") {
      sawStart = true;
      if (!status) {
        phase = "running";
        source = "chatgpt";
      }
    } else if (record.event === "browser.turn_ended") {
      const browserStatus = record.detail.status;
      if (browserStatus === "completed") status = "completed";
      else if (browserStatus === "failed" || browserStatus === "aborted") status = "failed";
      if (status) terminalAt = activityTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_send_accepted"
      || record.event === "lca_codex.turn_first_response"
      || record.event === "lca_codex.turn_first_reasoning"
      || record.event === "lca_codex.network_turn_created"
      || record.event === "lca_codex.network_turn_completed") {
      phase = "waiting";
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_first_text"
      || record.event === "lca_codex.network_turn_streaming") {
      phase = "running";
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_completed") {
      status = "completed";
      terminalAt = activityTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_failed") {
      status = "failed";
      terminalAt = activityTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_retry_scheduled") {
      status = undefined;
      terminalAt = undefined;
      phase = "waiting";
      source = "lca";
    } else if (record.event === "lca_codex.turn_retry_stopped") {
      status = "failed";
      terminalAt = activityTimestamp(record);
      source = "lca";
    } else if (record.event === "lca_codex.tool_started") {
      pendingTools.set(activityToolKey(record), recordSource);
      if (recordSource === "lca" || recordSource === "codex") {
        const tool = typeof record.detail.tool === "string" && record.detail.tool.trim()
          ? record.detail.tool.trim()
          : "unknown";
        const key = `${recordSource}:${tool}`;
        toolCounts.set(key, {
          source: recordSource,
          tool,
          count: (toolCounts.get(key)?.count ?? 0) + 1,
        });
      }
      phase = "waiting";
      source = recordSource;
    } else if (record.event === "lca_codex.tool_completed") {
      pendingTools.delete(activityToolKey(record));
      phase = "waiting";
      source = recordSource === "codex" ? "lca" : "chatgpt";
    } else if (!status && recordSource !== "system") {
      source = recordSource;
    }
  }

  const pendingSources = [...pendingTools.values()];
  if (pendingSources.includes("codex")) source = "codex";
  else if (pendingSources.includes("lca")) source = "lca";

  const first = records.find(record => record.event === "lca_codex.turn_started") ?? records[0]!;
  const last = records.at(-1)!;
  const startedAt = activityTimestamp(first);
  const lastAt = activityTimestamp(last);
  // Native Codex tools and ChatGPT Web reasoning can legitimately run longer than the
  // quiet-task threshold. Keep quiet ChatGPT turns waiting instead of calling them stalled.
  const quiet = status === undefined
    && sawStart
    && !pendingSources.includes("codex")
    && now - lastAt >= ACTIVITY_STALLED_MS;
  const stalled = quiet && source !== "chatgpt";
  const waitingForChatGpt = quiet && source === "chatgpt";
  const taskStatus: ActivityTaskStatus = status
    ?? (stalled
      ? "stalled"
      : waitingForChatGpt || pendingTools.size > 0 || phase === "waiting"
        ? "waiting"
        : "running");
  const endedAt = terminalAt ?? now;

  return {
    traceId,
    threadId: threadId ?? null,
    chatTitle: chatTitle ?? null,
    taskTitle: taskTitle ?? null,
    records,
    startedAt: first.at,
    lastAt: last.at,
    durationMs: Math.max(0, endedAt - startedAt),
    attempt,
    tools: [...toolCounts.values()].sort((left, right) => (
      left.source.localeCompare(right.source) || left.tool.localeCompare(right.tool)
    )),
    source,
    status: taskStatus,
    eventCount: records.length,
  };
}

function isActivityHealthRecord(record: LogRecord): boolean {
  return activityTraceId(record)?.startsWith("health-") === true;
}

function groupActivityLogs(logs: LogRecord[], now: number): {
  tasks: ActivityTaskGroup[];
  system: LogRecord[];
} {
  const byTraceId = new Map<string, LogRecord[]>();
  const system: LogRecord[] = [];
  for (const record of logs) {
    if (isActivityHealthRecord(record)) continue;
    const traceId = activityTraceId(record);
    if (!traceId) {
      system.push(record);
      continue;
    }
    const records = byTraceId.get(traceId) ?? [];
    records.push(record);
    byTraceId.set(traceId, records);
  }
  const tasks = [...byTraceId]
    .map(([traceId, records]) => buildActivityTaskGroup(traceId, records, now))
    .sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt));
  system.sort((left, right) => activityTimestamp(left) - activityTimestamp(right));
  return { tasks, system };
}

function groupActivityRecordsByChat(logs: LogRecord[]): Map<string, LogRecord[]> {
  const visibleLogs = logs.filter((record) => !isActivityHealthRecord(record));
  const threadByTrace = new Map<string, string>();
  for (const record of visibleLogs) {
    const traceId = activityTraceId(record);
    const threadId = typeof record.detail.threadId === "string" ? record.detail.threadId.trim() : "";
    if (traceId && threadId) threadByTrace.set(traceId, threadId);
  }

  const byChat = new Map<string, LogRecord[]>();
  for (const record of visibleLogs) {
    const traceId = activityTraceId(record);
    const threadId = traceId ? threadByTrace.get(traceId) : null;
    const chatId = traceId ? (threadId ? `chat:${threadId}` : `trace:${traceId}`) : "system";
    const records = byChat.get(chatId) ?? [];
    records.push(record);
    byChat.set(chatId, records);
  }
  return byChat;
}

function summarizeActivityChatGroups(byChat: Map<string, LogRecord[]>): ActivityChatSummary[] {
  return [...byChat].map<ActivityChatSummary>(([id, records]) => {
    const sorted = [...records].sort((left, right) => activityTimestamp(left) - activityTimestamp(right));
    const last = sorted.at(-1)!;
    if (id === "system") {
      return {
        id,
        kind: "system",
        threadId: null,
        title: "System activity",
        taskCount: 0,
        eventCount: sorted.length,
        lastAt: last.at,
      };
    }

    const threadId = id.startsWith("chat:") ? id.slice(5) : null;
    const traceIds = new Set(sorted.map(activityTraceId).filter((value): value is string => Boolean(value)));
    const chatTitle = [...sorted].reverse().find((record) => (
      typeof record.detail.chatTitle === "string" && record.detail.chatTitle.trim()
    ))?.detail.chatTitle;
    const fallbackTrace = [...traceIds][0] ?? id.slice(6);
    return {
      id,
      kind: threadId ? "chat" : "trace",
      threadId,
      title: typeof chatTitle === "string" && chatTitle.trim()
        ? chatTitle.trim()
        : threadId ? `Chat ${threadId.slice(0, 8)}` : `Task ${fallbackTrace}`,
      taskCount: traceIds.size,
      eventCount: sorted.length,
      lastAt: last.at,
    };
  }).sort(compareActivityChatSummaries);
}

function compareActivityChatSummaries(left: ActivityChatSummary, right: ActivityChatSummary): number {
  if (left.kind === "system" && right.kind !== "system") return 1;
  if (right.kind === "system" && left.kind !== "system") return -1;
  return Date.parse(right.lastAt) - Date.parse(left.lastAt) || left.id.localeCompare(right.id);
}

function mergeActivityChatSummaries(...groups: ActivityChatSummary[][]): ActivityChatSummary[] {
  const merged = new Map<string, ActivityChatSummary>();
  for (const group of groups) {
    for (const chat of group) {
      const current = merged.get(chat.id);
      if (!current) {
        merged.set(chat.id, chat);
        continue;
      }
      const newer = Date.parse(chat.lastAt) > Date.parse(current.lastAt) ? chat : current;
      merged.set(chat.id, {
        ...current,
        title: newer.title,
        lastAt: newer.lastAt,
        taskCount: Math.max(current.taskCount, chat.taskCount),
        eventCount: Math.max(current.eventCount, chat.eventCount),
      });
    }
  }
  return [...merged.values()].sort(compareActivityChatSummaries);
}

function mergeActivityTaskSummaries(...groups: ActivityTaskSummary[][]): ActivityTaskSummary[] {
  const merged = new Map<string, ActivityTaskSummary>();
  for (const group of groups) {
    for (const task of group) {
      const current = merged.get(task.traceId);
      if (!current) {
        merged.set(task.traceId, task);
        continue;
      }
      const newer = Date.parse(task.lastAt) >= Date.parse(current.lastAt) ? task : current;
      const older = newer === task ? current : task;
      const toolCounts = new Map<string, ActivityToolSummary>();
      for (const tool of [...older.tools, ...newer.tools]) {
        const key = `${tool.source}:${tool.tool}`;
        const existing = toolCounts.get(key);
        if (!existing || tool.count > existing.count) toolCounts.set(key, tool);
      }
      merged.set(task.traceId, {
        ...newer,
        threadId: newer.threadId ?? older.threadId,
        chatTitle: newer.chatTitle ?? older.chatTitle,
        taskTitle: newer.taskTitle ?? older.taskTitle,
        startedAt: Date.parse(task.startedAt) < Date.parse(current.startedAt) ? task.startedAt : current.startedAt,
        attempt: Math.max(current.attempt, task.attempt),
        durationMs: Math.max(current.durationMs, task.durationMs),
        eventCount: Math.max(current.eventCount, task.eventCount),
        tools: [...toolCounts.values()].sort((left, right) => (
          left.source.localeCompare(right.source) || left.tool.localeCompare(right.tool)
        )),
      });
    }
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt));
}

function mergeLogRecords(...groups: LogRecord[][]): LogRecord[] {
  const merged = new Map<string, LogRecord>();
  for (const group of groups) {
    for (const record of group) {
      const key = `${record.at}\u0000${record.event}\u0000${JSON.stringify(record.detail)}`;
      merged.set(key, record);
    }
  }
  return [...merged.values()].sort((left, right) => activityTimestamp(left) - activityTimestamp(right));
}

function activityTaskStatusLabel(group: ActivityTaskSummary): string {
  if (group.status === "completed") return "COMPLETED";
  if (group.status === "failed") return "FAILED";
  if (group.status === "stalled") return `STALLED · ${activitySourceLabel(group.source)}`;
  if (group.status === "waiting") return `WAITING FOR ${activitySourceLabel(group.source)}`;
  return `RUNNING · ${activitySourceLabel(group.source)}`;
}

function activityTaskTitle(group: ActivityTaskSummary): string {
  return group.taskTitle || `Task ${group.traceId}`;
}

function activityTaskTooltip(group: ActivityTaskSummary): string {
  return [
    ...(group.taskTitle ? [`Task: ${group.taskTitle}`] : []),
    ...(group.chatTitle ? [`Chat: ${group.chatTitle}`] : []),
    ...(group.threadId ? [`Chat ID: ${group.threadId}`] : []),
    `Task ID: ${group.traceId}`,
  ].join("\n");
}

function activityTaskMeta(group: ActivityTaskSummary): string {
  const events = group.eventCount === 1 ? "1 event" : `${group.eventCount} events`;
  return [
    ...(group.threadId ? [`Chat ID ${group.threadId.slice(0, 8)}`] : []),
    `Task ID ${group.traceId}`,
    `Attempt ${group.attempt}`,
    formatActivityDuration(group.durationMs),
    events,
  ].join(" · ");
}

function activityTaskToolMeta(group: ActivityTaskSummary): string {
  const summary = (source: "lca" | "codex") => {
    const count = group.tools
      .filter(tool => tool.source === source)
      .reduce((total, tool) => total + tool.count, 0);
    return `${count} tool${count === 1 ? "" : "s"}`;
  };
  return `LCA CODEX: ${summary("lca")} · CODEX NATIVE: ${summary("codex")}`;
}

const lcaActivityEventLabels: Record<string, string> = {
  "lca_codex.turn_started": "LCA Codex turn started",
  "lca_codex.turn_send_accepted": "Prompt accepted by ChatGPT",
  "lca_codex.turn_first_response": "First ChatGPT response",
  "lca_codex.turn_first_reasoning": "First reasoning update",
  "lca_codex.turn_first_text": "First answer text",
  "lca_codex.network_turn_created": "ChatGPT · WS turn created",
  "lca_codex.network_turn_streaming": "ChatGPT · WS streaming",
  "lca_codex.network_turn_completed": "ChatGPT · WS turn completed",
  "lca_codex.network_observer_unavailable": "ChatGPT · Network observer unavailable",
  "lca_codex.network_observer_reattached": "ChatGPT · Network observer reattached",
  "lca_codex.turn_completed": "LCA Codex turn completed",
  "lca_codex.turn_failed": "LCA Codex turn failed",
  "lca_codex.turn_retry_scheduled": "LCA Codex retry scheduled",
  "lca_codex.turn_retry_stopped": "LCA Codex retry stopped",
  "lca_codex.tool_started": "Tool started",
  "lca_codex.tool_completed": "Tool completed",
};

function humanEvent(value: string): string {
  return lcaActivityEventLabels[value]
    ?? value.split(".").map((part) => part.replaceAll("_", " ")).join(" · ");
}

function formatActivityDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const milliseconds = Math.max(0, Math.round(value));
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;
}

function lcaActivityDetail(key: string, value: unknown): string {
  if (key === "layer") {
    return value === "lca" ? "LCA connector" : value === "codex" ? "Codex native" : String(value);
  }
  if (key === "attempt") return `attempt ${String(value)}`;
  if (key === "nextAttempt") return `next attempt ${String(value)}`;
  if (key === "elapsedMs") return `elapsed ${formatActivityDuration(value)}`;
  if (key === "sinceSendMs") return `after send ${formatActivityDuration(value)}`;
  if (key === "durationMs") return `duration ${formatActivityDuration(value)}`;
  if (key === "responseChars" && typeof value === "number") return `${value.toLocaleString()} chars`;
  if (key === "completionSource") return `completion source: ${String(value)}`;
  if (key === "traceId") return `turn ${String(value)}`;
  if (key === "callId") return `call ${String(value)}`;
  return key === "tool" ? String(value) : `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function logDetail(event: string, detail: Record<string, unknown>, grouped = false): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  if (event.startsWith("lca_codex.")) {
    const order = [
      "layer",
      "tool",
      "attempt",
      "nextAttempt",
      "mode",
      "elapsedMs",
      "sinceSendMs",
      "durationMs",
      "responseChars",
      "completionSource",
      "status",
      "reason",
      "code",
      "traceId",
      "callId",
    ];
    const values = new Map(entries);
    return order
      .filter((key) => values.has(key) && (!grouped || !["traceId", "threadId", "chatTitle", "layer"].includes(key)))
      .map((key) => lcaActivityDetail(key, values.get(key)))
      .join(" · ");
  }
  return entries
    .filter(([key]) => !grouped || !["traceId", "threadId", "chatTitle"].includes(key))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
