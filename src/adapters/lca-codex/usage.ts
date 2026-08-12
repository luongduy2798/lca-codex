import { estimateTokens } from "../../lib/token-estimate";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage, CodexParsedRequest, CodexUsage } from "../../types";
import type { CompiledLcaCodexPrompt } from "./prompt";
import { compileLcaCodexPrompt } from "./prompt";
import { resolveLcaCodexModelMode, type LcaCodexCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

// ChatGPT's product system prompt and the fixed lca-codex MCP schemas are not present in the
// visible composer text. Reserve them explicitly so the browser hard gate remains conservative.
const CHATGPT_PLATFORM_RESERVE_TOKENS = 8_192;
export const CHATGPT_IMAGE_SAFETY_RESERVE_TOKENS = 20_000;

export interface LcaCodexRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateCompiledBrowserEffectiveInputTokens(
  compiled: CompiledLcaCodexPrompt,
  modelId: string,
): number {
  const imageTokens = compiled.images.reduce(
    total => total + CHATGPT_IMAGE_SAFETY_RESERVE_TOKENS,
    0,
  );
  return CHATGPT_PLATFORM_RESERVE_TOKENS
    + conservativeTextTokens(compiled.text, modelId)
    + (compiled.contextInputTokens ?? 0)
    + imageTokens;
}

export function estimateLcaCodexBrowserEffectiveInputTokens(
  parsed: CodexParsedRequest,
  capabilities: LcaCodexCapabilities,
): number {
  const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const compiled = compileLcaCodexPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
  );
  return estimateCompiledBrowserEffectiveInputTokens(compiled, parsed.modelId);
}

function nativeInputContent(content: string | CodexContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map(part => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", ...(part.detail ? { detail: part.detail } : {}) });
}

function nativeAssistantContent(content: CodexAssistantContentPart[]): unknown[] {
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") return { type: "thinking", text: part.thinking };
    return {
      type: "tool_call",
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      ...(part.namespace ? { namespace: part.namespace } : {}),
    };
  });
}

function nativeMessageEnvelope(message: CodexMessage): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      ...(message.toolNamespace ? { tool_namespace: message.toolNamespace } : {}),
      is_error: message.isError,
      content: nativeInputContent(message.content),
    };
  }
  if (message.role === "assistant") {
    return { role: "assistant", content: nativeAssistantContent(message.content) };
  }
  return { role: message.role, content: nativeInputContent(message.content) };
}

/**
 * Estimate the full active context owned by native Codex, independently of the bounded/lazy
 * ChatGPT browser projection. This is the number Responses usage exposes back to Codex for context
 * accounting/UI. Image bytes and opaque reasoning signatures are intentionally represented only by
 * their semantic placeholders; the bridge has no authoritative native tokenizer count for them.
 */
export function estimateLcaCodexNativeContextTokens(parsed: CodexParsedRequest): number {
  const nativeContext = {
    system: parsed.context.systemPrompt ?? [],
    messages: parsed.context.messages.map(nativeMessageEnvelope),
    tools: parsed.context.tools ?? [],
  };
  return conservativeTextTokens(JSON.stringify(nativeContext), parsed.modelId);
}

function roundEvidenceText(evidence: LcaCodexRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateLcaCodexUsage(
  parsed: CodexParsedRequest,
  evidence: LcaCodexRoundEvidence,
  capabilities: LcaCodexCapabilities,
): CodexUsage {
  // Browser effective-input pressure is checked separately before submission. Responses usage is
  // consumed by native Codex as active-context accounting, so report the full outer Codex context
  // here rather than the bounded/lazy ChatGPT prompt size.
  void capabilities;
  const inputTokens = estimateLcaCodexNativeContextTokens(parsed);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
