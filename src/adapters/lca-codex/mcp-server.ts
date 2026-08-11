import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

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
  .regex(/^binding_[A-Za-z0-9_-]{32}$/, "binding_id must be the exact binding_ value returned by codex_bind_turn; never pass turn_token here")
  .describe("Exact binding_ value returned by codex_bind_turn. This is not the turn_token.");
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

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const tool = environment.tools.find(candidate => wireName(candidate) === requestedWireName);
  if (!tool) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);
  return tool;
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
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

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: "3.0.0" });

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
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new Error("Codex turn binding expired");
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

  const invokeNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    return gateway && gateway !== tool
      ? invoke(
          bindingId,
          bound,
          gateway,
          { input: execGatewayProgram(wireName(tool), tool.freeform === true, payload) },
          sourceTool,
          wireName(tool),
        )
      : invoke(bindingId, bound, tool, payload, sourceTool);
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    sourceTool: string,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(
      bindingId,
      bound,
      gateway,
      { input: execGatewayProgram(nestedToolName, freeform, payload) },
      sourceTool,
      nestedToolName,
    );
  };

  server.registerTool(
    "codex_bind_turn",
    {
      title: "Bind this response to its Codex turn",
      description: "Idempotently exchange the current turn_token for a distinct binding_id. Copy the returned binding_ value exactly into every later connector call; never reuse the turn_ value as binding_id.",
      inputSchema: { turn_token: turnTokenSchema },
      outputSchema: {
        binding_id: bindingSchema,
        binding_status: z.literal("active"),
        valid_until: z.string(),
        bridge_protocol_version: z.literal(3),
        execution: z.literal("outer_codex_native"),
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
      console.error(`[lca-codex-mcp] codex_bind_turn scope=${requestScopeSummary(extra)}`);
      const claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, {
        method: "claim",
        token: turn_token,
        sourceTool: "codex_bind_turn",
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
        execution: "outer_codex_native",
        cwd: claimed.environment.cwd,
        roots: claimed.environment.roots,
        writable_roots: claimed.environment.writableRoots,
        sandbox: claimed.environment.sandboxPolicy.type,
        expires_at: expiresAt,
        tool_count: claimed.environment.tools.length,
        command_tool: commandTool ? wireName(commandTool) : gateway ? "exec_command" : null,
        outer_tool_gateway: gateway ? wireName(gateway) : null,
        capabilities: ["native_tool_loop", "session_history", "lazy_context", "lazy_instructions", "lazy_images", "exec", "apply_patch", "images", "tool_registry"],
        context_transport: "mcp_lazy",
        context_required: false,
        next_action: "Use this binding_id only if you need Codex instruction details, historical context, or a native Codex tool. Call codex_context selectively; do not preload history or instruction catalogs.",
      });
    },
  );

  server.registerTool(
    "codex_context",
    {
      title: "Read historical Codex context on demand",
      description: "Retrieve only the Codex context needed for the current request. Use instructions for Codex-generated skill/capability guidance, recent/search/get for older task history, full only when selective retrieval cannot preserve correctness, and image for an older attachment_ref.",
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
        sourceTool: "codex_context",
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

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
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
      console.error(`[lca-codex-mcp] codex_exec scope=${requestScopeSummary(extra)}`);
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
        ? invokeNative(binding_id, bound, tool, { arguments: args }, "codex_exec")
        : invokeNestedNative(binding_id, bound, commandName, false, { arguments: args }, "codex_exec");
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: "Write characters to, or poll, a session_id returned by codex_exec.",
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
        ? invokeNative(binding_id, bound, tool, payload, "codex_write_stdin")
        : invokeNestedNative(binding_id, bound, "write_stdin", false, payload, "codex_write_stdin");
    },
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.",
      inputSchema: { binding_id: bindingSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, patch }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "apply_patch");
      if (!tool) return invokeNestedNative(
        binding_id,
        bound,
        "apply_patch",
        true,
        { input: patch },
        "codex_apply_patch",
      );
      return tool.freeform
        ? invokeNative(binding_id, bound, tool, { input: patch }, "codex_apply_patch")
        : invokeNative(binding_id, bound, tool, { arguments: { input: patch } }, "codex_apply_patch");
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.",
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
        ? invokeNative(binding_id, bound, tool, payload, "codex_view_image")
        : invokeNestedNative(binding_id, bound, "view_image", false, payload, "codex_view_image");
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
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
      const bound = await environment(binding_id, "codex_tool_inventory");
      const needle = query?.trim().toLowerCase();
      const matches = bound.tools.filter(tool => !needle || [
        wireName(tool),
        tool.name,
        tool.namespace ?? "",
        tool.description,
      ].join("\n").toLowerCase().includes(needle));
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: tool.description,
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: tool.parameters } : {}),
      }));
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
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
      const tool = namedTool(bound, wire_name);
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        return invokeNative(binding_id, bound, tool, { input }, "codex_tool_call");
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      return invokeNative(binding_id, bound, tool, { arguments: args ?? {} }, "codex_tool_call");
    },
  );

  await server.connect(new StdioServerTransport());
}
