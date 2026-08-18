const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncLauncherVersion } = require("../scripts/sync-version.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("the public source workflow is Electron-first without terminal lifecycle aliases", () => {
  assert.equal(repositoryManifest.scripts.app, "bun run scripts/start-launcher.ts");
  for (const removed of [
    "start",
    "setup",
    "doctor",
    "clean",
    "build",
    "smoke",
    "smoke:codex",
    "launcher",
    "launcher:dev",
  ]) {
    assert.equal(repositoryManifest.scripts[removed], undefined, `${removed} must not reintroduce a terminal-first workflow`);
  }
});

test("launcher publishes native packages for all supported desktop operating systems", () => {
  assert.equal(manifest.build.appId, "dev.lcacodex.launcher");
  assert.equal(manifest.build.productName, "LCA Codex");
  assert.equal(manifest.desktopName, "lca-codex.desktop");
  assert.equal(manifest.build.artifactName, "lca-codex-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.win.icon, "assets/icon.ico");
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.equal(manifest.build.linux.executableName, "lca-codex");
  assert.equal(manifest.build.linux.syncDesktopName, true);
  assert.ok(manifest.build.files.includes("assets/icon.png"));
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, false);
});

test("launcher version is generated from the root package version", () => {
  assert.match(manifest.scripts.dev, /^bun run sync:version && /);
  assert.match(manifest.scripts.build, /^bun run sync:version && /);
  assert.match(manifest.scripts.start, /^bun run sync:version && /);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lca-codex-version-sync-"));
  try {
    fs.mkdirSync(path.join(scratch, "launcher"));
    fs.writeFileSync(path.join(scratch, "package.json"), `${JSON.stringify({ version: "9.8.7" }, null, 2)}\n`);
    fs.writeFileSync(path.join(scratch, "launcher", "package.json"), `${JSON.stringify({ name: "launcher", version: "0.0.0" }, null, 2)}\n`);

    assert.equal(syncLauncherVersion(scratch), "9.8.7");
    const synced = JSON.parse(fs.readFileSync(path.join(scratch, "launcher", "package.json"), "utf8"));
    assert.equal(synced.version, "9.8.7");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("release installers resolve checksummed native launcher assets", () => {
  const shellInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.sh"), "utf8");
  const windowsInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.ps1"), "utf8");
  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  for (const installer of [shellInstaller, windowsInstaller]) {
    assert.match(installer, /checksums\.txt/);
    assert.match(installer, /SHA-?256/i);
    assert.match(installer, /releases\/download/);
  }
  assert.match(shellInstaller, /PLATFORM="mac"/);
  assert.match(shellInstaller, /PLATFORM="linux"/);
  assert.match(shellInstaller, /lca-codex\.desktop/);
  assert.match(shellInstaller, /--appimage-extract/);
  assert.match(shellInstaller, /ICON_SOURCE="\$EXTRACT_DIR\/squashfs-root\/\.DirIcon"/);
  assert.doesNotMatch(shellInstaller, /find .*\*\.png/);
  assert.match(shellInstaller, /Name=LCA Codex/);
  assert.match(shellInstaller, /StartupWMClass=lca-codex/);
  assert.match(packager, /-linux-x86_64\(\?=\\\.\).*?-linux-x64/);
  assert.match(packager, /process\.execPath/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /--config\.extraMetadata\.version=/);
  assert.match(packager, /target === "--mac" && !env\.CSC_LINK && !env\.CSC_NAME/);
  assert.match(packager, /--config\.mac\.identity=-/);
  assert.doesNotMatch(packager, /electron-builder\.cmd/);
  assert.match(shellInstaller, /shell_quote\(\)/);
  assert.match(shellInstaller, /exec %s "\$@"/);
  assert.ok(
    shellInstaller.indexOf('chmod 0755 "$TEMP_DIR/$ASSET"')
      < shellInstaller.indexOf('"$TEMP_DIR/$ASSET" --appimage-extract'),
    "the downloaded AppImage must be executable before it is inspected",
  );
  assert.match(windowsInstaller, /lca-codex-\$Version-win-\$Arch\.exe/);
  assert.match(windowsInstaller, /\[Environment\]::Is64BitOperatingSystem/);
  assert.doesNotMatch(windowsInstaller, /RuntimeInformation/);
  const expectedWindowsExecutable = `Programs\\${manifest.name}\\${manifest.build.productName}.exe`;
  assert.ok(
    windowsInstaller.includes(expectedWindowsExecutable),
    `the PowerShell installer must launch the NSIS executable at ${expectedWindowsExecutable}`,
  );
});

test("packaged launcher owns a detached checksummed updater for every release platform", () => {
  const updater = fs.readFileSync(path.join(launcherRoot, "electron", "update.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(launcherRoot, "electron", "update-worker.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.match(updater, new RegExp(`platform === "${platform}"`));
    assert.match(worker, new RegExp(`job\\.platform === "${platform}"`));
  }
  assert.match(updater, /expectedChecksum/);
  assert.match(updater, /SHA-256 verification failed/);
  assert.match(updater, /detached:\s*true/);
  assert.match(worker, /waitForParent/);
  assert.doesNotMatch(worker, /backup/i);
});

test("CI packages and smoke-launches on macOS, Windows, and Linux", () => {
  const ci = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /workflow_dispatch:/);
  assert.doesNotMatch(ci, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(ci, /macos-15, ubuntu-latest, windows-latest/);
  assert.match(ci, /bun run app:package/);
  assert.match(ci, /bun run app:smoke/);
  assert.match(release, /push:\s*\n\s*tags:\s*\["v\*"\]/);
  for (const runner of ["macos-15", "macos-15-intel", "ubuntu-latest", "windows-latest"]) {
    assert.match(release, new RegExp(runner));
  }
  assert.match(release, /launcher\/build\/runtime/);
  assert.match(release, /bun run app:smoke/);
  assert.match(release, /codesign --verify --deep --strict --verbose=2/);
  assert.match(release, /LCA Codex\.app/);
  assert.doesNotMatch(release, /gh release create[\s\S]*?--draft/);
});

test("packaged smoke executes the relocated runtime instead of only checking copied files", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(main, /runtimeCommand\(\["--version"\]\)/);
  assert.match(main, /runtimeVerified:\s*true/);
  assert.match(smoke, /marker\.runtimeVerified\s*!==\s*true/);
  assert.match(smoke, /launcherManifest\.name/);
  assert.match(smoke, /launcherManifest\.build\.productName/);
  assert.doesNotMatch(smoke, /"Programs",\s*"lca-codex"/);
});
