import { createHash } from "node:crypto";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { waitForCodexToolGatewayRoutes } from "./codex-tool-health";
import {
  gatewayToolInventoryProgram,
  gatewayWireIdentity,
  inventoryToolRank,
  isModelRecursiveHarnessTool,
  parseGatewayToolInventory,
  type GatewayDiscoveredTool,
} from "./deferred-tool-inventory";
import type { ChatGptTurnEnvironment } from "./environment";
import {
  callTurnBroker,
  type BrokerDeferredInvocation,
  type BrokerDeferredToolStatus,
  type BrokerToolResult,
} from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

interface ResolvedTurn {
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

interface ContextQueryResult {
  snapshot_id: string;
  sha256: string;
  action: "instructions" | "recent" | "search" | "get" | "full" | "image";
  entries?: Array<Record<string, unknown>>;
  content?: string;
  next_offset?: number | null;
  total_chars?: number;
  total_entries?: number;
  query?: string;
  attachment?: {
    ref: string;
    message_id: string;
    image_url: string;
    detail?: string;
  };
}

const turnTokenSchema = z.string()
  .regex(/^turn_[A-Za-z0-9_-]{32}$/, "turn_token must be the exact turn_ value supplied in the current Codex task context");
const bindingSchema = z.string()
  .regex(/^binding_[A-Za-z0-9_-]{32}$/, "binding_id must be the exact binding_ value returned by agent_bind_turn; never pass turn_token here")
  .describe("Exact binding_ value returned by agent_bind_turn. This is not the turn_token.");
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
const contextActionSchema = z.enum(["instructions", "recent", "search", "get", "full", "image"]);

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function contextImageResult(value: ContextQueryResult) {
  const attachment = value.attachment;
  if (!attachment) throw new Error("lazy context image response did not include an attachment");
  const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(attachment.image_url);
  const metadata = {
    snapshot_id: value.snapshot_id,
    sha256: value.sha256,
    action: value.action,
    attachment_ref: attachment.ref,
    message_id: attachment.message_id,
  };
  if (dataMatch) {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(metadata) },
        { type: "image" as const, data: dataMatch[2]!, mimeType: dataMatch[1]! },
      ] as never,
      structuredContent: metadata,
    };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(metadata) },
      { type: "resource_link" as const, uri: attachment.image_url, name: attachment.ref, mimeType: "image/*" },
    ] as never,
    structuredContent: metadata,
  };
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(isRecord(value.structuredContent)
      ? { structuredContent: value.structuredContent }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(isRecord(value._meta)
      ? { _meta: value._meta }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function bridgeCapabilities(environment: ChatGptTurnEnvironment): string[] {
  const gateway = execGateway(environment);
  const capabilities = [
    "native_tool_loop",
    "session_history",
    "lazy_context",
    "lazy_instructions",
    "lazy_images",
    "tool_registry",
  ];
  if (exactTool(environment, "exec_command") || exactTool(environment, "shell_command") || gateway) {
    capabilities.push("exec");
  }
  // A generic harness such as Claude Code may expose Write/Edit/Bash but no apply_patch route.
  // Do not advertise Codex's patch primitive as universally available: doing so makes the model
  // reject perfectly valid harness-native editing tools before it ever inventories them.
  if (exactTool(environment, "apply_patch") || gateway) capabilities.push("apply_patch");
  if (exactTool(environment, "view_image") || gateway) capabilities.push("images");
  return capabilities;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return [
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function registerCodexCompatibilityAlias(
  server: McpServer,
  alias: string,
  canonicalName: string,
  tool: RegisteredTool,
): void {
  if (typeof tool.handler !== "function") {
    throw new Error(`Cannot alias task-based MCP tool ${canonicalName}`);
  }
  server.registerTool(
    alias,
    {
      title: tool.title,
      description: `Compatibility alias for ${canonicalName}. ${tool.description ?? ""}`.trim(),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      _meta: { ...(tool._meta ?? {}), lca_compatibility_alias_for: canonicalName },
    },
    tool.handler as ToolCallback<any>,
  );
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "lca-token-native", version: "3.0.0" });
  const readyGatewayTools = new Map<string, Set<string>>();
  const discoveredGatewayTools = new Map<string, Map<string, GatewayDiscoveredTool>>();

  const environment = async (
    bindingId: string,
    sourceTool?: string,
  ): Promise<ChatGptTurnEnvironment & { expiresAt?: number }> => {
    const resolved = await callTurnBroker<ResolvedTurn>(options.brokerSocketPath, {
      method: "resolve",
      bindingId,
      ...(sourceTool ? { sourceTool } : {}),
    });
    const expiresAt = resolved.environment.expiresAt;
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error("turn binding expired");
    return resolved.environment;
  };

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
    activityTool = wireName(tool),
  ) => {
    const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
      method: "invoke",
      bindingId,
      wireName: wireName(tool),
      sourceTool,
      activityTool,
      freeform: tool.freeform === true,
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    }, invocationTimeout(bound));
    return asMcpResult(response);
  };

  const invokeDeferred = async (
    bindingId: string,
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
    activityTool = wireName(tool),
  ) => {
    const queued = await callTurnBroker<BrokerDeferredInvocation>(options.brokerSocketPath, {
      method: "invoke_deferred",
      bindingId,
      wireName: wireName(tool),
      sourceTool,
      activityTool,
      freeform: tool.freeform === true,
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    });
    return result({
      status: "pending",
      invocation_id: queued.invocationId,
      retry_after_ms: 500,
      next_action: "Call agent_tool_result with this binding_id and invocation_id until it returns the completed harness tool result. Pending is not a tool result.",
    });
  };

  const ensureGatewayToolReady = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    gateway: CodexTool,
    nestedToolName: string,
    sourceTool: string,
  ) => {
    const cached = readyGatewayTools.get(bindingId);
    if (cached?.has(nestedToolName)) return;

    const inspected = await waitForCodexToolGatewayRoutes({
      names: [nestedToolName],
      inspect: program => invoke(
        bindingId,
        bound,
        gateway,
        { input: program },
        sourceTool,
        "agent_nested_tool_readiness",
      ),
    });
    if (!inspected.availability[nestedToolName]) {
      throw new Error(inspected.gatewayError
        ? `Could not inspect ${nestedToolName} through the native exec gateway: ${inspected.gatewayError}`
        : `The native exec gateway did not expose ${nestedToolName} within the readiness grace period`);
    }

    const ready = cached ?? new Set<string>();
    ready.add(nestedToolName);
    readyGatewayTools.set(bindingId, ready);
    if (readyGatewayTools.size > 128) {
      const oldest = readyGatewayTools.keys().next().value;
      if (oldest) readyGatewayTools.delete(oldest);
    }
  };

  const invokeNative = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway || gateway === tool) return invoke(bindingId, bound, tool, payload, sourceTool);
    const nestedToolName = wireName(tool);
    await ensureGatewayToolReady(bindingId, bound, gateway, nestedToolName, sourceTool);
    return invoke(
      bindingId,
      bound,
      gateway,
      { input: execGatewayProgram(nestedToolName, tool.freeform === true, payload) },
      sourceTool,
      nestedToolName,
    );
  };

  const invokeNestedNative = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This harness turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    await ensureGatewayToolReady(bindingId, bound, gateway, nestedToolName, sourceTool);
    return invoke(
      bindingId,
      bound,
      gateway,
      { input: execGatewayProgram(nestedToolName, freeform, payload) },
      sourceTool,
      nestedToolName,
    );
  };

  const invokeDeferredNative = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway || gateway === tool) return invokeDeferred(bindingId, tool, payload, sourceTool);
    const nestedToolName = wireName(tool);
    await ensureGatewayToolReady(bindingId, bound, gateway, nestedToolName, sourceTool);
    return invokeDeferred(
      bindingId,
      gateway,
      { input: execGatewayProgram(nestedToolName, tool.freeform === true, payload) },
      sourceTool,
      nestedToolName,
    );
  };

  const invokeNestedDeferredNative = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This harness turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    await ensureGatewayToolReady(bindingId, bound, gateway, nestedToolName, sourceTool);
    return invokeDeferred(
      bindingId,
      gateway,
      { input: execGatewayProgram(nestedToolName, freeform, payload) },
      sourceTool,
      nestedToolName,
    );
  };

  const agentBindTurn = server.registerTool(
    "agent_bind_turn",
    {
      title: "Bind this response to its agent turn",
      description: "Idempotently exchange the current turn_token for a distinct binding_id. Copy the returned binding_ value exactly into every later connector call; never reuse the turn_ value as binding_id.",
      inputSchema: { turn_token: turnTokenSchema },
      outputSchema: {
        binding_id: bindingSchema,
        binding_status: z.literal("active"),
        valid_until: z.string(),
        bridge_protocol_version: z.literal(3),
        execution: z.literal("outer_harness_native"),
        cwd: z.string(),
        roots: z.array(z.string()),
        writable_roots: z.array(z.string()),
        sandbox: z.string(),
        expires_at: z.string().nullable(),
        tool_count: z.number().int().nonnegative(),
        command_tool: z.string().nullable(),
        outer_tool_gateway: z.string().nullable(),
        capabilities: z.array(z.string()),
        context_transport: z.enum(["mcp_lazy", "none"]),
        context_required: z.boolean(),
        next_action: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token }, extra) => {
      console.error(`[lca-token-mcp] agent_bind_turn scope=${requestScopeSummary(extra)}`);
      const claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, {
        method: "claim",
        token: turn_token,
        sourceTool: "agent_bind_turn",
      });
      const commandTool = exactTool(claimed.environment, "exec_command") ?? exactTool(claimed.environment, "shell_command");
      const gateway = execGateway(claimed.environment);
      const expiresAt = claimed.environment.expiresAt === undefined
        ? null
        : new Date(claimed.environment.expiresAt).toISOString();
      return result({
        binding_id: claimed.bindingId,
        binding_status: "active",
        valid_until: expiresAt ?? "outer_turn_end",
        bridge_protocol_version: 3,
        execution: "outer_harness_native",
        cwd: claimed.environment.cwd,
        roots: claimed.environment.roots,
        writable_roots: claimed.environment.writableRoots,
        sandbox: claimed.environment.sandboxPolicy.type,
        expires_at: expiresAt,
        tool_count: claimed.environment.tools.length,
        command_tool: commandTool ? wireName(commandTool) : gateway ? "exec_command" : null,
        outer_tool_gateway: gateway ? wireName(gateway) : null,
        capabilities: bridgeCapabilities(claimed.environment),
        context_transport: "mcp_lazy",
        context_required: false,
        next_action: "Use this binding_id only if you need task instructions, historical context, or an authenticated harness tool. Call agent_context selectively. For local inspection or mutation, use only a matching capability returned above; otherwise query agent_tool_inventory for the harness-native operation (for example Read, Write, Edit, or Bash) and invoke the exact returned wire_name with agent_tool_call before declaring the operation unavailable.",
      });
    },
  );

  const agentContext = server.registerTool(
    "agent_context",
    {
      title: "Read historical task context on demand",
      description: "Retrieve only the task context needed for the current request. Use instructions for harness-generated skill/capability guidance, recent/search/get for older task history, full only when selective retrieval cannot preserve correctness, and image for an older attachment_ref.",
      inputSchema: {
        binding_id: bindingSchema,
        action: contextActionSchema,
        query: z.string().max(2_000).optional(),
        ids: z.array(z.string().max(128)).max(20).optional(),
        offset: z.number().int().min(0).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        max_chars: z.number().int().min(1_000).max(100_000).optional(),
        attachment_ref: z.string().max(256).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, action, query, ids, offset, limit, max_chars, attachment_ref }) => {
      const context = await callTurnBroker<ContextQueryResult>(options.brokerSocketPath, {
        method: "context_query",
        bindingId: binding_id,
        sourceTool: "agent_context",
        action,
        ...(query !== undefined ? { query } : {}),
        ...(ids !== undefined ? { ids } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(max_chars !== undefined ? { maxChars: max_chars } : {}),
        ...(attachment_ref !== undefined ? { attachmentRef: attachment_ref } : {}),
      });
      return action === "image" ? contextImageResult(context) : result(context as unknown as Record<string, unknown>);
    },
  );

  const agentExec = server.registerTool(
    "agent_exec",
    {
      title: "Run a native harness command",
      description: "Compatibility helper for harnesses that advertise a native command route such as exec_command/shell_command. Use it for inspection, search, tests, and builds when the bound turn reports the exec capability. Do not assume it is the mutation route for every harness: generic harnesses may instead expose Bash plus separate Write/Edit tools discoverable through agent_tool_inventory. A long-running command returns its native session_id.",
      inputSchema: {
        binding_id: bindingSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, cmd, workdir, yield_time_ms, max_output_tokens, tty }, extra) => {
      console.error(`[lca-token-mcp] agent_exec scope=${requestScopeSummary(extra)}`);
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
      const commandName = tool?.name ?? "exec_command";
      const args = commandName === "exec_command"
        ? {
            cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
            ...(tty !== undefined ? { tty } : {}),
          }
        : {
            command: cmd,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          };
      return tool
        ? invokeNative(binding_id, bound, tool, { arguments: args }, "agent_exec")
        : invokeNestedNative(binding_id, bound, commandName, false, { arguments: args }, "agent_exec");
    },
  );

  const agentWriteStdin = server.registerTool(
    "agent_write_stdin",
    {
      title: "Continue a native harness command session",
      description: "Compatibility helper to write characters to, or poll, a native session_id returned by agent_exec. It is not a universal repository-edit primitive; use the mutation tool required by the bound outer harness.",
      inputSchema: {
        binding_id: bindingSchema,
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, session_id, chars, yield_time_ms, max_output_tokens }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "write_stdin");
      const payload = { arguments: {
        session_id,
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
      } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload, "agent_write_stdin")
        : invokeNestedNative(binding_id, bound, "write_stdin", false, payload, "agent_write_stdin");
    },
  );

  const agentApplyPatch = server.registerTool(
    "agent_apply_patch",
    {
      title: "Apply a native harness patch",
      description: "Compatibility helper for turns whose bound outer harness actually advertises a native apply_patch route. Do not assume this helper is available or preferred for generic harnesses such as Claude Code; discover their harness-native Write/Edit tool with agent_tool_inventory and invoke it through agent_tool_call instead.",
      inputSchema: { binding_id: bindingSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, patch }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "apply_patch");
      if (!tool && !execGateway(bound)) {
        throw new Error(
          "This harness turn does not advertise a native apply_patch route. "
          + "Use agent_tool_inventory to discover the harness-native repository mutation tool "
          + "(for example Write or Edit in Claude Code), then invoke its exact wire_name with agent_tool_call.",
        );
      }
      if (!tool) return invokeNestedNative(
        binding_id,
        bound,
        "apply_patch",
        true,
        { input: patch },
        "agent_apply_patch",
      );
      return tool.freeform
        ? invokeNative(binding_id, bound, tool, { input: patch }, "agent_apply_patch")
        : invokeNative(binding_id, bound, tool, { arguments: { input: patch } }, "agent_apply_patch");
    },
  );

  const agentViewImage = server.registerTool(
    "agent_view_image",
    {
      title: "View an image through the native harness",
      description: "Invoke the outer harness view_image tool and return its multimodal result to this same ChatGPT response.",
      inputSchema: {
        binding_id: bindingSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, path, detail }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload, "agent_view_image")
        : invokeNestedNative(binding_id, bound, "view_image", false, payload, "agent_view_image");
    },
  );

  const agentToolInventory = server.registerTool(
    "agent_tool_inventory",
    {
      title: "Discover tools from the current agent harness",
      description: "Search the exact tool registry supplied to the current outer harness turn, including configured MCP/app tools. Deferred results discovered here remain inside this selected connector route; invoking them with agent_tool_call is not connector switching. Prefer a specific operation query when known (for example get_design_context) over a broad provider query.",
      inputSchema: {
        binding_id: bindingSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, query, offset, limit, include_schema }) => {
      const bound = await environment(binding_id, "agent_tool_inventory");
      const needle = query?.trim().toLowerCase();
      const needleKey = needle?.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ?? "";
      const directTools = bound.tools.filter(
        tool => !isModelRecursiveHarnessTool(wireName(tool), tool.description),
      );
      const directExactNamespaceMatchExists = Boolean(needleKey) && directTools.some(
        tool => (tool.namespace ?? "").toLowerCase() === needleKey,
      );
      const directMatches = directTools
        .map(tool => ({
          tool,
          rank: inventoryToolRank(
            needle ?? "",
            wireName(tool),
            tool.name,
            tool.namespace ?? "",
            tool.description,
            directExactNamespaceMatchExists,
          ),
        }))
        .filter(item => !needle || item.rank < 5)
        .sort((left, right) => left.rank - right.rank || wireName(left.tool).localeCompare(wireName(right.tool)));
      const directRows = directMatches.map(({ tool, rank }) => ({
        rank,
        wireName: wireName(tool),
        value: {
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: tool.description,
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          source: "turn" as const,
          execution: "synchronous",
          ...(include_schema ? { parameters: tool.parameters } : {}),
        } as Record<string, unknown>,
      }));

      const gateway = execGateway(bound);
      let nestedTotal = 0;
      let nestedDiscoveryError: string | undefined;
      const nestedRows: Array<{ rank: number; wireName: string; value: Record<string, unknown> }> = [];
      if (gateway && needle) {
        try {
          const discovered = parseGatewayToolInventory(await invoke(
            binding_id,
            bound,
            gateway,
            { input: gatewayToolInventoryProgram({
              query,
              excludedWireNames: bound.tools.map(wireName),
              offset: 0,
              limit: offset + limit,
              includeSchema: include_schema,
            }) },
            "agent_tool_inventory",
            "agent_nested_tool_inventory",
          ));
          nestedTotal = discovered.total;
          const cache = discoveredGatewayTools.get(binding_id) ?? new Map<string, GatewayDiscoveredTool>();
          for (const tool of discovered.tools) {
            if (isModelRecursiveHarnessTool(tool.wireName, tool.description)) continue;
            const previous = cache.get(tool.wireName);
            const identity = gatewayWireIdentity(tool.wireName);
            const cached: GatewayDiscoveredTool = {
              ...previous,
              ...tool,
            };
            if (include_schema) {
              if (tool.parameters) {
                cached.parameters = tool.parameters;
                delete cached.schemaError;
              } else {
                delete cached.parameters;
                if (!tool.schemaError) delete cached.schemaError;
              }
            } else if (previous?.parameters) {
              cached.parameters = previous.parameters;
              if (previous.schemaError) cached.schemaError = previous.schemaError;
            }
            cache.set(tool.wireName, cached);
            nestedRows.push({
              rank: tool.rank,
              wireName: tool.wireName,
              value: {
                wire_name: tool.wireName,
                name: identity.name,
                namespace: identity.namespace,
                description: tool.description,
                kind: tool.freeform ? "freeform" : "function",
                source: "exec_gateway",
                execution: "synchronous",
                ...(include_schema && tool.parameters ? { parameters: tool.parameters } : {}),
                ...(include_schema && tool.schemaError ? { schema_error: tool.schemaError.slice(0, 500) } : {}),
              },
            });
          }
          discoveredGatewayTools.set(binding_id, cache);
          if (discoveredGatewayTools.size > 128) {
            const oldest = discoveredGatewayTools.keys().next().value;
            if (oldest) discoveredGatewayTools.delete(oldest);
          }
        } catch (error) {
          nestedDiscoveryError = error instanceof Error ? error.message : String(error);
        }
      }

      const page = [...directRows, ...nestedRows]
        .sort((left, right) => left.rank - right.rank || left.wireName.localeCompare(right.wireName))
        .slice(offset, offset + limit)
        .map(item => item.value);
      const total = directMatches.length + nestedTotal;
      return result({
        tools: page,
        total,
        next_offset: offset + page.length < total ? offset + page.length : null,
        ...(nestedDiscoveryError ? { nested_discovery_error: nestedDiscoveryError.slice(0, 500) } : {}),
      });
    },
  );

  const agentToolCall = server.registerTool(
    "agent_tool_call",
    {
      title: "Call a non-delegating tool from the current agent harness",
      description: "Invoke an exact wire_name returned by agent_tool_inventory. Single-agent mode rejects model-launching and delegation tools; the outer harness performs accepted calls, approvals, and UI lifecycle.",
      inputSchema: {
        binding_id: bindingSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ binding_id, wire_name, arguments: args, input }) => {
      const bound = await environment(binding_id);
      const tool = bound.tools.find(candidate => wireName(candidate) === wire_name);
      if (tool && isModelRecursiveHarnessTool(wireName(tool), tool.description)) {
        throw new Error(
          `Single-agent mode blocks model-launching or delegation tool ${wire_name}. `
          + "Complete this task in the current ChatGPT Web reasoning turn instead of spawning another agent.",
        );
      }
      if (tool?.freeform) {
        if (input === undefined) throw new Error(`Freeform harness tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform harness tool ${wire_name} does not accept arguments`);
        return invokeNative(binding_id, bound, tool, { input }, "agent_tool_call");
      }
      if (tool) {
        if (input !== undefined) throw new Error(`Function harness tool ${wire_name} does not accept freeform input`);
        return invokeNative(binding_id, bound, tool, { arguments: args ?? {} }, "agent_tool_call");
      }

      const discovered = discoveredGatewayTools.get(binding_id)?.get(wire_name);
      if (!discovered) {
        throw new Error(`Harness tool is not available in this turn or has not been returned by agent_tool_inventory: ${wire_name}`);
      }
      if (isModelRecursiveHarnessTool(discovered.wireName, discovered.description)) {
        throw new Error(
          `Single-agent mode blocks model-launching or delegation tool ${wire_name}. `
          + "Complete this task in the current ChatGPT Web reasoning turn instead of spawning another agent.",
        );
      }
      if (discovered.freeform) {
        if (input === undefined) throw new Error(`Freeform harness tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform harness tool ${wire_name} does not accept arguments`);
        return invokeNestedNative(binding_id, bound, wire_name, true, { input }, "agent_tool_call");
      }
      if (input !== undefined) throw new Error(`Function harness tool ${wire_name} does not accept freeform input`);
      return invokeNestedNative(binding_id, bound, wire_name, false, { arguments: args ?? {} }, "agent_tool_call");
    },
  );

  const agentToolResult = server.registerTool(
    "agent_tool_result",
    {
      title: "Read a deferred harness tool result",
      description: "Compatibility-only polling for a deferred harness call accepted before single-agent mode was enabled. New model-launching or delegation calls are rejected.",
      inputSchema: {
        binding_id: bindingSchema,
        invocation_id: z.string().regex(/^call_[A-Za-z0-9_-]{32}$/, "invocation_id must be the exact call_ value returned by agent_tool_call"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, invocation_id }) => {
      const status = await callTurnBroker<BrokerDeferredToolStatus>(options.brokerSocketPath, {
        method: "poll_deferred",
        bindingId: binding_id,
        invocationId: invocation_id,
        sourceTool: "agent_tool_result",
      });
      if (status.status === "pending") {
        return result({
          status: "pending",
          invocation_id: status.invocationId,
          retry_after_ms: 500,
          next_action: "Call agent_tool_result again with the same binding_id and invocation_id. Do not treat pending as completion.",
        });
      }
      return asMcpResult(status.result);
    },
  );

  // `agent_*` is the canonical harness-neutral surface. Keep the old `codex_*` spellings as
  // exact handler aliases so frozen connector schemas/instructions from the stable Codex bridge do
  // not break during migration. Aliases never widen authority: they validate the same schemas and
  // dispatch through the same authenticated turn binding and exact outer tool registry.
  for (const [alias, canonicalName, tool] of [
    ["codex_bind_turn", "agent_bind_turn", agentBindTurn],
    ["codex_context", "agent_context", agentContext],
    ["codex_exec", "agent_exec", agentExec],
    ["codex_write_stdin", "agent_write_stdin", agentWriteStdin],
    ["codex_apply_patch", "agent_apply_patch", agentApplyPatch],
    ["codex_view_image", "agent_view_image", agentViewImage],
    ["codex_tool_inventory", "agent_tool_inventory", agentToolInventory],
    ["codex_tool_call", "agent_tool_call", agentToolCall],
    ["codex_tool_result", "agent_tool_result", agentToolResult],
  ] as const) {
    registerCodexCompatibilityAlias(server, alias, canonicalName, tool);
  }

  await server.connect(new StdioServerTransport());
}
