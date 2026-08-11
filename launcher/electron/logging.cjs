const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile, writePrivateFileAtomic } = require("./atomic-file.cjs");

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 300;
const MAX_LOG_STRING_CHARS = 16 * 1024;
const MAX_THREAD_TITLE_CHARS = 240;
const MAX_THREAD_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_THREAD_TITLES = 20_000;
const MAX_ACTIVITY_TRACE_THREADS = 20_000;
const THREAD_TITLE_REFRESH_MS = 1_000;
const ACTIVITY_STALL_MS = 30_000;
const LCA_CODEX_ACTIVITY_PREFIX = "[lca-codex-activity] ";
const LCA_CODEX_HELPER_ACTIVITY_PREFIX = `[lca-codex-helper] ${LCA_CODEX_ACTIVITY_PREFIX}`;
const LCA_CODEX_ACTIVITY_EVENTS = new Set([
  "lca_codex.turn_started",
  "lca_codex.turn_send_accepted",
  "lca_codex.turn_first_response",
  "lca_codex.turn_first_reasoning",
  "lca_codex.turn_first_text",
  "lca_codex.turn_completed",
  "lca_codex.turn_failed",
  "lca_codex.turn_retry_scheduled",
  "lca_codex.turn_retry_stopped",
  "lca_codex.tool_started",
  "lca_codex.tool_completed",
]);
const LCA_CODEX_ACTIVITY_DETAIL_KEYS = new Set([
  "attempt",
  "callId",
  "code",
  "durationMs",
  "elapsedMs",
  "layer",
  "mode",
  "nextAttempt",
  "reason",
  "responseChars",
  "sinceSendMs",
  "status",
  "taskTitle",
  "tool",
  "threadId",
  "traceId",
]);

function redactText(value) {
  const redacted = value
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[runtime-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{20,}\b/gi, "Bearer [redacted]");
  return redacted.length > MAX_LOG_STRING_CHARS
    ? `${redacted.slice(0, MAX_LOG_STRING_CHARS)}…[truncated]`
    : redacted;
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(?:authorization|cookie|runtimeKey|controlToken)/i.test(key)
        ? "[redacted]"
        : sanitize(item, seen),
    ]),
  );
}

function parseLcaCodexActivity(line) {
  if (typeof line !== "string") return null;
  const prefix = line.startsWith(LCA_CODEX_ACTIVITY_PREFIX)
    ? LCA_CODEX_ACTIVITY_PREFIX
    : line.startsWith(LCA_CODEX_HELPER_ACTIVITY_PREFIX)
      ? LCA_CODEX_HELPER_ACTIVITY_PREFIX
      : null;
  if (!prefix) return null;
  const encoded = line.slice(prefix.length);
  if (!encoded || encoded.length > 8 * 1024) return null;
  try {
    const value = JSON.parse(encoded);
    if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || !LCA_CODEX_ACTIVITY_EVENTS.has(value.event)
      || !["info", "warning", "error"].includes(value.level)
      || !value.detail
      || typeof value.detail !== "object"
      || Array.isArray(value.detail)) return null;
    const detail = {};
    for (const [key, item] of Object.entries(value.detail)) {
      if (!LCA_CODEX_ACTIVITY_DETAIL_KEYS.has(key)) continue;
      if (item === null || ["string", "number", "boolean"].includes(typeof item)) detail[key] = item;
    }
    return { event: value.event, level: value.level, detail };
  } catch {
    return null;
  }
}

function readRecent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_MEMORY_RECORDS)
      .flatMap((line) => {
        const record = parsePersistedRecord(line);
        return record ? [record] : [];
      });
  } catch {
    return [];
  }
}

