import type { ChatGptTurnEnvironment } from "./environment";

export type CodexToolHealthStatus = "working" | "available" | "failed" | "missing" | "unknown";

export interface CodexToolHealthItem {
  name: "exec_command" | "write_stdin" | "apply_patch" | "view_image";
  status: CodexToolHealthStatus;
  detail: string;
}

export interface CodexToolHealthReport {
  checkedAt: string;
  activeTurn: boolean;
  live: boolean;
  traceId: string | null;
  tools: CodexToolHealthItem[];
}

export interface CodexHealthToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export const CODEX_TOOL_HEALTH_ROUTE_NAMES = [
  "exec_command",
  "shell_command",
  "write_stdin",
  "apply_patch",
  "view_image",
] as const;

export const CODEX_TOOL_GATEWAY_READINESS_RETRY_DELAYS_MS = [0, 75, 150, 300] as const;

const CODEX_TOOL_HEALTH_REGISTRY_MARKER = "LCA_CODEX_TOOL_HEALTH_ROUTES:";

export function declaredCodexToolHealthRoutes(environment: ChatGptTurnEnvironment): {
  routes: Set<string>;
  gatewayAdvertised: boolean;
} {
  const routes = new Set(
    environment.tools
      .filter(tool => !tool.namespace)
      .map(tool => tool.name),
  );
  const gateway = environment.tools.find(tool => !tool.namespace && tool.name === "exec");
  if (!gateway?.freeform) return { routes, gatewayAdvertised: false };

  for (const name of CODEX_TOOL_HEALTH_ROUTE_NAMES) {
    if (gateway.description.includes(`### \`${name}\``)
      || gateway.description.includes(`tools: { ${name}(`)
      || gateway.description.includes(`tools.${name}(`)) {
      routes.add(name);
    }
  }
  return { routes, gatewayAdvertised: true };
}

export function codexToolHealthGatewayProgram(
  nestedToolName: string,
  payload: { arguments?: Record<string, unknown>; input?: string },
  freeform = false,
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return [
    `const result = await tools[${JSON.stringify(nestedToolName.replace(/[^A-Za-z0-9_$]/g, "_"))}](${JSON.stringify(nestedInput)});`,
    "text(JSON.stringify(result));",
  ].join("\n");
}

export function codexToolHealthRegistryProgram(
  names: readonly string[] = CODEX_TOOL_HEALTH_ROUTE_NAMES,
): string {
  return [
    `const names = ${JSON.stringify(names)};`,
    "const availability = Object.fromEntries(names.map(name => [name, typeof tools[name.replace(/[^A-Za-z0-9_$]/g, \"_\")] === \"function\"]));",
    `text(${JSON.stringify(CODEX_TOOL_HEALTH_REGISTRY_MARKER)} + JSON.stringify(availability));`,
  ].join("\n");
}

export function codexToolHealthResultDetail(result: CodexHealthToolResult): string {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      texts.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") texts.push(record.text);
    if (record.content !== undefined) visit(record.content);
    if (record.structuredContent !== undefined) visit(record.structuredContent);
  };
  visit(result.content);
  visit(result.structuredContent);
  return texts.join(" ").trim().slice(0, 500);
}

export function parseCodexToolHealthRegistry(result: CodexHealthToolResult): Record<string, unknown> {
  const detail = codexToolHealthResultDetail(result);
  const markerIndex = detail.indexOf(CODEX_TOOL_HEALTH_REGISTRY_MARKER);
  if (markerIndex < 0) throw new Error("Codex exec gateway did not return its native tool registry");
  const payload = detail.slice(markerIndex + CODEX_TOOL_HEALTH_REGISTRY_MARKER.length);
  const objectEnd = payload.indexOf("}");
  if (objectEnd < 0) throw new Error("Codex exec gateway returned an incomplete native tool registry");
  return JSON.parse(payload.slice(0, objectEnd + 1)) as Record<string, unknown>;
}

