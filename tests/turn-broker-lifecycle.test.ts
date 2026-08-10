import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/lca-codex/turn-execution";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/lca-codex/turn-broker";
import type { ChatGptContextSnapshot } from "../src/adapters/lca-codex/prompt";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

test("explicit browser-turn cancellation aborts and removes every registered session", async () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const replayable = sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  await replayable.browserOutcome;
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("lifecycle cancellation targets only the matching Codex thread and turn", () => {
  const sessions = new ChatGptTurnSessions();
  const cancelled: string[] = [];
  const runtime = (name: string) => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled.push(name); },
  });
  sessions.getOrCreate("a1", () => runtime("a1"), { threadId: "thread-a", turnId: "turn-1", purpose: "response" });
  sessions.getOrCreate("a2", () => runtime("a2"), { threadId: "thread-a", turnId: "turn-2", purpose: "response" });
  sessions.getOrCreate("b1", () => runtime("b1"), { threadId: "thread-b", turnId: "turn-1", purpose: "response" });

  expect(sessions.retireThreadTurn("thread-a", "turn-1")).toBe(1);
  expect(cancelled).toEqual(["a1"]);
  expect(sessions.activeCount()).toBe(2);
  expect(sessions.retireThread("thread-a")).toBe(1);
  expect(cancelled).toEqual(["a1", "a2"]);
  expect(sessions.activeCount()).toBe(1);
  sessions.clear();
});

