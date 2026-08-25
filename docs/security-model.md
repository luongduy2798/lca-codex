# LCA Token security model

## Core invariant

**Prompt text has no authority.** A model message, repository file, web page, previous tool result, or user instruction cannot grant filesystem access, change the sandbox, add tools, or widen network policy.

Authority must come from an authenticated outer control plane:

- generic `/v1/agent/responses` and `/v1/chat/completions` turns: LCA API key + the request's exact declared function-tool registry; the outer harness remains responsible for enforcing its filesystem/sandbox policy while executing those tools;
- Codex compatibility turns: verified native Codex wire provenance and the exact native tool registry.

Both paths normalize into the same turn environment before the browser prompt is compiled.

## Trust boundaries

The service account trusts:

- the local LCA Token daemon and its private profile directory;
- a valid per-profile `lcat_...` API key for generic requests;
- the authenticated generic harness that supplies and executes the exact Responses `tools` registry;
- native Codex wire provenance only on the legacy Codex compatibility path;
- the selected ChatGPT account/workspace;
- OpenAI's tunnel service and the exact ChatGPT connector attached to the profile.

Prompt text, repository contents, tool output, websites, attachments, model output, and unverified browser state are untrusted data.

## Generic agent authority

`POST /v1/agent/responses` and `POST /v1/chat/completions` require a valid API key. Execution identity and task identity are separate: execution identity is reused only across tool-result rounds for one in-flight model generation, while task identity is continuation metadata and never browser-page affinity. Responses restores task identity across the whole `previous_response_id` chain. Any generic harness may instead or additionally provide `X-LCA-Task-ID`; `metadata.lca_task_id` is an equivalent body-level task extension, and Responses may use its `conversation` id. These values are normalized to opaque ids and are not filesystem, sandbox, connector, tool, or browser-transcript authority. Chat Completions keeps transcript-prefix derivation only as a backward-compatible fallback when no explicit task identity is available; that heuristic is not relied on across compaction/history rewrites. Callers do not submit `thread_id`, `turn_id`, `cwd`, roots, sandbox, or network policy fields. Those remain Codex-compatibility control-plane fields rather than generic harness task identity.

Chat Completions may also carry a harness-owned textual output protocol in ordinary role messages, such as XML-style tool tags used by Cline-style clients. LCA Token may let the model emit that text exactly as requested so the outer harness can parse it. Textual markup is not a callable LCA Token tool and cannot grant filesystem, network, sandbox, or broker authority; only the authenticated structured `tools` registry can do that.

The standard Responses `tools` array is trusted only as the authenticated harness-owned registry for that request. LCA Token may broker calls to those exact tools, but the outer harness executes them and enforces its own filesystem, sandbox, approval, and network rules. The configured ChatGPT connector and lazy context transport remain available even when this registry is empty; that does not manufacture callable tools. LCA Token gives itself a restricted no-local-authority environment for generic turns, so a prompt or HTTP header cannot widen local access.

Authority-looking strings inside `input`, `instructions`, repository content, or tool output remain ordinary untrusted text.

## API credential

Each profile has one generic API credential stored at:

```text
~/.lca-token/profiles/<profile>/secrets/api-token
```

It is written through the private atomic-file helper and is intended to remain user-only (`0600` on Unix-like systems). Authentication uses a constant-time comparison. The CLI can create, rotate, revoke, and report the path/status without printing an existing credential.

The credential authorizes the caller to use the generic agent API and advertise harness-owned tools for that profile. Treat it as a high-value secret. Rotate it after suspected exposure.

Legacy `/v1/responses` compatibility is not retrofitted with this token because native Codex transport/authentication semantics are preserved there. The authenticated generic Responses and Chat Completions routes are the product boundary for arbitrary harnesses.

## Browser session credential

`browser/storage-state.json` can authorize access to ChatGPT. It is a credential, not a cache.

- Runtime turns use it only in the profile's managed Chromium context.
- Local `auth login` launches Chrome directly with a dedicated temporary LCA Token `--user-data-dir`; the human login window is not attached to Playwright/CDP and never uses the user's normal Chrome profile. After the user returns to the terminal and confirms with Enter, LCA Token terminates only that dedicated Chrome process. Only after it exits is the isolated profile inspected in a normal Chrome renderer placed off-screen and converted to verified portable storage state.
- `auth import` parses and verifies supplied Playwright storage state in the same headed managed Chrome renderer used by inference before storing it. Human-verification challenges fail closed.
- `auth export` intentionally emits sensitive session material; the output must be transferred and stored securely.
- `auth logout` removes the stored state and verification marker for the profile.
- LCA Token does not expose an interactive login URL, OAuth callback listener, or browser-control endpoint. Human account login happens in a local OS browser window outside the headless server runtime.

LCA Token does not attach to the user's normal Chrome profile. Separate LCA Token profiles do not intentionally share ChatGPT storage state.

## Tunnel credential

The tunnel runtime key should have only the permissions required by the tunnel workflow. LCA Token copies it into a profile-private file and passes a file reference/profile to the tunnel runtime rather than embedding the secret in a systemd/launchd service definition.

The tunnel service definition does not contain the tunnel id, runtime-key path, or runtime-key bytes. Rotate the key after suspected exposure.

## Turn-scoped connector capability

For a connector-backed browser turn:

