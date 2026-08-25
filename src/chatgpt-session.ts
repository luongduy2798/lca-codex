import type { Locator, Page } from "playwright-core";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_BACKGROUND_WINDOW_ARGS = [
  "--window-position=-10000,-10000",
  "--window-size=1440,1000",
] as const;

export function chatGptHeadlessChromeArgs(): string[] {
  return [
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export function chatGptManagedChromeArgs(showWindow = false): string[] {
  return [
    ...chatGptHeadlessChromeArgs(),
    ...(showWindow ? [] : CHATGPT_BACKGROUND_WINDOW_ARGS),
  ];
}

export function assertManagedChromeDisplayAvailable(
  platform = process.platform,
  display = process.env.DISPLAY,
): void {
  if (platform !== "linux" || display?.trim()) return;
  throw new Error(
    "Managed ChatGPT Chrome runs headed on Linux and requires a display. "
    + "Run LCA Token under Xvfb (for example `xvfb-run -a make serve`) or provide DISPLAY.",
  );
}

export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = 'button[aria-haspopup="menu"][data-tone="neutral"]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[role="slider"][aria-valuenow][aria-valuemax]';
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  `[data-testid="composer-intelligence-picker-content"]:has(${CHATGPT_EFFORT_SLIDER_SELECTOR})`,
  `[role="menu"]:has(${CHATGPT_EFFORT_SLIDER_SELECTOR})`,
  `[role="group"]:has(${CHATGPT_EFFORT_SLIDER_SELECTOR})`,
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"])',
  '[role="menu"]:has([role="menuitemradio"])',
  '[role="group"]:has([role="menuitemradio"])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(", ");

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page, timeoutMs = 10_000): Promise<void> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  do {
    if (await anyVisible(composer)) {
      // ChatGPT hydrates the composer in more than one DOM pass. A visible editor can be
      // replaced immediately after Playwright observes it, which made login verification
      // fail even though the authenticated composer reappeared a moment later. Require the
      // evidence to survive one short follow-up sample, but keep the check fail-closed.
      await page.waitForTimeout(100);
      if (await anyVisible(composer)) return;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptProCapability(page: Page): Promise<boolean> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  await effortButton.waitFor({ state: "visible", timeout: 30_000 });
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.click();
  try {
    await menu.waitFor({ state: "visible", timeout: 70_000 });
    const slider = menu.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).last();
    if (await slider.isVisible().catch(() => false)) {
      const min = Number(await slider.getAttribute("aria-valuemin") ?? "0");
      const max = Number(await slider.getAttribute("aria-valuemax"));
      if (Number.isFinite(min) && Number.isFinite(max)) return max - min + 1 >= 5;
    }
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    return await efforts.count() >= 5;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
