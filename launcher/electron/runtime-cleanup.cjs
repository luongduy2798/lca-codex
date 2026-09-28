const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");

const SERVICE_LABELS = ["lca-codex", "lca-token.codex"].flatMap(name =>
  ["daemon", "tunnel"].map(kind => `io.github.luongduy2798.${name}.${kind}`));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function run(file, args, timeout = 3_000) {
  return new Promise(resolve => execFile(file, args, {
    encoding: "utf8", timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => resolve({ code: error ? error.code || 1 : 0, stdout, stderr })));
}

function sameProcess(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.uid === b.uid && a.start === b.start
    && a.executable === b.executable && a.command === b.command);
}

function runtimeEntry(file) {
  try {
    const resolved = fs.realpathSync(file);
    if (!fs.statSync(resolved).isFile()) return false;
    const directory = path.dirname(resolved);
    const root = path.dirname(directory);
    if (path.basename(directory) === "src" && path.basename(resolved) === "cli.ts") {
      return readJson(path.join(root, "package.json"))?.name === "lca-codex";
    }
    if (path.basename(directory) === "app" && ["cli.js", "browser-helper.cjs"].includes(path.basename(resolved))) {
      const manifest = readJson(path.join(root, "manifest.json"));
      return manifest?.schemaVersion === 1 && typeof manifest.appVersion === "string"
        && /^[a-f0-9]{64}$/.test(manifest.bundleId);
    }
    return path.basename(directory) === ".launcher-runtime"
      && path.basename(resolved) === "browser-helper.cjs"
      && readJson(path.join(root, "package.json"))?.name === "lca-codex";
  } catch { return false; }
}

function invocationKind(processInfo, verifyEntry = runtimeEntry) {
  const { executable, command, args } = processInfo;
  if (!executable) return null;
  // Native argv is available on Linux/Windows. macOS ps leaves paths with spaces
  // unquoted, so remove the independently observed executable before parsing.
  let tail;
  if (args) tail = args.slice(1).map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(" ");
  else if (command.startsWith(`${executable} `)) tail = command.slice(executable.length + 1);
  else return null;
  const entry = tail.match(/^(?:run\s+)?"?(.+?[\\/](?:src[\\/]cli\.ts|app[\\/]cli\.js))"?\s+(serve|mcp)(?:\s|$)/);
  if (entry && /^bun(?:\.exe)?$/i.test(path.basename(executable)) && verifyEntry(entry[1])) {
    return entry[2] === "serve" ? "daemon" : "mcp";
  }
  const helper = tail.match(/^"?(.+?[\\/]browser-helper\.cjs)"?(?:\s|$)/);
  if (helper && /^(?:bun|node|electron|LCA Codex)(?:\.exe)?$/i.test(path.basename(executable))
    && verifyEntry(helper[1])) return "helper";
  return null;
}

function hasArgument(p, value) {
  if (typeof value !== "string" || !value) return false;
  if (p.args) return p.args.includes(value);
  return new RegExp(`(?:^|\\s)"?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?(?=\\s|$)`).test(p.command);
}

