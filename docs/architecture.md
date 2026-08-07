# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned lca-token daemon
  ├─ official /models passthrough + fixed Lca Token models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes one `lca-token` model. Its reasoning selector maps Low/Medium/High/Extra High/Pro to the
  matching ChatGPT browser mode; Extra High and Pro are advertised only when the authenticated
  account exposes Pro.
- Sends the complete Codex context and image attachments to a fresh ChatGPT Temporary Chat. Because this mode has no connector, the context remains an inline composer payload.
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same single model; Instant through Extra High are tool-capable, while Pro remains
  read-only after reasoning is resolved at runtime.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. It does not launch another
browser or copy authentication state. Each tab opens a fresh Temporary Chat, shares only the local
login partition, and keeps its own document and lifecycle. Completed tabs remain inspectable until
closed. Closing a running tab destroys its page and terminates that browser turn. A sixth concurrent
turn fails explicitly; the cap avoids excessive parallel traffic that could trigger account abuse
controls.

In full mode, tool-capable turns no longer carry the accumulated Codex history through the visible
composer. Before opening the fresh Temporary Chat, the adapter freezes the exact effective Codex
context into an immutable per-turn broker snapshot and sends only a projected active bootstrap:
active system instructions, unknown/custom developer overrides, the Codex-resolved AGENTS/project
instruction fragment, the latest user request, and current-turn images. Standard Codex base-model,
skill, permission, app, and plugin developer scaffolding stays in the broker instead of being replayed
into every Temporary Chat. One read-only `codex_context` tool exposes `instructions` for that Codex
capability guidance plus `recent`, `search`, `get`, `full`, and `image` for older task state. The model
is explicitly told not to bind or retrieve either history or instruction catalogs when the active
bootstrap is sufficient. `lca-token` never discovers AGENTS.md or chooses a skill itself; it only
projects and serves the exact instruction material already supplied by the outer Codex harness.

`codex_bind_turn` is therefore on demand. A direct answer can finish with zero connector calls. If
history or a native tool is needed, binding still scopes every later request to the exact outer Codex
turn. Native tool invocation is no longer gated on replaying unrelated history; `codex_tool_inventory`
and `codex_tool_call` still expose only the registry advertised by that outer turn, preserving Codex
sandbox, approvals, sessions, and tool lifecycle as the execution authority. The snapshot dies with
its outer Codex turn.

Historical image bytes remain in the broker and are returned only when `codex_context` is called with
`action=image` for an attachment reference discovered by a history result. They are no longer
re-uploaded into every fresh Temporary Chat. Read-only routes that cannot use the custom connector —
including Pro, browser-only mode, and routed compaction — retain the complete inline JSON fallback.

The appended model advertises the conservative Instant/Medium window because Codex catalog context
size is model-wide rather than reasoning-specific. The runtime still enforces the exact per-mode
150k/185k/256k/272k limits and a ten-percent auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves. Lazy-context turns account for the active browser bootstrap immediately; historical content
is no longer charged up front merely because it exists in the broker snapshot. The independent
composer-size boundary therefore applies primarily to inline fallback routes.

Routed compaction v1/v2 runs as a dedicated read-only browser summarization turn with no broker or
local tools, then returns the native replacement-history shape expected by Codex. A prompt-level
checkpoint marker is translated into a visible Codex trace item; tool-capable turns re-bind the
same capability after that checkpoint. Visible ChatGPT status rows become reasoning summaries,
while stable prose between rows becomes native Codex commentary.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no system Node/Bun. Full mode separately
downloads the official pinned `openai/tunnel-client` build for the current OS/architecture and
verifies it against the release SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the single routed `lca-token`
model; stale `lca-token/*` routes are removed locally and no static catalog is installed.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active Responses HTTP requests, including native compaction passthrough;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
