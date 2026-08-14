import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { CHATGPT_PROMPT_INSERT_CHUNK_CHARS, CHATGPT_RESPONSE_IDLE_POLL_MS, CHATGPT_RESPONSE_POLL_MS, ChatGptAdaptivePollScheduler, ChatGptBrowserWorker, ChatGptNetworkTurnTracker, ChatGptVisibleTraceTracker, MAX_CHATGPT_BROWSER_TABS, assertLcaCodexInputWithinContextWindow, browserDiagnosticCheckpoint, isChatGptTraceControl, redactChatGptUiDiagnostic, resolveBrowserConfig, resolveChatGptToolConfirmation, throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert } from "../src/adapters/lca-codex/browser-worker";
import { defaultChromeExecutable } from "../src/config";

test("Codex context uses the owned CDP composer transport, never the operating-system clipboard", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('composer.fill("")');
  expect(workerSource).toContain("this.insertPromptText(page, prompt)");
  expect(workerSource).toContain("this.insertPromptText(page, ` ${prompt}`)");
  expect(workerSource).not.toMatch(/\bclipboard\b|pbcopy|pbpaste/i);
});

test("completed prompts activate the scoped semantic send control", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('.getByTestId("send-button")');
  expect(workerSource).toContain('await sendButton.press("Enter")');
  expect(workerSource).not.toContain('getByTestId("send-button").dispatchEvent("click")');
});

test("browser turns run concurrently up to the five-tab limit", async () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);
  const releases = new Map<string, () => void>();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const browserTurn = (traceId: string) => ({
    traceId,
    modelId: "gpt-5.6-sol",
    capabilities: { localToolsEnabled: false, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], transport: "inline" as const, release() {} }),
    onTextDelta() {},
  });

  const active = Array.from({ length: 5 }, (_unused, index) => worker.run(browserTurn(`trace_${index + 1}`)));
  await Promise.resolve();
  expect(releases.size).toBe(5);
  await expect(worker.run(browserTurn("trace_6"))).rejects.toThrow("at most 5 simultaneous browser turns");

  releases.get("trace_1")?.();
  await active[0];
  const sixth = worker.run(browserTurn("trace_6"));
  await Promise.resolve();
  expect(releases.has("trace_6")).toBeTrue();
  for (const traceId of ["trace_2", "trace_3", "trace_4", "trace_5", "trace_6"]) {
    releases.get(traceId)?.();
  }
  await Promise.all([...active.slice(1), sixth]);
});

test("browser turns have no absolute deadline unless one is explicitly configured", () => {
  const provider = { adapter: "lca-codex" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).turnTimeoutMs).toBeUndefined();
  expect(resolveBrowserConfig({
    ...provider,
    lcaCodex: { turnTimeoutMs: 123_000 },
  }).turnTimeoutMs).toBe(123_000);
  expect(() => resolveBrowserConfig({
    ...provider,
    lcaCodex: { turnTimeoutMs: 0 },
  })).toThrow("turnTimeoutMs must be a positive finite number");
});

test("managed Chrome defaults follow the host platform", () => {
  expect(defaultChromeExecutable("darwin")).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  expect(defaultChromeExecutable("linux")).toBe("/usr/bin/google-chrome");
  expect(defaultChromeExecutable("win32", "D:\\Program Files")).toBe(
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  const provider = { adapter: "lca-codex" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).chromeExecutablePath).toBe(defaultChromeExecutable());
});

test("browser stage timeout aborts late page acquisition", async () => {
  let acquisitionAborted = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_timeout",
    "browser_page",
    10,
    async (signal) => await new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => {
        acquisitionAborted = true;
        resolve("late page");
      }, { once: true });
    }),
  );

  await expect(result).rejects.toThrow("ChatGPT browser stage timed out: browser_page");
  expect(acquisitionAborted).toBeTrue();
});

test("closing the launcher page is an immediate terminal turn error", async () => {
  const responseDomSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    responseDomSnapshot(responseTurn: unknown): Promise<unknown>;
  }).responseDomSnapshot;
  const responseTurn = {
    evaluate: async () => { throw new Error("Target page has been closed"); },
    page: () => ({ isClosed: () => true }),
  };

  await expect(responseDomSnapshot.call({}, responseTurn)).rejects.toThrow(
    "ChatGPT browser tab was closed; the Codex turn was terminated",
  );
});

