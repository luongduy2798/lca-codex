# LCA Token architecture

## Product boundary

LCA Token is a **terminal-first ChatGPT Web runtime and capability bridge**, not an agent harness. A caller owns its task lifecycle, local execution policy, and tool implementations. LCA Token owns the browser turn, frozen-context transport, connector binding, and Responses encoding needed to let ChatGPT participate in that task.

Codex is no longer the only supported harness. It remains a compatibility adapter while the generic API supplies the same browser/broker runtime behind authenticated Responses and OpenAI-compatible Chat Completions surfaces.

```text
          Generic harness                         Codex compatibility
  Claude Code / OpenCode / custom                     Codex CLI/app
               │                                           │
               │ /v1/agent/responses                       │ /v1/responses
               │ /v1/chat/completions                      │
               │ API key                                   │ native Codex metadata
               └──────────────────┬────────────────────────┘
                                  ▼
                          canonical turn context
                     identity + exact tool registry
                                  │
                                  ▼
                           LCA Token runtime
              ┌───────────────────┼───────────────────┐
              │                   │                   │
      Responses encoding     Turn/context broker  Browser worker
              │                   │                   │
              │                   │              background Chrome
              │                   │                   │
              │                   └──── connector ────┤
              │                         tunnel         ▼
              └────────────────────────────────── ChatGPT Web
```

The product path is terminal Control Center/CLI + daemon + managed Chromium. Interactive users get a native TUI with a guided setup wizard and lifecycle menus; the same underlying operations remain available as CLI subcommands for automation. Electron and the old launcher are removed from this branch, including their root-version synchronization and git-hook lifecycle.

## Product namespace

Each profile is independent:

```text
~/.lca-token/profiles/<profile>/
├── config.json
├── browser/storage-state.json
├── runtime/turn-broker.sock
├── runtime/thread-environments.json     # Codex compatibility state
├── tunnel/
├── logs/
└── secrets/
    ├── api-token
    └── runtime.key
```

The environment boundary is `LCA_TOKEN_*`; the default port is `8317`; tunnel profile/alias names are `lca-token-<profile>`. LCA Token does not use `~/.lca-codex` or a user's normal Chrome profile by default.

## Generic API transports

The generic routes are:

```text
GET  /v1/agent/models
POST /v1/agent/responses
POST /v1/chat/completions
```

They require only a per-profile `lcat_...` bearer token. Execution identity and task identity are separate. `previous_response_id` restores private continuation metadata across Responses logical turns while execution identity changes after a completed model generation; tool-result rounds keep the active execution identity because they resume the same in-flight generation. A transport-neutral `X-LCA-Task-ID` can label any generic request with a stable task, and `metadata.lca_task_id` is an equivalent body-level extension. Responses may also use its `conversation` id as the same task-identity input. These identifiers never create browser-page affinity. Chat Completions is an adapter: it normalizes `messages`, function `tools`, tool calls/results, JSON responses, and SSE chunks onto the same generic Responses core. Because Chat Completions has no standard thread id, explicit task identity remains robust across history rewrites/compaction; immutable-prefix derivation is only a backward-compatible fallback for append-only transcripts. In both transports the declared tool registry is harness-owned. The outer harness executes those tools under its own filesystem/sandbox policy; LCA Token does not invent local filesystem authority from the HTTP request or prompt text.

`src/core/agent.ts` is the first agent-neutral core boundary. The current compatibility adapter consumes its `AgentTurnEnvironment`; future transport adapters should normalize into the same turn-environment model rather than teaching the browser worker about individual harnesses.

## Codex compatibility transport

The older `/v1/responses` surface remains available for Codex compatibility. On that path the adapter derives thread/turn identity, workspace roots, sandbox policy, and tools only from trusted native Codex wire provenance. `lca-codex` never discovers AGENTS.md or chooses a skill itself; project/skill guidance is accepted only when it is already part of the trusted outer harness context.

Native model passthrough, Codex model-catalog augmentation, previous-response replay, and Codex compaction remain compatibility behavior. They are not required by the generic `/v1/agent` route.

## Browser runtime

Normal inference uses managed Chrome with `headless: false`. Desktop runtimes place the browser window off-screen; Linux managed services run the daemon under Xvfb so Chrome still sees a normal graphical display without requiring a physical desktop. Human-verification challenges remain terminal browser-turn failures; LCA Token does not solve or bypass them. A browser worker:

1. creates a fresh Temporary Chat page for every browser generation;
2. attaches page-scoped network lifecycle observation before Send;
3. selects the configured ChatGPT model/reasoning mode;
4. projects only bounded active context into the composer;
5. streams visible reasoning/commentary plus semantic Markdown;
6. treats matching page-owned network completion as terminal authority;
7. revokes turn-scoped connector capability and closes that Temporary Chat during cleanup.

Browser DOM is used for semantic text/controls, not as the source of turn completion. A completion belonging to another tab/conversation cannot terminate the active turn.

Task identity remains transport-neutral, but browser pages are turn/generation-scoped rather than task-scoped. Native Codex `thread_id`, generic Responses continuation state, and `X-LCA-Task-ID` may associate retained context with a logical task, but a completed Temporary Chat is never reopened for the next prompt. The next logical turn reconstructs its bounded active context from the same frozen/lazy context machinery inside a new Temporary Chat.

