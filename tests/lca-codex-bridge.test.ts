import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { chatGptImageFilePayloads, chatGptPromptFilePayloads } from "../src/adapters/lca-codex/browser-worker";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/lca-codex/browser-worker";
import { LcaCodexAdapterError } from "../src/adapters/lca-codex/adapter-error";
import { declaredCodexToolHealthRoutes, waitForCodexToolGatewayRoutes } from "../src/adapters/lca-codex/codex-tool-health";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/lca-codex/environment";
import {
  createLcaCodexAdapter,
  isLcaCodexToolHealthProbe,
  LCA_CODEX_TOOL_HEALTH_PROBE_PROMPT,
} from "../src/adapters/lca-codex/index";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/lca-codex/markdown";
import { LCA_CODEX_MODEL_ID, resolveLcaCodexModelMode } from "../src/adapters/lca-codex/model";
import { chatGptReadOnlyContextWarning, compileChatGptContextSnapshot, compileLcaCodexPrompt, withoutSupersededModelSwitchContracts } from "../src/adapters/lca-codex/prompt";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/lca-codex/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/lca-codex/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { estimateLcaCodexUsage } from "../src/adapters/lca-codex/usage";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

const tempRoot = join(tmpdir(), `lca-codex-bridge-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const tools: CodexTool[] = [
  { name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true },
  { name: "exec_command", description: "Run command", parameters: { type: "object" } },
  { name: "write_stdin", description: "Continue command", parameters: { type: "object" } },
  { name: "apply_patch", description: "Patch files", parameters: {}, freeform: true },
  { name: "view_image", description: "View image", parameters: { type: "object" } },
  { name: "search_openai_docs", namespace: "mcp__openaiDeveloperDocs", description: "Search docs", parameters: { type: "object" } },
];

const environmentXml = `<environment_context>
  <cwd>${tempRoot}</cwd>
  <filesystem><workspace_roots><root>${tempRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
const toolCapabilities = { localToolsEnabled: true, proAvailable: true };
const readOnlyCapabilities = { localToolsEnabled: false, proAvailable: true };

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function parsed(developerText?: string): CodexParsedRequest {
  return {
    modelId: LCA_CODEX_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [
        ...(developerText ? [{ role: "developer" as const, content: developerText, timestamp: 1 }] : []),
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
  };
}

function rawWireRequest(environmentText: string): CodexParsedRequest {
  const request = parsed();
  const turnId = "turn_test_123";
  const threadId = "thread_test_123";
  request._rawBody = {
    prompt_cache_key: threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentText }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  return request;
}

function canonicalCurrentWireRequest(environmentText: string): CodexParsedRequest {
  const request = rawWireRequest(environmentText);
  const raw = request._rawBody as {
    client_metadata: Record<string, unknown>;
    input: Array<Record<string, unknown>>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: "thread_test_123",
    turn_id: "turn_test_123",
    request_kind: "turn",
    sandbox: "none",
  });
  raw.input.unshift({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Follow the repository instructions." }],
  });
  raw.input[1]!.id = "msg_environment";
  raw.input[2]!.id = "msg_instruction";
  raw.input[1]!.content = [
    { type: "input_text", text: "<recommended_plugins>none</recommended_plugins>" },
    { type: "input_text", text: environmentText },
  ];
  delete raw.input[1]!.internal_chat_message_metadata_passthrough;
  delete raw.input[2]!.internal_chat_message_metadata_passthrough;
  return request;
}

function proRequest(environmentText = environmentXml): CodexParsedRequest {
  const request = rawWireRequest(environmentText);
  request.options.reasoning = "max";
  return request;
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function gatewayRegistryResult(availability: Record<string, boolean>): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: `LCA_CODEX_TOOL_HEALTH_ROUTES:${JSON.stringify(availability)}`,
    }],
  };
}

