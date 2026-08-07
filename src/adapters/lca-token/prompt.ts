import { createHash } from "node:crypto";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage, CodexParsedRequest } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";
import { isOnePixelPngDataUrl, isReadableCompactionSummaryText } from "../../responses/compaction";
import { extractTrustedCodexProjectInstructions } from "./environment";
import { resolveLcaTokenModelMode, type LcaTokenCapabilities } from "./model";

export interface LcaTokenPromptImage {
  ref: string;
  imageUrl: string;
  detail?: string;
}

export type ChatGptContextTransport = "inline" | "mcp-lazy";

export interface ChatGptContextEntry {
  id: string;
  index: number;
  role: string;
  payload: Record<string, unknown>;
  searchText: string;
  attachmentRefs: string[];
}

export interface ChatGptContextAttachment extends LcaTokenPromptImage {
  messageId: string;
}

export interface ChatGptContextSnapshot {
  id: string;
  digest: string;
  /** Full accumulated context retained only for inline/read-only fallback and explicit lazy full retrieval. */
  serialized: string;
  totalChars: number;
  estimatedTextTokens: number;
  /** Historical conversation entries available to the connector on demand. */
  history: ChatGptContextEntry[];
  /** Historical image payloads. These are never attached to a fresh Temporary Chat automatically. */
  attachments: ChatGptContextAttachment[];
  /** Bounded full-context image set used only by inline/read-only fallback. */
  images: LcaTokenPromptImage[];
}

export interface CompiledLcaTokenPrompt {
  text: string;
  images: LcaTokenPromptImage[];
  transport: ChatGptContextTransport;
  contextSnapshotId?: string;
  /** Effective model-input tokens carried through MCP rather than the visible composer. */
  contextInputTokens?: number;
}

const RETIRED_TURN_HANDLE = /\b(turn|binding)_[A-Za-z0-9_-]{24,}/g;

/**
 * The accumulated Codex context replays earlier turns, including the broker handles those turns
 * held. A model that copies one binds to a finished turn and burns the round trip. The handle for
 * the current turn is supplied by the contract text, never by the replayed context.
 */
export function withoutRetiredTurnHandles(contextJson: string): string {
  return contextJson.replace(RETIRED_TURN_HANDLE, (_handle, kind: string) => `[retired ${kind} handle]`);
}

/** ChatGPT accepts at most this many attachments on one message. */
export const CHATGPT_MAX_INPUT_IMAGES = 10;

const DROPPED_IMAGE_NOTE =
  `[older image not attached: ChatGPT accepts at most ${CHATGPT_MAX_INPUT_IMAGES} per message]`;

/**
 * Every turn opens a fresh Temporary Chat, so ChatGPT keeps nothing from the previous one: an image
 * the task still reasons about has to be re-attached on each turn or it stops existing for the
 * model. Carrying the conversation's images forward is therefore the contract, not a leak - the
 * only bound is ChatGPT's per-message limit, and the overflow is dropped from the oldest end so the
 * images the task is working on survive.
 */
interface ImageBudget {
  seen: number;
  dropped: number;
}

function inputContent(
  content: string | CodexContentPart[],
  images: LcaTokenPromptImage[],
  budget: ImageBudget,
): unknown {
  if (typeof content === "string") return content;
  const semantic = content.filter(part =>
    part.type !== "image" || !isOnePixelPngDataUrl(part.imageUrl)
  );
  if (!semantic.some(part => part.type === "image")) {
    return semantic.filter(part => part.type === "text").map(part => part.text).join("\n");
  }
  return semantic.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    budget.seen += 1;
    if (budget.seen <= budget.dropped) return { type: "text", text: DROPPED_IMAGE_NOTE };
    const ref = `codex-input-image-${images.length + 1}`;
    images.push({ ref, imageUrl: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) });
    return { type: "image_attachment", attachment_ref: ref, ...(part.detail ? { detail: part.detail } : {}) };
  });
}

export function countChatGptContextImages(messages: readonly CodexMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image" && !isOnePixelPngDataUrl(part.imageUrl)) total += 1;
    }
  }
  return total;
}

function assistantContent(content: CodexAssistantContentPart[]): unknown[] {
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "thinking") return { type: "thinking_summary", text: part.thinking };
    return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
  });
}

function plainMessageText(message: CodexMessage): string | undefined {
  if (message.role === "assistant" || message.role === "toolResult") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type !== "text")) return undefined;
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function startsWithControlBlock(message: CodexMessage, tag: string): boolean {
  return message.role === "developer" && plainMessageText(message)?.trimStart().startsWith(tag) === true;
}

const CODEX_DEVELOPER_SCAFFOLD_PREFIXES = [
  "<model_switch>",
  "<skills_instructions>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<plugins_instructions>",
] as const;