Account bootstrap is intentionally outside the **server** runtime. On a desktop machine, the Control Center can launch the configured Chrome executable directly with a dedicated temporary `--user-data-dir` owned by the active LCA Token profile. The user performs ChatGPT/Google login in that ordinary Chrome window; LCA Token does not attach Playwright/CDP to the login window or to the user's normal Chrome profile. After the user confirms from the terminal, LCA Token closes only that dedicated Chrome process, then reopens only the isolated profile in an off-screen normal Chrome renderer, verifies an authenticated Temporary Chat surface, exports portable Playwright storage state, and deletes the temporary login profile. A failed verification never replaces an already verified stored session.

Non-interactive machines continue to use explicit Playwright storage-state import/export. `make auth-export` writes to the active profile's private `browser/exports/chatgpt-storage-state.json` by default, while `FILE=...` selects an explicit transfer destination. `make auth-import FILE=/path/to/storage-state.json` verifies supplied state in the same headed renderer used by inference before trusting or storing it; invalid, expired, unauthenticated, or challenged state fails closed. LCA Token does not create a remote-login controller, login URL, remote Xvfb authentication UI, OAuth callback listener, or public authentication ingress. A Linux server supplies the renderer's graphical dependency through Xvfb rather than a desktop session.

## Lazy context

A connector-backed turn freezes an immutable snapshot before submitting the browser prompt. Generic LCA Token turns use this same path even when the authenticated structured-tool registry is empty. The prompt contains a bounded active projection: system/developer content, the latest user request, a recent working set, checkpoint metadata when present, and current images. Older history and historical images stay in the snapshot.

The model can answer without binding the connector. If it needs older state, it binds the one-time turn token and queries the frozen snapshot lazily. This keeps large task histories out of the ChatGPT composer and keeps context retrieval read-only.

The MCP meta-tool names are agent-neutral: `agent_bind_turn`, `agent_context`, `agent_tool_inventory`, and `agent_tool_call`. Native helper wrappers use the same namespace (`agent_exec`, `agent_write_stdin`, `agent_apply_patch`, and `agent_view_image`). The compatibility adapter may still be implemented under `src/adapters/lca-codex`, but its connector surface does not leak Codex product naming into LCA Token.

## Tool authority and lazy inventory

The critical invariant is:

> Prompt text has no authority. Tool authority comes from the authenticated harness control plane and the exact turn-scoped registry.

The browser prompt never receives hundreds of native schemas. Instead it receives a few connector meta-tools. A named tool is discovered only when required:

```text
ChatGPT
   │ agent_tool_inventory("github issue")
   ▼
turn broker / exact authenticated registry
   │
   ├─ direct advertised tool
   └─ deferred tool discovered through the advertised exec gateway
```

Inventory is bounded by the current turn. A tool absent from that registry cannot be manufactured by text, connector naming, or a fallback registry.

### Harness-owned tool round trip

Generic harness tools currently use the existing deferred Responses loop:

```text
same ChatGPT browser generation
        │
        │ connector tool call
        ▼
TurnBroker blocks the connector request
        │
        ▼
Responses function_call(call_id, name, arguments)
        │
        ▼
outer harness executes the tool under its own policy
        │
        ▼
POST function_call_output with the same call_id
        │
        ▼
TurnBroker resolves the blocked connector request
        │
        ▼
same ChatGPT browser generation continues
```

The generic harness only needs to send the normal `previous_response_id` continuation. LCA Token restores its server-owned execution id from private response state so the same browser generation continues without caller-managed `thread_id` or `turn_id`.

Parallel tool batches remain atomic at the continuation boundary: every outstanding `call_id` in a surfaced batch must receive a result before the browser generation resumes.

Server-owned MCP clients are a planned extension. They are not silently enabled by the current generic route.

## Capability lifecycle

The local broker owns two opaque handles:

- `turn_token`: embedded only in the one browser prompt for a tool-capable turn;
- `binding_id`: returned when the connector claims that token and used for later context/tool calls.

They are distinct from Responses `previous_response_id` and tool `call_id`. Handles are revoked on completion/cancellation and retired handles are rejected instead of being silently rebound to a later turn.

## Service model

macOS uses profile-specific LaunchAgents. Linux uses profile-specific `systemd --user` units. The daemon service injects only `LCA_TOKEN_HOME` and `LCA_TOKEN_PROFILE` as product identity and starts the CLI `serve` command. The tunnel keeps its own OS service definition and receives only tunnel profile identity, not the tunnel id or runtime key content, but that separation is an implementation detail rather than a user-visible lifecycle boundary: top-level start/stop/restart always manage daemon + tunnel/MCP as one runtime stack. Restart tears down both managed processes before bringing up the daemon and then a fresh tunnel/MCP worker, preventing stale connector schemas from surviving a daemon-only restart.

The runtime listener remains `127.0.0.1`. Remote deployment should put an independently administered secure transport in front of it rather than changing the daemon into a public unauthenticated listener.

## Approval boundary

ChatGPT may display an **Allow once** connector confirmation. That click is a host UI confirmation, not the authority decision. The broker must already have accepted the requested tool as part of the authenticated turn registry. `autoApproveToolCalls` is therefore only permission for a mechanical browser click after broker policy has bounded the call.

## Current migration boundary

The implementation is intentionally incremental:

```text
already neutralized
  product identity / profiles / CLI / services
  API authentication
  generic harness tool registry
  generic Responses route
  generic Chat Completions adapter
  canonical AgentTurnEnvironment
  headless inference

compatibility internals still to move/rename
  src/adapters/lca-codex/* browser + broker modules
  CodexParsedRequest canonical naming
  agent_* MCP meta-tool names
  Codex-specific model catalog / compaction
```

This preserves the proven browser, streaming, lazy-context, and tool-resume machinery while making the trusted harness boundary generic first. Physical module renames can happen after behavior is covered by the neutral contracts.
