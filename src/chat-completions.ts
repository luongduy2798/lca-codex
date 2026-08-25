import { createHash, randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (!Array.isArray(value)) throw new Error("message content must be a string, null, or an array of content parts");
  return value.map(part => {
    if (!isObject(part)) throw new Error("message content parts must be objects");
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") return part.text;
    throw new Error(`Unsupported Chat Completions content part: ${String(part.type ?? "missing type")}`);
  }).join("");
}

function inputContent(value: unknown): string | JsonObject[] {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (!Array.isArray(value)) throw new Error("message content must be a string, null, or an array of content parts");
  return value.map(part => {
    if (!isObject(part)) throw new Error("message content parts must be objects");
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "image_url" && isObject(part.image_url) && typeof part.image_url.url === "string") {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        ...(typeof part.image_url.detail === "string" ? { detail: part.image_url.detail } : {}),
      };
    }
    throw new Error(`Unsupported Chat Completions content part: ${String(part.type ?? "missing type")}`);
  });
}

function responseTool(tool: unknown): JsonObject {
  if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function)) {
    throw new Error("Chat Completions currently supports only function tools");
  }
  const fn = tool.function;
  if (typeof fn.name !== "string" || fn.name.length === 0) throw new Error("function tool name is required");
  return {
    type: "function",
    name: fn.name,
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
    ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
  };
}

function responseToolChoice(choice: unknown): unknown {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isObject(choice) && choice.type === "function" && isObject(choice.function) && typeof choice.function.name === "string") {
    return { type: "function", name: choice.function.name };
  }
  throw new Error("Unsupported Chat Completions tool_choice");
}

function responseInput(messages: unknown): JsonObject[] {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("Chat Completions requires a non-empty messages array");
  const input: JsonObject[] = [];
  for (const raw of messages) {
    if (!isObject(raw) || typeof raw.role !== "string") throw new Error("Each Chat Completions message requires a role");
    if (raw.role === "system" || raw.role === "developer" || raw.role === "user") {
      input.push({ role: raw.role, content: inputContent(raw.content) });
      continue;
    }
    if (raw.role === "assistant") {
      const content = textContent(raw.content);
      if (content.length > 0) input.push({ role: "assistant", content });
      if (raw.tool_calls !== undefined) {
        if (!Array.isArray(raw.tool_calls)) throw new Error("assistant tool_calls must be an array");
        for (const toolCall of raw.tool_calls) {
          if (!isObject(toolCall)
            || toolCall.type !== "function"
            || typeof toolCall.id !== "string"
            || !isObject(toolCall.function)
            || typeof toolCall.function.name !== "string") {
            throw new Error("Invalid assistant function tool call");
          }
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "{}",
          });
        }
      }
      continue;
    }
    if (raw.role === "tool") {
      if (typeof raw.tool_call_id !== "string" || raw.tool_call_id.length === 0) {
        throw new Error("tool messages require tool_call_id");
      }
      input.push({
        type: "function_call_output",
        call_id: raw.tool_call_id,
        output: textContent(raw.content),
      });
      continue;
    }
    throw new Error(`Unsupported Chat Completions message role: ${raw.role}`);
  }
  return input;
}

export interface ChatCompletionsConversion {
  responsesBody: JsonObject;
  stream: boolean;
  includeUsage: boolean;
  textualXmlToolProtocol: boolean;
  conversationId?: string;
}

function hasTextualXmlToolProtocol(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const raw of messages) {
    if (!isObject(raw)) continue;
    let content = "";
    try {
      content = textContent(raw.content);
    } catch {
      continue;
    }
    if (/Tool uses are formatted using XML-style tags|<attempt_completion>|<ask_followup_question>|task_progress parameter/i.test(content)) {
      return true;
    }
  }
  return false;
}

/**
 * Chat Completions has no standard thread id. This immutable-prefix derivation is only a
 * backward-compatible best effort for append-only transcripts. Harnesses that may compact or
 * rewrite history should use the transport-neutral LCA task-id contract instead. Keep this
 * fallback private to continuation/task bookkeeping; it must never select or reuse a browser page.
 */
export function chatCompletionsConversationId(body: unknown): string | undefined {
  if (!isObject(body) || !Array.isArray(body.messages)) return undefined;
  const boundary = body.messages.findIndex(message => (
    isObject(message) && (message.role === "assistant" || message.role === "tool")
  ));
  const anchorMessages = boundary >= 0 ? body.messages.slice(0, boundary) : body.messages;
  if (anchorMessages.length === 0) return undefined;
  const anchor = JSON.stringify({
    model: body.model,
    ...(typeof body.user === "string" ? { user: body.user } : {}),
    messages: anchorMessages,
  });
  return `lca-task-${createHash("sha256").update(anchor).digest("hex").slice(0, 32)}`;
}

