const fs = require("node:fs");
const path = require("node:path");

function syncLauncherVersion(repositoryRoot = path.resolve(__dirname, "..", "..")) {
  const rootPackagePath = path.join(repositoryRoot, "package.json");
  const launcherPackagePath = path.join(repositoryRoot, "launcher", "package.json");
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  const launcherPackage = JSON.parse(fs.readFileSync(launcherPackagePath, "utf8"));
  const version = rootPackage.version;

  if (typeof version !== "string" || !version.trim()) {
    throw new Error("Root package.json has no version");
  }
  if (launcherPackage.version === version) return version;

  launcherPackage.version = version;
  fs.writeFileSync(launcherPackagePath, `${JSON.stringify(launcherPackage, null, 2)}\n`);
  process.stdout.write(`Synced launcher version to ${version}\n`);
  return version;
}

if (require.main === module) syncLauncherVersion();

module.exports = { syncLauncherVersion };
