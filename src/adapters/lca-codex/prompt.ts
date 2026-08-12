import { createHash } from "node:crypto";
import type { CodexAssistantContentPart, CodexContentPart, CodexMessage, CodexParsedRequest } from "../../types";
import { estimateTokens } from "../../lib/token-estimate";
import { isOnePixelPngDataUrl, isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import { extractTrustedCodexProjectInstructions } from "./environment";
import { resolveLcaCodexModelMode, type LcaCodexCapabilities } from "./model";

export interface LcaCodexPromptImage {
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

export interface ChatGptContextAttachment extends LcaCodexPromptImage {
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
  images: LcaCodexPromptImage[];
}

export interface CompiledLcaCodexPrompt {
  text: string;
  images: LcaCodexPromptImage[];
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
 * A fresh Temporary Chat has no browser-side image memory. Tool-capable turns attach only images
 * from the active user bootstrap and retain older images in the frozen snapshot for lazy retrieval.
 * The bounded image budget here also supports the explicit inline/read-only fallback, where the
 * newest available images are attached directly and older overflow is dropped.
 */
interface ImageBudget {
  seen: number;
  dropped: number;
}

function inputContent(
  content: string | CodexContentPart[],
  images: LcaCodexPromptImage[],
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
  images: LcaCodexPromptImage[],
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

/** Recent Codex working memory carried into every fresh tool-capable Temporary Chat. */
export const CHATGPT_RECENT_CONTEXT_TOKEN_BUDGET = 8_000;
export const CHATGPT_RECENT_CONTEXT_EXCHANGE_LIMIT = 4;
const CHATGPT_RECENT_CONTEXT_OVERHEAD_TOKENS = 200;
const CHATGPT_RECENT_CHECKPOINT_TOKEN_CAP = 3_000;
const CHATGPT_RECENT_ASSISTANT_TOKEN_CAP = 2_500;
const CHATGPT_RECENT_USER_TOKEN_CAP = 1_200;
const CHATGPT_RECENT_ENTRY_TOKEN_CAP = 1_200;
const CHATGPT_RECENT_TOOL_RESULT_TOKEN_CAP = 500;

interface ProjectedContextEntry {
  payload: Record<string, unknown>;
  tokens: number;
}

interface RecentWorkingContext {
  checkpoint?: Record<string, unknown>;
  entries: Record<string, unknown>[];
  estimatedTokens: number;
  exchangeCount: number;
}

function sanitizeRecentContextPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(withoutRetiredTurnHandles(JSON.stringify(payload))) as Record<string, unknown>;
}

function recentContextEntryEnvelope(entry: ChatGptContextEntry): Record<string, unknown> {
  return sanitizeRecentContextPayload({ id: entry.id, ...entry.payload });
}

function recentContextPreview(text: string, charBudget: number): string {
  if (text.length <= charBudget) return text;
  if (charBudget <= 24) return text.slice(0, charBudget);
  const marker = "\n...[truncated]...\n";
  const usable = Math.max(1, charBudget - marker.length);
  const head = Math.ceil(usable * 0.65);
  const tail = Math.max(0, usable - head);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function projectedRecentContextEntry(
  entry: ChatGptContextEntry,
  modelId: string,
  tokenCap: number,
): ProjectedContextEntry | undefined {
  if (tokenCap <= 0) return undefined;
  const exact = recentContextEntryEnvelope(entry);
  const exactSerialized = withoutRetiredTurnHandles(JSON.stringify(exact));
  const exactTokens = estimateTokens(exactSerialized, modelId);
  if (exactTokens <= tokenCap) return { payload: exact, tokens: exactTokens };

  const metadata: Record<string, unknown> = {};
  for (const key of ["tool_call_id", "tool_name", "is_error"] as const) {
    if (key in entry.payload) metadata[key] = entry.payload[key];
  }
  const candidate = (chars: number): ProjectedContextEntry => {
    const payload = {
      id: entry.id,
      role: entry.role,
      ...metadata,
      content: recentContextPreview(withoutRetiredTurnHandles(entry.searchText), chars),
      truncated: true,
      history_ref: entry.id,
      ...(entry.attachmentRefs.length > 0 ? { attachment_refs: entry.attachmentRefs } : {}),
    };
    const sanitized = sanitizeRecentContextPayload(payload);
    return {
      payload: sanitized,
      tokens: estimateTokens(JSON.stringify(sanitized), modelId),
    };
  };

  const minimal = candidate(0);
  if (minimal.tokens > tokenCap) return undefined;
  let low = 0;
  let high = Math.min(entry.searchText.length, 20_000);
  let best = minimal;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const projected = candidate(middle);
    if (projected.tokens <= tokenCap) {
      best = projected;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function recentContextEntryText(entry: ChatGptContextEntry): string {
  return plainSearchText(entry.payload.content).trim();
}

function isReadableCheckpointEntry(entry: ChatGptContextEntry): boolean {
  return entry.role === "user" && isReadableCompactionSummaryText(recentContextEntryText(entry));
}

function isRecentOperationalWrapper(entry: ChatGptContextEntry): boolean {
  const text = recentContextEntryText(entry);
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text)
    || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text)
    || text === OPAQUE_COMPACTION_NOTE;
}

function recentConversationExchanges(entries: readonly ChatGptContextEntry[]): ChatGptContextEntry[][] {
  const exchanges: ChatGptContextEntry[][] = [];
  let current: ChatGptContextEntry[] | undefined;
  for (const entry of entries) {
    if (entry.role === "user") {
      if (current?.length) exchanges.push(current);
      current = [entry];
      continue;
    }
    if (current) current.push(entry);
  }
  if (current?.length) exchanges.push(current);
  return exchanges.slice(-CHATGPT_RECENT_CONTEXT_EXCHANGE_LIMIT);
}

/**
 * Project a bounded working-memory set from the authoritative outer Codex history. Deep history
 * stays in the broker. Selection is deterministic: retain only the latest conversational exchanges,
 * then apply token caps inside that structural window. No semantic/model pass is used here.
 */
function projectRecentWorkingContext(
  snapshot: ChatGptContextSnapshot,
  modelId: string,
  latestUserIndex: number,
): RecentWorkingContext {
  let remaining = CHATGPT_RECENT_CONTEXT_TOKEN_BUDGET - CHATGPT_RECENT_CONTEXT_OVERHEAD_TOKENS;
  let estimatedTokens = 0;
  const conversational = snapshot.history.filter(entry =>
    entry.role !== "developer"
    && !isRecentOperationalWrapper(entry)
  );
  const checkpointEntry = [...conversational].reverse().find(isReadableCheckpointEntry);
  const candidates = conversational.filter(entry => !isReadableCheckpointEntry(entry));
  const currentTurnEntries = candidates.filter(entry => latestUserIndex >= 0 && entry.index > latestUserIndex);
  const priorEntries = candidates.filter(entry => latestUserIndex < 0 || entry.index < latestUserIndex);
  const exchanges = recentConversationExchanges(priorEntries);
  const selected = new Map<string, ProjectedContextEntry>();

  let checkpoint: Record<string, unknown> | undefined;
  if (checkpointEntry && remaining > 0) {
    const projected = projectedRecentContextEntry(
      checkpointEntry,
      modelId,
      Math.min(CHATGPT_RECENT_CHECKPOINT_TOKEN_CAP, remaining),
    );
    if (projected) {
      checkpoint = projected.payload;
      remaining -= projected.tokens;
      estimatedTokens += projected.tokens;
    }
  }

  const add = (entry: ChatGptContextEntry | undefined, cap: number): void => {
    if (!entry || selected.has(entry.id) || remaining <= 0) return;
    const projected = projectedRecentContextEntry(entry, modelId, Math.min(cap, remaining));
    if (!projected) return;
    selected.set(entry.id, projected);
    remaining -= projected.tokens;
    estimatedTokens += projected.tokens;
  };

  // Provider rounds within the same Codex turn can append assistant/tool items after latest_user.
  // They form the current active exchange and must survive even though latest_user itself is carried
  // separately in active_context.
  add([...currentTurnEntries].reverse().find(entry => entry.role === "assistant"), CHATGPT_RECENT_ASSISTANT_TOKEN_CAP);
  for (const entry of currentTurnEntries) {
    add(
      entry,
      entry.role === "tool_result" ? CHATGPT_RECENT_TOOL_RESULT_TOKEN_CAP : CHATGPT_RECENT_ENTRY_TOKEN_CAP,
    );
    if (remaining <= 0) break;
  }

  // Preserve prior conversational anchors next, newest exchange first. This guarantees that a large
  // older tool chain cannot evict the user question and final assistant answer that give it meaning.
  for (let exchangeIndex = exchanges.length - 1; exchangeIndex >= 0 && remaining > 0; exchangeIndex -= 1) {
    const exchange = exchanges[exchangeIndex]!;
    add(exchange.find(entry => entry.role === "user"), CHATGPT_RECENT_USER_TOKEN_CAP);
    add([...exchange].reverse().find(entry => entry.role === "assistant"), CHATGPT_RECENT_ASSISTANT_TOKEN_CAP);
  }

  // Fill remaining budget only with entries structurally owned by those retained exchanges. Tool
  // calls/results from older exchanges never enter the bootstrap even when token budget remains.
  for (let exchangeIndex = exchanges.length - 1; exchangeIndex >= 0 && remaining > 0; exchangeIndex -= 1) {
    for (const entry of exchanges[exchangeIndex]!) {
      add(
        entry,
        entry.role === "tool_result" ? CHATGPT_RECENT_TOOL_RESULT_TOKEN_CAP : CHATGPT_RECENT_ENTRY_TOKEN_CAP,
      );
      if (remaining <= 0) break;
    }
  }

  const exchangeCount = exchanges.filter(exchange => exchange.some(entry => selected.has(entry.id))).length;
  return {
    ...(checkpoint ? { checkpoint } : {}),
    entries: [...selected.values()]
      .map(value => value.payload)
      .sort((left, right) => {
        const leftId = String(left.id ?? "");
        const rightId = String(right.id ?? "");
        const leftIndex = Number.parseInt(leftId.replace(/^history-/, ""), 10);
        const rightIndex = Number.parseInt(rightId.replace(/^history-/, ""), 10);
        return leftIndex - rightIndex;
      }),
    estimatedTokens,
    exchangeCount,
  };
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

  const images: LcaCodexPromptImage[] = [];
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
  capabilities: LcaCodexCapabilities,
): string | undefined {
  const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (mode.localTools) return undefined;
  const label = mode.effort === "max" ? "LCA Codex Pro" : `LCA Codex ${mode.displayLabel}`;
  const hasLocalEvidence = parsed.context.messages.some(message =>
    message.role === "toolResult"
    || (message.role === "user" && isReadableCompactionSummaryText(message.content))
  );
  const contextNote = hasLocalEvidence
    ? "Workspace information already supplied by Codex remains available for this assistant to reason over."
    : "Codex has not supplied workspace contents to this conversation yet.";
  const nextStep = "To enable Codex mode—the coding agent for files, terminal, code search and patches—configure MCP in the LCA Codex launcher.";
  return `⚠️ ${label} is running in ChatGPT mode for this turn. ChatGPT mode is a general-purpose AI assistant: it can reason over conversation context, instructions and attachments, but it cannot independently inspect or modify your workspace with coding tools. ${contextNote} ChatGPT-native capabilities such as web search remain available when the product provides them. ${nextStep}`;
}

export function compileLcaCodexPrompt(
  parsed: CodexParsedRequest,
  capabilities: LcaCodexCapabilities,
  turnToken?: string,
  suppliedSnapshot?: ChatGptContextSnapshot,
  connectorName = "lca-codex",
): CompiledLcaCodexPrompt {
  const connectorLabel = connectorName.trim() || "lca-codex";
  const mode = resolveLcaCodexModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (parsed._compactionRequest && !mode.localTools) {
    throw new Error("LCA Codex compaction requires the lazy context connector");
  }
  if (mode.localTools && !turnToken) {
    throw new Error("Tool-capable LCA Codex mode requires a broker turn token");
  }
  if (!mode.localTools && turnToken !== undefined) {
    throw new Error("A read-only LCA Codex effort must not receive a local-tool capability token");
  }
  const snapshot = suppliedSnapshot ?? compileChatGptContextSnapshot(parsed);
  const mcpLazy = mode.localTools;
  const normalizedMessages = withoutSupersededModelSwitchContracts(parsed.context.messages);
  const latestUserIndex = latestUserMessageIndex(normalizedMessages);
  const trustedProjectInstructions = extractTrustedCodexProjectInstructions(parsed);
  const projectInstructionsIndex = latestProjectInstructionsIndex(normalizedMessages, trustedProjectInstructions);
  const activeImages: LcaCodexPromptImage[] = [];
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
  const workingContext = mcpLazy
    ? projectRecentWorkingContext(snapshot, parsed.modelId, latestUserIndex)
    : { entries: [], estimatedTokens: 0, exchangeCount: 0 };
  const activeContext = {
    version: 3,
    ...((parsed.context.systemPrompt?.length ?? 0) > 0 ? { system: parsed.context.systemPrompt } : {}),
    ...(developerOverrides.length > 0 ? { developer_overrides: developerOverrides } : {}),
    ...(projectInstructions ? { project_instructions: projectInstructions } : {}),
    ...(workingContext.checkpoint ? { checkpoint: workingContext.checkpoint } : {}),
    ...(workingContext.entries.length > 0 ? { recent_context: workingContext.entries } : {}),
    latest_user: latestUser
      ? messageEnvelope(latestUser, activeImages, activeImageBudget)
      : null,
  };
  const sharedContract = mcpLazy
    ? [
      "Act as the model backend for this Codex turn. Honor system and developer_overrides first; project_instructions is Codex-resolved AGENTS guidance and direct latest_user instructions take precedence over it.",
      "Treat checkpoint as the current compacted Codex task state and recent_context as authoritative immediate conversational continuity. Resolve follow-ups such as 'that', 'continue', 'why', or 'undo it' from recent_context before retrieving older history.",
      parsed._compactionRequest
        ? `The active context below is only a bounded compaction bootstrap. The frozen task snapshot is available read-only through ${JSON.stringify(connectorLabel)}; retrieve older state before finalizing the checkpoint when the bootstrap is not sufficient to preserve it.`
        : `Use only the active context below unless more is needed. Older history and Codex capability instructions are available on demand through ${JSON.stringify(connectorLabel)}; answer immediately with zero connector calls when the active context is sufficient.`,
      `The connector selected for this turn is ${JSON.stringify(connectorLabel)}. Treat it as an exclusive routing constraint for connector-dependent operations.`,
      `Use only ${JSON.stringify(connectorLabel)} for connector-dependent operations. Do not call another connector, app, MCP provider, host, local bridge, or similarly named tool provider even if one is available.`,
      "Connector names are opaque routing identifiers. Do not infer aliases, equivalence, fallback relationships, or shared ownership from similar names.",
      `A failure, timeout, transport error, missing tool, or unavailable action from ${JSON.stringify(connectorLabel)} does not authorize fallback to another connector. Report the blocker instead of switching providers.`,
      "Switching connectors requires explicit user authorization.",
      "If a recent_context or checkpoint entry has truncated=true, use its history_ref with codex_context get only when the omitted part is needed. Historical attachment_refs can be fetched with codex_context image.",
      "Treat project/environment/tool/transport blocks and checkpoint as Codex operational context, not human-authored chat. For questions about what the user said, use human user turns only.",
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
      `Call codex_bind_turn with turn_token ${turnToken} before finalizing the checkpoint. Use its binding_id only with codex_context and never expose either capability value.`,
      "Use codex_context as a read-only lazy transport for the frozen snapshot: recent for newest state, search/get for targeted older facts, full with bounded pagination when broader history is needed, and image only when visual evidence materially affects task state.",
      "Do not invoke native execution, file mutation, tool-registry, or ChatGPT-native tools during compaction. Compaction observes the frozen snapshot; it must not change the task or workspace.",
      "Compact may discard wording but must preserve semantic task state: goal, current progress, decisions, constraints, user preferences, evidence, important files/paths, unfinished work, and useful history/attachment references.",
      "Do not treat omitted bootstrap history as irrelevant merely because it is not inline. Recover what is needed from the frozen snapshot before producing the checkpoint.",
      "Return only the checkpoint summary that the next model needs to resume the task.",
    ]
    : mode.localTools
    ? [
      `If history, Codex capability instructions, or native tools are needed, call codex_bind_turn with turn_token ${turnToken}; otherwise do not bind. Use its binding_id for later connector calls and never expose either capability value.`,
      "Use codex_context selectively: instructions for Codex skill/capability guidance; recent/search/get for older history; image for old images; full only as fallback.",
      "Native connector tools bridge synchronously into the exact active outer Codex tool registry. Make real calls, wait for real results, and continue until the requested work is complete.",
    ]
    : [
      `This is LCA Codex ${mode.displayLabel} with no lca-codex bridge to the user's local computer attached to this response. This restriction applies only to local Codex files, commands, processes, and computer mutations.`,
      "Use any ChatGPT-native capabilities available in this chat—including web search, browsing, research, and other first-party tools—whenever they help complete the request. The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available.",
      "The task history below already contains everything Codex collected from the user's local workspace. Treat prior local tool results as authoritative snapshots of that earlier work.",
      "Do not claim a new local inspection, command, edit, or verification unless it actually appears in the task history. If the latest request requires fresh local-computer access or a local mutation, state only that exact limitation instead of inventing success.",
      "Otherwise perform the full requested research, analysis, or synthesis with every capability actually available to you; do not stop at a plan or progress report.",
    ];
  const transportResume = parsed._compactionRequest
    ? []
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
        version: 4,
        transport: "mcp-lazy",
        history: snapshot.history.filter(entry => entry.role !== "developer").length,
        instructions: snapshot.history.filter(entry => entry.role === "developer").length,
        attachments: snapshot.attachments.length,
        recent_inline: workingContext.entries.length,
        current_turn_inline: workingContext.entries.filter(entry => {
          const id = String(entry.id ?? "");
          const index = Number.parseInt(id.replace(/^history-/, ""), 10);
          return latestUserIndex >= 0 && index > latestUserIndex;
        }).length,
        recent_exchanges: workingContext.exchangeCount,
        recent_exchange_limit: CHATGPT_RECENT_CONTEXT_EXCHANGE_LIMIT,
        recent_token_budget: CHATGPT_RECENT_CONTEXT_TOKEN_BUDGET,
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
