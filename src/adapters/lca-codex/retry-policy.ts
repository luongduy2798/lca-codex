import { LcaCodexAdapterError } from "./adapter-error";

export type BrowserRetryStopReason = "response_streamed" | "usage_limit" | "retry_limit";

export interface BrowserRetryPolicy {
  providerRetryable: boolean;
  browserGenerationAllowed: boolean;
  nativeRetryableWithoutBrowserGeneration: boolean;
  stopReason: BrowserRetryStopReason;
  usageLimited: boolean;
}

export function isProductUsageLimit(error: LcaCodexAdapterError): boolean {
  return error.status === 429
    || error.errorType === "rate_limit_error"
    || error.code === "rate_limit_exceeded"
    || error.code === "insufficient_quota"
    || error.code === "subscription_required";
}

export function resolveBrowserRetryPolicy(error: unknown, responseStreamed: boolean): BrowserRetryPolicy {
  const providerRetryable = error instanceof LcaCodexAdapterError && error.retryable;
  const usageLimited = error instanceof LcaCodexAdapterError && isProductUsageLimit(error);
  const browserGenerationAllowed = providerRetryable && !usageLimited && !responseStreamed;
  return {
    providerRetryable,
    browserGenerationAllowed,
    // A product usage limit remains retryable to native Codex so it may respect provider
    // backoff/user timing, but LCA itself must never open a second Temporary Chat to evade it.
    nativeRetryableWithoutBrowserGeneration: providerRetryable && usageLimited && !responseStreamed,
    stopReason: responseStreamed ? "response_streamed" : usageLimited ? "usage_limit" : "retry_limit",
    usageLimited,
  };
}
