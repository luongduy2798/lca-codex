import { readdirSync } from "node:fs";
import { join } from "node:path";

const legacyProductTests = new Set(["codex-integration.test.ts"]);

const testDir = join(import.meta.dir, "..", "tests");
const tests = readdirSync(testDir)
  .filter(name => name.endsWith(".test.ts") && !legacyProductTests.has(name))
  .sort()
  .map(name => join(testDir, name));

const child = Bun.spawn([process.execPath, "test", ...tests], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

process.exitCode = await child.exited;
