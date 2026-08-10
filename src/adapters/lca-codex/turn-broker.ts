import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isWindowsPipeEndpoint } from "../../config";
import type { ChatGptTurnEnvironment } from "./environment";
import { activityCallId, activityDuration, logLcaCodexActivity } from "./activity";
import {
  CODEX_TOOL_HEALTH_ROUTE_NAMES,
  codexToolHealthGatewayProgram,
  codexToolHealthRegistryProgram,
  declaredCodexToolHealthRoutes,
  parseCodexToolHealthRegistry,
  passiveCodexToolHealthReport,
  runCodexToolHealthSmoke,
  unavailableCodexToolHealthReport,
  type CodexToolHealthReport,
} from "./codex-tool-health";
import { withoutRetiredTurnHandles, type ChatGptContextEntry, type ChatGptContextSnapshot } from "./prompt";

interface PendingTurn extends ChatGptTurnEnvironment {
  expiresAt?: number;
}

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

interface PendingInvocation {
  request: BrokerToolRequest;
  activityTool: string;
  startedAt: number;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
}

interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type ContextQueryAction = "instructions" | "recent" | "search" | "get" | "full" | "image";

interface BrokerContextEntry {
  id: string;
  index: number;
  role: string;
  content: string;
  attachment_refs: string[];
  truncated: boolean;
}

