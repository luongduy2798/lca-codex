import { expect, test } from "bun:test";
import {
  estimateLcaCodexBrowserEffectiveInputTokens,
  estimateLcaCodexNativeContextTokens,
  estimateLcaCodexUsage,
} from "../src/adapters/lca-codex/usage";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: false, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("large inline prompts use tokenizer-derived usage without invented composer pressure", () => {
  const estimated = estimateLcaCodexBrowserEffectiveInputTokens(request("a".repeat(480_000)), capabilities);

  expect(estimated).toBeLessThan(100_000);
});

test("ordinary context below the transport threshold keeps its tokenizer-derived usage", () => {
  const estimated = estimateLcaCodexBrowserEffectiveInputTokens(
    request(`${"word ".repeat(79_999)}word`),
    capabilities,
  );

  expect(estimated).toBeLessThan(100_000);
});

test("native Codex usage stays independent from bounded browser effective input", () => {
  const parsed = request("current request");
  parsed.context.messages.unshift(
    { role: "user", content: "old context ".repeat(70_000), timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
  );
  const toolCapabilities = { localToolsEnabled: true, proAvailable: true };

  const browserInput = estimateLcaCodexBrowserEffectiveInputTokens(parsed, toolCapabilities);
  const nativeContext = estimateLcaCodexNativeContextTokens(parsed);
  const usage = estimateLcaCodexUsage(parsed, { answer: "done" }, toolCapabilities);

  expect(nativeContext).toBeGreaterThan(browserInput);
  expect(usage.inputTokens).toBe(nativeContext);
  expect(usage.totalTokens).toBe(nativeContext + usage.outputTokens);
});
