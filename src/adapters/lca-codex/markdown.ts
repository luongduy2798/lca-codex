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

export interface ChatGptMarkdownRoot {
  key: string;
  html: string;
  /** True only when this root is a complete renderer-owned Markdown block. */
  streamable?: boolean;
}

interface CachedChatGptMarkdownRoot extends ChatGptMarkdownRoot {
  markdown: string;
}

interface ChatGptStableBlockOptions {
  stabilityMs: number;
  tailGuardRoots: number;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function suffixPrefixOverlapLength(left: string, right: string, minimum = 32, maximum = 8_192): number {
  const limit = Math.min(left.length, right.length, maximum);
  if (limit < minimum) return 0;
  const pattern = right.slice(0, limit);
  const text = left.slice(-limit);
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length;) {
    if (pattern[index] === pattern[matched]) {
      prefix[index++] = ++matched;
    } else if (matched > 0) {
      matched = prefix[matched - 1]!;
    } else {
      prefix[index++] = 0;
    }
  }
  let matched = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    while (matched > 0 && pattern[matched] !== char) matched = prefix[matched - 1]!;
    if (pattern[matched] === char) matched += 1;
    if (matched === pattern.length && index < text.length - 1) {
      // A full match before the text ends cannot be the final suffix; continue with its fallback.
      matched = prefix[matched - 1]!;
    }
  }
  return matched >= minimum ? matched : 0;
}

