import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { LcaCodexAdapterError } from "./adapter-error";
import { activityDuration, logLcaCodexActivity } from "./activity";
import { ChatGptBrowserWorker } from "./browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { resolveLcaCodexModelMode, type LcaCodexCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptContextSnapshot, compileLcaCodexPrompt } from "./prompt";
import { resolveBrowserRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateLcaCodexUsage } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";

export const LCA_CODEX_TOOL_HEALTH_PROBE_PROMPT = "LCA_CODEX_NATIVE_TOOL_HEALTH_PROBE_V1";
const MAX_ACTIVITY_TASK_TITLE_CHARS = 240;
const CODEX_IDE_CONTEXT_PREFIX = "# Context from my IDE setup:";
const CODEX_IDE_REQUEST_MARKER = /^## My request:\s*$/m;

function messageText(content: string | CodexContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function codexTaskText(content: string | CodexContentPart[]): string {
  const text = messageText(content);
  if (!text.trimStart().startsWith(CODEX_IDE_CONTEXT_PREFIX)) return text;
  const marker = CODEX_IDE_REQUEST_MARKER.exec(text);
  return marker ? text.slice(marker.index + marker[0].length) : text;
}

function activityTaskTitle(parsed: CodexParsedRequest): string | undefined {
  const latestUser = parsed.context.messages.findLast(message => message.role === "user");
  const title = latestUser ? codexTaskText(latestUser.content).replace(/\s+/g, " ").trim() : "";
  return title ? title.slice(0, MAX_ACTIVITY_TASK_TITLE_CHARS) : undefined;
}

export function isLcaCodexToolHealthProbe(parsed: CodexParsedRequest): boolean {
  const latestUser = parsed.context.messages.findLast(message => message.role === "user");
  return latestUser !== undefined
    && messageText(latestUser.content).trim() === LCA_CODEX_TOOL_HEALTH_PROBE_PROMPT;
}

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.lcaCodex?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(): DOMException {
  return new DOMException("LCA Codex turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function hasFinalAnswerText(events: AdapterEvent[]): boolean {
  return events.some(event => event.type === "text_delta" && event.phase === "final_answer" && event.text.length > 0);
}

function emitProContextWarning(
  parsed: CodexParsedRequest,
  capabilities: LcaCodexCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

export function createLcaCodexAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.lcaCodex?.turnTimeoutMs;
  const connectorName = provider.lcaCodex?.appName?.trim() || "lca-codex";
  const configuredCapabilities: LcaCodexCapabilities = {
    localToolsEnabled: provider.lcaCodex?.localToolsEnabled === true,
    proAvailable: provider.lcaCodex?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    lcaCodex: provider.lcaCodex ?? {},
  })).digest("hex");
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.lcaCodex?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.lcaCodex.threadEnvironmentStatePath))
      : undefined,
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: LcaCodexCapabilities,
    attempt: number,
    threadId?: string,
  ): ChatGptTurnRuntime => {
    const startedAt = Date.now();
    const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const taskTitle = activityTaskTitle(parsed);
    logLcaCodexActivity("lca_codex.turn_started", {
      traceId,
      ...(threadId ? { threadId } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      attempt,
      mode: mode.localTools ? "tools" : "read-only",
    });
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    if (mode.localTools && isLcaCodexToolHealthProbe(parsed)) {
      if (!environment) throw new Error("Codex native-tool health probe requires a trusted Codex environment");
      const probeBrowser = deferred<string>();
      let cancelled = false;
      let activeToken: string | undefined;
      const token = broker.register(
        environment,
        timeoutMs === undefined ? 60_000 : Math.min(timeoutMs + 60_000, 120_000),
        `health-${traceId}`,
      ).then(turnToken => {
        if (cancelled) {
          broker.revoke(turnToken);
          throw abortError();
        }
        activeToken = turnToken;
        return turnToken;
      });
      return {
        mode: "tools",
        attempt,
        startedAt,
        token,
        browser: probeBrowser.promise,
        trace,
        text,
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          if (activeToken) broker.revoke(activeToken);
          probeBrowser.reject(abortError());
        },
      };
    }
    if (!mode.localTools) {
      const browser = worker.run({
        traceId,
        attempt,
        startedAt,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({ ...compileLcaCodexPrompt(parsed, turnCapabilities, undefined, undefined, connectorName), release: () => {} }),
        abortSignal: browserAbort.signal,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
      });
      return {
        mode: "read-only",
        attempt,
        startedAt,
        browser,
        trace,
        text,
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable LCA Codex mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const browser = worker.run({
      traceId,
      attempt,
      startedAt,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: async () => {
        const contextSnapshot = compileChatGptContextSnapshot(parsed);
        const turnToken = await broker.register(
          environment,
          timeoutMs === undefined ? undefined : timeoutMs + 60_000,
          traceId,
          contextSnapshot,
        );
        activeToken = turnToken;
        tokenSettled = true;
        token.resolve(turnToken);
        try {
          const compiled = compileLcaCodexPrompt(parsed, turnCapabilities, turnToken, contextSnapshot, connectorName);
          return { ...compiled, release: () => {} };
        } catch (error) {
          broker.revoke(turnToken);
          throw error;
        }
      },
      abortSignal: browserAbort.signal,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
    });
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      attempt,
      startedAt,
      token: token.promise,
      browser,
      trace,
      text,
      cancel: () => {
        browserAbort.abort();
        if (activeToken) broker.revoke(activeToken);
      },
    };
  };

  return {
    name: "lca-codex",
    async runTurn(parsed, incoming, emitOuter) {
      let streamedFinalAnswer = false;
      const emit = (event: AdapterEvent) => {
        if (event.type === "text_delta" && event.phase === "final_answer" && event.text.length > 0) {
          streamedFinalAnswer = true;
        }
        emitOuter(event);
      };
      if (parsed._opaqueMultiAgentV2Payload) {
        throw new Error(
          "LCA Codex subagents currently require a V1-rooted task. "
          + "Start a new task with a LCA Codex model before spawning LCA Codex Pro. "
          + "Codex MultiAgent V2 currently encrypts cross-backend task payloads.",
        );
      }
      const turnCapabilities = parsed._compactionRequest
        ? { ...configuredCapabilities, localToolsEnabled: false }
        : configuredCapabilities;
      const identity = extractChatGptTurnIdentity(parsed);
      const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
      let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
      if (mode.localTools) {
        try {
          environment = environmentStore.resolve(parsed);
        } catch (error) {
          console.warn(
            `[lca-codex] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
          );
          throw error;
        }
      }
      if (parsed._compactionRequest) {
        const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
        await chatGptTurnSessions.retireAndWait(responseExecutionKey);
      }
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      if (!parsed._compactionRequest && identity.threadId && identity.turnId) {
        await chatGptTurnSessions.retireSupersededThreadTurns(identity.threadId, identity.turnId, executionKey);
      }
      await chatGptTurnSessions.waitForRetirement(executionKey);
      const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
      const attempt = chatGptTurnSessions.retryAttempt(executionKey);
      const session = chatGptTurnSessions.getOrCreate(
        executionKey,
        () => startRuntime(parsed, environment, traceId, turnCapabilities, attempt, identity.threadId),
        {
          threadId: identity.threadId,
          turnId: identity.turnId,
          purpose: parsed._compactionRequest ? "compaction" : "response",
        },
      );
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") throw settled.error;
            let reasoning = session.reasoningForFinalReplay();
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              const events: AdapterEvent[] = [];
              const emitCaptured = (event: AdapterEvent) => {
                events.push(event);
                emit(event);
              };
              if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitCaptured);
              const trace = session.runtime.trace.drain();
              reasoning = trace.map(event => event.text);
              emitTraceEvents(trace, emitCaptured);
              emitTextDeltas(session.runtime.text.drain(), emitCaptured);
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(events);
            }
            emitBrowserCompletion(settled, estimateLcaCodexUsage(parsed, { answer: settled.answer, reasoning }, turnCapabilities), emit);
            chatGptTurnSessions.clearRetry(executionKey);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable LCA Codex runtime lost its trusted environment");
            broker.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const results = currentToolResults(parsed, session);
              if (results.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(outstanding, estimateLcaCodexUsage(parsed, { reasoning, toolRequests: outstanding }, turnCapabilities), emit);
                return;
              }
              if (results.length !== outstanding.length) {
                throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
              }
              for (const message of results) {
                broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                session.markResultDelivered(message.toolCallId);
              }
            }
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only LCA Codex runtime cannot own local tool calls");
          }

          const toolWaitAbort = new AbortController();
          try {
            const roundReasoning: string[] = [];
            const roundEvents: AdapterEvent[] = [];
            const emitRound = (event: AdapterEvent) => {
              roundEvents.push(event);
              emit(event);
            };
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
              roundReasoning.push(...trace.map(event => event.text));
              emitTraceEvents(trace, emitRound);
            };
            const emitNewText = (deltas: string[]) => emitTextDeltas(deltas, emitRound);
            if (!parsed._compactionRequest) emitProContextWarning(parsed, turnCapabilities, emitRound);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            const nextTools = turnToken
              ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => ({ type: "tools" as const, requests }))
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ]),
                incoming.abortSignal,
              );
              if (next.type === "trace") {
                emitNewTrace([next.event]);
                nextTrace = session.runtime.trace.next(toolWaitAbort.signal).then(event => ({ type: "trace" as const, event }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(roundEvents);
                if (next.outcome.type === "error") {
                  if (turnToken) broker.revoke(turnToken);
                  throw next.outcome.error;
                }
                if (turnToken) broker.revoke(turnToken);
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                emitBrowserCompletion(
                  next.outcome,
                  estimateLcaCodexUsage(parsed, { answer: next.outcome.answer, reasoning: roundReasoning }, turnCapabilities),
                  emit,
                );
                chatGptTurnSessions.clearRetry(executionKey);
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only LCA Codex runtime received a broker tool batch");
              }
              if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, next.requests);
              session.setOutstanding(next.requests, roundReasoning, roundEvents);
              emitToolBatch(
                next.requests,
                estimateLcaCodexUsage(parsed, { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
        });
      } catch (error) {
        const adapterError = error instanceof LcaCodexAdapterError ? error : null;
        const responseStreamed = streamedFinalAnswer || hasFinalAnswerText(session.eventsForFinalReplay());
        const retryPolicy = resolveBrowserRetryPolicy(error, responseStreamed);
        const nextAttempt = retryPolicy.browserGenerationAllowed
          ? chatGptTurnSessions.scheduleRetry(executionKey, session)
          : null;
        const browserRetryScheduled = nextAttempt !== null;
        const retryable = retryPolicy.nativeRetryableWithoutBrowserGeneration || browserRetryScheduled;
        if (adapterError && browserRetryScheduled) {
          // Reconnects must replay an active/successful browser turn, but retryable terminal
          // ChatGPT failures need a genuinely new Temporary Chat. Retaining a failed session here
          // made every native retry replay the same cached error for the registry's full TTL.
          logLcaCodexActivity("lca_codex.turn_retry_scheduled", {
            traceId,
            attempt: session.runtime.attempt ?? 1,
            nextAttempt,
            durationMs: activityDuration(session.runtime.startedAt ?? Date.now()),
            reason: adapterError.code,
            status: adapterError.status,
            code: adapterError.code,
          }, "warning");
        } else {
          session.cancel();
          if (retryPolicy.providerRetryable && adapterError) {
            logLcaCodexActivity("lca_codex.turn_retry_stopped", {
              traceId,
              attempt: session.runtime.attempt ?? 1,
              durationMs: activityDuration(session.runtime.startedAt ?? Date.now()),
              reason: retryPolicy.stopReason,
              status: adapterError.status,
              code: adapterError.code,
            }, retryPolicy.usageLimited ? "warning" : "error");
          }
        }
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (adapterError) {
          emit({
            type: "error",
            message: adapterError.message,
            status: adapterError.status,
            errorType: adapterError.errorType,
            code: adapterError.code,
            // Responses deltas are append-only. Once any final-answer text escaped this request,
            // starting a fresh browser generation would make Codex append the retry from byte 0
            // after the already-visible prefix. Keep the failed session replayable instead and
            // force this streamed failure to be terminal for the native request.
            retryable,
          });
          return;
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