function discoverOwned(snapshot, { uid, config, coreHome, known = [], ownedChildren = [], verifyEntry = runtimeEntry }) {
  const own = snapshot.processes.filter(p => p.uid === uid && p.pid !== process.pid && p.start && p.executable);
  const processes = new Map();
  for (const p of own) {
    const kind = invocationKind(p, verifyEntry);
    if (kind) processes.set(p.pid, { ...p, kind });
    else {
      const previous = known.find(row => sameProcess(row, p));
      if (previous) processes.set(p.pid, { ...p, kind: previous.kind });
      else if (p.ppid === process.pid && ownedChildren.some(child => child.pid === p.pid
        && child.exitCode === null && child.signalCode === null && Array.isArray(child.spawnargs)
        && (p.command === child.spawnargs.join(" ") || (p.args && JSON.stringify(p.args) === JSON.stringify(child.spawnargs))))) {
        processes.set(p.pid, { ...p, kind: "owned-child" });
      }
    }
  }
  const services = [];
  for (const service of snapshot.services) {
    if (!SERVICE_LABELS.includes(service.label)) continue;
    const args = service.args || [];
    const daemon = service.label.endsWith(".daemon");
    const pairedDaemon = snapshot.services.find(s => s.label === service.label.replace(/\.tunnel$/, ".daemon"));
    const pairedArgs = pairedDaemon?.args || [];
    const validDaemon = argv => invocationKind({ executable: argv[0], args: argv, command: "" }, verifyEntry) === "daemon";
    const binary = args[0];
    const legacyBinary = path.join(os.homedir(), ".lca-token", "profiles", "codex", "bin", "tunnel-client");
    const validTunnel = binary && path.basename(binary) === "tunnel-client"
      && ((binary === config?.tunnel?.binaryPath && args.includes(config.tunnel.profileDir))
        || (binary === legacyBinary && validDaemon(pairedArgs)));
    const live = processes.get(service.pid);
    if (!(daemon ? validDaemon(args) || live?.kind === "daemon" : validTunnel)) continue;
    services.push(service);
    const p = own.find(row => row.pid === service.pid);
    if (p && (daemon ? invocationKind(p, verifyEntry) === "daemon" : p.executable === binary)) {
      processes.set(p.pid, { ...p, kind: daemon ? "daemon" : "tunnel" });
    }
  }
  for (const p of own) {
    if (!/^tunnel-client(?:\.exe)?$/i.test(path.basename(p.executable))) continue;
    const configured = p.executable === config?.tunnel?.binaryPath
      && (hasArgument(p, config.tunnel.profileDir) || hasArgument(p, config.tunnel.alias));
    const child = [...processes.values()].some(c => c.ppid === p.pid && c.kind === "mcp");
    const privateBinary = p.executable === path.join(coreHome, "bin", path.basename(p.executable))
      && p.command.includes(path.join(coreHome, "tunnel"));
    if (configured || child || privateBinary) processes.set(p.pid, { ...p, kind: "tunnel" });
  }
  // A tunnel can launch a legacy MCP worker whose source predates the rename.
  // Its observed parent relationship proves ownership; names alone never do.
  let changed;
  do {
    changed = false;
    for (const p of own) {
      if (processes.has(p.pid) || !processes.has(p.ppid)
        || !/^(?:bun|node|tunnel-client|electron|LCA Codex)(?:\.exe)?$/i.test(path.basename(p.executable))) continue;
      processes.set(p.pid, { ...p, kind: "worker" });
      changed = true;
    }
  } while (changed);
  return { processes: [...processes.values()], services };
}

