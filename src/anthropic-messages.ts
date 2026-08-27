import { randomUUID } from "node:crypto";
import { estimateTokens } from "./lib/token-estimate";
import { responsesToChatCompletion } from "./chat-completions";
import { PRODUCT_ID } from "./product";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textBlocks(value: unknown, source: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error(`${source} must be a string or an array of content blocks`);
  return value.map((block, index) => {
    if (!isObject(block)) throw new Error(`${source}[${index}] must be an object`);
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "thinking" || block.type === "redacted_thinking") return "";
    throw new Error(`Unsupported ${source} content block: ${String(block.type ?? "missing type")}`);
  }).join("");
}

function imageInput(block: JsonObject, source: string): JsonObject {
  if (!isObject(block.source) || block.source.type !== "base64") {
    throw new Error(`${source} currently supports only base64 image sources`);
  }
  if (typeof block.source.media_type !== "string" || typeof block.source.data !== "string") {
    throw new Error(`${source} base64 image source requires media_type and data`);
  }
  return {
    type: "input_image",
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
  };
}

function toolResultOutput(value: unknown, source: string): string | JsonObject[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error(`${source} must be a string or an array of content blocks`);
  return value.map((block, index) => {
    if (!isObject(block)) throw new Error(`${source}[${index}] must be an object`);
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "input_text", text: block.text };
    }
    if (block.type === "image") return imageInput(block, `${source}[${index}]`);
    throw new Error(`Unsupported ${source} content block: ${String(block.type ?? "missing type")}`);
  });
}

function userContent(value: unknown, source: string): JsonObject[] {
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (!Array.isArray(value)) throw new Error(`${source} must be a string or an array of content blocks`);
  const input: JsonObject[] = [];
  const ordinary: JsonObject[] = [];
  const flushOrdinary = () => {
    if (ordinary.length === 0) return;
    input.push({ role: "user", content: ordinary.splice(0) });
  };
  for (let index = 0; index < value.length; index += 1) {
    const block = value[index];
    if (!isObject(block)) throw new Error(`${source}[${index}] must be an object`);
    if (block.type === "text" && typeof block.text === "string") {
      ordinary.push({ type: "input_text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      ordinary.push(imageInput(block, `${source}[${index}]`));
      continue;
    }
    if (block.type === "tool_result") {
      if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
        throw new Error(`${source}[${index}] tool_result requires tool_use_id`);
      }
      flushOrdinary();
      input.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: toolResultOutput(block.content ?? "", `${source}[${index}].content`),
      });
      continue;
    }
    throw new Error(`Unsupported ${source} content block: ${String(block.type ?? "missing type")}`);
  }
  flushOrdinary();
  return input;
}

function assistantContent(value: unknown, source: string): JsonObject[] {
  if (typeof value === "string") return value ? [{ role: "assistant", content: value }] : [];
  if (!Array.isArray(value)) throw new Error(`${source} must be a string or an array of content blocks`);
  const input: JsonObject[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    input.push({ role: "assistant", content: text });
    text = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const block = value[index];
    if (!isObject(block)) throw new Error(`${source}[${index}] must be an object`);
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name) {
        throw new Error(`${source}[${index}] tool_use requires id and name`);
      }
      flushText();
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
      });
      continue;
    }
    throw new Error(`Unsupported ${source} content block: ${String(block.type ?? "missing type")}`);
  }
  flushText();
  return input;
}

function responseInput(body: JsonObject): JsonObject[] {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Anthropic Messages requires a non-empty messages array");
  }
  const input: JsonObject[] = [];
  if (body.system !== undefined) {
    const system = textBlocks(body.system, "system");
    if (system) input.push({ role: "system", content: system });
  }
  for (let index = 0; index < body.messages.length; index += 1) {
    const message = body.messages[index];
    if (!isObject(message)) {
      throw new Error(`messages[${index}] must have role user or assistant`);
    }
    // Some Claude Code compatibility layers may send internal developer
    // instructions in the messages array instead of the top-level system
    // field. Anthropic's public Messages contract only exposes user and
    // assistant roles, so normalize those instructions without forwarding an
    // invalid role to the Responses core.
    if (message.role === "developer" || message.role === "system") {
      const system = textBlocks(message.content, `messages[${index}].content`);
      if (system) input.push({ role: "system", content: system });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`messages[${index}] must have role user or assistant`);
    }
    input.push(...(message.role === "user"
      ? userContent(message.content, `messages[${index}].content`)
      : assistantContent(message.content, `messages[${index}].content`)));
  }
  return input;
}