export async function waitForCodexToolGatewayRoutes({
  names,
  inspect,
  retryDelaysMs = CODEX_TOOL_GATEWAY_READINESS_RETRY_DELAYS_MS,
}: {
  names: readonly string[];
  inspect: (program: string) => Promise<CodexHealthToolResult>;
  retryDelaysMs?: readonly number[];
}): Promise<{ availability: Record<string, boolean>; gatewayError?: string }> {
  const availability = Object.fromEntries(names.map(name => [name, false])) as Record<string, boolean>;
  let successfulInspection = false;
  let gatewayError: string | undefined;

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const parsed = parseCodexToolHealthRegistry(await inspect(codexToolHealthRegistryProgram(names)));
      successfulInspection = true;
      gatewayError = undefined;
      for (const name of names) {
        if (parsed[name] === true) availability[name] = true;
      }
      if (names.every(name => availability[name])) break;
    } catch (error) {
      gatewayError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    availability,
    ...(!successfulInspection && gatewayError ? { gatewayError: gatewayError.slice(0, 500) } : {}),
  };
}

function sessionIdFromResult(result: CodexHealthToolResult): number | undefined {
  const seen = new Set<object>();
  const visit = (value: unknown): number | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try { return visit(JSON.parse(trimmed)); } catch { return undefined; }
      }
      return undefined;
    }
    if (!value || typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.session_id === "number" && Number.isSafeInteger(record.session_id) && record.session_id >= 0) {
      return record.session_id;
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(result);
}

export function unavailableCodexToolHealthReport(detail: string): CodexToolHealthReport {
  return {
    checkedAt: new Date().toISOString(),
    activeTurn: false,
    live: false,
    traceId: null,
    tools: (["exec_command", "write_stdin", "apply_patch", "view_image"] as const).map(name => ({
      name,
      status: "unknown",
      detail,
    })),
  };
}

export function passiveCodexToolHealthReport(
  environment: ChatGptTurnEnvironment,
  traceId: string,
  activeTurn: boolean,
): CodexToolHealthReport {
  const { routes, gatewayAdvertised } = declaredCodexToolHealthRoutes(environment);
  const routeAvailable = (name: string) => routes.has(name);
  const execRoute = routeAvailable("exec_command")
    ? "exec_command"
    : routeAvailable("shell_command")
      ? "shell_command"
      : null;
  const idleSuffix = activeTurn
    ? "Live smoke test will run when this turn is waiting for native tool calls."
    : "Shown from the most recently observed Codex turn; run a new Codex task for a live smoke test.";
  const unavailable = (name: string) => gatewayAdvertised
    ? {
        status: "unknown" as const,
        detail: `The exec gateway is advertised, but ${name} is not declared in its tool description. ${idleSuffix}`,
      }
    : {
        status: "missing" as const,
        detail: `Native route is not advertised. ${idleSuffix}`,
      };
  const advertised = (name: string, detail = "Native route is advertised") => routeAvailable(name)
    ? { status: "available" as const, detail: `${detail}. ${idleSuffix}` }
    : unavailable(name);
  return {
    checkedAt: new Date().toISOString(),
    activeTurn,
    live: false,
    traceId,
    tools: [
      {
        name: "exec_command",
        ...(execRoute
          ? advertised(execRoute, execRoute === "exec_command" ? "Native exec_command route is advertised" : "shell_command compatibility route is advertised")
          : unavailable("exec_command")),
      },
      { name: "write_stdin", ...advertised("write_stdin") },
      { name: "apply_patch", ...advertised("apply_patch", "Native route is advertised; this check does not modify files") },
      { name: "view_image", ...advertised("view_image", "Native route is advertised; this check does not open an image") },
    ],
  };
}

