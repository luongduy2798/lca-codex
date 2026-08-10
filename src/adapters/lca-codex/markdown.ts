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

export interface ChatGptMarkdownSegment {
  key: string;
  html: string;
  text: string;
  group?: string;
  streamable: boolean;
  /** Plain prose-like blocks may stream a guarded stable prefix before the next DOM block exists. */
  incremental?: boolean;
}

export interface ChatGptMarkdownRoot {
  key: string;
  html: string;
}

interface CachedChatGptMarkdownRoot extends ChatGptMarkdownRoot {
  markdown: string;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function replayLikeRewritePrefixLength(emitted: string, latest: string): number {
  if (latest.length < emitted.length || emitted.length < 64) return 0;
  const prefix = commonPrefixLength(emitted, latest);
  const changedTail = emitted.length - prefix;
  const toleratedTail = Math.min(256, Math.ceil(emitted.length * 0.2));
  return prefix >= 64 && changedTail <= toleratedTail ? prefix : 0;
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

function segmentsToMarkdown(segments: ChatGptMarkdownSegment[]): string {
  let markdown = "";
  let lastGroup: string | undefined;
  for (const segment of segments) {
    const block = chatGptHtmlToMarkdown(segment.html);
    if (!block) continue;
    const separator = markdown
      ? segment.group !== undefined && segment.group === lastGroup ? "\n" : "\n\n"
      : "";
    markdown += `${separator}${block}`;
    lastGroup = segment.group;
  }
  return markdown;
}

/**
 * Mirrors the Markdown currently visible in ChatGPT into an append-only Codex stream.
 *
 * There is deliberately no block-type gating. Every poll serializes the whole visible answer. The
 * common prefix shared by consecutive snapshots can be appended immediately. The one exception is
 * an unchanged snapshot ending in synthetic Markdown closure (`**`, backticks, link destination,
 * etc.): a temporarily stalled formatted DOM node can grow again *before* that closure. Committing
 * the closure during the stall would make the later snapshot incompatible with the append-only
 * Responses stream, so it waits for either real growth or explicit completion evidence.
 */
export class ChatGptMarkdownBuffer {
  private previousSnapshot = "";
  private latestSnapshot = "";
  private emitted = "";
  private finished = false;
  private rootCache = new Map<string, CachedChatGptMarkdownRoot>();

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    _legacyStabilityMs = 0,
    _legacyOptions: Record<string, number> = {},
    private readonly serializeHtml: (html: string) => string = chatGptHtmlToMarkdown,
  ) {}

  /** Legacy segment entry point retained for focused tests and callers outside the browser worker. */
  observe(segments: ChatGptMarkdownSegment[]): string {
    return this.observeMarkdown(this.transform(segmentsToMarkdown(segments)));
  }

  /** Legacy single-root entry point. Production uses observeRoots so unchanged roots stay cached. */
  observeHtml(html: string): string {
    return this.observeRoots([{ key: "root", html }]);
  }

  /**
   * Serialize only final-answer roots whose HTML changed since the previous poll. The cache contains
   * current roots only, so retained DOM/Markdown state stays bounded even if ChatGPT replaces roots.
   */
  observeRoots(roots: ChatGptMarkdownRoot[]): string {
    const nextCache = new Map<string, CachedChatGptMarkdownRoot>();
    const markdownRoots: string[] = [];
    for (const root of roots) {
      const cached = this.rootCache.get(root.key);
      const markdown = cached?.html === root.html ? cached.markdown : this.serializeHtml(root.html);
      nextCache.set(root.key, { ...root, markdown });
      if (markdown) markdownRoots.push(markdown);
    }
    this.rootCache = nextCache;
    return this.observeMarkdown(this.transform(markdownRoots.join("\n\n")));
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
      const replayPrefix = replayLikeRewritePrefixLength(this.emitted, this.latestSnapshot);
      if (replayPrefix > 0) {
        // A browser retry/render replay can replace an almost-identical answer after most of its
        // prefix was already streamed. Responses deltas cannot retract, so appending the complete
        // replacement would duplicate the whole answer. Preserve the emitted prefix and resume at
        // the same raw offset; any incompatible rewrite is intentionally confined to the small tail.
        delta = this.latestSnapshot.slice(this.emitted.length);
      } else {
        // A genuinely different late rewrite cannot replace already-emitted Responses deltas.
        // Surface it once as a correction instead of silently returning stale visible content.
        delta = this.emitted ? `\n\n${this.latestSnapshot}` : this.latestSnapshot;
      }
    }
    this.emitted += delta;
    this.finished = true;
    return { markdown: this.emitted, delta };
  }

  private observeMarkdown(visibleCurrent: string): string {
    if (this.finished) return "";
    let current = visibleCurrent;
    if (!current.startsWith(this.emitted) && this.emitted) {
      // Long ChatGPT answers may virtualize older DOM and leave only a visible suffix. Reconstruct
      // the append-only snapshot from a substantial emitted-suffix/current-prefix overlap instead
      // of treating this as a rewrite. A true incompatible rewrite still pauses and is handled once.
      const overlap = suffixPrefixOverlapLength(this.emitted, current);
      if (overlap > 0) current = `${this.emitted}${current.slice(overlap)}`;
    }
    if (!current.startsWith(this.emitted)) {
      // Do not replace the last compatible snapshot with a pure DOM shrink. If this is a real late
      // rewrite, keep it as the final candidate so finish() can append one bounded correction.
      if (current.length >= this.emitted.length) this.latestSnapshot = current;
      this.previousSnapshot = current;
      return "";
    }
    this.latestSnapshot = current;
    const stableLength = current === this.previousSnapshot && hasMovableTrailingMarkdownClosure(current)
      ? this.emitted.length
      : commonPrefixLength(this.previousSnapshot, current);
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