function createSystem({
  platform = process.platform,
  home = os.homedir(),
  execute = run,
  uid = platform === "win32" ? os.userInfo().username : process.getuid(),
} = {}) {
  let deadline = Infinity;
  const command = (file, args, timeout = 3_000) => {
    if (Date.now() >= deadline) throw new Error("Runtime cleanup deadline exceeded");
    return execute(file, args, Math.max(1, Math.min(timeout, deadline - Date.now())));
  };
  async function listProcesses() {
    if (platform === "linux") {
      return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
          const base = `/proc/${name}`;
          const owner = fs.statSync(base).uid;
          if (owner !== uid) return [];
          const stat = fs.readFileSync(`${base}/stat`, "utf8").split(") ").at(-1).split(" ");
          const args = fs.readFileSync(`${base}/cmdline`, "utf8").split("\0").filter(Boolean);
          return [{ pid: Number(name), ppid: Number(stat[1]), uid: owner, start: stat[19],
            executable: fs.readlinkSync(`${base}/exe`), args, command: JSON.stringify(args) }];
        } catch { return []; }
      });
    }
    if (platform === "win32") {
      const result = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
        + "$rows=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(bun|node|tunnel-client|LCA Codex|electron)\\.exe$'} | ForEach-Object {"
        + "$p=$_; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if($owner.Sid -eq $me){"
        + "[pscustomobject]@{pid=$p.ProcessId;ppid=$p.ParentProcessId;uid=$env:USERNAME;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine}}});"
        + "ConvertTo-Json -Compress -InputObject $rows"], 5_000);
      if (result.code !== 0) throw new Error("Cannot inspect Windows runtime processes");
      return JSON.parse(result.stdout || "[]").map(p => ({ ...p, command: p.command?.replace(/^"([^"]+)"/, "$1") || "" }));
    }
    const result = await command("ps", ["-ww", "-axo", "pid=,ppid=,uid=,lstart=,command="], 2_000);
    if (result.code !== 0) throw new Error("Cannot inspect runtime processes");
    const rows = result.stdout.split("\n").flatMap(line => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
      if (!m || Number(m[3]) !== uid || !/(?:cli\.(?:ts|js)|browser-helper\.cjs|tunnel-client)/.test(m[5])) return [];
      return [{ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), start: m[4], command: m[5] }];
    });
    return await Promise.all(rows.map(async p => {
      const executable = await command("ps", ["-p", String(p.pid), "-o", "comm="], 1_000);
      return { ...p, executable: executable.code === 0 ? executable.stdout.trim() : "" };
    }));
  }
  async function listServices() {
    if (platform !== "darwin") return [];
    const loaded = await command("launchctl", ["list"], 2_000);
    if (loaded.code !== 0) throw new Error("Cannot inspect launcher background services");
    return (await Promise.all(SERVICE_LABELS.map(async label => {
      const row = loaded.stdout.split("\n").find(line => line.trim().split(/\s+/).at(-1) === label);
      const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      let args = [];
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.uid === uid) {
          const parsed = await command("plutil", ["-convert", "json", "-o", "-", "--", file], 1_000);
          const definition = parsed.code === 0 ? JSON.parse(parsed.stdout) : null;
          if (definition?.Label === label) args = definition.ProgramArguments || [];
        }
      } catch {}
      if (!row && !args.length) return null;
      return { label, target: `gui/${uid}/${label}`, loaded: Boolean(row),
        pid: row ? Number(row.trim().split(/\s+/)[0]) || null : null, args };
    }))).filter(Boolean);
  }
  async function listeners(processes) {
    if (!processes.length) return [];
    const ids = new Set(processes.map(p => p.pid));
    if (platform === "darwin") {
      const result = await command("lsof", ["-nP", "-a", "-p", [...ids].join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn"], 2_000);
      if (result.code !== 0 && result.code !== 1) throw new Error("Cannot inspect runtime listeners");
      let pid;
      return result.stdout.split("\n").flatMap(line => {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        const match = line.match(/^n.*:(\d+)$/);
        return match && ids.has(pid) ? [{ pid, port: Number(match[1]) }] : [];
      });
    }
    if (platform === "win32") {
      const result = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @(${[...ids].join(",")}) } | Select-Object @{n='pid';e={$_.OwningProcess}},@{n='port';e={$_.LocalPort}})`], 5_000);
      if (result.code !== 0) throw new Error("Cannot inspect runtime listeners");
      return JSON.parse(result.stdout || "[]");
    }
    const inodes = new Map();
    for (const pid of ids) {
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          try {
            const match = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
            if (match) inodes.set(match[1], pid);
          } catch {}
        }
      } catch {}
    }
    return ["tcp", "tcp6"].flatMap(name => fs.readFileSync(`/proc/net/${name}`, "utf8").split("\n").flatMap(line => {
      const fields = line.trim().split(/\s+/);
      return fields[3] === "0A" && inodes.has(fields[9])
        ? [{ pid: inodes.get(fields[9]), port: parseInt(fields[1].split(":")[1], 16) }] : [];
    }));
  }
  return {
    uid, platform,
    setDeadline(value) { deadline = value; },
    async snapshot() {
      const [processes, services] = await Promise.all([listProcesses(), listServices()]);
      return { processes, services };
    },
    listeners,
    async disableService(service) {
      const disabled = await command("launchctl", ["disable", service.target], 2_000);
      if (disabled.code !== 0) throw new Error(`Cannot disable ${service.label}`);
      if (service.loaded) await command("launchctl", ["bootout", service.target], 3_000);
      const [loaded, flags] = await Promise.all([
        command("launchctl", ["list", service.label], 1_000),
        command("launchctl", ["print-disabled", `gui/${uid}`], 1_000),
      ]);
      const disabledFlag = flags.stdout.split(/\r?\n/).some(line => {
        const match = line.trim().match(/^"([^"]+)"\s*=>\s*(true|disabled)\s*;?$/);
        return match?.[1] === service.label;
      });
      if (loaded.code === 0 || flags.code !== 0 || !disabledFlag) {
        throw new Error(`Background service ${service.label} can still respawn`);
      }
    },
    async signal(p, signal) {
      // Signal individual verified identities, never an unverified process group.
      if (platform === "win32") {
        const result = await command("taskkill.exe", ["/PID", String(p.pid), "/F"], 2_000);
        if (result.code !== 0 && (await listProcesses()).some(row => sameProcess(row, p))) {
          throw new Error(`Cannot stop runtime PID ${p.pid}`);
        }
      } else {
        try { process.kill(p.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    },
  };
}

async function gracefulShutdown(config, processes, timeoutMs) {
  if (config?.host !== "127.0.0.1" || !Number.isInteger(config.port) || !config.controlToken) return;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const base = `http://127.0.0.1:${config.port}`;
    const health = await (await fetch(`${base}/healthz`, { signal })).json();
    if (health.service !== "lca-codex" || !processes.some(p => p.kind === "daemon" && p.pid === health.pid)) return;
    for (const action of ["drain", "cancel-browser-turns", "shutdown"]) {
      const response = await fetch(`${base}/admin/${action}`, { method: "POST", signal,
        headers: { authorization: `Bearer ${config.controlToken}` } });
      if (!response.ok) return;
      await response.arrayBuffer();
    }
  } catch { /* Verified OS identity remains the authority for explicit manual Stop. */ }
}