export function chatCompletionsToResponses(body: unknown): ChatCompletionsConversion {
  if (!isObject(body)) throw new Error("Chat Completions request body must be a JSON object");
  if (typeof body.model !== "string" || body.model.length === 0) throw new Error("Chat Completions requires a model");
  if (body.n !== undefined && body.n !== 1) throw new Error("LCA Token Chat Completions supports only n=1");
  const stream = body.stream === true;
  const tools = body.tools === undefined
    ? undefined
    : Array.isArray(body.tools)
      ? body.tools.map(responseTool)
      : (() => { throw new Error("tools must be an array"); })();
  const toolChoice = responseToolChoice(body.tool_choice);
  // Chat Completions exposes the browser's visible reasoning/commentary through the
  // compatibility `reasoning_content` field. The Responses parser hides reasoning summaries
  // when `reasoning.summary` is absent, so opt this internal conversion into visible summaries
  // even when the Chat Completions caller did not specify a reasoning effort.
  const reasoning = {
    summary: "auto",
    ...(typeof body.reasoning_effort === "string" ? { effort: body.reasoning_effort } : {}),
  };
  const maxOutputTokens = typeof body.max_completion_tokens === "number"
    ? body.max_completion_tokens
    : typeof body.max_tokens === "number"
      ? body.max_tokens
      : undefined;
  const responsesBody: JsonObject = {
    model: body.model,
    input: responseInput(body.messages),
    stream,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof body.presence_penalty === "number" ? { presence_penalty: body.presence_penalty } : {}),
    ...(typeof body.frequency_penalty === "number" ? { frequency_penalty: body.frequency_penalty } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    reasoning,
    ...(typeof body.user === "string" ? { user: body.user } : {}),
  };
  const textualXmlToolProtocol = hasTextualXmlToolProtocol(body.messages);
  const conversationId = chatCompletionsConversationId(body);
  return {
    responsesBody,
    stream,
    includeUsage: isObject(body.stream_options) && body.stream_options.include_usage === true,
    textualXmlToolProtocol,
    ...(conversationId ? { conversationId } : {}),
  };
}

function responseUsage(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const promptTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const completionTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(isObject(value.input_tokens_details) ? { prompt_tokens_details: value.input_tokens_details } : {}),
    ...(isObject(value.output_tokens_details) ? { completion_tokens_details: value.output_tokens_details } : {}),
  };
}

function chatFinishReason(response: JsonObject, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  const incomplete = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
  if (incomplete === "max_output_tokens") return "length";
  if (incomplete === "content_filter") return "content_filter";
  return "stop";
}

function normalizeEscapedXmlTagNames(text: string): string {
  return text.replace(/<\/?[A-Za-z][A-Za-z0-9_\\-]*>/g, tag => tag.replace(/\\_/g, "_"));
}

class StreamingXmlTagNameNormalizer {
  private pending = "";

  push(text: string): string {
    this.pending += text;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (this.pending.length > 0) {
      const open = this.pending.indexOf("<");
      if (open < 0) {
        output += this.pending;
        this.pending = "";
        break;
      }
      output += this.pending.slice(0, open);
      this.pending = this.pending.slice(open);
      const close = this.pending.indexOf(">");
      if (close < 0) {
        if (final || this.pending.includes("\n") || this.pending.length > 128) {
          output += this.pending;
          this.pending = "";
        }
        break;
      }
      const candidate = this.pending.slice(0, close + 1);
      output += normalizeEscapedXmlTagNames(candidate);
      this.pending = this.pending.slice(close + 1);
    }
    return output;
  }
}

function outputMessage(response: JsonObject, normalizeTextualToolTags = false): {
  content: string | null;
  reasoningContent: string | null;
  toolCalls: JsonObject[];
} {
  const content: string[] = [];
  const reasoningContent: string[] = [];
  const toolCalls: JsonObject[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const raw of output) {
    if (!isObject(raw)) continue;
    if (raw.type === "message" && raw.role === "assistant" && Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (!isObject(part) || part.type !== "output_text" || typeof part.text !== "string") continue;
        if (raw.phase === "commentary") reasoningContent.push(part.text);
        else content.push(part.text);
      }
    }
    if (raw.type === "reasoning" && Array.isArray(raw.summary)) {
      for (const part of raw.summary) {
        if (isObject(part) && part.type === "summary_text" && typeof part.text === "string") {
          reasoningContent.push(part.text);
        }
      }
    }
    if (raw.type === "function_call" && typeof raw.call_id === "string" && typeof raw.name === "string") {
      toolCalls.push({
        id: raw.call_id,
        type: "function",
        function: {
          name: raw.name,
          arguments: typeof raw.arguments === "string" ? raw.arguments : "{}",
        },
      });
    }
  }
  const joined = content.join("");
  const joinedReasoning = reasoningContent.join("");
  return {
    content: joined.length > 0 ? (normalizeTextualToolTags ? normalizeEscapedXmlTagNames(joined) : joined) : null,
    reasoningContent: joinedReasoning.length > 0 ? joinedReasoning : null,
    toolCalls,
  };
}

