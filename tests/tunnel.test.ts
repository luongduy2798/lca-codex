import { describe, expect, test } from "bun:test";
import { parseTunnelAliasMetadata, parseTunnelStatus, tunnelCommandOutput, tunnelConnectLaunchError } from "../src/tunnel";

describe("tunnel status boundary", () => {
  test("requires the managed runtime process, health, and readiness together", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toMatchObject({ ok: false, processRunning: false, healthy: true, ready: true });
  });

  test("accepts a healthy ready service-owned runtime when connect bookkeeping says stopped", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "stopped",
      remote_lookup_attempted: true,
      remote: { id: "tunnel_0123456789abcdef0123456789abcdef" },
      local: {
        issues: ["runtime log exists but no active runtime is running"],
      },
    }), 0, true)).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true source=managed-service healthy=true ready=true",
    });
  });

  test("keeps an explicitly stopped unmanaged runtime not ready", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "stopped",
    }))).toMatchObject({
      ok: false,
      processRunning: false,
      healthy: true,
      ready: false,
      state: "stopped",
    });
  });

  test("still accepts a service-owned runtime when status says ready and only process bookkeeping is stale", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }), 0, true)).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true source=managed-service healthy=true ready=true",
    });
  });

  test("fails closed when local health is stale but the remote tunnel lookup failed", () => {
    const result = parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "stopped",
      remote: null,
      remote_lookup_attempted: true,
      remote_error: "403 tunnel_active_organization_required for tunnel_0123456789abcdef0123456789abcdef",
    }), 0, true);

    expect(result).toMatchObject({
      ok: false,
      processRunning: false,
      healthy: true,
      ready: false,
      state: "stopped",
    });
    expect(result.detail).toContain("remote_error=403 tunnel_active_organization_required for [tunnel-id]");
  });

  test("extracts stale tunnel identity and organization repair hints from tunnel-client status", () => {
    expect(parseTunnelAliasMetadata(JSON.stringify({
      tunnel_id: "tunnel_0123456789abcdef0123456789abcdef",
      remote_error: "403 tunnel_active_organization_required: active organization context required",
      next_steps: [
        "tunnel-client runtimes connect --alias lca-token-test --organization-id org-Test123 --mcp-command test",
      ],
    }))).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      organizationId: "org-Test123",
      organizationRequired: true,
    });
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      1,
    );
    expect(result.detail).toBe("failed [tunnel-id] with [redacted-key]");
    expect(result.detail).not.toContain("0123456789abcdef");
  });

  test("surfaces and redacts an immediate managed-runtime launch failure", () => {
    const detail = tunnelConnectLaunchError(JSON.stringify({
      running: false,
      healthy: false,
      ready: false,
      exit_code: 1,
      launch_diagnostics: {
        log_tail: "403 for tunnel_0123456789abcdef0123456789abcdef using sk-secretsecretsecret",
      },
    }));

    expect(detail).toBe(
      "running=false; healthy=false; ready=false; exit_code=1; runtime_log=403 for [tunnel-id] using [redacted-key]",
    );
  });

  test("requires connect to prove running, healthy, and ready before accepting its profile", () => {
    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: true,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: false,
    }))).toContain("running=true; healthy=true; ready=false");

    expect(tunnelConnectLaunchError("not json")).toBe("tunnel-client returned non-JSON connect output");
  });

  test("includes the managed runtime log tail in stopped status diagnostics", () => {
    const result = parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: false,
      ready: false,
      runtime_state: "stopped",
      local: {
        issues: ["recorded process pid is not running"],
        log: {
          tail: "runtime startup failed with sk-secretsecretsecret",
        },
      },
    }));

    expect(result.detail).toContain("runtime_log=runtime startup failed with [redacted-key]");
    expect(result.detail).not.toContain("sk-secret");
  });

  test("status diagnostics do not discard stderr when a failed command also wrote stdout", () => {
    expect(tunnelCommandOutput({
      status: 1,
      stdout: '{"partial":true}',
      stderr: "runtime process exited with status 1",
    })).toBe('runtime process exited with status 1\n{"partial":true}');
    expect(tunnelCommandOutput({
      status: 0,
      stdout: '{"ready":true}',
      stderr: "non-fatal warning",
    })).toBe('{"ready":true}');
  });
});
