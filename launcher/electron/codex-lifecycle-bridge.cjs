const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const STATE_VERSION = 1;
const SETTING_KEY = "chatgpt.cliExecutable";

function resolveHome(value) {
  return path.resolve(value || process.env.LCA_CODEX_HOME?.trim() || path.join(os.homedir(), ".lca-codex"));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function bridgePaths({ coreHome, platform = process.platform } = {}) {
  const home = resolveHome(coreHome);
  const binDir = path.join(home, "bin");
  return {
    home,
    binDir,
    proxyScript: path.join(binDir, "codex-cli-proxy.cjs"),
    proxyExecutable: path.join(binDir, platform === "win32" ? "lca-codex-proxy.cmd" : "lca-codex-proxy"),
    statePath: path.join(home, "runtime", "codex-lifecycle-bridge.json"),
  };
}

function vscodeSettingsCandidates({ homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  if (platform === "darwin") {
    return [
      { id: "vscode", label: "VS Code", path: path.join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"), extensionRoot: path.join(homeDir, ".vscode", "extensions") },
    ];
  }
  if (platform === "win32") {
    const root = appData || path.join(homeDir, "AppData", "Roaming");
    return [
      { id: "vscode", label: "VS Code", path: path.join(root, "Code", "User", "settings.json"), extensionRoot: path.join(homeDir, ".vscode", "extensions") },
    ];
  }
  return [
    { id: "vscode", label: "VS Code", path: path.join(homeDir, ".config", "Code", "User", "settings.json"), extensionRoot: path.join(homeDir, ".vscode", "extensions") },
  ];
}

function hasCodexExtension(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).some(entry => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"));
  } catch {
    return false;
  }
}

function skipTrivia(text, start) {
  let i = start;
  for (;;) {
    while (/\s/.test(text[i] || "")) i += 1;
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i + 2);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    return i;
  }
}

function readString(text, start) {
  if (text[start] !== '"') return null;
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') {
      const raw = text.slice(start, i + 1);
      try { return { value: JSON.parse(raw), end: i + 1 }; } catch { return null; }
    }
  }
  return null;
}

function findTopLevelProperty(text, key) {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i + 2);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text[i] === '"') {
      const string = readString(text, i);
      if (!string) return null;
      if (depth === 1 && string.value === key) {
        const colon = skipTrivia(text, string.end);
        if (text[colon] !== ":") return null;
        const valueStart = skipTrivia(text, colon + 1);
        let cursor = valueStart;
        let nested = 0;
        let inString = false;
        let escaped = false;
        while (cursor < text.length) {
          const char = text[cursor];
          if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            cursor += 1;
            continue;
          }
          if (text.startsWith("//", cursor)) {
            const newline = text.indexOf("\n", cursor + 2);
            cursor = newline < 0 ? text.length : newline + 1;
            continue;
          }
          if (text.startsWith("/*", cursor)) {
            const end = text.indexOf("*/", cursor + 2);
            cursor = end < 0 ? text.length : end + 2;
            continue;
          }
          if (char === '"') { inString = true; cursor += 1; continue; }
          if (char === "[" || char === "{") nested += 1;
          else if (char === "]" || char === "}") {
            if (nested === 0) break;
            nested -= 1;
          } else if (char === "," && nested === 0) break;
          cursor += 1;
        }
        return { keyStart: i, valueStart, valueEnd: cursor };
      }
      i = string.end;
      continue;
    }
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    i += 1;
  }
  return null;
}