export function responsesToChatCompletion(
  response: JsonObject,
  requestedModel: string,
  normalizeTextualToolTags = false,
): JsonObject {
  const { content, reasoningContent, toolCalls } = outputMessage(response, normalizeTextualToolTags);
  const created = typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000);
  const id = typeof response.id === "string" ? `chatcmpl_${response.id.replace(/^resp_/, "")}` : `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  return {
    id,
    object: "chat.completion",
    created,
    model: typeof response.model === "string" ? response.model : requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: chatFinishReason(response, toolCalls.length > 0),
      logprobs: null,
    }],
    ...(responseUsage(response.usage) ? { usage: responseUsage(response.usage) } : {}),
  };
}

function sseFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function responsesSseToChatCompletions(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  includeUsage: boolean,
  normalizeTextualToolTags = false,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const itemPhases = new Map<string, unknown>();
  const toolIndexes = new Map<string, number>();
  let nextToolIndex = 0;
  let sawToolCall = false;
  let roleEmitted = false;
  let buffer = "";
  const xmlTagNormalizer = normalizeTextualToolTags ? new StreamingXmlTagNameNormalizer() : undefined;

  const chunk = (delta: JsonObject, finishReason: string | null, usage?: JsonObject) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emitRole = () => {
        if (roleEmitted) return;
        roleEmitted = true;
        controller.enqueue(sseFrame(chunk({ role: "assistant", content: "" }, null)));
      };
      const emitText = (text: string) => {
        if (!text) return;
        emitRole();
        controller.enqueue(sseFrame(chunk({ content: text }, null)));
      };
      const emitReasoning = (text: string) => {
        if (!text) return;
        emitRole();
        controller.enqueue(sseFrame(chunk({ reasoning_content: text }, null)));
      };
      const flushTextNormalizer = () => {
        if (!xmlTagNormalizer) return;
        emitText(xmlTagNormalizer.flush());
      };
      const processEvent = (event: JsonObject) => {
        const type = event.type;
        if (type === "response.output_item.added" && isObject(event.item)) {
          const item = event.item;
          if (item.type === "message" && typeof item.id === "string") itemPhases.set(item.id, item.phase);
          if (item.type === "function_call" && typeof item.id === "string" && typeof item.call_id === "string" && typeof item.name === "string") {
            emitRole();
            const index = nextToolIndex++;
            toolIndexes.set(item.id, index);
            sawToolCall = true;
            controller.enqueue(sseFrame(chunk({
              tool_calls: [{
                index,
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: "" },
              }],
            }, null)));
          }
          return;
        }
        if (type === "response.output_text.delta" && typeof event.item_id === "string" && typeof event.delta === "string") {
          if (itemPhases.get(event.item_id) === "commentary") {
            emitReasoning(event.delta);
            return;
          }
          emitText(xmlTagNormalizer ? xmlTagNormalizer.push(event.delta) : event.delta);
          return;
        }
        if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
          emitReasoning(event.delta);
          return;
        }
        if (type === "response.function_call_arguments.delta" && typeof event.item_id === "string" && typeof event.delta === "string") {
          const index = toolIndexes.get(event.item_id);
          if (index === undefined) return;
          emitRole();
          controller.enqueue(sseFrame(chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }, null)));
          return;
        }
        if (type === "response.completed" || type === "response.incomplete") {
          flushTextNormalizer();
          emitRole();
          const response = isObject(event.response) ? event.response : {};
          const finishReason = chatFinishReason(response, sawToolCall);
          controller.enqueue(sseFrame(chunk({}, finishReason)));
          const usage = responseUsage(response.usage);
          if (includeUsage && usage) {
            controller.enqueue(sseFrame({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [], usage }));
          }
          controller.enqueue(sseFrame("[DONE]"));
          return "terminal";
        }
        if (type === "response.failed") {
          flushTextNormalizer();
          const response = isObject(event.response) ? event.response : {};
          const error = isObject(response.error) ? response.error : { message: "LCA Token Chat Completions stream failed", type: "server_error" };
          controller.enqueue(sseFrame({ error }));
          controller.enqueue(sseFrame("[DONE]"));
          return "terminal";
        }
      };

      try {
        let terminal = false;
        while (!terminal) {
          const next = await reader.read();
          buffer += decoder.decode(next.value, { stream: !next.done });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLines = frame.split(/\r?\n/).filter(line => line.startsWith("data:"));
            if (dataLines.length === 0) continue;
            const data = dataLines.map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            let event: unknown;
            try { event = JSON.parse(data); } catch { continue; }
            if (isObject(event) && processEvent(event) === "terminal") {
              terminal = true;
              break;
            }
          }
          if (next.done) break;
        }
        if (terminal) await reader.cancel().catch(() => {});
        if (!terminal) {
          flushTextNormalizer();
          emitRole();
          controller.enqueue(sseFrame(chunk({}, sawToolCall ? "tool_calls" : "stop")));
          controller.enqueue(sseFrame("[DONE]"));
        }
        controller.close();
      } catch (error) {
        controller.enqueue(sseFrame({ error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } }));
        controller.enqueue(sseFrame("[DONE]"));
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
