import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginBootstrapChromeArgs,
  browserLoginBootstrapRoot,
  browserLoginStateExists,
  defaultBrowserLoginExportPath,
  exportBrowserLoginState,
  loginVerificationMarkerPath,
} from "../src/browser-login";
import {
  assertAuthenticatedChatGptPage,
  assertManagedChromeDisplayAvailable,
  chatGptHeadlessChromeArgs,
  chatGptManagedChromeArgs,
} from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("browser auth module has no interactive remote-login transport", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  expect(source).not.toContain("/frame");
  expect(source).not.toContain('spawn("Xvfb"');
  expect(source).not.toContain("xvfb-run");
  expect(source).not.toContain("RemoteBrowserLoginReady");
  expect(source).not.toContain("LCA_TOKEN_AUTH_PUBLIC_URL");
  expect(source).not.toContain("connectOverCDP");
  expect(source).not.toContain("--remote-debugging-port");
});

test("interactive login waits for terminal confirmation before LCA Token closes Chrome", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  const confirmation = source.indexOf("await waitForLoginCompletion()");
  const terminate = source.indexOf("await terminateInteractiveChrome(child)", confirmation);
  expect(confirmation).toBeGreaterThan(-1);
  expect(terminate).toBeGreaterThan(confirmation);
});

test("interactive login process shutdown cannot miss an already-fired exit event", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  expect(source).toContain("if (childHasExited(child)) return Promise.resolve()");
  expect(source).toContain("if (!await waitForChildExitWithin(child, 5_000))");
});

test("interactive login inspects the closed bootstrap profile and verifies portable state before saving it", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  const interactive = source.indexOf("await runInteractiveLoginChrome(config, userDataDir, options.waitForLoginCompletion)");
  const inspect = source.indexOf("const captured = await inspectBootstrapProfile(config, userDataDir)", interactive);
  const verify = source.indexOf("const inspected = await inspectStoredState(config, captured.storageState)", inspect);
  const save = source.indexOf("atomicWriteFile(config.storageStatePath", verify);
  expect(interactive).toBeGreaterThan(-1);
  expect(inspect).toBeGreaterThan(interactive);
  expect(verify).toBeGreaterThan(inspect);
  expect(save).toBeGreaterThan(verify);
});

test("interactive auth and portable-state verification both use normal headed Chrome", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  expect(source).toContain("const captured = await inspectBootstrapProfile(config, userDataDir)");
  expect(source).toContain("const inspected = await inspectStoredState(config, captured.storageState)");
  expect(source).toContain("const inspected = await inspectStoredState(config, state)");
  expect(source).toContain("headless: false");
  expect(source).toContain("assertManagedChromeDisplayAvailable()");
  expect(source).toContain("args: chatGptManagedChromeArgs(false)");
  expect(source).toContain('["--profile-directory=Default", ...chatGptManagedChromeArgs(false)]');
  expect(chatGptHeadlessChromeArgs()).toEqual([
    "--no-first-run",
    "--no-default-browser-check",
  ]);
  expect(chatGptManagedChromeArgs(false)).toEqual([
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=-10000,-10000",
    "--window-size=1440,1000",
  ]);
  expect(chatGptManagedChromeArgs(true)).toEqual([
    "--no-first-run",
    "--no-default-browser-check",
  ]);
});

test("headed managed Chrome requires DISPLAY only on Linux", () => {
  expect(() => assertManagedChromeDisplayAvailable("darwin", undefined)).not.toThrow();
  expect(() => assertManagedChromeDisplayAvailable("linux", ":99")).not.toThrow();
  expect(() => assertManagedChromeDisplayAvailable("linux", undefined)).toThrow("xvfb-run -a make serve");
});

test("authentication verification tolerates transient composer replacement during ChatGPT hydration", async () => {
  const visibility = [true, false, true, true];
  const page = {
    locator: () => ({
      count: async () => 1,
      nth: () => ({
        isVisible: async () => visibility.shift() ?? true,
      }),
    }),
    waitForTimeout: async () => {},
  } as unknown as Parameters<typeof assertAuthenticatedChatGptPage>[0];

  await expect(assertAuthenticatedChatGptPage(page, 1_000)).resolves.toBeUndefined();
});

test("login verification waits through composer hydration in both profile and portable-state checks", () => {
  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  expect(source).toContain("await assertAuthenticatedChatGptPage(verificationPage, 30_000)");
  expect(source).toContain("await assertAuthenticatedChatGptPage(verifierPage, 60_000)");
});

test("interactive login bootstrap uses a dedicated LCA Token Chrome profile", () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-login-bootstrap-"));
  try {
    const config = defaultConfig();
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const bootstrapRoot = browserLoginBootstrapRoot(config);
    expect(bootstrapRoot).toBe(join(root, "browser", "login-bootstrap"));
    const isolatedProfile = join(bootstrapRoot, "session-test");
    const args = browserLoginBootstrapChromeArgs(isolatedProfile);
    expect(args).toContain(`--user-data-dir=${isolatedProfile}`);
    expect(args).toContain("--profile-directory=Default");
    expect(args.some(arg => arg.includes("remote-debugging"))).toBe(false);
    expect(args.at(-1)).toContain("chatgpt.com");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "lca-codex-login-state-"));
  try {
    const config = defaultConfig();
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth export defaults to a private path under the profile browser directory", () => {
  const root = mkdtempSync(join(tmpdir(), "lca-token-login-export-"));
  try {
    const config = defaultConfig();
    config.storageStatePath = join(root, "browser", "storage-state.json");
    mkdirSync(join(root, "browser"), { recursive: true });
    writeFileSync(config.storageStatePath, "{\"cookies\":[],\"origins\":[]}\n", { mode: 0o600 });
    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-08-24T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );

    const destination = exportBrowserLoginState(config);

    expect(destination).toBe(defaultBrowserLoginExportPath(config));
    expect(destination).toBe(join(root, "browser", "exports", "chatgpt-storage-state.json"));
    expect(readFileSync(destination, "utf8")).toBe("{\"cookies\":[],\"origins\":[]}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
