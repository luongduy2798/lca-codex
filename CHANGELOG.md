# Changelog

All notable changes to this project will be documented in this file.

## [1.0.6]

### Changed

- Make the owned ChatGPT network lifecycle the sole terminal authority. A matching `conversation-turn-complete` now triggers one fresh canonical response-DOM snapshot and immediate finalization; there is no fixed post-network settle timer and no DOM-derived recovery completion path.
- Keep DOM stability strictly in the rendering path. Final-answer Markdown still waits for structural completeness and the 750 ms byte-stability window, including tool/connector turns, but terminal-looking DOM, footer controls, remounts, or long periods of unchanged content cannot finish a turn.
- Reconcile streamed answer blocks by semantic content across React removal, reorder, insertion, remount, and rewrite. Already-emitted Responses bytes remain append-only; replacement content may append only after it becomes a new stable candidate, and only the final visible top-level answer root is serialized during overlapping remounts.
- Preserve an in-flight ChatGPT generation when a post-Send CDP reconnect reaches the same launcher-owned surface but the replacement network observer cannot attach. The worker does not kill or replay the turn; initial observer attachment before Send still fails closed, and a missing network completion signal cannot be replaced by DOM evidence.
- Derive the routed LCA Codex outer context lifetime from the selected native model template's `max_context_window` instead of a fixed 272k cap. Auto-compaction remains at 90% of that advertised maximum (for example, 872k -> 784.8k), while the ChatGPT Web bootstrap remains independently bounded and lazy.
- Keep `model_context_window` overrides scoped to native models when augmenting the catalog, so a user override cannot make the routed LCA model advertise a capability larger than the unmodified native template reports.

### Tests

- Added regression coverage for network-only completion, one-shot terminal DOM re-snapshot, absence of DOM recovery completion, and continuation without replay when a replacement observer cannot reattach after Send.
- Added Markdown-buffer and browser contract coverage for incomplete fenced code, the 750 ms stability gate, canonical-root selection, append-only remount/rewrite reconciliation, and terminal tail flushing.
- Added model-catalog coverage for native `max_context_window` propagation, 90% auto-compaction, fail-closed handling of a missing/invalid native maximum, and isolation from `model_context_window` overrides.

## [1.0.5] - Released

### Fixed

- Serialize current ChatGPT code-block DOM as literal fenced Markdown without leaking language/copy controls or escaping source characters. Wrapped `<pre>` blocks, CodeMirror renderers, div-wrapped block code, and standalone block-like `<code>` nodes are handled while ordinary inline code remains inline.
- Make packaged launcher embedded operations execute from the durable installed runtime instead of the temporary packaged resources path, so operations continue to work after an AppImage extraction directory disappears.

### Tests

- Added Markdown serialization coverage for wrapped, CodeMirror, div-wrapped, and standalone ChatGPT code blocks.
- Added packaged-runtime coverage proving embedded launcher operations survive removal of the original AppImage extraction tree.

## [1.0.4] - Released

### Fixed

- Reattach Playwright to the same launcher-owned ChatGPT surface when only the CDP transport disconnects during a live turn. The network tracker survives the reattachment, the worker records that an observer gap occurred, and it never replays the ChatGPT generation because prior local tool calls may already have side effects.
- Make page-scoped ChatGPT network lifecycle authoritative for normal browser-turn ownership and completion. The observer attaches before Send; the page's conversation POST proves submission and its `stream_status` request supplies the exact conversation ID.
- Support Instant turns that emit WebSocket creation/completion events without a `conversation-turn-stream` event. WebSocket evidence is buffered until it matches the exact page-owned conversation, so another browser tab cannot accept or complete this turn.
- Require an ID-less completion to have matching creation evidence. A completion carrying `turn_id` must match the exact owned turn, and a conflicting turn in the same conversation is ignored. Completion evidence may arrive first and is buffered until ownership is known. The terminal state is latched across the next ordinary poll so React can commit its final DOM tail before serialization.
- Keep the public ChatGPT DOM out of normal lifecycle decisions. DOM remains the visible-content source for reasoning/commentary, local-tool confirmation, Markdown serialization, and explicit abort UI; assistant remounts and Stop/Copy controls do not normally decide whether a turn has completed.
- Add a narrowly scoped `network_gap_dom_recovery` terminal path for a WebSocket completion frame that can be lost while CDP is disconnected. Recovery is allowed only after a known observer gap, an already-correlated turn, a visible response with terminal action evidence, no visible Stop control, at least 1.5 seconds of stable activity, and a confirming subsequent poll. DOM therefore remains a recovery aid for a proven transport gap, not a general lifecycle fallback.
- Stream final-answer Markdown incrementally for both connector/tool turns and read-only turns. DOM parsing first separates Markdown inside `[data-streaming-response-status]` as intermediate commentary from top-level final-answer Markdown; only structurally complete, byte-stable answer blocks are appended to Codex, while the terminal lifecycle flushes the remaining mutable tail.
- Preserve the latest visible assistant text across response DOM remounts so a terminal turn can still finalize from the last rendered content while the current assistant node is temporarily absent.
- Fail explicitly when a terminal browser turn never produced renderable Markdown instead of returning an empty successful response to Codex.
- Recover the native Codex `exec` gateway when current Codex clients place its custom definition inside an `additional_tools` namespace, so command/filesystem tools remain available to real LCA turns.
- Surface normalized one-shot Activity milestones (`created`, `streaming`, `completed`) without implying raw WebSocket arrival order, and distinguish normal `network` completion from `network_gap_dom_recovery` without logging raw payloads, response content, or opaque conversation/turn IDs.
- Keep bounded browser diagnostics available for turn failures and unusually long waits. Screenshot capture prefers direct CDP when Playwright's renderer-bound path is unavailable, while browser-state capture remains independent.

### Tests

- Added contract coverage that a transient launcher CDP disconnect re-resolves the same owned assistant surface instead of treating transport loss as a closed tab or starting a fresh ChatGPT generation.
- Added regression coverage for order-independent lifecycle correlation, including Instant turns without turn-stream frames, page-owned conversation isolation, turn-stream before conversation-created, unrelated completion rejection, same-conversation wrong-turn rejection, five-tab isolation, mandatory pre-Send observer attachment, and mandatory observer reattachment to the same launcher surface.
- Added contract coverage that normal submission/completion stays network-correlated while the implementation exposes the guarded network-gap recovery path separately.
- Updated the response-DOM contract so top-level final-answer blocks remain incrementally streamable even when local tools are enabled; the old `!mode.localTools` whole-turn buffering gate is no longer part of the runtime path.
- Retained Markdown-buffer regression coverage that already-committed blocks are append-only and cannot be silently rewritten after they have been streamed to Codex.
- Added contract coverage for browser diagnostic artifacts, including CDP screenshot fallback and independent state capture.
