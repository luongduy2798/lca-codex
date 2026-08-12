import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const launcherRelativePath = "launcher/package.json";
const launcherPackagePath = resolve(root, launcherRelativePath);

function git(args: string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || `git ${args.join(" ")} failed\n`);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const stagedRootPackage = JSON.parse(git(["show", ":package.json"]));
const workingRootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const stagedVersion = stagedRootPackage.version;
const workingVersion = workingRootPackage.version;

if (typeof stagedVersion !== "string" || !stagedVersion.trim()) {
  throw new Error("Staged root package.json has no version");
}
if (typeof workingVersion !== "string" || !workingVersion.trim()) {
  throw new Error("Working root package.json has no version");
}

const indexEntry = git(["ls-files", "-s", "--", launcherRelativePath]).trim();
if (!indexEntry) throw new Error(`${launcherRelativePath} is not tracked`);

const mode = indexEntry.match(/^(\d+)\s/)?.[1];
if (!mode) throw new Error(`Cannot determine git mode for ${launcherRelativePath}`);
const stagedLauncherPackage = JSON.parse(git(["show", `:${launcherRelativePath}`]));
const workingLauncherPackage = JSON.parse(readFileSync(launcherPackagePath, "utf8"));

if (stagedLauncherPackage.version === stagedVersion && workingLauncherPackage.version === workingVersion) {
  process.exit(0);
}

stagedLauncherPackage.version = stagedVersion;
const stagedLauncherJson = `${JSON.stringify(stagedLauncherPackage, null, 2)}\n`;
const blob = git(["hash-object", "-w", "--stdin"], stagedLauncherJson).trim();
git(["update-index", "--cacheinfo", `${mode},${blob},${launcherRelativePath}`]);

if (workingLauncherPackage.version !== workingVersion) {
  workingLauncherPackage.version = workingVersion;
  writeFileSync(launcherPackagePath, `${JSON.stringify(workingLauncherPackage, null, 2)}\n`);
}

process.stdout.write(`Synced launcher version for commit ${stagedVersion}\n`);
