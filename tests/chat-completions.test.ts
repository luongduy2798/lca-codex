import { expect, test } from "bun:test";
import { ensureApiToken } from "../src/api-auth";
import { chatCompletionsRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig } from "../src/types";

function request(token: string | undefined, body: Record<string, unknown>, taskId?: string): Request {
  return new Request("http://127.0.0.1:8317/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(taskId ? { "x-lca-task-id": taskId } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("Chat Completions requires the profile API key", async () => {
  ensureApiToken();
  const response = await chatCompletionsRequest(request(undefined, {
    model: "lca-token",
    messages: [{ role: "user", content: "hello" }],
  }), defaultConfig(), () => ({
    name: "should-not-run",
    async runTurn() { throw new Error("unauthorized adapter invocation"); },
  }));
  expect(response.status).toBe(401);
});

test("Chat Completions converts messages and function tools onto the generic Responses core", async () => {
  const { token } = ensureApiToken();
  let invocation = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-completions-test",
    async runTurn(parsed, incoming, emit) {
      invocation += 1;
      expect(incoming.agentRequest?.transport).toBe("chat_completions");
      expect(parsed.context.messages.some(message => message.role === "user")).toBe(true);
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read_file"]);
      emit({ type: "text_delta", text: "Hello from ChatGPT Web", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 4, outputTokens: 5 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
  }), defaultConfig(), factory);
  expect(response.status).toBe(200);
  expect(invocation).toBe(1);
  const body = await response.json() as any;
  expect(body.object).toBe("chat.completion");
  expect(body.model).toBe("lca-token");
  expect(body.choices[0].message).toEqual({ role: "assistant", content: "Hello from ChatGPT Web" });
  expect(body.choices[0].finish_reason).toBe("stop");
  expect(body.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
});

test("Chat Completions returns OpenAI-style tool calls", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-tool-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "tool_call_start", id: "call_read_1", name: "read_file" });
      emit({ type: "tool_call_delta", arguments: '{"path":"README.md"}' });
      emit({ type: "tool_call_end" });
      emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 3, outputTokens: 2 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [{ role: "user", content: "read the readme" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }), defaultConfig(), factory);
  const body = await response.json() as any;
  expect(body.choices[0].message.content).toBeNull();
  expect(body.choices[0].message.tool_calls).toEqual([{
    id: "call_read_1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"README.md"}' },
  }]);
  expect(body.choices[0].finish_reason).toBe("tool_calls");
});

test("Chat Completions accepts assistant tool-call and tool-result history", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-tool-history-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.messages.some(message => message.role === "toolResult")).toBe(true);
      emit({ type: "text_delta", text: "README summarized", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 6, outputTokens: 2 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      { role: "user", content: "read the readme" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
      { role: "tool", tool_call_id: "call_read_1", content: "README contents" },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }), defaultConfig(), factory);
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.choices[0].message.content).toBe("README summarized");
});

test("Chat Completions structured tool results continue the same in-flight browser execution", async () => {
  const { token } = ensureApiToken();
  const executionIds: string[] = [];
  let invocation = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-tool-continuation-test",
    async runTurn(_parsed, incoming, emit) {
      invocation += 1;
      executionIds.push(incoming.agentRequest?.executionId ?? "missing");
      if (invocation === 1) {
        emit({ type: "tool_call_start", id: "call_live_read_1", name: "read_file" });
        emit({ type: "tool_call_delta", arguments: '{"path":"README.md"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 3, outputTokens: 2 } });
        return;
      }
      emit({ type: "text_delta", text: invocation === 2 ? "README summarized" : "next prompt", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 6, outputTokens: 2 } });
    },
  });
  const tools = [{
    type: "function",
    function: { name: "read_file", parameters: { type: "object" } },
  }];
  const initialMessages = [{ role: "user", content: "read the readme" }];

  const first = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: initialMessages,
    tools,
  }), defaultConfig(), factory);
  expect(first.status).toBe(200);
  const firstBody = await first.json() as any;
  const toolCalls = firstBody.choices[0].message.tool_calls;
  expect(toolCalls?.[0]?.id).toBe("call_live_read_1");

  const secondMessages = [
    ...initialMessages,
    { role: "assistant", content: null, tool_calls: toolCalls },
    { role: "tool", tool_call_id: "call_live_read_1", content: "README contents" },
  ];
  const second = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: secondMessages,
    tools,
  }), defaultConfig(), factory);
  expect(second.status).toBe(200);
  const secondBody = await second.json() as any;
  expect(secondBody.choices[0].message.content).toBe("README summarized");
  expect(executionIds[1]).toBe(executionIds[0]);

  const third = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      ...secondMessages,
      { role: "assistant", content: "README summarized" },
      { role: "user", content: "continue with the next task" },
    ],
    tools,
  }), defaultConfig(), factory);
  expect(third.status).toBe(200);
  expect(executionIds[2]).not.toBe(executionIds[0]);
});