test("a transient launcher CDP disconnect reattaches the same browser surface instead of replaying the turn", () => {
  const workerSource = readFileSync(
    new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  expect(workerSource).toContain("const reattachLauncherSurface = async (): Promise<boolean> => {");
  expect(workerSource).toContain("!turnConnection || turnConnection.isConnected()");
  expect(workerSource).toContain("launcherSurfaceId,\n            turn.abortSignal,");
  expect(workerSource).toContain("responseTurn = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR).filter({ visible: true }).last()");
  expect(workerSource.match(/if \(await reattachLauncherSurface\(\)\) continue;/g)?.length).toBe(2);
  expect(workerSource).toContain("rather than replaying the\n          // ChatGPT turn");
});

test("browser network lifecycle correlates the created conversation, turn stream, and terminal event", () => {
  const transitions: string[] = [];
  const tracker = new ChatGptNetworkTurnTracker(transition => transitions.push(transition));
  const frame = (topicId: string, type: string, payload: Record<string, unknown>) => JSON.stringify([{
    type: "message",
    topic_id: topicId,
    payload: { type, payload, metadata: {} },
  }]);

  tracker.observeWebSocketPayload(frame("conversations", "conversation-created", {
    conversation_id: "before-arm",
  }));
  expect(tracker.snapshot()).toEqual({
    armed: false,
    conversationKnown: false,
    turnKnown: false,
    completed: false,
  });

  tracker.arm();
  tracker.observeWebSocketPayload(frame("conversation-turn-turn-1", "conversation-turn-stream", {
    type: "heartbeat",
    turn_id: "turn-1",
    conversation_id: "conversation-1",
  }));
  tracker.observeWebSocketPayload(frame("conversations", "conversation-created", {
    conversation_id: "conversation-1",
  }));
  tracker.observeWebSocketPayload(frame("conversations", "conversation-turn-complete", {
    conversation_id: "unrelated-conversation",
  }));
  expect(tracker.snapshot()).toEqual({
    armed: true,
    conversationKnown: true,
    turnKnown: true,
    completed: false,
  });

  const completionBeforeStream = new ChatGptNetworkTurnTracker();
  completionBeforeStream.arm();
  completionBeforeStream.observeWebSocketPayload(frame("conversations", "conversation-created", {
    conversation_id: "conversation-without-stream",
  }));
  completionBeforeStream.observeWebSocketPayload(frame("conversations", "conversation-turn-complete", {
    conversation_id: "conversation-without-stream",
  }));
  expect(completionBeforeStream.snapshot()).toEqual({
    armed: true,
    conversationKnown: false,
    turnKnown: false,
    completed: false,
  });

  tracker.observeWebSocketPayload(frame("conversations", "conversation-turn-complete", {
    conversation_id: "conversation-1",
  }));
  expect(tracker.snapshot().completed).toBeTrue();
  expect(transitions).toEqual(["created", "streaming", "completed"]);
});

test("browser network lifecycle lets the post-send conversation replace a stale heartbeat", () => {
  const tracker = new ChatGptNetworkTurnTracker();
  const frame = (topicId: string, type: string, payload: Record<string, unknown>) => JSON.stringify([{
    type: "message",
    topic_id: topicId,
    payload: { type, payload },
  }]);

  tracker.arm();
  tracker.observeWebSocketPayload(frame("conversation-turn-old-turn", "conversation-turn-stream", {
    type: "heartbeat",
    turn_id: "old-turn",
    conversation_id: "old-conversation",
  }));
  tracker.observeWebSocketPayload(frame("conversations", "conversation-created", {
    conversation_id: "fresh-conversation",
  }));
  tracker.observeWebSocketPayload(frame("conversations", "conversation-turn-complete", {
    conversation_id: "old-conversation",
  }));
  expect(tracker.snapshot()).toEqual({
    armed: true,
    conversationKnown: true,
    turnKnown: true,
    completed: false,
  });

  tracker.observeWebSocketPayload(frame("conversation-turn-fresh-turn", "conversation-turn-stream", {
    type: "heartbeat",
    turn_id: "fresh-turn",
    conversation_id: "fresh-conversation",
  }));
  tracker.observeWebSocketPayload(frame("conversations", "conversation-turn-complete", {
    conversation_id: "fresh-conversation",
  }));
  expect(tracker.snapshot()).toEqual({
    armed: true,
    conversationKnown: true,
    turnKnown: true,
    completed: true,
  });
});

test("browser network lifecycle is mandatory before Send and after launcher reattachment", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const attach = workerSource.indexOf("await networkObserver.attach(page);");
  const arm = workerSource.indexOf("networkObserver.arm();", attach);
  const send = workerSource.indexOf('await sendButton.press("Enter");', arm);
  expect(attach).toBeGreaterThan(-1);
  expect(arm).toBeGreaterThan(attach);
  expect(send).toBeGreaterThan(arm);
  expect(workerSource.match(/await networkObserver\.attach\(page\);/g)?.length).toBe(2);
  expect(workerSource).toContain('logLcaCodexActivity("lca_codex.network_observer_reattached"');
  expect(workerSource).toContain('logLcaCodexActivity("lca_codex.network_observer_unavailable"');
  expect(workerSource).toContain('"lca_codex.network_turn_created"');
  expect(workerSource).toContain('"lca_codex.network_turn_streaming"');
  expect(workerSource).toContain('"lca_codex.network_turn_completed"');
  expect(workerSource).toContain('completionSource: "network"');
  expect(workerSource).toContain("let networkCompletionObservedOnPriorPoll = false;");
  expect(workerSource).toContain("const networkCompletionReady = networkCompletionObserved");
  expect(workerSource).toContain("networkCompletionObservedOnPriorPoll = networkCompletionObserved;");
  expect(workerSource).toContain("if (networkCompletionReady || recoveredCompletionReady) {");
  expect(workerSource).not.toContain("turnCompletionReady");
  expect(workerSource).not.toContain("completionTracker");
  expect(workerSource).toContain("ChatGPT network lifecycle observer is unavailable before Send");
  expect(workerSource).toContain("ChatGPT network lifecycle observer could not reattach to the active turn");
  expect(workerSource).not.toContain('payloadData.includes("[DONE]")');
});

