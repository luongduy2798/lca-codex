const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const EXTENSION_PREFIX = "openai.chatgpt-";
const TARGET_FUNCTION = "function fjt(e){";
const TARGET_PROOF = "codex.upsellBanner.general.title";
const PATCH_MARKER = "/* lca-token-hide-codex-usage-upsell */";
const LEGACY_PATCH_MARKER = "/* lca-hide-rate-limit-upsell */";
const BACKUP_SUFFIX = ".lca-token-usage-upsell.bak";
const LEGACY_BACKUP_SUFFIXES = [".lca-token-rate-limit-bak", ".lca-rate-limit.bak"];
const PATCH_BODY = `${PATCH_MARKER}if((e?.rateLimitStatus?.rate_limit?.limit_reached===!0||e?.rateLimitStatus?.rate_limit?.allowed===!1)&&e?.rateLimitWarningThreshold==null)return null;`;

function versionParts(version) {
  return String(version ?? "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
}

function compareVersionsDescending(left, right) {
  const a = versionParts(left.version);
  const b = versionParts(right.version);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return right.modifiedAt - left.modifiedAt;
}

function defaultExtensionRoots(home = os.homedir()) {
  const roots = [];
  const explicit = process.env.VSCODE_EXTENSIONS?.trim();
  if (explicit) roots.push(...explicit.split(path.delimiter).filter(Boolean));
  roots.push(
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
  );
  return [...new Set(roots.map((entry) => path.resolve(entry)))];
}

function readExtensionVersion(extensionPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {}
  const name = path.basename(extensionPath);
  return name.startsWith(EXTENSION_PREFIX) ? name.slice(EXTENSION_PREFIX.length).split("-")[0] : "unknown";
}

function extensionCandidates(roots) {
  const candidates = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(EXTENSION_PREFIX)) continue;
      const extensionPath = path.join(root, name);
      let stat;
      try {
        stat = fs.statSync(extensionPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      candidates.push({
        extensionPath,
        version: readExtensionVersion(extensionPath),
        modifiedAt: stat.mtimeMs,
      });
    }
  }
  return candidates.sort(compareVersionsDescending);
}

function bundleCandidates(extensionPath) {
  const assets = path.join(extensionPath, "webview", "assets");
  let names = [];
  try {
    names = fs.readdirSync(assets);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^app-initial-.*\.js$/.test(name))
    .map((name) => path.join(assets, name));
}

function hasPatchMarker(content) {
  return content.includes(PATCH_MARKER) || content.includes(LEGACY_PATCH_MARKER);
}

function replaceFileAtomicPreservingMode(filePath, content) {
  const mode = fs.statSync(filePath).mode & 0o777;
  const temporary = `${filePath}.lca-token-tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    renameAtomicFile(temporary, filePath);
    try { fs.chmodSync(filePath, mode); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function backupCandidates(bundlePath) {
  return [
    `${bundlePath}${BACKUP_SUFFIX}`,
    ...LEGACY_BACKUP_SUFFIXES.map((suffix) => `${bundlePath}${suffix}`),
  ];
}

function safeBackupFor(bundlePath) {
  for (const candidate of backupCandidates(bundlePath)) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, "utf8");
    if (!hasPatchMarker(content) && content.includes(TARGET_FUNCTION) && content.includes(TARGET_PROOF)) {
      return candidate;
    }
  }
  return null;
}

class CodexUsageUpsellPatcher {
  constructor({ extensionRoots, home = os.homedir(), logger } = {}) {
    this.extensionRoots = extensionRoots ?? defaultExtensionRoots(home);
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
  }

  inspect() {
    const extension = extensionCandidates(this.extensionRoots)[0];
    if (!extension) {
      return { state: "not-found", version: null, extensionPath: null, bundlePath: null, backupAvailable: false };
    }
    const bundles = bundleCandidates(extension.extensionPath);
    for (const bundlePath of bundles) {
      let content;
      try {
        content = fs.readFileSync(bundlePath, "utf8");
      } catch {
        continue;
      }
      if (hasPatchMarker(content)) {
        return {
          state: "applied",
          version: extension.version,
          extensionPath: extension.extensionPath,
          bundlePath,
          backupAvailable: safeBackupFor(bundlePath) !== null,
        };
      }
    }
    for (const bundlePath of bundles) {
      let content;
      try {
        content = fs.readFileSync(bundlePath, "utf8");
      } catch {
        continue;
      }
      const first = content.indexOf(TARGET_FUNCTION);
      const second = first === -1 ? -1 : content.indexOf(TARGET_FUNCTION, first + TARGET_FUNCTION.length);
      const proof = first === -1 ? -1 : content.indexOf(TARGET_PROOF, first);
      if (first !== -1 && second === -1 && proof !== -1 && proof - first < 45_000) {
        return {
          state: "available",
          version: extension.version,
          extensionPath: extension.extensionPath,
          bundlePath,
          backupAvailable: safeBackupFor(bundlePath) !== null,
        };
      }
    }
    return {
      state: "unsupported",
      version: extension.version,
      extensionPath: extension.extensionPath,
      bundlePath: bundles[0] ?? null,
      backupAvailable: false,
    };
  }

  apply() {
    const status = this.inspect();
    if (status.state !== "available") return { ...status, mutated: false };
    const content = fs.readFileSync(status.bundlePath, "utf8");
    const backupPath = `${status.bundlePath}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(status.bundlePath, backupPath, fs.constants.COPYFILE_EXCL);
    const patched = content.replace(TARGET_FUNCTION, `${TARGET_FUNCTION}${PATCH_BODY}`);
    if (patched === content || !patched.includes(PATCH_MARKER)) {
      throw new Error("Codex usage-limit upsell patch could not be applied safely");
    }
    replaceFileAtomicPreservingMode(status.bundlePath, patched);
    const next = this.inspect();
    if (next.state !== "applied") throw new Error("Codex usage-limit upsell patch did not verify after writing");
    this.logger.info("codex.ui_usage_upsell_hidden", { version: next.version });
    return { ...next, mutated: true };
  }

  restore() {
    const status = this.inspect();
    if (status.state !== "applied") return { ...status, mutated: false };
    const backupPath = safeBackupFor(status.bundlePath);
    if (!backupPath) {
      throw new Error("Codex usage-limit upsell patch cannot be restored because its clean backup is missing");
    }
    replaceFileAtomicPreservingMode(status.bundlePath, fs.readFileSync(backupPath, "utf8"));
    const next = this.inspect();
    if (next.state === "applied") throw new Error("Codex usage-limit upsell patch remained active after restore");
    this.logger.info("codex.ui_usage_upsell_restored", { version: status.version });
    return { ...next, mutated: true };
  }
}

module.exports = {
  BACKUP_SUFFIX,
  CodexUsageUpsellPatcher,
  LEGACY_PATCH_MARKER,
  PATCH_MARKER,
  TARGET_FUNCTION,
  TARGET_PROOF,
  defaultExtensionRoots,
};
