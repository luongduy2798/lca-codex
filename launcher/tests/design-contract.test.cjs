const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const styles = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
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

test("embedded ChatGPT is measured after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("launcher keeps browser chrome flush and MCP instructions below the video", () => {
  assert.match(styles, /\.workspace\s*\{[^}]*padding-top:\s*0/s);
  assert.match(styles, /\.content-surface\s*\{[^}]*padding-top:\s*var\(--height-titlebar\)/s);
  assert.match(styles, /\.mcp-stage\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(
    styles,
    /\.guide-media\s*\{[^}]*width:\s*min\(90%,\s*clamp\(511px,\s*44vw,\s*620px\)\)[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*overflow:\s*hidden/s,
  );
  assert.match(styles, /\.guide-media img\s*\{[^}]*object-fit:\s*contain/s);
  assert.doesNotMatch(styles, /\.wizard-stepper\s*\{[^}]*border-(?:top|bottom)/s);
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
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
  assert.match(i18nSource, /keepRunningOnClose: "Keep launcher running when window closes"/);
});

test("sidebar exposes ChatGPT and Codex modes without consuming browser header space", () => {
  assert.match(appSource, /className=\{`sidebar-mode-card/);
  assert.match(appSource, /snapshot\.runtime\.mode === "full"[\s\S]*?copy\.codexMode/);
  assert.match(appSource, /snapshot\.runtime\.mode === "browser-only"[\s\S]*?copy\.chatgptMode/);
  assert.match(appSource, /onClick=\{\(\) => navigateSurface\("mcp"\)\}/);
  assert.match(appSource, /RuntimeDetail label=\{copy\.runtimeMode\}[\s\S]*?copy\.codexMode[\s\S]*?copy\.chatgptMode/);
  assert.match(i18nSource, /chatgptMode: "ChatGPT"/);
  assert.match(i18nSource, /General-purpose AI assistant/);
  assert.match(i18nSource, /codexMode: "Codex"/);
  assert.match(i18nSource, /Coding agent\. Can actively inspect and modify the workspace/);
  assert.match(styles, /\.sidebar-mode-card\s*\{/);
  assert.doesNotMatch(appSource, /titlebar-mode|header-mode/);
});

test("manual-first runtime controls are global and startup stays observe-only by default", () => {
  for (const apiCall of ["runtimeStatus", "startRuntime", "stopRuntime", "restartRuntime", "onRuntimeState"]) {
    assert.match(preloadSource, new RegExp(`${apiCall}:`));
  }
  assert.match(appSource, /className="titlebar-runtime no-drag"/);
  assert.match(appSource, /activeAction === "start" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /activeAction === "restart" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /activeAction === "stop" \? <ButtonSpinner \/> : null/);
  assert.match(appSource, /function RuntimeServiceSurface/);
  assert.match(appSource, /setPreference\("runtimeAutoStart", checked\)/);
  assert.match(electronMain, /await publishRuntimeStatus\(\);\s*startRuntimeStatusMonitor\(\);\s*if \(stateStore\.read\(\)\.runtimeAutoStart === true\)/);
  assert.match(electronMain, /const status = await runtimeSupervisor\.startRuntime\(\)/);
  assert.match(electronMain, /const status = await runtimeSupervisor\.stopRuntime\(\)/);
});

test("Codex config keeps automatic actions minimal and manual mode editable", () => {
  const start = appSource.indexOf("function CodexConfigSurface");
  const end = appSource.indexOf("function McpSurface", start);
  const codexConfigSource = appSource.slice(start, end);
  assert.match(codexConfigSource, /api!\.setupCore\(\)/);
  assert.match(codexConfigSource, /className="config-mode-toolbar"[\s\S]*?copy\.refreshing[\s\S]*?copy\.refresh/);
  assert.match(codexConfigSource, /api!\.uninstallIntegration\(\)/);
  assert.match(codexConfigSource, /api!\.saveCodexConfig\(manualContent\)/);
  assert.match(codexConfigSource, /<textarea[\s\S]*?config-file-editor/);
  assert.match(codexConfigSource, /copy\.save/);
  assert.match(codexConfigSource, /loading=\{activeAction === "install"\}/);
  assert.match(codexConfigSource, /const modelsInstalled = config\?\.installed === true/);
  assert.match(codexConfigSource, /modelsInstalled \? copy\.reinstallModels : copy\.install/);
  assert.match(codexConfigSource, /modelsInstalled \? copy\.reinstallingModels : copy\.installingModels/);
  assert.match(i18nSource, /reinstallModels: "Reinstall models"/);
  assert.match(i18nSource, /reinstallingModels: "Reinstalling…"/);
  assert.match(codexConfigSource, /loading=\{activeAction === "restore"\}/);
  assert.match(codexConfigSource, /loading=\{activeAction === "save"\}/);
  assert.match(codexConfigSource, /activeAction === "refresh" \? <ButtonSpinner \/> : null/);
  assert.match(styles, /\.button-spinner\s*\{[^}]*animation:\s*spin 0\.8s linear infinite/s);
  assert.doesNotMatch(codexConfigSource, /toggleRoute|resetCodexConfig|copy\.resetConfig|copy\.disconnect/);
  const configActionsStart = codexConfigSource.indexOf('className="inline-actions config-actions"');
  const configActionsEnd = codexConfigSource.indexOf("</div>", configActionsStart);
  assert.doesNotMatch(codexConfigSource.slice(configActionsStart, configActionsEnd), /copy\.refresh/);
  assert.match(electronMain, /runtimeHost\.setupCore\(\{ replaceCodexRoute: true \}\)/);
  assert.doesNotMatch(electronMain, /Replace existing route|--replace-codex-route/);
  assert.match(preloadSource, /saveCodexConfig:[\s\S]*?launcher:codex-config-save/);
  assert.doesNotMatch(preloadSource, /codex-config-reset|resetCodexConfig/);
  assert.match(electronMain, /launcher:codex-config-save[\s\S]*?runtimeHost\.saveCodexConfig\(content\)/);
  assert.doesNotMatch(electronMain, /launcher:codex-config-reset/);
  assert.match(i18nSource, /restorePreviousRoute: "Restore native Codex"/);
  assert.match(i18nSource, /save: "Save"/);
  assert.match(codexConfigSource, /className="codex-next-steps"/);
  assert.match(codexConfigSource, /api!\.startRuntime\(\)/);
  assert.match(codexConfigSource, /copy\.startLcaServiceAction/);
  assert.match(codexConfigSource, /copy\.codexCliRestart/);
  assert.match(codexConfigSource, /copy\.vscodeRestart/);
  assert.match(i18nSource, /Developer: Reload Window/);
  assert.match(styles, /\.codex-next-step\.is-pending\s*\{[^}]*opacity:/s);
});

test("settings expose a persistent fail-closed Codex bridge switch and status indicator", () => {
  assert.match(appSource, /api!\.setBridgeEnabled\(enabled\)/);
  assert.match(appSource, /snapshot\.state\.bridgeEnabled \? "success" : "error"/);
  assert.match(appSource, /body=\{copy\.bridgeRouteBody\} label=\{copy\.bridgeRoute\}/);
  assert.match(styles, /\.action-dot\.is-success\s*\{[^}]*background:\s*var\(--green-300\)/s);
  assert.match(styles, /\.action-dot\.is-error\s*\{[^}]*background:\s*var\(--red-300\)/s);
  assert.match(electronMain, /runtimeHost\.setBridgeEnabled\(enabled === true\)/);
  assert.match(electronMain, /codexRestartRequired:\s*true/);
  assert.match(i18nSource, /Turning it off restores your previous model route without deleting setup or saved credentials/);
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

test("MCP guide uses the two optimized recordings in the requested step order", () => {
  assert.match(
    appSource,
    /MCP_GUIDE_MEDIA = \[\s*new URL\("\.\/assets\/mcp-create-tunnel\.gif"[\s\S]*?new URL\("\.\/assets\/mcp-connect-connector\.gif"[\s\S]*?new URL\("\.\/assets\/mcp-connect-connector\.gif"/,
  );
  for (const file of ["mcp-create-tunnel.gif", "mcp-connect-connector.gif"]) {
    const asset = fs.readFileSync(path.join(launcherRoot, "src", "assets", file));
    assert.equal(asset.subarray(0, 6).toString("ascii"), "GIF89a");
    assert.ok(asset.length < 5 * 1024 * 1024, `${file} is unexpectedly large`);
  }
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
  assert.doesNotMatch(
    appSource,
    /<SecondaryButton disabled=\{busy \|\| !connectorOpened\} onClick=\{\(\) => void verify\(\)\}>/,
  );
  assert.match(appSource, /<PrimaryButton\s+disabled=\{busy\}/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
  assert.match(
    electronMain,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
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
