const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");

const EXTENSION_PREFIX = "openai.chatgpt-";
const TARGET_FUNCTION = "function fjt(e){";
const TARGET_FUNCTIONS = [TARGET_FUNCTION, "function c8n(e){"];
const TARGET_PROOF = "codex.upsellBanner.general.title";
const PATCH_MARKER = "/* lca-codex-hide-codex-usage-upsell */";
const BACKUP_SUFFIX = ".lca-codex-usage-upsell.bak";
const PATCH_BODY = `${PATCH_MARKER}if((e?.rateLimitStatus?.rate_limit?.limit_reached===!0||e?.rateLimitStatus?.rate_limit?.allowed===!1)&&e?.rateLimitWarningThreshold==null)return null;`;

const REVIEW_BUNDLE_PATTERN = /^subagent-activity-chip-group-.*\.js$/;
const REVIEW_TARGET_PROOF = "codex.unifiedDiff.reviewChangedFiles";
const REVIEW_TARGET = "re=e=>{Ed(),Tc.dispatchMessage(`show-diff`,{unifiedDiff:n.unifiedDiff,conversationId:a,cwd:o??null})}";
const REVIEW_PATCH_MARKER = "/* lca-codex-review-changes-per-file */";
const REVIEW_BACKUP_SUFFIX = ".lca-codex-per-file-review.bak";
const REVIEW_REPLACEMENT = `re=e=>{Ed();${REVIEW_PATCH_MARKER}let t=n.unifiedDiff;if(e!=null){let r=d.files.findIndex(t=>t.path===e),i=t.split(/(?=^diff --git )/m);i.length===d.files.length&&r>=0&&r<i.length&&(t=i[r])}Tc.dispatchMessage(\`show-diff\`,{unifiedDiff:t,conversationId:a,cwd:o??null})}`;
const REVIEW_PROOF_DISTANCE = 30_000;

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

function reviewBundleCandidates(extensionPath) {
  const assets = path.join(extensionPath, "webview", "assets");
  let names = [];
  try {
    names = fs.readdirSync(assets);
  } catch {
    return [];
  }
  return names
    .filter((name) => REVIEW_BUNDLE_PATTERN.test(name))
    .map((name) => path.join(assets, name));
}

function hasPatchMarker(content) {
  return content.includes(PATCH_MARKER);
}

function usageTargetFunction(content) {
  const matches = TARGET_FUNCTIONS.filter((candidate) => {
    const first = content.indexOf(candidate);
    if (first === -1) return false;
    const second = content.indexOf(candidate, first + candidate.length);
    const proof = content.indexOf(TARGET_PROOF, first);
    return second === -1 && proof !== -1 && proof - first < 45_000;
  });
  return matches.length === 1 ? matches[0] : null;
}

function hasReviewPatchMarker(content) {
  return content.includes(REVIEW_PATCH_MARKER);
}

function reviewTargetAvailable(content) {
  const first = content.indexOf(REVIEW_TARGET);
  if (first === -1) return false;
  const second = content.indexOf(REVIEW_TARGET, first + REVIEW_TARGET.length);
  const proof = content.indexOf(REVIEW_TARGET_PROOF, first);
  return second === -1 && proof !== -1 && proof - first < REVIEW_PROOF_DISTANCE;
}

function replaceFileAtomicPreservingMode(filePath, content) {
  const mode = fs.statSync(filePath).mode & 0o777;
  const temporary = `${filePath}.lca-codex-tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    renameAtomicFile(temporary, filePath);
    try { fs.chmodSync(filePath, mode); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function safeBackupFor(bundlePath) {
  const candidate = `${bundlePath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(candidate)) return null;
  const content = fs.readFileSync(candidate, "utf8");
  if (!hasPatchMarker(content) && usageTargetFunction(content) !== null) {
    return candidate;
  }
  return null;
}

