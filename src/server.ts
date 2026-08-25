import { createLcaCodexAdapter } from "./adapters/lca-codex";
import { closeChatGptBrowserWorkers } from "./adapters/lca-codex/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/lca-codex/turn-broker";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/lca-codex/turn-execution";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import { readCodexModelContextOverride, type CodexModelContextOverride } from "./codex-integration";
import {
  LCA_CODEX_BASE_MODEL,
  isLcaCodexModelSlug,
  requireLcaCodexModel,
  resolveLcaCodexReasoningMode,
  type LcaCodexModelDescriptor,
} from "./lca-codex-models";
import { forwardNativeCodexRequest, type NativeFetch } from "./native-passthrough";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import {
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseProviderState,
  rememberResponseState,
} from "./responses/state";
import {
  namespacedToolName,
  type AdapterEvent,
  type CodexParsedRequest,
  type CodexProviderContinuationState,
} from "./types";
import type { CodexProviderConfig } from "./types";
import type { AgentRequestTransport, ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";
import { PRODUCT_ID } from "./product";
import { apiTokenAuthorized } from "./api-auth";
import {
  chatCompletionsToResponses,
  responsesSseToChatCompletions,
  responsesToChatCompletion,
} from "./chat-completions";

const AGENT_PROVIDER_STATE_KEY = "lca-token-agent";
export const AGENT_TASK_ID_HEADER = "x-lca-task-id";
const AGENT_TASK_ID_METADATA_KEY = "lca_task_id";
const MAX_AGENT_TASK_ID_LENGTH = 512;
const CHAT_TOOL_EXECUTION_TTL_MS = 30 * 60_000;
const MAX_CHAT_TOOL_EXECUTIONS = 1_024;

interface ChatToolExecution {
  executionId: string;
  conversationId: string;
  updatedAt: number;
}

const chatToolExecutions = new Map<string, ChatToolExecution>();
const chatExecutionCallKeys = new Map<string, Set<string>>();

function chatToolExecutionKey(conversationId: string, callId: string): string {
  return `${conversationId}:${callId}`;
}

function forgetChatToolExecutionKey(key: string): void {
  const entry = chatToolExecutions.get(key);
  if (!entry) return;
  chatToolExecutions.delete(key);
  const keys = chatExecutionCallKeys.get(entry.executionId);
  keys?.delete(key);
  if (keys?.size === 0) chatExecutionCallKeys.delete(entry.executionId);
}

function pruneChatToolExecutions(): void {
  const cutoff = Date.now() - CHAT_TOOL_EXECUTION_TTL_MS;
  for (const [key, entry] of chatToolExecutions) {
    if (entry.updatedAt >= cutoff) continue;
    forgetChatToolExecutionKey(key);
  }
  while (chatToolExecutions.size > MAX_CHAT_TOOL_EXECUTIONS) {
    const oldest = chatToolExecutions.keys().next();
    if (oldest.done) return;
    forgetChatToolExecutionKey(oldest.value);
  }
}

function rememberChatToolExecution(conversationId: string, executionId: string, callId: string): void {
  pruneChatToolExecutions();
  const key = chatToolExecutionKey(conversationId, callId);
  forgetChatToolExecutionKey(key);
  chatToolExecutions.set(key, { executionId, conversationId, updatedAt: Date.now() });
  const keys = chatExecutionCallKeys.get(executionId) ?? new Set<string>();
  keys.add(key);
  chatExecutionCallKeys.set(executionId, keys);
}

function forgetChatToolExecution(executionId: string): void {
  const keys = chatExecutionCallKeys.get(executionId);
  if (!keys) return;
  for (const key of [...keys]) forgetChatToolExecutionKey(key);
}

function trailingChatToolResultCallIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const callIds: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) break;
    const item = message as { role?: unknown; tool_call_id?: unknown };
    if (item.role !== "tool") break;
    if (typeof item.tool_call_id !== "string" || item.tool_call_id.length === 0) return [];
    callIds.push(item.tool_call_id);
  }
  return callIds.reverse();
}

