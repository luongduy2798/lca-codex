const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { WebContentsView, shell } = require("electron");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { verifyConnectorWithBrowserHelper } = require("./browser-helper-verifier.cjs");
const { processRunning } = require("./process-tree.cjs");
const {
  dispatchTrustedClick,
  dispatchTrustedKey,
  evaluatePage,
} = require("./cdp-input.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("./browser-state.cjs");

const NORMAL_CHAT_URL = "https://chatgpt.com/";
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CONNECTOR_SETTINGS_HASH = "#settings/Connectors";
const IDLE_BROWSER_URL = "about:blank#lca-codex-browser-host";
const SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const SMOKE_EXPECTED = "CODEX WEB GPT READY";
const SMOKE_SUBMISSION_TIMEOUT_MS = 15_000;
const SMOKE_RESPONSE_TIMEOUT_MS = 120_000;
const SMOKE_COMPLETION_SETTLE_MS = 1_500;
const MAX_BROWSER_VIEW_DIMENSION = 16_384;
const MAX_BROWSER_TABS = 5;
const DEFAULT_BACKGROUND_BROWSER_SIZE = Object.freeze({ width: 1024, height: 720 });
const CHATGPT_PARTITION = "persist:lca-codex-chatgpt";
const CHATGPT_BACKEND_REQUEST_FILTER = { urls: [`${CHATGPT_ORIGIN}/backend-api/*`] };
const GOOGLE_OAUTH_REQUEST_FILTER = { urls: ["https://accounts.google.com/o/oauth2/*"] };
const CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS = 500;
const CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS = 1_000;
const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
].join(", ");
const PRO_CAPABILITY_CONTROL_TIMEOUT_MS = 5_000;
const PRO_CAPABILITY_MENU_TIMEOUT_MS = 4_000;
const PRO_CAPABILITY_RESET_TIMEOUT_MS = 2_000;
const EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="slider"][aria-valuenow][aria-valuemax])',
  '[role="menu"]:has([role="slider"][aria-valuenow][aria-valuemax])',
  '[role="group"]:has([role="slider"][aria-valuenow][aria-valuemax])',
].join(", ");
const COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
const USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(", ");
const CONVERSATION_OPTIONS_SELECTOR = '[data-testid="conversation-options-button"]';
const DELETE_CHAT_MENU_ITEM_SELECTOR = '[data-testid="delete-chat-menu-item"]';
const CONFIRM_DELETE_CHAT_SELECTOR = [
  '[role="dialog"] [data-testid="confirm-delete-conversation"]',
  '[role="dialog"] button[data-color="danger"]',
  '[role="dialog"] button[class*="btn-danger"]',
].join(", ");
const CHAT_DELETE_ELEMENT_TIMEOUT_MS = 2_500;
const CHAT_DELETE_VERIFY_TIMEOUT_MS = 6_000;
const CHAT_DELETE_UI_STABLE_MS = 400;
const CHATGPT_VIEWPORT_CSS = `
  html,
  body {
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
    overscroll-behavior-x: none !important;
  }

  #__next {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-x: hidden !important;
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function visibleElementScript(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  })`;
}

function normalizeBounds(bounds) {
  const read = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    x: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.x)),
    y: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.y)),
    width: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.width))),
    height: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.height))),
  };
}

function initialBrowserBounds(window) {
  const [contentWidth, contentHeight] = window.getContentSize();
  return normalizeBounds({
    x: 0,
    y: 0,
    width: contentWidth > 1 ? contentWidth : DEFAULT_BACKGROUND_BROWSER_SIZE.width,
    height: contentHeight > 1 ? contentHeight : DEFAULT_BACKGROUND_BROWSER_SIZE.height,
  });
}

function allowedAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && (
    parsed.hostname === "chatgpt.com"
    || parsed.hostname.endsWith(".openai.com")
    || parsed.hostname === "accounts.google.com"
    || parsed.hostname === "login.microsoftonline.com"
    || parsed.hostname.endsWith(".apple.com")
  );
}

function googleAccountChooserUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") return null;
  if (!/^\/o\/oauth2\/(?:v2\/)?auth\/?$/.test(parsed.pathname)) return null;
  const prompts = (parsed.searchParams.get("prompt") || "").split(/\s+/).filter(Boolean);
  if (prompts.includes("select_account")) return null;
  parsed.searchParams.set(
    "prompt",
    prompts.includes("none") ? "select_account" : [...prompts, "select_account"].join(" "),
  );
  return parsed.toString();
}

function normalizeChatMode(value) {
  return value === "temporary" ? "temporary" : "normal";
}

function chatUrlForMode(mode) {
  return normalizeChatMode(mode) === "temporary" ? TEMPORARY_CHAT_URL : NORMAL_CHAT_URL;
}

function isChatGptPageMode(value, mode) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.origin !== CHATGPT_ORIGIN || parsed.pathname !== "/") return false;
  const temporary = parsed.searchParams.get("temporary-chat") === "true";
  return normalizeChatMode(mode) === "temporary" ? temporary : !temporary;
}

function isTemporaryChatUrl(value) {
  return isChatGptPageMode(value, "temporary");
}

function isChatGptChatUrl(value) {
  return isChatGptPageMode(value, "normal") || isChatGptPageMode(value, "temporary");
}

function preferredChatModeFor(host) {
  const preferences = typeof host?.getPreferences === "function" ? host.getPreferences() : undefined;
  return normalizeChatMode(preferences?.chatMode ?? host?.chatMode);
}

function preferredChatUrlFor(host) {
  return chatUrlForMode(preferredChatModeFor(host));
}

function chatGptConversationIdFromUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.origin !== CHATGPT_ORIGIN) return null;
  const match = /^\/c\/([A-Za-z0-9_-]{16,128})\/?$/.exec(parsed.pathname);
  return match?.[1] || null;
}

function initializationNavigationWasSuperseded(error, expectedUrl, currentUrl) {
  const code = error && typeof error === "object" ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (code === "ERR_ABORTED" || /\bERR_ABORTED\s*\(-3\)/.test(message))
    && currentUrl !== expectedUrl
    && isChatGptChatUrl(currentUrl);
}

function isChatGptBackendUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN && parsed.pathname.startsWith("/backend-api/");
}