test("connector verification and real tool turns share one Playwright selector", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource.match(/this\.selectConnector\(page(?:, captureDiagnostic)?\)/g)?.length).toBe(2);
  expect(workerSource).toContain('await page.keyboard.type("@");');
  expect(workerSource).toContain("for (const character of this.config.appName)");
  expect(workerSource).toContain("await page.keyboard.type(character);");
  expect(workerSource).not.toContain('composer.fill(`@${this.config.appName}`)');
  expect(workerSource).toContain('const exactResult = menuRows');
  expect(workerSource).toContain('const menuRows = page.locator(CHATGPT_CONNECTOR_MENU_ROW_SELECTOR)');
  expect(workerSource).toContain('[data-testid="composer-intelligence-picker-content"] button');
  expect(workerSource).toContain('[data-radix-popper-content-wrapper] button');
  expect(workerSource).toContain('exactResult.waitFor({ state: "visible", timeout: fastTimeout })');
  expect(workerSource).toContain('appResult.dispatchEvent("click")');
  expect(workerSource).not.toContain('composer.pressSequentially("@c"');
  expect(workerSource).not.toContain('composer.press("Enter")');
  expect(workerSource).toContain("this.selectedConnectorControl(selectedComposer)");
  expect(workerSource).toContain("'[data-id^=\"plugin:\"][data-keyword]'");
  expect(workerSource).toContain("const selectedComposer = await this.activeComposer(page)");
});

test("active composer resolution waits for exactly one visible editor", async () => {
  const composer = { id: "active" };
  const counts = [2, 1];
  const visibleComposers = {
    count: async () => counts.shift() ?? 1,
    first: () => composer,
  };
  const page = {
    locator: () => ({
      filter: (options: { visible: boolean }) => {
        expect(options).toEqual({ visible: true });
        return visibleComposers;
      },
    }),
  };
  const activeComposer = (ChatGptBrowserWorker.prototype as unknown as {
    activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  }).activeComposer;

  expect(await activeComposer.call({}, page, 500)).toBe(composer);
});

test("large read-only context is inserted in bounded edits before exact verification", async () => {
  const prompt = `Act as the model backend for the Codex task encoded below.\n${"x".repeat(819_343)}`;
  const calls: Array<[string, string?]> = [];
  let asserted = "";
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  await attachPrompt.call({
    activeComposer: async () => composer,
    insertPromptText,
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, page, prompt, false);

  const inserted = calls.filter(call => call[0] === "insertText").map(call => call[1] ?? "");
  expect(calls.slice(0, 2)).toEqual([["fill", ""], ["focus"]]);
  expect(inserted.every(chunk => chunk.length <= CHATGPT_PROMPT_INSERT_CHUNK_CHARS)).toBeTrue();
  expect(inserted.length).toBe(5);
  expect(inserted.join("")).toBe(prompt);
  expect(asserted).toBe(prompt);
});

test("duplicate DOM representations of one selected connector are treated as one logical selection", async () => {
  const selected = {
    evaluateAll: async (callback: (elements: Array<{ getAttribute(name: string): string | null }>) => unknown) => callback([
      { getAttribute: (name: string) => name === "data-keyword" ? "lca-codex" : null },
      { getAttribute: (name: string) => name === "data-keyword" ? "lca-codex" : null },
    ]),
  };
  const connectorIsSelected = (ChatGptBrowserWorker.prototype as unknown as {
    connectorIsSelected(composer: unknown): Promise<boolean>;
  }).connectorIsSelected;

  expect(await connectorIsSelected.call({
    config: { appName: "lca-codex" },
    selectedConnectorControl: () => selected,
  }, {})).toBeTrue();
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    first() { return this; },
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    dispatchEvent: async (event: string) => {
      expect(event).toBe("click");
      connectorSelected = true;
      calls.push(["dispatchResult", event]);
    },
  };
  const selectedConnector = {
    first() { return this; },
    waitFor: async () => {
      expect(connectorSelected).toBeTrue();
      calls.push(["waitForSelectedConnector"]);
    },
    count: async () => 1,
  };
  const selectedComposer = {
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword]');
      return {
        filter: (options: { hasText: string; visible: boolean }) => {
          expect(options).toEqual({ hasText: "lca-codex", visible: true });
          return selectedConnector;
        },
      };
    },
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    getByText: (text: string, options: { exact: boolean }) => {
      expect(text).toBe("lca-codex");
      expect(options).toEqual({ exact: true });
      return { exactConnectorLabel: true };
    },
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) {
        return {
          filter: (options: { has?: unknown; visible?: boolean }) => {
            expect(options).toEqual({ has: { exactConnectorLabel: true } });
            return {
              filter: (visibleOptions: { visible: boolean }) => {
                expect(visibleOptions).toEqual({ visible: true });
                return appResult;
              },
            };
          },
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
    keyboard: {
      press: async (value: string) => { calls.push(["pagePress", value]); },
      type: async (value: string) => { calls.push(["type", value]); },
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  const resolved = await selectConnector.call({
    config: { appName: "lca-codex" },
    connectorIsSelected: async () => connectorSelected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return connectorSelected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(resolved).toBe(selectedComposer);
  expect(activeComposerCalls).toBe(3);
  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["type", "@"],
    ["waitForResult"],
    ["dispatchResult", "click"],
    ["waitForSelectedConnector"],
  ]);
});

test("narrow composer connector selection uses a real mention key and stops at the first exact row", async () => {
  const calls: string[] = [];
  let query = "";
  let selected = false;
  const timeout = new Error("not filtered yet");
  timeout.name = "TimeoutError";
  const appResult = {
    first() { return this; },
    waitFor: async () => {
      calls.push(`menu:${query}`);
      if (query !== "@l") throw timeout;
    },
    count: async () => 1,
    dispatchEvent: async (event: string) => {
      expect(event).toBe("click");
      selected = true;
      calls.push("activate");
    },
  };
  const selectedConnector = {
    first() { return this; },
    waitFor: async () => { calls.push("selected"); },
  };
  const initialComposer = {
    fill: async (value: string) => {
      expect(value).toBe("");
      query = "";
      calls.push("clear");
    },
    focus: async () => { calls.push("focus"); },
  };
  const selectedComposer = { id: "selected" };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => ({ filter: () => appResult }) }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      press: async (value: string) => { calls.push(`press:${value}`); },
      type: async (value: string) => {
        query += value;
        calls.push(`type:${value}`);
      },
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  const result = await selectConnector.call({
    config: { appName: "lca-codex" },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => selected ? selectedComposer : initialComposer,
  }, page);

  expect(result).toBe(selectedComposer);
  expect(calls).toEqual([
    "clear",
    "focus",
    "type:@",
    "menu:@",
    "type:l",
    "menu:@l",
    "activate",
    "selected",
  ]);
});

