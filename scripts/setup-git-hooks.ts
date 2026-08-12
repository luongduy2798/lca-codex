import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

if (!existsSync(resolve(root, ".git"))) process.exit(0);

const result = Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) process.exit(result.exitCode);