function chatToolContinuationExecutionId(body: unknown, conversationId: string): string | undefined {
  pruneChatToolExecutions();
  const callIds = trailingChatToolResultCallIds(body);
  if (callIds.length === 0) return undefined;
  const entries = callIds.map(callId => chatToolExecutions.get(chatToolExecutionKey(conversationId, callId)));
  if (entries.some(entry => !entry)) return undefined;
  const executionIds = new Set(entries.map(entry => entry!.executionId));
  return executionIds.size === 1 ? entries[0]!.executionId : undefined;
}

function agentTaskIdValue(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${source} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${source} must not be empty`);
  if (trimmed.length > MAX_AGENT_TASK_ID_LENGTH) {
    throw new Error(`${source} must be at most ${MAX_AGENT_TASK_ID_LENGTH} characters`);
  }
  // Returned task ids are already opaque and safe to reuse verbatim. External harness ids are
  // hashed so task-affinity map keys do not retain caller-provided identifiers or arbitrary text.
  if (/^lca-task-[0-9a-f]{32}$/i.test(trimmed)) return trimmed.toLowerCase();
  return `lca-task-${createHash("sha256").update(trimmed).digest("hex").slice(0, 32)}`;
}

function requestAgentTaskId(req: Request, body: unknown): string | undefined {
  const raw = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
  const metadata = raw?.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown>
    : undefined;
  const conversation = raw?.conversation;
  const conversationId = typeof conversation === "string"
    ? conversation
    : conversation && typeof conversation === "object" && !Array.isArray(conversation)
      ? (conversation as { id?: unknown }).id
      : undefined;
  const candidates = [
    agentTaskIdValue(req.headers.get(AGENT_TASK_ID_HEADER), AGENT_TASK_ID_HEADER),
    agentTaskIdValue(metadata?.[AGENT_TASK_ID_METADATA_KEY], `metadata.${AGENT_TASK_ID_METADATA_KEY}`),
    agentTaskIdValue(conversationId, "conversation"),
  ].filter((value): value is string => Boolean(value));
  const unique = new Set(candidates);
  if (unique.size > 1) {
    throw new Error(
      `${AGENT_TASK_ID_HEADER}, metadata.${AGENT_TASK_ID_METADATA_KEY}, and conversation must identify the same task when combined`,
    );
  }
  return candidates[0];
}

function agentExecutionIdFromState(body: unknown): string | undefined {
  const state = previousResponseProviderState(body)?.[AGENT_PROVIDER_STATE_KEY];
  const value = state?.execution_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentConversationIdFromState(body: unknown): string | undefined {
  const state = previousResponseProviderState(body)?.[AGENT_PROVIDER_STATE_KEY];
  const value = state?.conversation_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentProviderState(
  executionId: string | undefined,
  conversationId: string | undefined,
): CodexProviderContinuationState | undefined {
  return executionId || conversationId
    ? {
        [AGENT_PROVIDER_STATE_KEY]: {
          ...(executionId ? { execution_id: executionId } : {}),
          ...(conversationId ? { conversation_id: conversationId } : {}),
        },
      }
    : undefined;
}

function isAgentToolContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input) || input.length === 0) return false;
  return input.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const type = (item as { type?: unknown }).type;
    return type === "function_call_output" || type === "custom_tool_call_output";
  });
}

export class HttpTurnCounter {
  private active = 0;

  count(): number {
    return this.active;
  }

  async track(
    run: () => Promise<Response>,
    signal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
  ): Promise<Response> {
    this.active += 1;
    let released = false;
    let abortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    try {
      const response = await run();
      if (!response.body) {
        release();
        return response;
      }
      if (signal?.aborted) {
        void response.body.cancel(signal.reason).catch(() => {});
        release();
        return response;
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        abortListener = () => {
          void reader.cancel(signal?.reason).catch(() => {}).finally(release);
        };
        signal?.addEventListener("abort", abortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // OpenCodex's Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      abortListener = () => {
        void reader.cancel(signal?.reason).catch(() => {});
        void clientBody.cancel(signal?.reason).catch(() => {});
        release();
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch {
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type LcaCodexAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export function routeLcaCodexRequest(parsed: CodexParsedRequest, config: AppConfig): LcaCodexModelDescriptor {
  const model = requireLcaCodexModel(parsed.modelId);
  const mode = resolveLcaCodexReasoningMode(parsed.options.reasoning, config.proAvailable);
  parsed.modelId = LCA_CODEX_BASE_MODEL;
  parsed.options.reasoning = mode.adapterEffort;
  return model;
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) return upstream;
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: LcaCodexAdapterFactory = createLcaCodexAdapter,
  options: {
    agentOnly?: boolean;
    agentTransport?: AgentRequestTransport;
    agentConversationId?: string;
    agentExecutionId?: string;
    onAgentToolCall?: (callId: string, executionId: string, conversationId?: string) => void;
    onAgentExecutionFinished?: (executionId: string) => void;
  } = {},
): Promise<Response> {
  if (options.agentOnly && !apiTokenAuthorized(req)) {
    return formatErrorResponse(401, "authentication_error", "A valid LCA Token API key is required");
  }
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  if (options.agentOnly && (typeof requestedModel !== "string" || !isLcaCodexModelSlug(requestedModel))) {
    return formatErrorResponse(400, "invalid_request_error", `The agent API supports only the ${PRODUCT_ID} model`);
  }
  if (typeof requestedModel === "string" && !isLcaCodexModelSlug(requestedModel)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const agentToolContinuation = options.agentOnly && isAgentToolContinuation(raw);
  const expanded = expandPreviousResponseInput(raw);
  const restoredAgentExecutionId = agentToolContinuation ? agentExecutionIdFromState(expanded) : undefined;
  const restoredAgentConversationId = options.agentOnly ? agentConversationIdFromState(expanded) : undefined;
  let parsed: CodexParsedRequest;
  let route: LcaCodexModelDescriptor;
  let agentExecutionId: string | undefined;
  let agentConversationId: string | undefined;
  try {
    const explicitAgentTaskId = options.agentOnly ? requestAgentTaskId(req, raw) : undefined;
    parsed = parseRequest(expanded);
    route = routeLcaCodexRequest(parsed, config);
    if (options.agentOnly) {
      if (explicitAgentTaskId && restoredAgentConversationId && explicitAgentTaskId !== restoredAgentConversationId) {
        throw new Error(`${AGENT_TASK_ID_HEADER} conflicts with the task restored by previous_response_id`);
      }
      agentExecutionId = restoredAgentExecutionId ?? options.agentExecutionId ?? randomUUID();
      agentConversationId = explicitAgentTaskId
        ?? restoredAgentConversationId
        ?? options.agentConversationId
        ?? `lca-task-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run LCA Codex with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }
  if (agentToolContinuation && !restoredAgentExecutionId) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Private agent execution state for this tool continuation is unavailable; start a new agent turn instead of resuming the old tool call.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = adapterFactory(providerConfig(config));
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, {
        headers: req.headers,
        abortSignal: abort.signal,
        ...(agentExecutionId ? {
          agentRequest: {
            executionId: agentExecutionId,
            transport: options.agentTransport ?? "responses",
            ...(agentConversationId ? { conversationId: agentConversationId } : {}),
          },
        } : {}),
      }, event => {
        if (agentExecutionId && event.type === "tool_call_start") {
          options.onAgentToolCall?.(event.id, agentExecutionId, agentConversationId);
        }
        if (agentExecutionId && ((event.type === "done" && event.endTurn) || event.type === "error")) {
          options.onAgentExecutionFinished?.(agentExecutionId);
        }
        queue.push(event);
      });
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(compaction ? { compaction: true } : {
          onCompletedResponse: (response: Record<string, unknown>, providerState) => rememberResponseState(parsed._rawBody, response, {
            force: true,
            ...(providerState || agentExecutionId || agentConversationId
              ? { providerState: { ...(providerState ?? {}), ...(agentProviderState(agentExecutionId, agentConversationId) ?? {}) } }
              : {}),
          }),
        }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        ...(agentConversationId ? { [AGENT_TASK_ID_HEADER]: agentConversationId } : {}),
      },
    });
  }

  await run();
  const events = await queue.collect();
  let providerState: CodexProviderContinuationState | undefined;
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
    onProviderState: state => { providerState = state; },
  });
  if (!compaction) rememberResponseState(parsed._rawBody, json, {
    force: true,
    ...(providerState || agentExecutionId || agentConversationId
      ? { providerState: { ...(providerState ?? {}), ...(agentProviderState(agentExecutionId, agentConversationId) ?? {}) } }
      : {}),
  });
  return Response.json(json, agentConversationId
    ? { headers: { [AGENT_TASK_ID_HEADER]: agentConversationId } }
    : undefined);
}

