import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type ReleaseKind = "current" | "patch" | "minor" | "major";

const root = resolve(import.meta.dir, "..");
const kind = process.argv[2] as ReleaseKind | undefined;
const versionFiles = ["package.json", "launcher/package.json", "src/version.ts"] as const;

if (kind !== "current" && kind !== "patch" && kind !== "minor" && kind !== "major") {
  throw new Error("Expected release kind: current, patch, minor, or major");
}

function output(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
}

function gitOutput(args: string[]): string {
  return output(["git", ...args]);
}

function gitRun(args: string[]): void {
  run(["git", ...args]);
}

function restoreVersionFiles(): void {
  gitRun(["restore", "--", ...versionFiles]);
}

const branch = gitOutput(["branch", "--show-current"]);
if (branch !== "main") throw new Error(`Releases must be created from main, not ${branch || "detached HEAD"}`);

const dirty = gitOutput(["status", "--porcelain"]);
if (dirty) throw new Error("Working tree must be clean before releasing");

const remote = gitOutput(["remote", "get-url", "origin"]);
if (!/github\.com[:/]luongduy2798\/lca-codex(?:\.git)?$/.test(remote)) {
  throw new Error(`origin must point to luongduy2798/lca-codex, received ${remote}`);
}

process.stdout.write("Syncing main and tags from origin...\n");
gitRun(["fetch", "origin", "main", "--tags"]);

const localHead = gitOutput(["rev-parse", "HEAD"]);
const remoteHead = gitOutput(["rev-parse", "origin/main"]);
if (localHead !== remoteHead) throw new Error("Local main must exactly match origin/main before releasing");

const rootPackagePath = resolve(root, "package.json");
const launcherPackagePath = resolve(root, "launcher", "package.json");
const versionSourcePath = resolve(root, "src", "version.ts");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as Record<string, unknown> & { version?: string };
const launcherPackage = JSON.parse(readFileSync(launcherPackagePath, "utf8")) as Record<string, unknown> & { version?: string };

if (launcherPackage.version !== rootPackage.version) {
  throw new Error(`Version mismatch: package.json=${rootPackage.version ?? "<missing>"}, launcher/package.json=${launcherPackage.version ?? "<missing>"}`);
}

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(rootPackage.version ?? "");
if (!match) throw new Error(`Expected a stable semver version, received ${rootPackage.version ?? "<missing>"}`);

let major = Number(match[1]);
let minor = Number(match[2]);
let patch = Number(match[3]);

if (kind === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (kind === "minor") {
  minor += 1;
  patch = 0;
} else if (kind === "patch") {
  patch += 1;
}

const nextVersion = `${major}.${minor}.${patch}`;
const tag = `v${nextVersion}`;
const tagCheck = Bun.spawnSync(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});
if (tagCheck.exitCode === 0) throw new Error(`Tag ${tag} already exists`);

if (kind !== "current") {
  rootPackage.version = nextVersion;
  launcherPackage.version = nextVersion;
  writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  writeFileSync(launcherPackagePath, `${JSON.stringify(launcherPackage, null, 2)}\n`);
  writeFileSync(versionSourcePath, `export const VERSION = ${JSON.stringify(nextVersion)};\n`);
}

process.stdout.write(`Verifying ${tag} before publishing...\n`);
try {
  run([process.execPath, "run", "verify"]);
} catch (error) {
  if (kind !== "current") restoreVersionFiles();
  throw error;
}

if (kind !== "current") {
  gitRun(["add", ...versionFiles]);
  gitRun(["commit", "-m", `release: ${tag}`]);
}
gitRun(["tag", "-a", tag, "-m", `Release ${tag}`]);

process.stdout.write(`Pushing ${tag} atomically with main...\n`);
const push = Bun.spawnSync(["git", "push", "--atomic", "origin", "main", tag], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if (push.exitCode !== 0) {
  throw new Error(`Push failed. Local release commit and tag ${tag} were kept; retry with: git push --atomic origin main ${tag}`);
}

process.stdout.write(`Release ${tag} pushed. GitHub Release workflow will build and publish the installers.\n`);
