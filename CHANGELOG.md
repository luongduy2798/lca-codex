# Changelog

All notable changes to this project will be documented in this file.

## [1.0.3] - Unreleased

### Fixed

- Keep browser turns alive when ChatGPT temporarily removes or replaces the assistant response DOM while generation/tool execution is still running. The missing-response grace period now starts only after generation stops.
- Prevent connector/tool turns from streaming final Markdown too early. Final-answer Markdown stays mutable while tools are active and is emitted once at terminal completion, avoiding failures when ChatGPT replaces text that previously looked complete.
- Preserve terminal completion handling across transient DOM changes, while still invalidating stale terminal text if generation resumes.

### Tests

- Added regression coverage for assistant DOM replacement during active generation.
- Added regression coverage proving mutable connector Markdown is deferred until completion and replaced preliminary blocks are never retracted from Codex.
- Validated the fix with the safe test suite and a restarted real connector runtime before preparing this unreleased version.