test("connector selection retriggers the complete mention after a fresh-page hydration miss", async () => {
  const calls: string[] = [];
  let menuAttempt = 0;
  let selected = false;
  const timeout = new Error("menu not hydrated");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    first() { return this; },
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push("selected");
    },
    count: async () => 1,
  };
  const appResult = {
    first() { return this; },
    waitFor: async () => {
      menuAttempt += 1;
      calls.push(`menu:${menuAttempt}`);
      if (menuAttempt < 12) throw timeout;
    },
    count: async () => 1,
    dispatchEvent: async () => {
      selected = true;
      calls.push("activate");
    },
  };
  const selectedComposer = {
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(value ? `fill:${value}` : "clear"); },
    focus: async () => { calls.push("focus"); },
  };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => ({ filter: () => appResult }) }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      press: async () => { calls.push("escape"); },
      type: async (value: string) => { calls.push(`type:${value}`); },
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await selectConnector.call({
    config: { appName: "lca-codex" },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(calls).toEqual([
    "clear", "focus", "type:@", "menu:1",
    "type:l", "menu:2", "type:c", "menu:3", "type:a", "menu:4", "type:-", "menu:5",
    "type:c", "menu:6", "type:o", "menu:7", "type:d", "menu:8", "type:e", "menu:9",
    "type:x", "menu:10", "menu:11",
    "escape", "clear",
    "escape", "clear", "focus", "type:@", "menu:12",
    "activate", "selected",
  ]);
});

