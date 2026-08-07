import { expect, test } from "bun:test";
import { LCA_TOKEN_MODEL_ID, resolveLcaTokenModelMode } from "../src/adapters/lca-token/model";

test("the browser adapter maps fixed routed efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, proAvailable: true };
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "low", capabilities)).toMatchObject({
    displayLabel: "Instant",
    uiEffortIndex: 0,
    localTools: true,
  });
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "medium", capabilities)).toMatchObject({
    uiEffortIndex: 1,
    localTools: true,
  });
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "high", capabilities)).toMatchObject({
    uiEffortIndex: 2,
    localTools: true,
  });
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "xhigh", capabilities)).toMatchObject({
    uiEffortIndex: 3,
    localTools: true,
  });
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "max", capabilities)).toMatchObject({
    uiEffortIndex: 4,
    localTools: false,
  });
});

test("capabilities gate tools and Pro-only efforts explicitly without changing the selected model", () => {
  expect(resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "high", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toMatchObject({ localTools: false });
  expect(() => resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "max", {
    localToolsEnabled: false,
    proAvailable: false,
  })).toThrow("Pro effort is not available");
  expect(() => resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "xhigh", {
    localToolsEnabled: true,
    proAvailable: false,
  })).toThrow("Extra High effort is not available");
  expect(() => resolveLcaTokenModelMode("unknown", "high", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveLcaTokenModelMode(LCA_TOKEN_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    proAvailable: true,
  })).toThrow("effort is not supported");
});
