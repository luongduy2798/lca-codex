import { expect, test } from "bun:test";
import { ensureApiToken } from "../src/api-auth";
import { agentTurnEnvironment } from "../src/core/agent";
import { defaultConfig } from "../src/config";
import { agentModelsRequest, responseRequest } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { CodexProviderConfig } from "../src/types";

const tools = [{
  type: "function" as const,
  name: "read_file",
  description: "Read one file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];

test("generic agent tools do not grant LCA Token local filesystem or network authority", () => {
  const environment = agentTurnEnvironment(tools);
  expect(environment).toMatchObject({
    cwd: "/",
    roots: [],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  expect(environment.tools.map(tool => tool.name)).toEqual(["read_file"]);
});

function request(token?: string, body: Record<string, unknown> = {}, taskId?: string): Request {
  return new Request("http://127.0.0.1:8317/v1/agent/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(taskId ? { "x-lca-task-id": taskId } : {}),
    },
    body: JSON.stringify({
      model: "lca-token",
      stream: false,
      input: "inspect the project",
      tools,
      ...body,
    }),
  });
}

test("generic Responses route requires only the profile API key before invoking the adapter", async () => {
  ensureApiToken();
  const response = await responseRequest(request(), defaultConfig(), () => ({
    name: "should-not-run",
    async runTurn() { throw new Error("unauthorized adapter invocation"); },
  }), { agentOnly: true });
  expect(response.status).toBe(401);
});

test("generic API accepts credentials only through Authorization Bearer", async () => {
  const { token } = ensureApiToken();
  const response = agentModelsRequest(new Request("http://127.0.0.1:8317/v1/agent/models", {
    headers: { "x-lca-token": token },
  }));
  expect(response.status).toBe(401);
});

test("generic Responses route rejects an invalid API key before parsing continuation state", async () => {
  ensureApiToken();
  const response = await responseRequest(new Request("http://127.0.0.1:8317/v1/agent/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer lcat_invalid_token_that_must_not_authorize_1234567890",
    },
    body: JSON.stringify({
      model: "lca-token",
      previous_response_id: "resp_missing_private_state",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }),
  }), defaultConfig(), () => ({
    name: "should-not-run",
    async runTurn() { throw new Error("unauthorized adapter invocation"); },
  }), { agentOnly: true });
  expect(response.status).toBe(401);
});

test("generic model catalog requires the profile API key", async () => {
  const { token } = ensureApiToken();
  const missing = agentModelsRequest(new Request("http://127.0.0.1:8317/v1/agent/models"));
  expect(missing.status).toBe(401);

  const invalid = agentModelsRequest(new Request("http://127.0.0.1:8317/v1/agent/models", {
    headers: { authorization: "Bearer lcat_wrong_token_123456789012345678901234567890123456" },
  }));
  expect(invalid.status).toBe(401);

  const valid = agentModelsRequest(new Request("http://127.0.0.1:8317/v1/agent/models", {
    headers: { authorization: `Bearer ${token}` },
  }));
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({
    object: "list",
    data: [{ id: "lca-token", object: "model", created: 0, owned_by: "lca-token" }],
  });
});

test("generic Responses route passes a server-owned execution id and tool registry to the adapter", async () => {
  const { token } = ensureApiToken();
  let captured: Parameters<ProviderAdapter["runTurn"]>[1]["agentRequest"];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "agent-test",
    async runTurn(parsed, incoming, emit) {
      captured = incoming.agentRequest;
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["read_file"]);
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });
  const response = await responseRequest(request(token), defaultConfig(), factory, { agentOnly: true });
  expect(response.status).toBe(200);
  expect(captured?.executionId).toBeString();
  expect(captured?.executionId.length).toBeGreaterThan(10);
  expect(captured?.conversationId).toBeString();
  expect(captured?.conversationId!.length).toBeGreaterThan(10);
  expect(captured?.transport).toBe("responses");
  const body = await response.json() as { status?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  expect(body.status).toBe("completed");
  expect(JSON.stringify(body.output)).toContain("ok");
});