test("tool-capable prompts use the shared Playwright connector selection before inserting context", async () => {
  const calls: Array<[string, string?]> = [];
  let selected = false;
  const selectedConnector = {
    first() { return this; },
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push(["selectedConnector"]);
    },
    count: async () => 1,
  };
  const appResult = {
    first() { return this; },
    waitFor: async () => { calls.push(["connectorMenu"]); },
    count: async () => 1,
    dispatchEvent: async () => {
      selected = true;
      calls.push(["selectConnector"]);
    },
  };
  const selectedComposer = {
    focus: async () => { calls.push(["selectedFocus"]); },
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => ({ filter: () => appResult }) }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
      press: async (value: string) => { calls.push(["press", value]); },
      type: async (value: string) => { calls.push(["type", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  let activeComposerCalls = 0;
  await attachPrompt.call({
    config: { appName: "lca-codex" },
    selectConnector,
    insertPromptText,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true);

  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["type", "@"],
    ["connectorMenu"],
    ["selectConnector"],
    ["selectedConnector"],
    ["selectedFocus"],
    ["press", "End"],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
});

test("image attachment readiness uses exact file tiles and not localized remove-button text", async () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls: Array<[string, string?]> = [];
  const send = {
    isEnabled: async () => {
      calls.push(["sendEnabled"]);
      return true;
    },
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("group");
      expect(options).toEqual({ name: "codex-input-image-1.png", exact: true });
      return {
        waitFor: async (state: { state: string; timeout: number }) => {
          expect(state).toEqual({ state: "visible", timeout: 60_000 });
          calls.push(["fileTile", options.name]);
        },
      };
    },
    getByTestId: (testId: string) => {
      expect(testId).toBe("send-button");
      return send;
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const input = {
    waitFor: async (state: { state: string; timeout: number }) => {
      expect(state).toEqual({ state: "attached", timeout: 20_000 });
      calls.push(["inputReady"]);
    },
    setInputFiles: async (files: Array<{ name: string }>) => {
      calls.push(["setFiles", files.map(file => file.name).join(",")]);
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[data-testid="upload-photos-input"]') return input;
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => [] };
      }
      return { last: () => composer };
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await attachFiles.call({ activeComposer: async () => composer }, page, {
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["inputReady"],
    ["setFiles", "codex-input-image-1.png"],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain('aria-label^="Remove file "');
});

test("effort selection uses structural menu indices instead of localized labels", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("mode.uiEffortIndex");
  expect(workerSource).toContain("CHATGPT_EFFORT_MENU_SELECTOR");
  expect(workerSource).toContain("CHATGPT_EFFORT_ITEM_SELECTOR");
  expect(workerSource).toContain('timeout: 70_000');
  expect(sessionSource).toContain('[role="menu"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="group"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="menuitemradio"]');
  expect(sessionSource).not.toContain(":popover-open");
  expect(sessionSource).not.toContain("data-radix-collection-item");
  expect(workerSource).toContain('getAttribute("aria-checked")');
  expect(workerSource).toContain('getAttribute("aria-expanded")');
  expect(workerSource).not.toContain("currentLabel === targetLabel");
  expect(workerSource).not.toContain("chatGptEffortLabelsMatch");
  expect(workerSource).not.toMatch(/getByRole\("button", \{\s*name: "(?:Instant|Medium|High|Extra High|Pro)"/);
});

test("effort selection handles the known ChatGPT rate-limit dialog before trusted pointer activation", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const selectionStart = workerSource.indexOf("private async selectModelAndEffort");
  const selectionEnd = workerSource.indexOf("private async activeComposer", selectionStart);
  const selectionSource = workerSource.slice(selectionStart, selectionEnd);
  const guard = selectionSource.indexOf("throwIfChatGptRateLimitDialog(page)");
  const activation = selectionSource.indexOf("currentEffort.click()");

  expect(workerSource).toContain("Too many requests");
  expect(workerSource).toContain("making requests too quickly");
  expect(guard).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(guard);
  expect(selectionSource).not.toContain('currentEffort.press("Enter")');
  expect(selectionSource).toContain("effortChoice.click()");
  expect(selectionSource).not.toContain('effortChoice.press("Enter")');
  expect(selectionSource).not.toContain("is unavailable");
});

function dialogPage(text: string): { page: Page; pressed: string[] } {
  let matches = true;
  const pressed: string[] = [];
  const button = {
    last: () => button,
    isVisible: async () => matches,
    press: async (key: string) => { pressed.push(key); },
  };
  const dialog = {
    filter: ({ hasText }: { hasText: string | RegExp }) => {
      matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => matches,
    getByRole: () => button,
  };
  return {
    page: {
      locator: () => dialog,
      getByText: (hasText: string | RegExp) => dialog.filter({ hasText }),
    } as unknown as Page,
    pressed,
  };
}

test("the known ChatGPT rate-limit dialog is acknowledged and returns a structured 429", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "LcaCodexAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("unrelated ChatGPT dialogs are left untouched", async () => {
  const fixture = dialogPage("Confirm another action");

  await throwIfChatGptRateLimitDialog(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

test("a failed subscription fetch is retryable and does not falsely invalidate ChatGPT login", async () => {
  const fixture = dialogPage(
    "Failed to load subscription: Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
  );

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "LcaCodexAdapterError",
    status: 503,
    errorType: "server_error",
    code: "chatgpt_subscription_unavailable",
    retryable: true,
  });
});

test("submission acceptance stops when its stage is aborted", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      networkObserver: unknown,
      signal: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const controller = new AbortController();
  controller.abort();

  await expect(waitForSubmissionAccepted.call(
    {},
    {},
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

function toolConfirmationPage(options: { disappearAfterReads?: number } = {}): {
  page: Page;
  pressed: string[];
} {
  let reads = 0;
  let visible = true;
  const pressed: string[] = [];
  const button = (name: string) => ({
    last: () => button(name),
    waitFor: async () => {},
    press: async (key: string) => {
      pressed.push(`${name}:${key}`);
      visible = false;
    },
  });
  const dialog = {
    filter: ({ hasText }: { hasText: string }) => {
      expect(hasText).toBe("Allow ChatGPT to use lca-codex?");
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => {
      reads += 1;
      if (options.disappearAfterReads !== undefined && reads >= options.disappearAfterReads) visible = false;
      return visible;
    },
    getByRole: (_role: string, input: { name: string }) => button(input.name),
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(visible).toBeFalse();
    },
  };
  return {
    page: { locator: () => dialog } as unknown as Page,
    pressed,
  };
}

test("manual ChatGPT connector approval pauses and resumes the same browser turn", async () => {
  const fixture = toolConfirmationPage({ disappearAfterReads: 3 });

  expect(await resolveChatGptToolConfirmation(fixture.page, "lca-codex", false, undefined, 100)).toBeTrue();
  expect(fixture.pressed).toEqual([]);
});

test("an unanswered ChatGPT connector approval is denied instead of aborting the turn", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "lca-codex", false, undefined, 2)).toBeTrue();
  expect(fixture.pressed).toEqual(["Deny:Enter"]);
});

test("explicit connector auto-approval still selects Allow once", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "lca-codex", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow once:Enter"]);
});

test("browser preflight uses one hard effective-input safety gate across reasoning modes", () => {
  expect(() => assertLcaCodexInputWithinContextWindow(725_000, "medium")).toThrow(
    "725,000-token ChatGPT Web safety limit",
  );
  try {
    assertLcaCodexInputWithinContextWindow(725_000, "medium");
    throw new Error("expected context-window preflight to fail");
  } catch (error) {
    expect(error).toMatchObject({
      name: "LcaCodexAdapterError",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    });
    expect(String(error)).toContain("Reduce the current required input or attachments");
  }

  expect(() => assertLcaCodexInputWithinContextWindow(724_999, "medium")).not.toThrow();
  expect(() => assertLcaCodexInputWithinContextWindow(724_999, "high")).not.toThrow();
  expect(() => assertLcaCodexInputWithinContextWindow(724_999, "xhigh")).not.toThrow();
  expect(() => assertLcaCodexInputWithinContextWindow(724_999, "max")).not.toThrow();
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("browser stage diagnostics use safe bounded artifact names", () => {
  expect(browserDiagnosticCheckpoint("effort menu / before click")).toBe("effort-menu-before-click");
  expect(browserDiagnosticCheckpoint("../turn_token secret")).toBe("turn_token-secret");
  expect(browserDiagnosticCheckpoint("x".repeat(200))).toHaveLength(80);
});

test("browser stage diagnostics preserve every critical local checkpoint", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  for (const checkpoint of [
    "browser-page-acquired",
    "temporary-chat-navigation-complete",
    "composer-ready",
    "session-verified",
    "effort-control-ready",
    "effort-menu-open-requested",
    "effort-selected",
    "connector-mention-triggered",
    "connector-menu-visible",
    "connector-menu-missing",
    "connector-selected",
    "prompt-attachment-complete",
    "file-attachment-complete",
    "send-ready",
    "send-accepted",
    "tool-confirmation-visible",
    "response-visible",
    "completion-pending-30s",
    "turn-completed",
    "turn-failed",
  ]) {
    expect(workerSource).toContain(`"${checkpoint}"`);
  }
  expect(workerSource).toContain('join(getConfigDir(), "diagnostics", "browser-turns")');
  expect(workerSource).toContain('page.screenshot({ animations: "disabled", caret: "hide"');
  expect(workerSource).toContain('session.send("Page.captureScreenshot"');
  expect(workerSource).toContain("const screenshotPath = join(this.directory, `${stem}.png`)");
  expect(workerSource).toContain("atomicWriteFile(screenshotPath, screenshotResult.value.screenshot)");
  expect(workerSource).toContain("await Promise.allSettled([");
  expect(workerSource).toContain("CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10");
  expect(workerSource).toContain('process.env.LCA_CODEX_BROWSER_DIAGNOSTICS !== "1"');
  expect(workerSource).toContain('checkpoint !== "completion-pending-30s"');
});

test("browser lifecycle no longer fails from response DOM health heuristics", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain("ChatGptTurnDomHealthTracker");
  expect(workerSource).not.toContain("response DOM disappeared");
  expect(workerSource).not.toContain("response-dom-health-failed");
  expect(workerSource).toContain('surfacedError.message.includes("Browser diagnostic screenshot:")');
  expect(workerSource).toContain('diagnostics.captureError(diagnosticPage, "turn-failed", surfacedError)');
  expect(workerSource).not.toContain('diagnostics.capture(diagnosticPage, "turn-failed", surfacedError)');
  expect(workerSource).toContain("visibleStopButtons: visibleStopButtons.length");
  expect(workerSource).toContain("visibleCompletionActions: visibleCompletionActions.length");
  expect(workerSource).toContain("visibleTerminalActionGroupCount:");
});

test("response polling balances visible latency with weak-machine efficiency", () => {
  expect(CHATGPT_RESPONSE_POLL_MS).toBe(250);
  expect(CHATGPT_RESPONSE_IDLE_POLL_MS).toBe(500);
  const tracker = new ChatGptVisibleTraceTracker();
  const block = [{ kind: "status", text: "Inspecting runtime state" }] as const;
  expect(tracker.observe([...block], false, 1_000)).toEqual([]);
  expect(tracker.observe([...block], false, 1_099)).toEqual([]);
  expect(tracker.observe([...block], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime state" },
  ]);
});

test("terminal resolution finalizes the DOM-backed Markdown serializer", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const networkCompletion = workerSource.indexOf("if (networkCompletionReady || recoveredCompletionReady) {");
  const finalSnapshot = workerSource.indexOf("const final = markdownBuffer.finish()", networkCompletion);
  const finalEmission = workerSource.indexOf("turn.onTextDelta(final.delta)", finalSnapshot);
  expect(networkCompletion).toBeGreaterThan(-1);
  expect(finalSnapshot).toBeGreaterThan(networkCompletion);
  expect(finalEmission).toBeGreaterThan(finalSnapshot);
  expect(workerSource).toContain("const markdownSegments = renderedRoots.flatMap((markdownRoot, rootIndex) =>");
  expect(workerSource).not.toContain("ChatGptCompletionTracker");
  expect(workerSource).not.toContain("chatGptResponseHasStructuredMarkdown");
  expect(workerSource).not.toContain("markdownBuffer.flush()");
  expect(workerSource).toContain("const markdownBuffer = new ChatGptMarkdownBuffer(");
});

test("network completion remains authoritative when the assistant DOM is absent on the terminal poll", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const responsePresentBranch = workerSource.indexOf("if (snapshot.responsePresent) {");
  const networkCompletion = workerSource.indexOf("if (networkCompletionReady || recoveredCompletionReady) {", responsePresentBranch);
  expect(responsePresentBranch).toBeGreaterThan(-1);
  expect(networkCompletion).toBeGreaterThan(responsePresentBranch);
  expect(workerSource.slice(responsePresentBranch, networkCompletion)).toContain("}");
  expect(workerSource).toContain("const completedVisibleText = snapshot.visibleText || lastResponseVisibleText;");
  expect(workerSource).not.toContain("if (snapshot.responsePresent && networkCompletionReady)");
});

test("adaptive polling backs off only after repeated unchanged snapshots", () => {
  const scheduler = new ChatGptAdaptivePollScheduler();
  expect(scheduler.nextDelay(true)).toBe(250);
  expect(scheduler.nextDelay(false)).toBe(250);
  expect(scheduler.nextDelay(false)).toBe(500);
  expect(scheduler.nextDelay(false)).toBe(500);
  expect(scheduler.nextDelay(true)).toBe(250);
});

test("visible trace rewrites start a fresh block instead of crashing the turn", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([{ kind: "status", text: "Searching sources", key: "action" }], false, 1_000)).toEqual([
    { kind: "reasoning", text: "Searching sources" },
  ]);
  expect(tracker.observe([{ kind: "status", text: "Reviewed sources", key: "action" }], false, 1_010)).toEqual([
    { kind: "reasoning", text: "Reviewed sources" },
  ]);
});

test("incomplete commentary streams a guarded stable prefix instead of waiting for the next action", () => {
  const tracker = new ChatGptVisibleTraceTracker(100, {
    tailGuardChars: 8,
    minDeltaChars: 4,
    prefixStabilityMs: 50,
    flushIntervalMs: 50,
  });
  expect(tracker.observe([
    { kind: "commentary", text: "Checking repository architecture now", complete: false },
  ], false, 1_000)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking repository architecture now carefully", complete: false },
  ], false, 1_050)).toEqual([
    { kind: "commentary", text: "Checking repository " },
  ]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking repository architecture now carefully for drift", complete: false },
  ], false, 1_100)).toEqual([
    { kind: "commentary", text: "architecture now ", continuation: true },
  ]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking repository architecture now carefully for drift", complete: true },
  ], false, 1_200)).toEqual([
    { kind: "commentary", text: "carefully for drift", continuation: true },
  ]);
});

