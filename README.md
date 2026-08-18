<h1 align="center">LCA Codex</h1>

<p align="center">
  <strong>ChatGPT Web bridge for Codex</strong><br>
  Use LCA Codex (including Pro) as native Codex models.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 and x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
</p>

Pick the single **LCA Codex** model in Codex's native model picker, then choose its reasoning level
to select Instant, Medium, High, Extra High, or Pro behavior. Every turn still uses a fresh ChatGPT
Temporary Chat. With the tool bridge active, a normal turn's composer receives a bounded active bootstrap:
active system/project instructions, the current checkpoint, up to four recent exchanges within an
8k-token budget, the latest user request, and current-turn images. Deeper history and historical
images stay in the immutable broker snapshot and are retrieved through the `lca-codex` connector
only when needed. Compaction skips the inline recent-exchange projection and reads the frozen snapshot
lazily instead. Visible reasoning, native Codex tool activity, and Markdown stream back into the same
Codex task.

```text
Codex task ──Responses + SSE──▶ lca-codex ──embedded browser──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

Codex keeps the native task, context lifecycle, UI, and tool harness. The local Responses bridge
routes only the selected model turn through a fresh ChatGPT Temporary Chat; MCP connects ChatGPT
back to the tools of that same Codex task.

## Highlights

- **A polished cross-platform launcher.** One command installs the native macOS, Windows, or Linux
  app. It keeps sign-in, setup, smoke testing, MCP guidance, runtime health, and local logs in one
  place, while the embedded browser lets you watch every ChatGPT turn as it happens. Up to five
  task-bound browser tabs can run in parallel; the cap avoids excessive parallel account traffic.
- **ChatGPT is the selected model.** It runs as a native Codex model, not as a tool called by
  another host model. The original model picker, task lifecycle, streaming, tracing, and tool UI
  remain intact.
- **Local-first task sessions.** Codex remains the source of truth for task history on your
  computer. Every browser turn starts in a fresh ChatGPT Temporary Chat. Tool-capable bridge
  turns freeze that accumulated context into an immutable per-turn snapshot and retrieve selected
  older state over MCP on demand; browser chats are never reused as a second history authority.
- **A ChatGPT Web bridge into the Codex harness.** Instant, Medium, High, Extra High, and Pro all use
  the same active Codex task bridge when the custom MCP connector is enabled. Filesystem, shell,
  images, approvals, and configured tools/apps stay owned by Codex; calls and real results remain
  inside the same browser response—nothing is simulated as text.
- **Bounded context at every reasoning level.** Browser reasoning effort no longer changes how much
  Codex history is replayed inline. Each normal connector-backed turn gets a small active bootstrap
  (up to four recent exchanges within an 8k-token budget) and can fetch older task state lazily
  through the connector. Dedicated compaction turns omit that recent projection and summarize from
  the frozen lazy snapshot instead. If the connector is explicitly disabled, the selected reasoning
  mode runs read-only instead.
- **Fail-closed and manually tested.** Model selection, large context transport, images, streaming,
  visible trace, compaction, native tool rounds, cancellation, and Pro were exercised end-to-end on
  macOS and Windows 11. UI drift and missing capabilities produce explicit errors rather than
  silent fallbacks.

Temporary Chat is a ChatGPT privacy mode, not anonymity or local-only inference: prompts are still
processed by OpenAI and are subject to the account's settings and OpenAI's
[Temporary Chat policy](https://help.openai.com/en/articles/8914046-temporary-chat-faq). This project
is unofficial; users remain responsible for complying with applicable OpenAI terms and workspace
policies.

## Quick start

Install or update the desktop launcher. To update or repair an existing installation, quit the
launcher and run the same command again; it replaces the application and embedded runtime while
preserving the ChatGPT profile and launcher configuration.

**macOS or Linux**

```bash
curl -fsSL https://github.com/luongduy2798/lca-codex/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/luongduy2798/lca-codex/releases/latest/download/install-launcher.ps1 | iex
```

Then complete the three required checks in the app:

1. Sign in to ChatGPT in the embedded browser.
2. Run the browser smoke test.
3. Configure the **Codex tool bridge**: provide the tunnel credentials, start the bridge, attach the
   ChatGPT MCP connector, verify it, then restart Codex once so the LCA Codex model appears.

Pro appears only when the signed-in account exposes it. MCP/tunnel setup is part of core setup and is
required; the launcher supports only the ChatGPT Web bridge runtime.

The packaged launcher includes its own browser/runtime dependencies and does not require a system
Node/Bun installation.

**Run from source**

From an existing source checkout:

```bash
bun run app
```

This source path requires Bun 1.3.14. The command installs locked dependencies and opens the app.

## Runtime contract

LCA Codex has one runtime shape: the **ChatGPT Web bridge**. The OpenAI tunnel and ChatGPT MCP
connector are required before setup is complete. Instant, Medium, High, Extra High, and Pro all use
the same active Codex tool registry when the connector is enabled.

Every picker entry has one fixed ChatGPT reasoning mode. Codex still displays its built-in Effort and
Speed rows, but changing them cannot silently change the selected browser model. Reasoning effort no
longer changes how much conversation history is copied into the browser prompt: all normal tool-capable
modes use the same bounded active bootstrap and retrieve older context lazily. Dedicated compaction
uses the same frozen lazy snapshot without projecting the recent working set inline.

Browser-turn lifecycle comes from ChatGPT's page-scoped network traffic, not from response UI. The
worker attaches its network observer before Send. The conversation request proves submission, and that
same tab's `stream_status` request supplies its exact conversation ID even in Instant mode, which emits
no `conversation-turn-stream` frame. WebSocket creation, stream, and completion evidence is buffered
until it matches that owned ID. A completion for another tab cannot terminate the turn. If completion
carries a turn ID, that ID must match the owned turn; a different turn in the same conversation is
ignored.
Response DOM, Stop/Copy controls, and React remounts do not decide whether a turn is running or
finished.

Rendering is intentionally hybrid rather than a ChatGPT-WS text passthrough. Page-scoped network
ownership plus matching WebSocket completion owns terminal lifecycle, DOM polling supplies visible reasoning/commentary and semantic Markdown, and the
local bridge encodes those deltas as Responses SSE back to Codex. Markdown inside ChatGPT's
`[data-streaming-response-status]` container is treated as intermediate commentary; structurally
complete, byte-stable top-level answer blocks stream incrementally for both tool-capable and read-only
turns, then terminal completion flushes the remaining tail. After a matching network completion, the
worker takes one fresh canonical answer-DOM snapshot at that terminal edge and finalizes without a fixed
post-network settle delay. If CDP disconnects after Send, the same launcher-owned surface and tracker are
reattached without replaying the ChatGPT generation. If the replacement observer cannot attach but that
surface remains live, the generation continues; DOM still cannot substitute for the missing network
completion signal. Initial observer attachment fails closed before Send.

## Codex tool bridge

The bridge connects ChatGPT back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). Each fresh Temporary Chat receives
only a projected active bootstrap: active system/custom developer overrides, the AGENTS/project
instructions already resolved by Codex, the current checkpoint, up to four recent exchanges within
an 8k-token budget, the latest user request, and current-turn images. Standard Codex
model/skill/permission/app/plugin instruction scaffolding stays in the immutable broker and is
retrieved with `codex_context action=instructions` only when needed; conversation history deeper
than the bounded recent working set and historical images are lazy too. Binding is also on demand:
a trivial request can answer without any connector round trip, while native file/command/MCP work
still executes through the exact active Codex harness tool registry. The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The routed `lca-codex` model advertises the selected native template's `max_context_window` as its
outer Codex lifetime and auto-compacts at 90% of that maximum. For example, a native 872k maximum
yields an 872k outer lifetime with compaction at 784.8k. This does not enlarge the initial ChatGPT Web
prompt: the active bootstrap remains bounded to four recent exchanges within an 8k-token budget and
older state stays lazy. A user `model_context_window` override applies to native catalog entries only;
it cannot make the routed LCA model claim a larger native capability.

1. In the required **Configure Codex tool bridge** setup step, create the Tunnel and a regular API
   key on the same OpenAI account that will use the ChatGPT connector; creating the key is free and
   does not consume model API credits.
2. Enter the ChatGPT connector name, paste the Tunnel ID and API key, then press
   **Configure & start bridge**. The launcher waits for the tunnel to become ready before starting
   the Responses runtime.
3. Enable **Developer Mode** in ChatGPT settings. Create a connector using **Tunnel**, select that
   exact Tunnel, set **Authentication** to **None**, and give it exactly the connector name shown by the launcher.
4. Scan its tools, choose the intended action permissions, and run **Verify runtime**. Verification
   selects the configured connector name exactly and confirms the connector pill.

Write/modify actions require a ChatGPT workspace and admin policy that permit them. OpenAI
currently documents those actions for Business and Enterprise/Edu workspaces; personal Pro is
limited to read/fetch MCP permissions. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

## Operations

Use **Activity** for structured local logs and **Settings → Run doctor** for end-to-end health
checks. Use **Settings → Cancel retained browser turn** if a stopped task leaves ChatGPT working,
and **Settings → Remove Codex integration** before deleting the launcher so the previous Codex
route is restored.

## Limitations and security

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. The browser
  flow is manually exercised end-to-end on macOS and Windows 11; runtime, tests, and native
  packaging are gated on all three operating systems in CI.
- Until platform signing credentials are configured for a release, macOS Gatekeeper or Windows
  SmartScreen may show an unknown-publisher warning. The one-command installers verify the
  published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling the tool bridge.

## Development

```bash
bun run app
bun run verify
bun run app:package
```

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)

## Disclaimer

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.