test("previous_response_id reuses execution ids only for tool-result rounds", async () => {
  const { token } = ensureApiToken();
  const executionIds: string[] = [];
  const conversationIds: string[] = [];
  let invocation = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "agent-continuation-test",
    async runTurn(_parsed, incoming, emit) {
      executionIds.push(incoming.agentRequest?.executionId ?? "missing");
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      invocation += 1;
      if (invocation === 1) {
        emit({ type: "tool_call_start", id: "call_agent_1", name: "read_file" });
        emit({ type: "tool_call_delta", arguments: '{"path":"README.md"}' });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 1, outputTokens: 1 } });
        return;
      }
      emit({ type: "text_delta", text: "continued", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  const first = await responseRequest(request(token), defaultConfig(), factory, { agentOnly: true });
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { id?: string };
  expect(firstBody.id).toBeString();

  const second = await responseRequest(request(token, {
    previous_response_id: firstBody.id,
    input: [{ type: "function_call_output", call_id: "call_agent_1", output: "README contents" }],
  }), defaultConfig(), factory, { agentOnly: true });
  expect(second.status).toBe(200);
  const secondBody = await second.json() as { id?: string };
  expect(secondBody.id).toBeString();
  expect(executionIds).toHaveLength(2);
  expect(executionIds[0]).toBe(executionIds[1]);

  const third = await responseRequest(request(token, {
    previous_response_id: secondBody.id,
    input: "Now summarize the result",
  }), defaultConfig(), factory, { agentOnly: true });
  expect(third.status).toBe(200);
  expect(executionIds).toHaveLength(3);
  expect(executionIds[2]).not.toBe(executionIds[1]);
  expect(conversationIds).toHaveLength(3);
  expect(conversationIds[0]).not.toBe("missing");
  expect(conversationIds[1]).toBe(conversationIds[0]);
  expect(conversationIds[2]).toBe(conversationIds[0]);
});

test("independent Responses tasks receive different private task identities", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "agent-new-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  for (const input of ["task one", "task two"]) {
    const response = await responseRequest(request(token, { input }), defaultConfig(), factory, { agentOnly: true });
    expect(response.status).toBe(200);
  }

  expect(conversationIds).toHaveLength(2);
  expect(conversationIds[0]).not.toBe("missing");
  expect(conversationIds[1]).not.toBe(conversationIds[0]);
});

test("explicit task ids keep Responses task identity stable when a harness rewrites or compacts its retained history", async () => {
  const { token } = ensureApiToken();
  const conversationIds: string[] = [];
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "agent-explicit-task-affinity-test",
    async runTurn(_parsed, incoming, emit) {
      conversationIds.push(incoming.agentRequest?.conversationId ?? "missing");
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  const first = await responseRequest(
    request(token, { input: "full original task history" }, "harness-task-42"),
    defaultConfig(),
    factory,
    { agentOnly: true },
  );
  expect(first.status).toBe(200);
  const stableTaskId = first.headers.get("x-lca-task-id");
  expect(stableTaskId).toMatch(/^lca-task-[0-9a-f]{32}$/);

  const second = await responseRequest(
    request(token, { input: "compacted replacement summary with no shared transcript prefix" }, "harness-task-42"),
    defaultConfig(),
    factory,
    { agentOnly: true },
  );
  expect(second.status).toBe(200);
  expect(second.headers.get("x-lca-task-id")).toBe(stableTaskId);

  const third = await responseRequest(
    request(token, { input: "unrelated task" }, "harness-task-43"),
    defaultConfig(),
    factory,
    { agentOnly: true },
  );
  expect(third.status).toBe(200);

  expect(conversationIds).toHaveLength(3);
  expect(conversationIds[0]).toBe(conversationIds[1]);
  expect(conversationIds[2]).not.toBe(conversationIds[0]);
});

test("Responses rejects an explicit task id that conflicts with previous_response_id state", async () => {
  const { token } = ensureApiToken();
  let invocations = 0;
  const factory = (_provider: CodexProviderConfig): ProviderAdapter => ({
    name: "agent-task-conflict-test",
    async runTurn(_parsed, _incoming, emit) {
      invocations += 1;
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    },
  });

  const first = await responseRequest(
    request(token, { input: "task" }, "task-one"),
    defaultConfig(),
    factory,
    { agentOnly: true },
  );
  const firstBody = await first.json() as { id?: string };
  const conflicting = await responseRequest(
    request(token, { previous_response_id: firstBody.id, input: "continue" }, "task-two"),
    defaultConfig(),
    factory,
    { agentOnly: true },
  );

  expect(conflicting.status).toBe(400);
  expect(invocations).toBe(1);
  expect(await conflicting.text()).toContain("conflicts with the task restored by previous_response_id");
});
