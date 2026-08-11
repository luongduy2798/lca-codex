const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const runtimeLifecycleSource = fs.readFileSync(path.join(launcherRoot, "electron", "runtime-lifecycle.cjs"), "utf8");
const setupSource = fs.readFileSync(path.join(launcherRoot, "..", "src", "setup.ts"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
const i18nSource = fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8");

test("launcher uses native macOS chrome and controlled window translucency", () => {
  assert.match(electronMain, /backgroundColor:\s*isMac\s*\?\s*"#00000000"\s*:\s*"#181818"/);
  assert.match(electronMain, /titleBarStyle:\s*isMac\s*\?\s*"hiddenInset"\s*:\s*"hidden"/);
  assert.match(electronMain, /titleBarOverlay:\s*\{[\s\S]*?height:\s*46/);
  assert.match(electronMain, /transparent:\s*isMac/);
  assert.match(electronMain, /vibrancy:\s*"under-window"/);
  assert.match(electronMain, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*17\s*\}/);
  assert.doesNotMatch(electronMain, /setWindowButtonVisibility/);
  assert.doesNotMatch(appSource, /WindowControls/);
  assert.match(styles, /backdrop-filter/);

  for (const removedClass of [
    "ambient-backdrop",
    "onboarding-card",
    "control-panel",
    "status-bar",
    "browser-slot",
    "mcp-card",
    "diagnostic-card",
  ]) {
    assert.equal(appSource.includes(removedClass), false, `${removedClass} returned to App.tsx`);
    assert.equal(styles.includes(`.${removedClass}`), false, `${removedClass} returned to styles.css`);
  }
});

test("launcher retains the native shell and owned browser surface structure", () => {
  for (const requiredClass of [
    "app-titlebar",
    "app-sidebar",
    "sidebar-brand-row",
    "workspace",
    "browser-tab-strip",
    "browser-toolbar",
    "browser-viewport",
    "content-surface",
    "mcp-stage",
  ]) {
    assert.equal(appSource.includes(requiredClass), true, `${requiredClass} is missing from App.tsx`);
    assert.equal(styles.includes(`.${requiredClass}`), true, `${requiredClass} is missing from styles.css`);
  }
  assert.equal(appSource.includes("sidebar-resize-handle"), false);
  assert.equal(styles.includes(".sidebar-resize-handle"), false);
});

test("runtime sidebar stays visible at every window width", () => {
  assert.doesNotMatch(appSource, /COMPACT_SIDEBAR_QUERY|compactSidebar|sidebarOpen|toggleSidebar|sidebar-backdrop/);
  assert.doesNotMatch(styles, /\.sidebar-backdrop|\.app-shell\.is-compact|is-sidebar-open/);
  assert.match(appSource, /const browserSurfaceActive = surface === "browser";/);
  assert.match(appSource, /<aside className="app-sidebar">/);
  assert.match(styles, /\.app-sidebar\s*\{[^}]*width:\s*var\(--sidebar-width\)[^}]*min-width:\s*var\(--sidebar-width\)[^}]*flex:\s*0 0 var\(--sidebar-width\)/s);
  assert.match(styles, /\.workspace\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1/s);
});

test("Activity groups task logs and labels the active execution layer", () => {
  assert.match(appSource, /function groupActivityLogs\(/);
  assert.match(appSource, /function activityTraceId\(/);
  assert.match(appSource, /ACTIVITY_STALLED_MS = 30_000/);
  assert.match(appSource, /"CHATGPT"[\s\S]*?"LCA CODEX"[\s\S]*?"CODEX NATIVE"[\s\S]*?"SYSTEM"/);
  assert.match(appSource, /WAITING FOR \$\{activitySourceLabel\(group\.source\)\}/);
  assert.match(appSource, /const stalled = quiet && source !== "chatgpt"/);
  assert.match(appSource, /const waitingForChatGpt = quiet && source === "chatgpt"/);
  assert.match(appSource, /className="activity-task-header"/);
  assert.match(appSource, /Chat ID: \$\{group\.threadId\}/);
  assert.match(appSource, /LCA CODEX:[\s\S]*?CODEX NATIVE:/);
  assert.match(appSource, /api\.activityChatTasks\(\{ chatId: chat\.id \}\)/);
  assert.match(appSource, /api\.activityTaskRecords\(\{ traceId: task\.traceId \}\)/);
  assert.match(appSource, /expandedChats\[chat\.id\] === true/);
  assert.match(appSource, /expandedTasks\[task\.traceId\] === true/);
  assert.match(appSource, /\[\.\.\.records\]\.reverse\(\)/);
  assert.match(styles, /\.activity-source-flag\.is-chatgpt/);
  assert.match(styles, /\.activity-source-flag\.is-lca/);
  assert.match(styles, /\.activity-source-flag\.is-codex/);
  assert.match(styles, /\.activity-task-status\.is-stalled/);
});

test("embedded ChatGPT is measured after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("launcher keeps browser chrome flush and MCP instructions structured", () => {
  assert.match(styles, /\.workspace\s*\{[^}]*padding-top:\s*0/s);
  assert.match(styles, /\.content-surface\s*\{[^}]*padding-top:\s*var\(--height-titlebar\)/s);
  assert.match(styles, /\.mcp-stage\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.doesNotMatch(styles, /\.guide-media/);
  assert.doesNotMatch(appSource, /MCP_GUIDE_MEDIA|mcp-create-tunnel\.gif|mcp-connect-connector\.gif/);
  assert.doesNotMatch(styles, /\.wizard-stepper\s*\{[^}]*border-(?:top|bottom)/s);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.wizard-stepper button\s*\{[^}]*gap:\s*6px[^}]*padding-inline:\s*7px/s);
  assert.doesNotMatch(styles, /@media \(max-width: 900px\)[\s\S]*?\.wizard-stepper em\s*\{[^}]*display:\s*none/s);
  assert.match(appSource, /M22\.2819 9\.8211/);
  assert.match(appSource, /sidebar-brand-identity/);
});

