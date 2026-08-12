import { estimateTokens } from "../../lib/token-estimate";
import type { CodexParsedRequest, CodexUsage } from "../../types";
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

export function estimateCompiledLcaCodexInputTokens(
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

export function estimateLcaCodexInputTokens(
  parsed: CodexParsedRequest,
  capabilities: LcaCodexCapabilities,
): number {
  const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const compiled = compileLcaCodexPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
  );
  return estimateCompiledLcaCodexInputTokens(compiled, parsed.modelId);
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
  const inputTokens = estimateLcaCodexInputTokens(parsed, capabilities);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