test("visible DOM trace interleaves statuses and explicit intermediate commentary", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initialBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...initialBlocks], false, 1_000)).toEqual([]);
  expect(tracker.observe([...initialBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
  ]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_200)).toEqual([]);
  expect(tracker.observe([...commentaryBlocks], false, 1_300)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
  ]);
  expect(tracker.observe([
    { kind: "answer", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace does not duplicate a phase after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Thinking" },
  ]);
  expect(tracker.observe([], false, 1_150)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_300)).toEqual([]);
});

test("streaming commentary resumes by delta after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([{ kind: "commentary", text: "Checking sources" }], false, 1_000)).toEqual([
    { kind: "commentary", text: "Checking sources" },
  ]);
  expect(tracker.observe([], false, 1_010)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking sources and dates" },
  ], false, 1_020)).toEqual([
    { kind: "commentary", text: " and dates", continuation: true },
  ]);
});

test("visible DOM trace emits a short-lived reasoning label on its first observation", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([
    { kind: "status", text: "Binding Codex turn context" },
  ], false, 1_000)).toEqual([
    { kind: "reasoning", text: "Binding Codex turn context" },
  ]);
});

test("completed-turn evidence flushes a short-lived reasoning label immediately", () => {
  const tracker = new ChatGptVisibleTraceTracker(10_000);
  expect(tracker.observe([
    { kind: "status", text: "Reviewing LCA Codex Prompt and State Handling" },
  ], true, 1_000)).toEqual([
    { kind: "reasoning", text: "Reviewing LCA Codex Prompt and State Handling" },
  ]);
});

