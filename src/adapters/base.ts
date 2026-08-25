import type { AdapterEvent, CodexParsedRequest } from "../types";

export type AgentRequestTransport = "responses" | "chat_completions";

export interface AgentRequestContext {
  /** Stable for one logical Responses turn, including its function_call_output continuations. */
  executionId: string;
  /** Public generic transport that originated this browser turn. */
  transport: AgentRequestTransport;
  /** Optional transport task identity for continuation bookkeeping; never browser-page affinity. */
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