function responseTools(value: unknown): JsonObject[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  return value.map((tool, index) => {
    if (!isObject(tool) || typeof tool.name !== "string" || !tool.name) {
      throw new Error(`tools[${index}] requires name`);
    }
    return {
      type: "function",
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: isObject(tool.input_schema) ? tool.input_schema : {},
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    };
  });
}

function responseToolChoice(value: unknown): { choice?: unknown; parallel?: boolean } {
  if (value === undefined) return {};
  if (!isObject(value) || typeof value.type !== "string") throw new Error("tool_choice must be an object");
  const parallel = value.disable_parallel_tool_use === true ? false : undefined;
  if (value.type === "auto") return { choice: "auto", ...(parallel === undefined ? {} : { parallel }) };
  if (value.type === "any") return { choice: "required", ...(parallel === undefined ? {} : { parallel }) };
  if (value.type === "none") return { choice: "none", ...(parallel === undefined ? {} : { parallel }) };
  if (value.type === "tool" && typeof value.name === "string" && value.name) {
    return { choice: { type: "function", name: value.name }, ...(parallel === undefined ? {} : { parallel }) };
  }
  throw new Error(`Unsupported Anthropic tool_choice type: ${value.type}`);
}

function reasoningEffort(body: JsonObject): string | undefined {
  if (!isObject(body.output_config) || typeof body.output_config.effort !== "string") return undefined;
  const effort = body.output_config.effort;
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "max") return "xhigh";
  return undefined;
}

export interface AnthropicMessagesConversion {
  responsesBody: JsonObject;
  requestedModel: string;
  stream: boolean;
}

export function anthropicMessagesToResponses(body: unknown): AnthropicMessagesConversion {
  if (!isObject(body)) throw new Error("Anthropic Messages request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model) throw new Error("Anthropic Messages requires model");
  if (typeof body.max_tokens !== "number" || !Number.isFinite(body.max_tokens) || body.max_tokens <= 0) {
    throw new Error("Anthropic Messages requires a positive max_tokens value");
  }
  const tools = responseTools(body.tools);
  const toolChoice = responseToolChoice(body.tool_choice);
  const effort = reasoningEffort(body);
  return {
    requestedModel: body.model,
    stream: body.stream === true,
    responsesBody: {
      model: PRODUCT_ID,
      input: responseInput(body),
      stream: body.stream === true,
      ...(tools ? { tools } : {}),
      ...(toolChoice.choice !== undefined ? { tool_choice: toolChoice.choice } : {}),
      ...(toolChoice.parallel !== undefined ? { parallel_tool_calls: toolChoice.parallel } : {}),
      max_output_tokens: Math.floor(body.max_tokens),
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
      ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {}),
      ...(effort ? { reasoning: { effort, summary: "auto" } } : { reasoning: { summary: "auto" } }),
    },
  };
}

export function anthropicInputTokenCount(body: unknown): number {
  const source = isObject(body) ? body : {};
  const converted = anthropicMessagesToResponses({
    ...source,
    max_tokens: typeof source.max_tokens === "number" ? source.max_tokens : 1,
    stream: false,
  });
  const canonical = JSON.stringify({
    input: converted.responsesBody.input,
    tools: converted.responsesBody.tools,
  });
  return estimateTokens(canonical);
}

function anthropicUsage(value: unknown): JsonObject {
  const usage = isObject(value) ? value : {};
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    ...(isObject(usage.input_tokens_details) && typeof usage.input_tokens_details.cached_tokens === "number"
      ? { cache_read_input_tokens: usage.input_tokens_details.cached_tokens }
      : {}),
  };
}