test("Windows chrome uses the available left edge and the branded application icon", () => {
  assert.match(appSource, /data-platform=\{snapshot\.platform\}/);
  assert.match(styles, /\.app-root:not\(\[data-platform="darwin"\]\) \.titlebar-left\s*\{[^}]*left:\s*8px/s);
  assert.match(styles, /\.app-root:not\(\[data-platform="darwin"\]\) \.titlebar-left \.icon-button\s*\{[^}]*border-radius:\s*var\(--radius-round\)/s);
  assert.match(electronMain, /icon:\s*APP_ICON_PATH/);
});

test("closing the launcher follows the persisted background-launcher preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(electronMain, /same BrandMark glyph rendered in the sidebar/);
  assert.match(electronMain, /MAC_TRAY_ICON_PNG = "iVBORw0KGgo/);
  assert.match(electronMain, /nativeImage\.createFromBuffer\(Buffer\.from\(MAC_TRAY_ICON_PNG, "base64"\)\)\.resize\(\{ width: 18, height: 18 \}\)/);
  assert.doesNotMatch(electronMain, /keepRunningOnClose && tray/);
  assert.match(electronMain, /if \(image\.isEmpty\(\)\) throw new Error\("Tray icon could not be loaded"\);/);
  assert.match(electronMain, /if \(process\.platform === "darwin"\) image\.setTemplateImage\(true\);/);
  assert.doesNotMatch(electronMain, /data:image\/svg\+xml/);
  assert.doesNotMatch(electronMain, /label: "Open LCA Codex"/);
  assert.match(electronMain, /label: trayRuntimeLabel\(status\), enabled: false/);
  assert.match(electronMain, /label: "Quit LCA Codex"/);
  assert.match(electronMain, /tray\.on\("click", \(\) => showMainWindow\(\)\)/);
  assert.match(electronMain, /tray\.setTitle\(latestTrayActivity \? `\$\{runtime\} · \$\{latestTrayActivity\}` : runtime\)/);
  assert.match(electronMain, /Waiting for ChatGPT/);
  assert.match(electronMain, /record\?\.event === "lca_codex\.tool_started" \|\| record\?\.event === "lca_codex\.tool_completed"/);
  assert.match(electronMain, /traceId\.startsWith\("health-"\)/);
  assert.match(electronMain, /clearTrayActivityAfter\(8_000\)/);
  assert.match(electronMain, /publish: \(record\) => \{[\s\S]*?send\("launcher:log", record\);[\s\S]*?publishTrayActivity\(record\);/);
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
  assert.match(i18nSource, /keepRunningOnClose: "Keep launcher running when window closes"/);
});

test("tray activity keeps active work visible but detects stalled LCA turns", () => {
  assert.match(electronMain, /ACTIVITY_STALL_MS/);
  assert.match(electronMain, /"lca_codex\.turn_started": \{ label: "Turn started", terminal: false, stallable: true \}/);
  assert.match(electronMain, /stallable: !terminal && record\.detail\?\.layer !== "codex"/);
  assert.match(electronMain, /if \(!activity\.stallable\) return;/);
  assert.match(electronMain, /latestTrayActivity = "Stalled";[\s\S]*?clearTrayActivityAfter\(8_000\)/);
  assert.match(electronMain, /"lca_codex\.turn_completed": \{ label: "Task completed", terminal: true, stallable: false \}/);
});

test("sidebar keeps the brand prominent, runtime actions clear, and Settings free of unexplained status dots", () => {
  assert.match(appSource, /sidebar-brand-identity[\s\S]*?<BrandMark small \/>[\s\S]*?<strong>\{copy\.product\}<\/strong>/);
  assert.doesNotMatch(appSource, /sidebar-brand-identity[\s\S]{0,240}?copy\.tagline/);
  assert.match(styles, /\.sidebar-brand-identity strong\s*\{[^}]*color:\s*#fff[^}]*font-size:\s*18px[^}]*font-weight:\s*700/s);
  assert.doesNotMatch(styles, /\.sidebar-brand-copy small\s*\{/);
  assert.match(appSource, /className=\{`sidebar-runtime-card is-\$\{snapshot\.runtime\.lifecycle\}/);
  assert.match(appSource, /className="sidebar-runtime-overview"[\s\S]*?navigateSurface\("runtime"\)/);
  assert.match(appSource, /sidebar-runtime-overview[\s\S]*?sidebar-runtime-lifecycle[\s\S]*?runtimeLifecycleLabel\(copy, snapshot\.runtime\)/);
  assert.doesNotMatch(appSource, /runtimeModeLabel|snapshot\.runtime\.mode|sidebar-runtime-mode-line/);
  assert.match(appSource, /sidebar-runtime-overview[\s\S]*?<RuntimeActionButtons compact copy=\{copy\} runtime=\{snapshot\.runtime\} setError=\{setError\} \/>/);
  assert.doesNotMatch(appSource, /className="sidebar-runtime-mode"[\s\S]*?navigateSurface\("mcp"\)/);
  assert.match(styles, /\.sidebar-runtime-lifecycle\s*\{[^}]*font-size:\s*15px/s);
  assert.doesNotMatch(styles, /sidebar-runtime-mode-line|sidebar-runtime-card\.is-codex/);
  assert.match(styles, /\.sidebar-runtime-card\.is-ready\s*\{[^}]*border-color:/s);
  assert.match(styles, /\.sidebar-runtime-card\.is-error,[\s\S]*?background:\s*linear-gradient/s);
  assert.match(styles, /\.sidebar-brand-row \.sidebar-brand-identity > \.brand-mark\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s);
  assert.match(appSource, /active=\{surface === "settings"\}\s*icon="settings"\s*label=\{copy\.settings\}/);
  assert.doesNotMatch(appSource, /active=\{surface === "settings"\}[\s\S]{0,120}?badge=/);
  assert.doesNotMatch(appSource, /chatgptModeSummary|codexModeSummary|modeNotConfiguredSummary/);
  assert.doesNotMatch(appSource, /className="titlebar-runtime no-drag"/);
  assert.doesNotMatch(styles, /\.titlebar-runtime\s*\{|\.runtime-status-chip\s*\{/);
  assert.doesNotMatch(styles, /\.browser-tab-strip\s*\{\s*padding-right:\s*150px/s);
  assert.match(styles, /\.browser-tab\s*>\s*button\s*\{[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(styles, /\.browser-tab\s*>\s*button\s*\{[\s\S]*?opacity:\s*0;/);
});

test("runtime details omit mode switching and always expose tunnel state", () => {
  assert.doesNotMatch(appSource, /runtime\.mode|runtime-mode-suggestion|switchToCodexMode|chatgptMode/);
  assert.match(i18nSource, /mcpTitle: "MCP"/);
  assert.match(i18nSource, /configureMcp: "Configure MCP"/);
  assert.match(i18nSource, /connect: "Configure MCP"/);
  assert.match(i18nSource, /reconnect: "Apply MCP settings"/);
  assert.match(styles, /\.runtime-detail-row\.has-description\s*\{/);
  assert.match(appSource, /runtime\.tunnel\?\.ready[\s\S]*?runtime\.tunnel\.pid \? `PID \$\{runtime\.tunnel\.pid\} · ` : ""[\s\S]*?copy\.runtimeReady/);
  assert.match(appSource, /runtime\.tunnel\?\.state && runtime\.tunnel\.state !== "stopped"/);
  assert.doesNotMatch(appSource, /value=\{runtime\.tunnel\?\.pid[\s\S]*?: copy\.runtimeStopped\}/);
});

test("manual-first runtime controls are global and startup stays observe-only by default", () => {
  for (const apiCall of ["runtimeStatus", "startRuntime", "stopRuntime", "restartRuntime", "onRuntimeState"]) {
    assert.match(preloadSource, new RegExp(`${apiCall}:`));
  }
  assert.match(appSource, /className=\{`sidebar-runtime-card/);
  assert.match(appSource, /activeAction === "start" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /activeAction === "restart" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /activeAction === "stop" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /function RuntimeServiceSurface/);
  assert.match(appSource, /setPreference\("runtimeAutoStart", checked\)/);
  assert.match(electronMain, /await publishRuntimeStatus\(\);\s*startRuntimeStatusMonitor\(\{ logger, stateStore \}\);\s*if \(stateStore\.read\(\)\.runtimeAutoStart === true\)/);
  assert.match(runtimeLifecycleSource, /const status = await runtimeSupervisor\.startRuntime\(\)/);
  assert.match(runtimeLifecycleSource, /const status = await runtimeSupervisor\.stopRuntime\(\)/);
});

test("Codex config keeps install and restore actions independent from MCP and manual mode editable", () => {
  const start = appSource.indexOf("function CodexConfigSurface");
  const end = appSource.indexOf("function VsCodeAdvancedSurface", start);
  const codexConfigSource = appSource.slice(start, end);
  assert.match(codexConfigSource, /api!\.setupCore\(\)/);
  assert.match(codexConfigSource, /SectionHeading label=\{copy\.codexToolHealthSection\} meta=\{copy\.automatic\} spaced/);
  assert.match(codexConfigSource, /className="next-surface-row"[\s\S]*?setSubview\("codex-tools"\)/);
  assert.match(codexConfigSource, /function CodexToolHealthSurface[\s\S]*?api!\.checkCodexTools\(\)/);
  assert.match(codexConfigSource, /api!\.onCodexToolHealthState/);
  assert.match(runtimeLifecycleSource, /checkToolsAfterStart[\s\S]*?runtimeHost\.checkCodexTools\(\)[\s\S]*?publishToolHealth/);
  assert.match(codexConfigSource, /SectionHeading label=\{copy\.vscodeAdvancedSection\} meta=\{copy\.optional\} spaced/);
  assert.match(codexConfigSource, /className="next-surface-row"[\s\S]*?setSubview\("vscode-advanced"\)/);
  assert.match(codexConfigSource, /copy\.vscodeAdvancedTitle[\s\S]*?copy\.vscodeAdvancedSubtitle/);
  assert.match(codexConfigSource, /className="config-mode-toolbar"[\s\S]*?copy\.refreshing[\s\S]*?copy\.refresh/);
  assert.match(codexConfigSource, /api!\.restoreNativeCodex\(\)/);
  assert.match(codexConfigSource, /config\?\.active \? config\.routeUrl \?\? copy\.previousRoute : copy\.previousRoute/);
  assert.match(codexConfigSource, /api!\.saveCodexConfig\(manualContent\)/);
  assert.match(codexConfigSource, /<textarea[\s\S]*?config-file-editor/);
  assert.match(codexConfigSource, /copy\.save/);
  assert.match(codexConfigSource, /activeAction === "install"/);
  assert.match(codexConfigSource, /const modelsInstalled = config\?\.installed === true/);
  assert.match(codexConfigSource, /modelsInstalled \? copy\.reinstallModels : copy\.install/);
  assert.match(codexConfigSource, /loading=\{activeAction === "restore"\}/);
  assert.match(codexConfigSource, /loading=\{activeAction === "save"\}/);
  assert.match(codexConfigSource, /activeAction === "refresh" \? <ButtonSpinner \/> : null/);
  assert.match(styles, /\.button-spinner\s*\{[^}]*animation:\s*spin 0\.8s linear infinite/s);
  assert.doesNotMatch(codexConfigSource, /toggleRoute|resetCodexConfig|copy\.resetConfig|copy\.disconnect/);
  const configActionsStart = codexConfigSource.indexOf('className="inline-actions config-actions"');
  const configActionsEnd = codexConfigSource.indexOf("</div>", configActionsStart);
  assert.doesNotMatch(codexConfigSource.slice(configActionsStart, configActionsEnd), /copy\.refresh/);
  assert.match(electronMain, /launcher:setup-core[\s\S]*?runtimeHost\.setupCore\(\{ connect \}\)/);
  assert.match(electronMain, /launcher:setup-mcp[\s\S]*?runtimeHost\.setupMcp\(/);
  assert.match(setupSource, /installCodexIntegration\(config,[\s\S]*?activate:\s*!launcherOwned/);
  assert.match(preloadSource, /setupCore: \(\) => ipcRenderer\.invoke\("launcher:setup-core"\)/);
  assert.match(preloadSource, /setupMcp: \(input\) => ipcRenderer\.invoke\("launcher:setup-mcp", input\)/);
  assert.match(preloadSource, /restoreNativeCodex: \(\) => ipcRenderer\.invoke\("launcher:restore-native-codex"\)/);
  const nativeRestoreStart = electronMain.indexOf('handle("launcher:restore-native-codex"');
  const fullUninstallStart = electronMain.indexOf('handle("launcher:uninstall-integration"', nativeRestoreStart);
  const nativeRestoreSource = electronMain.slice(nativeRestoreStart, fullUninstallStart);
  assert.match(nativeRestoreSource, /stopManagedRuntime\(\{ restoreCodex: false \}\)[\s\S]*?runtimeHost\.restoreNativeCodex\(\)/);
  assert.doesNotMatch(nativeRestoreSource, /mcpSetupComplete|mcpRuntimeInstalled|mcpGuideStep/);
  assert.match(electronMain, /Replace existing route[\s\S]*?replaceExistingRoute: true/);
  assert.match(preloadSource, /saveCodexConfig:[\s\S]*?launcher:codex-config-save/);
  assert.doesNotMatch(preloadSource, /codex-config-reset|resetCodexConfig/);
  assert.match(electronMain, /launcher:codex-config-save[\s\S]*?runtimeHost\.saveCodexConfig\(content\)/);
  assert.doesNotMatch(electronMain, /launcher:codex-config-reset/);
  assert.match(i18nSource, /restorePreviousRoute: "Restore native Codex"/);
  assert.match(i18nSource, /save: "Save"/);
  assert.match(appSource, /function CodexRestartGuide/);
  assert.equal((appSource.match(/<CodexRestartGuide/g) ?? []).length, 2);
  assert.match(appSource, /function CodexRestartGuide[\s\S]*?api!\.startRuntime\(\)/);
  assert.match(appSource, /function CodexRestartGuide[\s\S]*?copy\.startLcaServiceAction/);
  assert.match(appSource, /function CodexRestartGuide[\s\S]*?copy\.codexCliRestart/);
  assert.match(appSource, /function CodexRestartGuide[\s\S]*?copy\.vscodeRestart/);
  assert.doesNotMatch(i18nSource, /restartCodex: "Restart Codex once/);
  assert.match(i18nSource, /Developer: Reload Window/);
  assert.match(styles, /\.codex-next-step\.is-pending\s*\{[^}]*opacity:/s);
  assert.match(electronMain, /function codexRestartPending[\s\S]*?codexCatalogVerified:\s*false[\s\S]*?codexRestartRequestedAt:/);
  assert.match(electronMain, /lastRequestAt >= restartRequestedAt/);
  assert.match(electronMain, /launcher:setup-core[\s\S]*?coreSetupComplete:\s*true[\s\S]*?publishRuntimeStatus\(\)/);
  assert.match(electronMain, /launcher:setup-mcp[\s\S]*?codexRestartPending\([\s\S]*?bridgeEnabled:\s*true/);
  assert.match(appSource, /const codexIntegrationInstalled = snapshot\.state\.coreSetupComplete === true/);
  assert.match(appSource, /action=\{codexIntegrationInstalled[\s\S]*?complete=\{codexIntegrationInstalled\}[\s\S]*?index=\{3\}/);
  assert.match(appSource, /disabled=\{busy \|\| !codexIntegrationInstalled\}[\s\S]*?index=\{4\}/);
  assert.match(appSource, /index=\{3\}[\s\S]*?title=\{copy\.stepInstall\}[\s\S]*?index=\{4\}[\s\S]*?title=\{copy\.stepMcp\}/);
  assert.match(electronMain, /codexCatalogVerified:\s*true,[\s\S]*?codexRestartRequired:\s*false,[\s\S]*?codexRestartRequestedAt:\s*null/);
});

test("Advanced VS Code setup is nested under Codex Config and offers Automatic and Manual paths", () => {
  const start = appSource.indexOf("function VsCodeAdvancedSurface");
  const end = appSource.indexOf("function McpSurface", start);
  const source = appSource.slice(start, end);
  const sidebarStart = appSource.indexOf('<nav className="sidebar-nav"');
  const sidebarEnd = appSource.indexOf("</nav>", sidebarStart);
  const sidebarSource = appSource.slice(sidebarStart, sidebarEnd);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(appSource, /surface === "vscode-advanced"/);
  assert.doesNotMatch(sidebarSource, /vscode-advanced|copy\.vscodeAdvanced/);
  assert.match(sidebarSource, /label=\{copy\.codexConfig\}[\s\S]*?onClick=\{navigateCodexRoot\}/);
  assert.match(appSource, /const navigateCodexRoot = \(\) => \{[\s\S]*?setCodexRootRequest\(\(request\) => request \+ 1\)[\s\S]*?navigateSurface\("codex"\)/);
  assert.match(appSource, /rootRequest=\{codexRootRequest\}/);
  assert.match(appSource, /useEffect\(\(\) => \{\s*setSubview\("config"\);\s*\}, \[rootRequest\]\)/);
  assert.match(source, /onBack: \(\) => void/);
  assert.match(source, /className="text-button nested-surface-back"[\s\S]*?copy\.codexConfig/);
  assert.match(source, /mode === "automatic"/);
  assert.match(source, /mode === "manual"/);
  assert.match(source, /api!\.setupVsCodeAdvanced\(\)/);
  assert.match(source, /api!\.installVsCodeAdvancedProxy\(\)/);
  assert.match(source, /api!\.removeVsCodeAdvanced\(\)/);
  assert.match(source, /chatgpt\.cliExecutable/);
  assert.match(source, /copy\.vscodeAdvancedFallback/);
  assert.match(preloadSource, /vscodeAdvancedConfig:[\s\S]*?launcher:vscode-advanced-config/);
  assert.match(preloadSource, /setupVsCodeAdvanced:[\s\S]*?launcher:vscode-advanced-setup/);
  assert.match(electronMain, /launcher:vscode-advanced-proxy-install[\s\S]*?runtimeHost\.installVsCodeAdvancedProxy\(\)/);
  assert.doesNotMatch(i18nSource, /JetBrains|client-agnostic/);
  assert.match(i18nSource, /Stop or Quit restores the previous cliExecutable value/i);
});

test("Codex native tool health is auto-checked on runtime start and nested under Codex Config", () => {
  const configStart = appSource.indexOf("function CodexConfigSurface");
  const toolsStart = appSource.indexOf("function CodexToolHealthSurface", configStart);
  const vscodeStart = appSource.indexOf("function VsCodeAdvancedSurface", toolsStart);
  const configSource = appSource.slice(configStart, toolsStart);
  const toolsSource = appSource.slice(toolsStart, vscodeStart);

  assert.ok(configStart >= 0 && toolsStart > configStart && vscodeStart > toolsStart);
  assert.match(configSource, /setSubview\("codex-tools"\)/);
  assert.match(configSource, /className="next-surface-row"[\s\S]*?copy\.codexToolHealthTitle[\s\S]*?copy\.codexToolHealthSubtitle/);
  assert.doesNotMatch(configSource, /className="codex-tool-health-list"/);
  assert.match(toolsSource, /className="text-button nested-surface-back"[\s\S]*?copy\.codexConfig/);
  assert.match(toolsSource, /api!\.checkCodexTools\(\)/);
  assert.match(toolsSource, /className="codex-tool-health-list"/);
  assert.match(runtimeLifecycleSource, /runtimeHost\.activateRuntimeBridge\(\)[\s\S]*?checkToolsAfterStart\(healthGeneration\)/);
  assert.match(electronMain, /launcher:codex-tool-health-check[\s\S]*?runtimeHost\.checkCodexTools\(\)/);
  assert.match(preloadSource, /checkCodexTools:[\s\S]*?launcher:codex-tool-health-check/);
  assert.match(preloadSource, /onCodexToolHealthState:[\s\S]*?launcher:codex-tool-health-state/);
  assert.match(i18nSource, /Checked automatically whenever the runtime starts/);
  assert.match(i18nSource, /Starting the runtime runs this same check automatically/);
});

test("settings expose a reversible UI-only Codex usage upsell toggle", () => {
  assert.match(appSource, /label=\{copy\.hideCodexUsageUpsell\}[\s\S]*?checked=\{snapshot\.state\.hideCodexUsageUpsell\}/);
  assert.match(appSource, /api!\.setCodexUsageUpsellHidden\(enabled\)/);
  assert.match(preloadSource, /setCodexUsageUpsellHidden:[\s\S]*?launcher:codex-usage-upsell-hidden/);
  assert.match(preloadSource, /onCodexUsageUpsellState:[\s\S]*?launcher:codex-usage-upsell-state/);
  assert.match(electronMain, /new CodexUsageUpsellPatcher\(\{ logger \}\)/);
  assert.match(electronMain, /hideCodexUsageUpsell === true[\s\S]*?syncCodexUsageUpsellPatch/);
  assert.match(i18nSource, /hideCodexUsageUpsell: "Hide Codex usage-limit upsell"/);
  assert.match(i18nSource, /Usage limits, credits and API behavior are unchanged/);
  assert.match(i18nSource, /official extension remains updateable through VS Code/);
});

test("runtime lifecycle owns the Codex bridge without exposing a separate switch", () => {
  assert.doesNotMatch(appSource, /api!\.setBridgeEnabled|copy\.bridgeRoute/);
  assert.doesNotMatch(preloadSource, /launcher:bridge-enabled/);
  assert.doesNotMatch(i18nSource, /Codex bridge/);
  assert.match(electronMain, /createRuntimeLifecycleCoordinator\(/);
  assert.match(runtimeLifecycleSource, /const start = async \(\) => \{[\s\S]*?runtimeHost\.activateRuntimeBridge\(\)/);
  assert.match(runtimeLifecycleSource, /const stop = async \(\{ restoreCodex = true \} = \{\}\) => \{[\s\S]*?runtimeHost\.deactivateRuntimeBridge\(\)/);
  assert.doesNotMatch(runtimeLifecycleSource, /abortAllTurns/);
  assert.match(runtimeLifecycleSource, /const restart = async \(\) => \{[\s\S]*?stop\(\{ restoreCodex: false \}\)/);
  assert.match(runtimeLifecycleSource, /const quit = async \(\{ commit \} = \{\}\) => \{[\s\S]*?stop\(\{ restoreCodex: true \}\)[\s\S]*?await commit\(\)/);
  assert.doesNotMatch(runtimeLifecycleSource, /await runtimeHost\.checkCodexTools\(\)/);
  assert.match(electronMain, /requestQuit[\s\S]*?runtimeLifecycle\.quit\(\{ commit \}\)/);
  const requestQuitStart = electronMain.indexOf("async function requestQuit");
  const requestQuitEnd = electronMain.indexOf("function loggerForQuit", requestQuitStart);
  const requestQuitSource = electronMain.slice(requestQuitStart, requestQuitEnd);
  const quitCommitStart = requestQuitSource.indexOf("const commit = async () =>");
  assert.equal(requestQuitSource.slice(0, quitCommitStart).includes("stopRuntimeStatusMonitor()"), false);
  assert.match(requestQuitSource.slice(quitCommitStart), /stopRuntimeStatusMonitor\(\)[\s\S]*?app\.quit\(\)/);
  const stopLifecycle = electronMain.slice(
    electronMain.indexOf("async function stopManagedRuntime"),
    electronMain.indexOf("async function restartManagedRuntime"),
  );
  assert.doesNotMatch(stopLifecycle, /mcp|connector|credential/i);
  assert.match(electronMain, /function codexRestartPending[\s\S]*?codexRestartRequired:\s*true[\s\S]*?codexRestartRequestedAt:/);
});

test("long-running diagnostics expose action-local progress", () => {
  assert.match(appSource, /activeAction === "doctor" \? <ButtonSpinner \/> : <Icon name="chevron" \/>/);
  assert.match(appSource, /activeAction === "cancel" \? <ButtonSpinner \/> : <Icon name="chevron" \/>/);
  assert.match(appSource, /activeAction === "uninstall" \? <ButtonSpinner \/> : <Icon name="chevron" \/>/);
});

test("doctor summary never hides failed checks behind trailing healthy checks", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("settings keep quiet native scrollbars without a language selector", () => {
  assert.doesNotMatch(appSource, /LanguageMenu|language-menu|setLanguage/);
  assert.match(styles, /\*::\-webkit-scrollbar-button\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.content-scroll:hover::\-webkit-scrollbar-thumb\s*\{/);
});

test("launcher is English-only and exposes no repository UI", () => {
  assert.doesNotMatch(appSource, /WelcomeOption|WelcomeAction|LanguageMenu|icon="github"|urls\.github|zh-CN|简体中文/);
  assert.doesNotMatch(preloadSource, /setLanguage:|openSocial:|completeOnboarding:/);
  assert.doesNotMatch(electronMain, /launcher:(?:set-language|open-social|complete-onboarding)|GITHUB_URL|zh-CN|简体中文/);
  assert.doesNotMatch(i18nSource, /Choose your language|Open repository|简体中文|zh-CN/);
});

test("MCP copy includes every required account, key, and connector instruction", () => {
  assert.match(i18nSource, /regular API key with Tunnels Read \+ Use \(free;/);
  assert.match(i18nSource, /Don't forget to create a ChatGPT workspace\./);
  assert.match(i18nSource, /same OpenAI account that will use the connector/);
  assert.match(i18nSource, /only after this step succeeds and the tunnel is running/);
  assert.match(appSource, /className="mcp-step-two-hint"/);
  assert.match(i18nSource, /enable Developer Mode[\s\S]*?choose Tunnel[\s\S]*?set Authentication to None/);
  assert.match(appSource, /<NoticeRow icon="alert" tone="warning">/);
  assert.doesNotMatch(appSource, /icon="spark"/);
});

test("MCP wizard remains locked while a local or supervisor operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = activeAction !== null \|\| operation\?\.status === "running"/);
  assert.match(appSource, /loading=\{activeAction === "connect"\}/);
  assert.match(appSource, /loading=\{activeAction === "verify"\}/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
  assert.match(appSource, /disabled=\{busy\} onClick=\{\(\) => void safeMove\(1\)\}/);
  assert.doesNotMatch(appSource, /connectorOpened/);
});

test("MCP wizard reuses saved credentials and exposes replacement explicitly", () => {
  assert.match(electronMain, /mcpCredentialsConfigured:\s*runtimeHost\?\.mcpCredentialsConfigured\(\)\s*\?\?\s*false/);
  assert.match(appSource, /credentialsConfigured && !replacingCredentials/);
  assert.match(appSource, /\{ replace: false \}/);
  assert.match(appSource, /\{ tunnelId, runtimeKey, replace: true \}/);
  assert.match(i18nSource, /replaceCredentials: "Replace credentials"/);
});

test("MCP verification has one primary action and exposes live progress", () => {
  const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
  assert.doesNotMatch(
    appSource,
    /<SecondaryButton disabled=\{busy \|\| !connectorOpened\} onClick=\{\(\) => void verify\(\)\}>/,
  );
  assert.match(appSource, /<PrimaryButton\s+disabled=\{busy \|\| snapshot\.runtime\.lifecycle !== "ready"\}/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
  assert.match(
    electronMain,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(appSource, /if \(busy \|\| snapshot\.runtime\.lifecycle !== "ready"\) return;/);
  assert.match(browserHostSource, /runConnectorVerification[\s\S]*?setBackgroundThrottling\(false\)[\s\S]*?beginConnectorVerificationSurface\(\)[\s\S]*?verifyConnectorWithBrowserHelper[\s\S]*?setBackgroundThrottling\(true\)/);
  assert.match(browserHostSource, /beginConnectorVerificationSurface[\s\S]*?setBounds\([\s\S]*?contentWidth - 1[\s\S]*?contentHeight - 1[\s\S]*?setVisible\(true\)/);
  assert.doesNotMatch(
    browserHostSource,
    /querySelectorAll\('\[role="group"\], \[role="option"\], \[role="menuitem"\]'\)/,
  );
});

test("launcher refreshes persisted ChatGPT authentication before presenting setup", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
  assert.match(i18nSource, /checkingSignIn: "Checking saved session"/);
});

test("launcher reminds authenticated users to refresh the private ChatGPT session every 48 hours", () => {
  assert.match(electronMain, /sessionRefreshReminderAt:\s*nextSessionRefreshReminderAt\(\)/);
  assert.match(electronMain, /launcher:session-reminder-dismiss/);
  assert.match(electronMain, /launcher:browser-logout[\s\S]*?browserHost\.logout\(\)/);
  assert.match(preloadSource, /dismissSessionReminder:[\s\S]*?launcher:session-reminder-dismiss/);
  assert.match(preloadSource, /logoutChatGpt:[\s\S]*?launcher:browser-logout/);
  assert.match(browserHostSource, /session\.clearStorageData\(\)/);
  assert.match(appSource, /browser\?\.authenticated !== true/);
  assert.match(appSource, /window\.setTimeout\(\(\) => setSessionReminderDue\(true\), delay\)/);
  assert.match(appSource, /copy\.dismiss[\s\S]*?copy\.logOut/);
  assert.match(i18nSource, /signing in again every two days/);
});

test("launcher checks once at startup and exposes a blue user-triggered update action", () => {
  assert.match(electronMain, /createUpdateController/);
  assert.match(electronMain, /void updateController\.checkOnce\(\)/);
  assert.doesNotMatch(electronMain, /setInterval\([^)]*update/i);
  assert.match(preloadSource, /installUpdate:[\s\S]*?launcher:update-install/);
  assert.match(appSource, /tone="update"/);
  assert.match(appSource, /copy\.updateAvailable/);
  assert.match(styles, /\.sidebar-item\.is-update\s*\{[^}]*background:\s*rgb\(51 156 255 \/ 14%\)/s);
  assert.match(i18nSource, /updateAvailable: "Update to"/);
});
