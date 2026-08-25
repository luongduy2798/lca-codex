import { describe, expect, test } from "bun:test";
import { interruptServiceTurns, negotiateDrain, serviceHealthIsReady } from "../src/service";

describe("service drain lifecycle", () => {
  test("compensates when a drain may have reached the daemon before the client times out", async () => {
    const actions: string[] = [];
    let acceptingTurns = true;
    const control = async (action: "drain" | "resume") => {
      actions.push(action);
      acceptingTurns = action === "resume";
      if (action === "drain") throw new Error("request timed out after delivery");
      return { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    };

    await expect(negotiateDrain(control)).rejects.toThrow("atomic idleness could not be proven");
    expect(actions).toEqual(["drain", "resume"]);
    expect(acceptingTurns).toBe(true);
  });

  test("releases a verified idle drain", async () => {
    const actions: string[] = [];
    const lease = await negotiateDrain(async action => {
      actions.push(action);
      return action === "drain"
        ? { accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }
        : { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    });
    expect(actions).toEqual(["drain"]);
    await lease.release();
    expect(actions).toEqual(["drain", "resume"]);
  });

  test("authoritative lifecycle cancels active browser turns instead of refusing the operation", async () => {
    const actions: string[] = [];
    const cancelled = await interruptServiceTurns(async action => {
      actions.push(action);
      return action === "drain"
        ? { accepting_turns: false, active_http_turns: 2, active_browser_turns: 3 }
        : { cancelled_browser_turns: 3, active_http_turns: 2, active_browser_turns: 0 };
    });

    expect(actions).toEqual(["drain", "cancel-browser-turns"]);
    expect(cancelled).toBe(3);
  });

  test("authoritative lifecycle still permits the hard service stop when graceful control is unavailable", async () => {
    const actions: string[] = [];
    const cancelled = await interruptServiceTurns(async action => {
      actions.push(action);
      throw new Error("control endpoint unavailable");
    });

    expect(actions).toEqual(["drain", "cancel-browser-turns"]);
    expect(cancelled).toBe(0);
  });
});

test("service readiness requires a matching accepting daemon and broker", () => {
  const config = { mode: "full" as const, releaseVersion: "0.2.0" };
  const ready = {
    service: "lca-token",
    status: "ok",
    mode: "full",
    version: "0.2.0",
    accepting_turns: true,
    broker_ready: true,
  };

  expect(serviceHealthIsReady(ready, config)).toBe(true);
  expect(serviceHealthIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(serviceHealthIsReady({ ...ready, broker_ready: false }, config)).toBe(false);
  expect(serviceHealthIsReady({ ...ready, version: "0.1.0" }, config)).toBe(false);
});