async function removeDeadSocket(file) {
  if (!file || process.platform === "win32") return;
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.uid !== process.getuid()) return;
  const absent = await new Promise(resolve => {
    const socket = net.connect(file);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", error => finish(["ECONNREFUSED", "ENOENT"].includes(error.code)));
  });
  if (!absent) throw new Error("Broker socket still has a live or unverified owner");
  try {
    const current = fs.lstatSync(file);
    if (current.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(file);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function cleanupRuntimes({ coreHome, logger, system = createSystem(), verifyEntry,
  ownedChildren = [], timeoutMs = 30_000, termMs = 3_000, killMs = 2_000, graceMs = 2_000, signal }) {
  const deadline = Date.now() + timeoutMs;
  system.setDeadline?.(deadline);
  const config = readJson(path.join(coreHome, "config.json"));
  const options = { coreHome, config, uid: system.uid, verifyEntry, ownedChildren };
  const errors = [];
  const checkedServices = new Set();
  const seen = new Map();
  const budget = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Runtime cleanup exceeded 30 seconds");
  };
  const inventory = async () => {
    budget();
    const found = discoverOwned(await system.snapshot(), { ...options, known: [...seen.values()] });
    for (const p of found.processes) seen.set(p.pid, p);
    budget();
    return found;
  };
  const perform = async fn => { try { await fn(); } catch (error) { errors.push(error.message); } };
  let current = await inventory();
  for (const p of current.processes) seen.set(p.pid, p);
  const ports = await system.listeners(current.processes);
  logger?.info?.("runtime.cleanup_started", { pids: [...seen.keys()], ports: ports.map(p => p.port),
    services: current.services.map(s => s.label) });
  // Disable the supervisor BEFORE terminating its child: KeepAlive otherwise wins
  // the race for the Responses port each time the user presses Start.
  await Promise.all(current.services.map(service => perform(async () => {
    budget(); await system.disableService(service); checkedServices.add(service.label);
  })));
  if (graceMs > 0) await gracefulShutdown(config, current.processes, Math.min(graceMs, Math.max(1, deadline - Date.now())));
  for (const [stopSignal, waitMs] of [["SIGTERM", termMs], ["SIGKILL", killMs]]) {
    const until = Math.min(deadline, Date.now() + waitMs);
    const signalled = new Set();
    do {
      current = await inventory();
      for (const p of current.processes) {
        const identity = `${p.pid}:${p.start}`;
        seen.set(p.pid, p);
        if (signalled.has(identity)) continue;
        // Re-read immediately before each signal, including escalation and respawns.
        const fresh = (await system.snapshot()).processes.find(row => row.pid === p.pid);
        if (!sameProcess(p, fresh)) continue;
        budget();
        await perform(() => system.signal(p, stopSignal));
        signalled.add(identity);
      }
      if (!current.processes.length) break;
      await sleep(Math.min(100, Math.max(0, until - Date.now())));
    } while (Date.now() < until);
  }
  current = await inventory();
  const remainingPorts = await system.listeners(current.processes);
  if (current.processes.length) errors.push(`Runtime PIDs still alive: ${current.processes.map(p => p.pid).join(", ")}`);
  if (remainingPorts.length) errors.push(`Runtime ports still listening: ${remainingPorts.map(p => p.port).join(", ")}`);
  if (current.services.some(s => s.loaded && checkedServices.has(s.label))) errors.push("Runtime background service is still loaded");
  if (errors.length) throw new Error([...new Set(errors)].join("; "));
  budget();
  await removeDeadSocket(path.join(coreHome, "runtime", "turn-broker.sock"));
  if (config?.brokerSocketPath?.startsWith(`${coreHome}${path.sep}`)) await removeDeadSocket(config.brokerSocketPath);
  fs.rmSync(path.join(coreHome, "runtime", "launcher-supervisor.json"), { force: true });
  logger?.info?.("runtime.cleanup_completed", { pids: [...seen.keys()], ports: ports.map(p => p.port) });
}

module.exports = { cleanupRuntimes, createSystem, discoverOwned, invocationKind, runtimeEntry, sameProcess };
