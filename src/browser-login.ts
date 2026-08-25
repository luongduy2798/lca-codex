import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertManagedChromeDisplayAvailable,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  chatGptManagedChromeArgs,
  detectChatGptProCapability,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  proAvailable: boolean;
}

export interface BrowserLoginBootstrapOptions {
  waitForLoginCompletion: () => Promise<void>;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  proAvailable?: boolean;
}

interface CapturedBrowserLogin {
  storageState: NonNullable<BrowserContextOptions["storageState"]>;
  proAvailable: boolean;
  url: string;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(storageStatePath: string, proAvailable: boolean): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    proAvailable,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<{ proAvailable: boolean; url: string }> {
  assertManagedChromeDisplayAvailable();
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: chatGptManagedChromeArgs(false),
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage, 60_000);
      await assertTemporaryChatPage(verifierPage);
      return { proAvailable: await detectChatGptProCapability(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export function browserLoginBootstrapRoot(config: AppConfig): string {
  return join(dirname(config.storageStatePath), "login-bootstrap");
}

export function browserLoginBootstrapChromeArgs(userDataDir: string): string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    CHATGPT_TEMPORARY_CHAT_URL,
  ];
}

async function detectLoginProCapability(page: Parameters<typeof detectChatGptProCapability>[0]): Promise<boolean> {
  return await Promise.race([
    detectChatGptProCapability(page).catch(() => false),
    delay(5_000, false),
  ]);
}

async function inspectBootstrapProfile(config: AppConfig, userDataDir: string): Promise<CapturedBrowserLogin> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--profile-directory=Default", ...chatGptManagedChromeArgs(false)],
  });
  try {
    const verificationPage = context.pages()[0] ?? await context.newPage();
    await verificationPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await assertAuthenticatedChatGptPage(verificationPage, 30_000);
    await assertTemporaryChatPage(verificationPage);
    return {
      storageState: await context.storageState(),
      proAvailable: await detectLoginProCapability(verificationPage),
      url: verificationPage.url(),
    };
  } finally {
    await context.close();
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise(resolve => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    if (childHasExited(child)) {
      child.off("exit", onExit);
      resolve();
    }
  });
}

async function waitForChildExitWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  return await Promise.race([
    waitForChildExit(child).then(() => true),
    delay(timeoutMs, false),
  ]);
}

async function terminateInteractiveChrome(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExitWithin(child, 5_000)) return;
  if (!childHasExited(child)) child.kill("SIGKILL");
  if (!await waitForChildExitWithin(child, 5_000)) {
    throw new Error("Dedicated Chrome login window did not exit after termination");
  }
}

async function runInteractiveLoginChrome(
  config: AppConfig,
  userDataDir: string,
  waitForLoginCompletion: () => Promise<void>,
): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  }
  const args = browserLoginBootstrapChromeArgs(userDataDir);
  const child = spawn(config.chromeExecutablePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => {
    if (stderr.length >= 8_192) return;
    stderr += chunk.toString("utf8").slice(0, 8_192 - stderr.length);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  try {
    await waitForLoginCompletion();
  } finally {
    await terminateInteractiveChrome(child);
  }

  if (child.exitCode !== null && child.exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(`Interactive Chrome closed unexpectedly (exit ${child.exitCode})${detail ? `: ${detail}` : ""}`);
  }
}

export async function bootstrapBrowserLogin(
  config: AppConfig,
  options: BrowserLoginBootstrapOptions,
): Promise<BrowserLoginResult> {
  const root = browserLoginBootstrapRoot(config);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* Windows ACLs are managed by the OS. */ }
  const userDataDir = mkdtempSync(join(root, "session-"));
  try { chmodSync(userDataDir, 0o700); } catch { /* Windows ACLs are managed by the OS. */ }
  try {
    await runInteractiveLoginChrome(config, userDataDir, options.waitForLoginCompletion);
    const captured = await inspectBootstrapProfile(config, userDataDir);
    // Portable-state verification deliberately uses the same normal Chrome renderer as inference.
    // On Linux servers that renderer belongs inside Xvfb; no alternate browser mode is attempted.
    const inspected = await inspectStoredState(config, captured.storageState);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(captured.storageState)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: inspected.url,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
  return { proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(config: AppConfig): { proAvailable?: boolean } {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {};
  } catch {
    return {};
  }
}

export async function importBrowserLoginState(config: AppConfig, sourcePath: string): Promise<BrowserLoginResult> {
  if (!existsSync(sourcePath)) throw new Error(`ChatGPT storage-state file does not exist: ${sourcePath}`);
  let state: NonNullable<BrowserContextOptions["storageState"]>;
  try {
    state = JSON.parse(readFileSync(sourcePath, "utf8")) as NonNullable<BrowserContextOptions["storageState"]>;
  } catch (error) {
    throw new Error(`ChatGPT storage-state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("ChatGPT storage-state file must contain a Playwright storage-state object");
  }
  const inspected = await inspectStoredState(config, state);
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
  return {
    storageStatePath: config.storageStatePath,
    accountSurfaceUrl: inspected.url,
    proAvailable: inspected.proAvailable,
  };
}

export function defaultBrowserLoginExportPath(config: AppConfig): string {
  return join(dirname(config.storageStatePath), "exports", "chatgpt-storage-state.json");
}

export function exportBrowserLoginState(
  config: AppConfig,
  destinationPath = defaultBrowserLoginExportPath(config),
): string {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const state = readFileSync(config.storageStatePath);
  atomicWriteFile(destinationPath, state);
  return destinationPath;
}

export function logoutBrowserLogin(config: AppConfig): void {
  rmSync(config.storageStatePath, { force: true });
  rmSync(loginVerificationMarkerPath(config.storageStatePath), { force: true });
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
