# Changelog

All notable changes to this project will be documented in this file.

## [1.0.3] - Unreleased

### Fixed

- Keep browser turns alive when ChatGPT temporarily removes or replaces the assistant response DOM while generation/tool execution is still running. The missing-response grace period now starts only after generation stops.
- Revalidate a grace-expired missing-response watchdog on the next normal browser poll before failing. This closes a React commit race where the failure-time screenshot already contains the restored terminal response even though the immediately preceding poll observed an absent, idle assistant DOM.
- Reattach Playwright to the same launcher-owned ChatGPT surface when only the CDP transport disconnects during a live turn. A genuinely closed launcher tab remains terminal, and the worker never replays the ChatGPT generation just to recover transport because prior local tool calls may already have side effects.
- Do not impose a separate response-DOM timeout while ChatGPT still exposes active generation. Deep-reasoning turns may legitimately keep the assistant DOM unchanged or temporarily absent for well over a minute; lifecycle aborts and the configured turn timeout remain the explicit bounds.
- Start the missing completed-turn-action grace period from the latest observed assistant/tool UI activity rather than the first answer-looking Markdown. Tool-capable turns can expose final-looking text while later connector calls are still running, so that activity must reset the watchdog.
- Prevent connector/tool turns from streaming final Markdown too early. Final-answer Markdown stays mutable while tools are active and is emitted once at terminal completion, avoiding failures when ChatGPT replaces text that previously looked complete.
- Preserve terminal completion handling across transient DOM changes, while still invalidating stale terminal text if generation resumes. Response-scoped terminal action UI now outranks a stale global Stop button, a collapsed response action footer/overflow menu is accepted when ChatGPT hides the Copy button responsively, and completion settles only after the whole observed assistant/tool activity signature is stable.
- Capture a screenshot plus bounded browser-state JSON at the exact response-DOM watchdog failure and include both local artifact paths in the error returned to Codex. Failure screenshots use direct CDP capture first because Playwright screenshots can time out on the failing renderer; state capture is preserved independently even if image capture fails. Exact failure diagnostics are returned immediately without taking a second delayed screenshot in the final catch.

### Tests

- Added regression coverage for assistant DOM replacement during active generation.
- Added regression coverage that a missing-response failure candidate is cancelled when the assistant turn returns on the confirmation poll after the grace boundary.
- Added contract coverage that a transient launcher CDP disconnect re-resolves the same owned assistant surface instead of treating transport loss as a closed tab or starting a fresh ChatGPT generation.
- Added regression coverage that connector/tool UI activity resets the completed-turn-action watchdog even when answer-looking text is unchanged.
- Added regression coverage proving mutable connector Markdown is deferred until completion and replaced preliminary blocks are never retracted from Codex.
- Added contract coverage that response-DOM health failures surface their failure-time browser diagnostic artifacts to Codex, including CDP screenshot fallback and independent state capture.
- Added regression coverage for stale Stop visibility and response-scoped terminal action groups when Copy is collapsed into overflow.