function safeReviewBackupFor(bundlePath) {
  const candidate = `${bundlePath}${REVIEW_BACKUP_SUFFIX}`;
  if (!fs.existsSync(candidate)) return null;
  const content = fs.readFileSync(candidate, "utf8");
  if (!hasReviewPatchMarker(content) && reviewTargetAvailable(content)) return candidate;
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
      if (usageTargetFunction(content) !== null) {
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
    const targetFunction = usageTargetFunction(content);
    if (!targetFunction) throw new Error("Codex usage-limit upsell renderer signature changed before patching");
    const backupPath = `${status.bundlePath}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(status.bundlePath, backupPath, fs.constants.COPYFILE_EXCL);
    const patched = content.replace(targetFunction, `${targetFunction}${PATCH_BODY}`);
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

  reset() {
    const before = this.inspect();
    const restored = before.state === "applied" ? this.restore() : { ...before, mutated: false };
    const bundlePath = restored.bundlePath ?? before.bundlePath;
    const backupPath = bundlePath ? safeBackupFor(bundlePath) : null;
    if (backupPath) fs.rmSync(backupPath, { force: true });
    if (backupPath) this.logger.info("codex.ui_usage_upsell_backup_removed", { version: restored.version });
    return { ...restored, backupAvailable: false, mutated: restored.mutated || Boolean(backupPath) };
  }
}

class CodexPerFileReviewPatcher {
  constructor({ extensionRoots, home = os.homedir(), logger } = {}) {
    this.extensionRoots = extensionRoots ?? defaultExtensionRoots(home);
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
  }

  inspect() {
    const extension = extensionCandidates(this.extensionRoots)[0];
    if (!extension) {
      return { state: "not-found", version: null, extensionPath: null, bundlePath: null, backupAvailable: false };
    }
    const bundles = reviewBundleCandidates(extension.extensionPath);
    for (const bundlePath of bundles) {
      let content;
      try {
        content = fs.readFileSync(bundlePath, "utf8");
      } catch {
        continue;
      }
      if (hasReviewPatchMarker(content)) {
        return {
          state: "applied",
          version: extension.version,
          extensionPath: extension.extensionPath,
          bundlePath,
          backupAvailable: safeReviewBackupFor(bundlePath) !== null,
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
      if (reviewTargetAvailable(content)) {
        return {
          state: "available",
          version: extension.version,
          extensionPath: extension.extensionPath,
          bundlePath,
          backupAvailable: safeReviewBackupFor(bundlePath) !== null,
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
    if (!reviewTargetAvailable(content)) throw new Error("Codex per-file review signature changed before patching");
    const backupPath = `${status.bundlePath}${REVIEW_BACKUP_SUFFIX}`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(status.bundlePath, backupPath, fs.constants.COPYFILE_EXCL);
    const patched = content.replace(REVIEW_TARGET, REVIEW_REPLACEMENT);
    if (patched === content || !patched.includes(REVIEW_PATCH_MARKER)) {
      throw new Error("Codex per-file review patch could not be applied safely");
    }
    replaceFileAtomicPreservingMode(status.bundlePath, patched);
    const next = this.inspect();
    if (next.state !== "applied") throw new Error("Codex per-file review patch did not verify after writing");
    this.logger.info("codex.ui_per_file_review_enabled", { version: next.version });
    return { ...next, mutated: true };
  }

  restore() {
    const status = this.inspect();
    if (status.state !== "applied") return { ...status, mutated: false };
    const backupPath = safeReviewBackupFor(status.bundlePath);
    if (!backupPath) {
      throw new Error("Codex per-file review patch cannot be restored because its clean backup is missing");
    }
    replaceFileAtomicPreservingMode(status.bundlePath, fs.readFileSync(backupPath, "utf8"));
    const next = this.inspect();
    if (next.state === "applied") throw new Error("Codex per-file review patch remained active after restore");
    this.logger.info("codex.ui_per_file_review_restored", { version: status.version });
    return { ...next, mutated: true };
  }

  reset() {
    const before = this.inspect();
    const restored = before.state === "applied" ? this.restore() : { ...before, mutated: false };
    const bundlePath = restored.bundlePath ?? before.bundlePath;
    const backupPath = bundlePath ? safeReviewBackupFor(bundlePath) : null;
    if (backupPath) fs.rmSync(backupPath, { force: true });
    if (backupPath) this.logger.info("codex.ui_per_file_review_backup_removed", { version: restored.version });
    return { ...restored, backupAvailable: false, mutated: restored.mutated || Boolean(backupPath) };
  }
}

module.exports = {
  BACKUP_SUFFIX,
  CodexPerFileReviewPatcher,
  CodexUsageUpsellPatcher,
  PATCH_MARKER,
  REVIEW_BACKUP_SUFFIX,
  REVIEW_PATCH_MARKER,
  REVIEW_TARGET,
  REVIEW_TARGET_PROOF,
  TARGET_FUNCTION,
  TARGET_FUNCTIONS,
  TARGET_PROOF,
  defaultExtensionRoots,
};