export async function runCodexToolHealthSmoke({
  environment,
  traceId,
  routes,
  gatewayError,
  invoke,
}: {
  environment: ChatGptTurnEnvironment;
  traceId: string;
  routes: Set<string>;
  gatewayError?: string;
  invoke: (
    toolName: string,
    payload: { arguments?: Record<string, unknown>; input?: string },
    freeform?: boolean,
  ) => Promise<CodexHealthToolResult>;
}): Promise<CodexToolHealthReport> {
  const routeAvailable = (name: string) => routes.has(name);
  const unavailableDetail = (name: string) => gatewayError
    ? `Could not inspect the Codex exec gateway for ${name}: ${gatewayError}`
    : "Native route is not advertised";
  const advertised = (name: string) => routeAvailable(name)
    ? { status: "available" as const, detail: "Native route is advertised" }
    : { status: gatewayError ? "unknown" as const : "missing" as const, detail: unavailableDetail(name) };
  const execRoute = routeAvailable("exec_command")
    ? "exec_command"
    : routeAvailable("shell_command")
      ? "shell_command"
      : null;
  const report: CodexToolHealthReport = {
    checkedAt: new Date().toISOString(),
    activeTurn: true,
    live: true,
    traceId,
    tools: [
      { name: "exec_command", ...(execRoute ? { status: "available" as const, detail: execRoute === "exec_command" ? "Native route is advertised" : "shell_command compatibility route is advertised" } : advertised("exec_command")) },
      { name: "write_stdin", ...advertised("write_stdin") },
      { name: "apply_patch", ...(routeAvailable("apply_patch") ? { status: "available" as const, detail: "Native route is advertised; safety check does not modify files" } : advertised("apply_patch")) },
      { name: "view_image", ...(routeAvailable("view_image") ? { status: "available" as const, detail: "Native route is advertised; safety check does not open an image" } : advertised("view_image")) },
    ],
  };
  const item = (name: CodexToolHealthItem["name"]) => report.tools.find(tool => tool.name === name)!;
  if (!execRoute) return report;

  try {
    const command = process.platform === "win32"
      ? "powershell.exe -NoProfile -Command \"$line = [Console]::ReadLine(); Write-Output $line\""
      : "sh -c 'IFS= read -r line; printf \"%s\\n\" \"$line\"'";
    const execResult = execRoute === "exec_command"
      ? await invoke(execRoute, {
          arguments: {
            cmd: command,
            workdir: environment.cwd,
            yield_time_ms: 250,
            max_output_tokens: 1_000,
            tty: true,
          },
        })
      : await invoke(execRoute, {
          arguments: {
            command: process.platform === "win32" ? "cmd /d /c echo LCA_CODEX_TOOL_CHECK_READY" : "printf 'LCA_CODEX_TOOL_CHECK_READY\\n'",
            workdir: environment.cwd,
            timeout_ms: 2_000,
          },
        });
    const execItem = item("exec_command");
    if (execResult.isError) {
      execItem.status = "failed";
      execItem.detail = codexToolHealthResultDetail(execResult) || "Native command smoke test failed";
      return report;
    }
    execItem.status = "working";
    execItem.detail = execRoute === "exec_command"
      ? "Harmless interactive command started successfully"
      : "Harmless shell_command compatibility smoke test completed";

    if (execRoute !== "exec_command") {
      const stdinItem = item("write_stdin");
      if (routeAvailable("write_stdin")) {
        stdinItem.status = "available";
        stdinItem.detail = "Native route is advertised; shell_command cannot create a session for a live stdin smoke test";
      }
      return report;
    }

    const sessionId = sessionIdFromResult(execResult);
    const stdinItem = item("write_stdin");
    if (sessionId === undefined) {
      stdinItem.status = routeAvailable("write_stdin") ? "available" : "missing";
      stdinItem.detail = routeAvailable("write_stdin")
        ? "Command worked, but the smoke command did not return a session to poll"
        : "Native route is not advertised";
      return report;
    }
    if (!routeAvailable("write_stdin")) return report;
    const stdinResult = await invoke("write_stdin", {
      arguments: {
        session_id: sessionId,
        chars: "LCA_CODEX_TOOL_CHECK_STDIN\n",
        yield_time_ms: 1_000,
        max_output_tokens: 1_000,
      },
    });
    if (stdinResult.isError) {
      stdinItem.status = "failed";
      stdinItem.detail = codexToolHealthResultDetail(stdinResult) || "Native session write failed";
      void invoke("write_stdin", {
        arguments: { session_id: sessionId, chars: "\u0003", yield_time_ms: 250, max_output_tokens: 500 },
      }).catch(() => {});
    } else {
      stdinItem.status = "working";
      stdinItem.detail = "Input was delivered to the harmless command session successfully";
    }
  } catch (error) {
    const execItem = item("exec_command");
    execItem.status = "failed";
    execItem.detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  return report;
}
