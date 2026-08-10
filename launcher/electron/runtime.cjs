const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { findCodexExecutable } = require("./codex-cli-proxy.cjs");
const {
  bridgeStatus: vscodeAdvancedStatus,
  removeBridge: removeVsCodeAdvanced,
  repairBridge: repairVsCodeAdvanced,
  resumeBridge: resumeVsCodeAdvanced,
  setupBridge: setupVsCodeAdvanced,
  suspendBridge: suspendVsCodeAdvanced,
} = require("./codex-lifecycle-bridge.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const CORE_SETUP_TIMEOUT_MS = 10 * 60_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_CHECKPOINT_FILE_BYTES = 16 * 1024 * 1024;
const CODEX_TOOL_HEALTH_TIMEOUT_MS = 90_000;
const CODEX_TOOL_PROBE_TIMEOUT_MS = 45_000;
const CODEX_TOOL_PROBE_POLL_MS = 150;
const CODEX_TOOL_HEALTH_NAMES = ["exec_command", "write_stdin", "apply_patch", "view_image"];
const CODEX_TOOL_HEALTH_PROBE_PROMPT = "LCA_CODEX_NATIVE_TOOL_HEALTH_PROBE_V1";

function codexToolHealthFallback(detail, checkedAt = null) {
  return {
    checkedAt,
    activeTurn: false,
    live: false,
    traceId: null,
    tools: CODEX_TOOL_HEALTH_NAMES.map((name) => ({ name, status: "unknown", detail })),
  };
}

function validateCodexToolHealthReport(value) {
  if (!value || typeof value !== "object") throw new Error("Codex tool health response is invalid");
  if (typeof value.checkedAt !== "string" || Number.isNaN(Date.parse(value.checkedAt))) {
    throw new Error("Codex tool health response has an invalid timestamp");
  }
  if (typeof value.activeTurn !== "boolean") throw new Error("Codex tool health response is missing activeTurn");
  if (typeof value.live !== "boolean") throw new Error("Codex tool health response is missing live status");
  if (value.traceId !== null && typeof value.traceId !== "string") throw new Error("Codex tool health response has an invalid traceId");
  if (!Array.isArray(value.tools) || value.tools.length !== CODEX_TOOL_HEALTH_NAMES.length) {
    throw new Error("Codex tool health response is missing tool results");
  }
  const statuses = new Set(["working", "available", "failed", "missing", "unknown"]);
  for (const name of CODEX_TOOL_HEALTH_NAMES) {
    const item = value.tools.find((candidate) => candidate?.name === name);
    if (!item || !statuses.has(item.status) || typeof item.detail !== "string") {
      throw new Error(`Codex tool health response is invalid for ${name}`);
    }
  }
  return value;
}

function requestCodexToolHealth(socketPath, timeoutMs = CODEX_TOOL_HEALTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = `health_${randomBytes(18).toString("base64url")}`;
    const socket = net.createConnection(socketPath);
    let buffered = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Codex tool health check timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method: "health_check" })}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffered.slice(0, newline));
      } catch {
        finish(new Error("Codex tool health broker returned invalid JSON"));
        return;
      }
      if (response?.id !== id) {
        finish(new Error("Codex tool health broker returned a mismatched response"));
        return;
      }
      if (typeof response.error === "string" && response.error) {
        finish(new Error(response.error));
        return;
      }
      try {
        finish(null, validateCodexToolHealthReport(response.result));
      } catch (error) {
        finish(error);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexToolHealthProbeArgs(probeDir) {
  return [
    "--ask-for-approval", "never",
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color", "never",
    "--sandbox", "workspace-write",
    "--cd", probeDir,
    "--model", "lca-codex",
    "--config", 'model_reasoning_effort="low"',
    CODEX_TOOL_HEALTH_PROBE_PROMPT,
  ];
}

function collect(stream, chunks, onLine, onError) {
  let buffered = "";
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURE_BYTES) chunks.push(chunk);
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function captureRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`Setup checkpoint path is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) {
    throw new Error(`Setup checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${filePath}`);
  }
  return {
    path: filePath,
    exists: true,
    data: fs.readFileSync(filePath),
    mode: stat.mode & 0o777,
  };
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  writePrivateFileAtomic(snapshot.path, snapshot.data);
  if (platform !== "win32") fs.chmodSync(snapshot.path, snapshot.mode);
}

function regularFileChanged(snapshot, platform = process.platform) {
  let stat;
  try {
    stat = fs.lstatSync(snapshot.path);
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot.exists;
    throw error;
  }
  if (!snapshot.exists || !stat.isFile()) return true;
  if (platform !== "win32" && (stat.mode & 0o777) !== snapshot.mode) return true;
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return true;
  return !fs.readFileSync(snapshot.path).equals(snapshot.data);
}

function parseBridgeRouteResult(stdout, { expectedActive, requireInstalled = false } = {}) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Codex bridge route command returned invalid JSON");
  }
  if (typeof result?.active !== "boolean") {
    throw new Error("Codex bridge route command did not report its active state");
  }
  if (requireInstalled && typeof result.installed !== "boolean") {
    throw new Error("Codex bridge route status did not report whether the integration is installed");
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`Codex bridge route is inconsistent: ${result.errors.join("; ")}`);
  }
  if (typeof expectedActive === "boolean" && result.active !== expectedActive) {
    throw new Error(`Codex bridge route remained ${result.active ? "connected" : "disconnected"}`);
  }
  return result;
}

class RuntimeHost {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath,
    coreHome,
    codexHome,
    launchAgentsDir,
    platform = process.platform,
    publishOperation,
    supervisor,
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.browserDescriptorPath = browserDescriptorPath;
    this.coreHome = resolveUserPath(coreHome || process.env.LCA_CODEX_HOME?.trim() || path.join(os.homedir(), ".lca-codex"));
    this.codexLifecycleProxySource = path.join(__dirname, "codex-cli-proxy.cjs");
    this.platform = platform;
    this.codexHome = codexHome
      ? resolveUserPath(codexHome)
      : process.env.CODEX_HOME?.trim()
        ? resolveUserPath(process.env.CODEX_HOME.trim())
        : path.join(os.homedir(), ".codex");
    this.launchAgentsDir = launchAgentsDir
      ? resolveUserPath(launchAgentsDir)
      : path.join(os.homedir(), "Library", "LaunchAgents");
    this.publishOperation = publishOperation;
    this.supervisor = supervisor;
    this.active = null;
    this.activeChild = null;
    this.lifecycleOperation = null;
    this.codexToolHealthReport = null;
    this.codexToolHealthCheckInFlight = null;
    this.codexToolProbeChild = null;
    this.cleanupEphemeralSecrets();
  }

  currentOperation() {
    const stuckChild = this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null;
    return this.lifecycleOperation || this.active || (stuckChild ? "previous runtime process shutdown" : null);
  }

  async waitForCodexConfigStatus() {
    while (this.currentOperation() === "codex-config-status") {
      const pending = this.codexConfigSnapshotInFlight;
      if (!pending) {
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      try {
        await pending;
      } catch {
        // This read-only snapshot reports its own error. Lifecycle actions only need its lock released.
      }
    }
  }

  async cancelActiveOperation() {
    const child = this.activeChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const waitForExit = (timeoutMs) => new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", finish);
        child.off("close", finish);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", finish);
        child.off("close", finish);
        resolve(false);
      }, timeoutMs);
      child.once("exit", finish);
      child.once("close", finish);
    });
    this.logger.warn("runtime.operation_cancel_requested", {
      operation: this.active || this.lifecycleOperation || "unknown",
      pid: child.pid,
    });
    terminateOwnedProcessTree(child);
    if (!await waitForExit(2_000)) {
      terminateOwnedProcessTree(child, "SIGKILL");
      await waitForExit(2_000);
    }
    return true;
  }

  cleanupEphemeralSecrets() {
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    try {
      for (const entry of fs.readdirSync(secretsDir, { withFileTypes: true })) {
        if (/^runtime-key-(?:\d+|[a-f0-9]{32})\.tmp$/.test(entry.name)) {
          fs.rmSync(path.join(secretsDir, entry.name), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn("runtime.secret_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  command(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  launcherControlEnvironment() {
    let descriptor;
    try {
      descriptor = JSON.parse(fs.readFileSync(this.browserDescriptorPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Launcher browser ownership descriptor is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const token = descriptor?.control?.token;
    if (descriptor?.pid !== process.pid || typeof token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw new Error("Launcher browser ownership descriptor does not belong to this launcher process");
    }
    return { LCA_CODEX_LAUNCHER_CONTROL_TOKEN: token };
  }

  runtimeConfigSnapshot() {
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    if (!setupConfig) {
      return {
        configured: false,
        owner: "none",
        mode: "full",
        serialized: null,
      };
    }
    const launcherOwned = setupConfig.browserHost === "launcher";
    const config = setupConfig;
    return {
      configured: true,
      owner: launcherOwned ? "launcher" : "external",
      mode: "full",
      serialized: JSON.stringify(config),
      config: structuredClone(config),
    };
  }

  mcpCredentialsConfigured() {
    const config = this.runtimeConfigSnapshot().config;
    const tunnel = config?.tunnel ?? null;
    return Boolean(
      tunnel
      && /^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)
      && typeof tunnel.runtimeKeyFile === "string"
      && path.isAbsolute(tunnel.runtimeKeyFile)
      && fs.existsSync(tunnel.runtimeKeyFile),
    );
  }

  captureSetupCheckpoint(snapshot) {
    if (typeof this.supervisor.configPath !== "string" || !path.isAbsolute(this.supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path for setup rollback");
    }
    const coreHome = this.supervisor.coreHome
      || path.dirname(this.supervisor.configPath);
    const paths = new Set([
      this.supervisor.configPath,
      path.join(coreHome, "codex", "integration-journal.json"),
      path.join(this.codexHome, "config.toml"),
      path.join(this.codexHome, "models_cache.json"),
      path.join(coreHome, "secrets", "tunnel-runtime.key"),
      path.join(coreHome, "tunnel", "profiles", "lca-codex.yaml"),
    ]);
    if (snapshot.owner === "external" && this.platform === "darwin") {
      paths.add(path.join(this.launchAgentsDir, "io.github.luongduy2798.lca-codex.daemon.plist"));
      paths.add(path.join(this.launchAgentsDir, "io.github.luongduy2798.lca-codex.tunnel.plist"));
    }
    const tunnel = snapshot.config?.tunnel;
    if (tunnel && typeof tunnel === "object") {
      if (typeof tunnel.runtimeKeyFile === "string" && tunnel.runtimeKeyFile) {
        paths.add(tunnel.runtimeKeyFile);
      }
      if (typeof tunnel.profileDir === "string"
        && tunnel.profileDir
        && typeof tunnel.profileName === "string"
        && tunnel.profileName) {
        paths.add(path.join(tunnel.profileDir, `${tunnel.profileName}.yaml`));
      }
    }
    return [...paths].map(captureRegularFile);
  }

  setupCheckpointChanged(checkpoint) {
    return checkpoint ? checkpoint.some(snapshot => regularFileChanged(snapshot, this.platform)) : false;
  }

  restoreSetupCheckpoint(checkpoint) {
    if (!checkpoint) return;
    const failures = [];
    for (const snapshot of [...checkpoint].reverse()) {
      try {
        restoreRegularFile(snapshot, this.platform);
      } catch (error) {
        failures.push(`${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Setup checkpoint restoration failed: ${failures.join("; ")}`);
    }
  }

  async restorePreviousRuntime(snapshot, operationName, { repairExternal = false, wasRunning = false } = {}) {
    const current = this.runtimeConfigSnapshot();
    if (current.owner !== snapshot.owner || current.serialized !== snapshot.serialized) {
      throw new Error(
        "Runtime configuration changed before the operation failed; refusing to describe the current runtime as the previous installation",
      );
    }
    if (snapshot.owner === "external") {
      if (repairExternal) {
        if (this.platform !== "darwin") {
          throw new Error("Terminal-managed runtime repair is supported only on macOS");
        }
        await this.run(operationName, ["service", "install"], {
          embedded: true,
          message: "Restoring the previous terminal-managed daemon",
          successMessage: "Previous terminal-managed daemon restored",
          timeoutMs: 75_000,
        });
        await this.run(operationName, ["tunnel", "start"], {
          embedded: true,
          message: "Restoring the previous terminal-managed tunnel",
          successMessage: "Previous terminal-managed tunnel restored",
          timeoutMs: 75_000,
        });
      }
      await this.run(operationName, ["doctor", "--json"], {
        message: "Verifying the previous terminal-managed runtime",
        successMessage: "Previous terminal-managed runtime is still healthy",
        timeoutMs: 75_000,
      });
      return;
    }
    if (!wasRunning) {
      await this.supervisor.stopForSetup();
      return;
    }
    const runtime = await this.supervisor.startIfConfigured();
    if (runtime.status !== "ready") {
      throw new Error(
        `Previous runtime recovery returned ${runtime.status}; expected ready${runtime.detail ? `: ${runtime.detail}` : ""}`,
      );
    }
  }

  async rollbackFirstSetup(checkpoint) {
    const changed = this.setupCheckpointChanged(checkpoint);
    let stopError;
    try {
      await this.supervisor.stopForSetup();
    } catch (error) {
      stopError = error;
    }
    let restoreError;
    try {
      this.restoreSetupCheckpoint(checkpoint);
    } catch (error) {
      restoreError = error;
    }
    this.supervisor.clearState();
    if (stopError || restoreError) {
      const failures = [
        stopError ? `stopping the incomplete runtime failed: ${stopError instanceof Error ? stopError.message : String(stopError)}` : null,
        restoreError ? (restoreError instanceof Error ? restoreError.message : String(restoreError)) : null,
      ].filter(Boolean);
      throw new Error(failures.join("; "));
    }
    return changed;
  }

  async run(name, args, options = {}) {
    if (this.active) throw new Error(`Another launcher operation is active: ${this.active}`);
    if (this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null) {
      throw new Error("A previous launcher operation process is still running");
    }
    this.activeChild = null;
    if (this.lifecycleOperation && this.lifecycleOperation !== name) {
      throw new Error(`Another launcher operation is active: ${this.lifecycleOperation}`);
    }
    this.active = name;
    const publishOperation = options.publishOperation !== false;
    if (publishOperation) this.publishOperation?.({ name, status: "running", message: options.message || name });
    this.logger.info("runtime.operation_started", { name, args: args.map((arg) => /key|token/i.test(arg) ? "[redacted]" : arg) });
    try {
      const invocation = options.embedded
        ? embeddedRuntimeInvocation({ app: this.app, sourceRoot: this.sourceRoot, args })
        : this.command(args);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: {
            ...process.env,
            LCA_CODEX_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
            ...(options.env || {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.activeChild = child;
        const stdout = [];
        const stderr = [];
        const pipeErrors = [];
        const recordPipeError = (stream) => (error) => {
          pipeErrors.push(`${name} ${stream} pipe failed: ${error instanceof Error ? error.message : String(error)}`);
        };
        collect(child.stdout, stdout, (line) => {
          this.logger.info("runtime.stdout", { operation: name, line });
          if (publishOperation) this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stdout"));
        collect(child.stderr, stderr, (line) => {
          this.logger.warn("runtime.stderr", { operation: name, line });
          if (publishOperation) this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stderr"));
        let settled = false;
        let timedOut = null;
        let terminationTimeout = null;
        let forceTimeout = null;
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (terminationTimeout) clearTimeout(terminationTimeout);
          if (forceTimeout) clearTimeout(forceTimeout);
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => {
              if (settled) return;
              timedOut = new Error(`${name} timed out after ${options.timeoutMs}ms`);
              try {
                terminateOwnedProcessTree(child);
              } catch (error) {
                settled = true;
                clearTimers();
                reject(new Error(
                  `${timedOut.message}; child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                ));
                return;
              }
              terminationTimeout = setTimeout(() => {
                if (settled) return;
                try {
                  terminateOwnedProcessTree(child, "SIGKILL");
                } catch (error) {
                  settled = true;
                  clearTimers();
                  reject(new Error(
                    `${timedOut.message}; forced child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                  ));
                  return;
                }
                forceTimeout = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  clearTimers();
                  reject(new Error(`${timedOut.message}; the child process did not exit after forced termination`));
                }, 2_000);
              }, 5_000);
            }, options.timeoutMs)
          : null;
        child.once("error", (error) => {
          const childStillRunning = Number.isInteger(child.pid)
            && child.exitCode === null
            && child.signalCode === null;
          if (this.activeChild === child && !childStillRunning) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          reject(timedOut
            ? new Error(`${timedOut.message}; termination failed: ${error.message}`)
            : error);
        });
        child.once("exit", (code, signal) => {
          if (this.activeChild === child) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          if (timedOut) {
            try {
              terminateOwnedProcessTree(child, "SIGKILL");
              reject(timedOut);
            } catch (error) {
              reject(new Error(
                `${timedOut.message}; final process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              ));
            }
            return;
          }
          if (pipeErrors.length > 0) {
            reject(new Error(pipeErrors.join("; ")));
            return;
          }
          resolve({
            code: code ?? 1,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(detail);
      }
      this.logger.info("runtime.operation_completed", { name });
      if (publishOperation) this.publishOperation?.({ name, status: "completed", message: options.successMessage || "Completed" });
      return result;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error("runtime.operation_failed", { name, message });
      if (publishOperation) this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.active = null;
    }
  }

  async doctor() {
    try {
      const result = await this.run("doctor", ["doctor", "--json"], {
        message: "Checking runtime",
        timeoutMs: 75_000,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        ok: false,
        checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async bridgeStatus(operationName = "bridge-status") {
    const result = await this.run(operationName, ["route", "status"], {
      embedded: true,
      message: "Checking Codex bridge route",
      successMessage: "Codex bridge route checked",
      timeoutMs: 15_000,
    });
    return parseBridgeRouteResult(result.stdout, { requireInstalled: true });
  }

  async codexConfigSnapshot() {
    if (this.codexConfigSnapshotInFlight) return this.codexConfigSnapshotInFlight;

    const snapshot = (async () => {
      const configPath = path.join(this.codexHome, "config.toml");
      let content = "";
      let exists = false;
      try {
        const stat = fs.lstatSync(configPath);
        if (!stat.isFile()) throw new Error(`Codex config is not a regular file: ${configPath}`);
        if (stat.size > MAX_CHECKPOINT_FILE_BYTES) {
          throw new Error(`Codex config exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${configPath}`);
        }
        content = fs.readFileSync(configPath, "utf8");
        exists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      let route = null;
      const errors = [];
      try {
        const result = await this.run("codex-config-status", ["route", "status"], {
          embedded: true,
          publishOperation: false,
          timeoutMs: 15_000,
        });
        route = JSON.parse(result.stdout);
        if (typeof route?.installed !== "boolean" || typeof route?.active !== "boolean") {
          throw new Error("Codex route status is incomplete");
        }
        if (Array.isArray(route.errors)) {
          errors.push(...route.errors
            .filter(value => typeof value === "string" && value.trim())
            .map(value => value.trim()));
        }
      } catch (error) {
        route = null;
        errors.push(error instanceof Error ? error.message : String(error));
      }

      const installed = route?.installed === true;
      const active = route?.active === true;
      return {
        state: errors.length > 0
          ? "inconsistent"
          : !installed
            ? "not-configured"
            : active
              ? "configured"
              : "disconnected",
        installed,
        active,
        configPath,
        exists,
        content,
        ...(typeof route?.routeUrl === "string" && route.routeUrl ? { routeUrl: route.routeUrl } : {}),
        errors,
      };
    })();

    this.codexConfigSnapshotInFlight = snapshot;
    try {
      return await snapshot;
    } finally {
      if (this.codexConfigSnapshotInFlight === snapshot) this.codexConfigSnapshotInFlight = null;
    }
  }

  codexToolHealthSnapshot() {
    return structuredClone(this.codexToolHealthReport || codexToolHealthFallback("Not checked yet"));
  }

  resetCodexToolHealth() {
    this.codexToolHealthReport = null;
  }

  stopCodexToolHealthProbe(child = this.codexToolProbeChild) {
    if (!child) return;
    if (this.codexToolProbeChild === child) this.codexToolProbeChild = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      terminateOwnedProcessTree(child);
    } catch (error) {
      this.logger.warn("codex.tool_health_probe_stop_failed", {
        message: redactText(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  startCodexToolHealthProbe(config) {
    const probeDir = path.join(this.coreHome, "runtime", "codex-tool-health-probe");
    fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 });
    const executable = findCodexExecutable({ env: process.env });
    const child = spawn(executable, codexToolHealthProbeArgs(probeDir), {
      cwd: probeDir,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        LCA_CODEX_HOME: this.coreHome,
        LCA_CODEX_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.codexToolProbeChild = child;
    let stderr = "";
    let exited = false;
    let exitDetail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once("error", (error) => {
      exited = true;
      exitDetail = error instanceof Error ? error.message : String(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      exitDetail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    });
    return {
      child,
      exited: () => exited,
      detail: () => redactText([exitDetail, stderr.trim()].filter(Boolean).join(": ")).slice(0, 1_000),
    };
  }

  async probeCodexTools(config) {
    const probe = this.startCodexToolHealthProbe(config);
    const deadline = Date.now() + CODEX_TOOL_PROBE_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (probe.exited()) {
          throw new Error(`Codex tool health probe stopped before native tools became available${probe.detail() ? `: ${probe.detail()}` : ""}`);
        }
        const remaining = Math.max(1_000, deadline - Date.now());
        const report = await requestCodexToolHealth(config.brokerSocketPath, Math.min(CODEX_TOOL_HEALTH_TIMEOUT_MS, remaining));
        if (report.live) return report;
        await sleep(CODEX_TOOL_PROBE_POLL_MS);
      }
      throw new Error("Codex tool health probe timed out before a live native tool wait was available");
    } finally {
      this.stopCodexToolHealthProbe(probe.child);
    }
  }

  async performCodexToolHealthCheck() {
    const config = this.runtimeConfigSnapshot().config;
    if (!config || typeof config.brokerSocketPath !== "string" || !config.brokerSocketPath.trim()) {
      return codexToolHealthFallback("LCA Codex runtime is not configured", new Date().toISOString());
    }
    if (config.mode !== "full" || !config.tunnel) {
      return codexToolHealthFallback("The full Codex harness is not configured", new Date().toISOString());
    }
    const current = await requestCodexToolHealth(config.brokerSocketPath);
    return current.live ? current : this.probeCodexTools(config);
  }

  async checkCodexTools() {
    if (this.codexToolHealthCheckInFlight) {
      return structuredClone(await this.codexToolHealthCheckInFlight);
    }
    const check = (async () => {
      try {
        return await this.performCodexToolHealthCheck();
      } catch (error) {
        return codexToolHealthFallback(
          redactText(error instanceof Error ? error.message : String(error)),
          new Date().toISOString(),
        );
      }
    })();
    this.codexToolHealthCheckInFlight = check;
    try {
      const report = await check;
      this.codexToolHealthReport = report;
      return structuredClone(report);
    } finally {
      if (this.codexToolHealthCheckInFlight === check) this.codexToolHealthCheckInFlight = null;
    }
  }

  vscodeAdvancedSnapshot() {
    return vscodeAdvancedStatus({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      platform: this.platform,
    });
  }

  repairVsCodeAdvanced() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return repairVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      electronExecutable: process.execPath,
      platform: this.platform,
    });
  }

  setupVsCodeAdvanced() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return setupVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      electronExecutable: process.execPath,
      platform: this.platform,
      configureSettings: true,
    });
  }

  installVsCodeAdvancedProxy() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return setupVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      electronExecutable: process.execPath,
      platform: this.platform,
      configureSettings: false,
    });
  }

  removeVsCodeAdvanced() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return removeVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      platform: this.platform,
    });
  }

  resumeVsCodeAdvancedWithinOperation() {
    return resumeVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      electronExecutable: process.execPath,
      platform: this.platform,
    });
  }

  suspendVsCodeAdvancedWithinOperation() {
    return suspendVsCodeAdvanced({
      coreHome: this.coreHome,
      proxySourcePath: this.codexLifecycleProxySource,
      platform: this.platform,
    });
  }

  suspendVsCodeAdvanced() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = "vscode-advanced-suspend";
    try {
      return this.suspendVsCodeAdvancedWithinOperation();
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async saveCodexConfig(content) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    if (typeof content !== "string") throw new Error("Codex config content must be text");
    if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(`Codex config exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes`);
    }
    const configPath = path.join(this.codexHome, "config.toml");
    captureRegularFile(configPath);
    writePrivateFileAtomic(configPath, content);
    return await this.codexConfigSnapshot();
  }

  async restoreBridgeRouteWithinOperation(operationName) {
    const current = await this.bridgeStatus(operationName);
    if (!current.installed || !current.active) return current;
    const disconnected = await this.run(operationName, ["route", "disconnect"], {
      embedded: true,
      message: "Restoring the previous Codex route",
      successMessage: "Previous Codex route restored",
      timeoutMs: 15_000,
    });
    return {
      ...parseBridgeRouteResult(disconnected.stdout, { expectedActive: false }),
      installed: true,
    };
  }

  async connectBridgeRouteWithinOperation(operationName) {
    const current = await this.bridgeStatus(operationName);
    if (!current.installed) throw new Error("Install the Codex integration before starting the runtime");
    if (current.active) return current;
    const connected = await this.run(operationName, ["route", "connect"], {
      embedded: true,
      message: "Connecting Codex to the launcher",
      successMessage: "Codex bridge connected",
      timeoutMs: 15_000,
    });
    return {
      ...parseBridgeRouteResult(connected.stdout, { expectedActive: true }),
      installed: true,
    };
  }

  async restoreBridgeRoute(operationName = "bridge-route-restore") {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      return await this.restoreBridgeRouteWithinOperation(operationName);
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async setBridgeEnabled(enabled) {
    const desired = enabled === true;
    const name = desired ? "bridge-connect" : "bridge-disconnect";
    await this.waitForCodexConfigStatus();
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = name;
    try {
      if (desired) {
        return await this.connectBridgeRouteWithinOperation(name);
      }
      const restored = await this.restoreBridgeRouteWithinOperation(name);
      if (!restored.installed) throw new Error("Install the Codex integration before changing the bridge route");
      return restored;
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async activateRuntimeBridge(operationName = "runtime-bridge-start") {
    await this.waitForCodexConfigStatus();
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      const route = await this.connectBridgeRouteWithinOperation(operationName);
      try {
        const vscode = this.resumeVsCodeAdvancedWithinOperation();
        return { route, vscode };
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(operationName);
          this.suspendVsCodeAdvancedWithinOperation();
        } catch (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring native Codex after startup failure also failed:`
            + ` ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        throw error;
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async deactivateRuntimeBridge(operationName = "runtime-bridge-stop") {
    await this.waitForCodexConfigStatus();
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      let route;
      let routeError;
      try {
        route = await this.restoreBridgeRouteWithinOperation(operationName);
      } catch (error) {
        routeError = error;
      }
      let vscode;
      let vscodeError;
      try {
        vscode = this.suspendVsCodeAdvancedWithinOperation();
      } catch (error) {
        vscodeError = error;
      }
      if (routeError || vscodeError) {
        throw new Error([
          routeError ? `restoring the native Codex route failed: ${routeError instanceof Error ? routeError.message : String(routeError)}` : null,
          vscodeError ? `restoring VS Code cliExecutable failed: ${vscodeError instanceof Error ? vscodeError.message : String(vscodeError)}` : null,
        ].filter(Boolean).join("; "));
      }
      return { route, vscode };
    } finally {
      this.lifecycleOperation = null;
    }
  }

  mcpConnectorName() {
    const config = this.supervisor.readConfig();
    if (!config) {
      throw new Error("The native MCP runtime is not configured");
    }
    if (typeof config.appName !== "string" || !config.appName.trim() || config.appName.length > 80) {
      throw new Error("The configured ChatGPT connector name is invalid");
    }
    return config.appName.trim();
  }

  cancelBrowserTurns() {
    return this.run("cancel-browser-turns", ["service", "cancel-turns"], {
      message: "Cancelling retained browser turns",
      successMessage: "Retained browser turns cancelled",
      timeoutMs: 15_000,
    });
  }

  restoreNativeCodex() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return this.run("restore-native-codex", ["route", "reset"], {
      message: "Restoring native Codex configuration",
      successMessage: "Native Codex configuration restored",
      timeoutMs: 15_000,
    });
  }

  async uninstallIntegration() {
    const name = "uninstall-integration";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    this.lifecycleOperation = name;
    try {
      try {
        if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
        else await this.supervisor.stopForSetup();
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the previous Codex route was restored,`
          + " but launcher runtime cleanup did not complete",
        );
      }
      try {
        return await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: "Restoring the previous Codex route",
          successMessage: "LCA Codex integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw error;
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  setupCore() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    return this.run("core-setup", ["route", "install"], {
      message: "Installing LCA Codex models into Codex",
      successMessage: "Codex integration installed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
  }

  async upgradeManagedRuntime() {
    await this.waitForCodexConfigStatus();
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const currentVersion = this.app.getVersion();
    if (existing.owner !== "launcher" || existing.config?.releaseVersion === currentVersion) {
      return { updated: false };
    }
    const route = await this.bridgeStatus("runtime-upgrade-route");
    const args = [
      "setup",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("runtime-upgrade", args, {
      message: `Upgrading launcher runtime from ${existing.config.releaseVersion} to ${currentVersion}`,
      successMessage: `Launcher runtime upgraded to ${currentVersion}`,
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    if (!route.active) await this.setBridgeEnabled(false);
    return {
      updated: true,
      mode: existing.mode,
      bridgeEnabled: route.active,
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      stdout: result.stdout,
    };
  }

  setupMcp({ tunnelId = "", runtimeKey = "", replace = false, appName = "" } = {}) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const connectorName = typeof appName === "string" ? appName.trim() : "";
    if (!connectorName || connectorName.length > 80) {
      throw new Error("Connector name must contain 1 to 80 characters");
    }
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured();
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) {
      throw new Error("A Tunnels Read + Use runtime key is required");
    }
    const args = [
      "setup",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--app-name",
      connectorName,
    ];
    if (reuseSavedCredentials) {
      args.push("--acknowledge-unofficial", "--restart-service");
      return this.runSetup("mcp-setup", args, {
        message: "Connecting the native Codex harness with saved tunnel credentials",
        successMessage: "Local MCP tools are ready",
        timeoutMs: CORE_SETUP_TIMEOUT_MS,
        startAfterSetup: true,
      });
    }
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretsDir, 0o700); } catch {}
    const keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
    args.push(
      "--tunnel-id",
      tunnelId,
      "--runtime-key-file",
      keyPath,
      "--acknowledge-unofficial",
      "--restart-service",
    );
    return this.runSetup("mcp-setup", args, {
      message: "Connecting the native Codex harness",
      successMessage: "Local MCP tools are ready",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
      startAfterSetup: true,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  }

  async runSetup(name, args, options = {}) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const { startAfterSetup = false, ...runOptions } = options;
    const previousRuntime = this.runtimeConfigSnapshot();
    const previousLive = previousRuntime.owner === "launcher"
      ? await this.supervisor.observeRuntime()
      : null;
    const wasRunning = previousLive?.lifecycle === "ready" && previousLive.owner === "current-launcher";
    const checkpoint = this.captureSetupCheckpoint(previousRuntime);
    this.lifecycleOperation = name;
    let setupCommandStarted = false;
    try {
      if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
      else await this.supervisor.stopForSetup();
      setupCommandStarted = true;
      const result = await this.run(name, args, runOptions);
      if (wasRunning || startAfterSetup) {
        const runtime = await this.supervisor.startIfConfigured();
        if (runtime.status !== "ready") {
          throw new Error(`Setup completed, but the full harness could not be started: ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
        }
      } else {
        await this.supervisor.stopForSetup();
      }
      return result;
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      const failures = [];
      let rolledBack = false;
      let checkpointChanged = false;
      if (!previousRuntime.configured && setupCommandStarted) {
        try {
          rolledBack = await this.rollbackFirstSetup(checkpoint);
        } catch (caught) {
          failures.push(
            `first-time setup rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
      if (previousRuntime.configured && checkpoint) {
        try {
          checkpointChanged = this.setupCheckpointChanged(checkpoint);
        } catch (caught) {
          checkpointChanged = true;
          failures.push(
            `checking the setup checkpoint failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
        try {
          this.restoreSetupCheckpoint(checkpoint);
        } catch (caught) {
          failures.push(caught instanceof Error ? caught.message : String(caught));
        }
      }
      let recoveryError;
      try {
        await this.restorePreviousRuntime(previousRuntime, name, {
          repairExternal: previousRuntime.owner === "external" && checkpointChanged,
          wasRunning,
        });
      } catch (caught) {
        recoveryError = caught;
      }
      if (recoveryError) {
        failures.push(
          `restoring the previous launcher runtime failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      const message = [
        primary,
        ...(rolledBack ? ["incomplete first-time setup was rolled back"] : []),
        ...failures,
      ].join("; ");
      this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.lifecycleOperation = null;
    }
  }
}

module.exports = { RuntimeHost, CODEX_TOOL_HEALTH_PROBE_PROMPT, codexToolHealthProbeArgs };
