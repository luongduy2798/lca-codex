# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
launcher-owned lca-codex daemon
  ├─ official /models passthrough + fixed LCA Codex models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

## Runtime contract

LCA Codex has one supported runtime shape: the ChatGPT Web bridge. Codex remains the only agent
harness; LCA transports a selected turn to ChatGPT Web and connects that response back to the
current Codex task.

- Exposes one `lca-codex` model. Its reasoning selector maps Low/Medium/High/Extra High/Pro to the
  matching ChatGPT browser reasoning mode; Extra High and Pro are advertised only when the
  authenticated account exposes Pro.
- Instant, Medium, High, Extra High, and Pro are all tool-capable when the custom connector is
  enabled. Reasoning effort selects the ChatGPT browser mode; it does not independently change
  local-tool access. An explicitly connector-disabled runtime remains read-only regardless of
  reasoning level.
- ChatGPT uses a required custom MCP connector backed by `openai/tunnel-client`.
- Every connector call is bound to one outer Codex turn capability.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.
- Runtime readiness is conjunctive: both the tunnel and the Responses daemon must be healthy. The
  launcher starts the tunnel first and never reports the runtime Ready when tunnel readiness is lost.

The reversible Codex integration deliberately installs a Web-compatibility profile:
`multi_agent = true` preserves routed subagent turns, `multi_agent_v2 = false` keeps their payloads
readable by the current Web projection, and `remote_compaction_v2 = false` bounds retained Web image
history. These settings adapt the outer Codex harness to ChatGPT Web constraints; they do not move
planning, tool ownership, sandboxing, or approvals into LCA Codex.

## Browser lifecycle

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each Codex task is leased an independent `WebContentsView` and surface ID; Playwright attaches
to that exact surface through a launcher-owned loopback CDP endpoint. It does not launch another
browser or copy authentication state. Each tab opens a fresh Temporary Chat, shares only the local
login partition, and keeps its own document and lifecycle. Completed tabs remain inspectable until
closed. Closing a running tab destroys its page and terminates that browser turn. A sixth concurrent
turn fails explicitly; the cap avoids excessive parallel traffic that could trigger account abuse
controls.

Within an open tab, the authoritative generation lifecycle is network-scoped rather than DOM-scoped.
Before Send, the worker attaches a page CDP WebSocket observer and arms it for the new submission. It
correlates `conversation-created` to that new conversation, then its `conversation-turn-stream`, and
accepts only the matching `conversation-turn-complete` as normal completion. Frames seen before arming
are ignored; a fresh creation event replaces a provisional stale heartbeat correlation, and completion
from another conversation is rejected. Submission acceptance likewise requires correlated network
conversation/turn evidence.

The public ChatGPT DOM is deliberately not a liveness or completion authority. Assistant nodes may be
removed, replaced, or remounted by React; global Stop/Copy/action controls may also be stale or absent.
Those changes do not end or complete the turn. DOM access is limited to rendering concerns: visible
reasoning/commentary, local-tool confirmation, final Markdown serialization, and pressing Stop for an
explicit abort. After the matching network completion event, the worker performs one ordinary poll to
allow a final React commit, then finalizes from the current DOM or the latest cached visible response.
There is no DOM-completion fallback and no response-DOM watchdog timeout.

The network observer is therefore required infrastructure, not optional telemetry. Initial attachment
must succeed before Send. If the launcher-owned CDP transport drops, the worker may reconnect to the
same surface without replaying the ChatGPT generation, preserving any local-tool side effects already
performed. The observer must then reattach as well; failure is terminal rather than permission to
continue from DOM heuristics. Activity logs expose only one-shot lifecycle milestones and the fixed
`network` completion source, never raw WebSocket payloads, response content, credentials, or opaque
conversation/turn identifiers.

Normal tool-capable turns do not replay the entire accumulated Codex history through the
visible composer. Before opening the fresh Temporary Chat, the adapter freezes the exact effective
Codex context into an immutable per-turn broker snapshot and projects a bounded working-memory
bootstrap: active system instructions, unknown/custom developer overrides, the Codex-resolved
AGENTS/project instruction fragment, the latest readable compaction checkpoint, a recent
conversation tail, the latest user request, and current-turn images. The recent tail is selected
structurally rather than semantically: each human user turn starts an exchange, its following
assistant/tool events belong to that exchange until the next user turn, and only the latest four
exchanges are eligible for the bootstrap. The 8k token budget remains a hard cap inside that window;
user/final-assistant anchors are admitted before bounded tool evidence, so an old tool-heavy exchange
cannot consume the bootstrap. Oversized retained entries use bounded previews with stable
`history_ref` values instead of replaying full logs.

Standard Codex base-model, skill, permission, app, and plugin developer scaffolding plus older/deeper
conversation state stays in the broker instead of being replayed into every Temporary Chat. One
read-only `codex_context` tool exposes `instructions` for Codex capability guidance plus
`recent`, `search`, `get`, `full`, and `image` for deeper task state. A truncated working-memory entry
can be expanded with `get`; historical images remain lazy. The model is explicitly told to resolve
ordinary conversational references from the inline recent context first and bind only when the
needed information is outside that working set or a native Codex tool is required. `lca-codex` never
discovers AGENTS.md or chooses a skill itself; it only projects and serves the exact instruction
material already supplied by the outer Codex harness.