function readCliSetting(content) {
  const found = findTopLevelProperty(content, SETTING_KEY);
  if (!found) return undefined;
  const raw = content.slice(found.valueStart, found.valueEnd).trim();
  if (raw === "null") return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function setCliSetting(content, value) {
  const normalized = content.trim() ? content : "{}\n";
  const found = findTopLevelProperty(normalized, SETTING_KEY);
  const encoded = value === null ? "null" : JSON.stringify(value);
  if (found) return `${normalized.slice(0, found.valueStart)}${encoded}${normalized.slice(found.valueEnd)}`;
  const close = normalized.lastIndexOf("}");
  if (close < 0) throw new Error("VS Code settings must contain a top-level JSON object");
  const before = normalized.slice(0, close);
  const significant = before.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trimEnd();
  const comma = significant.endsWith("{") || significant.endsWith(",") ? "" : ",";
  const indent = before.includes("\n") ? "  " : "";
  const prefix = before.endsWith("\n") ? "" : "\n";
  return `${before}${comma}${prefix}${indent}${JSON.stringify(SETTING_KEY)}: ${encoded}\n${normalized.slice(close)}`;
}

function removeCliSetting(content) {
  const found = findTopLevelProperty(content, SETTING_KEY);
  if (!found) return content;
  let start = found.keyStart;
  while (start > 0 && /[ \t]/.test(content[start - 1])) start -= 1;
  let end = found.valueEnd;
  while (/[ \t]/.test(content[end] || "")) end += 1;
  if (content[end] === ",") {
    end += 1;
    while (/[ \t]/.test(content[end] || "")) end += 1;
  }
  if (content[end] === "\r" && content[end + 1] === "\n") end += 2;
  else if (content[end] === "\n") end += 1;
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function readState(statePath) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return value?.version === STATE_VERSION ? value : null;
  } catch {
    return null;
  }
}

function hashFile(pathname) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"); } catch { return null; }
}

function bridgeStatus({ coreHome, proxySourcePath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const paths = bridgePaths({ coreHome, platform });
  const persistedState = readState(paths.statePath);
  const configuredClients = new Set(
    Array.isArray(persistedState?.configuredClients) ? persistedState.configuredClients : [],
  );
  const errors = [];
  const expectedHash = proxySourcePath ? hashFile(proxySourcePath) : null;
  const scriptHash = hashFile(paths.proxyScript);
  const installed = Boolean(scriptHash && (!expectedHash || scriptHash === expectedHash) && fs.existsSync(paths.proxyExecutable));
  const clients = vscodeSettingsCandidates({ homeDir, platform, appData }).map(candidate => {
    const detected = hasCodexExtension(candidate.extensionRoot) || fs.existsSync(candidate.path);
    let current;
    let error = null;
    if (fs.existsSync(candidate.path)) {
      try { current = readCliSetting(fs.readFileSync(candidate.path, "utf8")); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    }
    if (error) errors.push(`${candidate.label}: ${error}`);
    return { id: candidate.id, label: candidate.label, detected, configured: current === paths.proxyExecutable, settingsPath: candidate.path };
  });
  const vscode = clients[0];
  const configured = vscode?.configured === true;
  const managed = Boolean(vscode?.settingsPath && configuredClients.has(vscode.settingsPath));
  const state = errors.length > 0
    ? "inconsistent"
    : installed && configured
      ? "configured"
      : installed
        ? "installed"
        : "not-configured";
  return {
    state,
    installed,
    configured,
    managed,
    vscodeDetected: vscode?.detected === true,
    proxyPath: paths.proxyExecutable,
    settingsPath: vscode?.settingsPath || "",
    errors,
    reloadRequired: configured,
  };
}

function setupBridge({ coreHome, proxySourcePath, electronExecutable = process.execPath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA, configureSettings = true } = {}) {
  if (!proxySourcePath || !fs.existsSync(proxySourcePath)) throw new Error("Codex lifecycle proxy source is missing");
  const paths = bridgePaths({ coreHome, platform });
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(paths.proxyScript, fs.readFileSync(proxySourcePath));
  if (platform !== "win32") fs.chmodSync(paths.proxyScript, 0o755);
  const wrapper = platform === "win32"
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronExecutable}" "${paths.proxyScript}" %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(electronExecutable)} ${shellQuote(paths.proxyScript)} "$@"\n`;
  writePrivateFileAtomic(paths.proxyExecutable, wrapper);
  if (platform !== "win32") fs.chmodSync(paths.proxyExecutable, 0o755);

  const existingState = readState(paths.statePath);
  const previousValues = { ...(existingState?.previousValues || {}) };
  const configuredClients = new Set(
    Array.isArray(existingState?.configuredClients) ? existingState.configuredClients : [],
  );
  if (configureSettings) {
    for (const candidate of vscodeSettingsCandidates({ homeDir, platform, appData })) {
      if (!hasCodexExtension(candidate.extensionRoot) && !fs.existsSync(candidate.path)) continue;
      let content = "{}\n";
      if (fs.existsSync(candidate.path)) content = fs.readFileSync(candidate.path, "utf8");
      if (!(candidate.path in previousValues)) {
        const previous = readCliSetting(content);
        previousValues[candidate.path] = previous === paths.proxyExecutable
          ? { present: false, value: null, migratedLegacyProxy: true }
          : { present: previous !== undefined, value: previous ?? null };
      }
      const next = setCliSetting(content, paths.proxyExecutable);
      if (next !== content) {
        fs.mkdirSync(path.dirname(candidate.path), { recursive: true });
        writePrivateFileAtomic(candidate.path, next);
      }
      configuredClients.add(candidate.path);
    }
  }
  writePrivateFileAtomic(paths.statePath, JSON.stringify({
    version: STATE_VERSION,
    installedAt: new Date().toISOString(),
    proxyHash: hashFile(proxySourcePath),
    previousValues,
    configuredClients: [...configuredClients],
  }, null, 2) + "\n");
  return bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData });
}