function parsePersistedRecord(line) {
  try {
    const record = JSON.parse(line);
    if (!record
      || typeof record.at !== "string"
      || !["debug", "info", "warning", "error"].includes(record.level)
      || typeof record.event !== "string") return null;
    return {
      at: record.at,
      level: record.level,
      event: record.event,
      detail: record.detail && typeof record.detail === "object"
        ? sanitize(record.detail)
        : {},
    };
  } catch {
    return null;
  }
}

function readPersistedRecords(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const record = parsePersistedRecord(line);
        return record ? [record] : [];
      });
  } catch {
    return [];
  }
}

function activityTraceId(record) {
  const explicit = activityIdentifier(record?.detail?.traceId);
  if (explicit && explicit !== "unknown") return explicit;
  const line = typeof record?.detail?.line === "string" ? record.detail.line : "";
  const browserTurn = /\bbrowser turn ([A-Za-z0-9_-]{6,128})\b/.exec(line)?.[1];
  if (browserTurn && browserTurn !== "unknown") return browserTurn;
  const trace = /\btrace=([A-Za-z0-9_-]{6,128})\b/.exec(line)?.[1];
  return trace && trace !== "unknown" ? trace : null;
}

function activityRecordTimestamp(record) {
  const timestamp = Date.parse(record?.at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareActivityChats(left, right) {
  const timestamp = activityRecordTimestamp({ at: right.lastAt }) - activityRecordTimestamp({ at: left.lastAt });
  return timestamp || left.id.localeCompare(right.id);
}

function encodeActivityChatCursor(chat) {
  return Buffer.from(JSON.stringify({ at: chat.lastAt, id: chat.id }), "utf8").toString("base64url");
}

function decodeActivityChatCursor(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded
      || typeof decoded !== "object"
      || typeof decoded.at !== "string"
      || typeof decoded.id !== "string"
      || !Number.isFinite(Date.parse(decoded.at))
      || decoded.id.length > 256) return null;
    return { at: decoded.at, id: decoded.id };
  } catch {
    return null;
  }
}

function isActivityHealthRecord(record) {
  return activityTraceId(record)?.startsWith("health-") === true;
}

function buildActivityChats(tasks, system) {
  const chatsById = new Map();
  for (const task of tasks) {
    const current = chatsById.get(task.chatId);
    const title = task.chatTitle
      || (task.threadId ? `Chat ${task.threadId.slice(0, 8)}` : `Task ${task.traceId}`);
    if (!current) {
      chatsById.set(task.chatId, {
        id: task.chatId,
        kind: task.threadId ? "chat" : "trace",
        threadId: task.threadId,
        title,
        taskCount: 1,
        eventCount: task.records.length,
        lastAt: task.lastAt,
      });
      continue;
    }
    current.taskCount += 1;
    current.eventCount += task.records.length;
    if (activityRecordTimestamp({ at: task.lastAt }) > activityRecordTimestamp({ at: current.lastAt })) {
      current.lastAt = task.lastAt;
    }
    if (task.chatTitle) current.title = task.chatTitle;
  }

  if (system.length > 0) {
    chatsById.set("system", {
      id: "system",
      kind: "system",
      threadId: null,
      title: "System activity",
      taskCount: 0,
      eventCount: system.length,
      lastAt: system.at(-1).at,
    });
  }
  return [...chatsById.values()].sort(compareActivityChats);
}