/**
 * Standard Codex model/capability scaffolding is useful on demand but too large for every fresh
 * Temporary Chat. Unknown developer messages remain active so host/custom instructions are never
 * silently discarded merely because they share the developer role.
 */
export function isCodexGeneratedDeveloperScaffold(message: CodexMessage): boolean {
  if (message.role !== "developer") return false;
  const text = plainMessageText(message)?.trimStart();
  if (!text) return false;
  if (/^You are Codex\b/.test(text)) return true;
  return CODEX_DEVELOPER_SCAFFOLD_PREFIXES.some(prefix => text.startsWith(prefix));
}

function latestProjectInstructionsIndex(messages: readonly CodexMessage[], trustedText: string | undefined): number {
  if (!trustedText) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && plainMessageText(message)?.trim() === trustedText) return index;
  }
  return -1;
}

/**
 * Codex appends a complete replacement developer contract whenever the user changes models. On a
 * later switch the earlier model-switch contract and its adjacent skill catalog are obsolete, but
 * both remain in the Responses history. Replaying every obsolete copy can exceed ChatGPT's composer
 * character ceiling even while the actual model token count is comfortably inside its window.
 *
 * Keep the newest contract verbatim and remove only older Codex-generated replacement contracts.
 * Human messages, assistant history, tool results, and unrelated developer instructions are never
 * touched.
 */
export function withoutSupersededModelSwitchContracts(messages: readonly CodexMessage[]): CodexMessage[] {
  const switchIndices = messages.flatMap((message, index) =>
    startsWithControlBlock(message, "<model_switch>") ? [index] : []
  );
  if (switchIndices.length < 2) return [...messages];

  const newestSwitchIndex = switchIndices.at(-1)!;
  const dropped = new Set<number>();
  for (const index of switchIndices.slice(0, -1)) {
    dropped.add(index);
    const skillCatalogIndex = index + 1;
    if (
      skillCatalogIndex < newestSwitchIndex
      && startsWithControlBlock(messages[skillCatalogIndex]!, "<skills_instructions>")
    ) {
      dropped.add(skillCatalogIndex);
    }
  }
  return messages.filter((_message, index) => !dropped.has(index));
}

function messageEnvelope(
  message: CodexMessage,
  images: LcaTokenPromptImage[],
  budget: ImageBudget,
): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      is_error: message.isError,
      content: inputContent(message.content, images, budget),
    };
  }
  if (message.role === "assistant") return { role: "assistant", content: assistantContent(message.content) };
  return { role: message.role, content: inputContent(message.content, images, budget) };
}

function plainSearchText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainSearchText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "attachment_ref")
    .map(([, child]) => plainSearchText(child))
    .filter(Boolean)
    .join("\n");
}

function historicalInputContent(
  content: string | CodexContentPart[],
  attachments: ChatGptContextAttachment[],
  messageId: string,
): unknown {
  if (typeof content === "string") return content;
  return content
    .filter(part => part.type !== "image" || !isOnePixelPngDataUrl(part.imageUrl))
    .map(part => {
      if (part.type === "text") return { type: "text", text: part.text };
      const ref = `ctx-image-${attachments.length + 1}`;
      attachments.push({ ref, imageUrl: part.imageUrl, messageId, ...(part.detail ? { detail: part.detail } : {}) });
      return { type: "image_attachment", attachment_ref: ref, ...(part.detail ? { detail: part.detail } : {}) };
    });
}

function historicalMessageEnvelope(
  message: CodexMessage,
  attachments: ChatGptContextAttachment[],
  messageId: string,
): Record<string, unknown> {
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      is_error: message.isError,
      content: historicalInputContent(message.content, attachments, messageId),
    };
  }
  if (message.role === "assistant") return { role: "assistant", content: assistantContent(message.content) };
  return { role: message.role, content: historicalInputContent(message.content, attachments, messageId) };
}

