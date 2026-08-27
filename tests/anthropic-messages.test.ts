import { expect, test } from "bun:test";
import { ensureApiToken } from "../src/api-auth";
import { defaultConfig } from "../src/config";
import { anthropicCountTokensRequest, anthropicMessagesRequest } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig } from "../src/types";

function request(
  token: string | undefined,
  body: Record<string, unknown>,
  sessionId = "claude-session-1",
  agentId?: string,
): Request {
  return new Request("http://127.0.0.1:8317/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

function messageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "inspect the project" }],
    ...overrides,
  };
}

test("Anthropic Messages requires the profile API key", async () => {
  ensureApiToken();
  const response = await anthropicMessagesRequest(request(undefined, messageBody()), defaultConfig(), () => ({
    name: "should-not-run",
    async runTurn() { throw new Error("unauthorized adapter invocation"); },
  }));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
});

test("Anthropic Messages normalizes Claude Code messages and tools onto the shared agent core", async () => {
  const { token } = ensureApiToken();
  let capturedConversationId = "";
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-core-test",
    async runTurn(parsed, incoming, emit) {
      expect(incoming.agentRequest?.transport).toBe("anthropic_messages");
      capturedConversationId = incoming.agentRequest?.conversationId ?? "";
      expect(parsed.context.systemPrompt).toContain("Use the repository instructions");
      expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["Read"]);
      emit({ type: "text_delta", text: "Claude Code backend ready", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 7, outputTokens: 4 } });
    },
  });
  const response = await anthropicMessagesRequest(request(token, messageBody({
    system: [{ type: "text", text: "Use the repository instructions", cache_control: { type: "ephemeral" } }],
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    }],
  })), defaultConfig(), factory);

  expect(response.status).toBe(200);
  expect(capturedConversationId).toMatch(/^lca-task-[0-9a-f]{32}$/);
  expect(response.headers.get("x-lca-task-id")).toBe(capturedConversationId);
  const body = await response.json() as any;
  expect(body).toMatchObject({
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 7, output_tokens: 4 },
  });
  expect(body.content).toEqual([{ type: "text", text: "Claude Code backend ready" }]);
});

test("Anthropic title generation cannot displace a main tool continuation in the same session", async () => {
  const { token } = ensureApiToken();
  const executionIds: string[] = [];
  const conversationIds: string[] = [];
  let invocation = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-tool-continuation-test",
    async runTurn(_parsed, incoming, emit) {
      executionIds.push(incoming.agentRequest?.executionId ?? "missing");
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      invocation += 1;
      if (invocation === 1) {
        emit({ type: "tool_call_start", id: "toolu_read_1", name: "Read" });
        emit({ type: "tool_call_delta", arguments: '{"file_path":"README.md"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 4, outputTokens: 2 } });
        return;
      }
      emit({
        type: "text_delta",
        text: invocation === 2 ? "Project inspection" : "README inspected",
        phase: "final_answer",
      });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 8, outputTokens: 2 } });
    },
  });
  const tools = [{ name: "Read", input_schema: { type: "object" } }];

  const first = await anthropicMessagesRequest(request(token, messageBody({ tools })), defaultConfig(), factory);
  expect(first.status).toBe(200);
  const firstBody = await first.json() as any;
  expect(firstBody.stop_reason).toBe("tool_use");
  expect(firstBody.content).toEqual([{
    type: "tool_use",
    id: "toolu_read_1",
    name: "Read",
    input: { file_path: "README.md" },
  }]);

  const auxiliary = await anthropicMessagesRequest(request(token, messageBody({
    messages: [{
      role: "user",
      content: "<session> inspect the project </session> Write the title in the predominant language of the session",
    }],
  })), defaultConfig(), factory);
  expect(auxiliary.status).toBe(200);

  const continuation = await anthropicMessagesRequest(request(token, messageBody({
    tools,
    messages: [
      { role: "user", content: "inspect the project" },
      { role: "assistant", content: firstBody.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "README contents" }] },
    ],
  })), defaultConfig(), factory);
  expect(continuation.status).toBe(200);
  expect(executionIds).toHaveLength(3);
  expect(executionIds[1]).not.toBe(executionIds[0]);
  expect(executionIds[2]).toBe(executionIds[0]);
  expect(new Set(conversationIds).size).toBe(1);
});

