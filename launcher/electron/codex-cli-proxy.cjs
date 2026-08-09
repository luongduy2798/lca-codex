#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const LIFECYCLE_METHODS = new Set([
  "turn/start",
  "turn/started",
  "turn/interrupt",
  "turn/completed",
  "thread/stop",
]);

function platformTokens(platform) {
  if (platform === "darwin") return ["macos", "darwin"];
  if (platform === "win32") return ["windows", "win32"];
  return [platform];
}

function archTokens(arch) {
  if (arch === "x64") return ["x86_64", "x64"];
  if (arch === "arm64") return ["aarch64", "arm64"];
  return [arch];
}

function extensionRoots(homeDir = os.homedir()) {
  return [
    path.join(homeDir, ".vscode", "extensions"),
    path.join(homeDir, ".vscode-insiders", "extensions"),
  ];
}

function findCodexExecutable({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  selfPath = __filename,
} = {}) {
  const override = env.LCA_CODEX_REAL_EXECUTABLE?.trim();
  if (override) {
    const resolved = path.resolve(override);
    if (resolved === path.resolve(selfPath)) throw new Error("LCA_CODEX_REAL_EXECUTABLE points to the proxy itself");
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Configured Codex executable does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  for (const root of extensionRoots(homeDir)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) continue;
      const extensionDir = path.join(root, entry.name);
      const binRoot = path.join(extensionDir, "bin");
      if (!fs.existsSync(binRoot)) continue;
      for (const platformDir of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (!platformDir.isDirectory()) continue;
        const lower = platformDir.name.toLowerCase();
        if (!platformTokens(platform).some(token => lower.includes(token))) continue;
        if (!archTokens(arch).some(token => lower.includes(token))) continue;
        const executable = path.join(binRoot, platformDir.name, platform === "win32" ? "codex.exe" : "codex");
        if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) continue;
        if (path.resolve(executable) === path.resolve(selfPath)) continue;
        candidates.push({ executable, mtimeMs: fs.statSync(extensionDir).mtimeMs });
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length > 0) return candidates[0].executable;

  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const pathValue = env.PATH || env.Path || "";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const part of pathValue.split(delimiter)) {
    if (!part.trim()) continue;
    const executable = path.resolve(part.replace(/^"(.*)"$/, "$1"), executableName);
    try {
      if (!fs.statSync(executable).isFile()) continue;
      if (fs.realpathSync(executable) === fs.realpathSync(selfPath)) continue;
      let preview = "";
      try { preview = fs.readFileSync(executable, "utf8").slice(0, 2048); } catch {}
      if (preview.includes("codex-cli-proxy.cjs") || preview.includes("LCA_CODEX_REAL_EXECUTABLE points to the proxy itself")) continue;
      return executable;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error("A real Codex executable was not found. Install Codex or set LCA_CODEX_REAL_EXECUTABLE explicitly");
}

function firstString(...values) {
  return values.find(value => typeof value === "string" && value.length > 0);
}

function lifecycleEventFromLine(line, direction) {
  if (!line.includes("turn/") && !line.includes("thread/stop")) return null;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  const method = typeof message?.method === "string" ? message.method : undefined;
  if (!method || !LIFECYCLE_METHODS.has(method)) return null;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  const thread = params.thread && typeof params.thread === "object" ? params.thread : {};
  return {
    direction,
    method,
    threadId: firstString(params.threadId, params.thread_id, turn.threadId, turn.thread_id, thread.id),
    turnId: firstString(params.turnId, params.turn_id, turn.id),
    requestId: typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined,
  };
}

function createLineObserver(direction, onLifecycle) {
  let buffer = "";
  const consume = (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const event = lifecycleEventFromLine(line, direction);
      if (event) onLifecycle(event);
    }
  };
  consume.flush = () => {
    if (!buffer) return;
    const event = lifecycleEventFromLine(buffer.replace(/\r$/, ""), direction);
    buffer = "";
    if (event) onLifecycle(event);
  };
  return consume;
}

function runtimeControlConfig(env = process.env) {
  const home = path.resolve(env.LCA_CODEX_HOME?.trim() || path.join(os.homedir(), ".lca-codex"));
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    if (config?.host !== "127.0.0.1" || !Number.isInteger(config?.port) || config.port < 1 || config.port > 65_535) return null;
    if (typeof config?.controlToken !== "string" || config.controlToken.length < 40) return null;
    return { host: config.host, port: config.port, controlToken: config.controlToken };
  } catch {
    return null;
  }
}

function postLifecycleEvent(event, { env = process.env, timeoutMs = 750 } = {}) {
  const config = runtimeControlConfig(env);
  if (!config || !event?.method || !event?.threadId) return Promise.resolve(false);
  const body = Buffer.from(JSON.stringify(event));
  return new Promise(resolve => {
    const req = http.request({
      host: config.host,
      port: config.port,
      method: "POST",
      path: "/admin/codex-lifecycle",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end(body);
  });
}

function defaultLifecycleHandler(stderr, env = process.env) {
  return event => {
    if (env.LCA_CODEX_PROXY_DEBUG === "1") {
      const compact = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
      stderr.write(`[lca-codex-proxy] lifecycle ${JSON.stringify(compact)}\n`);
    }
    void postLifecycleEvent(event, { env });
  };
}

function forwardSignal(child, signal) {
  if (!child.killed) {
    try { child.kill(signal); } catch {}
  }
}

function runProxy({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  executable = findCodexExecutable({ env }),
  onLifecycle = defaultLifecycleHandler(stderr, env),
} = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(executable, argv, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const observeInput = createLineObserver("extension->codex", onLifecycle);
    const observeOutput = createLineObserver("codex->extension", onLifecycle);

    stdin.on("data", observeInput);
    child.stdout.on("data", observeOutput);
    stdin.pipe(child.stdin);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    const signalHandlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => forwardSignal(child, signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      observeInput.flush();
      observeOutput.flush();
      stdin.off("data", observeInput);
      child.stdout.off("data", observeOutput);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };

    child.once("error", (error) => {
      cleanup();
      stderr.write(`[lca-codex-proxy] failed to start Codex: ${error.message}\n`);
      resolve({ code: 127, signal: null });
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null });
    });
  });
}

if (require.main === module) {
  runProxy().then(({ code }) => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`[lca-codex-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 127;
  });
}

module.exports = {
  LIFECYCLE_METHODS,
  createLineObserver,
  findCodexExecutable,
  lifecycleEventFromLine,
  postLifecycleEvent,
  runtimeControlConfig,
  runProxy,
};
