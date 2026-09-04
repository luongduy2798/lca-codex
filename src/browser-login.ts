import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertChatGptPageMode,
  CHATGPT_NORMAL_CHAT_URL,
  detectChatGptEffortLevelCount,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  effortLevelCount: number;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  effortLevelCount?: number;
  proAvailable?: boolean;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(storageStatePath: string, effortLevelCount: number): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    effortLevelCount,
    proAvailable: effortLevelCount >= 5,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<{ effortLevelCount: number; url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_NORMAL_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertChatGptPageMode(verifierPage, "normal");
      return { effortLevelCount: await detectChatGptEffortLevelCount(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ effortLevelCount: number; proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected.effortLevelCount);
  return { effortLevelCount: inspected.effortLevelCount, proAvailable: inspected.effortLevelCount >= 5 };
}

export function storedBrowserLoginCapabilities(config: AppConfig): { effortLevelCount?: number; proAvailable?: boolean } {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    if (Number.isInteger(marker.effortLevelCount) && marker.effortLevelCount! > 0) {
      return { effortLevelCount: marker.effortLevelCount, proAvailable: marker.effortLevelCount! >= 5 };
    }
    if (typeof marker.proAvailable === "boolean") {
      const effortLevelCount = marker.proAvailable ? 5 : 3;
      return { effortLevelCount, proAvailable: marker.proAvailable };
    }
    return {};
  } catch {
    return {};
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_NORMAL_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_NORMAL_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
      page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
    ).first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    } catch {
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertChatGptPageMode(page, "normal");
    const state = await context.storageState();

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected.effortLevelCount);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      effortLevelCount: inspected.effortLevelCount,
      proAvailable: inspected.effortLevelCount >= 5,
    };
  } finally {
    await context.close();
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
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