test("Chat Completions repairs Markdown-escaped XML tool tag names for textual tool protocols", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-xml-tool-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({
        type: "text_delta",
        text: "<attempt\\_completion>\n<result>done</result>\n<task\\_progress>- [x] done</task\\_progress>\n</attempt\\_completion>",
        phase: "final_answer",
      });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 3 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      { role: "system", content: "Tool uses are formatted using XML-style tags. Finish with <attempt_completion>." },
      { role: "user", content: "hello" },
    ],
  }), defaultConfig(), factory);
  const body = await response.json() as any;
  expect(body.choices[0].message.content).toBe(
    "<attempt_completion>\n<result>done</result>\n<task_progress>- [x] done</task_progress>\n</attempt_completion>",
  );
});

test("Cline-style textual tool rounds keep stable private task identity metadata", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-conversation-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "<attempt_completion><result>done</result></attempt_completion>", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 2 } });
    },
  });
  const system = "Tool uses are formatted using XML-style tags. Finish with <attempt_completion>.";
  const initial = [{ role: "system", content: system }, { role: "user", content: "inspect this task" }];
  const first = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: initial,
  }), defaultConfig(), factory);
  expect(first.status).toBe(200);

  const second = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      ...initial,
      { role: "assistant", content: "<read_file><path>README.md</path></read_file>" },
      { role: "user", content: "README contents" },
    ],
  }), defaultConfig(), factory);
  expect(second.status).toBe(200);
  expect(conversationIds).toHaveLength(2);
  expect(conversationIds[0]).not.toBe("missing");
  expect(conversationIds[1]).toBe(conversationIds[0]);
});

test("ordinary Chat Completions follow-ups keep stable private task identity metadata", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-conversation-standard-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 1 } });
    },
  });
  const initial = [{ role: "system", content: "Be concise" }, { role: "user", content: "inspect this task" }];
  const first = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: initial,
  }), defaultConfig(), factory);
  expect(first.status).toBe(200);

  const second = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      ...initial,
      { role: "assistant", content: "done" },
      { role: "user", content: "continue" },
    ],
  }), defaultConfig(), factory);
  expect(second.status).toBe(200);
  expect(conversationIds).toHaveLength(2);
  expect(conversationIds[0]).not.toBe("missing");
  expect(conversationIds[1]).toBe(conversationIds[0]);
});

test("the returned Chat Completions task id round-trips without changing task identity", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-returned-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 1 } });
    },
  });
  const initial = [{ role: "system", content: "Be concise" }, { role: "user", content: "inspect this task" }];
  const first = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: initial,
  }), defaultConfig(), factory);
  expect(first.status).toBe(200);
  const taskId = first.headers.get("x-lca-task-id");
  expect(taskId).toMatch(/^lca-task-[0-9a-f]{32}$/);
  if (!taskId) throw new Error("expected Chat Completions task id header");

  const second = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      ...initial,
      { role: "assistant", content: "done" },
      { role: "user", content: "continue" },
    ],
  }, taskId), defaultConfig(), factory);
  expect(second.status).toBe(200);
  expect(second.headers.get("x-lca-task-id")).toBe(taskId);
  expect(conversationIds).toEqual([taskId, taskId]);
});

test("explicit task ids keep Chat Completions task identity stable across arbitrary harness compaction", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-explicit-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 1 } });
    },
  });

  const first = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      { role: "system", content: "generic harness instructions" },
      { role: "user", content: "large original task history" },
    ],
  }, "harness-task-99"), defaultConfig(), factory);
  expect(first.status).toBe(200);
  const stableTaskId = first.headers.get("x-lca-task-id");
  expect(stableTaskId).toMatch(/^lca-task-[0-9a-f]{32}$/);

  const second = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [
      { role: "system", content: "generic harness instructions" },
      { role: "user", content: "compact checkpoint replacing all prior task messages" },
      { role: "user", content: "continue from that checkpoint" },
    ],
  }, "harness-task-99"), defaultConfig(), factory);
  expect(second.status).toBe(200);
  expect(second.headers.get("x-lca-task-id")).toBe(stableTaskId);

  const third = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    messages: [{ role: "user", content: "separate task" }],
  }, "harness-task-100"), defaultConfig(), factory);
  expect(third.status).toBe(200);

  expect(conversationIds).toHaveLength(3);
  expect(conversationIds[0]).toBe(conversationIds[1]);
  expect(conversationIds[2]).not.toBe(conversationIds[0]);
});

