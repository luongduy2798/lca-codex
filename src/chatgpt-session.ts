import type { Locator, Page } from "playwright-core";

export type ChatGptChatMode = "normal" | "temporary";

export const CHATGPT_NORMAL_CHAT_URL = "https://chatgpt.com/";
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export function chatGptUrlForMode(mode: ChatGptChatMode): string {
  return mode === "temporary" ? CHATGPT_TEMPORARY_CHAT_URL : CHATGPT_NORMAL_CHAT_URL;
}

export function isChatGptPageMode(urlValue: string, mode: ChatGptChatMode): boolean {
  try {
    const url = new URL(urlValue);
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/") return false;
    const temporary = url.searchParams.get("temporary-chat") === "true";
    return mode === "temporary" ? temporary : !temporary;
  } catch {
    return false;
  }
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
].join(", ");
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

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertChatGptPageMode(page: Page, mode: ChatGptChatMode): Promise<void> {
  if (!isChatGptPageMode(page.url(), mode)) {
    throw new Error(`ChatGPT left the requested ${mode} chat surface (${page.url()})`);
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  await assertChatGptPageMode(page, "temporary");
}

export async function detectChatGptEffortLevelCount(page: Page): Promise<number> {
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
    await slider.waitFor({ state: "visible", timeout: 10_000 });
    const min = Number(await slider.getAttribute("aria-valuemin") ?? "0");
    const max = Number(await slider.getAttribute("aria-valuemax"));
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`ChatGPT effort slider exposed an invalid range (${min}-${max})`);
    }
    return max - min + 1;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function detectChatGptProCapability(page: Page): Promise<boolean> {
  return await detectChatGptEffortLevelCount(page) >= 5;
}