function hasMovableTrailingMarkdownClosure(markdown: string): boolean {
  return /(?:\*{1,3}|_{1,3}|~{2}|`{1,3}|\]\([^\n)]*\))$/.test(markdown);
}

function mergeBufferedMarkdownSnapshot(previous: string, current: string): string {
  if (!current) return previous;
  if (!previous || current.startsWith(previous)) return current;
  if (previous.startsWith(current)) return previous;
  const overlap = suffixPrefixOverlapLength(previous, current);
  return overlap > 0 ? `${previous}${current.slice(overlap)}` : current;
}

/**
 * Mirrors the Markdown currently visible in ChatGPT into an append-only Codex stream.
 *
 * In the default mode every poll serializes the whole visible answer and appends the common prefix
 * shared by consecutive snapshots. The one exception is an unchanged snapshot ending in synthetic
 * Markdown closure (`**`, backticks, link destination, etc.): a temporarily stalled formatted DOM
 * node can grow again *before* that closure. Committing the closure during the stall would make the
 * later snapshot incompatible with the append-only Responses stream, so it waits for either real
 * growth or explicit completion evidence.
 *
 * completionOnly() keeps those speculative prefixes internal because ChatGPT can replace its flat
 * streaming DOM with structured Markdown at completion. stableBlocks() is the production middle
 * ground: it emits only unchanged, renderer-owned blocks while retaining the active tail locally.
 */
export class ChatGptMarkdownBuffer {
  private previousSnapshot = "";
  private latestSnapshot = "";
  private bufferedSnapshot = "";
  private emitted = "";
  private finished = false;
  private rootCache = new Map<string, CachedChatGptMarkdownRoot>();
  private rootCandidates = new Map<string, { html: string; streamable: boolean; since: number }>();

  constructor(
    private readonly serializeHtml: (html: string) => string = chatGptHtmlToMarkdown,
    private readonly streamStablePrefixes = true,
    private readonly stableBlockOptions?: ChatGptStableBlockOptions,
  ) {}

  static completionOnly(
    serializeHtml: (html: string) => string = chatGptHtmlToMarkdown,
  ): ChatGptMarkdownBuffer {
    return new ChatGptMarkdownBuffer(serializeHtml, false);
  }

  static stableBlocks(
    stabilityMs: number,
    tailGuardRoots = 2,
    serializeHtml: (html: string) => string = chatGptHtmlToMarkdown,
  ): ChatGptMarkdownBuffer {
    return new ChatGptMarkdownBuffer(serializeHtml, true, {
      stabilityMs,
      tailGuardRoots: Math.max(1, tailGuardRoots),
    });
  }

  /**
   * Serialize only final-answer roots whose HTML changed since the previous poll. The cache contains
   * current roots only, so retained DOM/Markdown state stays bounded even if ChatGPT replaces roots.
   */
  observeRoots(roots: ChatGptMarkdownRoot[], now = Date.now()): string {
    const nextCache = new Map<string, CachedChatGptMarkdownRoot>();
    const markdownRoots: CachedChatGptMarkdownRoot[] = [];
    for (const root of roots) {
      const cached = this.rootCache.get(root.key);
      const markdown = cached?.html === root.html ? cached.markdown : this.serializeHtml(root.html);
      const serialized = { ...root, markdown };
      nextCache.set(root.key, serialized);
      if (markdown) markdownRoots.push(serialized);
    }
    this.rootCache = nextCache;
    const stablePrefixLength = this.stableBlockOptions
      ? this.stableBlockPrefixLength(markdownRoots, now)
      : undefined;
    return this.observeMarkdown(
      markdownRoots.map(root => root.markdown).join("\n\n"),
      stablePrefixLength,
    );
  }

  /** Flush everything currently visible without declaring the browser turn final. */
  flush(): { markdown: string; delta: string } {
    if (this.finished) return { markdown: this.emitted, delta: "" };
    if (!this.latestSnapshot.startsWith(this.emitted)) return { markdown: this.emitted, delta: "" };
    const delta = this.latestSnapshot.slice(this.emitted.length);
    this.emitted = this.latestSnapshot;
    return { markdown: this.emitted, delta };
  }

  finish(): { markdown: string; delta: string } {
    if (this.finished) return { markdown: this.emitted, delta: "" };
    let delta = "";
    if (this.latestSnapshot.startsWith(this.emitted)) {
      delta = this.latestSnapshot.slice(this.emitted.length);
    } else if (this.latestSnapshot !== this.emitted) {
      // Responses deltas cannot retract an already-emitted prefix. Any incompatible rewrite must
      // therefore be surfaced intact as a correction. Slicing at the old raw offset can splice two
      // different answers together and silently produce content that never existed in the browser.
      delta = this.emitted ? `\n\n${this.latestSnapshot}` : this.latestSnapshot;
    }
    this.emitted += delta;
    this.finished = true;
    return { markdown: this.emitted, delta };
  }

  private stableBlockPrefixLength(roots: CachedChatGptMarkdownRoot[], now: number): number {
    const nextCandidates = new Map<string, { html: string; streamable: boolean; since: number }>();
    for (const root of roots) {
      const previous = this.rootCandidates.get(root.key);
      const streamable = root.streamable === true;
      nextCandidates.set(root.key, {
        html: root.html,
        streamable,
        since: previous?.html === root.html && previous.streamable === streamable
          ? previous.since
          : now,
      });
    }
    this.rootCandidates = nextCandidates;

    const safeRootCount = Math.max(0, roots.length - this.stableBlockOptions!.tailGuardRoots);
    let stableLength = 0;
    for (let index = 0; index < safeRootCount; index += 1) {
      const root = roots[index]!;
      const candidate = nextCandidates.get(root.key)!;
      if (root.streamable !== true
        || now - candidate.since < this.stableBlockOptions!.stabilityMs) {
        break;
      }
      if (stableLength > 0) stableLength += 2;
      stableLength += root.markdown.length;
    }
    return stableLength;
  }

  private observeMarkdown(visibleCurrent: string, maximumStableLength?: number): string {
    if (this.finished) return "";
    this.bufferedSnapshot = mergeBufferedMarkdownSnapshot(this.bufferedSnapshot, visibleCurrent);
    if (!this.streamStablePrefixes) {
      this.latestSnapshot = this.bufferedSnapshot;
      this.previousSnapshot = visibleCurrent;
      return "";
    }
    let current = visibleCurrent;
    if (!current.startsWith(this.emitted) && this.emitted) {
      // Long ChatGPT answers may virtualize older DOM and leave only a visible suffix. Reconstruct
      // the append-only snapshot from a substantial emitted-suffix/current-prefix overlap instead
      // of treating this as a rewrite. A true incompatible rewrite still pauses and is handled once.
      const overlap = suffixPrefixOverlapLength(this.emitted, current);
      if (overlap > 0) current = `${this.emitted}${current.slice(overlap)}`;
    }
    if (!current.startsWith(this.emitted)) {
      // Do not replace the last compatible snapshot with a pure prefix shrink. Any other
      // incompatible shape is a real renderer rewrite, even when its Markdown happens to be
      // shorter, and must become the authoritative completion candidate.
      if (!this.emitted.startsWith(current)) this.latestSnapshot = current;
      this.previousSnapshot = current;
      return "";
    }
    this.latestSnapshot = current;
    const commonStableLength = commonPrefixLength(this.previousSnapshot, current);
    const stableLength = maximumStableLength === undefined
      ? current === this.previousSnapshot && hasMovableTrailingMarkdownClosure(current)
        ? this.emitted.length
        : commonStableLength
      : Math.min(commonStableLength, maximumStableLength);
    if (stableLength < this.emitted.length) {
      this.previousSnapshot = current;
      return "";
    }
    const delta = current.slice(this.emitted.length, stableLength);
    if (delta) this.emitted += delta;
    this.previousSnapshot = current;
    return delta;
  }
}