`codex_bind_turn` is therefore on demand. A direct answer can finish with zero connector calls. If
history or a native tool is needed, binding still scopes every later request to the exact outer Codex
turn. Native tool invocation is no longer gated on replaying unrelated history; `codex_tool_inventory`
and `codex_tool_call` still expose only the registry advertised by that outer turn, preserving Codex
sandbox, approvals, sessions, and tool lifecycle as the execution authority. The snapshot dies with
its outer Codex turn.

Historical image bytes remain in the broker and are returned only when `codex_context` is called with
`action=image` for an attachment reference discovered by a history result. They are no longer
re-uploaded into every fresh Temporary Chat. Normal connector-backed turns and routed compaction use
the same lazy snapshot transport, but only normal turns project the recent four-exchange/8k working
set inline. Compaction uses a minimal bootstrap with the prior checkpoint and latest user state, then
retrieves recent/deep history from the frozen snapshot as needed. There is no full-history JSON
fallback for compaction.

The appended model advertises one outer Codex lifetime for every reasoning level: 272k tokens, with
native auto-compaction at 244.8k (90%). Browser reasoning effort changes reasoning only; there are no
per-mode inline context limits. Independently, the ChatGPT Web side keeps
the active bootstrap bounded to at most four recent exchanges within an 8k-token budget. Effective
browser input accounting includes fixed platform costs plus a 20k-token safety reserve per attached
image; 600k is the soft tuning watermark and 725k is the hard browser safety guard. Historical
content that remains only in the broker snapshot is not charged up front. This browser effective-input
estimate is intentionally separate from Responses usage reported back to Codex: the latter estimates
the full active native Codex context so the outer context gauge/accounting does not mistake a bounded
browser projection for the accumulated Codex task history.

Routed compaction v1/v2 runs as a dedicated browser checkpoint turn over a frozen broker snapshot.
It does not inline the normal recent working set. It must bind the lazy context connector and may use
only read-only `codex_context` retrieval
(`recent`, `search`, `get`, bounded `full`, and `image`); native execution, mutations, tool-registry
calls, and ChatGPT-native tools are prohibited during compaction. The resulting checkpoint may drop
old wording but must preserve semantic task state and useful history/attachment references before
returning the native replacement-history shape expected by Codex. A prompt-level checkpoint marker
is translated into a visible Codex trace item; later tool-capable turns bind their own turn-scoped
capability as needed. Visible ChatGPT status rows become reasoning summaries, while stable prose
between rows becomes native Codex commentary.

## Retry policy

Provider retryability and permission to create a fresh ChatGPT browser generation are separate
contracts. A transient provider failure may authorize one bounded fresh Temporary Chat only before
any final-answer bytes have been emitted. Once final-answer text has entered the append-only
Responses stream, the request is terminal so a replacement generation can never duplicate the
visible prefix.

Product usage limits are different again. Rate limits, quota exhaustion, and subscription limits may
remain retryable to native Codex so its normal backoff or a later user retry can occur, but LCA Codex
never opens a second Temporary Chat automatically for those errors. This preserves the product
usage-limit invariant without misclassifying a temporary 429 as a permanent API failure.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper. Core setup
downloads the official pinned `openai/tunnel-client` build for the current OS/architecture and
verifies it against the release SHA-256 manifest.

On first launch, the embedded runtime is identity-checked and copied atomically into a private
versioned directory under the application home. Daemon and MCP commands use that durable copy,
which is required because Linux AppImage mount paths are temporary and must never be persisted in
Codex or tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the required
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Runtime lifecycle orchestration is a separate transaction boundary from
the Electron entry point: Start, Stop, Restart, and Quit share the same compensation rules for the
managed daemon, reversible native Codex route, and optional VS Code proxy. A failed Start restores
native Codex and stops a daemon that was already started; Quit commits the application exit only
after native Codex restoration and runtime shutdown succeed.

Native Codex tool health is diagnostic rather than a runtime-readiness gate. Once the daemon and
reversible bridge are ready, Start returns immediately and launches the bounded tool-health probe
asynchronously. Stop, Restart, or a failed Start invalidates the health generation and terminates any
owned probe, so a late result from an older runtime generation cannot overwrite current UI state.
The turn broker keeps only the health transport hook; native-route discovery, passive reports, and
harmless exec/stdin smoke semantics live in the dedicated Codex tool-health module.

Native login items or an owner-local XDG autostart file launch the app hidden after sign-in. A marker
containing only launcher-owned PIDs lets doctor distinguish the launcher runtime from a stale or
external process. Terminal-managed macOS launchd services are drained and removed during an
explicit launcher ownership transfer; launchd remains only for the advanced terminal-only mode.

Setup keeps Codex's built-in `openai` provider and switches only `openai_base_url`. The daemon
forwards the authenticated official model catalog and appends only the single routed `lca-codex`
model; unsupported `lca-codex/*` routes are removed locally and no static catalog is installed.

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

## Launcher Activity retention

The launcher retains at most the current `launcher.jsonl` generation plus `launcher.jsonl.1`. Those
two files are parsed once when the logger starts, then represented by an in-memory Activity index for
chat pagination, task summaries, task drill-down, and system records. New records update the index in
memory, and log rotation replaces the older retained generation without rereading either JSONL file.
This keeps Activity IPC from repeatedly parsing up to two full log generations on the Electron main
thread.

The JSONL files remain the process-restart persistence source; the in-memory index is only a derived
runtime view and never changes the existing redaction or bounded-retention rules.

## Security invariants

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
