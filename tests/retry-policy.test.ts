import { expect, test } from "bun:test";
import { LcaCodexAdapterError } from "../src/adapters/lca-codex/adapter-error";
import { resolveBrowserRetryPolicy } from "../src/adapters/lca-codex/retry-policy";

test("product usage limits stay native-retryable without authorizing a fresh browser generation", () => {
  const policy = resolveBrowserRetryPolicy(new LcaCodexAdapterError("rate limited", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  }), false);

  expect(policy).toEqual({
    providerRetryable: true,
    browserGenerationAllowed: false,
    nativeRetryableWithoutBrowserGeneration: true,
    stopReason: "usage_limit",
    usageLimited: true,
  });
});

test("transient provider failures may authorize one bounded browser generation retry", () => {
  const policy = resolveBrowserRetryPolicy(new LcaCodexAdapterError("temporary upstream failure", {
    status: 503,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  }), false);

  expect(policy.browserGenerationAllowed).toBe(true);
  expect(policy.nativeRetryableWithoutBrowserGeneration).toBe(false);
  expect(policy.stopReason).toBe("retry_limit");
});

test("append-only final output makes every fresh browser generation terminal", () => {
  const policy = resolveBrowserRetryPolicy(new LcaCodexAdapterError("temporary upstream failure", {
    status: 503,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  }), true);

  expect(policy.providerRetryable).toBe(true);
  expect(policy.browserGenerationAllowed).toBe(false);
  expect(policy.nativeRetryableWithoutBrowserGeneration).toBe(false);
  expect(policy.stopReason).toBe("response_streamed");
});