test("session cache expiry never cancels a still-active long browser turn", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let cancelled = 0;
  const active = sessions.getOrCreate("long-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  await Bun.sleep(5);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("long-turn", () => {
    throw new Error("active session must be reused");
  })).toBe(active);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("five active turns coexist and a sixth fails closed", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 5 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(5);
  expect(cancelled).toBe(0);
  expect(() => sessions.getOrCreate("turn-6", runtime)).toThrow("at most 5 simultaneous browser turns");

  expect(sessions.getOrCreate("turn-3", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[2]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(5);
});

test("settled replay sessions expire from their last use instead of their creation time", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("done"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };
  const first = sessions.getOrCreate("replay", start);
  await first.browserOutcome;
  await Bun.sleep(10);
  expect(sessions.getOrCreate("replay", start)).toBe(first);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("replay", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("a retryable browser failure schedules only one fresh browser attempt", async () => {
  const sessions = new ChatGptTurnSessions();
  const key = "bounded-retry";
  let starts = 0;
  let cancellations = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      attempt: sessions.retryAttempt(key),
      browser: Promise.reject(new Error("retryable upstream failure")),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancellations += 1; },
    };
  };

  const first = sessions.getOrCreate(key, start);
  await first.browserOutcome;
  expect(first.runtime.attempt).toBe(1);
  expect(sessions.scheduleRetry(key, first)).toBe(2);

  const second = sessions.getOrCreate(key, start);
  await second.browserOutcome;
  expect(second.runtime.attempt).toBe(2);
  expect(sessions.scheduleRetry(key, second)).toBeNull();
  expect(sessions.getOrCreate(key, start)).toBe(second);
  expect(starts).toBe(2);
  expect(cancellations).toBe(1);
  sessions.clear();
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    if (process.platform === "win32") {
      expect(isWindowsPipeEndpoint(socketPath)).toBe(true);
    } else {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker serves immutable context in order, replays the last chunk, and gates native tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-context-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const serialized = "{\"version\":4,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}";
  const snapshot: ChatGptContextSnapshot = {
    id: "ctx_test",
    digest: "a".repeat(64),
    serialized,
    totalChars: serialized.length,
    estimatedTextTokens: 20,
    history: [
      {
        id: "instructions-0",
        index: 0,
        role: "developer",
        payload: { role: "developer", content: "<skills_instructions>skill-installer catalog</skills_instructions>" },
        searchText: "skill-installer catalog",
        attachmentRefs: [],
      },
      {
        id: "history-0",
        index: 1,
        role: "user",
        payload: { role: "user", content: "hello historical world" },
        searchText: "hello historical world",
        attachmentRefs: [],
      },
    ],
    attachments: [],
    images: [],
  };
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000, "context-test", snapshot);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const recent = await callTurnBroker<{ entries: Array<{ id: string; content: string }> }>(socketPath, {
      method: "context_query",
      bindingId: claimed.bindingId,
      action: "recent",
      limit: 4,
    });
    expect(recent.entries).toHaveLength(1);
    expect(recent.entries[0]).toMatchObject({ id: "history-0" });
    expect(recent.entries[0]!.content).toContain("hello historical world");

    const instructions = await callTurnBroker<{ entries: Array<{ id: string; content: string }> }>(socketPath, {
      method: "context_query",
      bindingId: claimed.bindingId,
      action: "instructions",
      limit: 4,
    });
    expect(instructions.entries.map(entry => entry.id)).toEqual(["instructions-0"]);
    expect(instructions.entries[0]!.content).toContain("skill-installer catalog");

    const searched = await callTurnBroker<{ entries: Array<{ id: string }> }>(socketPath, {
      method: "context_query",
      bindingId: claimed.bindingId,
      action: "search",
      query: "historical",
    });
    expect(searched.entries.map(entry => entry.id)).toEqual(["history-0"]);

    const full = await callTurnBroker<{ content: string; next_offset: number | null }>(socketPath, {
      method: "context_query",
      bindingId: claimed.bindingId,
      action: "full",
      maxChars: 24_000,
    });
    expect(full.content).toContain("hello historical world");
    expect(full.next_offset).toBeNull();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker health check exercises direct command and stdin tools without touching patch or image tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-health-direct-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [
        { name: "exec_command", description: "Run command", parameters: { type: "object" } },
        { name: "write_stdin", description: "Write stdin", parameters: { type: "object" } },
        { name: "apply_patch", description: "Patch", parameters: {}, freeform: true },
        { name: "view_image", description: "View image", parameters: { type: "object" } },
      ],
    }, 10_000, "health-direct");

    const firstBatch = broker.nextToolBatch(token);
    const reportPromise = callTurnBroker<{
      activeTurn: boolean;
      live: boolean;
      tools: Array<{ name: string; status: string; detail: string }>;
    }>(socketPath, { method: "health_check" });
    const [execRequest] = await firstBatch;
    expect(execRequest).toMatchObject({ wireName: "exec_command", freeform: false });
    broker.completeTool(token, execRequest!.callId, {
      content: [{ type: "text", text: JSON.stringify({ session_id: 17 }) }],
      structuredContent: { session_id: 17 },
    });

    const [stdinRequest] = await broker.nextToolBatch(token);
    expect(stdinRequest).toMatchObject({ wireName: "write_stdin", freeform: false });
    expect(stdinRequest?.arguments).toMatchObject({ session_id: 17, chars: "LCA_CODEX_TOOL_CHECK_STDIN\n" });
    broker.completeTool(token, stdinRequest!.callId, {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { output: "ok" },
    });

    const report = await reportPromise;
    expect(report.activeTurn).toBe(true);
    expect(report.live).toBe(true);
    expect(report.tools.find(tool => tool.name === "exec_command")?.status).toBe("working");
    expect(report.tools.find(tool => tool.name === "write_stdin")?.status).toBe("working");
    expect(report.tools.find(tool => tool.name === "apply_patch")).toMatchObject({ status: "available" });
    expect(report.tools.find(tool => tool.name === "view_image")).toMatchObject({ status: "available" });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker health check discovers nested native routes through the exec gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-health-gateway-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{ name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true }],
    }, 10_000, "health-gateway");

    const registryBatch = broker.nextToolBatch(token);
    const reportPromise = callTurnBroker<{
      activeTurn: boolean;
      live: boolean;
      tools: Array<{ name: string; status: string; detail: string }>;
    }>(socketPath, { method: "health_check" });
    const [registryRequest] = await registryBatch;
    expect(registryRequest).toMatchObject({ wireName: "exec", freeform: true });
    expect(registryRequest?.input).toContain("LCA_CODEX_TOOL_HEALTH_ROUTES:");
    broker.completeTool(token, registryRequest!.callId, {
      content: [{
        type: "text",
        text: "Script completed\nOutput:\nLCA_CODEX_TOOL_HEALTH_ROUTES:{\"exec_command\":true,\"shell_command\":false,\"write_stdin\":true,\"apply_patch\":true,\"view_image\":true}\n",
      }],
    });

    const [execRequest] = await broker.nextToolBatch(token);
    expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
    expect(execRequest?.input).toContain('tools["exec_command"]');
    broker.completeTool(token, execRequest!.callId, {
      content: [{ type: "text", text: JSON.stringify({ session_id: 23 }) }],
    });

    const [stdinRequest] = await broker.nextToolBatch(token);
    expect(stdinRequest).toMatchObject({ wireName: "exec", freeform: true });
    expect(stdinRequest?.input).toContain('tools["write_stdin"]');
    broker.completeTool(token, stdinRequest!.callId, {
      content: [{ type: "text", text: "ok" }],
    });

    const report = await reportPromise;
    expect(report.activeTurn).toBe(true);
    expect(report.live).toBe(true);
    expect(report.tools.map(tool => [tool.name, tool.status])).toEqual([
      ["exec_command", "working"],
      ["write_stdin", "working"],
      ["apply_patch", "available"],
      ["view_image", "available"],
    ]);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker health check keeps advertised native routes visible between and after Codex tool rounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-health-idle-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec",
        description: [
          "Run nested Codex tools",
          "### `exec_command`",
          "declare const tools: { exec_command(args: object): Promise<unknown>; };",
          "### `write_stdin`",
          "declare const tools: { write_stdin(args: object): Promise<unknown>; };",
          "### `apply_patch`",
          "declare const tools: { apply_patch(input: string): Promise<unknown>; };",
          "### `view_image`",
          "declare const tools: { view_image(args: object): Promise<unknown>; };",
        ].join("\n"),
        parameters: {},
        freeform: true,
      }],
    }, 10_000, "health-idle");
    const registered = await callTurnBroker<{
      activeTurn: boolean;
      live: boolean;
      traceId: string | null;
      tools: Array<{ name: string; status: string; detail: string }>;
    }>(socketPath, { method: "health_check" });
    expect(registered.activeTurn).toBe(true);
    expect(registered.live).toBe(false);
    expect(registered.traceId).toBe("health-idle");
    expect(registered.tools.map(tool => [tool.name, tool.status])).toEqual([
      ["exec_command", "available"],
      ["write_stdin", "available"],
      ["apply_patch", "available"],
      ["view_image", "available"],
    ]);
    expect(registered.tools[0]?.detail).toContain("Live smoke test will run when this turn is waiting");

    broker.revoke(token);
    const retired = await callTurnBroker<{
      activeTurn: boolean;
      live: boolean;
      traceId: string | null;
      tools: Array<{ status: string; detail: string }>;
    }>(socketPath, { method: "health_check" });
    expect(retired.activeTurn).toBe(false);
    expect(retired.live).toBe(false);
    expect(retired.traceId).toBe("health-idle");
    expect(retired.tools.every(tool => tool.status === "available")).toBe(true);
    expect(retired.tools[0]?.detail).toContain("most recently observed Codex turn");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker tokens do not expire while their browser turn is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unbounded-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    await Bun.sleep(5);
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function unansweredBrokerEndpoint(name: string, onConnection: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), name));
  const socketPath = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer(onConnection);
  return {
    socketPath,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an unbounded broker call fails when the broker closes without answering", async () => {
  const broker = unansweredBrokerEndpoint("cgw-broker-closed-", socket => socket.on("data", () => socket.end()));
  await broker.listen();
  try {
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: "turn_closed" }, null))
      .rejects.toThrow("closed the connection");
  } finally {
    await broker.close();
  }
}, 10_000);

test("an unbounded broker call outlives the bounded default timeout", async () => {
  const accepted: Socket[] = [];
  const broker = unansweredBrokerEndpoint("cgw-broker-slow-", socket => { accepted.push(socket); });
  await broker.listen();
  try {
    const call = callTurnBroker(broker.socketPath, { method: "claim", token: "turn_unbounded" }, null);
    const outcome = await Promise.race([
      call.then(() => "settled", () => "settled"),
      Bun.sleep(5_300).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
  } finally {
    for (const socket of accepted) socket.destroy();
    await broker.close();
  }
}, 15_000);

test("turn broker names the finished turn that owns a replayed handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 60_000, "turn-alpha");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.revoke(token);

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };

    const replayedBinding = await rejection({
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(replayedBinding).toContain("turn-alpha");
    expect(replayedBinding).toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("binding id is invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
