const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const {
  findCodexExecutable,
  lifecycleEventFromLine,
  postLifecycleEvent,
} = require("../electron/codex-cli-proxy.cjs");

const proxyPath = path.resolve(__dirname, "../electron/codex-cli-proxy.cjs");

function runNode(args, { env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function fakeCodex(root, source) {
  const script = path.join(root, "fake-codex.cjs");
  fs.writeFileSync(script, source);
  return script;
}

test("lifecycle parser recognizes Codex turn methods in both directions", () => {
  assert.deepEqual(
    lifecycleEventFromLine(
      JSON.stringify({ id: 8, method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } }),
      "extension->codex",
    ),
    { direction: "extension->codex", method: "turn/interrupt", threadId: "thread-a", turnId: "turn-a", requestId: 8 },
  );
  assert.deepEqual(
    lifecycleEventFromLine(
      JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-b", threadId: "thread-b" } } }),
      "codex->extension",
    ),
    { direction: "codex->extension", method: "turn/started", threadId: "thread-b", turnId: "turn-b", requestId: undefined },
  );
  assert.equal(lifecycleEventFromLine("not json", "codex->extension"), null);
  assert.equal(lifecycleEventFromLine(JSON.stringify({ method: "item/started" }), "codex->extension"), null);
});

test("proxy forwards args, stdin, stdout, stderr and child exit code without polluting stderr", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-proxy-"));
  try {
    const fake = fakeCodex(root, `
      process.stderr.write("child-stderr\\n");
      process.stdout.write(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1", threadId: "thread-1" } } }) + "\\n");
      process.stdout.write("raw-child-output\\n");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        process.stdout.write("stdin=" + input.trim() + "\\n");
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", threadId: "thread-1" } } }) + "\\n");
        process.stdout.write("args=" + JSON.stringify(process.argv.slice(2)) + "\\n");
        process.exitCode = 7;
      });
    `);
    const interrupt = `${JSON.stringify({ id: 3, method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } })}\n`;
    const result = await runNode([proxyPath, fake, "app-server", "--analytics-default-enabled"], {
      env: { LCA_CODEX_REAL_EXECUTABLE: process.execPath, LCA_CODEX_HOME: root },
      input: interrupt,
    });

    assert.equal(result.code, 7);
    assert.match(result.stdout, /raw-child-output/);
    assert.match(result.stdout, /stdin=\{"id":3,"method":"turn\/interrupt"/);
    assert.match(result.stdout, /args=\["app-server","--analytics-default-enabled"\]/);
    assert.match(result.stderr, /child-stderr/);
    assert.doesNotMatch(result.stderr, /\[lca-codex-proxy\] lifecycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle reporter authenticates to the local runtime control endpoint", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-lifecycle-"));
  const token = "x".repeat(48);
  let received = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received = { authorization: req.headers.authorization, body: JSON.parse(body) };
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port: address.port, controlToken: token }));
    const ok = await postLifecycleEvent(
      { direction: "extension->codex", method: "turn/interrupt", threadId: "thread-a", turnId: "turn-a" },
      { env: { ...process.env, LCA_CODEX_HOME: home } },
    );
    assert.equal(ok, true);
    assert.deepEqual(received, {
      authorization: `Bearer ${token}`,
      body: { direction: "extension->codex", method: "turn/interrupt", threadId: "thread-a", turnId: "turn-a" },
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PATH discovery allows the same proxy to front a standalone Codex CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-path-"));
  try {
    const executable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
    fs.writeFileSync(executable, "standalone-codex");
    assert.equal(findCodexExecutable({ homeDir: path.join(root, "no-home"), env: { PATH: root } }), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official extension discovery selects the current platform and architecture Codex binary", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-discovery-"));
  try {
    const platformName = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
    const archName = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const older = path.join(home, ".vscode", "extensions", "openai.chatgpt-1.0.0", "bin", `${platformName}-${archName}`, executableName);
    const newer = path.join(home, ".vscode", "extensions", "openai.chatgpt-2.0.0", "bin", `${platformName}-${archName}`, executableName);
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(older, "old");
    fs.writeFileSync(newer, "new");
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(path.dirname(path.dirname(path.dirname(older))), oldTime, oldTime);

    assert.equal(findCodexExecutable({ homeDir: home }), newer);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
