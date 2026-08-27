/**
 * Browser execution concurrency is deliberately bounded. Every live model execution owns one
 * isolated Temporary Chat page until its page-owned WebSocket completion arrives, so unbounded
 * harness fan-out would create unbounded signed-in browser state and account traffic.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;