describe("LCA Codex ChatGPT Web bridge v3", () => {
  test("recovers the Codex exec gateway nested in an additional_tools namespace", () => {
    const gatewayDescription = [
      "Run JavaScript code to orchestrate tools.",
      "### `exec_command`",
      "### `write_stdin`",
      "### `apply_patch`",
      "### `view_image`",
    ].join("\n");
    const request = parseRequest({
      model: "lca-codex",
      stream: true,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              { type: "custom", name: "exec", description: gatewayDescription, format: { type: "text" } },
              { type: "function", name: "wait", description: "Wait for exec", parameters: { type: "object" }, strict: false },
            ],
          }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }] },
      ],
    });

    const gateway = request.context.tools?.find(tool => tool.name === "exec");
    expect(gateway).toMatchObject({ name: "exec", freeform: true, description: gatewayDescription });
    expect(gateway?.namespace).toBeUndefined();
    expect(request.context.tools?.find(tool => tool.name === "wait")).toMatchObject({ namespace: "functions" });

    const health = declaredCodexToolHealthRoutes({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: request.context.tools ?? [],
    });
    expect(health.gatewayAdvertised).toBe(true);
    expect([...health.routes]).toEqual(expect.arrayContaining(["exec_command", "write_stdin", "apply_patch", "view_image"]));
  });

  test("nested tool readiness retries a transiently incomplete exec registry", async () => {
    const inspections = [
      gatewayRegistryResult({ apply_patch: false }),
      gatewayRegistryResult({ apply_patch: true }),
    ];
    const inspected = await waitForCodexToolGatewayRoutes({
      names: ["apply_patch"],
      retryDelaysMs: [0, 0],
      inspect: async () => inspections.shift()!,
    });

    expect(inspected).toEqual({ availability: { apply_patch: true } });
    expect(inspections).toHaveLength(0);
  });

  test("gateway readiness accepts exec_command and shell_command as alternative command routes", async () => {
    for (const commandRoutes of [
      { exec_command: true, shell_command: false },
      { exec_command: false, shell_command: true },
    ]) {
      const inspections = [gatewayRegistryResult({
        ...commandRoutes,
        write_stdin: true,
        apply_patch: true,
        view_image: true,
      })];
      const inspected = await waitForCodexToolGatewayRoutes({
        names: ["exec_command", "shell_command", "write_stdin", "apply_patch", "view_image"],
        retryDelaysMs: [0, 0],
        inspect: async () => inspections.shift()!,
      });

      expect(inspected.availability).toEqual({
        ...commandRoutes,
        write_stdin: true,
        apply_patch: true,
        view_image: true,
      });
      expect(inspections).toHaveLength(0);
    }
  });

  test("rejects an opaque MultiAgent V2 child payload before starting the browser", async () => {
    const request = parseRequest({
      model: "lca-codex",
      stream: true,
      reasoning: { effort: "ultra" },
      input: [{
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "encrypted_content", encrypted_content: "opaque-native-v2-payload" }],
      }],
    });
    expect(request._opaqueMultiAgentV2Payload).toBe(true);

    const socketPath = brokerTestEndpoint(`cgw-h3-v2-reject-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-v2-reject-test",
      lcaCodex: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      return "unexpected";
    };
    try {
      await expect(createLcaCodexAdapter(provider).runTurn!(
        request,
        { headers: new Headers() },
        () => {},
      )).rejects.toThrow("require a V1-rooted task");
      expect(browserStarts).toBe(0);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("extracts authoritative environment, tool registry, and turn identity from the Codex wire envelope", () => {
    const request = rawWireRequest(environmentXml);
    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
    expect(extractChatGptTurnIdentity(request)).toEqual({
      threadId: "thread_test_123",
      turnId: "turn_test_123",
      promptCacheKey: "thread_test_123",
    });
  });

  test("accepts adjacent native turn provenance when Codex omits top-level client_metadata", () => {
    const request = rawWireRequest(environmentXml);
    delete (request._rawBody as { client_metadata?: unknown }).client_metadata;
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(tempRoot);
  });

  test("accepts the canonical current-turn environment when Codex omits item turn ids and git metadata", () => {
    const request = canonicalCurrentWireRequest(environmentXml);

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
    expect(() => chatGptTurnExecutionKey(request)).not.toThrow();
  });

  test("keeps native client turn identity authoritative when message provenance uses another turn id", () => {
    const request = canonicalCurrentWireRequest(environmentXml);
    const raw = request._rawBody as { input: Array<Record<string, unknown>> };
    raw.input[2]!.internal_chat_message_metadata_passthrough = { turn_id: "turn_other" };

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
    expect(() => chatGptTurnExecutionKey(request)).not.toThrow();
  });

  test("starts a tool-capable browser turn from the current Codex metadata shape", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-canonical-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-canonical-metadata-test",
      lcaCodex: { brokerSocketPath: socketPath, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      expect(prepared.transport).toBe("mcp-lazy");
      expect(prepared.text).toContain("<codex_active_context>");
      expect(prepared.text).toContain("<codex_context_ref>");
      expect(prepared.text).toContain("answer immediately with zero connector calls when the active context is sufficient");
      expect(prepared.text).toContain("instructions for Codex skill/capability guidance");
      const answer = "Canonical metadata accepted";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      const request = canonicalCurrentWireRequest(environmentXml);

      const events: AdapterEvent[] = [];
      await createLcaCodexAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("launcher native-tool health probe creates its own broker wait without starting ChatGPT", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-health-probe-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-health-probe-test",
      lcaCodex: { brokerSocketPath: socketPath, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      throw new Error("health probe must not start ChatGPT");
    };
    const request = rawWireRequest(environmentXml);
    request.context.tools = tools.filter(tool => tool.name !== "exec");
    request.context.messages = [{ role: "user", content: LCA_CODEX_TOOL_HEALTH_PROBE_PROMPT, timestamp: 2 }];
    const raw = request._rawBody as { input: Array<Record<string, unknown>> };
    raw.input.at(-1)!.content = [{ type: "input_text", text: LCA_CODEX_TOOL_HEALTH_PROBE_PROMPT }];
    expect(isLcaCodexToolHealthProbe(request)).toBe(true);

    const adapter = createLcaCodexAdapter(provider);
    const firstEvents: AdapterEvent[] = [];
    const firstTurn = adapter.runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
    await Bun.sleep(10);
    const health = callTurnBroker<{
      activeTurn: boolean;
      live: boolean;
      tools: Array<{ name: string; status: string }>;
    }>(socketPath, { method: "health_check" }, 30_000);

    try {
      await firstTurn;
      const execCall = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
      expect(execCall?.name).toBe("exec_command");

      const secondRequest = structuredClone(request);
      secondRequest.context.messages.push({
        role: "toolResult",
        toolCallId: execCall!.id,
        toolName: "exec_command",
        content: JSON.stringify({ session_id: 37 }),
        isError: false,
        timestamp: 3,
      });
      const secondEvents: AdapterEvent[] = [];
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => secondEvents.push(event));
      const stdinCall = secondEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
      expect(stdinCall?.name).toBe("write_stdin");

      const thirdRequest = structuredClone(secondRequest);
      thirdRequest.context.messages.push({
        role: "toolResult",
        toolCallId: stdinCall!.id,
        toolName: "write_stdin",
        content: JSON.stringify({ output: "LCA_CODEX_TOOL_CHECK_STDIN" }),
        isError: false,
        timestamp: 4,
      });
      const abort = new AbortController();
      const thirdTurn = adapter.runTurn!(
        thirdRequest,
        { headers: new Headers(), abortSignal: abort.signal },
        () => {},
      );
      const report = await health;
      expect(report.activeTurn).toBe(true);
      expect(report.live).toBe(true);
      expect(report.tools.map(tool => [tool.name, tool.status])).toEqual([
        ["exec_command", "working"],
        ["write_stdin", "working"],
        ["apply_patch", "available"],
        ["view_image", "available"],
      ]);
      expect(browserStarts).toBe(0);
      abort.abort();
      await expect(thirdTurn).rejects.toThrow();
    } finally {
      (worker as unknown as { run: typeof worker.run }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close().catch(() => {});
    }
  });

  test("does not trust an environment tag supplied as the active user message", () => {
    const request = parsed();
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn_test_123" }) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentXml }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
      }],
    };
    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("recovers the trusted environment from a locally restored previous_response prefix", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First turn complete" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };
    request._replayPrefixLen = firstInput.length + 1;

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
  });

  test("recovers the trusted environment from a native full-history Codex resume", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test_123", turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First turn complete" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
  });

  test("rejects a historical environment pair without intervening assistant output", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test_123", turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });


  test("uses stable native turn metadata for every provider round in one Codex turn", () => {
    const first = rawWireRequest(environmentXml);
    const second = rawWireRequest(environmentXml);
    second.context.messages[0]!.timestamp = Date.now();
    second.context.messages.push({
      role: "toolResult",
      toolCallId: "call_123",
      toolName: "exec_command",
      content: "done",
      isError: false,
      timestamp: Date.now(),
    });
    expect(chatGptTurnExecutionKey(first)).toBe(chatGptTurnExecutionKey(second));
    const steered = structuredClone(second);
    steered.context.messages.push({
      role: "user",
      content: "Stop and review the implementation before continuing",
      timestamp: Date.now(),
    });
    ((steered._rawBody as { input: unknown[] }).input).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Stop and review the implementation before continuing" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
    });
    expect(chatGptTurnExecutionKey(steered)).not.toBe(chatGptTurnExecutionKey(second));
    const afterCompact = rawWireRequest(environmentXml);
    afterCompact.context.messages.push({
      role: "user",
      content: `${SUMMARY_PREFIX}\nCompacted history`,
      timestamp: Date.now(),
    });
    ((afterCompact._rawBody as { input: unknown[] }).input).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nCompacted history` }],
    });
    expect(chatGptTurnExecutionKey(afterCompact)).toBe(chatGptTurnExecutionKey(first));
    const compact = structuredClone(first);
    compact._compactionRequest = true;
    expect(chatGptTurnExecutionKey(compact)).not.toBe(chatGptTurnExecutionKey(first));
    const newCompactTurn = structuredClone(compact);
    (newCompactTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_test_123",
        turn_id: "turn_compact_456",
      }),
    };
    expect(chatGptCompactionSourceExecutionKey(newCompactTurn)).toBe(chatGptTurnExecutionKey(first));
    expect(chatGptTurnExecutionKey(newCompactTurn)).not.toBe(chatGptTurnExecutionKey(first));
    const laterCompact = structuredClone(newCompactTurn);
    ((laterCompact._rawBody as { input: unknown[] }).input).push({
      type: "function_call_output",
      call_id: "call_later",
      output: "later compacted state",
    });
    expect(chatGptTurnExecutionKey(laterCompact)).not.toBe(chatGptTurnExecutionKey(newCompactTurn));
    expect(chatGptCompactionSourceExecutionKey(laterCompact)).toBe(chatGptTurnExecutionKey(first));
    expect(() => chatGptTurnExecutionKey(parsed(environmentXml))).toThrow("requires native Codex turn_id metadata");
  });

  test("coalesces provider retries onto one browser runtime and preserves outstanding calls", () => {
    const sessions = new ChatGptTurnSessions();
    let starts = 0;
    const runtime = () => {
      starts += 1;
      return {
        mode: "tools" as const,
        token: new Promise<string>(() => {}),
        browser: new Promise<string>(() => {}),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => {},
      };
    };
    const first = sessions.getOrCreate("same", runtime);
    const second = sessions.getOrCreate("same", runtime);
    expect(second).toBe(first);
    expect(starts).toBe(1);
    first.setOutstanding([{ callId: "call_1", wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } }]);
    expect(second.outstanding()).toEqual([{ callId: "call_1", wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } }]);
  });

  test("retires an active previous turn when a new turn starts on the same Codex thread", async () => {
    const sessions = new ChatGptTurnSessions();
    let oldReject!: (error: Error) => void;
    let otherReject!: (error: Error) => void;
    let oldCancellations = 0;
    let otherCancellations = 0;
    const old = sessions.getOrCreate("old", () => ({
      mode: "read-only",
      browser: new Promise<string>((_resolve, reject) => { oldReject = reject; }),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {
        oldCancellations += 1;
        oldReject(new DOMException("old turn cancelled", "AbortError"));
      },
    }), { threadId: "thread-a", turnId: "turn-old", purpose: "response" });
    const sameTurnRetry = sessions.getOrCreate("old", () => {
      throw new Error("same execution key must reuse its session");
    }, { threadId: "thread-a", turnId: "turn-old", purpose: "response" });
    const otherThread = sessions.getOrCreate("other", () => ({
      mode: "read-only",
      browser: new Promise<string>((_resolve, reject) => { otherReject = reject; }),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {
        otherCancellations += 1;
        otherReject(new DOMException("other turn cancelled", "AbortError"));
      },
    }), { threadId: "thread-b", turnId: "turn-other", purpose: "response" });

    expect(sameTurnRetry).toBe(old);
    expect(await sessions.retireSupersededThreadTurns("thread-a", "turn-new", "new")).toBe(1);
    expect(oldCancellations).toBe(1);
    expect(otherCancellations).toBe(0);
    expect((await old.browserOutcome).type).toBe("error");
    expect(otherThread.isActive()).toBe(true);
    sessions.clear();
  });

  test("retires a failed session so the next native retry starts a new browser turn", async () => {
    const sessions = new ChatGptTurnSessions();
    let starts = 0;
    let cancellations = 0;
    const runtime = () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.reject(new Error("retryable upstream failure")),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => { cancellations += 1; },
      };
    };
    const failed = sessions.getOrCreate("retryable", runtime);
    await failed.browserOutcome;

    expect(sessions.retire("retryable", failed)).toBe(true);
    expect(sessions.retire("retryable", failed)).toBe(false);
    const retried = sessions.getOrCreate("retryable", runtime);

    expect(retried).not.toBe(failed);
    expect(starts).toBe(2);
    expect(cancellations).toBe(1);
    sessions.clear();
  });

  test("does not open a fresh Temporary Chat to retry a product usage limit", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-rate-limit-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-rate-limit-retry-test",
      lcaCodex: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      throw new LcaCodexAdapterError("ChatGPT rate limit: wait before retrying", {
        status: 429,
        errorType: "rate_limit_error",
        code: "rate_limit_exceeded",
        retryable: true,
      });
    };

    try {
      const request = rawWireRequest(environmentXml);
      const firstEvents: AdapterEvent[] = [];
      await createLcaCodexAdapter(provider).runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
      expect(firstEvents.at(-1)).toMatchObject({
        type: "error",
        status: 429,
        code: "rate_limit_exceeded",
        retryable: true,
      });

      const replayEvents: AdapterEvent[] = [];
      await createLcaCodexAdapter(provider).runTurn!(request, { headers: new Headers() }, event => replayEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(replayEvents.at(-1)).toMatchObject({
        type: "error",
        status: 429,
        code: "rate_limit_exceeded",
        retryable: true,
      });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close().catch(() => {});
    }
  });

  test("does not start a fresh native retry after final-answer text has already streamed", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-partial-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-partial-retry-test",
      lcaCodex: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      turn.onTextDelta("partial answer already visible");
      throw new LcaCodexAdapterError("transient upstream failure after partial output", {
        status: 503,
        errorType: "server_error",
        code: "upstream_server_error",
        retryable: true,
      });
    };

    try {
      const request = rawWireRequest(environmentXml);
      const firstEvents: AdapterEvent[] = [];
      await createLcaCodexAdapter(provider).runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));

      expect(firstEvents.some(event => (
        event.type === "text_delta"
        && event.phase === "final_answer"
        && event.text === "partial answer already visible"
      ))).toBe(true);
      expect(firstEvents.at(-1)).toMatchObject({
        type: "error",
        code: "upstream_server_error",
        retryable: false,
      });

      const replayEvents: AdapterEvent[] = [];
      await createLcaCodexAdapter(provider).runTurn!(request, { headers: new Headers() }, event => replayEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(replayEvents.some(event => event.type === "text_delta" && event.phase === "final_answer")).toBe(false);
      expect(replayEvents.at(-1)).toMatchObject({
        type: "error",
        code: "upstream_server_error",
        retryable: false,
      });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close().catch(() => {});
    }
  });

  test("waits for one shared browser retirement before starting the compacted continuation", async () => {
    const sessions = new ChatGptTurnSessions();
    let finishBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolveBrowser => { finishBrowser = resolveBrowser; });
    let cancellations = 0;
    const original = sessions.getOrCreate("replace", () => ({
      mode: "read-only",
      browser,
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancellations += 1; },
    }));

    const firstRetirement = sessions.retireAndWait("replace");
    const duplicateRetirement = sessions.retireAndWait("replace");
    let replacementStarts = 0;
    const replacement = sessions.waitForRetirement("replace").then(() => sessions.getOrCreate("replace", () => {
      replacementStarts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("continued"),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => {},
      };
    }));

    expect(cancellations).toBe(1);
    expect(replacementStarts).toBe(0);
    finishBrowser("stopped");
    expect(await Promise.all([firstRetirement, duplicateRetirement])).toEqual([true, true]);
    expect(await original.browserOutcome).toEqual({ type: "final", answer: "stopped" });
    expect(await replacement).not.toBe(original);
    expect(replacementStarts).toBe(1);
    sessions.clear();
  });

  test("keeps inline images out of the context JSON and prepares native browser attachments", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = parsed();
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect this image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileLcaCodexPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    expect(compiled.text).not.toContain(imageUrl);
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.text).toContain('"version":3');
    const files = chatGptImageFilePayloads(compiled.images);
    expect(files[0]?.name).toBe("codex-input-image-1.png");
    expect(files[0]?.mimeType).toBe("image/png");
    expect(files[0]?.buffer.length).toBeGreaterThan(0);
  });

  test("keeps only the newest complete Codex model-switch contract", () => {
    const history = [
      { role: "developer" as const, content: "<model_switch>old contract</model_switch>", timestamp: 1 },
      { role: "developer" as const, content: "<skills_instructions>old catalog</skills_instructions>", timestamp: 2 },
      { role: "user" as const, content: "historical user message", timestamp: 3 },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "historical answer" }], model: "gpt-5.6-sol", timestamp: 4 },
      { role: "developer" as const, content: "unrelated developer instruction", timestamp: 5 },
      { role: "developer" as const, content: "<model_switch>current contract</model_switch>", timestamp: 6 },
      { role: "developer" as const, content: "<skills_instructions>current catalog</skills_instructions>", timestamp: 7 },
      { role: "user" as const, content: "current request", timestamp: 8 },
    ];

    const normalized = withoutSupersededModelSwitchContracts(history);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("old contract");
    expect(serialized).not.toContain("old catalog");
    expect(serialized).toContain("historical user message");
    expect(serialized).toContain("historical answer");
    expect(serialized).toContain("unrelated developer instruction");
    expect(serialized).toContain("current contract");
    expect(serialized).toContain("current catalog");
    expect(serialized).toContain("current request");
  });

  test("keeps a large tool-capable context out of composer text and uploads only referenced images", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = parsed();
    const largeHistory = "d".repeat(70_000);
    request.context.systemPrompt = ["keep this active rule"];
    request.context.messages = [
      { role: "user", content: "historical request", timestamp: 1 },
      { role: "toolResult", toolCallId: "call_history", toolName: "exec_command", content: largeHistory, isError: false, timestamp: 2 },
      { role: "user", content: [
        { type: "text", text: "Inspect the attached current image" },
        { type: "image", imageUrl, detail: "high" },
      ], timestamp: 3 },
    ];
    const snapshot = compileChatGptContextSnapshot(request);
    const compiled = compileLcaCodexPrompt(request, toolCapabilities, "turn_123456789012345678901234", snapshot);
    const files = chatGptPromptFilePayloads(compiled);

    expect(compiled.transport).toBe("mcp-lazy");
    expect(compiled.text).not.toContain(largeHistory);
    expect(compiled.text).toContain("Inspect the attached current image");
    expect(compiled.text).toContain("<codex_context_ref>");
    expect(compiled.text).toContain('"history_ref":"history-1"');
    expect(compiled.text).toContain('"truncated":true');
    expect(compiled.text.length).toBeLessThan(45_000);
    expect(snapshot.serialized).toContain(largeHistory);
    expect(files.map(file => file.name)).toEqual(["codex-input-image-1.png"]);
    expect(files[0]!.mimeType).toBe("image/png");
  });

  test("maps one LCA Codex model to explicit effort modes and fails closed on invalid combinations", () => {
    expect(resolveLcaCodexModelMode(LCA_CODEX_MODEL_ID, "max", toolCapabilities)).toEqual({
      modelId: LCA_CODEX_MODEL_ID,
      effort: "max",
      displayLabel: "Pro",
      uiEffortIndex: 4,
      localTools: true,
    });
    expect(resolveLcaCodexModelMode(LCA_CODEX_MODEL_ID, "xhigh", toolCapabilities)).toMatchObject({
      uiEffortIndex: 3,
      localTools: true,
    });
    expect(() => resolveLcaCodexModelMode(LCA_CODEX_MODEL_ID, "max", {
      localToolsEnabled: false,
      proAvailable: false,
    })).toThrow("Pro effort is not available");
    expect(() => resolveLcaCodexModelMode(LCA_CODEX_MODEL_ID, "xhigh", {
      localToolsEnabled: true,
      proAvailable: false,
    })).toThrow("Extra High effort is not available");
    expect(() => resolveLcaCodexModelMode("unknown", "high", toolCapabilities)).toThrow("model is not supported");
  });

  test("keeps an explicit connector-disabled Pro turn read-only", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = proRequest();
    request.context.systemPrompt = ["system-rule", "repo-rule"];
    request.context.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Synthesize the prepared evidence" },
          { type: "image", imageUrl, detail: "high" },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_prior",
        toolName: "exec_command",
        content: JSON.stringify({ output: "prepared workspace evidence", exit_code: 0 }),
        isError: false,
        timestamp: 2,
      },
    ];

    const compiled = compileLcaCodexPrompt(request, readOnlyCapabilities);
    expect(compiled.text).toContain("LCA Codex Pro with no lca-codex bridge to the user's local computer");
    expect(compiled.text).toContain("web search, browsing, research");
    expect(compiled.text).toContain("prepared workspace evidence");
    expect(compiled.text).toContain('"system":["system-rule","repo-rule"]');
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.images).toHaveLength(1);
    expect(compiled.text).not.toContain("codex_bind_turn");
    expect(compiled.text).not.toContain("turn_token");
    expect(compiled.text).not.toContain("Use the attached lca-codex plugin");
    expect(() => compileLcaCodexPrompt(request, readOnlyCapabilities, "turn_forbidden")).toThrow("must not receive");

    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("running in ChatGPT mode");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("Workspace information already supplied by Codex");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("configure MCP in the LCA Codex launcher");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("web search remain available");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).not.toContain("local tool results");
    request.context.messages = [{ role: "user", content: "No preparation yet", timestamp: 3 }];
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("Codex has not supplied workspace contents");
    request.context.messages = [{
      role: "user",
      content: `${SUMMARY_PREFIX}\n\nWorkspace files and tests were inspected before compaction.`,
      timestamp: 4,
    }];
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("Workspace information already supplied by Codex");
    expect(chatGptReadOnlyContextWarning(proRequest(), toolCapabilities)).toBeUndefined();
    expect(chatGptReadOnlyContextWarning(parsed(), toolCapabilities)).toBeUndefined();
    expect(() => compileLcaCodexPrompt(parsed(), toolCapabilities)).toThrow("requires a broker turn token");

    const lazyPro = compileLcaCodexPrompt(
      proRequest(),
      toolCapabilities,
      "turn_12345678901234567890123456789012",
    );
    expect(lazyPro.transport).toBe("mcp-lazy");
    expect(lazyPro.text).toContain("codex_bind_turn");
    expect(lazyPro.text).not.toContain("LCA Codex Pro with no lca-codex bridge");
  });

  test("reports conservative nonzero native Codex context usage", () => {
    const textRequest = parsed();
    const textUsage = estimateLcaCodexUsage(textRequest, { answer: "done" }, toolCapabilities);
    expect(textUsage).toMatchObject({ estimated: true });
    expect(textUsage.inputTokens).toBeGreaterThan(0);
    expect(textUsage.outputTokens).toBeGreaterThan(0);
    expect(textUsage.totalTokens).toBe(textUsage.inputTokens + textUsage.outputTokens);

    const imageRequest = parsed();
    imageRequest.context.messages[0]!.content = [
      { type: "text", text: "Inspect this image" },
      { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==", detail: "high" },
    ];
    const imageUsage = estimateLcaCodexUsage(imageRequest, { answer: "done" }, toolCapabilities);
    expect(imageUsage.inputTokens).toBeGreaterThan(textUsage.inputTokens);
  });

  test("keeps the ChatGPT rate-limit dialog distinct from model capacity and UI failures", () => {
    const rateLimit = buildResponseJSON([{
      type: "error",
      message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
      status: 429,
      errorType: "rate_limit_error",
      code: "rate_limit_exceeded",
      retryable: true,
    }], LCA_CODEX_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string };
    };
    expect(rateLimit).toMatchObject({
      status: "failed",
      retryable: true,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });

    const missingEffort = buildResponseJSON([{
      type: "error",
      message: "ChatGPT effort menu did not expose item index 1; item count: 0",
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: false,
    }], LCA_CODEX_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string };
    };
    expect(missingEffort).toMatchObject({
      status: "failed",
      retryable: false,
      error: { type: "server_error", code: "upstream_server_error" },
    });
    expect(missingEffort.error.code).not.toBe("server_is_overloaded");

    const contextWindow = buildResponseJSON([{
      type: "error",
      message: "This task exceeds the 225,000-token context window. Switch models, run /compact, then retry.",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    }], LCA_CODEX_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string; message: string };
    };
    expect(contextWindow).toMatchObject({
      status: "failed",
      retryable: false,
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    expect(contextWindow.error.message).toContain("/compact");
  });

  test("returns one native compaction item with preserved estimated usage", () => {
    const request = parsed();
    const summary = "Completed the tool loop; continue with the deployment check.";
    const usage = estimateLcaCodexUsage(request, { answer: summary }, toolCapabilities);
    const response = buildResponseJSON([
      { type: "text_delta", text: "Completed the tool loop; ", phase: "final_answer" },
      { type: "text_delta", text: "continue with the deployment check.", phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true, usage },
    ], "gpt-5.6-sol", { compaction: true }) as {
      output: Array<{ type: string; encrypted_content?: string }>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };

    expect(response.output).toHaveLength(1);
    expect(response.output[0]?.type).toBe("compaction");
    expect(decodeCompactionSummary(response.output[0]?.encrypted_content ?? "")).toBe(summary);
    expect(response.usage.input_tokens).toBe(usage.inputTokens);
    expect(response.usage.output_tokens).toBe(usage.outputTokens);
    expect(response.usage.total_tokens).toBe(usage.totalTokens!);
  });

  test("turn cancellation interrupts an in-flight browser stage instead of waiting for its timeout", async () => {
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt",
      lcaCodex: { localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
      runStage<T>(
        traceId: string,
        stage: string,
        timeoutMs: number,
        action: (signal: AbortSignal) => Promise<T>,
        turnAbortSignal?: AbortSignal,
      ): Promise<T>;
    };
    const turnAbort = new AbortController();
    let stageAborted = false;
    const pending = worker.runStage(
      "trace_abort_stage",
      "test_stage",
      60_000,
      stageSignal => new Promise<string>((_resolve, reject) => {
        stageSignal.addEventListener("abort", () => {
          stageAborted = true;
          reject(new DOMException("stage aborted", "AbortError"));
        }, { once: true });
      }),
      turnAbort.signal,
    );

    turnAbort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(stageAborted).toBe(true);
  });

  test("preserves GFM formatting while streaming only completed stable DOM blocks", () => {
    const heading = '<h2 data-start="0" data-end="15">Format Probe</h2>';
    const bold = '<p data-start="16" data-end="24"><strong>bold</strong></p>';
    const alpha = '<ul><li><p>alpha</p></li></ul>';
    const beta = '<ul><li><p>beta</p></li></ul>';
    const list = '<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>';
    const html = `${heading}${bold}${list}`;
    expect(chatGptHtmlToMarkdown(html)).toBe("## Format Probe\n\n**bold**\n\n- alpha\n- beta");

    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    const first = [
      { key: "heading", html: heading, text: "Format Probe", streamable: true },
      { key: "bold", html: bold, text: "bold", streamable: false },
    ];
    expect(buffer.observe(first, 0)).toBe("");
    expect(buffer.observe(first, 100)).toBe("## Format Probe");

    const expanded = [
      { key: "heading", html: heading, text: "Format Probe", streamable: true },
      { key: "bold", html: bold, text: "bold", streamable: true },
      { key: "alpha", html: alpha, text: "alpha", group: "list", streamable: true },
      { key: "beta", html: beta, text: "beta", group: "list", streamable: false },
    ];
    expect(buffer.observe(expanded, 150)).toBe("");
    expect(buffer.observe(expanded, 250)).toBe("\n\n**bold**\n\n- alpha");
    expect(buffer.finish()).toEqual({
      delta: "\n- beta",
      markdown: "## Format Probe\n\n**bold**\n\n- alpha\n- beta",
    });
  });

  test("serializes wrapped ChatGPT code blocks without leaking controls or escaping code", () => {
    const markdown = chatGptHtmlToMarkdown([
      '<p><strong>Fix</strong> <code>handleRemoteDeparture()</code> first.</p>',
      '<pre><div class="code-block"><div class="code-header"><span>TypeScript</span><button>Copy</button></div><div class="code-body"><code class="whitespace-pre language-typescript"><span>this.lastRemoteEndedAt = Date.now();</span>\n<span>this.lastRemoteEndReason = "peer_left";</span></code></div></div></pre>',
      '<ol><li><p>Keep <strong>bold</strong> and <code>inline_code</code> intact.</p></li></ol>',
    ].join(""));

    expect(markdown).toBe([
      '**Fix** `handleRemoteDeparture()` first.',
      '',
      '```typescript',
      'this.lastRemoteEndedAt = Date.now();',
      'this.lastRemoteEndReason = "peer_left";',
      '```',
      '',
      '1. Keep **bold** and `inline_code` intact.',
    ].join("\n"));
    expect(markdown).not.toContain("TypeScript\n\n```typescript");
    expect(markdown).not.toContain("Copy");
    expect(markdown).not.toContain("\\=");
    expect(markdown).not.toContain("peer\\_left");
    expect(markdown).not.toContain("\\*\\*");
  });

  test("serializes current ChatGPT CodeMirror code blocks as literal fenced source", () => {
    const markdown = chatGptHtmlToMarkdown([
      '<p><strong>Before</strong> <code>inline_code</code>.</p>',
      '<pre class="overflow-visible! px-0!">',
      '<div class="relative w-full">',
      '<div class="code-header"><div>TypeScript</div><button aria-label="Copy"></button></div>',
      '<div class="cm-editor"><div class="cm-scroller">',
      '<div class="cm-content" role="textbox" aria-multiline="true" aria-readonly="true" aria-label="Edit code" data-language="typescript">',
      '<div class="cm-line"><span>const</span> peer_left = false;</div>',
      '<div class="cm-line">const foo_bar = "hello_world";</div>',
      '<div class="cm-line"><br></div>',
      '<div class="cm-line"><span>if</span> (peer_left === false) {</div>',
      '<div class="cm-line">  console.log("**not bold**", foo_bar);</div>',
      '<div class="cm-line">}</div>',
      '</div>',
      '</div></div>',
      '</div>',
      '</pre>',
      '<p>After <code>peer_left = true</code>.</p>',
    ].join(""));

    expect(markdown).toBe([
      '**Before** `inline_code`.',
      '',
      '```typescript',
      'const peer_left = false;',
      'const foo_bar = "hello_world";',
      '',
      'if (peer_left === false) {',
      '  console.log("**not bold**", foo_bar);',
      '}',
      '```',
      '',
      'After `peer_left = true`.',
    ].join("\n"));
    expect(markdown).not.toContain("Copy");
    expect(markdown).not.toContain("TypeScript\n\n");
    expect(markdown).not.toContain("peer\\_left");
    expect(markdown).not.toContain("\\=");
  });

  test("serializes ChatGPT div block code without escaping literal source", () => {
    const markdown = chatGptHtmlToMarkdown([
      '<p><strong>Before</strong> <code>inline_code</code>.</p>',
      '<div class="contain-inline-size">',
      '<div class="code-header"><span>TypeScript</span><button>Copy</button></div>',
      '<div class="overflow-y-auto p-4"><code class="whitespace-pre language-typescript">',
      'const peer_left = false;\n',
      'const foo_bar = "hello_world";\n',
      'if (peer_left === false) {\n  console.log(foo_bar);\n}\n',
      'const markdown = `**not bold**\n_peer_left_\n1. not a markdown list`;',
      '</code></div>',
      '</div>',
      '<p>After <code>peer_left = true</code>.</p>',
    ].join(""));

    expect(markdown).toBe([
      '**Before** `inline_code`.',
      '',
      '```typescript',
      'const peer_left = false;',
      'const foo_bar = "hello_world";',
      'if (peer_left === false) {',
      '  console.log(foo_bar);',
      '}',
      'const markdown = `**not bold**',
      '_peer_left_',
      '1. not a markdown list`;',
      '```',
      '',
      'After `peer_left = true`.',
    ].join("\n"));
    expect(markdown).not.toContain("Copy");
    expect(markdown).not.toContain("peer\\_left");
    expect(markdown).not.toContain("\\=");
  });

  test("serializes standalone block-like code but keeps ordinary code inline", () => {
    const standalone = chatGptHtmlToMarkdown(
      '<code class="whitespace-pre language-typescript">const peer_left = true;\nconst x = a === b;</code>',
    );
    expect(standalone).toBe([
      '```typescript',
      'const peer_left = true;',
      'const x = a === b;',
      '```',
    ].join("\n"));

    expect(chatGptHtmlToMarkdown('<p>Inline <code>peer_left = true</code> stays inline.</p>'))
      .toBe('Inline `peer_left = true` stays inline.');
  });

  test("buffers citation hydration, tolerates later markup-only rewrites, and rejects text rewrites", () => {
    const plain = "<p>Source</p>";
    const linked = '<p><a href="https://example.com">Source</a></p>';
    const hydrated = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    expect(hydrated.observe([
      { key: "source", html: plain, text: "Source", streamable: true },
    ], 0)).toBe("");
    expect(hydrated.observe([
      { key: "source", html: linked, text: "Source", streamable: true },
    ], 50)).toBe("");
    expect(hydrated.observe([
      { key: "source", html: linked, text: "Source", streamable: true },
    ], 150)).toBe("[Source](https://example.com)");
    expect(hydrated.observe([
      { key: "source", html: `${linked}<button>Copy</button>`, text: "Source", streamable: true },
    ], 200)).toBe("");

    const rewritten = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    const source = [{ key: "source", html: plain, text: "Source", streamable: true }];
    expect(rewritten.observe(source, 0)).toBe("");
    expect(rewritten.observe(source, 100)).toBe("Source");
    expect(() => rewritten.observe([
      { key: "source", html: "<p>Different</p>", text: "Different", streamable: true },
    ], 200)).toThrow("completed text block");
  });

  test("defers mutable connector Markdown until completion so replaced blocks are never retracted", () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    const preliminary = [
      { key: "0:0:p", html: "<p>I’ll inspect it.</p>", text: "I’ll inspect it.", streamable: true },
      { key: "0:1:p", html: "<p>Running tool…</p>", text: "Running tool…", streamable: false },
    ];
    expect(buffer.observe(preliminary, 0, false)).toBe("");
    expect(buffer.observe(preliminary, 5_000, false)).toBe("");

    const final = [
      { key: "0:0:p", html: "<p>Tool finished successfully.</p>", text: "Tool finished successfully.", streamable: false },
    ];
    expect(buffer.observe(final, 6_000, false)).toBe("");
    expect(buffer.finish()).toEqual({
      delta: "Tool finished successfully.",
      markdown: "Tool finished successfully.",
    });
  });

  test("drops decorative HTML images without removing textual links", () => {
    const markdown = chatGptHtmlToMarkdown([
      '<p>Source card: <a href="https://github.com/example/repo"><img alt="GitHub" src="data:image/png;base64,AAAA"></a></p>',
      '<p><a href="https://github.com/example/repo">Open repository</a></p>',
    ].join(""));
    expect(markdown).not.toContain("![");
    expect(markdown).not.toContain("data:image");
    expect(markdown).toContain("[Open repository](https://github.com/example/repo)");
  });

  test("replays the complete outer Codex context, including prior reasoning and tool evidence", () => {
    const request = parsed();
    request.context.systemPrompt = ["system-rule", "repo-rule"];
    request.context.messages = [
      { role: "developer", content: "developer-rule", timestamp: 1 },
      { role: "user", content: "first request", timestamp: 2 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspected files" },
          { type: "toolCall", id: "call_prior", name: "exec_command", arguments: { cmd: "pwd" } },
        ],
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call_prior",
        toolName: "exec_command",
        content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      },
      { role: "user", content: "continue", timestamp: 5 },
    ];
    const snapshot = compileChatGptContextSnapshot(request);
    const compiled = compileLcaCodexPrompt(request, toolCapabilities, "turn_123456789012345678901234", snapshot);
    expect(compiled.transport).toBe("mcp-lazy");
    expect(compiled.text).toContain("first request");
    expect(compiled.text).toContain("Inspected files");
    expect(compiled.text).toContain("call_prior");
    expect(compiled.text).toContain("continue");
    const envelope = JSON.parse(snapshot.serialized) as { version: number; system: string[]; messages: Array<Record<string, unknown>> };
    expect(envelope.version).toBe(5);
    expect(envelope.system).toEqual(["system-rule", "repo-rule"]);
    expect(envelope.messages.map(message => message.role)).toEqual(["developer", "user", "assistant", "tool_result", "user"]);
    expect(envelope.messages[2]?.content).toEqual([
      { type: "thinking_summary", text: "Inspected files" },
      { type: "tool_call", id: "call_prior", name: "exec_command", arguments: { cmd: "pwd" } },
    ]);
    expect(envelope.messages[3]).toMatchObject({
      tool_call_id: "call_prior",
      tool_name: "exec_command",
      content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
    });
  });

  test("rejects remote image fetches instead of creating an implicit browser-side fallback", () => {
    expect(() => chatGptImageFilePayloads([{
      ref: "codex-input-image-1",
      imageUrl: "https://example.com/image.png",
    }])).toThrow("inline base64 data URL");
  });

  test("holds an MCP invocation until the outer Codex result arrives", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const environment = extractChatGptTurnEnvironment(parsed(environmentXml));
    const token = await broker.register(environment, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } });
    expect(() => broker.completeTool(token, "unknown", toolResult({ output: "no" }))).toThrow("not pending");
    broker.completeTool(token, request!.callId, toolResult({ output: tempRoot }));
    expect(await invocation).toEqual(toolResult({ output: tempRoot }));
    await broker.close();
  });

  test("makes capability claim retries idempotent until the turn is revoked", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-claim-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const first = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const retry = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(retry.bindingId).toBe(first.bindingId);
    await broker.close();
  });

  test("batches parallel ChatGPT MCP calls into one native Responses round", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-parallel-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invoke = (cmd: string) => callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd },
    }, 10_000);
    const first = invoke("pwd");
    const second = invoke("git status --short");
    const batch = await broker.nextToolBatch(token);
    expect(batch.map(request => request.arguments?.cmd).sort()).toEqual(["git status --short", "pwd"]);
    for (const request of batch) broker.completeTool(token, request.callId, toolResult({ output: request.arguments?.cmd }));
    await Promise.all([first, second]);
    await broker.close();
  });

  test("revoking a turn rejects pending invocations and invalidates its binding", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-revoke-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "sleep 30" },
    }, 10_000);
    await broker.nextToolBatch(token);
    broker.revoke(token);
    await expect(invocation).rejects.toThrow("revoked");
    await expect(callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId }))
      .rejects.toThrow("has already finished");
    await broker.close();
  });

  test("a new Codex turn retires a stopped previous tool loop on the same thread", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-new-turn-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt",
      lcaCodex: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let firstBrowserStopped = false;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled prompt");
        if (browserStarts === 1) {
          const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
          try {
            await callTurnBroker<BrokerToolResult>(socketPath, {
              method: "invoke",
              bindingId: claimed.bindingId,
              wireName: "exec_command",
              freeform: false,
              arguments: { cmd: "pwd", workdir: tempRoot },
            }, 30_000);
            throw new Error("stopped first turn unexpectedly received a tool result");
          } catch (error) {
            firstBrowserStopped = turn.abortSignal?.aborted === true
              && error instanceof Error
              && error.message.includes("revoked");
            throw error;
          }
        }
        const answer = "new turn completed";
        turn.onTextDelta(answer);
        return answer;
      } finally {
        prepared.release();
      }
    };

    const adapter = createLcaCodexAdapter(provider);
    const firstRequest = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(firstRequest, { headers: new Headers() }, event => firstEvents.push(event));
      expect(firstEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });

      const secondRequest = rawWireRequest(environmentXml);
      const raw = secondRequest._rawBody as {
        client_metadata: Record<string, unknown>;
        input: Array<Record<string, unknown>>;
      };
      const secondTurnId = "turn_test_456";
      raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
        thread_id: "thread_test_123",
        turn_id: secondTurnId,
      });
      for (const item of raw.input) {
        const metadata = item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
        if (metadata) metadata.turn_id = secondTurnId;
      }
      const activeUser = raw.input.at(-1)!;
      activeUser.content = [{ type: "input_text", text: "Start a fresh request after Stop" }];
      secondRequest.context.messages = [{ role: "user", content: "Start a fresh request after Stop", timestamp: 3 }];

      const secondEvents: AdapterEvent[] = [];
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => secondEvents.push(event));

      expect(firstBrowserStopped).toBe(true);
      expect(browserStarts).toBe(2);
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(secondEvents.some(event => event.type === "text_delta" && event.text === "new turn completed")).toBe(true);
    } finally {
      (worker as unknown as { run: typeof worker.run }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close().catch(() => {});
    }
  });

  test("replaces the active browser response after Codex compacts mid-tool-loop", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-adapter-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt",
      lcaCodex: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let originalTurnToken = "";
    let continuationTurnToken = "";
    let originalBrowserStopped = false;
    let originalBrowserReceivedToolResult = false;
    let compactionPrompt = "";
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        if (prepared.text.includes("history-compaction checkpoint")) {
          compactionPrompt = prepared.text;
          const compactSummary = "The project was inspected and the pending command completed.";
          turn.onTextDelta(compactSummary);
          return compactSummary;
        }
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled prompt");
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        if (prepared.text.includes("The project was inspected and the pending command completed.")) {
          continuationTurnToken = token;
          turn.onReasoningSummary?.("Resumed from the compacted Codex history");
          const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
            method: "invoke",
            bindingId: claimed.bindingId,
            wireName: "exec_command",
            freeform: false,
            arguments: { cmd: "git status --short", workdir: tempRoot },
          }, 30_000);
          turn.onReasoningSummary?.("Verified the continued task");
          const answer = `## Browser final\n\nStatus: ${(nativeResult.structuredContent as { output: string }).output}`;
          turn.onTextDelta("## Browser final");
          turn.onTextDelta(`\n\nStatus: ${(nativeResult.structuredContent as { output: string }).output}`);
          return answer;
        }

        originalTurnToken = token;
        turn.onReasoningSummary?.("Mapped the repository surface");
        turn.onReasoningSummary?.("Inspected the working directory");
        try {
          const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
            method: "invoke",
            bindingId: claimed.bindingId,
            wireName: "exec_command",
            freeform: false,
            arguments: { cmd: "pwd", workdir: tempRoot },
          }, 30_000);
          originalBrowserReceivedToolResult = true;
          return `stale browser continued with ${(nativeResult.structuredContent as { output: string }).output}`;
        } catch (error) {
          originalBrowserStopped = turn.abortSignal?.aborted === true
            && error instanceof Error
            && error.message.includes("revoked");
          throw error;
        }
      } finally {
        prepared.release();
      }
    };

    const adapter = createLcaCodexAdapter(provider);
    const firstRequest = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(firstRequest, { headers: new Headers() }, event => firstEvents.push(event));
      const callStart = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
      expect(callStart?.name).toBe("exec_command");
      expect(firstEvents.filter(event => event.type === "assistant_boundary")).toHaveLength(2);
      expect(firstEvents.filter(event => event.type === "thinking_delta")).toEqual([
        { type: "thinking_delta", thinking: "Mapped the repository surface" },
        { type: "thinking_delta", thinking: "Inspected the working directory" },
      ]);
      const firstDone = firstEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(firstDone).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      expect(firstDone.usage?.estimated).toBe(true);
      expect(Number.isFinite(firstDone.usage?.inputTokens)).toBe(true);
      expect(Number.isFinite(firstDone.usage?.outputTokens)).toBe(true);
      const firstResponse = buildResponseJSON(firstEvents, "gpt-5.6-sol") as { output: Array<Record<string, unknown>>; usage: { total_tokens: number } };
      expect(firstResponse.usage.total_tokens).toBeGreaterThan(0);
      expect(firstResponse.output.map(item => item.type)).toEqual(["reasoning", "reasoning", "function_call"]);
      expect(firstResponse.output[2]).toMatchObject({
        type: "function_call",
        call_id: callStart!.id,
        name: "exec_command",
        status: "completed",
      });

      const compactRequest = rawWireRequest(environmentXml);
      compactRequest._compactionRequest = true;
      const toolCall = {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: callStart!.id, name: "exec_command", arguments: { cmd: "pwd", workdir: tempRoot } }],
        timestamp: 3,
      };
      const result = {
        role: "toolResult" as const,
        toolCallId: callStart!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      };
      compactRequest.context.messages.push(toolCall, result);
      ((compactRequest._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: callStart!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "pwd", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: callStart!.id,
          output: result.content,
        },
      );
      const compactEvents: AdapterEvent[] = [];
      await adapter.runTurn!(compactRequest, { headers: new Headers() }, event => compactEvents.push(event));
      expect(compactEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(originalBrowserStopped).toBe(true);
      expect(originalBrowserReceivedToolResult).toBe(false);
      expect(compactionPrompt).toContain('"transport":"mcp-lazy"');
      expect(compactionPrompt).toContain("Use codex_context as a read-only lazy transport for the frozen snapshot");
      expect(compactionPrompt).toContain('"recent_inline":0');
      expect(compactionPrompt).toContain('"recent_exchanges":0');
      expect(compactionPrompt).not.toContain(`"tool_call_id":"${callStart!.id}"`);
      expect(compactionPrompt).not.toContain("<codex_context_json>");

      const secondRequest = rawWireRequest(environmentXml);
      secondRequest.context.messages.push({
        role: "user",
        content: `${SUMMARY_PREFIX}\nThe project was inspected and the pending command completed.`,
        timestamp: 5,
      });
      ((secondRequest._rawBody as { input: unknown[] }).input).push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nThe project was inspected and the pending command completed.` }],
      });
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => secondEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(continuationTurnToken).not.toBe(originalTurnToken);
      expect(secondEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Resumed from the compacted Codex history",
      });
      const continuedCall = secondEvents.find(
        (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
      );
      expect(continuedCall?.name).toBe("exec_command");
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });

      const finalRequest = structuredClone(secondRequest);
      const continuedToolCall = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: continuedCall!.id,
          name: "exec_command",
          arguments: { cmd: "git status --short", workdir: tempRoot },
        }],
        timestamp: 6,
      };
      const continuedResult = {
        role: "toolResult" as const,
        toolCallId: continuedCall!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: "clean", exit_code: 0 }),
        isError: false,
        timestamp: 7,
      };
      finalRequest.context.messages.push(continuedToolCall, continuedResult);
      ((finalRequest._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: continuedCall!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "git status --short", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: continuedCall!.id,
          output: continuedResult.content,
        },
      );
      const finalEvents: AdapterEvent[] = [];
      await adapter.runTurn!(finalRequest, { headers: new Headers() }, event => finalEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(finalEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Verified the continued task",
      });
      expect(finalEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text).join(""))
        .toBe("## Browser final\n\nStatus: clean");
      const finalDone = finalEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(finalDone).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(finalDone.usage?.estimated).toBe(true);
      expect(Number.isFinite(finalDone.usage?.inputTokens)).toBe(true);
      expect(Number.isFinite(finalDone.usage?.outputTokens)).toBe(true);
      expect(finalDone.usage!.inputTokens).toBeGreaterThan(firstDone.usage!.inputTokens);

      const replayEvents: AdapterEvent[] = [];
      await adapter.runTurn!(finalRequest, { headers: new Headers() }, event => replayEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(replayEvents).toEqual(finalEvents);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("runs connector-disabled Pro as one read-only browser turn with native warning, tracing, and exact replay", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-pro-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "lca-codex",
      baseUrl: "browser://chatgpt-pro-test",
      contextWindow: 256_000,
      lcaCodex: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      expect(turn.modelId).toBe(LCA_CODEX_MODEL_ID);
      const prepared = await turn.prepare();
      try {
        expect(prepared.text).toContain("LCA Codex Pro with no lca-codex bridge to the user's local computer");
        expect(prepared.text).toContain("web search, browsing, research");
        expect(prepared.text).not.toContain("turn_token");
        expect(prepared.text).not.toContain("codex_bind_turn");
        turn.onReasoningSummary?.("Reviewed the accumulated");
        turn.onReasoningSummary?.(" task evidence", true);
        turn.onCommentary?.("The prepared context contains enough evidence to continue the analysis.");
        turn.onReasoningSummary?.("Synthesized the read-only conclusion");
        turn.onTextDelta("## Pro result");
        turn.onTextDelta("\n\nPrepared context synthesized.");
        return "## Pro result\n\nPrepared context synthesized.";
      } finally {
        prepared.release();
      }
    };

    const request = proRequest();
    request._rawBody = {
      prompt_cache_key: "thread_pro_read_only",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_pro_read_only",
          turn_id: "turn_pro_read_only",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Synthesize the already prepared context" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_pro_read_only" },
      }],
    };
    request.context.messages.push({
      role: "toolResult",
      toolCallId: "call_prepared",
      toolName: "exec_command",
      content: JSON.stringify({ output: "workspace already inspected", exit_code: 0 }),
      isError: false,
      timestamp: 3,
    });
    const adapter = createLcaCodexAdapter(provider);
    const events: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(1);
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      const commentary = events.filter(
        (event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta" && event.phase === "commentary",
      );
      expect(commentary).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("running in ChatGPT mode"),
          phase: "commentary",
        }),
        {
          type: "text_delta",
          text: "The prepared context contains enough evidence to continue the analysis.",
          phase: "commentary",
        },
      ]);
      expect(events.filter(event => event.type === "thinking_delta")).toEqual([
        { type: "thinking_delta", thinking: "Reviewed the accumulated" },
        { type: "thinking_delta", thinking: " task evidence" },
        { type: "thinking_delta", thinking: "Synthesized the read-only conclusion" },
      ]);
      expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta" && event.phase === "final_answer")
        .map(event => event.text).join(""))
        .toBe("## Pro result\n\nPrepared context synthesized.");
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });

      const response = buildResponseJSON(events, LCA_CODEX_MODEL_ID) as {
        output: Array<{ type: string; phase?: string; content?: Array<{ text?: string }> }>;
      };
      const warning = response.output.find(item => item.type === "message" && item.phase === "commentary");
      expect(warning?.content?.[0]?.text).toContain("running in ChatGPT mode");
      expect(warning?.content?.[0]?.text).toContain("web search remain available");
      expect(warning?.content?.[0]?.text).toContain("configure MCP in the LCA Codex launcher");
      expect(response.output.filter(item => item.type === "message" && item.phase === "commentary")).toHaveLength(2);
      expect(response.output.filter(item => item.type === "reasoning")).toHaveLength(2);

      const replay: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => replay.push(event));
      expect(browserStarts).toBe(1);
      expect(replay).toEqual(events);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("serves the complete outer-native bridge contract over MCP stdio", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = gatewayOnlyEnvironment.tools.filter(tool => (
      tool.name === "exec" || tool.name === "search_openai_docs"
    ));
    const token = await broker.register(gatewayOnlyEnvironment, 60_000);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "lca-codex-bridge-test", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_apply_patch",
        "codex_bind_turn",
        "codex_context",
        "codex_exec",
        "codex_tool_call",
        "codex_tool_inventory",
        "codex_view_image",
        "codex_write_stdin",
      ]);

      const bound = await call("codex_bind_turn", { turn_token: token });
      const bindingId = (bound.structuredContent as { binding_id?: string } | undefined)?.binding_id;
      expect(bindingId).toStartWith("binding_");
      expect((bound.structuredContent as { bridge_protocol_version: number }).bridge_protocol_version).toBe(3);
      expect((bound.structuredContent as { execution: string }).execution).toBe("outer_codex_native");
      expect((bound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((bound.structuredContent as { command_tool: string }).command_tool).toBe("exec_command");

      const completeReadiness = async (availability: Record<string, boolean>) => {
        const [readinessRequest] = await broker.nextToolBatch(token);
        expect(readinessRequest).toMatchObject({ wireName: "exec", freeform: true });
        expect(readinessRequest?.input).toContain("LCA_CODEX_TOOL_HEALTH_ROUTES:");
        broker.completeTool(token, readinessRequest!.callId, gatewayRegistryResult(availability));
        return readinessRequest;
      };

      const inventory = await call("codex_tool_inventory", { binding_id: bindingId, query: "docs" });
      const discovered = (inventory.structuredContent as { tools: Array<{ wire_name: string }> }).tools;
      expect(discovered.map(tool => tool.wire_name)).toEqual(["mcp__openaiDeveloperDocs__search_openai_docs"]);

      const invented = await call("codex_tool_call", {
        binding_id: bindingId,
        wire_name: "mcp__invented__escape_hatch",
        arguments: {},
      });
      expect(invented.isError).toBe(true);
      expect(JSON.stringify(invented.content)).toContain("Codex tool is not available in this turn");

      const execPromise = call("codex_exec", { binding_id: bindingId, cmd: "pwd", workdir: tempRoot });
      await completeReadiness({ exec_command: true });
      const [execRequest] = await broker.nextToolBatch(token);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(execRequest?.input).toContain(`tools["exec_command"](${JSON.stringify({ cmd: "pwd", workdir: tempRoot })})`);
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });

      const patchText = "*** Begin Patch\n*** Add File: test.txt\n+ok\n*** End Patch";
      const patchPromise = call("codex_apply_patch", { binding_id: bindingId, patch: patchText });
      await completeReadiness({ apply_patch: false });
      await completeReadiness({ apply_patch: true });
      const [patchRequest] = await broker.nextToolBatch(token);
      expect(patchRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(patchRequest?.input).toContain(`tools["apply_patch"](${JSON.stringify(patchText)})`);
      broker.completeTool(token, patchRequest!.callId, toolResult({ applied: true }));
      expect((await patchPromise).isError).not.toBe(true);

      const docsPromise = call("codex_tool_call", {
        binding_id: bindingId,
        wire_name: "mcp__openaiDeveloperDocs__search_openai_docs",
        arguments: { query: "Responses API" },
      });
      await completeReadiness({ mcp__openaiDeveloperDocs__search_openai_docs: true });
      const [docsRequest] = await broker.nextToolBatch(token);
      expect(docsRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(docsRequest?.input).toContain('tools["mcp__openaiDeveloperDocs__search_openai_docs"]({"query":"Responses API"})');
      broker.completeTool(token, docsRequest!.callId, toolResult({ hits: 3 }));
      expect((await docsPromise).structuredContent).toEqual({ hits: 3 });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);

  test("serves the outer-native bridge contract over MCP stdio for a turn registered without a turn timeout", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-no-ttl-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = gatewayOnlyEnvironment.tools.filter(tool => (
      tool.name === "exec" || tool.name === "search_openai_docs"
    ));
    const token = await broker.register(gatewayOnlyEnvironment);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "lca-codex-bridge-test", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);

      const bound = await call("codex_bind_turn", { turn_token: token });
      expect(bound.content).toEqual([{ type: "text", text: expect.stringContaining("binding_") }]);
      expect(bound.isError).not.toBe(true);
      const binding = bound.structuredContent as {
        binding_id: string;
        binding_status: string;
        valid_until: string;
        expires_at: string | null;
        next_action: string;
      };
      expect(binding.binding_id).toStartWith("binding_");
      expect(binding.binding_status).toBe("active");
      expect(binding.valid_until).toBe("outer_turn_end");
      expect(binding.expires_at).toBeNull();
      expect(binding.next_action).toContain("Use this binding_id only if you need Codex instruction details, historical context, or a native Codex tool");
      expect(binding.next_action).toContain("Call codex_context selectively");
      expect(binding.next_action).not.toContain("turn_token");

      const confused = await call("codex_exec", { binding_id: token, cmd: "pwd" });
      expect(confused.isError).toBe(true);
      expect(JSON.stringify(confused.content)).toContain("never pass turn_token here");

      const execPromise = call("codex_exec", { binding_id: binding.binding_id, cmd: "pwd", workdir: tempRoot });
      const [readinessRequest] = await Promise.race([
        broker.nextToolBatch(token),
        execPromise.then(response => {
          throw new Error(`codex_exec settled before reaching the broker: ${JSON.stringify(response.content)}`);
        }),
      ]);
      expect(readinessRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(readinessRequest?.input).toContain("LCA_CODEX_TOOL_HEALTH_ROUTES:");
      broker.completeTool(token, readinessRequest!.callId, gatewayRegistryResult({ exec_command: true }));

      const [execRequest] = await broker.nextToolBatch(token);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(execRequest?.input).toContain(`tools["exec_command"](${JSON.stringify({ cmd: "pwd", workdir: tempRoot })})`);
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);
});
