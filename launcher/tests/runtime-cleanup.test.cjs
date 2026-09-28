const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { cleanupRuntimes, createSystem, discoverOwned, invocationKind, sameProcess } = require("../electron/runtime-cleanup.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source with spaces");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "lca-codex" }));
  const entry = path.join(source, "src", "cli.ts");
  fs.writeFileSync(entry, "// fixture");
  fs.mkdirSync(path.join(root, "runtime"));
  const marker = path.join(root, "runtime", "launcher-supervisor.json");
  fs.writeFileSync(marker, "invalid marker");
  const rows = [];
  const services = [];
  const calls = [];
  const daemon = (pid, port = 17841, overrides = {}) => ({ pid, ppid: 1, uid: 501,
    start: `start-${pid}`, executable: "/fixture/bun", command: `/fixture/bun ${entry} serve`, port, ...overrides });
  const system = {
    uid: 501,
    async snapshot() { return { processes: rows.map(p => ({ ...p })), services: services.map(s => ({ ...s })) }; },
    async listeners(processes) { return processes.filter(p => p.port).map(p => ({ pid: p.pid, port: p.port })); },
    async disableService(service) { calls.push(["disable", service.label]); services.find(s => s.label === service.label).loaded = false; },
    async signal(p, signal) {
      calls.push([signal, p.pid]);
      const index = rows.findIndex(row => sameProcess(row, p));
      if (index >= 0 && signal === "SIGKILL") rows.splice(index, 1);
    },
  };
  const clean = options => cleanupRuntimes({ coreHome: root, system, graceMs: 0, termMs: 1, killMs: 1, ...options });
  return { root, entry, rows, services, calls, system, daemon, clean, marker };
}

test("manual cleanup disables legacy KeepAlive before killing all verified ports", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100001), f.daemon(100002, 17842), f.daemon(100003, 17843, {
    executable: "/other/node", command: "node unrelated-server.js",
  }), f.daemon(100004, 17844, { uid: 502 }));
  f.services.push({ label: "io.github.luongduy2798.lca-token.codex.daemon", pid: 100001,
    loaded: true, args: ["/fixture/bun", f.entry, "serve"] });
  const kill = f.system.signal;
  f.system.signal = async (p, signal) => {
    assert.equal(f.services[0].loaded, false, "KeepAlive must be unloaded first");
    await kill(p, signal);
  };
  await f.clean();
  assert.deepEqual(f.rows.map(p => p.pid), [100003, 100004]);
  assert.deepEqual(f.calls.filter(c => c[0] === "SIGKILL").map(c => c[1]), [100001, 100002]);
  assert.equal(fs.existsSync(f.marker), false);
  await f.clean(); // Stop is idempotent.
});

test("cleanup needs neither valid configuration nor PID marker nor a health response", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "config.json"), "broken");
  fs.rmSync(f.marker);
  f.rows.push(f.daemon(100005, 22222));
  await f.clean();
  assert.equal(f.rows.length, 0);
});

test("SIGKILL never targets a reused PID", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100006));
  f.system.signal = async (p, signal) => {
    f.calls.push([signal, p.pid]);
    f.rows[0] = { ...f.rows[0], start: "reused", executable: "/other/node", command: "node other.js" };
  };
  await f.clean();
  assert.deepEqual(f.calls, [["SIGTERM", 100006]]);
  assert.equal(f.rows[0].start, "reused");
});

test("identity changing between discovery and signal is not killed", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100007));
  let reads = 0;
  const snapshot = f.system.snapshot;
  f.system.snapshot = async () => {
    if (++reads === 3) Object.assign(f.rows[0], { start: "different", executable: "/other/node", command: "other" });
    return snapshot();
  };
  await f.clean();
  assert.deepEqual(f.calls, []);
});

test("a cleanup failure preserves evidence but still stops other runtimes", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100008), f.daemon(100009));
  const signal = f.system.signal;
  f.system.signal = async (p, kind) => {
    if (p.pid === 100008) throw new Error("permission denied for fixture");
    await signal(p, kind);
  };
  await assert.rejects(f.clean(), /permission denied.*Runtime PIDs still alive: 100008/);
  assert.deepEqual(f.rows.map(p => p.pid), [100008]);
  assert.equal(fs.existsSync(f.marker), true);
});

test("service disable failure cannot report successful Stop or skip other cleanup", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100010));
  f.services.push({ label: "io.github.luongduy2798.lca-codex.daemon", pid: 100010,
    loaded: true, args: ["/fixture/bun", f.entry, "serve"] });
  f.system.disableService = async () => { throw new Error("cannot disable service"); };
  await assert.rejects(f.clean(), /cannot disable service/);
  assert.equal(f.rows.length, 0);
  assert.equal(fs.existsSync(f.marker), true);
});