function buildRetainedActivityFromRecords(retainedRecords, decorateActivityRecord) {
  // Prime trace -> thread mappings first so records that precede the first explicit
  // threadId for a task still receive the correct chat association.
  for (const record of retainedRecords) decorateActivityRecord(record);
  const records = retainedRecords
    .map((record) => decorateActivityRecord(record))
    .filter((record) => !isActivityHealthRecord(record));
  const tasksByTrace = new Map();
  const system = [];

  for (const record of records) {
    const traceId = activityTraceId(record);
    if (!traceId) {
      system.push(record);
      continue;
    }
    const taskRecords = tasksByTrace.get(traceId) ?? [];
    taskRecords.push(record);
    tasksByTrace.set(traceId, taskRecords);
  }

  const tasks = [...tasksByTrace].map(([traceId, taskRecords]) => {
    taskRecords.sort((left, right) => activityRecordTimestamp(left) - activityRecordTimestamp(right));
    let threadId = null;
    let chatTitle = null;
    let taskTitle = null;
    for (const record of taskRecords) {
      const recordThreadId = activityIdentifier(record.detail?.threadId);
      const recordChatTitle = typeof record.detail?.chatTitle === "string" ? record.detail.chatTitle.trim() : "";
      const recordTaskTitle = typeof record.detail?.taskTitle === "string" ? record.detail.taskTitle.trim() : "";
      if (recordThreadId) threadId = recordThreadId;
      if (recordChatTitle) chatTitle = recordChatTitle;
      if (recordTaskTitle) taskTitle = recordTaskTitle;
    }
    const lastAt = taskRecords.at(-1)?.at ?? new Date(0).toISOString();
    return {
      traceId,
      threadId,
      chatTitle,
      taskTitle,
      chatId: threadId ? `chat:${threadId}` : `trace:${traceId}`,
      records: taskRecords,
      lastAt,
    };
  });

  system.sort((left, right) => activityRecordTimestamp(left) - activityRecordTimestamp(right));

  return {
    chats: buildActivityChats(tasks, system),
    tasks,
    system,
  };
}

function createRetainedActivityIndex(filePath, decorateActivityRecord, initialRecords = {}) {
  let rotatedRecords = initialRecords.rotatedRecords ?? readPersistedRecords(`${filePath}.1`);
  let currentRecords = initialRecords.currentRecords ?? readPersistedRecords(filePath);
  let cached = null;
  let cachedTasksByTrace = new Map();
  let chatsDirty = false;
  let dirty = true;

  const snapshot = () => {
    if (dirty || !cached) {
      cached = buildRetainedActivityFromRecords(
        [...rotatedRecords, ...currentRecords],
        decorateActivityRecord,
      );
      cachedTasksByTrace = new Map(cached.tasks.map(task => [task.traceId, task]));
      dirty = false;
      chatsDirty = false;
    } else if (chatsDirty) {
      cached.chats = buildActivityChats(cached.tasks, cached.system);
      chatsDirty = false;
    }
    return cached;
  };

  const append = (record, { rotated = false } = {}) => {
    if (rotated) {
      // The previous current file is now the only retained .1 generation; the older
      // .1 file was removed before rename. Keep the same bounded two-generation view
      // in memory without rereading either JSONL file.
      rotatedRecords = currentRecords;
      currentRecords = [];
    }
    currentRecords.push(record);
    if (rotated || dirty || !cached) {
      dirty = true;
      return;
    }

    const decorated = decorateActivityRecord(record);
    if (isActivityHealthRecord(decorated)) return;
    const traceId = activityTraceId(decorated);
    if (!traceId) {
      const previousLast = cached.system.at(-1);
      cached.system.push(decorated);
      if (previousLast && activityRecordTimestamp(previousLast) > activityRecordTimestamp(decorated)) {
        cached.system.sort((left, right) => activityRecordTimestamp(left) - activityRecordTimestamp(right));
      }
      chatsDirty = true;
      return;
    }

    let task = cachedTasksByTrace.get(traceId);
    const threadId = activityIdentifier(decorated.detail?.threadId);
    const chatTitle = typeof decorated.detail?.chatTitle === "string"
      ? decorated.detail.chatTitle.trim()
      : "";
    const taskTitle = typeof decorated.detail?.taskTitle === "string"
      ? decorated.detail.taskTitle.trim()
      : "";
    if (!task) {
      task = {
        traceId,
        threadId,
        chatTitle: chatTitle || null,
        taskTitle: taskTitle || null,
        chatId: threadId ? `chat:${threadId}` : `trace:${traceId}`,
        records: [],
        lastAt: decorated.at,
      };
      cached.tasks.push(task);
      cachedTasksByTrace.set(traceId, task);
    }
    const threadChanged = Boolean(threadId && task.threadId !== threadId);
    const titleChanged = Boolean(chatTitle && task.chatTitle !== chatTitle);
    const taskTitleChanged = Boolean(taskTitle && task.taskTitle !== taskTitle);
    if (threadId) {
      task.threadId = threadId;
      task.chatId = `chat:${threadId}`;
    }
    if (chatTitle) task.chatTitle = chatTitle;
    if (taskTitle) task.taskTitle = taskTitle;
    if ((threadChanged || titleChanged || taskTitleChanged) && task.records.length > 0) {
      task.records = task.records.map(previous => ({
        ...previous,
        detail: {
          ...previous.detail,
          ...(threadChanged ? { threadId } : {}),
          ...(titleChanged ? { chatTitle } : {}),
          ...(taskTitleChanged ? { taskTitle } : {}),
        },
      }));
    }
    const previousLast = task.records.at(-1);
    task.records.push(decorated);
    if (previousLast && activityRecordTimestamp(previousLast) > activityRecordTimestamp(decorated)) {
      task.records.sort((left, right) => activityRecordTimestamp(left) - activityRecordTimestamp(right));
    }
    task.lastAt = task.records.at(-1)?.at ?? decorated.at;
    chatsDirty = true;
  };

  const filtered = (shouldDelete) => {
    const nextRotatedRecords = rotatedRecords.filter((record) => !shouldDelete(record));
    const nextCurrentRecords = currentRecords.filter((record) => !shouldDelete(record));
    return {
      rotatedRecords: nextRotatedRecords,
      currentRecords: nextCurrentRecords,
      deleted: (rotatedRecords.length - nextRotatedRecords.length)
        + (currentRecords.length - nextCurrentRecords.length),
    };
  };

  const replace = ({ rotatedRecords: nextRotatedRecords, currentRecords: nextCurrentRecords }) => {
    rotatedRecords = nextRotatedRecords;
    currentRecords = nextCurrentRecords;
    cached = null;
    cachedTasksByTrace = new Map();
    chatsDirty = false;
    dirty = true;
  };

  return { append, filtered, replace, snapshot };
}