test("Anthropic tool_result remains a continuation across trailing Claude Code system reminders", async () => {
  const { token } = ensureApiToken();
  const executionIds: string[] = [];
  let invocation = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-reminder-continuation-test",
    async runTurn(_parsed, incoming, emit) {
      executionIds.push(incoming.agentRequest?.executionId ?? "missing");
      invocation += 1;
      if (invocation === 1) {
        emit({ type: "tool_call_start", id: "toolu_large_read", name: "Read" });
        emit({ type: "tool_call_delta", arguments: '{"file_path":"src/large.ts"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 4, outputTokens: 2 } });
        return;
      }
      emit({ type: "text_delta", text: "continued", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 8, outputTokens: 2 } });
    },
  });
  const tools = [{ name: "Read", input_schema: { type: "object" } }];
  const first = await anthropicMessagesRequest(request(token, messageBody({ tools })), defaultConfig(), factory);
  const firstBody = await first.json() as any;

  const second = await anthropicMessagesRequest(request(token, messageBody({
    tools,
    messages: [
      { role: "user", content: "inspect the project" },
      { role: "assistant", content: firstBody.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_large_read", content: "large file contents" }] },
      { role: "system", content: "The TodoWrite tool hasn't been used recently." },
      { role: "developer", content: "Continue the same tool loop." },
    ],
  })), defaultConfig(), factory);

  expect(second.status).toBe(200);
  expect(executionIds).toHaveLength(2);
  expect(executionIds[1]).toBe(executionIds[0]);
});

test("Anthropic exact request retries keep one execution while a changed transcript starts a new one", async () => {
  const { token } = ensureApiToken();
  const executionIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-request-retry-identity-test",
    async runTurn(_parsed, incoming, emit) {
      executionIds.push(incoming.agentRequest?.executionId ?? "missing");
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });
  const initial = messageBody();

  expect((await anthropicMessagesRequest(request(token, initial), defaultConfig(), factory)).status).toBe(200);
  expect((await anthropicMessagesRequest(request(token, initial), defaultConfig(), factory)).status).toBe(200);
  expect((await anthropicMessagesRequest(request(token, messageBody({
    messages: [
      { role: "user", content: "inspect the project" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "inspect another flow" },
    ],
  })), defaultConfig(), factory)).status).toBe(200);

  expect(executionIds).toHaveLength(3);
  expect(executionIds[1]).toBe(executionIds[0]);
  expect(executionIds[2]).not.toBe(executionIds[0]);
});

test("Claude Code session and subagent ids create stable isolated task identities", async () => {
  const { token } = ensureApiToken();
  const seen = new Map<string, string>();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      seen.set(`${incoming.headers.get("x-claude-code-session-id")}:${incoming.headers.get("x-claude-code-agent-id") ?? "main"}`, incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  for (const [session, agent] of [
    ["session-a", undefined],
    ["session-a", undefined],
    ["session-a", "agent-1"],
    ["session-a", "agent-2"],
    ["session-b", undefined],
  ] as const) {
    const response = await anthropicMessagesRequest(request(token, messageBody(), session, agent), defaultConfig(), factory);
    expect(response.status).toBe(200);
  }

  const mainA = seen.get("session-a:main");
  expect(mainA).toMatch(/^lca-task-/);
  expect(seen.get("session-a:agent-1")).not.toBe(mainA);
  expect(seen.get("session-a:agent-2")).not.toBe(mainA);
  expect(seen.get("session-a:agent-1")).not.toBe(seen.get("session-a:agent-2"));
  expect(seen.get("session-b:main")).not.toBe(mainA);
});

test("Anthropic streaming relays text and tool-use as native Messages SSE", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "anthropic-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "Checking ", phase: "final_answer" });
      emit({ type: "text_delta", text: "README", phase: "final_answer" });
      emit({ type: "tool_call_start", id: "toolu_stream_1", name: "Read" });
      emit({ type: "tool_call_delta", arguments: '{"file_path":"README.md"}' });
      emit({ type: "tool_call_end" });
      emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 5, outputTokens: 3 } });
    },
  });
  const response = await anthropicMessagesRequest(request(token, messageBody({
    stream: true,
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  })), defaultConfig(), factory);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const stream = await response.text();
  expect(stream).toContain("event: message_start");
  expect(stream).toContain('"type":"text_delta","text":"Checking "');
  expect(stream).toContain('"type":"text_delta","text":"README"');
  expect(stream).toContain('"type":"tool_use","id":"toolu_stream_1","name":"Read"');
  expect(stream).toContain('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"README.md\\"}"');
  expect(stream).toContain('"stop_reason":"tool_use"');
  expect(stream).toContain("event: message_stop");
});

test("Anthropic count_tokens works without max_tokens and never invokes the browser adapter", async () => {
  const { token } = ensureApiToken();
  const response = await anthropicCountTokensRequest(new Request("http://127.0.0.1:8317/v1/messages/count_tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      system: "Use the repository instructions",
      messages: [{ role: "user", content: "Count this prompt" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { input_tokens?: number };
  expect(body.input_tokens).toBeNumber();
  expect(body.input_tokens!).toBeGreaterThan(0);
});
