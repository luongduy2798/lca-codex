const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  installProcessDiagnosticGuards,
  parseLcaCodexActivity,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("LCA Codex activity accepts only known payload-free diagnostic fields", () => {
  const parsed = parseLcaCodexActivity(`[lca-codex-activity] ${JSON.stringify({
    event: "lca_codex.tool_completed",
    level: "info",
    detail: {
      traceId: "abc123",
      threadId: "thread_test_123",
      layer: "codex",
      tool: "mcp__files__read",
      durationMs: 1_250,
      status: "completed",
      prompt: "must not be logged",
      arguments: { path: "/private/file" },
      output: "must not be logged",
    },
  })}`);

  assert.deepEqual(parsed, {
    event: "lca_codex.tool_completed",
    level: "info",
    detail: {
      traceId: "abc123",
      threadId: "thread_test_123",
      layer: "codex",
      tool: "mcp__files__read",
      durationMs: 1_250,
      status: "completed",
    },
  });
  assert.equal(parseLcaCodexActivity(
    '[lca-codex-activity] {"event":"lca_codex.unknown","level":"info","detail":{}}',
  ), null);
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher activity paginates by chat, then lazily loads task summaries and one task's records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-chat-page-"));
  const filePath = path.join(root, "launcher.jsonl");
  const record = (at, event, detail) => JSON.stringify({ at, level: "info", event, detail });
  try {
    fs.writeFileSync(`${filePath}.1`, [
      record("2026-07-28T00:00:01.000Z", "lca_codex.turn_started", {
        traceId: "trace_a111",
        threadId: "thread_a111",
      }),
      record("2026-07-28T00:00:02.000Z", "lca_codex.turn_completed", { traceId: "trace_a111" }),
      "",
    ].join("\n"));
    fs.writeFileSync(filePath, [
      record("2026-07-28T00:00:03.000Z", "lca_codex.turn_started", {
        traceId: "trace_a222",
        threadId: "thread_a111",
      }),
      record("2026-07-28T00:00:04.000Z", "lca_codex.turn_completed", { traceId: "trace_a222" }),
      record("2026-07-28T00:00:05.000Z", "lca_codex.turn_started", {
        traceId: "trace_b111",
        threadId: "thread_b111",
      }),
      record("2026-07-28T00:00:06.000Z", "lca_codex.turn_completed", { traceId: "trace_b111" }),
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });

    const latest = logger.activityChatsPage({ limit: 1 });
    assert.deepEqual(latest.chats.map(chat => chat.id), ["chat:thread_b111"]);
    assert.equal(latest.chats[0].taskCount, 1);
    assert.equal(latest.chats[0].eventCount, 2);
    assert.equal(latest.hasMore, true);
    assert.equal(typeof latest.nextCursor, "string");

    logger.info("lca_codex.turn_started", { traceId: "trace_new999", threadId: "thread_new999" });
    const older = logger.activityChatsPage({ cursor: latest.nextCursor, limit: 1 });
    assert.deepEqual(older.chats.map(chat => chat.id), ["chat:thread_a111"]);
    assert.equal(older.chats[0].taskCount, 2);
    assert.equal(older.chats[0].eventCount, 4);
    assert.equal(older.hasMore, false);

    const chatTasks = logger.activityChatTasks({ chatId: "chat:thread_a111" });
    assert.deepEqual(chatTasks.map(task => task.traceId), ["trace_a222", "trace_a111"]);
    assert.deepEqual(chatTasks.map(task => task.eventCount), [2, 2]);
    assert.equal(Object.hasOwn(chatTasks[0], "records"), false);

    const taskRecords = logger.activityTaskRecords({ traceId: "trace_a111" });
    assert.deepEqual(taskRecords.map(item => item.detail.traceId), ["trace_a111", "trace_a111"]);
    assert.equal(taskRecords.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher Activity deletes one task, one chat, or all retained logs from disk and memory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-activity-delete-"));
  const filePath = path.join(root, "launcher.jsonl");
  const record = (at, event, detail) => JSON.stringify({ at, level: "info", event, detail });
  try {
    fs.writeFileSync(`${filePath}.1`, [
      record("2026-07-28T00:00:01.000Z", "lca_codex.turn_started", { traceId: "trace_delete_a1", threadId: "thread_delete_a" }),
      record("2026-07-28T00:00:02.000Z", "lca_codex.turn_completed", { traceId: "trace_delete_a1" }),
      "",
    ].join("\n"));
    fs.writeFileSync(filePath, [
      record("2026-07-28T00:00:03.000Z", "lca_codex.turn_started", { traceId: "trace_delete_a2", threadId: "thread_delete_a" }),
      record("2026-07-28T00:00:04.000Z", "lca_codex.turn_completed", { traceId: "trace_delete_a2" }),
      record("2026-07-28T00:00:05.000Z", "lca_codex.turn_started", { traceId: "trace_delete_b1", threadId: "thread_delete_b" }),
      record("2026-07-28T00:00:06.000Z", "lca_codex.turn_completed", { traceId: "trace_delete_b1" }),
      record("2026-07-28T00:00:07.000Z", "launcher.system_test", {}),
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });

    assert.deepEqual(logger.deleteActivity({ scope: "task", traceId: "trace_delete_a1" }), { deleted: 2 });
    assert.equal(logger.activityTaskRecords({ traceId: "trace_delete_a1" }).length, 0);
    assert.deepEqual(
      logger.activityChatTasks({ chatId: "chat:thread_delete_a" }).map(task => task.traceId),
      ["trace_delete_a2"],
    );
    assert.equal(fs.existsSync(`${filePath}.1`), false);

    assert.deepEqual(logger.deleteActivity({ scope: "chat", chatId: "chat:thread_delete_a" }), { deleted: 2 });
    assert.deepEqual(logger.activityChatsPage({ limit: 20 }).chats.map(chat => chat.id), [
      "system",
      "chat:thread_delete_b",
    ]);
    assert.equal(fs.readFileSync(filePath, "utf8").includes("trace_delete_a2"), false);

    assert.deepEqual(logger.deleteActivity({ scope: "all" }), { deleted: 3 });
    assert.deepEqual(logger.activityChatsPage({ limit: 20 }).chats, []);
    assert.deepEqual(logger.recent(), []);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(`${filePath}.1`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher Activity excludes native-tool health probe traces while retaining their raw diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-health-activity-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    const logger = createLogger({ filePath });
    logger.info("lca_codex.tool_started", {
      traceId: "health-probe123",
      layer: "codex",
      tool: "exec_command",
      callId: "call_health123",
    });
    logger.info("lca_codex.tool_completed", {
      traceId: "health-probe123",
      layer: "codex",
      tool: "exec_command",
      callId: "call_health123",
      status: "completed",
    });
    logger.info("lca_codex.turn_started", {
      traceId: "trace_visible123",
      threadId: "thread_visible123",
    });

    assert.deepEqual(logger.activityChatsPage({ limit: 20 }).chats.map((chat) => chat.id), [
      "chat:thread_visible123",
    ]);
    assert.deepEqual(logger.activityTaskRecords({ traceId: "health-probe123" }), []);
    assert.equal(logger.recent().filter((record) => record.detail.traceId === "health-probe123").length, 2);
    assert.match(fs.readFileSync(filePath, "utf8"), /health-probe123/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher Activity keeps its retained index in memory across repeated IPC pagination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-activity-index-"));
  const filePath = path.join(root, "launcher.jsonl");
  const record = (at, event, detail) => JSON.stringify({ at, level: "info", event, detail });
  try {
    fs.writeFileSync(`${filePath}.1`, [
      record("2026-07-28T00:00:01.000Z", "lca_codex.turn_started", { traceId: "trace_cached_a", threadId: "thread_cached_a" }),
      record("2026-07-28T00:00:02.000Z", "lca_codex.turn_completed", { traceId: "trace_cached_a" }),
      "",
    ].join("\n"));
    fs.writeFileSync(filePath, [
      record("2026-07-28T00:00:03.000Z", "lca_codex.turn_started", { traceId: "trace_cached_b", threadId: "thread_cached_b" }),
      record("2026-07-28T00:00:04.000Z", "lca_codex.turn_completed", { traceId: "trace_cached_b" }),
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });

    // Removing the backing files after logger construction proves Activity pagination and
    // drill-down use the retained in-memory index instead of reopening both JSONL files.
    fs.rmSync(filePath, { force: true });
    fs.rmSync(`${filePath}.1`, { force: true });

    const first = logger.activityChatsPage({ limit: 1 });
    assert.deepEqual(first.chats.map(chat => chat.id), ["chat:thread_cached_b"]);
    const second = logger.activityChatsPage({ cursor: first.nextCursor, limit: 1 });
    assert.deepEqual(second.chats.map(chat => chat.id), ["chat:thread_cached_a"]);
    assert.deepEqual(
      logger.activityChatTasks({ chatId: "chat:thread_cached_a" }).map(task => task.traceId),
      ["trace_cached_a"],
    );
    assert.equal(logger.activityTaskRecords({ traceId: "trace_cached_a" }).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher activity links task traces to the latest local Codex chat title", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-thread-title-"));
  const filePath = path.join(root, "launcher.jsonl");
  const threadIndexPath = path.join(root, "session_index.jsonl");
  const published = [];
  try {
    fs.writeFileSync(threadIndexPath, [
      JSON.stringify({ id: "thread_test_123", thread_name: "Old title" }),
      JSON.stringify({ id: "thread_test_123", thread_name: "Current title" }),
      "",
    ].join("\n"));
    const logger = createLogger({ filePath, threadIndexPath, publish: record => published.push(record) });
    logger.info("lca_codex.turn_started", { traceId: "trace123", threadId: "thread_test_123" });
    logger.info("browser.turn_started", { traceId: "trace123" });

    assert.deepEqual(published.map(record => record.detail), [
      { traceId: "trace123", threadId: "thread_test_123", chatTitle: "Current title" },
      { traceId: "trace123", threadId: "thread_test_123", chatTitle: "Current title" },
    ]);
    assert.equal(logger.recent()[0].detail.chatTitle, "Current title");
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8").split("\n")[0]).detail.chatTitle, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