function activityRecordSource(record) {
  if (record.event === "lca_codex.tool_started" || record.event === "lca_codex.tool_completed") {
    if (record.detail?.layer === "codex") return "codex";
    if (record.detail?.layer === "lca") return "lca";
  }
  if ([
    "lca_codex.turn_send_accepted",
    "lca_codex.turn_first_response",
    "lca_codex.turn_first_reasoning",
    "lca_codex.turn_first_text",
    "lca_codex.turn_completed",
    "lca_codex.turn_failed",
  ].includes(record.event)) return "chatgpt";
  if (record.event.startsWith("browser.") || record.event.startsWith("smoke.")) return "chatgpt";
  if (record.event.startsWith("lca_codex.")) return "lca";
  const line = typeof record.detail?.line === "string" ? record.detail.line : "";
  if (/\bbrowser (?:turn|diagnostic)\b/.test(line)) return "chatgpt";
  if (/\bbroker\b|\[lca-codex-mcp\]/.test(line)) return "lca";
  if (record.event.startsWith("runtime.daemon_")
    || record.event.startsWith("connector.")
    || record.event.startsWith("bridge.")) return "lca";
  if (record.event.startsWith("codex.")) return "codex";
  return "system";
}

function activityToolKey(record) {
  const source = activityRecordSource(record);
  const callId = typeof record.detail?.callId === "string" ? record.detail.callId : "";
  const tool = typeof record.detail?.tool === "string" ? record.detail.tool : "tool";
  return `${source}:${callId || tool}`;
}

