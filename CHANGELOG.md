# Changelog

All notable changes to this project will be documented in this file.

## [1.0.3] - Unreleased

### Fixed

- Reattach Playwright to the same launcher-owned ChatGPT surface when only the CDP transport disconnects during a live turn. A genuinely closed launcher tab remains terminal, and the worker never replays the ChatGPT generation just to recover transport because prior local tool calls may already have side effects.
- Make the page-scoped ChatGPT WebSocket lifecycle authoritative for browser turns. The observer attaches before Send, correlates `conversation-created` through `conversation-turn-stream` to `conversation-turn-complete`, and fails closed if the observer cannot attach initially or after a transient CDP reattachment.
- Stop using assistant DOM presence, Stop/Copy controls, or other completion UI as browser-turn liveness/completion signals. React may remove or remount response UI without changing turn state; DOM is now used only for visible reasoning/commentary, local-tool confirmation, final Markdown serialization, and explicit abort UI.
- Accept browser submission only from correlated WebSocket conversation/turn evidence and complete only after the correlated `conversation-turn-complete` event. The worker keeps one ordinary post-completion poll so the final React render can commit before Markdown is serialized, without adding a separate DOM timeout.
- Surface the correlated WebSocket lifecycle as one-shot Activity milestones (`created`, `streaming`, `completed`) and record final completion as `network`, without logging raw WebSocket payloads, response content, or opaque conversation/turn IDs.
- Prevent connector/tool turns from streaming final Markdown too early. Final-answer Markdown stays mutable while tools are active and is emitted once at terminal completion, avoiding failures when ChatGPT replaces text that previously looked complete.
- Preserve the latest visible assistant text across response DOM remounts so a WebSocket-completed turn can still finalize from the last rendered content while the current assistant node is temporarily absent.
- Keep bounded browser diagnostics available for turn failures and unusually long waits. Screenshot capture prefers direct CDP when Playwright's renderer-bound path is unavailable, while browser-state capture remains independent.

### Tests

- Added contract coverage that a transient launcher CDP disconnect re-resolves the same owned assistant surface instead of treating transport loss as a closed tab or starting a fresh ChatGPT generation.
- Added regression coverage for WebSocket lifecycle correlation, stale pre-send heartbeat replacement, unrelated completion rejection, mandatory pre-Send observer attachment, and mandatory observer reattachment to the same launcher surface.
- Added contract coverage that submission acceptance and completion use only network lifecycle evidence, including completion while the assistant DOM is absent on the terminal poll.
- Added regression coverage proving mutable connector Markdown is deferred until completion and replaced preliminary blocks are never retracted from Codex.
- Added contract coverage for browser diagnostic artifacts, including CDP screenshot fallback and independent state capture.
