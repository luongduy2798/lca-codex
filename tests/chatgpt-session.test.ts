import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_NORMAL_CHAT_URL,
  CHATGPT_TEMPORARY_CHAT_URL,
  ensureChatGptPersonalized,
} from "../src/chatgpt-session";
import { ChatGptBrowserWorker, resolveBrowserConfig } from "../src/adapters/lca-codex/browser-worker";
import { resolveBrowserRetryPolicy } from "../src/adapters/lca-codex/retry-policy";

function personalizationPage(options: {
  initial?: "Personalized" | "Unpersonalized";
  labels?: [string, string];
  controls?: number;
  menuId?: string | null;
  optionCount?: number;
  selectionWorks?: boolean;
  radioState?: "missing" | "conflicting";
} = {}) {
  let state = options.initial ?? "Unpersonalized";
  let url = CHATGPT_TEMPORARY_CHAT_URL;
  let open = false;
  const clicks: string[] = [];
  const navigations: string[] = [];
  const menuId = options.menuId === undefined ? "personalization-menu" : options.menuId;
  const controls = options.controls ?? 1;
  const locator = (kind: string, index = 0, condition?: string) => {
    const checked = () => options.radioState === "missing" ? null
      : options.radioState === "conflicting" ? "true"
      : String(index === (state === "Personalized" ? 0 : 1));
    const count = () => {
      if (condition === '[aria-expanded="true"][aria-controls]' && (!open || !menuId)) return 0;
      if (condition === '[aria-expanded="false"]' && open) return 0;
      if (condition === '[aria-checked="true"]' && checked() !== "true") return 0;
      if (kind === "control") return controls;
      if (kind === "composer") return 1;
      if (!open) return 0;
      if (kind === "menu") return 1;
      if (kind === "items") return options.optionCount ?? 2;
      if (kind === "item") return index < (options.optionCount ?? 2) ? 1 : 0;
      return 0;
    };
    const result = {
      selector: kind,
      count: async () => count(),
      isVisible: async () => count() > 0,
      waitFor: async () => { if (count() !== 1) throw new Error("Missing or ambiguous locator"); },
      filter: () => result,
      and: (other: { selector: string }) => locator(kind, index, other.selector),
      last: () => result,
      first: () => kind === "items" ? locator("item", 0) : result,
      nth: (position: number) => kind === "items" ? locator("item", position) : result,
      getAttribute: async (name: string) => {
        if (name === "aria-label") return (options.labels ?? ["Personalized", "Unpersonalized"])[state === "Personalized" ? 0 : 1];
        if (name === "aria-checked") return checked();
        if (name === "aria-expanded") return String(open);
        if (name === "aria-controls") return menuId;
        return null;
      },
      getByRole: (role: string) => {
        expect(kind).toBe("menu");
        expect(role).toBe("menuitemradio");
        return locator("items");
      },
      click: async () => {
        if (count() !== 1) throw new Error("Ambiguous click");
        clicks.push(kind === "item" ? `item-${index}` : kind);
        if (kind === "control") open = true;
        if (kind === "item") {
          if (options.selectionWorks !== false) state = index === 0 ? "Personalized" : "Unpersonalized";
          open = false;
        }
      },
    };
    return result;
  };
  const page = {
    url: () => url,
    goto: async (next: string) => { navigations.push(next); url = next; },
    keyboard: { press: async (key: string) => { expect(key).toBe("Escape"); open = false; } },
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return locator("composer");
      if (selector === '[role="dialog"]') return locator("empty");
      if (selector.startsWith("[aria-")) return locator(selector);
      if (selector === '#conversation-header-actions button[aria-haspopup="menu"]:visible') return locator("control");
      expect(selector).toBe('[role="menu"][id="personalization-menu"]:visible');
      return locator("menu");
    },
  } as unknown as Page;
  return { page, clicks, navigations, state: () => state };
}

test("remembered first-item selection is inspected without reselecting it", async () => {
  for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
    const fixture = personalizationPage({ initial: "Personalized" });
    await ensureChatGptPersonalized(fixture.page);
    await ensureChatGptPersonalized(fixture.page);
    expect(fixture.clicks).toEqual(["control", "control"]);
  }
});