function isChatGptConversationMutationResponse(details, conversationId) {
  if (!details || !/^[A-Za-z0-9_-]{16,128}$/.test(conversationId || "")) return false;
  const method = typeof details.method === "string" ? details.method.toUpperCase() : "";
  if (!["PATCH", "POST", "DELETE"].includes(method)) return false;
  let parsed;
  try {
    parsed = new URL(details.url);
  } catch {
    return false;
  }
  if (parsed.origin !== CHATGPT_ORIGIN) return false;
  const prefixes = [
    `/backend-api/conversation/${conversationId}`,
    `/backend-api/conversation/id/${conversationId}`,
    `/backend-api/conversations/${conversationId}`,
  ];
  return prefixes.some(prefix => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`));
}

function responseHeaderIncludes(responseHeaders, name, expectedValue) {
  const expected = expectedValue.toLowerCase();
  return Object.entries(responseHeaders || {}).some(([headerName, rawValues]) => {
    if (headerName.toLowerCase() !== name.toLowerCase()) return false;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    return values.some(value => String(value)
      .split(",")
      .some(candidate => candidate.trim().toLowerCase() === expected));
  });
}

function isChatGptCloudflareChallengeResponse(details) {
  return details?.statusCode === 403
    && isChatGptBackendUrl(details.url)
    && responseHeaderIncludes(details.responseHeaders, "cf-mitigated", "challenge");
}

class BrowserHost {
  constructor({ window, descriptorPath, cdpPort, control, helper, logger, publishState, getPreferences }) {
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.helper = helper;
    this.logger = logger;
    this.publishState = publishState;
    this.getPreferences = typeof getPreferences === "function" ? getPreferences : () => ({ chatMode: "normal" });
    this.dispatchTrustedClick = dispatchTrustedClick;
    this.dispatchTrustedKey = dispatchTrustedKey;
    this.evaluatePage = evaluatePage;
    this.verifyConnectorWithBrowserHelper = verifyConnectorWithBrowserHelper;
    this.surfaceId = randomBytes(24).toString("base64url");
    this.visible = false;
    this.surfaceActive = true;
    this.turnTabs = new Map();
    this.closedTurnOwners = new Map();
    this.chatCleanupWaiters = new Map();
    this.selectedTabId = "home";
    this.manualOperation = null;
    this.loginOperation = null;
    this.cloudflareChallengeRecovery = null;
    this.cloudflareChallengeRecoveryArmed = true;
    this.cloudflareChallengeRecoveryDelayMs = CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS;
    this.cloudflareChallengeRecoverySettleMs = CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS;
    this.viewportCssKey = null;
    this.authView = null;
    this.boundsReady = false;
    // Turn views must have a usable viewport even before the renderer mounts the Browser tab and
    // reports its exact slot. Keep boundsReady false so this fallback is never shown as UI bounds.
    this.bounds = initialBrowserBounds(window);
    this.state = {
      status: "idle",
      message: "No active task",
      url: "about:blank",
      title: "ChatGPT",
      authenticated: false,
      visible: false,
      surfaceActive: true,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    this.view = new WebContentsView({
      webPreferences: {
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    this.view.setVisible(false);
    this.bindChatGptBackendRecovery();
    this.bindGoogleAccountChooser();
    this.bindWebContents();
    void this.view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      const currentUrl = this.view.webContents.getURL();
      if (initializationNavigationWasSuperseded(error, IDLE_BROWSER_URL, currentUrl)) {
        this.logger.info("browser.initialization_superseded", { url: currentUrl });
        return;
      }
      this.logger.error("browser.initialization_failed", { message: error instanceof Error ? error.message : String(error) });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
    });
    this.writeDescriptor();
  }

  get activeTraceId() {
    return [...this.turnTabs.values()].find((tab) => tab.status === "running")?.traceId || null;
  }

  preferredChatMode() {
    return preferredChatModeFor(this);
  }

  preferredChatUrl() {
    return preferredChatUrlFor(this);
  }

  tabSnapshot(tab) {
    return {
      id: tab.id,
      traceId: tab.traceId,
      title: tab.label,
      status: tab.status,
      loading: tab.loading === true,
      active: this.selectedTabId === tab.id,
      closable: true,
    };
  }

  selectedTurnTab() {
    return this.turnTabs.get(this.selectedTabId) || null;
  }

  createTurnTab(traceId, helperPid, chatMode) {
    if (this.turnTabs.size >= MAX_BROWSER_TABS) {
      throw new Error(
        `LCA Codex already has ${MAX_BROWSER_TABS} browser tabs; close one before starting another turn to avoid excessive parallel traffic on the ChatGPT account`,
      );
    }
    const id = randomBytes(12).toString("base64url");
    const surfaceId = randomBytes(24).toString("base64url");
    const ordinal = Array.from({ length: MAX_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values()].some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("LCA Codex browser tab allocation is inconsistent");
    const view = new WebContentsView({
      webPreferences: {
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    const tab = {
      id,
      surfaceId,
      traceId,
      helperPid,
      chatMode: normalizeChatMode(chatMode),
      view,
      status: "running",
      ordinal,
      label: `ChatGPT ${ordinal}`,
      pageTitle: "ChatGPT",
      url: IDLE_BROWSER_URL,
      loading: true,
      message: "ChatGPT is working",
      cleanupHidden: false,
      freshNormalChatObserved: false,
      ownedConversationId: null,
      conversationOwnershipInvalid: false,
    };
    this.turnTabs.set(id, tab);
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    this.bindTurnContents(tab);
    void view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      tab.status = "error";
      tab.loading = false;
      tab.message = error instanceof Error ? error.message : String(error);
      this.publishState?.(this.snapshot());
    });
    return tab;
  }

  recordTurnConversationNavigation(tab, url) {
    tab.url = url;
    if (tab.chatMode !== "normal" || tab.conversationOwnershipInvalid) return;
    if (isChatGptPageMode(url, "normal")) {
      if (!tab.ownedConversationId) tab.freshNormalChatObserved = true;
      return;
    }
    const conversationId = chatGptConversationIdFromUrl(url);
    if (!conversationId) return;
    if (!tab.freshNormalChatObserved) {
      tab.conversationOwnershipInvalid = true;
      return;
    }
    if (!tab.ownedConversationId) {
      tab.ownedConversationId = conversationId;
      this.logger.info("browser.conversation_owned", { tabId: tab.id, traceId: tab.traceId });
      return;
    }
    if (tab.ownedConversationId !== conversationId) tab.conversationOwnershipInvalid = true;
  }

  bindTurnContents(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
      return { action: "deny" };
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.recordTurnConversationNavigation(tab, contents.getURL());
      this.publishState?.(this.snapshot());
    });
    contents.on("did-finish-load", () => {
      this.recordTurnConversationNavigation(tab, contents.getURL());
      tab.loading = false;
      void contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => {});
      const encoded = JSON.stringify(tab.surfaceId);
      void contents.executeJavaScript(`(() => {
        Object.defineProperty(globalThis, "__LCA_CODEX_SURFACE_ID__", {
          value: ${encoded}, configurable: true, enumerable: false, writable: false,
        });
        document.documentElement.dataset.codexWebGptSurface = ${encoded};
      })()`, true).then(
        () => this.publishState?.(this.snapshot()),
        (error) => {
          tab.status = "error";
          tab.message = `Browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
          this.publishState?.(this.snapshot());
        },
      );
    });
    contents.on("page-title-updated", (_event, title) => {
      if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-navigate", (_event, url, _httpResponseCode, _httpStatusText, mainFrame) => {
      if (mainFrame) this.recordTurnConversationNavigation(tab, url);
      this.publishState?.(this.snapshot());
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.recordTurnConversationNavigation(tab, url);
      this.publishState?.(this.snapshot());
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      tab.status = "error";
      tab.loading = false;
      tab.url = url;
      tab.message = errorDescription;
      this.logger.error("browser.tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        errorCode,
        errorDescription,
        url,
      });
      this.publishState?.(this.snapshot());
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.status = "error";
      tab.loading = false;
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.publishState?.(this.snapshot());
    });
  }

  bindWebContents() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        return {
          action: "allow",
          createWindow: (options) => this.createAuthView(options),
        };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString());
      } else {
        this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
      }
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      this.setState(this.activeTraceId || this.manualOperation
        ? { url, loading: true }
        : { status: "loading", message: "Opening ChatGPT", url, loading: true });
    });
    contents.on("did-finish-load", () => {
      this.setState({ url: contents.getURL(), loading: false });
      void this.applyViewportCss();
      void this.markOwnedSurface()
        .then(() => this.probeAuthentication())
        .catch((error) => {
          this.logger.error("browser.surface_mark_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          this.setState({ status: "error", message: "Embedded browser ownership could not be established" });
        });
    });
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.setState({ url });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}` });
    });
  }

  bindChatGptBackendRecovery() {
    this.view.webContents.session.webRequest.onCompleted(
      CHATGPT_BACKEND_REQUEST_FILTER,
      details => this.handleChatGptBackendResponse(details),
    );
  }

  observeChatCleanupBackendResponse(details) {
    if (!this.chatCleanupWaiters) return false;
    const waiter = this.chatCleanupWaiters.get(details?.webContentsId);
    if (!waiter || !isChatGptConversationMutationResponse(details, waiter.conversationId)) return false;
    this.chatCleanupWaiters.delete(details.webContentsId);
    clearTimeout(waiter.timer);
    if (details.statusCode >= 200 && details.statusCode < 300) {
      waiter.resolve({ method: details.method, statusCode: details.statusCode, url: details.url });
    } else {
      waiter.reject(new Error(`ChatGPT delete mutation failed with HTTP ${details.statusCode}`));
    }
    return true;
  }

  waitForChatCleanupMutation(tab, conversationId) {
    const webContentsId = tab.view.webContents.id;
    const previous = this.chatCleanupWaiters.get(webContentsId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error("ChatGPT delete mutation waiter was replaced"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.chatCleanupWaiters.get(webContentsId);
        if (current?.timer !== timer) return;
        this.chatCleanupWaiters.delete(webContentsId);
        reject(new Error("ChatGPT delete mutation did not complete before cleanup timeout"));
      }, CHAT_DELETE_VERIFY_TIMEOUT_MS);
      this.chatCleanupWaiters.set(webContentsId, { conversationId, resolve, reject, timer });
    });
  }

  bindGoogleAccountChooser() {
    this.view.webContents.session.webRequest.onBeforeRequest(
      GOOGLE_OAUTH_REQUEST_FILTER,
      (details, callback) => {
        if (details.resourceType !== "mainFrame") {
          callback({});
          return;
        }
        const redirectURL = googleAccountChooserUrl(details.url);
        callback(redirectURL ? { redirectURL } : {});
      },
    );
  }

  handleChatGptBackendResponse(details) {
    this.observeChatCleanupBackendResponse(details);
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || details?.webContentsId !== contents.id) return false;
    if (!isChatGptBackendUrl(details.url)) return false;

    if (details.statusCode >= 200 && details.statusCode < 400) {
      this.cloudflareChallengeRecoveryArmed = true;
      return false;
    }
    if (!isChatGptCloudflareChallengeResponse(details)) return false;
    if (this.cloudflareChallengeRecovery) {
      this.cloudflareChallengeRecoveryArmed = false;
      return true;
    }
    if (this.activeTraceId || this.manualOperation) {
      this.logger.warn("browser.cloudflare_challenge_not_reloaded", {
        reason: this.activeTraceId ? "turn-active" : "manual-operation-active",
        url: details.url,
      });
      return true;
    }
    if (!this.cloudflareChallengeRecoveryArmed) {
      this.logger.warn("browser.cloudflare_challenge_persisted", { url: details.url });
      return true;
    }
    this.cloudflareChallengeRecoveryArmed = false;
    this.logger.warn("browser.cloudflare_challenge_detected", { url: details.url });
    const recovery = this.reloadHomeAfterCloudflareChallenge();
    const tracked = recovery
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.cloudflare_challenge_recovery_failed", { message });
        this.setState({ status: "error", message, loading: false });
      })
      .finally(() => {
        if (this.cloudflareChallengeRecovery === tracked) this.cloudflareChallengeRecovery = null;
      });
    this.cloudflareChallengeRecovery = tracked;
    return true;
  }

  async reloadHomeAfterCloudflareChallenge() {
    const contents = this.view.webContents;
    this.setState({
      status: "loading",
      message: "Refreshing ChatGPT security check",
      loading: true,
    });
    await sleep(this.cloudflareChallengeRecoveryDelayMs);
    if (contents.isDestroyed()) throw new Error("ChatGPT browser closed during security-check recovery");
    const url = contents.getURL();
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      throw new Error("ChatGPT security-check recovery lost its owned browser page");
    }

    // Only responses from this new document may prove that the challenge cleared.
    this.cloudflareChallengeRecoveryArmed = false;
    await contents.loadURL(url);
    await sleep(this.cloudflareChallengeRecoverySettleMs);
    if (!this.cloudflareChallengeRecoveryArmed) {
      throw new Error("ChatGPT security check is still blocking backend requests. Reload ChatGPT and retry.");
    }
    await this.probeAuthentication();
    this.logger.info("browser.cloudflare_challenge_recovered", { url });
  }

  snapshot() {
    const contents = this.activeView()?.webContents;
    const selected = this.selectedTurnTab();
    const homeTab = {
      id: "home",
      traceId: null,
      title: this.state.title || "ChatGPT",
      status: this.state.status,
      loading: this.state.loading === true,
      active: this.selectedTabId === "home",
      closable: false,
    };
    const state = selected
      ? {
          ...this.state,
          status: selected.status,
          message: selected.message,
          url: selected.url,
          title: selected.pageTitle,
          loading: selected.loading,
        }
      : this.state;
    const visibleTurnTabs = [...this.turnTabs.values()].filter((tab) => tab.cleanupHidden !== true);
    return {
      ...readBrowserNavigationState(contents, {
      ...state,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
      }),
      activeTabId: this.selectedTabId,
      tabs: visibleTurnTabs.length > 0
        ? [
            ...(this.selectedTabId === "home" ? [homeTab] : []),
            ...visibleTurnTabs.map((tab) => this.tabSnapshot(tab)),
          ]
        : [homeTab],
      maxTabs: MAX_BROWSER_TABS,
    };
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    };
    this.publishState?.(this.snapshot());
  }

  setBounds(bounds) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(normalizeBounds(bounds), { width, height });
    this.boundsReady = true;
    this.view.setBounds(this.bounds);
    for (const tab of this.turnTabs.values()) tab.view.setBounds(this.bounds);
    this.authView?.setBounds(this.bounds);
    this.syncViewVisibility();
    void this.view.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    if (this.authView && !this.authView.webContents.isDestroyed()) {
      void this.authView.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    }
  }

  activeView() {
    return this.authView || this.selectedTurnTab()?.view || this.view;
  }

  activateHomeSurface() {
    this.selectedTabId = "home";
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
  }

  syncViewVisibility() {
    const visible = browserViewVisible(this.visible, this.surfaceActive, this.boundsReady);
    const selected = this.selectedTurnTab();
    this.view.setVisible(visible && !this.authView && !selected);
    for (const tab of this.turnTabs.values()) {
      tab.view.setVisible(visible && !this.authView && selected?.id === tab.id && tab.cleanupHidden !== true);
    }
    this.authView?.setVisible(visible);
  }

  hideTurnTabForCleanup(tab) {
    if (!tab || tab.cleanupHidden === true) return;
    tab.cleanupHidden = true;
    if (this.selectedTabId === tab.id) {
      const fallback = [...this.turnTabs.values()]
        .filter((candidate) => candidate.id !== tab.id && candidate.cleanupHidden !== true)
        .at(-1);
      this.selectedTabId = fallback?.id || "home";
    }
    this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
    this.logger.info("browser.tab_hidden_for_cleanup", { tabId: tab.id, traceId: tab.traceId });
  }

  beginConnectorVerificationSurface() {
    if (browserViewVisible(this.visible, this.surfaceActive, this.boundsReady)) return () => {};
    const [contentWidth, contentHeight] = this.window.getContentSize();
    const fallback = initialBrowserBounds(this.window);
    // Chromium reports document.visibilityState=hidden whenever the launcher-owned WebContentsView
    // is actually hidden. Connector autocomplete will not reliably hydrate in that state. Keep a
    // full-size layout viewport alive while clipping all but one edge pixel outside the launcher
    // content area, so verification is browser-visible without covering or navigating away from
    // the MCP screen.
    this.view.setBounds({
      x: Math.max(0, contentWidth - 1),
      y: Math.max(0, contentHeight - 1),
      width: fallback.width,
      height: fallback.height,
    });
    this.view.setVisible(true);
    return () => {
      this.view.setBounds(this.bounds);
      this.syncViewVisibility();
    };
  }

  selectTab(tabId) {
    if (tabId !== "home" && !this.turnTabs.has(tabId)) throw new Error("Browser tab does not exist");
    if (this.authView) this.closeAuthView(this.authView, true);
    this.selectedTabId = tabId;
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
    return this.snapshot();
  }

  removeTurnTab(tab, abortRunning) {
    this.turnTabs.delete(tab.id);
    if (abortRunning && tab.status === "running") {
      this.closedTurnOwners.set(tab.traceId, tab.helperPid);
      tab.status = "aborted";
    }
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.selectedTabId === tab.id) {
      this.selectedTabId = [...this.turnTabs.keys()].at(-1) || "home";
    }
    this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
  }

  closeTab(tabId) {
    const tab = this.turnTabs.get(tabId);
    if (!tab) throw new Error("Browser tab does not exist");
    this.removeTurnTab(tab, true);
    this.logger.info("browser.tab_closed", { tabId, traceId: tab.traceId, status: tab.status });
    return this.snapshot();
  }

  abortAllTurns() {
    const tabs = [...this.turnTabs.values()];
    for (const tab of tabs) this.removeTurnTab(tab, true);
    if (tabs.length > 0) {
      this.logger.warn("browser.turns_aborted_for_runtime_stop", { count: tabs.length });
    }
    return this.snapshot();
  }

  createAuthView(options = {}) {
    this.closeAuthView(this.authView, true);
    const authView = new WebContentsView({
      webPreferences: {
        ...(options.webPreferences || {}),
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.authView = authView;
    this.window.contentView.addChildView(authView);
    authView.setBounds(this.bounds);
    authView.setVisible(false);
    const contents = authView.webContents;
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("did-finish-load", () => {
      this.setState({ url: contents.getURL(), loading: false });
      void this.probeAuthentication();
    });
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("close", () => this.closeAuthView(authView, true));
    contents.on("destroyed", () => this.closeAuthView(authView, false));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.auth_navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.closeAuthView(authView, false);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        void contents.loadURL(url);
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString());
        }
      }
      return { action: "deny" };
    });
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_opened");
    return contents;
  }

  closeAuthView(authView, closeContents, refreshMain = true) {
    if (!authView || this.authView !== authView) return;
    this.authView = null;
    try { this.window.contentView.removeChildView(authView); } catch {}
    if (closeContents && !authView.webContents.isDestroyed()) {
      authView.webContents.close();
    }
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_closed");
    if (refreshMain && this.manualOperation === "ChatGPT login" && !this.view.webContents.isDestroyed()) {
      void this.view.webContents.loadURL(preferredChatUrlFor(this)).catch((error) => {
        this.logger.error("browser.auth_refresh_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  async applyViewportCss() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (this.viewportCssKey) {
      await contents.removeInsertedCSS(this.viewportCssKey).catch(() => {});
      this.viewportCssKey = null;
    }
    this.viewportCssKey = await contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => null);
  }

  async markOwnedSurface() {
    const surfaceId = JSON.stringify(this.surfaceId);
    await this.view.webContents.executeJavaScript(`(() => {
      Object.defineProperty(globalThis, "__LCA_CODEX_SURFACE_ID__", {
        value: ${surfaceId},
        configurable: true,
        enumerable: false,
        writable: false,
      });
      document.documentElement.dataset.codexWebGptSurface = ${surfaceId};
    })()`, true);
  }

  show() {
    this.visible = true;
    this.syncViewVisibility();
    this.setState({ visible: true });
    if (this.surfaceActive && this.boundsReady) this.activeView().webContents.focus();
  }

  async reveal() {
    this.show();
    if (!this.selectedTurnTab() && this.view.webContents.getURL() === IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(preferredChatUrlFor(this));
      await this.probeAuthentication();
    }
    return this.snapshot();
  }

  async openConnectorSettings() {
    return await this.withManualOperation("connector setup", async () => {
      const contents = this.view.webContents;
      this.show();
      // Connector settings are currently hydrated only from Normal Chat. Keep setup on the same
      // launcher-owned authenticated partition without silently changing the selected turn mode.
      await contents.loadURL(NORMAL_CHAT_URL);
      await this.waitForAuthenticated(60_000);
      await contents.executeJavaScript(
        `location.hash = ${JSON.stringify(CONNECTOR_SETTINGS_HASH)}; location.href`,
        true,
      );
      this.setState({
        status: "ready",
        message: "ChatGPT connector settings opened",
        authenticated: true,
        url: contents.getURL(),
      });
      return this.snapshot();
    });
  }

  hide() {
    this.visible = false;
    this.syncViewVisibility();
    this.setState({ visible: false });
  }

  setSurfaceActive(active) {
    this.surfaceActive = active === true;
    this.syncViewVisibility();
    this.setState({ surfaceActive: this.surfaceActive });
    return this.snapshot();
  }

  async waitForSurfaceReady(timeoutMs = 15_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.surfaceActive && this.boundsReady) return;
      await sleep(pollMs);
    }
    throw new Error(
      "Embedded browser surface did not receive measured bounds before the operation",
    );
  }

  navigate(action) {
    if (this.activeTraceId) {
      throw new Error("Browser navigation is locked while ChatGPT is running a Codex turn");
    }
    if (this.manualOperation) {
      throw new Error(`Browser navigation is locked during ${this.manualOperation}`);
    }
    const contents = this.activeView().webContents;
    navigateBrowser(contents, action);
    return this.snapshot();
  }

  beginTurn(traceId, reveal, helperPid, chatMode) {
    const selectedChatMode = normalizeChatMode(chatMode ?? preferredChatModeFor(this));
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    const existing = [...this.turnTabs.values()].find((tab) => tab.traceId === traceId);
    if (existing) {
      if (existing.status === "running" && existing.helperPid !== helperPid) {
        if (processRunning(existing.helperPid)) {
          throw new Error(`ChatGPT browser turn ${traceId} is owned by another helper process`);
        }
        this.logger.warn("browser.stale_turn_owner_replaced", {
          tabId: existing.id,
          traceId,
          previousHelperPid: existing.helperPid,
          helperPid,
          evidence: "previous helper exited",
        });
      }
      existing.helperPid = helperPid;
      existing.chatMode = normalizeChatMode(existing.chatMode ?? selectedChatMode);
      existing.status = "running";
      existing.loading = true;
      existing.message = "ChatGPT is working";
      if (!existing.view.webContents.isDestroyed()) {
        existing.view.webContents.setBackgroundThrottling(false);
      }
      this.selectedTabId = existing.id;
      if (reveal) this.show();
      else this.syncViewVisibility();
      this.publishState?.(this.snapshot());
      this.writeDescriptor();
      this.logger.info("browser.tab_reused", { tabId: existing.id, traceId, chatMode: existing.chatMode });
      return { surfaceId: existing.surfaceId, tabId: existing.id, chatMode: existing.chatMode };
    }
    const tab = this.createTurnTab(traceId, helperPid, selectedChatMode);
    this.selectedTabId = tab.id;
    if (reveal) this.show();
    else this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.logger.info("browser.tab_created", { tabId: tab.id, traceId, chatMode: tab.chatMode, tabCount: this.turnTabs.size });
    return { surfaceId: tab.surfaceId, tabId: tab.id, chatMode: tab.chatMode };
  }

  async waitForTurnElementPoint(tab, selector, timeoutMs = CHAT_DELETE_ELEMENT_TIMEOUT_MS) {
    const contents = tab.view.webContents;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error("ChatGPT task chat closed during cleanup");
      const point = await contents.executeJavaScript(`(() => {
        const element = ${visibleElementScript(selector)};
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`, true).catch(() => null);
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
      await sleep(50);
    }
    throw new Error(`ChatGPT cleanup control did not appear: ${selector}`);
  }

  async clickTurnSelector(tab, selector) {
    const contents = tab.view.webContents;
    const deadline = Date.now() + CHAT_DELETE_ELEMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error("ChatGPT task chat closed during cleanup");
      const outcome = await contents.executeJavaScript(`(() => {
        const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
        if (candidates.length !== 1) return { count: candidates.length };
        candidates[0].click();
        return { count: 1 };
      })()`, true).catch(() => null);
      if (outcome?.count === 1) return;
      if (outcome && outcome.count > 1) {
        throw new Error(`ChatGPT cleanup selector is ambiguous: ${selector} (visible=${outcome.count})`);
      }
      await sleep(50);
    }
    throw new Error(`ChatGPT cleanup control did not appear: ${selector}`);
  }

  async waitForConversationRemoved(tab, conversationId) {
    const contents = tab.view.webContents;
    const deadline = Date.now() + CHAT_DELETE_VERIFY_TIMEOUT_MS;
    let stableSince = null;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error("ChatGPT task chat closed before delete UI settled");
      const state = await contents.executeJavaScript(`(() => {
        const id = ${JSON.stringify(conversationId)};
        const pathname = '/c/' + id;
        const historyLinkPresent = [...document.querySelectorAll('a[href]')].some(anchor => {
          try { return new URL(anchor.href, location.href).pathname === pathname; } catch { return false; }
        });
        return {
          href: location.href,
          historyLinkPresent,
          optionsPresent: document.getElementById('conversation-options-' + id) !== null,
        };
      })()`, true).catch(() => null);
      if (state) {
        const removed = chatGptConversationIdFromUrl(state.href) !== conversationId
          && state.historyLinkPresent !== true
          && state.optionsPresent !== true;
        if (removed) {
          if (stableSince === null) stableSince = Date.now();
          if (Date.now() - stableSince >= CHAT_DELETE_UI_STABLE_MS) return true;
        } else {
          stableSince = null;
        }
      }
      await sleep(50);
    }
    throw new Error("ChatGPT delete mutation completed but the conversation remained in the UI");
  }

  async deleteOwnedTurnConversation(tab, authoritativeConversationId) {
    if (tab.chatMode !== "normal") {
      this.logger.warn("browser.chat_cleanup_skipped", { tabId: tab.id, traceId: tab.traceId, reason: "temporary chat" });
      return false;
    }
    const hasAuthoritativeOwnership = typeof authoritativeConversationId === "string"
      && /^[A-Za-z0-9_-]{16,128}$/.test(authoritativeConversationId);
    if (!hasAuthoritativeOwnership && (!tab.freshNormalChatObserved || tab.conversationOwnershipInvalid)) {
      this.logger.warn("browser.chat_cleanup_skipped", { tabId: tab.id, traceId: tab.traceId, reason: "navigation ownership unavailable" });
      return false;
    }
    const ownedConversationId = hasAuthoritativeOwnership ? authoritativeConversationId : tab.ownedConversationId;
    if (!ownedConversationId) {
      this.logger.warn("browser.chat_cleanup_skipped", { tabId: tab.id, traceId: tab.traceId, reason: "conversation ownership unavailable" });
      return false;
    }
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) {
      this.logger.warn("browser.chat_cleanup_skipped", { tabId: tab.id, traceId: tab.traceId, reason: "browser surface destroyed" });
      return false;
    }
    if (chatGptConversationIdFromUrl(contents.getURL()) !== ownedConversationId) {
      this.logger.warn("browser.chat_cleanup_skipped", { tabId: tab.id, traceId: tab.traceId, reason: "conversation ownership mismatch" });
      return false;
    }
    contents.setBackgroundThrottling(false);
    try {
      // The active turn surface currently exposes one visible conversation-options control, but
      // unlike sidebar/history rows it does not consistently carry conversation-options-<id>.
      // Ownership is already pinned by the exact /c/<id> URL above, and clickTurnSelector rejects
      // ambiguous visible matches, so use the semantic test id here instead of an unstable id.
      await this.clickTurnSelector(tab, CONVERSATION_OPTIONS_SELECTOR);
      await this.clickTurnSelector(tab, DELETE_CHAT_MENU_ITEM_SELECTOR);
      const mutation = this.waitForChatCleanupMutation(tab, ownedConversationId);
      try {
        await this.clickTurnSelector(tab, CONFIRM_DELETE_CHAT_SELECTOR);
        // ChatGPT updates the UI optimistically before the delete request necessarily finishes.
        // Hide the terminal task tab as soon as the owned conversation is visibly gone, while
        // keeping its WebContents alive in the background until the exact backend mutation is 2xx.
        await this.waitForConversationRemoved(tab, ownedConversationId);
        this.hideTurnTabForCleanup(tab);
        await mutation;
      } catch (error) {
        mutation.catch(() => {});
        throw error;
      }
      this.logger.info("browser.task_chat_deleted", { tabId: tab.id, traceId: tab.traceId });
      return true;
    } finally {
      const waiter = this.chatCleanupWaiters.get(contents.id);
      if (waiter?.conversationId === ownedConversationId) {
        this.chatCleanupWaiters.delete(contents.id);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("ChatGPT delete cleanup ended before its mutation completed"));
      }
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
    }
  }

  async endTurn(traceId, helperPid, status, hideAfterTurn, deleteCompletedTaskChat, message, authoritativeConversationId) {
    const tab = [...this.turnTabs.values()].find((candidate) => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) {
        this.closedTurnOwners.delete(traceId);
        return;
      }
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(
        `Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`,
      );
    }
    tab.status = status === "completed" ? "ready" : status === "aborted" ? "aborted" : "error";
    tab.message = status === "completed" ? "Task completed" : message || `ChatGPT turn ${status}`;
    tab.loading = false;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
    if (status === "completed") {
      this.logger.info("browser.tab_completed", { tabId: tab.id, traceId });
    }
    if (deleteCompletedTaskChat === true) {
      try {
        await this.deleteOwnedTurnConversation(tab, authoritativeConversationId);
      } catch (error) {
        this.logger.warn("browser.task_chat_cleanup_failed", {
          tabId: tab.id,
          traceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A browser tab represents an active Codex turn, not durable task history. Retaining terminal
    // tabs leaked one slot per response/compaction until the five-tab safety limit made later
    // turns fail. The result already lives in Codex; release the browser document on every
    // terminal path while leaving other concurrently running tabs untouched.
    this.removeTurnTab(tab, false);
    if (hideAfterTurn && !this.activeTraceId) this.hide();
    this.logger.info("browser.tab_released", { tabId: tab.id, traceId, status: tab.status });
  }

  async returnToIdle() {
    this.hide();
    this.view.webContents.setBackgroundThrottling(true);
    if (this.view.webContents.getURL() !== IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(IDLE_BROWSER_URL);
    }
    this.setState({
      status: this.state.authenticated ? "ready" : "signed-out",
      message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
    });
  }

  openLogin() {
    if (this.state.authenticated) {
      this.activateHomeSurface();
      this.show();
      return Promise.resolve(this.snapshot());
    }
    if (this.loginOperation) {
      this.activateHomeSurface();
      this.show();
      return this.loginOperation;
    }
    const operation = this.withManualOperation("ChatGPT login", async () => {
      this.show();
      this.logger.info("browser.login_opened");
      const current = this.view.webContents.getURL();
      if (!current.startsWith(CHATGPT_ORIGIN)) {
        await this.view.webContents.loadURL(preferredChatUrlFor(this));
      }
      await this.probeAuthentication();
      return await this.waitForAuthenticated();
    });
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
  }

  async logout() {
    return await this.withManualOperation("ChatGPT logout", async () => {
      if (this.authView) this.closeAuthView(this.authView, true, false);
      const contents = this.view.webContents;
      await contents.session.clearStorageData();
      this.setState({
        authenticated: false,
        loading: true,
        message: "Signing out of ChatGPT",
        status: "loading",
      });
      await contents.loadURL(preferredChatUrlFor(this));
      const browser = await this.probeAuthentication();
      if (browser.authenticated) {
        throw new Error("ChatGPT session remained authenticated after local session data was cleared");
      }
      this.activateHomeSurface();
      this.show();
      this.logger.info("browser.logout_completed");
      return this.snapshot();
    });
  }

  async refreshAuthentication() {
    return await this.withManualOperation("session refresh", async () => {
      this.setState({ status: "loading", message: "Checking saved ChatGPT session" });
      const chatMode = preferredChatModeFor(this);
      if (!isChatGptPageMode(this.view.webContents.getURL(), chatMode)) {
        await this.view.webContents.loadURL(chatUrlForMode(chatMode));
      }
      return await this.probeAuthentication();
    });
  }

  async probeAuthentication() {
    if (!this.view || this.view.webContents.isDestroyed()) return this.snapshot();
    let url = this.view.webContents.getURL();
    if (url === IDLE_BROWSER_URL) {
      this.setState({
        status: this.state.authenticated ? "ready" : "signed-out",
        message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
        url,
      });
      return this.snapshot();
    }
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      this.setState({ status: "signed-out", message: "Sign in to ChatGPT", authenticated: false, url });
      return this.snapshot();
    }
    const probe = (contents) => contents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      return { composer: Boolean(composer), readyState: document.readyState };
    })()`, true).catch(() => ({ composer: false, readyState: "unknown" }));
    let result = await probe(this.view.webContents);
    if (!result.composer && this.authView && !this.authView.webContents.isDestroyed()) {
      const authResult = await probe(this.authView.webContents);
      if (authResult.composer) {
        const completedAuthView = this.authView;
        this.closeAuthView(completedAuthView, true, false);
        await this.view.webContents.loadURL(preferredChatUrlFor(this));
        url = this.view.webContents.getURL();
        result = await probe(this.view.webContents);
      }
    }
    if (result.composer) {
      if (this.authView && !this.authView.webContents.isDestroyed()) {
        this.closeAuthView(this.authView, true, false);
      }
      const wasAuthenticated = this.state.authenticated;
      const availability = this.activeTraceId
        ? { status: "running", message: "ChatGPT is working" }
        : this.manualOperation
          ? {}
          : { status: "ready", message: "ChatGPT is ready" };
      this.setState({ ...availability, authenticated: true, url });
      if (!wasAuthenticated) this.logger.info("browser.authenticated", { url });
    } else {
      const loaded = result.readyState === "complete";
      this.setState({
        status: loaded ? "signed-out" : "loading",
        message: loaded ? "Sign in to ChatGPT" : "Waiting for ChatGPT",
        authenticated: false,
        url,
      });
    }
    return this.snapshot();
  }

  async waitForAuthenticated(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.probeAuthentication();
      if (state.authenticated) return state;
      await sleep(750);
    }
    throw new Error("ChatGPT login was not completed before the timeout");
  }

  async waitForVisibleComposer(timeoutMs = 15_000, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.view.webContents.executeJavaScript(`(() => {
        const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
        return {
          composer: Boolean(composer),
          visibilityState: document.visibilityState,
          readyState: document.readyState,
        };
      })()`, true).catch(() => ({
        composer: false,
        visibilityState: "unknown",
        readyState: "unknown",
      }));
      if (state.composer && state.visibilityState === "visible") return state;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT connector verification could not activate a visible composer`
      + ` (document=${state?.readyState || "unknown"}; visibility=${state?.visibilityState || "unknown"};`
      + ` composer=${state?.composer ? "ready" : "missing"})`,
    );
  }

  async smokeTest() {
    return await this.withManualOperation("browser smoke test", () => this.runSmokeTest());
  }

  async runSmokeTest() {
    this.show();
    await this.waitForSurfaceReady();
    this.setState({ status: "testing", message: "Running browser smoke test" });
    this.logger.info("smoke.started");
    const chatMode = preferredChatModeFor(this);
    if (!isChatGptPageMode(this.view.webContents.getURL(), chatMode)) {
      await this.view.webContents.loadURL(chatUrlForMode(chatMode));
    }
    await this.waitForAuthenticated(60_000);

    const effortResult = await this.selectHighEffort();
    this.logger.info("smoke.effort_selected", effortResult);
    const beforeAssistantCount = await this.assistantTurnCount();
    const beforeUserCount = await this.userTurnCount();
    if (!await this.focusComposer()) {
      throw new Error("ChatGPT composer was not available for the smoke test");
    }
    await this.clearFocusedComposer();
    this.view.webContents.focus();
    this.view.webContents.insertText(SMOKE_TEXT);
    await this.waitForComposerText(SMOKE_TEXT);
    await this.waitForSmokeSendButton();
    if (!await this.focusSmokeSendButton()) {
      throw new Error("ChatGPT send button could not receive focus for the smoke test");
    }
    await this.pressTrustedBrowserKey("Enter");
    const submitted = await this.waitForSmokeSubmissionAccepted(beforeUserCount);
    this.logger.info("smoke.submitted", submitted);

    const deadline = Date.now() + SMOKE_RESPONSE_TIMEOUT_MS;
    let completionCandidate = null;
    while (Date.now() < deadline) {
      const outcome = await this.view.webContents.executeJavaScript(`(() => {
        const turns = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN_SELECTOR)}));
        const latest = turns.at(-1);
        const rendered = latest?.querySelector('.markdown');
        const text = rendered ? (rendered.innerText || rendered.textContent || '').trim() : '';
        const completionActionVisible = latest
          ? Array.from(latest.querySelectorAll(${JSON.stringify(COMPLETION_ACTION_SELECTOR)})).some((button) => {
              const style = getComputedStyle(button);
              const rect = button.getBoundingClientRect();
              return style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0;
            })
          : false;
        const stopVisible = Array.from(document.querySelectorAll('[data-testid="stop-button"]')).some((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        });
        return { count: turns.length, text, stopVisible, completionActionVisible };
      })()`, true);
      const complete = outcome.count > beforeAssistantCount
        && outcome.text === SMOKE_EXPECTED
        && !outcome.stopVisible
        && outcome.completionActionVisible;
      if (!complete) {
        completionCandidate = null;
      } else if (completionCandidate?.text !== outcome.text) {
        completionCandidate = { text: outcome.text, since: Date.now() };
      } else if (Date.now() - completionCandidate.since >= SMOKE_COMPLETION_SETTLE_MS) {
        this.logger.info("smoke.completed", { responseChars: outcome.text.length });
        this.setState({ status: "ready", message: "Smoke test passed", authenticated: true });
        return { ok: true, effort: effortResult.effort, response: SMOKE_EXPECTED };
      }
      await sleep(500);
    }
    this.logger.error("smoke.timed_out");
    this.setState({ status: "error", message: "Smoke test timed out" });
    throw new Error("ChatGPT smoke test timed out before the expected answer appeared");
  }

  async pressTrustedBrowserKey(key) {
    try {
      await this.dispatchTrustedKey({
        debuggerClient: this.view.webContents.debugger,
        key,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT trusted browser key failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async clickTrustedBrowserPoint(point) {
    try {
      await this.dispatchTrustedClick({
        debuggerClient: this.view.webContents.debugger,
        point,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT trusted browser click failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async evaluateBrowserPage(expression) {
    const contents = this.view.webContents;
    try {
      return await this.evaluatePage({
        debuggerClient: contents.debugger,
        expression,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT page inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  pressBrowserKey(keyCode) {
    const contents = this.view.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode });
    contents.sendInputEvent({ type: "keyUp", keyCode });
  }

  pressBrowserShortcut(keyCode, modifiers) {
    const contents = this.view.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }

  async focusComposer() {
    return await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return false;
      composer.focus({ preventScroll: true });
      return document.activeElement === composer || composer.contains(document.activeElement);
    })()`, true);
  }

  async readComposerText() {
    return await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return null;
      const text = String('value' in composer ? composer.value : composer.innerText || composer.textContent || '')
        .replace(/\\r\\n/g, '\\n');
      return /^\\s*$/.test(text) ? '' : text;
    })()`, true);
  }

  async waitForComposerText(expected, timeoutMs = 10_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    let actual = null;
    do {
      actual = await this.readComposerText();
      if (actual === expected) return;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT composer did not preserve the expected text`
      + ` (expectedChars=${expected.length}; actualChars=${typeof actual === "string" ? actual.length : "missing"})`,
    );
  }

  async clearFocusedComposer() {
    this.view.webContents.focus();
    this.pressBrowserShortcut("A", [process.platform === "darwin" ? "meta" : "control"]);
    this.pressBrowserKey("Backspace");
    await this.waitForComposerText("");
  }

  async readSmokeSendButton() {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-send-button-read */
      const button = ${visibleElementScript('[data-testid="send-button"]')};
      if (!button) return { ready: false, reason: 'missing' };
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
        return { ready: false, reason: 'disabled' };
      }
      return { ready: true };
    })()`);
  }

  async waitForSmokeSendButton(timeoutMs = 10_000, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.readSmokeSendButton();
      if (state.ready) return state;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT send button did not become available for the smoke test`
      + ` (state=${state?.reason || "unknown"})`,
    );
  }

  async focusSmokeSendButton() {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-send-button-focus */
      const button = ${visibleElementScript('[data-testid="send-button"]')};
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      button.focus({ preventScroll: true });
      return document.activeElement === button;
    })()`);
  }

  async readSmokeSubmissionState(beforeUserCount) {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-submission-read */
      const beforeUserCount = ${beforeUserCount};
      const userTurnCount = document.querySelectorAll(${JSON.stringify(USER_TURN_SELECTOR)}).length;
      const stopVisible = Array.from(document.querySelectorAll('[data-testid="stop-button"]')).some((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return {
        accepted: userTurnCount > beforeUserCount,
        userTurnCount,
        stopVisible,
      };
    })()`);
  }

  async waitForSmokeSubmissionAccepted(
    beforeUserCount,
    timeoutMs = SMOKE_SUBMISSION_TIMEOUT_MS,
    pollMs = 100,
  ) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.readSmokeSubmissionState(beforeUserCount);
      if (state.accepted) return state;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT did not accept the smoke-test message after activating the send button`
      + ` (userTurnsBefore=${beforeUserCount}; userTurnsNow=${state?.userTurnCount ?? "unknown"};`
      + ` stopVisible=${state?.stopVisible === true})`,
    );
  }

  async readEffortControl() {
    return this.evaluateBrowserPage(`(() => {
      /* effort-control-read */
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      const form = composer?.closest('form');
      const controls = Array.from(form?.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]'
      ) || []).filter(visible);
      const control = controls.at(-1);
      if (!control) {
        return {
          found: false,
          composer: Boolean(composer),
          form: Boolean(form),
          readyState: document.readyState,
          url: location.href,
        };
      }
      const rect = control.getBoundingClientRect();
      return {
        found: true,
        label: normalize(control.innerText || control.textContent),
        expanded: control.getAttribute('aria-expanded'),
        point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        composer: Boolean(composer),
        form: true,
        readyState: document.readyState,
        url: location.href,
      };
    })()`);
  }

  async waitForEffortControl(timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let control;
    do {
      control = await this.readEffortControl();
      if (control.found) return control;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort control did not become ready`
      + ` (url=${control?.url || this.view.webContents.getURL()};`
      + ` document=${control?.readyState || "unknown"}; composer=${control?.composer ? "ready" : "missing"};`
      + ` composerForm=${control?.form ? "ready" : "missing"})`,
    );
  }

  async readEffortMenu(targetIndex) {
    return await this.evaluateBrowserPage(`(() => {
        /* effort-menu-read */
        const targetIndex = ${targetIndex};
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
        const control = Array.from(composer?.closest('form')?.querySelectorAll(
          'button[aria-haspopup="menu"][data-tone="neutral"]'
        ) || []).filter(visible).at(-1);
        const controlledId = control?.getAttribute('aria-controls');
        const controlled = controlledId ? document.getElementById(controlledId) : null;
        const roots = [
          ...(controlled ? [controlled] : []),
          ...Array.from(document.querySelectorAll(${JSON.stringify(EFFORT_MENU_SELECTOR)})),
        ];
        const candidate = [...new Set(roots)].filter(visible)
          .map((menu) => ({
            menu,
            slider: menu.querySelector('[role="slider"][aria-valuenow][aria-valuemax]'),
          }))
          .find(({ slider }) => slider && visible(slider));
        if (!candidate?.slider) {
          return { open: false, count: 0, mode: null, min: null, max: null, value: null, target: null };
        }

        if (candidate.slider) {
          const slider = candidate.slider;
          const min = Number(slider.getAttribute('aria-valuemin') || 0);
          const max = Number(slider.getAttribute('aria-valuemax'));
          const value = Number(slider.getAttribute('aria-valuenow'));
          const targetValue = targetIndex;
          if (![min, max, value, targetValue].every(Number.isInteger) || max < min || value < min || value > max) {
            return { open: true, count: 0, mode: 'slider', min, max, value, target: null };
          }
          const rect = slider.getBoundingClientRect();
          return {
            open: true,
            count: max - min + 1,
            mode: 'slider',
            min,
            max,
            value,
            target: targetValue >= min && targetValue <= max ? {
              checked: value === targetValue ? 'true' : 'false',
              point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
              value,
              targetValue,
            } : null,
          };
        }

      })()`);
  }

  async openEffortMenu(targetIndex, timeoutMs, pollMs, knownControl) {
    let control = knownControl?.found ? knownControl : await this.readEffortControl();
    if (!control.found) {
      throw new Error("ChatGPT effort control disappeared before its menu could open");
    }
    if (control.expanded !== "true") {
      // Re-resolve immediately before activation so the click is derived from the current
      // composer-owned semantic control, never from a stale or hard-coded viewport coordinate.
      control = await this.readEffortControl();
      if (!control.found || !control.point) {
        throw new Error("ChatGPT effort control disappeared before activation");
      }
      await this.clickTrustedBrowserPoint(control.point);
    }
    return await this.waitForEffortMenu(targetIndex, timeoutMs, pollMs);
  }

  async chooseEffortMenuItem(targetIndex, knownMenu) {
    const menu = knownMenu?.target ? knownMenu : await this.readEffortMenu(targetIndex);
    if (!menu.target?.point) {
      throw new Error(`ChatGPT effort item index ${targetIndex} disappeared before activation`);
    }
    if (menu.mode !== "slider") throw new Error("ChatGPT thinking picker is not an indexed slider");
    const focused = await this.evaluateBrowserPage(`(() => {
      const slider = document.querySelector(${JSON.stringify(EFFORT_MENU_SELECTOR)})
        ?.querySelector('[role="slider"][aria-valuenow][aria-valuemax]');
      if (!slider) return false;
      slider.focus({ preventScroll: true });
      return document.activeElement === slider;
    })()`);
    if (!focused) throw new Error("ChatGPT effort slider could not receive focus");
    const delta = Number(menu.target.targetValue) - Number(menu.target.value);
    const key = delta >= 0 ? "ArrowRight" : "ArrowLeft";
    for (let index = 0; index < Math.abs(delta); index += 1) {
      await this.pressTrustedBrowserKey(key);
    }
  }

  async waitForEffortMenu(targetIndex, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let menu;
    do {
      menu = await this.readEffortMenu(targetIndex);
      if (menu.target) return menu;
      if (menu.open && menu.count > 0 && Number.isInteger(menu.min) && Number.isInteger(menu.max)) {
        throw new Error(`ChatGPT thinking slider does not expose index ${targetIndex} (range=${menu.min}-${menu.max})`);
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort menu did not expose item index ${targetIndex}`
      + ` (open=${menu?.open === true}; itemCount=${menu?.count || 0})`,
    );
  }

  async selectHighEffort({
    readyTimeoutMs = 70_000,
    optionTimeoutMs = 70_000,
    confirmTimeoutMs = 40_000,
    pollMs = 200,
  } = {}) {
    const targetIndex = 2;
    const control = await this.waitForEffortControl(readyTimeoutMs, pollMs);
    let menu = await this.readEffortMenu(targetIndex);
    if (!menu.target) {
      menu = menu.open || control.expanded === "true"
        ? await this.waitForEffortMenu(targetIndex, optionTimeoutMs, pollMs)
        : await this.openEffortMenu(targetIndex, optionTimeoutMs, pollMs, control);
    }
    if (menu.target.checked !== "true" && menu.target.checked !== "false") {
      throw new Error(`ChatGPT effort item index ${targetIndex} has no semantic checked state`);
    }
    if (menu.target.checked === "true") {
      this.pressBrowserKey("Escape");
      return { effort: "High", changed: false };
    }
    await this.chooseEffortMenuItem(targetIndex, menu);

    const deadline = Date.now() + confirmTimeoutMs;
    let confirmed = menu;
    do {
      confirmed = await this.readEffortMenu(targetIndex);
      if (!confirmed.target) {
        const current = await this.readEffortControl();
        if (current.found) {
          confirmed = await this.openEffortMenu(
            targetIndex,
            Math.max(1, Math.min(5_000, deadline - Date.now())),
            pollMs,
            current,
          );
        }
      }
      if (confirmed.target?.checked === "true") {
        this.pressBrowserKey("Escape");
        return { effort: "High", changed: true };
      }
      if (confirmed.target && confirmed.target.checked !== "false") {
        throw new Error(`ChatGPT effort item index ${targetIndex} lost its semantic checked state`);
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT did not confirm effort item index ${targetIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed?.target?.checked ?? null)})`,
    );
  }

  async assistantTurnCount() {
    return this.view.webContents.executeJavaScript(
      `document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN_SELECTOR)}).length`,
      true,
    );
  }

  async userTurnCount() {
    return this.view.webContents.executeJavaScript(
      `document.querySelectorAll(${JSON.stringify(USER_TURN_SELECTOR)}).length`,
      true,
    );
  }

  async verifyConnector(appName) {
    return await this.withManualOperation("connector verification", () => this.runConnectorVerification(appName));
  }

  async runConnectorVerification(appName) {
    if (preferredChatModeFor(this) === "temporary") {
      throw new Error("ChatGPT connectors are unavailable in Temporary Chat. Switch Chat mode to Normal and retry verification.");
    }
    if (typeof appName !== "string" || !appName.trim() || appName.length > 80) {
      throw new Error("Connector name is invalid");
    }
    const connectorName = appName.trim();
    const contents = this.view.webContents;
    this.setState({ status: "testing", message: "Checking ChatGPT connector" });
    // A fresh launcher can reach MCP verification before the renderer ever mounts Browser, leaving
    // the home WebContentsView both throttled and document-hidden. Keep it live and Chromium-visible
    // in a clipped background viewport for the duration of connector verification.
    contents.setBackgroundThrottling(false);
    const restoreVerificationSurface = this.beginConnectorVerificationSurface();
    try {
      // Connector discovery is currently hydrated only in Normal Chat. Reload so a connector
      // created moments ago cannot be hidden by stale page state.
      await this.view.webContents.loadURL(NORMAL_CHAT_URL);
      await this.waitForAuthenticated(60_000);
      await this.waitForVisibleComposer();
      const result = await this.verifyConnectorWithBrowserHelper({
        helper: this.helper,
        descriptorPath: this.descriptorPath,
        appName: connectorName,
        logger: this.logger,
      });
      this.logger.info("connector.verified", { appName: connectorName });
      this.setState({ status: "ready", message: "ChatGPT connector is available", authenticated: true });
      return result;
    } finally {
      restoreVerificationSurface();
      contents.setBackgroundThrottling(true);
    }
  }

  async inspectSession(detectEffortLevels = false) {
    return await this.withManualOperation("session inspection", () => this.runSessionInspection(detectEffortLevels));
  }

  async runSessionInspection(detectEffortLevels = false) {
    const initialUrl = this.view.webContents.getURL();
    const startedIdle = initialUrl === IDLE_BROWSER_URL;
    const chatMode = preferredChatModeFor(this);
    if (!isChatGptPageMode(initialUrl, chatMode)) await this.view.webContents.loadURL(chatUrlForMode(chatMode));
    const state = await this.probeAuthentication();
    if (!state.authenticated) {
      throw new Error("The embedded ChatGPT session is not authenticated");
    }
    const url = this.view.webContents.getURL();
    if (!isChatGptPageMode(url, chatMode)) {
      throw new Error(`The embedded browser is not on requested ${chatMode} Chat (${url})`);
    }
    let effortLevelCount;
    if (detectEffortLevels) {
      try {
        const control = await this.waitForEffortControl(PRO_CAPABILITY_CONTROL_TIMEOUT_MS, 100);
        let menu = await this.readEffortMenu(0);
        if (!menu.target) {
          if (!menu.open && control.expanded === "true") {
            // aria-expanded can remain stale after ChatGPT re-renders the popover. Reset
            // the semantic control once before reopening instead of waiting on a menu
            // that no longer exists in the DOM.
            this.pressBrowserKey("Escape");
            await sleep(100);
            const resetControl = await this.waitForEffortControl(PRO_CAPABILITY_RESET_TIMEOUT_MS, 100);
            menu = await this.openEffortMenu(0, PRO_CAPABILITY_MENU_TIMEOUT_MS, 100, resetControl);
          } else {
            menu = menu.open
              ? await this.waitForEffortMenu(0, PRO_CAPABILITY_MENU_TIMEOUT_MS, 100)
              : await this.openEffortMenu(0, PRO_CAPABILITY_MENU_TIMEOUT_MS, 100, control);
          }
        }
        effortLevelCount = menu.count;
        if (!Number.isInteger(effortLevelCount) || effortLevelCount < 1) {
          throw new Error("ChatGPT thinking slider exposed no usable positions");
        }
      } catch (error) {
        // Capability metadata never depends on translated labels. If the indexed slider fails to
        // hydrate, retain the conservative three-level baseline and surface a diagnostic.
        effortLevelCount = 3;
        this.logger?.warn?.("browser.effort_range_probe_unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.pressBrowserKey("Escape");
      }
    }
    if (startedIdle) await this.returnToIdle();
    return { authenticated: true, chatMode, url, ...(detectEffortLevels ? { effortLevelCount } : {}) };
  }

  async withManualOperation(name, action) {
    if (this.activeTraceId) {
      throw new Error(`ChatGPT browser is running Codex turn ${this.activeTraceId}`);
    }
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is already busy with ${this.manualOperation}`);
    }
    this.activateHomeSurface();
    this.manualOperation = name;
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(false);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: "error", message });
      throw error;
    } finally {
      if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
      this.manualOperation = null;
    }
  }

  writeDescriptor() {
    const descriptor = {
      version: 1,
      kind: "lca-codex-launcher",
      pid: process.pid,
      endpoint: `http://127.0.0.1:${this.cdpPort}`,
      control: this.control,
      helper: this.helper,
      partition: "persist:lca-codex-chatgpt",
      idleUrl: IDLE_BROWSER_URL,
      surfaceId: this.surfaceId,
      createdAt: new Date().toISOString(),
    };
    writePrivateFileAtomic(this.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  }

  destroy() {
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    this.closeAuthView(this.authView, true);
    for (const tab of this.turnTabs.values()) {
      try { this.window.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.turnTabs.clear();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}

module.exports = {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
  googleAccountChooserUrl,
  IDLE_BROWSER_URL,
  initializationNavigationWasSuperseded,
  initialBrowserBounds,
  isChatGptCloudflareChallengeResponse,
  isChatGptConversationMutationResponse,
  isChatGptPageMode,
  chatGptConversationIdFromUrl,
  isTemporaryChatUrl,
  chatUrlForMode,
  NORMAL_CHAT_URL,
  TEMPORARY_CHAT_URL,
};