function summarizeActivityTask(task, now = Date.now()) {
  const pendingTools = new Map();
  const toolCounts = new Map();
  let status;
  let terminalAt;
  let phase = "running";
  let source = "lca";
  let attempt = 1;
  let sawStart = false;

  for (const record of task.records) {
    const recordSource = activityRecordSource(record);
    const recordAttempt = record.detail?.attempt;
    if (typeof recordAttempt === "number" && Number.isFinite(recordAttempt)) {
      attempt = Math.max(attempt, Math.max(1, Math.round(recordAttempt)));
    }
    if (record.event === "lca_codex.turn_started") {
      sawStart = true;
      status = undefined;
      terminalAt = undefined;
      pendingTools.clear();
      phase = "running";
      source = "lca";
    } else if (record.event === "browser.turn_started") {
      sawStart = true;
      if (!status) {
        phase = "running";
        source = "chatgpt";
      }
    } else if (record.event === "browser.turn_ended") {
      const browserStatus = record.detail?.status;
      if (browserStatus === "completed") status = "completed";
      else if (browserStatus === "failed" || browserStatus === "aborted") status = "failed";
      if (status) terminalAt = activityRecordTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_send_accepted"
      || record.event === "lca_codex.turn_first_response"
      || record.event === "lca_codex.turn_first_reasoning") {
      phase = "waiting";
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_first_text") {
      phase = "running";
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_completed") {
      status = "completed";
      terminalAt = activityRecordTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_failed") {
      status = "failed";
      terminalAt = activityRecordTimestamp(record);
      source = "chatgpt";
    } else if (record.event === "lca_codex.turn_retry_scheduled") {
      status = undefined;
      terminalAt = undefined;
      phase = "waiting";
      source = "lca";
    } else if (record.event === "lca_codex.turn_retry_stopped") {
      status = "failed";
      terminalAt = activityRecordTimestamp(record);
      source = "lca";
    } else if (record.event === "lca_codex.tool_started") {
      pendingTools.set(activityToolKey(record), recordSource);
      if (recordSource === "lca" || recordSource === "codex") {
        const tool = typeof record.detail?.tool === "string" && record.detail.tool.trim()
          ? record.detail.tool.trim()
          : "unknown";
        const key = `${recordSource}:${tool}`;
        toolCounts.set(key, {
          source: recordSource,
          tool,
          count: (toolCounts.get(key)?.count ?? 0) + 1,
        });
      }
      phase = "waiting";
      source = recordSource;
    } else if (record.event === "lca_codex.tool_completed") {
      pendingTools.delete(activityToolKey(record));
      phase = "waiting";
      source = recordSource === "codex" ? "lca" : "chatgpt";
    } else if (!status && recordSource !== "system") {
      source = recordSource;
    }
  }

  const pendingSources = [...pendingTools.values()];
  if (pendingSources.includes("codex")) source = "codex";
  else if (pendingSources.includes("lca")) source = "lca";

  const first = task.records.find(record => record.event === "lca_codex.turn_started") ?? task.records[0];
  const last = task.records.at(-1);
  const startedAt = activityRecordTimestamp(first);
  const lastAt = activityRecordTimestamp(last);
  const quiet = status === undefined
    && sawStart
    && !pendingSources.includes("codex")
    && now - lastAt >= ACTIVITY_STALL_MS;
  // ChatGPT Web can legitimately remain quiet while it is still reasoning. Treat that as
  // waiting; reserve the stalled state for the local bridge layer.
  const stalled = quiet && source !== "chatgpt";
  const waitingForChatGpt = quiet && source === "chatgpt";
  const taskStatus = status
    ?? (stalled
      ? "stalled"
      : waitingForChatGpt || pendingTools.size > 0 || phase === "waiting"
        ? "waiting"
        : "running");

  return {
    traceId: task.traceId,
    threadId: task.threadId,
    chatTitle: task.chatTitle,
    taskTitle: task.taskTitle,
    startedAt: first?.at ?? task.lastAt,
    lastAt: last?.at ?? task.lastAt,
    durationMs: Math.max(0, (terminalAt ?? now) - startedAt),
    attempt,
    tools: [...toolCounts.values()].sort((left, right) => (
      left.source.localeCompare(right.source) || left.tool.localeCompare(right.tool)
    )),
    source,
    status: taskStatus,
    eventCount: task.records.length,
  };
}

function activityIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,200}$/.test(value) ? value : null;
}

function createThreadTitleLookup(filePath) {
  let fileIdentity = "";
  let lastMtimeMs = -1;
  let readOffset = 0;
  let nextRefreshAt = 0;
  let pendingLine = "";
  let titles = new Map();

  const rememberTitle = (line) => {
    if (!line) return;
    try {
      const item = JSON.parse(line);
      const id = activityIdentifier(item?.id);
      const title = typeof item?.thread_name === "string"
        ? redactText(item.thread_name).replace(/\s+/g, " ").trim().slice(0, MAX_THREAD_TITLE_CHARS)
        : "";
      if (!id || !title) return;
      // Refresh insertion order on updates so the bounded map retains the newest titles.
      titles.delete(id);
      titles.set(id, title);
      while (titles.size > MAX_THREAD_TITLES) titles.delete(titles.keys().next().value);
    } catch {}
  };

  const readSlice = (start, length) => {
    if (length <= 0) return Buffer.alloc(0);
    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      let total = 0;
      while (total < length) {
        const count = fs.readSync(descriptor, buffer, total, length - total, start + total);
        if (count === 0) break;
        total += count;
      }
      return buffer.subarray(0, total);
    } finally {
      fs.closeSync(descriptor);
    }
  };

  const applySlice = (buffer, { reset = false, discardPartialFirstLine = false } = {}) => {
    if (reset) titles = new Map();
    if (reset || discardPartialFirstLine) pendingLine = "";
    let complete = buffer;
    if (discardPartialFirstLine) {
      const newline = complete.indexOf(0x0a);
      complete = newline >= 0 ? complete.subarray(newline + 1) : Buffer.alloc(0);
    }
    const lines = `${pendingLine}${complete.toString("utf8")}`.split(/\r?\n/);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) rememberTitle(line);
    // JSONL normally ends in a newline, but retain compatibility with a valid final record that
    // has not been terminated yet. Reprocessing it after a later append is harmless and updates
    // the same bounded map entry.
    if (pendingLine) rememberTitle(pendingLine);
  };

  const refresh = () => {
    const now = Date.now();
    if (!filePath || now < nextRefreshAt) return;
    nextRefreshAt = now + THREAD_TITLE_REFRESH_MS;
    try {
      const stat = fs.statSync(filePath);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity === fileIdentity && stat.size === readOffset && stat.mtimeMs === lastMtimeMs) return;

      const replaced = fileIdentity !== "" && identity !== fileIdentity;
      const rewritten = identity === fileIdentity
        && (stat.size < readOffset || (stat.size === readOffset && stat.mtimeMs !== lastMtimeMs));
      const cold = fileIdentity === "";
      let start;
      let reset = false;
      let discardPartialFirstLine = false;
      if (cold || replaced || rewritten) {
        start = Math.max(0, stat.size - MAX_THREAD_INDEX_BYTES);
        reset = true;
        discardPartialFirstLine = start > 0;
      } else if (stat.size > readOffset) {
        const growth = stat.size - readOffset;
        start = growth > MAX_THREAD_INDEX_BYTES
          ? stat.size - MAX_THREAD_INDEX_BYTES
          : readOffset;
        discardPartialFirstLine = growth > MAX_THREAD_INDEX_BYTES;
      } else {
        fileIdentity = identity;
        lastMtimeMs = stat.mtimeMs;
        readOffset = stat.size;
        return;
      }

      const content = readSlice(start, stat.size - start);
      applySlice(content, { reset, discardPartialFirstLine });
      fileIdentity = identity;
      lastMtimeMs = stat.mtimeMs;
      readOffset = start + content.length;
    } catch {
      titles = new Map();
      fileIdentity = "";
      lastMtimeMs = -1;
      readOffset = 0;
      pendingLine = "";
    }
  };

  return (threadId) => {
    refresh();
    return titles.get(threadId);
  };
}