test("personalization selects item zero and verifies radio state regardless of translated labels", async () => {
  for (const labels of [["Personalized", "Unpersonalized"], ["Cá nhân hóa", "Không cá nhân hóa"], ["個人化", "非個人化"]] as [string, string][]) {
    const fixture = personalizationPage({ labels });
    await ensureChatGptPersonalized(fixture.page);
    expect(fixture.state()).toBe("Personalized");
    expect(fixture.clicks).toEqual(["control", "item-0", "control"]);
    await ensureChatGptPersonalized(fixture.page);
    expect(fixture.clicks).toEqual(["control", "item-0", "control", "control"]);
  }
});

test("missing, ambiguous, or ineffective personalization UI fails without browser retry", async () => {
  for (const options of [
    { controls: 0 }, { controls: 2 }, { menuId: null },
    { optionCount: 0 }, { optionCount: 1 }, { optionCount: 3 }, { selectionWorks: false },
    { radioState: "missing" as const }, { radioState: "conflicting" as const },
  ]) {
    const fixture = personalizationPage(options);
    const error = await ensureChatGptPersonalized(fixture.page).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("select Normal Chat in Settings");
    expect(resolveBrowserRetryPolicy(error, false).browserGenerationAllowed).toBe(false);
    expect(fixture.navigations).toEqual([]);
  }
});

test("browser configuration defaults to Temporary while preserving explicit Normal and rejecting invalid input", () => {
  const provider = { adapter: "lca-codex" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).chatMode).toBe("temporary");
  expect(resolveBrowserConfig({ ...provider, lcaCodex: { chatMode: "normal" } }).chatMode).toBe("normal");
  expect(() => resolveBrowserConfig({
    ...provider, lcaCodex: { chatMode: "auto" as "normal" },
  })).toThrow("Unsupported ChatGPT chat mode");
});

const verifyConnector = (ChatGptBrowserWorker.prototype as unknown as {
  verifyConnectorExclusive(): Promise<string>;
}).verifyConnectorExclusive;

test("worker verification respects both modes and confirms Personalized before selecting the connector", async () => {
  for (const chatMode of ["temporary", "normal"] as const) {
    const fixture = personalizationPage();
    let selected = false;
    const result = await verifyConnector.call({
      config: { chatMode, appName: "test-connector" },
      ensurePage: async () => fixture.page,
      activeComposer: async () => {},
      selectConnector: async () => {
        if (chatMode === "temporary") expect(fixture.state()).toBe("Personalized");
        selected = true;
      },
    });
    expect(result).toBe("test-connector");
    expect(selected).toBe(true);
    expect(fixture.navigations).toEqual(chatMode === "normal" ? [CHATGPT_NORMAL_CHAT_URL] : []);
    expect(fixture.clicks).toEqual(chatMode === "normal" ? [] : ["control", "item-0", "control"]);
  }
});

test("failed Temporary verification neither selects a connector nor navigates to Normal", async () => {
  const fixture = personalizationPage({ selectionWorks: false });
  let selected = false;
  await expect(verifyConnector.call({
    config: { chatMode: "temporary", appName: "test-connector" },
    ensurePage: async () => fixture.page,
    activeComposer: async () => {},
    selectConnector: async () => { selected = true; },
  })).rejects.toThrow("Personalized was not confirmed");
  expect(selected).toBe(false);
  expect(fixture.navigations).toEqual([]);
});

test("all browser task turns verify personalization before effort selection and prompt attachment", () => {
  const source = readFileSync(new URL("../src/adapters/lca-codex/browser-worker.ts", import.meta.url), "utf8");
  const turnSource = source.slice(source.indexOf("private async runBrowserTurn("));
  expect(turnSource).toMatch(/await assertChatGptPageMode\(page, chatMode\);\s*if \(chatMode === "temporary"\) await ensureChatGptPersonalized\(page\);/);
  expect(turnSource.indexOf("await ensureChatGptPersonalized(page)")).toBeLessThan(turnSource.indexOf('"effort_selection"'));
  expect(turnSource.indexOf("await ensureChatGptPersonalized(page)")).toBeLessThan(turnSource.indexOf("this.attachPrompt("));
});
