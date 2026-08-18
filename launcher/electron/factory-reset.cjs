const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FACTORY_RESET_CLEANUP_ARG = "--factory-reset-cleanup";
const FACTORY_RESET_HIDDEN_ARG = "--hidden";
const LCA_OWNED_PATH_NAMES = new Set([".lca-codex", "lca-codex", "lca codex"]);

function hasLcaOwnedPathSegment(target) {
  const root = path.parse(target).root;
  return target
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)
    .some((part) => LCA_OWNED_PATH_NAMES.has(part.toLowerCase()));
}

function assertSafeResetPath(target) {
  if (typeof target !== "string" || !target.trim()) throw new Error("Factory reset path is empty");
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  if (resolved === root || resolved === home || !hasLcaOwnedPathSegment(resolved)) {
    throw new Error(`Refusing to factory-reset unsafe path: ${resolved}`);
  }
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync.native(resolved);
    const realRoot = path.parse(real).root;
    if (real === realRoot || real === home || !hasLcaOwnedPathSegment(real)) {
      throw new Error(`Refusing to factory-reset unsafe real path: ${real}`);
    }
  }
  return resolved;
}

function cleanupFactoryResetPaths(paths) {
  const targets = [...new Set(paths.filter(Boolean).map(assertSafeResetPath))];
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
  return targets;
}

function factoryResetRelaunchArgs(argv = process.argv) {
  return [
    ...argv.slice(1).filter((arg) => (
      arg !== FACTORY_RESET_CLEANUP_ARG && arg !== FACTORY_RESET_HIDDEN_ARG
    )),
    FACTORY_RESET_CLEANUP_ARG,
  ];
}

module.exports = {
  FACTORY_RESET_CLEANUP_ARG,
  assertSafeResetPath,
  cleanupFactoryResetPaths,
  factoryResetRelaunchArgs,
};