function stopReason(response: JsonObject, hasTools: boolean): string {
  if (hasTools) return "tool_use";
  const incomplete = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
  if (incomplete === "max_output_tokens") return "max_tokens";
  if (incomplete === "content_filter") return "refusal";
  return "end_turn";
}

export function responsesToAnthropicMessage(response: JsonObject, requestedModel: string): JsonObject {
  const chat = responsesToChatCompletion(response, requestedModel);
  const choice = Array.isArray(chat.choices) && isObject(chat.choices[0]) ? chat.choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  const content: JsonObject[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isObject(raw) || typeof raw.id !== "string" || !isObject(raw.function) || typeof raw.function.name !== "string") continue;
      let input: unknown = {};
      if (typeof raw.function.arguments === "string") {
        try { input = JSON.parse(raw.function.arguments); } catch { input = {}; }
      }
      content.push({ type: "tool_use", id: raw.id, name: raw.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason(response, content.some(block => block.type === "tool_use")),
    stop_sequence: null,
    usage: anthropicUsage(response.usage),
  };
}

function sseEvent(type: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function responsesSseToAnthropicMessages(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  const itemKinds = new Map<string, "text" | "tool">();
  const itemIndexes = new Map<string, number>();
  const openBlocks = new Set<number>();
  let nextIndex = 0;
  let sawTool = false;
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      const startText = (itemId: string): number => {
        const existing = itemIndexes.get(itemId);
        if (existing !== undefined) return existing;
        const index = nextIndex++;
        itemIndexes.set(itemId, index);
        openBlocks.add(index);
        controller.enqueue(sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }));
        return index;
      };
      const stopBlock = (index: number) => {
        if (!openBlocks.delete(index)) return;
        controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
      };
      const processEvent = (event: JsonObject): "terminal" | undefined => {
        const type = event.type;
        if (type === "response.heartbeat") {
          controller.enqueue(sseEvent("ping", { type: "ping" }));
          return;
        }
        if (type === "response.output_item.added" && isObject(event.item) && typeof event.item.id === "string") {
          const item = event.item;
          const itemId = item.id as string;
          if (item.type === "message") itemKinds.set(itemId, "text");
          if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
            const index = nextIndex++;
            itemKinds.set(itemId, "tool");
            itemIndexes.set(itemId, index);
            openBlocks.add(index);
            sawTool = true;
            controller.enqueue(sseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: item.call_id, name: item.name, input: {} },
            }));
          }
          return;
        }
        if (type === "response.output_text.delta" && typeof event.item_id === "string" && typeof event.delta === "string") {
          if (itemKinds.get(event.item_id) !== "text") return;
          const index = startText(event.item_id);
          controller.enqueue(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: event.delta },
          }));
          return;
        }
        if (type === "response.function_call_arguments.delta" && typeof event.item_id === "string" && typeof event.delta === "string") {
          const index = itemIndexes.get(event.item_id);
          if (index === undefined) return;
          controller.enqueue(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: event.delta },
          }));
          return;
        }
        if (type === "response.output_item.done" && isObject(event.item) && typeof event.item.id === "string") {
          const index = itemIndexes.get(event.item.id);
          if (index !== undefined) stopBlock(index);
          return;
        }
        if (type === "response.completed" || type === "response.incomplete") {
          for (const index of [...openBlocks]) stopBlock(index);
          const response = isObject(event.response) ? event.response : {};
          const usage = anthropicUsage(response.usage);
          controller.enqueue(sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason(response, sawTool), stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
          }));
          controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
          return "terminal";
        }
        if (type === "response.failed") {
          const response = isObject(event.response) ? event.response : {};
          const error = isObject(response.error) ? response.error : {};
          controller.enqueue(sseEvent("error", {
            type: "error",
            error: {
              type: typeof error.type === "string" ? error.type : "api_error",
              message: typeof error.message === "string" ? error.message : "LCA Token Anthropic Messages stream failed",
            },
          }));
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
          for (const index of [...openBlocks]) stopBlock(index);
          controller.enqueue(sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: sawTool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          }));
          controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
        }
        controller.close();
      } catch (error) {
        controller.enqueue(sseEvent("error", {
          type: "error",
          error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
        }));
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