function repairBridge({ coreHome, proxySourcePath, electronExecutable = process.execPath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const status = bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData });
  if (status.installed || (!status.configured && !status.managed)) return { ...status, repaired: false };
  const repaired = setupBridge({
    coreHome,
    proxySourcePath,
    electronExecutable,
    homeDir,
    platform,
    appData,
    configureSettings: false,
  });
  return { ...repaired, repaired: true };
}

function normalizePreviousValue(previous) {
  return previous && typeof previous === "object"
    ? previous
    : { present: true, value: previous };
}

function previousValueMatches(current, previous) {
  const record = normalizePreviousValue(previous);
  if (record.present === false) return current === undefined;
  return current === (typeof record.value === "string" ? record.value : null);
}

function suspendBridge({ coreHome, proxySourcePath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const paths = bridgePaths({ coreHome, platform });
  const state = readState(paths.statePath);
  const previousValues = { ...(state?.previousValues || {}) };
  const configuredClients = new Set(Array.isArray(state?.configuredClients) ? state.configuredClients : []);
  const writes = [];
  let stateChanged = false;
  let changed = false;
  for (const candidate of vscodeSettingsCandidates({ homeDir, platform, appData })) {
    if (!fs.existsSync(candidate.path)) continue;
    const content = fs.readFileSync(candidate.path, "utf8");
    if (readCliSetting(content) !== paths.proxyExecutable) continue;
    if (!configuredClients.has(candidate.path)) {
      configuredClients.add(candidate.path);
      stateChanged = true;
    }
    if (!Object.prototype.hasOwnProperty.call(previousValues, candidate.path)) {
      previousValues[candidate.path] = { present: false, value: null, migratedLegacyProxy: true };
      stateChanged = true;
    }
    const previous = normalizePreviousValue(previousValues[candidate.path]);
    const next = previous.present === false
      ? removeCliSetting(content)
      : setCliSetting(content, typeof previous.value === "string" ? previous.value : null);
    if (next !== content) writes.push({ path: candidate.path, content: next });
  }
  if (stateChanged) {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(paths.statePath, JSON.stringify({
      version: STATE_VERSION,
      installedAt: state?.installedAt || new Date().toISOString(),
      proxyHash: state?.proxyHash || hashFile(proxySourcePath),
      previousValues,
      configuredClients: [...configuredClients],
    }, null, 2) + "\n");
  }
  for (const write of writes) {
    writePrivateFileAtomic(write.path, write.content);
    changed = true;
  }
  const status = bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData });
  return { ...status, changed, reloadRequired: changed || status.reloadRequired };
}

