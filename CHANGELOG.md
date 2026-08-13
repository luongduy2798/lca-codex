# Changelog

All notable changes to this project will be documented in this file.

## [1.0.3] - Unreleased

### Fixed

- Reattach Playwright to the same launcher-owned ChatGPT surface when only the CDP transport disconnects during a live turn. The network tracker survives the reattachment, the worker records that an observer gap occurred, and it never replays the ChatGPT generation because prior local tool calls may already have side effects.
- Make the page-scoped ChatGPT WebSocket lifecycle authoritative for normal browser-turn ownership and completion. The observer attaches before Send and tracks `conversation-created`, `conversation-turn-stream`, and `conversation-turn-complete` as order-independent evidence rather than assuming a fixed arrival sequence; live ChatGPT traffic may deliver turn-stream frames before the conversation-created frame.
- Use `conversation-turn-stream` as the primary ownership signal because it carries both `conversation_id` and `turn_id`. `conversation-created` confirms the owned conversation, unrelated completions are ignored, and a provisional stale stream can be replaced only when a later stream belongs to a conversation with matching creation evidence.
- Accept browser submission only from correlated WebSocket conversation/turn evidence. Normal completion requires the matching created/stream/complete evidence for the owned conversation and is latched across the next ordinary poll so React can commit the final DOM tail before serialization.
- Keep the public ChatGPT DOM out of normal lifecycle decisions. DOM remains the visible-content source for reasoning/commentary, local-tool confirmation, Markdown serialization, and explicit abort UI; assistant remounts and Stop/Copy controls do not normally decide whether a turn has completed.
- Add a narrowly scoped `network_gap_dom_recovery` terminal path for a WebSocket completion frame that can be lost while CDP is disconnected. Recovery is allowed only after a known observer gap, an already-correlated turn, a visible response with terminal action evidence, no visible Stop control, at least 1.5 seconds of stable activity, and a confirming subsequent poll. DOM therefore remains a recovery aid for a proven transport gap, not a general lifecycle fallback.
- Stream final-answer Markdown incrementally for both connector/tool turns and read-only turns. DOM parsing first separates Markdown inside `[data-streaming-response-status]` as intermediate commentary from top-level final-answer Markdown; only structurally complete, byte-stable answer blocks are appended to Codex, while the terminal lifecycle flushes the remaining mutable tail.
- Preserve the latest visible assistant text across response DOM remounts so a terminal turn can still finalize from the last rendered content while the current assistant node is temporarily absent.
- Surface normalized one-shot Activity milestones (`created`, `streaming`, `completed`) without implying raw WebSocket arrival order, and distinguish normal `network` completion from `network_gap_dom_recovery` without logging raw payloads, response content, or opaque conversation/turn IDs.
- Keep bounded browser diagnostics available for turn failures and unusually long waits. Screenshot capture prefers direct CDP when Playwright's renderer-bound path is unavailable, while browser-state capture remains independent.

### Tests

- Added contract coverage that a transient launcher CDP disconnect re-resolves the same owned assistant surface instead of treating transport loss as a closed tab or starting a fresh ChatGPT generation.
- Added regression coverage for order-independent WebSocket lifecycle correlation, including turn-stream before conversation-created, stale provisional heartbeat replacement, unrelated completion rejection, mandatory pre-Send observer attachment, and mandatory observer reattachment to the same launcher surface.
- Added contract coverage that normal submission/completion stays network-correlated while the implementation exposes the guarded network-gap recovery path separately.
- Updated the response-DOM contract so top-level final-answer blocks remain incrementally streamable even when local tools are enabled; the old `!mode.localTools` whole-turn buffering gate is no longer part of the runtime path.
- Retained Markdown-buffer regression coverage that already-committed blocks are append-only and cannot be silently rewritten after they have been streamed to Codex.
- Added contract coverage for browser diagnostic artifacts, including CDP screenshot fallback and independent state capture.
