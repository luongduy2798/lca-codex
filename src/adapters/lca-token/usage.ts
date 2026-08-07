import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import type { CompiledLcaTokenPrompt } from "./prompt";
import { compileLcaTokenPrompt } from "./prompt";
import { resolveLcaTokenModelMode, type LcaTokenCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

// ChatGPT's product system prompt and the fixed lca-token MCP schemas are not present in the
// visible composer text. Reserve them explicitly; over-counting fails safe by compacting earlier.
const CHATGPT_PLATFORM_RESERVE_TOKENS = 8_192;
const CHATGPT_IMAGE_RESERVE_TOKENS = 4_096;
const CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;

export interface LcaTokenRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateCompiledLcaTokenInputTokens(
  compiled: CompiledLcaTokenPrompt,
  modelId: string,
): number {
  const imageTokens = compiled.images.reduce(
    (total, image) => total + (image.detail === "original"
      ? CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS
      : CHATGPT_IMAGE_RESERVE_TOKENS),
    0,
  );
  return CHATGPT_PLATFORM_RESERVE_TOKENS
    + conservativeTextTokens(compiled.text, modelId)
    + (compiled.contextInputTokens ?? 0)
    + imageTokens;
}

export function estimateLcaTokenInputTokens(
  parsed: CodexParsedRequest,
  capabilities: LcaTokenCapabilities,
): number {
  const mode = resolveLcaTokenModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const compiled = compileLcaTokenPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
  );
  return estimateCompiledLcaTokenInputTokens(compiled, parsed.modelId);
}

function roundEvidenceText(evidence: LcaTokenRoundEvidence): string {
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

export function estimateLcaTokenUsage(
  parsed: CodexParsedRequest,
  evidence: LcaTokenRoundEvidence,
  capabilities: LcaTokenCapabilities,
): CodexUsage {
  const inputTokens = estimateLcaTokenInputTokens(parsed, capabilities);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