test("visible DOM trace emits one complete commentary paragraph before the next action", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "commentary", text: "I’m reading", complete: false },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([]);
  const expanded = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: false },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([]);
  const completed = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: true },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...completed], false, 1_250)).toEqual([
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture" },
  ]);
  expect(tracker.observe([...completed], false, 1_350)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
  expect(tracker.observe([...completed], false, 1_450)).toEqual([]);
});

test("response DOM separates streaming commentary from the final Markdown answer", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const responseSnapshotSource = workerSource.slice(
    workerSource.indexOf("private async responseDomSnapshot"),
    workerSource.indexOf("private async pendingCompletionDiagnostic"),
  );
  expect(responseSnapshotSource).toContain("if (!candidate.isConnected) return false");
  expect(responseSnapshotSource).not.toContain("getBoundingClientRect()");
  expect(workerSource).toContain('const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]');
  expect(workerSource).toContain("const commentaryRoots = allMarkdownRoots.filter");
  expect(workerSource).toContain('candidate.closest("[data-streaming-response-status]") !== null');
  expect(workerSource).toContain("const renderedRoots = allMarkdownRoots.filter");
  expect(workerSource).toContain("const markdownSegments = renderedRoots.flatMap((markdownRoot, rootIndex) =>");
  expect(workerSource).toContain("text: child.innerText.trim()");
  expect(workerSource).toContain("streamable: childIsComplete");
  expect(workerSource).toContain("group,");
  expect(workerSource).toContain("fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(\"\")");
  expect(workerSource).not.toContain("!mode.localTools");
  expect(workerSource).toContain("markdownBuffer.observe(");
  expect(workerSource).toContain("const final = markdownBuffer.finish()");
  expect(workerSource).toContain("const pollScheduler = new ChatGptAdaptivePollScheduler()");
  expect(workerSource).not.toContain("ChatGptTextDeltaCoalescer");
  expect(workerSource).toContain("setTimeout(resolveSleep, nextPollMs)");
  expect(workerSource).toContain("markdownSegments");
  expect(workerSource).toContain("streamable: childIsComplete");
  expect(workerSource).toContain("const overlapsRenderedAnswer = (candidate: HTMLElement)");
  expect(workerSource).toContain("const statusSemantic = (candidate: HTMLElement)");
  expect(workerSource).toContain('candidate.closest<HTMLElement>("button") ?? candidate');
  expect(workerSource).toContain('candidate.querySelectorAll<HTMLElement>(".sr-only")');
  expect(workerSource).not.toContain("const adjacentCommentary");
  expect(workerSource).toContain('candidate.closest<HTMLElement>("[data-item-anchor]")');
  expect(workerSource).toContain("const traceByKey = new Map<string, ChatGptVisibleTraceBlock>()");
  expect(workerSource).toContain('block.kind === "commentary" ? { complete: index < blocks.length - 1 }');
  expect(workerSource).toContain('uiControl: candidate.matches("button")');
  expect(workerSource).toContain("!overlapsRenderedAnswer(semantic)");
  expect(workerSource).toContain("!overlapsRenderedAnswer(container)");
  expect(workerSource).not.toContain('fullHtml: rendered?.innerHTML ?? ""');
});

