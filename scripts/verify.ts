import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "lca-codex-verify-"));
const runtimeBundle = join(scratch, "runtime");
const verificationHome = join(scratch, "home");
const verificationLcaHome = join(scratch, "lca");
const verificationCodexHome = join(scratch, "codex");
mkdirSync(verificationHome, { recursive: true });
mkdirSync(verificationLcaHome, { recursive: true });
mkdirSync(verificationCodexHome, { recursive: true });

const verificationEnv = {
  ...process.env,
  HOME: verificationHome,
  USERPROFILE: verificationHome,
  LCA_CODEX_HOME: verificationLcaHome,
  CODEX_HOME: verificationCodexHome,
};

async function run(args: string[], isolateRuntimeState = false): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: isolateRuntimeState ? verificationEnv : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "typecheck"]);
  await run(["run", "test"], true);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"], true);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