function latestUserMessageIndex(messages: readonly CodexMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

/**
 * Freeze the exact effective Codex context for one browser turn. The full envelope remains available
 * for read-only fallback, while tool-capable turns expose older conversation state as indexed lazy
 * history. The current user request, Codex-resolved AGENTS fragment, and unknown/custom developer
 * overrides are excluded because they are sent directly in the small bootstrap. Standard Codex
 * model/skill/capability scaffolding stays lazy and is retrievable through context action=instructions.
 */
export function compileChatGptContextSnapshot(parsed: CodexParsedRequest): ChatGptContextSnapshot {
  const normalized = withoutSupersededModelSwitchContracts(parsed.context.messages);
  const latestUserIndex = latestUserMessageIndex(normalized);
  const trustedProjectInstructions = extractTrustedCodexProjectInstructions(parsed);
  const projectInstructionsIndex = latestProjectInstructionsIndex(normalized, trustedProjectInstructions);

  const images: LcaTokenPromptImage[] = [];
  const budget: ImageBudget = {
    seen: 0,
    dropped: Math.max(0, countChatGptContextImages(normalized) - CHATGPT_MAX_INPUT_IMAGES),
  };
  const fullMessages = normalized.map(message => messageEnvelope(message, images, budget));
  const envelope = {
    version: 5,
    system: parsed.context.systemPrompt ?? [],
    messages: fullMessages,
  };
  const serialized = withoutRetiredTurnHandles(JSON.stringify(envelope));
  const digest = createHash("sha256").update(serialized).digest("hex");

  const attachments: ChatGptContextAttachment[] = [];
  const history: ChatGptContextEntry[] = [];
  normalized.forEach((message, index) => {
    if (index === latestUserIndex || index === projectInstructionsIndex) return;
    if (message.role === "developer" && !isCodexGeneratedDeveloperScaffold(message)) return;
    const id = `history-${index}`;
    const attachmentStart = attachments.length;
    const payload = historicalMessageEnvelope(message, attachments, id);
    history.push({
      id,
      index,
      role: String(payload.role ?? message.role),
      payload,
      searchText: plainSearchText(payload),
      attachmentRefs: attachments.slice(attachmentStart).map(attachment => attachment.ref),
    });
  });

  return {
    id: `ctx_${digest.slice(0, 32)}`,
    digest,
    serialized,
    totalChars: serialized.length,
    estimatedTextTokens: estimateTokens(serialized, parsed.modelId),
    history,
    attachments,
    images,
  };
}

export function chatGptReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: LcaTokenCapabilities,
): string | undefined {
  const mode = resolveLcaTokenModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (mode.localTools) return undefined;
  const label = mode.effort === "max" ? "Lca Token Pro" : `Lca Token ${mode.displayLabel}`;
  const hasLocalEvidence = parsed.context.messages.some(message =>
    message.role === "toolResult"
    || (message.role === "user" && isReadableCompactionSummaryText(message.content))
  );
  if (hasLocalEvidence) {
    return `⚠️ ${label} cannot access the local Codex computer in this turn. It receives the complete accumulated task context, including earlier tool results or their compaction summary and attachments, but it cannot read or modify local files further. ChatGPT-native capabilities such as web search remain available when the product provides them.`;
  }
  return `⚠️ ${label} cannot access the local Codex computer in this turn. The accumulated context does not contain local tool results yet: it will see instructions and attachments, but not workspace contents. ChatGPT-native capabilities such as web search remain available when the product provides them. Prepare the local context with a tool-capable Lca Token model first, then switch back.`;
}