function resumeBridge({ coreHome, proxySourcePath, electronExecutable = process.execPath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const paths = bridgePaths({ coreHome, platform });
  let state = readState(paths.statePath);
  const configuredClients = new Set(Array.isArray(state?.configuredClients) ? state.configuredClients : []);
  if (configuredClients.size === 0) {
    return { ...bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData }), changed: false };
  }
  const repaired = repairBridge({
    coreHome,
    proxySourcePath,
    electronExecutable,
    homeDir,
    platform,
    appData,
  });
  if (!repaired.installed) throw new Error("The managed Codex lifecycle proxy is not installed");
  state = readState(paths.statePath);
  const writes = [];
  for (const candidate of vscodeSettingsCandidates({ homeDir, platform, appData })) {
    if (!configuredClients.has(candidate.path)) continue;
    const content = fs.existsSync(candidate.path) ? fs.readFileSync(candidate.path, "utf8") : "{}\n";
    const current = readCliSetting(content);
    if (current === paths.proxyExecutable) continue;
    if (!Object.prototype.hasOwnProperty.call(state?.previousValues || {}, candidate.path)) {
      throw new Error(`${candidate.label} managed chatgpt.cliExecutable baseline is missing`);
    }
    const previous = state?.previousValues?.[candidate.path];
    if (!previousValueMatches(current, previous)) {
      throw new Error(`${candidate.label} chatgpt.cliExecutable changed while LCA Codex was stopped; refusing to overwrite it`);
    }
    writes.push({ path: candidate.path, content: setCliSetting(content, paths.proxyExecutable) });
  }
  for (const write of writes) {
    fs.mkdirSync(path.dirname(write.path), { recursive: true });
    writePrivateFileAtomic(write.path, write.content);
  }
  const status = bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData });
  return { ...status, changed: writes.length > 0, reloadRequired: writes.length > 0 || status.reloadRequired };
}

function removeBridge({ coreHome, proxySourcePath, homeDir = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const paths = bridgePaths({ coreHome, platform });
  const state = readState(paths.statePath);
  const restoredSettings = new Set();
  if (state?.previousValues && typeof state.previousValues === "object") {
    for (const [settingsPath, previous] of Object.entries(state.previousValues)) {
      if (!fs.existsSync(settingsPath)) continue;
      const content = fs.readFileSync(settingsPath, "utf8");
      const record = previous && typeof previous === "object" ? previous : { present: true, value: previous };
      const next = record.present === false
        ? removeCliSetting(content)
        : setCliSetting(content, typeof record.value === "string" ? record.value : null);
      if (next !== content) writePrivateFileAtomic(settingsPath, next);
      restoredSettings.add(settingsPath);
    }
  }
  for (const candidate of vscodeSettingsCandidates({ homeDir, platform, appData })) {
    if (restoredSettings.has(candidate.path) || !fs.existsSync(candidate.path)) continue;
    const content = fs.readFileSync(candidate.path, "utf8");
    if (readCliSetting(content) === paths.proxyExecutable) {
      writePrivateFileAtomic(candidate.path, removeCliSetting(content));
    }
  }
  fs.rmSync(paths.proxyExecutable, { force: true });
  fs.rmSync(paths.proxyScript, { force: true });
  fs.rmSync(paths.statePath, { force: true });
  return bridgeStatus({ coreHome, proxySourcePath, homeDir, platform, appData });
}

module.exports = {
  SETTING_KEY,
  bridgePaths,
  bridgeStatus,
  readCliSetting,
  removeBridge,
  removeCliSetting,
  repairBridge,
  resumeBridge,
  setCliSetting,
  setupBridge,
  suspendBridge,
  vscodeSettingsCandidates,
};
