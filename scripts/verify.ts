import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "lca-token-verify-"));
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
  LCA_TOKEN_HOME: verificationLcaHome,
  LCA_TOKEN_PROFILE: "verify",
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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