test("legacy tunnel and orphaned workers remain owned after launchd unload", async t => {
  const f = fixture(t);
  const binary = path.join(os.homedir(), ".lca-token/profiles/codex/bin/tunnel-client");
  f.rows.push(f.daemon(100011), { ...f.daemon(100012), executable: binary, command: `${binary} old-profile` },
    { ...f.daemon(100013), ppid: 100012, command: "/fixture/bun /legacy/mcp.js" });
  f.services.push({ label: "io.github.luongduy2798.lca-token.codex.daemon", pid: 100011,
    loaded: true, args: ["/fixture/bun", f.entry, "serve"] },
  { label: "io.github.luongduy2798.lca-token.codex.tunnel", pid: 100012,
    loaded: true, args: [binary, "old-profile"] });
  const disable = f.system.disableService;
  f.system.disableService = async s => {
    await disable(s);
    f.services.find(row => row.label === s.label).pid = null;
    f.rows.find(p => p.pid === 100013).ppid = 1;
  };
  await f.clean();
  assert.equal(f.rows.length, 0);
});

test("arbitrary process arguments or legacy service names do not establish ownership", t => {
  const f = fixture(t);
  const fake = f.daemon(100014, 9999, { command: `/fixture/bun -e 'console.log("${f.entry} serve")'` });
  assert.equal(invocationKind(fake), null);
  const result = discoverOwned({ processes: [fake], services: [{ label: "io.github.luongduy2798.lca-token.codex.daemon",
    pid: fake.pid, loaded: true, args: ["/other/node", "unrelated.js"] }] }, { uid: 501, coreHome: f.root });
  assert.deepEqual(result, { processes: [], services: [] });
});

test("older packaged daemon and browser helper identities are recognized", t => {
  const f = fixture(t);
  const root = path.join(f.root, "old runtime");
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, appVersion: "0.1.0", bundleId: "a".repeat(64) }));
  for (const name of ["cli.js", "browser-helper.cjs"]) fs.writeFileSync(path.join(root, "app", name), "// fixture");
  assert.equal(invocationKind({ executable: "/fixture/bun", command: `/fixture/bun ${root}/app/cli.js serve` }), "daemon");
  assert.equal(invocationKind({ executable: "/Applications/LCA Codex.app/Contents/MacOS/LCA Codex",
    command: `/Applications/LCA Codex.app/Contents/MacOS/LCA Codex ${root}/app/browser-helper.cjs` }), "helper");
});

test("hung health endpoint cannot prevent forced cleanup", async t => {
  const f = fixture(t);
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.writeFileSync(path.join(f.root, "config.json"), JSON.stringify({ host: "127.0.0.1", port: server.address().port,
    controlToken: "fixture-only-control-token" }));
  f.rows.push(f.daemon(100015));
  await f.clean({ graceMs: 20 });
  assert.equal(f.rows.length, 0);
});

test("cleanup deadline refuses further signals and retains the marker", async t => {
  const f = fixture(t);
  f.rows.push(f.daemon(100016));
  await assert.rejects(f.clean({ timeoutMs: -1 }), /exceeded/);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.marker), true);
});

test("an isolated real daemon ignoring TERM is killed and its listener is released", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.entry, `
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("fixture"); } });
    process.on("SIGTERM", () => {});
    console.log(JSON.stringify({ port: server.port, executable: process.execPath }));
    setInterval(() => {}, 1000);
  `);
  const child = spawn("bun", [f.entry, "serve"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Fixture daemon startup timed out")), 5_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())); }
    });
  });
  const row = f.daemon(child.pid, ready.port, { executable: ready.executable,
    command: `${ready.executable} ${f.entry} serve` });
  // Discovery is restricted to this fixture-created child, never the host process table.
  f.system.snapshot = async () => ({ processes: child.exitCode === null && child.signalCode === null ? [row] : [], services: [] });
  f.system.signal = async (p, signal) => { assert.equal(p.pid, child.pid); child.kill(signal); };
  await f.clean({ termMs: 30, killMs: 2_000 });
  assert.notEqual(child.signalCode, null);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(ready.port, "127.0.0.1", resolve); });
  await new Promise(resolve => probe.close(resolve));
});

test("supervisor manual cleanup ignores malformed markers and does not restart a failed component", async t => {
  const f = fixture(t);
  const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
  const log = { info() {}, warn() {}, error() {} };
  const supervisor = new RuntimeSupervisor({ app: { getVersion: () => "1.0.13" }, logger: log, coreHome: f.root,
    runtimeCleanup: f.clean, browserDescriptorPath: path.join(f.root, "browser.json") });
  supervisor.startTunnel = async () => { throw new Error("must not restart"); };
  supervisor.restoreDrainedDaemon = async () => { throw new Error("must not resume"); };
  f.rows.push(f.daemon(100017));
  assert.equal((await supervisor.stopAllRuntimes()).lifecycle, "stopped");
  assert.equal(supervisor.manualResetting, false);
  assert.equal(supervisor.tunnelMonitorTimer, null);
  assert.equal(fs.existsSync(f.marker), false);
});

for (const disabledValue of ["true", "disabled"]) {
test(`macOS service shutdown recognizes ${disabledValue} and verifies unload`, async () => {
  const calls = [];
  const label = "io.github.luongduy2798.lca-token.codex.daemon";
  const system = createSystem({ platform: "darwin", uid: 501, execute: async (file, args) => {
    calls.push([file, ...args]);
    return { code: args[0] === "list" ? 113 : 0, stdout: args[0] === "print-disabled" ? `"${label}" => ${disabledValue}` : "" };
  } });
  await system.disableService({ label, target: `gui/501/${label}`, loaded: true });
  assert.deepEqual(calls.slice(0, 2).map(c => c[1]), ["disable", "bootout"]);
});
}