test("visible DOM trace keeps a complete action phrase instead of a nested count", () => {
  expect(new ChatGptVisibleTraceTracker(0).observe([
    { kind: "status", text: "Searched\n5\nsites" },
  ], false)).toEqual([
    { kind: "reasoning", text: "Searched 5 sites" },
  ]);
});

test("visible DOM trace waits out animated Pro fragments and appends genuine growth", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "I" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I’m" }], false, 1_025)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "’m seeking" }], false, 1_050)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "a concrete stack" }], false, 1_075)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_100)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_200)).toEqual([{
    kind: "reasoning",
    text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity",
  }]);

  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_250)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_350)).toEqual([{
    kind: "reasoning",
    text: ", including validation",
    continuation: true,
  }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Thinking" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Switch model", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "More actions", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Inspecting models", uiControl: false })).toBe(false);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "answer", text: "Answer now" })).toBe(false);
});

test("pending-completion diagnostics record DOM metrics without response or overlay content", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const start = workerSource.indexOf("private async pendingCompletionDiagnostic");
  const end = workerSource.indexOf("private async runExclusive", start);
  const diagnosticSource = workerSource.slice(start, end);
  expect(diagnosticSource).toContain("textChars:");
  expect(diagnosticSource).toContain("htmlChars:");
  expect(diagnosticSource).not.toMatch(/\btext:\s*(?:root|candidate)\.innerText/);
  expect(diagnosticSource).not.toMatch(/\bariaLabel:\s*candidate\.getAttribute/);
});

test("response DOM parsing recognizes terminal action groups when Copy collapses into overflow", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain('button[data-testid="copy-turn-action-button"]');
  expect(workerSource).toContain("CHATGPT_COMPLETION_ACTION_SELECTOR");
  expect(workerSource).toContain("const terminalActionGroup = rendered");
  expect(workerSource).toContain('candidate.querySelector(completionActionSelector) !== null');
  expect(workerSource).toContain('button[aria-haspopup="menu"]');
  expect(workerSource).toContain(".filter(followsRendered)");
  expect(workerSource).not.toContain('root.querySelectorAll<HTMLElement>("button")');
});

test("browser DOM serialization re-resolves the latest visible assistant turn after launcher reattachment", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource.match(/responseTurn = page\.locator\(CHATGPT_ASSISTANT_TURN_SELECTOR\)\.filter\(\{ visible: true \}\)\.last\(\)/g)?.length).toBe(2);
  expect(workerSource).not.toContain("initialResponseTurnCount");
});

test("browser submission acceptance uses only network lifecycle evidence", () => {
  const workerSource = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const start = workerSource.indexOf("private async waitForSubmissionAccepted(");
  const end = workerSource.indexOf("private async attachedPromptText", start);
  const submissionSource = workerSource.slice(start, end);
  expect(submissionSource).toContain('if (networkState.turnKnown) return "network_turn";');
  expect(submissionSource).toContain('if (networkState.conversationKnown) return "network_conversation";');
  expect(submissionSource).toContain("networkObserver.isAttached()");
  expect(submissionSource).not.toContain("userTurnCount");
  expect(submissionSource).not.toContain("assistantTurnCount");
  expect(submissionSource).not.toContain("generationRunning");
});