export function agentModelsRequest(req: Request): Response {
  if (!apiTokenAuthorized(req)) {
    return formatErrorResponse(401, "authentication_error", "A valid LCA Token API key is required");
  }
  return Response.json({
    object: "list",
    data: [{
      id: PRODUCT_ID,
      object: "model",
      created: 0,
      owned_by: PRODUCT_ID,
    }],
  });
}

export async function chatCompletionsRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: LcaCodexAdapterFactory = createLcaCodexAdapter,
): Promise<Response> {
  if (!apiTokenAuthorized(req)) {
    return formatErrorResponse(401, "authentication_error", "A valid LCA Token API key is required");
  }
  let conversion: ReturnType<typeof chatCompletionsToResponses>;
  let chatBody: unknown;
  let chatTaskId: string | undefined;
  try {
    chatBody = await readJsonRequestBody(req);
    chatTaskId = requestAgentTaskId(req, chatBody);
    conversion = chatCompletionsToResponses(chatBody);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  if (chatTaskId) headers.set(AGENT_TASK_ID_HEADER, chatTaskId);
  const conversationId = chatTaskId ?? conversion.conversationId;
  const continuedExecutionId = conversationId
    ? chatToolContinuationExecutionId(chatBody, conversationId)
    : undefined;
  const internal = new Request("http://127.0.0.1/v1/agent/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(conversion.responsesBody),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, {
    agentOnly: true,
    agentTransport: "chat_completions",
    ...(conversion.conversationId ? { agentConversationId: conversion.conversationId } : {}),
    ...(continuedExecutionId ? { agentExecutionId: continuedExecutionId } : {}),
    onAgentToolCall: (callId, executionId, activeConversationId) => {
      if (activeConversationId) rememberChatToolExecution(activeConversationId, executionId, callId);
    },
    onAgentExecutionFinished: forgetChatToolExecution,
  });
  if (!response.ok) return response;
  const taskId = response.headers.get(AGENT_TASK_ID_HEADER);
  const requestedModel = String(conversion.responsesBody.model);
  if (conversion.stream) {
    if (!response.body) return formatErrorResponse(502, "invalid_response_error", "Responses core returned an empty stream");
    return new Response(responsesSseToChatCompletions(
      response.body,
      requestedModel,
      conversion.includeUsage,
      conversion.textualXmlToolProtocol,
    ), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        ...(taskId ? { [AGENT_TASK_ID_HEADER]: taskId } : {}),
      },
    });
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Responses core returned invalid JSON");
  }
  if (body.error && typeof body.error === "object") {
    const error = body.error as { message?: unknown; type?: unknown; code?: unknown };
    const normalized = {
      message: typeof error.message === "string" ? error.message : "Chat Completions turn failed",
      type: typeof error.type === "string" ? error.type : "server_error",
      code: typeof error.code === "string" ? error.code : null,
    };
    return Response.json({ error: normalized }, { status: httpStatusFromTerminalError(normalized) });
  }
  return Response.json(
    responsesToChatCompletion(body, requestedModel, conversion.textualXmlToolProtocol),
    taskId ? { headers: { [AGENT_TASK_ID_HEADER]: taskId } } : undefined,
  );
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: LcaCodexAdapterFactory = createLcaCodexAdapter,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isLcaCodexModelSlug(raw.model)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  try {
    requireLcaCodexModel(raw.model);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: { fetchUpstream?: NativeFetch } = {},
): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  const turnBroker = TurnBroker.forSocket(config.brokerSocketPath);
  void turnBroker.listen().catch(error => {
    console.error(
      `[${PRODUCT_ID}] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  const httpTurns = new HttpTurnCounter();
  const brokerReady = () => turnBroker.isListening();
  const acceptingTurns = () => !draining && brokerReady();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount(),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: PRODUCT_ID,
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: acceptingTurns(),
          broker_ready: brokerReady(),
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        return Response.json({ status: "ok", accepting_turns: acceptingTurns(), broker_ready: brokerReady(), ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-browser-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        return chatGptTurnSessions.clearAndWait().then(cancelled => (
          Response.json({ status: "ok", cancelled_browser_turns: cancelled, ...activity() })
        ));
      }
      if (req.method === "POST" && url.pathname === "/admin/codex-lifecycle") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        return readJsonRequestBody(req).then(async raw => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return formatErrorResponse(400, "invalid_request_error", "Codex lifecycle event must be an object");
          }
          const event = raw as { method?: unknown; threadId?: unknown; turnId?: unknown };
          const method = typeof event.method === "string" ? event.method : "";
          const threadId = typeof event.threadId === "string" ? event.threadId : "";
          const turnId = typeof event.turnId === "string" ? event.turnId : "";
          if (!threadId || threadId.length > 200 || turnId.length > 200) {
            return formatErrorResponse(400, "invalid_request_error", "Codex lifecycle event has invalid turn identity");
          }
          let cancelled = 0;
          if (method === "turn/interrupt" || method === "turn/completed") {
            if (!turnId) return formatErrorResponse(400, "invalid_request_error", `${method} requires turnId`);
            cancelled = chatGptTurnSessions.retireThreadTurn(threadId, turnId);
          } else if (method === "thread/stop") {
            cancelled = chatGptTurnSessions.retireThread(threadId);
          } else if (method !== "turn/start" && method !== "turn/started") {
            return formatErrorResponse(400, "invalid_request_error", `Unsupported Codex lifecycle method: ${method || "missing"}`);
          }
          return Response.json({
            status: "ok",
            method,
            cancelled_browser_turns: cancelled,
            ...activity(),
          });
        }).catch(error => formatErrorResponse(
          400,
          "invalid_request_error",
          error instanceof Error ? error.message : "Codex lifecycle request must be valid JSON",
        ));
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            `${PRODUCT_ID} is draining for a requested service operation`,
          );
        }
        return httpTurns.track(async () => {
          const response = await modelsRequest(
            req,
            config,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return response;
        }, req.signal);
      }
      if (req.method === "GET" && url.pathname === "/v1/agent/models") {
        return agentModelsRequest(req);
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", `${PRODUCT_ID} is draining for a requested service operation`);
        return httpTurns.track(() => responseRequest(req, config), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/agent/responses") {
        if (draining) return formatErrorResponse(503, "server_error", `${PRODUCT_ID} is draining for a requested service operation`);
        return httpTurns.track(() => responseRequest(req, config, createLcaCodexAdapter, { agentOnly: true }), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (draining) return formatErrorResponse(503, "server_error", `${PRODUCT_ID} is draining for a requested service operation`);
        return httpTurns.track(() => chatCompletionsRequest(req, config), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", `${PRODUCT_ID} is draining for a requested service operation`);
        return httpTurns.track(() => compactRequest(req, config), req.signal);
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", `${PRODUCT_ID} is draining for a requested service operation`);
        return httpTurns.track(() => nativeSearchRequest(req, dependencies.fetchUpstream), req.signal);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[${PRODUCT_ID}] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[${PRODUCT_ID}] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
