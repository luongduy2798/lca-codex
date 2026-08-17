import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
  preformattedCode: true,
});
turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});

function chatGptBlockCode(node: Node): HTMLElement | null {
  if (node.nodeName === "CODE") {
    const code = node as HTMLElement;
    const className = code.getAttribute("class") ?? "";
    if (/(?:^|\s)(?:language-[^\s]+|whitespace-pre!?)(?:\s|$)/.test(className)
      || code.hasAttribute("data-language")) {
      return code;
    }
    return null;
  }
  const code = (node as HTMLElement).querySelector?.("code") ?? null;
  return code ? chatGptBlockCode(code) : null;
}

function chatGptCodeMirrorSource(node: Node): HTMLElement | null {
  const element = node as HTMLElement;
  if (element.matches?.('[role="textbox"][aria-label="Edit code"]')) return element;
  return element.querySelector?.('[role="textbox"][aria-label="Edit code"]') ?? null;
}

function chatGptCodeSourceText(source: HTMLElement): string {
  if (source.matches('[role="textbox"][aria-label="Edit code"]')) {
    const lines = Array.from(source.children)
      .filter(child => child.classList.contains("cm-line"));
    if (lines.length > 0) return lines.map(line => line.textContent ?? "").join("\n");
  }
  return source.textContent ?? "";
}

function chatGptCodeWrapper(code: HTMLElement): HTMLElement | null {
  for (let parent = code.parentElement; parent; parent = parent.parentElement) {
    if (parent.nodeName === "PRE") return null;
    if (parent.nodeName !== "DIV") continue;

    const codeChild = Array.from(parent.children).find(child => child.contains(code));
    if (!codeChild) continue;
    if (Array.from(parent.children).some(child => child !== codeChild && child.querySelector("button"))) {
      return parent;
    }
  }
  return null;
}

function fencedCodeBlock(source: HTMLElement, owner: HTMLElement, options: TurndownService.Options): string {
  const className = source.getAttribute("class") ?? "";
  const classLanguage = className.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const language = (
    source.getAttribute("data-language")
    ?? owner.getAttribute("data-language")
    ?? classLanguage
    ?? ""
  ).trim().split(/\s+/, 1)[0]!.replace(/[^A-Za-z0-9_+#.-]/g, "");
  const value = chatGptCodeSourceText(source);
  const fenceChar = options.fence?.charAt(0) || "`";
  const fencePattern = new RegExp(`^${fenceChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}{3,}`, "gm");
  let fenceSize = 3;
  for (const match of value.matchAll(fencePattern)) {
    fenceSize = Math.max(fenceSize, match[0].length + 1);
  }
  const fence = fenceChar.repeat(fenceSize);
  return `\n\n${fence}${language}\n${value.replace(/\n$/, "")}\n${fence}\n\n`;
}

turndown.addRule("chatGptFencedCodeBlock", {
  filter: node => node.nodeName === "PRE"
    && Boolean(node.querySelector("code") || chatGptCodeMirrorSource(node)),
  replacement: (_content, node, options) => {
    const pre = node as HTMLElement;
    const source = pre.querySelector("code") ?? chatGptCodeMirrorSource(pre);
    if (!source) return "";

    // ChatGPT wraps code in extra header/control DOM inside <pre>. Older renderers use <code>;
    // current renderers use a read-only CodeMirror textbox with one .cm-line per source line.
    // Treat the entire <pre> as one code block so labels such as "TypeScript"/"Copy" never become
    // prose and source text is never passed through Turndown's Markdown escaping.
    return fencedCodeBlock(source, pre, options);
  },
});
turndown.addRule("chatGptDivWrappedCodeBlock", {
  filter: node => {
    if (node.nodeName !== "DIV") return false;
    const div = node as HTMLElement;
    const code = chatGptBlockCode(div);
    if (!code || code.closest("pre")) return false;

    // Current ChatGPT code blocks are often a <div> shell with a language/header row and a
    // Copy/menu button, followed by a block-like <code>. There is no <pre>, so Turndown otherwise
    // serializes the language label as prose and treats the source as inline code.
    return chatGptCodeWrapper(code) === div;
  },
  replacement: (_content, node, options) => {
    const div = node as HTMLElement;
    const code = chatGptBlockCode(div);
    return code ? fencedCodeBlock(code, div, options) : "";
  },
});
turndown.addRule("chatGptStandaloneBlockCode", {
  filter: node => node.nodeName === "CODE"
    && !node.parentElement?.closest("pre")
    && Boolean(chatGptBlockCode(node)),
  replacement: (_content, node, options) => fencedCodeBlock(node as HTMLElement, node as HTMLElement, options),
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

export function chatGptHtmlToMarkdown(html: string): string {
  return html.trim() ? turndown.turndown(html).trim() : "";
}

export interface ChatGptMarkdownSegment {
  key: string;
  html: string;
  text: string;
  group?: string;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  text: string;
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. The browser supplies semantic blocks and marks a block streamable
 * only after a following block exists. Each completed block must then remain byte-stable for the
 * configured window. Once committed, presentation-only HTML rewrites are harmless; changing its
 * visible text is an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<number, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now(), allowCommit = true): string {
    this.assertCommittedPrefix(segments);
    this.latest = segments.map(segment => ({ ...segment }));

    for (let index = this.committed.length; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const previous = this.candidates.get(index);
      const unchanged = previous
        && previous.key === segment.key
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group;
      this.candidates.set(index, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const index of this.candidates.keys()) {
      if (index >= segments.length) this.candidates.delete(index);
    }

    if (!allowCommit) return "";

    let delta = "";
    while (this.committed.length < segments.length) {
      const index = this.committed.length;
      const candidate = this.candidates.get(index);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push({ key: candidate.key, text: candidate.text });
      this.candidates.delete(index);
    }
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    this.assertCommittedPrefix(this.latest);
    let delta = "";
    for (let index = this.committed.length; index < this.latest.length; index += 1) {
      const segment = this.latest[index]!;
      delta += this.commit(segment);
      this.committed.push({ key: segment.key, text: segment.text });
    }
    this.candidates.clear();
    return { markdown: this.markdown, delta };
  }

  private assertCommittedPrefix(segments: ChatGptMarkdownSegment[]): void {
    if (segments.length < this.committed.length) {
      throw new Error("ChatGPT removed a completed text block that was already streamed to Codex");
    }
    for (let index = 0; index < this.committed.length; index += 1) {
      const previous = this.committed[index]!;
      const current = segments[index]!;
      if (current.key !== previous.key || current.text !== previous.text) {
        throw new Error("ChatGPT changed a completed text block that was already streamed to Codex");
      }
    }
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