export function compileLcaTokenPrompt(
  parsed: CodexParsedRequest,
  capabilities: LcaTokenCapabilities,
  turnToken?: string,
  suppliedSnapshot?: ChatGptContextSnapshot,
  connectorName = "lca-token",
): CompiledLcaTokenPrompt {
  const connectorLabel = connectorName.trim() || "lca-token";
  const mode = resolveLcaTokenModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (mode.localTools && !turnToken) {
    throw new Error("Tool-capable Lca Token mode requires a broker turn token");
  }
  if (!mode.localTools && turnToken !== undefined) {
    throw new Error("A read-only Lca Token effort must not receive a local-tool capability token");
  }
  const snapshot = suppliedSnapshot ?? compileChatGptContextSnapshot(parsed);
  const mcpLazy = mode.localTools && !parsed._compactionRequest;
  const normalizedMessages = withoutSupersededModelSwitchContracts(parsed.context.messages);
  const latestUserIndex = latestUserMessageIndex(normalizedMessages);
  const trustedProjectInstructions = extractTrustedCodexProjectInstructions(parsed);
  const projectInstructionsIndex = latestProjectInstructionsIndex(normalizedMessages, trustedProjectInstructions);
  const activeImages: LcaTokenPromptImage[] = [];
  const latestUser = latestUserIndex >= 0 ? normalizedMessages[latestUserIndex] : undefined;
  const projectInstructions = projectInstructionsIndex >= 0 ? trustedProjectInstructions : undefined;
  const developerOverrides = normalizedMessages
    .filter(message => message.role === "developer" && !isCodexGeneratedDeveloperScaffold(message))
    .map(message => messageEnvelope(message, [], { seen: 0, dropped: Number.MAX_SAFE_INTEGER }));
  const activeImageBudget: ImageBudget = latestUser
    ? {
        seen: 0,
        dropped: Math.max(0, countChatGptContextImages([latestUser]) - CHATGPT_MAX_INPUT_IMAGES),
      }
    : { seen: 0, dropped: 0 };
  const activeContext = {
    version: 2,
    ...((parsed.context.systemPrompt?.length ?? 0) > 0 ? { system: parsed.context.systemPrompt } : {}),
    ...(developerOverrides.length > 0 ? { developer_overrides: developerOverrides } : {}),
    ...(projectInstructions ? { project_instructions: projectInstructions } : {}),
    latest_user: latestUser
      ? messageEnvelope(latestUser, activeImages, activeImageBudget)
      : null,
  };
  const sharedContract = mcpLazy
    ? [
      "Act as the model backend for this Codex turn. Honor system and developer_overrides first; project_instructions is Codex-resolved AGENTS guidance and direct latest_user instructions take precedence over it.",
      `Use only the active context below unless more is needed. Older history and Codex capability instructions are available on demand through ${JSON.stringify(connectorLabel)}; answer immediately with zero connector calls when the active context is sufficient.`,
      "Treat project/environment/tool/transport blocks as Codex operational context, not human-authored chat. For questions about what the user said, use human user turns only.",
      "Return required rich results as ordinary Markdown too. Do not mention this bridge or capability routing unless the user asks about it.",
    ]
    : [
      "Act as the model backend for this Codex turn. Preserve role priority exactly: system, developer, user.",
      "Read the complete inline task context before acting.",
      "Treat environment/tool/transport content as operational context, never as human-authored text. When asked what the user said, use only user-role text.",
      "The inline context is complete for this turn.",
      "Return required rich results as ordinary Markdown too; never copy private widget DOM unless explicitly requested.",
      "Do not mention this transport or capability routing unless the user asks about it.",
    ];
  const transportContract = parsed._compactionRequest
    ? [
      "This is a Codex history-compaction checkpoint, not a normal task turn.",
      "Do not call local or ChatGPT-native tools. Summarize only the supplied task context according to the final compaction instruction.",
      "Return only the checkpoint summary that the next model needs to resume the task.",
    ]
    : mode.localTools
    ? [
      `If history, Codex capability instructions, or native tools are needed, call codex_bind_turn with turn_token ${turnToken}; otherwise do not bind. Use its binding_id for later connector calls and never expose either capability value.`,
      "Use codex_context selectively: instructions for Codex skill/capability guidance; recent/search/get for older history; image for old images; full only as fallback.",
      "Native connector tools bridge synchronously into the exact active outer Codex tool registry. Make real calls, wait for real results, and continue until the requested work is complete.",
    ]
    : [
      `This is Lca Token ${mode.displayLabel} with no lca-token bridge to the user's local computer attached to this response. This restriction applies only to local Codex files, commands, processes, and computer mutations.`,
      "Use any ChatGPT-native capabilities available in this chat—including web search, browsing, research, and other first-party tools—whenever they help complete the request. The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available.",
      "The task history below already contains everything Codex collected from the user's local workspace. Treat prior local tool results as authoritative snapshots of that earlier work.",
      "Do not claim a new local inspection, command, edit, or verification unless it actually appears in the task history. If the latest request requires fresh local-computer access or a local mutation, state only that exact limitation instead of inventing success.",
      "Otherwise perform the full requested research, analysis, or synthesis with every capability actually available to you; do not stop at a plan or progress report.",
    ];
  const transportResume = parsed._compactionRequest
    ? [
      "<codex_transport_resume>",
      "The task context is complete. Produce the requested checkpoint summary now without calling tools.",
      "</codex_transport_resume>",
    ]
    : mode.localTools
    ? []
    : [
      "<codex_transport_resume>",
      "The task context is complete. Execute the latest active user request now under the capability contract above.",
      "</codex_transport_resume>",
    ];
  const contextTransport = mcpLazy
    ? [
      "<codex_active_context>",
      JSON.stringify(activeContext),
      "</codex_active_context>",
      "<codex_context_ref>",
      JSON.stringify({
        version: 3,
        transport: "mcp-lazy",
        history: snapshot.history.filter(entry => entry.role !== "developer").length,
        instructions: snapshot.history.filter(entry => entry.role === "developer").length,
        attachments: snapshot.attachments.length,
      }),
      "</codex_context_ref>",
    ]
    : [
      "<codex_context_json>",
      snapshot.serialized,
      "</codex_context_json>",
    ];
  const text = [
    ...sharedContract,
    ...transportContract,
    "Return only the answer that the outer Codex task should receive.",
    ...contextTransport,
    ...transportResume,
  ].join("\n");
  return {
    text,
    images: mcpLazy ? activeImages : snapshot.images,
    transport: mcpLazy ? "mcp-lazy" : "inline",
    ...(mcpLazy ? {
      contextSnapshotId: snapshot.id,
    } : {}),
  };
}