test("Chat Completions accepts metadata.lca_task_id as a transport-neutral task identity extension", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-metadata-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  for (const messages of [
    [{ role: "user", content: "before compact" }],
    [{ role: "user", content: "after compact with rewritten history" }],
  ]) {
    const response = await chatCompletionsRequest(request(token, {
      model: "lca-token",
      metadata: { lca_task_id: "metadata-task-1" },
      messages,
    }), defaultConfig(), factory);
    expect(response.status).toBe(200);
  }

  expect(conversationIds).toHaveLength(2);
  expect(conversationIds[0]).toBe(conversationIds[1]);
});

test("transcript-prefix fallback changes task identity when the append-only task anchor changes", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-conversation-new-task-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });
  const system = "Tool uses are formatted using XML-style tags. Finish with <attempt_completion>.";
  for (const task of ["task A", "task B"]) {
    const response = await chatCompletionsRequest(request(token, {
      model: "lca-token",
      messages: [{ role: "system", content: system }, { role: "user", content: task }],
    }), defaultConfig(), factory);
    expect(response.status).toBe(200);
  }
  expect(conversationIds).toHaveLength(2);
  expect(conversationIds[0]).not.toBe(conversationIds[1]);
});

test("streaming Chat Completions emits chat.completion.chunk text and usage frames", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "hello ", phase: "final_answer" });
      emit({ type: "text_delta", text: "stream", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 2 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hello" }],
  }), defaultConfig(), factory);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = await response.text();
  expect(body).toContain('"object":"chat.completion.chunk"');
  expect(body).toContain('"content":"hello "');
  expect(body).toContain('"content":"stream"');
  expect(body).toContain('"finish_reason":"stop"');
  expect(body).toContain('"prompt_tokens":2');
  expect(body).toContain("data: [DONE]");
  expect(body).not.toContain("response.output_text.delta");
});

test("streaming Chat Completions emits visible reasoning before final content", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-reasoning-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "thinking_delta", thinking: "Inspecting the task" });
      emit({ type: "text_delta", text: "Reading the relevant file", phase: "commentary" });
      emit({ type: "text_delta", text: "Final answer", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 3 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  }), defaultConfig(), factory);
  const body = await response.text();
  const reasoning = body.indexOf('\"reasoning_content\":\"Inspecting the task\"');
  const commentary = body.indexOf('\"reasoning_content\":\"Reading the relevant file\"');
  const final = body.indexOf('\"content\":\"Final answer\"');
  expect(reasoning).toBeGreaterThan(-1);
  expect(commentary).toBeGreaterThan(reasoning);
  expect(final).toBeGreaterThan(commentary);
});

test("streaming Chat Completions emits OpenAI-style tool-call deltas", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-tool-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "tool_call_start", id: "call_stream_1", name: "read_file" });
      emit({ type: "tool_call_delta", arguments: '{"path":' });
      emit({ type: "tool_call_delta", arguments: '"README.md"}' });
      emit({ type: "tool_call_end" });
      emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 2, outputTokens: 2 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    stream: true,
    messages: [{ role: "user", content: "read" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  }), defaultConfig(), factory);
  const body = await response.text();
  expect(body).toContain('"id":"call_stream_1"');
  expect(body).toContain('"name":"read_file"');
  expect(body).toContain('"arguments":"{\\\"path\\\":"');
  expect(body).toContain('"finish_reason":"tool_calls"');
});

test("streaming Chat Completions repairs escaped XML tag names across delta boundaries", async () => {
  const { token } = ensureApiToken();
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "chat-xml-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "<attempt\\", phase: "final_answer" });
      emit({ type: "text_delta", text: "_completion><result>done</result></attempt\\", phase: "final_answer" });
      emit({ type: "text_delta", text: "_completion>", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 2, outputTokens: 2 } });
    },
  });
  const response = await chatCompletionsRequest(request(token, {
    model: "lca-token",
    stream: true,
    messages: [
      { role: "system", content: "Tool uses are formatted using XML-style tags. Finish with <attempt_completion>." },
      { role: "user", content: "hello" },
    ],
  }), defaultConfig(), factory);
  const body = await response.text();
  expect(body).toContain("<attempt_completion>");
  expect(body).toContain("</attempt_completion>");
  expect(body).not.toContain("attempt\\\\_completion");
  expect(body).toContain("data: [DONE]");
});
