const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const vitePackage = require.resolve("vite/package.json", { paths: [root] });
const viteBin = path.join(path.dirname(vitePackage), "bin", "vite.js");
const electronBin = require("electron");
const bun = process.env.LCA_TOKEN_BUN || process.execPath;

const helperBuild = spawnSync(bun, ["run", "scripts/build-browser-helper.ts"], {
  cwd: path.resolve(root, ".."),
  env: process.env,
  stdio: "inherit",
});
if (helperBuild.error) throw helperBuild.error;
if (helperBuild.status !== 0) process.exit(helperBuild.status ?? 1);

const vite = spawn(process.execPath, [viteBin], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let electron;
let stopped = false;
let restartRequested = false;
let restartTimer = null;
let electronWatcher = null;

const stop = () => {
  if (stopped) return;
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  electronWatcher?.close();
  electron?.kill("SIGTERM");
  vite.kill("SIGTERM");
};

const spawnElectron = () => {
  if (stopped) return;
  restartRequested = false;
  electron = spawn(electronBin, [root], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4178",
      LCA_TOKEN_BUN: bun,
    },
  });
  electron.once("exit", (code) => {
    electron = undefined;
    if (stopped) return;
    if (restartRequested) {
      spawnElectron();
      return;
    }
    stop();
    process.exitCode = code ?? 0;
  });
  electron.once("error", (error) => {
    console.error(`Electron failed to start: ${error.message}`);
    electron = undefined;
    stop();
    process.exitCode = 1;
  });
};

const scheduleElectronRestart = (filename) => {
  if (stopped || !filename?.endsWith(".cjs")) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopped) return;
    if (!electron) {
      spawnElectron();
      return;
    }
    restartRequested = true;
    electron.kill("SIGTERM");
  }, 120);
};

const waitForVite = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4178");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Vite did not become ready on 127.0.0.1:4178");
};

void waitForVite().then(() => {
  electronWatcher = fs.watch(path.join(root, "electron"), (_eventType, filename) => {
    scheduleElectronRestart(filename?.toString());
  });
  spawnElectron();
}).catch((error) => {
  console.error(error);
  stop();
  process.exitCode = 1;
});

vite.once("exit", (code) => {
  if (!stopped && code !== 0) {
    console.error(`Vite exited with code ${code}`);
    stop();
    process.exitCode = code ?? 1;
  }
});

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
