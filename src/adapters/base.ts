import type { AdapterEvent, CodexParsedRequest } from "../types";

export type AgentRequestTransport = "responses" | "chat_completions" | "anthropic_messages";

export interface AgentRequestContext {
  /** Stable for one logical Responses turn, including its function_call_output continuations. */
  executionId: string;
  /** Public generic transport that originated this browser turn. */
  transport: AgentRequestTransport;
  /** Stable logical-task identity used for outer-harness lineage and continuation bookkeeping. */
  conversationId?: string;
}

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
  /** Present only on authenticated generic agent routes. */
  agentRequest?: AgentRequestContext;
}

export interface ProviderAdapter {
  name: string;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