function createActivityRecordDecorator(records, threadIndexPath) {
  const traceThreads = new Map();
  const titleForThread = createThreadTitleLookup(threadIndexPath);
  const threadForRecord = (record) => {
    const traceId = activityIdentifier(record?.detail?.traceId);
    const explicitThreadId = activityIdentifier(record?.detail?.threadId);
    if (traceId && explicitThreadId) {
      traceThreads.delete(traceId);
      traceThreads.set(traceId, explicitThreadId);
      while (traceThreads.size > MAX_ACTIVITY_TRACE_THREADS) {
        traceThreads.delete(traceThreads.keys().next().value);
      }
    }
    return explicitThreadId || (traceId ? traceThreads.get(traceId) : null);
  };

  for (const record of records) threadForRecord(record);
  return (record) => {
    const threadId = threadForRecord(record);
    if (!threadId) return record;
    const chatTitle = titleForThread(threadId);
    // Chat titles are display-only metadata; keep them out of the persisted launcher log.
    return {
      ...record,
      detail: {
        ...record.detail,
        threadId,
        ...(chatTitle ? { chatTitle } : {}),
      },
    };
  };
}

function writeRetainedRecords(filePath, records) {
  if (records.length === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writePrivateFileAtomic(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function createLogger({ filePath, publish, threadIndexPath }) {
  const rotatedRecords = readPersistedRecords(`${filePath}.1`);
  const currentRecords = readPersistedRecords(filePath);
  const records = currentRecords.slice(-MAX_MEMORY_RECORDS);
  const decorateActivityRecord = createActivityRecordDecorator(
    [...rotatedRecords, ...currentRecords],
    threadIndexPath,
  );
  const activityIndex = createRetainedActivityIndex(filePath, decorateActivityRecord, {
    rotatedRecords,
    currentRecords,
  });

  const activityChatsPage = (input = {}) => {
    const requestedLimit = Number.isFinite(input?.limit) ? Math.floor(input.limit) : 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const cursor = input?.cursor === undefined || input?.cursor === null
      ? null
      : decodeActivityChatCursor(input.cursor);
    if (input?.cursor && !cursor) return { chats: [], nextCursor: null, hasMore: false };

    const { chats } = activityIndex.snapshot();
    const remaining = cursor
      ? chats.filter((chat) => (
          activityRecordTimestamp({ at: chat.lastAt }) < activityRecordTimestamp({ at: cursor.at })
          || (chat.lastAt === cursor.at && chat.id > cursor.id)
        ))
      : chats;
    const pageChats = remaining.slice(0, limit);
    const hasMore = remaining.length > pageChats.length;
    return {
      chats: pageChats,
      nextCursor: hasMore && pageChats.length > 0 ? encodeActivityChatCursor(pageChats.at(-1)) : null,
      hasMore,
    };
  };

  const activityChatTasks = (input = {}) => {
    const chatId = typeof input?.chatId === "string" && input.chatId.length <= 256 ? input.chatId : null;
    if (!chatId) return [];
    const activity = activityIndex.snapshot();
    return activity.tasks
      .filter((task) => task.chatId === chatId)
      .map((task) => summarizeActivityTask(task))
      .sort((left, right) => activityRecordTimestamp({ at: right.lastAt }) - activityRecordTimestamp({ at: left.lastAt }));
  };

  const activityTaskRecords = (input = {}) => {
    const traceId = typeof input?.traceId === "string" && input.traceId.length <= 256 ? input.traceId : null;
    if (!traceId) return [];
    const activity = activityIndex.snapshot();
    return activity.tasks.find((task) => task.traceId === traceId)?.records ?? [];
  };

  const activitySystemRecords = () => {
    const activity = activityIndex.snapshot();
    return activity.system;
  };

  const deleteActivity = (input = {}) => {
    const scope = input?.scope;
    let shouldDelete;

    if (scope === "all") {
      shouldDelete = () => true;
    } else if (scope === "task") {
      const traceId = activityIdentifier(input?.traceId);
      if (!traceId) throw new Error("Activity task deletion requires a valid traceId");
      shouldDelete = (record) => activityTraceId(record) === traceId;
    } else if (scope === "chat") {
      const chatId = typeof input?.chatId === "string" && input.chatId.length <= 256 ? input.chatId : null;
      if (!chatId) throw new Error("Activity chat deletion requires a valid chatId");
      const activity = activityIndex.snapshot();
      if (chatId === "system") {
        shouldDelete = (record) => activityTraceId(record) === null;
      } else {
        const traceIds = new Set(
          activity.tasks.filter((task) => task.chatId === chatId).map((task) => task.traceId),
        );
        shouldDelete = (record) => {
          const traceId = activityTraceId(record);
          return traceId !== null && traceIds.has(traceId);
        };
      }
    } else {
      throw new Error("Activity deletion scope must be all, chat, or task");
    }

    const next = activityIndex.filtered(shouldDelete);
    if (next.deleted === 0) return { deleted: 0 };

    writeRetainedRecords(`${filePath}.1`, next.rotatedRecords);
    writeRetainedRecords(filePath, next.currentRecords);
    activityIndex.replace(next);

    const remainingRecent = records.filter((record) => !shouldDelete(record));
    records.splice(0, records.length, ...remainingRecent.slice(-MAX_MEMORY_RECORDS));
    return { deleted: next.deleted };
  };

  const append = (level, event, detail = {}) => {
    const record = {
      at: new Date().toISOString(),
      level,
      event,
      detail: detail && typeof detail === "object" && !Array.isArray(detail) ? sanitize(detail) : {},
    };
    records.push(record);
    if (records.length > MAX_MEMORY_RECORDS) records.splice(0, records.length - MAX_MEMORY_RECORDS);
    let rotated = false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (stat && stat.size >= MAX_LOG_BYTES) {
        fs.rmSync(`${filePath}.1`, { force: true });
        renameAtomicFile(filePath, `${filePath}.1`);
        rotated = true;
      }
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {}
    activityIndex.append(record, { rotated });
    const displayRecord = decorateActivityRecord(record);
    publish?.(displayRecord);
    return record;
  };

  return {
    debug: (event, detail) => append("debug", event, detail),
    info: (event, detail) => append("info", event, detail),
    warn: (event, detail) => append("warning", event, detail),
    error: (event, detail) => append("error", event, detail),
    recent: (limit = 150) => records
      .slice(-Math.max(1, Math.min(300, limit)))
      .map(decorateActivityRecord),
    activityChatsPage,
    activityChatTasks,
    activityTaskRecords,
    activitySystemRecords,
    deleteActivity,
    filePath,
  };
}

function installProcessDiagnosticGuards({ filePath, streams = [process.stdout, process.stderr] }) {
  const guarded = new Set();
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function" || guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on("error", (error) => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.appendFileSync(
          filePath,
          `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // A lost diagnostic sink must not become a second process error.
      }
    });
  }
}

function registerLoggedIpc(ipcMain, logger, channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      logger.error("launcher.ipc_failed", {
        channel,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

module.exports = {
  ACTIVITY_STALL_MS,
  createLogger,
  installProcessDiagnosticGuards,
  parseLcaCodexActivity,
  readRecent,
  redactText,
  registerLoggedIpc,
  sanitize,
};