interface TurnChannel {
  traceId: string;
  environment: PendingTurn;
  bindingId?: string;
  context?: {
    snapshot: ChatGptContextSnapshot;
  };
  queuedCallIds: string[];
  invocations: Map<string, PendingInvocation>;
  waiters: Set<ToolWaiter>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerRequest {
  id: string;
  method: "claim" | "resolve" | "release" | "context_query" | "invoke" | "health_check";
  token?: string;
  bindingId?: string;
  action?: ContextQueryAction;
  query?: string;
  ids?: string[];
  offset?: number;
  limit?: number;
  maxChars?: number;
  attachmentRef?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  /** Public LCA connector tool that originated this broker operation. */
  sourceTool?: string;
  /** Native Codex tool requested before any exec-gateway wrapping. */
  activityTool?: string;
}

interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const brokers = new Map<string, TurnBroker>();
const MAX_BROKER_LINE_CHARS = 67_108_864;
const MAX_RETIRED_TURN_HANDLES = 64;

export type { CodexToolHealthItem, CodexToolHealthReport, CodexToolHealthStatus } from "./codex-tool-health";

export async function closeTurnBrokers(): Promise<void> {
  const active = [...brokers.values()];
  const results = await Promise.allSettled(active.map(broker => broker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT turn broker(s) failed to close`);
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function retiredTurnLabel(traceId: string): string {
  return traceId && traceId !== "unknown" ? `Codex turn ${traceId}` : "a Codex turn";
}

function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  return JSON.stringify({
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
  });
}

export class TurnBroker {
  static forSocket(path: string): TurnBroker {
    let broker = brokers.get(path);
    if (!broker) {
      broker = new TurnBroker(path);
      brokers.set(path, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly pending = new Map<string, TurnChannel>();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  private lastObserved?: { traceId: string; environment: ChatGptTurnEnvironment };
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private server?: Server;
  private startPromise?: Promise<void>;

  private constructor(readonly socketPath: string) {}

  /**
   * A ChatGPT turn outlives the request that started it, and its lca-codex calls arrive from a
   * separate MCP process. Creating the socket only once a turn registers leaves that process
   * connecting to a path that does not exist yet, so an in-flight turn reports a filesystem error
   * instead of the broker's own answer. The endpoint belongs to the runtime's lifetime.
   */
  async listen(): Promise<void> {
    await this.start();
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    contextSnapshot?: ChatGptContextSnapshot,
  ): Promise<string> {
    await this.start();
    this.prune();
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("LCA Codex turn broker TTL must be a positive finite number");
    }
    const token = opaqueId("turn");
    const channel: TurnChannel = {
      traceId,
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      ...(contextSnapshot ? {
        context: { snapshot: contextSnapshot },
      } : {}),
      queuedCallIds: [],
      invocations: new Map(),
      waiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    this.rememberEnvironment(traceId, channel.environment);
    return token;
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
    this.rememberEnvironment(channel.traceId, channel.environment);
  }

  private rememberEnvironment(traceId: string, environment: ChatGptTurnEnvironment): void {
    this.lastObserved = {
      traceId,
      environment: {
        cwd: environment.cwd,
        roots: [...environment.roots],
        writableRoots: [...environment.writableRoots],
        sandboxPolicy: environment.sandboxPolicy.type === "workspaceWrite"
          ? { ...environment.sandboxPolicy, writableRoots: [...environment.sandboxPolicy.writableRoots] }
          : { ...environment.sandboxPolicy },
        tools: environment.tools.map(tool => ({ ...tool })),
      },
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const ready = this.takeQueued(channel);
    if (ready.length > 0) return ready;
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (channel.queuedCallIds.includes(callId)) throw new Error(`tool call was completed before it was delivered: ${callId}`);
    channel.invocations.delete(callId);
    logLcaCodexActivity("lca_codex.tool_completed", {
      traceId: channel.traceId,
      layer: "codex",
      tool: invocation.activityTool,
      callId: activityCallId(callId),
      durationMs: activityDuration(invocation.startedAt),
      status: result.isError ? "error" : "completed",
    }, result.isError ? "error" : "info");
    console.info(`[lca-codex] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
  }

  revoke(token: string): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    this.retire(this.retiredTokens, token, channel.traceId);
    this.rejectChannel(channel, new Error("Codex turn binding was revoked"));
  }

  private retire(history: Map<string, string>, handle: string, traceId: string): void {
    history.delete(handle);
    history.set(handle, traceId);
    while (history.size > MAX_RETIRED_TURN_HANDLES) {
      const oldest = history.keys().next();
      if (oldest.done) return;
      history.delete(oldest.value);
    }
  }

  async close(): Promise<void> {
    for (const token of [...this.channels.keys()]) this.revoke(token);
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else rejectClose(error);
      }));
    }
    if (!isWindowsPipeEndpoint(this.socketPath)
      && existsSync(this.socketPath)
      && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const windowsPipe = isWindowsPipeEndpoint(this.socketPath);
      if (!windowsPipe) mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      const listen = () => {
        const server = createServer(socket => this.handleSocket(socket));
        this.server = server;
        server.once("error", rejectStart);
        server.on("error", error => {
          console.error(
            `[lca-codex] turn broker server error at ${this.socketPath}: ${errorOf(error).message}`,
          );
        });
        server.listen(this.socketPath, () => {
          server.off("error", rejectStart);
          if (!windowsPipe) chmodSync(this.socketPath, 0o600);
          resolveStart();
        });
      };

      if (windowsPipe) {
        listen();
        return;
      }
      if (!existsSync(this.socketPath)) {
        listen();
        return;
      }
      if (!lstatSync(this.socketPath).isSocket()) {
        rejectStart(new Error(`LCA Codex broker path exists and is not a socket: ${this.socketPath}`));
        return;
      }
      const socketStat = lstatSync(this.socketPath);
      const getuid = process.getuid;
      if (typeof getuid === "function" && socketStat.uid !== getuid()) {
        rejectStart(new Error(`LCA Codex broker socket is not owned by the current user: ${this.socketPath}`));
        return;
      }
      if ((socketStat.mode & 0o077) !== 0) {
        rejectStart(new Error(`LCA Codex broker socket has unsafe permissions: ${this.socketPath}`));
        return;
      }
      const probe = createConnection(this.socketPath);
      let probeSettled = false;
      const finishProbe = (action: () => void) => {
        if (probeSettled) return;
        probeSettled = true;
        probe.destroy();
        action();
      };
      probe.setTimeout(2_000, () => finishProbe(() => {
        rejectStart(new Error(`Timed out while checking existing LCA Codex broker socket: ${this.socketPath}`));
      }));
      probe.once("connect", () => {
        finishProbe(() => {
          rejectStart(new Error(`LCA Codex broker socket is already owned by another process: ${this.socketPath}`));
        });
      });
      probe.once("error", error => {
        finishProbe(() => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNREFUSED" && code !== "ENOENT") {
            rejectStart(new Error(
              `Could not verify existing LCA Codex broker socket ${this.socketPath}: ${error.message}`,
            ));
            return;
          }
          try {
            if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
            listen();
          } catch (cleanupError) {
            rejectStart(errorOf(cleanupError));
          }
        });
      });
    });
    return this.startPromise;
  }

  private handleSocket(socket: Socket): void {
    let buffered = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
        handled = true;
        this.writeSocketResponse(socket, { id: "unknown", error: "turn broker request exceeds size limit" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffered.slice(0, newline);
      let request: BrokerRequest | undefined;
      try {
        if (line.length > MAX_BROKER_LINE_CHARS) throw new Error("turn broker request exceeds size limit");
        request = JSON.parse(line) as BrokerRequest;
        this.validateRequest(request);
      } catch (error) {
        this.writeSocketResponse(socket, { id: request?.id ?? "unknown", error: errorOf(error).message });
        return;
      }
      const sourceActivity = this.sourceToolActivity(request);
      const sourceStartedAt = Date.now();
      if (sourceActivity) {
        logLcaCodexActivity("lca_codex.tool_started", sourceActivity);
      }
      void Promise.resolve().then(() => this.dispatch(request!)).then(
        result => {
          if (sourceActivity) {
            const failed = Boolean(result && typeof result === "object" && (result as BrokerToolResult).isError === true);
            logLcaCodexActivity("lca_codex.tool_completed", {
              ...sourceActivity,
              durationMs: activityDuration(sourceStartedAt),
              status: failed ? "error" : "completed",
            }, failed ? "error" : "info");
          }
          this.writeSocketResponse(socket, { id: request!.id, result });
        },
        error => {
          if (sourceActivity) {
            logLcaCodexActivity("lca_codex.tool_completed", {
              ...sourceActivity,
              durationMs: activityDuration(sourceStartedAt),
              status: "error",
            }, "error");
          }
          this.writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message });
        },
      );
    });
  }

  private sourceToolActivity(request: BrokerRequest): {
    traceId: string;
    layer: string;
    tool: string;
    callId: string;
  } | null {
    const tool = request.sourceTool?.trim();
    if (!tool) return null;
    const channel = request.method === "claim"
      ? this.channels.get(request.token?.trim() ?? "")
      : this.bindings.get(request.bindingId?.trim() ?? "")?.channel;
    if (!channel) return null;
    return {
      traceId: channel.traceId,
      layer: "lca",
      tool,
      callId: activityCallId(request.id),
    };
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    const line = `${JSON.stringify(response)}\n`;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      socket.end(`${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`);
      return;
    }
    socket.end(line);
  }

  private validateRequest(request: BrokerRequest): void {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
      throw new Error("turn broker request id is invalid");
    }
    if (request.method !== "claim"
      && request.method !== "resolve"
      && request.method !== "release"
      && request.method !== "context_query"
      && request.method !== "invoke"
      && request.method !== "health_check") {
      throw new Error("turn broker method is invalid");
    }
    for (const value of [request.sourceTool, request.activityTool]) {
      if (value !== undefined && (!/^[A-Za-z0-9_.$:-]{1,1000}$/.test(value))) {
        throw new Error("turn broker activity tool name is invalid");
      }
    }
  }

  private dispatch(request: BrokerRequest): unknown | Promise<unknown> {
    this.prune();
    if (request.method === "health_check") return this.checkCodexTools();
    if (request.method === "claim") {
      const token = request.token?.trim();
      if (!token) throw new Error("turn token is required");
      const channel = this.channels.get(token);
      const retiredTurn = channel ? undefined : this.retiredTokens.get(token);
      console.error(
        `[lca-codex] broker claim received (tokenChars=${token.length}, valid=${Boolean(channel)}`
        + `${channel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!channel) {
        throw new Error(retiredTurn !== undefined
          ? `This turn_token was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
          + " Use the turn_token supplied with the current task context instead of one from earlier context."
          : "turn token is invalid, expired, or revoked");
      }
      if (channel.bindingId) {
        const existing = this.bindings.get(channel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== channel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: channel.bindingId, environment: channel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      channel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel });
      return { bindingId, environment: channel.environment };
    }

    const bindingId = request.bindingId?.trim();
    if (!bindingId) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      console.error(
        `[lca-codex] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)},`
        + ` retiredTurn=${retiredTurn ?? "unknown"})`,
      );
      throw new Error(retiredTurn !== undefined
        ? `This binding_id belongs to ${retiredTurnLabel(retiredTurn)}, which has already finished.`
        + " Call codex_bind_turn with the current turn_token and use the binding_id it returns."
        : "binding id is invalid or expired");
    }
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") {
      return { environment: binding.channel.environment };
    }
    if (request.method === "context_query") {
      const context = binding.channel.context;
      if (!context) throw new Error("this Codex turn has no lazy context snapshot");
      const action = request.action;
      if (!action) throw new Error("context action is required");
      const snapshot = context.snapshot;
      const maxChars = Math.min(100_000, Math.max(1_000, request.maxChars ?? 24_000));
      const limit = Math.min(20, Math.max(1, request.limit ?? 6));
      const offset = Math.max(0, request.offset ?? 0);

      if (action === "image") {
        const ref = request.attachmentRef?.trim();
        if (!ref) throw new Error("attachment_ref is required for context image retrieval");
        const attachment = snapshot.attachments.find(candidate => candidate.ref === ref);
        if (!attachment) throw new Error(`historical attachment is not available: ${ref}`);
        return {
          snapshot_id: snapshot.id,
          sha256: snapshot.digest,
          action,
          attachment: {
            ref: attachment.ref,
            message_id: attachment.messageId,
            image_url: attachment.imageUrl,
            ...(attachment.detail ? { detail: attachment.detail } : {}),
          },
        };
      }

      if (action === "full") {
        const fullHistory = withoutRetiredTurnHandles(JSON.stringify({
          version: 1,
          messages: snapshot.history.map(entry => ({ id: entry.id, ...entry.payload })),
        }));
        const content = fullHistory.slice(offset, offset + maxChars);
        const nextOffset = offset + content.length < fullHistory.length ? offset + content.length : null;
        return {
          snapshot_id: snapshot.id,
          sha256: snapshot.digest,
          action,
          offset,
          content,
          next_offset: nextOffset,
          total_chars: fullHistory.length,
        };
      }

      let entries: ChatGptContextEntry[];
      if (action === "instructions") {
        entries = snapshot.history.filter(entry => entry.role === "developer").slice(0, limit);
      } else if (action === "recent") {
        entries = snapshot.history.filter(entry => entry.role !== "developer").slice(-limit);
      } else if (action === "get") {
        const ids = new Set((request.ids ?? []).map(id => id.trim()).filter(Boolean));
        if (ids.size === 0) throw new Error("ids are required for context get");
        entries = snapshot.history.filter(entry => ids.has(entry.id)).slice(0, limit);
      } else if (action === "search") {
        const query = request.query?.trim().toLowerCase();
        if (!query) throw new Error("query is required for context search");
        const terms = query.split(/\s+/).filter(Boolean);
        entries = snapshot.history
          .filter(entry => entry.role !== "developer")
          .map(entry => {
            const haystack = entry.searchText.toLowerCase();
            const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
            return { entry, score };
          })
          .filter(match => match.score > 0)
          .sort((left, right) => right.score - left.score || right.entry.index - left.entry.index)
          .slice(offset, offset + limit)
          .map(match => match.entry);
      } else {
        throw new Error(`unsupported context action: ${action}`);
      }

      let remaining = maxChars;
      const packed: BrokerContextEntry[] = [];
      for (const entry of entries) {
        if (remaining <= 0) break;
        const serialized = withoutRetiredTurnHandles(JSON.stringify(entry.payload));
        const truncated = serialized.length > remaining;
        const content = truncated ? `${serialized.slice(0, Math.max(0, remaining - 18))}...[truncated]` : serialized;
        packed.push({
          id: entry.id,
          index: entry.index,
          role: entry.role,
          content,
          attachment_refs: entry.attachmentRefs,
          truncated,
        });
        remaining -= content.length;
      }
      return {
        snapshot_id: snapshot.id,
        sha256: snapshot.digest,
        action,
        entries: packed,
        total_entries: action === "instructions"
          ? snapshot.history.filter(entry => entry.role === "developer").length
          : snapshot.history.filter(entry => entry.role !== "developer").length,
        ...(action === "search" ? { query: request.query ?? "", next_offset: packed.length === limit ? offset + packed.length : null } : {}),
      };
    }

    const wireName = request.wireName?.trim();
    if (!wireName) throw new Error("wire tool name is required");
    return this.invokeChannel(
      binding.channel,
      wireName,
      request.freeform === true,
      request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} },
      request.activityTool?.trim() || wireName,
    );
  }

  private invokeChannel(
    channel: TurnChannel,
    wireName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    activityTool: string,
  ): Promise<BrokerToolResult> {
    const callId = opaqueId("call");
    const startedAt = Date.now();
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform,
      ...(freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    };
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      channel.invocations.set(callId, {
        request: toolRequest,
        activityTool,
        startedAt,
        resolve: resolveInvoke,
        reject: rejectInvoke,
      });
      channel.queuedCallIds.push(callId);
      logLcaCodexActivity("lca_codex.tool_started", {
        traceId: channel.traceId,
        layer: "codex",
        tool: activityTool,
        callId: activityCallId(callId),
      });
      console.info(
        `[lca-codex] broker trace=${channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${channel.waiters.size}`,
      );
      this.scheduleToolWaiters(channel);
    });
  }

  private exactEnvironmentTool(environment: ChatGptTurnEnvironment, name: string) {
    return environment.tools.find(tool => !tool.namespace && tool.name === name);
  }

  private exactTool(channel: TurnChannel, name: string) {
    return this.exactEnvironmentTool(channel.environment, name);
  }

  private execGateway(channel: TurnChannel) {
    const tool = this.exactTool(channel, "exec");
    return tool?.freeform ? tool : undefined;
  }

  private invokeNativeForHealthCheck(
    channel: TurnChannel,
    toolName: string,
    payload: { arguments?: Record<string, unknown>; input?: string },
    freeform = false,
  ): Promise<BrokerToolResult> {
    const gateway = this.execGateway(channel);
    if (gateway) {
      return this.invokeChannel(
        channel,
        gateway.name,
        true,
        { input: codexToolHealthGatewayProgram(toolName, payload, freeform) },
        toolName,
      );
    }
    const tool = this.exactTool(channel, toolName);
    if (!tool) throw new Error(`Codex tool is not available in this turn: ${toolName}`);
    return this.invokeChannel(
      channel,
      tool.name,
      tool.freeform === true,
      tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} },
      toolName,
    );
  }

  private async healthRoutes(channel: TurnChannel): Promise<{ routes: Set<string>; gatewayError?: string }> {
    const { routes } = declaredCodexToolHealthRoutes(channel.environment);
    const gateway = this.execGateway(channel);
    if (!gateway) return { routes };

    const program = codexToolHealthRegistryProgram();
    try {
      const result = await this.invokeChannel(
        channel,
        gateway.name,
        true,
        { input: program },
        "codex_tool_health_registry",
      );
      const parsed = parseCodexToolHealthRegistry(result);
      for (const name of CODEX_TOOL_HEALTH_ROUTE_NAMES) {
        if (parsed[name] === true) routes.add(name);
        else if (!this.exactTool(channel, name)) routes.delete(name);
      }
      return { routes };
    } catch (error) {
      return { routes, gatewayError: errorOf(error).message.slice(0, 500) };
    }
  }

  private async checkCodexTools(): Promise<CodexToolHealthReport> {
    const channels = [...this.channels.values()];
    const channel = channels.slice().reverse().find(candidate => candidate.waiters.size > 0);
    if (!channel) {
      const registered = channels.at(-1);
      if (registered) return passiveCodexToolHealthReport(registered.environment, registered.traceId, true);
      if (this.lastObserved) return passiveCodexToolHealthReport(this.lastObserved.environment, this.lastObserved.traceId, false);
      return unavailableCodexToolHealthReport(
        "No Codex tool-capable turn has been observed since this runtime started. Run one Codex task, then check again.",
      );
    }

    const { routes, gatewayError } = await this.healthRoutes(channel);
    return runCodexToolHealthSmoke({
      environment: channel.environment,
      traceId: channel.traceId,
      routes,
      gatewayError,
      invoke: (toolName, payload, freeform) => this.invokeNativeForHealthCheck(channel, toolName, payload, freeform),
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    return ids.map(id => channel.invocations.get(id)?.request).filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    console.info(
      `[lca-codex] broker trace=${channel.traceId} delivered calls=${batch.length} tools=${batch.map(request => request.wireName).join(",")}`,
    );
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    for (const [callId, invocation] of channel.invocations) {
      logLcaCodexActivity("lca_codex.tool_completed", {
        traceId: channel.traceId,
        layer: "codex",
        tool: invocation.activityTool,
        callId: activityCallId(callId),
        durationMs: activityDuration(invocation.startedAt),
        status: "error",
      }, "error");
      invocation.reject(error);
    }
    channel.invocations.clear();
    channel.queuedCallIds = [];
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, channel] of this.channels) {
      if (channel.environment.expiresAt === undefined || channel.environment.expiresAt > now) continue;
      this.revoke(token);
    }
  }
}

/**
 * A turn registered without a TTL has no deadline to bound its tool calls against, so a null
 * timeout waits for as long as the turn itself lives. Undefined keeps the bounded default, because
 * a caller that cannot compute a deadline must not silently inherit an unbounded wait. An
 * unbounded call still ends when the turn is revoked or the broker drops the connection.
 */
export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
): Promise<T> {
  const id = opaqueId("request");
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectCall(error);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => finishError(new Error("LCA Codex turn broker timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`LCA Codex turn broker unavailable: ${error.message}`)));
    socket.once("close", () => finishError(new Error("LCA Codex turn broker closed the connection")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("LCA Codex turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response: BrokerResponse;
      try {
        response = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`LCA Codex turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (response.id !== id) {
        finishError(new Error("LCA Codex turn broker response id mismatch"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    });
  });
}
