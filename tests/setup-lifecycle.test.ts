import { expect, test } from "bun:test";
import { setupProxyIsReady } from "../src/setup";

const config = {
  mode: "full" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new agent turns", () => {
  const ready = {
    service: "lca-token",
    status: "ok",
    mode: "full",
    version: "0.2.0",
    accepting_turns: true,
    broker_ready: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, broker_ready: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});
