const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BACKUP_SUFFIX,
  CodexUsageUpsellPatcher,
  LEGACY_PATCH_MARKER,
  PATCH_MARKER,
} = require("../electron/codex-ui-patch.cjs");

function fixture(version = "26.5803.41515", body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-codex-ui-"));
  const extensions = path.join(root, ".vscode", "extensions");
  const extension = path.join(extensions, `openai.chatgpt-${version}-darwin-x64`);
  const assets = path.join(extension, "webview", "assets");
  const bundle = path.join(assets, "app-initial-test.js");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(bundle, body ?? "prefix;function fjt(e){let n=e.rateLimitStatus;const x='codex.upsellBanner.general.title';return n};suffix");
  return { root, extensions, extension, bundle };
}

function patcherFor(...roots) {
  return new CodexUsageUpsellPatcher({ extensionRoots: roots, logger: { info() {}, warn() {}, error() {} } });
}

test("Codex usage-limit patch hides only the reached-limit upsell UI and restores the clean bundle", () => {
  const fx = fixture();
  try {
    const patcher = patcherFor(fx.extensions);
    assert.equal(patcher.inspect().state, "available");
    const applied = patcher.apply();
    assert.equal(applied.state, "applied");
    assert.equal(applied.mutated, true);
    const patched = fs.readFileSync(fx.bundle, "utf8");
    assert.match(patched, new RegExp(PATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(patched, /rate_limit\?\.limit_reached===!0/);
    assert.match(patched, /rateLimitWarningThreshold==null/);
    assert.match(patched, /codex\.upsellBanner\.general\.title/);
    assert.equal(fs.existsSync(`${fx.bundle}${BACKUP_SUFFIX}`), true);

    const restored = patcher.restore();
    assert.equal(restored.state, "available");
    assert.equal(restored.mutated, true);
    assert.equal(fs.readFileSync(fx.bundle, "utf8").includes(PATCH_MARKER), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex usage-limit patch fails closed when a new extension build changes the known renderer signature", () => {
  const fx = fixture("26.6000.1", "prefix;function renamed(e){return 'codex.upsellBanner.general.title'};suffix");
  try {
    const patcher = patcherFor(fx.extensions);
    const before = fs.readFileSync(fx.bundle, "utf8");
    const status = patcher.apply();
    assert.equal(status.state, "unsupported");
    assert.equal(status.mutated, false);
    assert.equal(fs.readFileSync(fx.bundle, "utf8"), before);
    assert.equal(fs.existsSync(`${fx.bundle}${BACKUP_SUFFIX}`), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex usage-limit patch targets the newest installed official extension", () => {
  const older = fixture("26.5803.1");
  const newer = fixture("26.5900.2");
  try {
    const patcher = patcherFor(older.extensions, newer.extensions);
    assert.equal(patcher.inspect().version, "26.5900.2");
    patcher.apply();
    assert.equal(fs.readFileSync(newer.bundle, "utf8").includes(PATCH_MARKER), true);
    assert.equal(fs.readFileSync(older.bundle, "utf8").includes(PATCH_MARKER), false);
  } finally {
    fs.rmSync(older.root, { recursive: true, force: true });
    fs.rmSync(newer.root, { recursive: true, force: true });
  }
});

test("existing legacy LCA Codex patch and backup are recognized and can be restored", () => {
  const original = "prefix;function fjt(e){let n=e.rateLimitStatus;const x='codex.upsellBanner.general.title';return n};suffix";
  const fx = fixture("26.5803.41515", original.replace("function fjt(e){", `function fjt(e){${LEGACY_PATCH_MARKER}if(e?.rateLimitStatus?.rate_limit?.limit_reached===!0)return null;`));
  try {
    fs.writeFileSync(`${fx.bundle}.lca-codex-rate-limit-bak`, original);
    const patcher = patcherFor(fx.extensions);
    const status = patcher.inspect();
    assert.equal(status.state, "applied");
    assert.equal(status.backupAvailable, true);
    const restored = patcher.restore();
    assert.equal(restored.state, "available");
    assert.equal(fs.readFileSync(fx.bundle, "utf8"), original);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