1. LCA Token freezes the context snapshot and authenticated environment.
2. The broker creates a random `turn_token` for that exact turn.
3. The browser prompt receives the token plus the selected connector name.
4. The connector exchanges it once for a different opaque `binding_id`.
5. Later context/tool calls use only the binding.
6. Completion/cancellation revokes the live capability and retires both handles.

Claims are idempotent for retry safety, but a retired handle is never rebound to a later turn. Old capability text replayed from history therefore cannot silently target the current environment.

## Lazy tool inventory

The connector exposes a small meta-tool surface. Tool discovery is always filtered through the active turn registry. Direct tools are searched from that registry; deferred tools can be discovered only through an exec gateway that the same authenticated registry advertised.

No fallback global registry is authorized by a prompt. If a tool is absent or has not been returned by lazy inventory, invocation fails closed.

The connector meta-tools use the `agent_*` namespace. Their names do not grant authority: the exact authenticated turn registry is still the callable surface, while the outer harness remains responsible for its own local execution policy.

## Harness-owned tool execution

For generic turns, the current implementation treats advertised tools as harness-owned. Chat Completions function tools are normalized to the same Responses tool registry before execution. When ChatGPT invokes one during a generic structured-tool generation:

1. the connector request blocks in the local broker;
2. LCA Token emits a Responses `function_call` to the outer harness;
3. the harness executes the tool under its own sandbox/approval policy;
4. the harness returns the matching tool result using the transport's continuation shape: `function_call_output` plus `previous_response_id` for Responses, or the matching assistant `tool_calls` / `tool` message pair for Chat Completions;
5. the blocked connector call resolves;
6. the **same** ChatGPT generation continues.

LCA Token does not implement a hidden shell fallback when a harness tool is unavailable.

## Approval semantics

`autoApproveToolCalls` is enabled by the normal setup path. It only permits a mechanical **Allow once** click in ChatGPT after the broker has already restricted the invocation to a tool from the authenticated turn registry.

Browser approval UI is not the source of filesystem/tool authority. Unknown or unexpected confirmation surfaces fail closed instead of being broadly accepted.

## Local process boundary

The built-in server binds to `127.0.0.1` only. Generic API authentication prevents an unrelated local request from using the agent route or advertising a tool registry, but it does **not** defend against a process that can already read the service account's private files or memory.

A compromised process running as the same service account is inside the local trust boundary. Use a dedicated service account for a shared server and protect `LCA_TOKEN_HOME` with OS permissions.

Administrative lifecycle endpoints use a separate random `controlToken` from `config.json`; it is not the generic harness API key.

## Network exposure

- HTTP health/Responses listeners are loopback-only.
- The built-in daemon provides no TLS termination.
- The ChatGPT connector tunnel is outbound and does not require opening a public inbound port.
- Chromium connects to ChatGPT through ordinary browser networking.

Do not expose the daemon directly to the public Internet. A remote harness should reach it through an independently administered private/TLS transport such as an SSH tunnel, private network, or hardened reverse proxy, while still presenting the LCA API key.

## Browser/UI drift

ChatGPT DOM, controls, and network behavior are not a supported stable API. Browser automation is therefore fail-closed:

- network lifecycle owns submission/completion;
- DOM is used for semantic Markdown and visible controls, not to fabricate completion;
- a different tab/conversation cannot complete the active page-owned turn;
- selector or lifecycle drift produces an explicit error instead of silently switching transport/model.

## Cross-turn isolation

Each browser generation gets a separate page-owned Temporary Chat lifecycle and turn-scoped broker capability. The page is closed when that generation completes or fails; later prompts always use a fresh page even when they carry the same task identity. The bounded local continuation cache exists only to resume structured harness-tool result rounds for the same in-flight generation, including both Responses and Chat Completions continuations; it is not a second long-term history authority.

Generic harnesses own their retained history and compaction policy. Generic LCA auto-compaction is intentionally absent rather than pretending that Codex-specific compaction semantics are universal. A harness may use LCA Token as the model for its own compact/checkpoint helper call; both the helper call and the next normal task turn are isolated browser generations, with continuity reconstructed from retained/lazy context rather than a persistent ChatGPT tab.

## GUI-less Linux deployment

Xvfb removes the physical desktop-session dependency while Chrome itself remains headed. This does not change the need to protect credentials. A server deployment should protect at least:

- `config.json` / lifecycle control token;
- `secrets/api-token`;
- tunnel runtime key;
- ChatGPT storage state;
- logs and diagnostics that may reveal filesystem paths or operational metadata.

Server deployment uses explicit credential transfer rather than remote-driving a login browser. Exported ChatGPT storage state must travel through a secure transfer channel, and the destination profile verifies it in headed Chrome inside the server's Xvfb display before use. The local isolated-browser `auth login` path is for machines with a usable desktop session and does not create remote authentication ingress for a server. The managed Linux systemd service runs under `xvfb-run`; manual foreground inference or import on a GUI-less Linux shell must likewise provide `DISPLAY` or run under Xvfb. Human-verification challenges fail closed rather than being solved or bypassed.

## Non-goals

- Defending against a compromised OS account that can read all LCA Token credentials.
- Bypassing ChatGPT plan, workspace, usage, action-control, model, or account restrictions.
- Turning consumer browser automation into a supported OpenAI API contract.
- Inferring permissions from prompt text or repository content.
- Automatically enabling server-owned tools that the authenticated harness did not advertise.
