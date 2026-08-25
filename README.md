# LCA Token

LCA Token is a local, terminal-first ChatGPT Web runtime for agent harnesses. Its primary human UX is an interactive TUI, while scriptable CLI subcommands remain available for automation. It exposes a Responses-compatible HTTP surface, runs ChatGPT turns in managed Chromium, and keeps lazy context/tool calls bound to the authenticated outer harness instead of granting authority from prompt text.

This branch is the terminal/server product split from the older LCA Codex desktop integration. The Electron launcher and its root-level synchronization/githook machinery have been removed; the runtime does **not** require Electron or an attached desktop browser.

```text
Codex / Claude Code / OpenCode / custom harness
                    │
                    │ Responses-compatible HTTP
                    ▼
              LCA Token daemon
        ┌───────────┼────────────┐
        │           │            │
   API auth   turn/context   background Chrome
        │       broker            │
        │           │             ▼
        │           └────── ChatGPT Web
        │                         │
        └──────── authenticated connector/tunnel
```

## Current status

The `lca-token` branch already provides:

- a separate product namespace: `lca-token`, `~/.lca-token`, and `LCA_TOKEN_*` environment variables;
- isolated profiles with separate ChatGPT state, runtime sockets, tunnel profiles, logs, and API credentials;
- normal headed Chrome placed off-screen for inference, with Linux servers rendering it inside Xvfb and ChatGPT session credentials created through a local isolated-browser login or supplied explicitly through verified import/export;
- a native terminal Control Center and guided Setup Wizard, with scriptable CLI lifecycle commands and no Electron in the default build/test/runtime path;
- macOS `launchd` and Linux `systemd --user` services;
- API-key-authenticated generic agent routes for Responses (`/v1/agent/responses`) and OpenAI-compatible Chat Completions (`/v1/chat/completions`);
- transport-neutral generic task identity for continuation bookkeeping without browser-page affinity: every completed model generation gets a fresh Temporary Chat, while Responses still restores private continuation state across `previous_response_id` and harnesses may provide `X-LCA-Task-ID` when they need a stable task label;
- the same lazy frozen-context/connector path as LCA Codex, independent of whether a generic request advertises structured tools, while tool brokering remains limited to the exact authenticated request registry;
- the existing Codex transport as a compatibility adapter on the legacy `/v1/responses` surface.

One migration item is intentionally still visible internally: the compatibility adapter lives under `src/adapters/lca-codex`. The public ChatGPT connector meta-tools now use the agent-neutral `agent_*` namespace instead of inheriting `codex_*` names from the compatibility adapter.

Generic-agent compaction is intentionally owned by the outer harness. LCA Token does not impose a generic context limit or auto-compact policy. Helper summarization calls and normal task turns alike use isolated Temporary Chats; retained history/checkpoint state comes from the harness/lazy-context machinery rather than a persistent ChatGPT browser transcript. Codex compatibility compaction continues to use its native compatibility path.

## Requirements

- LCA Token requires Bun 1.3.14. Use that pinned version for source runs and repository checks.
- An installed Chrome or Chromium executable. API inference intentionally runs normal Chrome with `headless: false`; the window is placed off-screen on desktop systems and rendered inside Xvfb on Linux servers. LCA Token does not use stealth/fingerprint spoofing or solve human-verification challenges.
- Linux server deployments need `xvfb-run` (normally from the `xvfb` package) plus `xauth`. The managed `systemd --user` service wraps the daemon in Xvfb automatically.
- A ChatGPT account/session that can use the required ChatGPT Web features.
- An OpenAI tunnel plus runtime key for the ChatGPT connector bridge.

LCA Token is unofficial browser automation, not the OpenAI API. ChatGPT UI changes can break it, and using ChatGPT through a browser remains subject to the account's plan, workspace policy, usage limits, and applicable OpenAI terms.

## State isolation

The default profile lives under:

```text
~/.lca-token/
├── active-profile
└── profiles/
    └── default/
        ├── config.json
        ├── browser/
        │   └── storage-state.json
        ├── runtime/
        │   └── turn-broker.sock
        ├── tunnel/
        ├── logs/
        └── secrets/
            ├── api-token
            └── runtime.key
```

LCA Token does not read `~/.lca-codex` by default and does not attach to the user's normal Chrome profile. Each profile owns its own state:

```bash
make profile-create NAME=work
make profile-use NAME=work
make profile-list
```

For containers or servers:

```bash
export LCA_TOKEN_HOME=/var/lib/lca-token
export LCA_TOKEN_PROFILE=default
```

## Run and test from source

```bash
bun install
make typecheck
make test-safe
make run
```

`make` and `make run` both open the Control Center against the normal `~/.lca-token` profile state. `make tui` explicitly requires an interactive terminal. Run `make help` to see the complete supported command facade. There is no separate dev/build runtime state, global CLI installation, or desktop-app build step.

## Setup

For normal interactive setup, launch the TUI:

```bash
make
```

or jump directly into the guided setup flow:

```bash
make setup
```

The Setup Wizard walks through profile selection, the one-time unofficial-software acknowledgement, loopback port, connector name, Chromium path, tunnel id, and private runtime-key import. Setup always enables broker-scoped ChatGPT **Allow once** confirmation handling, overwrites the selected profile configuration, interrupts any active turns owned by a loaded daemon, and restarts the runtime automatically. ChatGPT authentication is completed separately from the Control Center by logging in through an isolated LCA Token Chrome profile or by importing verified storage state. Secrets are entered through hidden input, existing API key values are never displayed, and a newly created `lcat_...` API key is shown only once.

After setup, `make` opens the Control Center for ChatGPT authentication, the unified runtime-stack lifecycle, API-token rotation/revocation, profiles, connector setup, doctor/health checks, and advanced maintenance. `start`, `stop`, and `restart` always operate on the daemon and tunnel/MCP runtime together; there is no normal lifecycle path that refreshes only one half of the stack. Stop/restart remains authoritative: active browser work is drained/cancelled when possible, then the daemon is stopped, the tunnel service/runtime is stopped, and restart brings up a fresh daemon followed by a fresh tunnel/MCP worker. Start/restart returns success only after the matching `/healthz` payload reports both `accepting_turns=true` and `broker_ready=true` and the tunnel reports healthy/ready. Foreground `serve` and the internal MCP transport remain CLI-only because starting either inside the Control Center would replace/block the TUI rather than provide an interactive management action.

For automation and non-interactive servers, the existing CLI surface remains available. For example:

```bash
make profile-create NAME=server
make profile-use NAME=server

make setup ARGS='--tunnel-id tunnel_0123456789abcdef0123456789abcdef --runtime-key-file /secure/path/tunnel-runtime.key --acknowledge-unofficial'
```

Setup keeps the listener on `127.0.0.1`, defaults to port `8317`, installs the profile-specific service on macOS/Linux, and creates one `lcat_...` API key if the profile does not already have one. A newly created key is printed once; store it as a credential.

Useful lifecycle commands:

```bash
make status
make doctor
make start
make stop
make restart
```

These are stack-level commands: `make restart` restarts both the daemon and the managed tunnel/MCP worker, so connector tool-schema or MCP-server changes cannot remain pinned in an older tunnel process. The legacy `service-start|stop|restart` and `tunnel-start|stop|restart` Make targets are compatibility aliases to the same full-stack lifecycle, not partial restarts.

`make status` is the compact day-to-day snapshot: runtime readiness, ChatGPT authentication, API-key presence, tunnel readiness, the local generic agent endpoints (`GET /v1/agent/models`, `POST /v1/agent/responses`, and `POST /v1/chat/completions`), and the Codex compatibility endpoints (`GET /v1/models`, `POST /v1/responses`, `POST /v1/responses/compact`, and `POST /v1/alpha/search`). Copy-ready curl examples remain focused on the generic agent routes and use `$LCA_API_KEY` rather than printing the stored credential. `make doctor` remains the deeper diagnostic path for configuration validity, Chrome/login-state permissions, managed services, tunnel installation/key checks, runtime readiness, and connector guidance.

When standard input/output are not attached to a terminal, `make run` prints the underlying CLI help rather than trying to enter the TUI. Use `make tui` when an interactive terminal is required explicitly.

On Linux, service management uses `systemd --user`. For a user service that must survive logout/start at boot, configure systemd user lingering according to your server policy, for example with an administrator-approved `loginctl enable-linger <user>`.

The Linux managed service launches the daemon as `xvfb-run -a ... serve`, so an EC2/VPS host does not need GNOME, KDE, VNC, RDP, or a physical display. On Debian/Ubuntu-family servers, install the virtual-display prerequisites before service setup, for example `sudo apt-get install -y xvfb xauth`. If you run the daemon or an auth import manually outside systemd on a GUI-less Linux shell, wrap that command too: `xvfb-run -a make serve` or `xvfb-run -a make auth-import FILE=./chatgpt-storage-state.json`.

## ChatGPT authentication

On a desktop machine, the normal path is the Control Center:

```bash
make
```

Choose **ChatGPT authentication → Login to ChatGPT**. LCA Token opens Chrome with a dedicated temporary `--user-data-dir` under the selected LCA Token profile. Sign in normally and leave that Chrome window open once the ChatGPT composer is visible. Return to the terminal/TUI and press Enter; LCA Token then closes only its dedicated Chrome process. LCA Token does not attach to your normal Chrome profile and does not remote-control the login flow. The remaining profile inspection and portable-state verification stay inside this desktop-only `auth-login` boundary, after which LCA Token writes the Playwright storage state for the active profile and removes the temporary login profile. If verification fails, the previous verified session is left untouched.

The same local login flow is available from the Makefile facade:

```bash
make auth-status
make auth-login
make auth-logout
```

`auth-login` is intended for a machine with a usable desktop session. It is not a public login endpoint and does not expose a remote browser controller, OAuth callback listener, Xvfb login display, or one-time login URL.

### Server credential transfer

LCA Token does not perform interactive ChatGPT/Google login on the server. Authentication state is transferred explicitly:

```bash
make auth-status
make auth-export
make auth-export FILE=/secure/path/chatgpt-storage-state.json
make auth-import FILE=./chatgpt-storage-state.json
make auth-logout
```

`auth import` accepts a Playwright storage-state JSON file, launches the same normal headed Chrome renderer used by inference, verifies that the state reaches an authenticated temporary ChatGPT conversation, and only then stores it in the selected LCA Token profile. On a GUI-less Linux server, run the import under Xvfb as shown above. Invalid, expired, unauthenticated, or human-verification-challenged state fails closed.

`auth export` copies the already verified state from the selected profile to a destination file. With no `FILE`, it defaults to the profile-private `browser/exports/chatgpt-storage-state.json` path under `~/.lca-token/profiles/<profile>/`; pass `FILE=...` when you need a specific transfer location. A typical server workflow is: export from a trusted machine/profile that already holds a valid LCA Token session, transfer the file through a secure channel, then import it on the server. There is no one-time login URL, remote browser controller, Xvfb login display, or public auth ingress in this flow.

The exported storage-state file is an authentication credential. Keep it out of Git, logs, tickets, chat messages, and shared storage; protect it at least as carefully as a session cookie.

## API credentials

Generic API access is accepted only with a per-profile API key:

```bash
make api-key-status
make api-key-create
make api-key-rotate
make api-key-revoke
make api-key-path
```

`create` prints an API key only when no key exists. `rotate` replaces the key and prints the new value. The credential is stored in a user-only file under the selected profile. The on-disk filename remains `secrets/api-token` for state compatibility.

## Generic agent API

Use the generic base path:

```text
http://127.0.0.1:8317/v1/agent
```

The current generic endpoints are:

- `GET /v1/agent/models`
- `POST /v1/agent/responses`
- `POST /v1/chat/completions`

Model id:

```text
lca-token
```

Every generic request needs only the profile API key:

```http
Authorization: Bearer lcat_...
```

This is the only supported API credential transport; custom credential headers such as `X-LCA-Token` are not accepted. `X-LCA-Agent-Authority`, where used by a harness integration, remains a separate trusted-authority signal and is not an API credential.

Task identity is separate from authentication and tool authority. A harness that has its own stable task/session id may send it on either generic transport:

```http
X-LCA-Task-ID: harness-task-123
```

LCA Token normalizes that value to an opaque `lca-task-...` id and returns the normalized id in the same response header. `metadata.lca_task_id` is accepted as an equivalent body-level extension; on the Responses route the standard `conversation` id is also accepted as the same task-identity input. If more than one is supplied they must resolve to the same task. Task identity is continuation metadata only: it never reuses a completed Temporary Chat and grants no filesystem, network, sandbox, connector, or tool authority.

The standard Responses `tools` field is the exact harness-owned tool registry for that request. A tool-capable browser turn exposes only lazy connector meta-tools to ChatGPT; when ChatGPT asks for a harness tool, LCA Token emits an ordinary Responses `function_call`. The harness executes it under its own filesystem/sandbox policy and posts the matching `function_call_output` continuation. LCA Token keeps the in-flight execution identity internally so tool results can resume that same live browser generation; after the generation completes its Temporary Chat is closed. A later logical turn, even with the same `X-LCA-Task-ID`, starts a fresh Temporary Chat and reconstructs context from retained/lazy state. Callers do not configure Codex-specific `thread_id`, `turn_id`, `cwd`, roots, or sandbox fields.

Prompt text still has no authority to add tools or widen local access. Generic tools are executed by the outer harness, not by LCA Token under an invented local filesystem policy. Native Codex compatibility turns continue to obtain filesystem and sandbox authority from trusted Codex metadata.

For harnesses that use the traditional OpenAI-compatible Chat Completions transport (for example a custom provider expecting `messages` and `choices`), point the provider at the same LCA Token base URL and call `POST /v1/chat/completions`. The adapter supports text/system/developer/user/assistant/tool history, function tools and tool results, `tool_choice`, common sampling/token fields, normal JSON responses, and `text/event-stream` Chat Completions chunks. It normalizes those shapes onto the same generic Responses core, so API authentication, task identity, lazy context, configured connector selection, and harness-owned tool authority use the same model. Chat Completions itself has no standard thread id, so `X-LCA-Task-ID` remains the robust task label across compaction/history rewrites, while the transcript-prefix heuristic remains a backward-compatible fallback. A structured `tool` result that answers a function call emitted by the immediately active generation resumes that same browser execution; once that generation completes, the Temporary Chat is closed, and the next logical prompt always starts a fresh Temporary Chat.

Some agent harnesses, including Cline-style providers, describe their tool protocol as ordinary system-prompt text and expect the model to emit XML-style tool markup rather than OpenAI `tools` / function calls. On the Chat Completions route LCA Token preserves that textual output protocol instead of replacing it with a read-only conversational answer. The markup is still only model output for the outer harness to parse: it does not grant LCA Token filesystem, network, sandbox, or callable-tool authority. Structured tools remain authorized only by the authenticated request's actual `tools` registry.

### Curl examples for every Agent API endpoint

Set the profile API key once:

```bash
export LCA_API_KEY='lcat_REDACTED'
```

`GET /v1/agent/models`:

```bash
curl -sS http://127.0.0.1:8317/v1/agent/models \
  -H "Authorization: Bearer $LCA_API_KEY"
```

`POST /v1/agent/responses`:

```bash
curl -sS http://127.0.0.1:8317/v1/agent/responses \
  -H "Authorization: Bearer $LCA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"lca-token",
    "stream":false,
    "input":"Inspect the project and summarize it"
  }'
```

`POST /v1/chat/completions`:

```bash
curl -sS http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer $LCA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"lca-token",
    "stream":false,
    "messages":[{"role":"user","content":"Say exactly: LCA Token API works"}]
  }'
```

Tool-capable Responses requests use the same endpoint and credential. For example:

```bash
curl -sS http://127.0.0.1:8317/v1/agent/responses \
  -H "Authorization: Bearer $LCA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"lca-token",
    "stream":true,
    "input":"Inspect the project and summarize it",
    "tools":[{
      "type":"function",
      "name":"read_file",
      "description":"Read one workspace file",
      "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}
    }]
  }'
```

Any harness that can speak the Responses tool-call loop and authenticate with the profile token can use this route. An adapter for another wire protocol can normalize its turns into the same HTTP contract without changing the browser worker.

## Codex compatibility

The legacy `/v1/responses`, `/v1/models`, compaction, native passthrough, and Codex environment extraction remain so the existing integration can be used while the core is generalized. Connector meta-tools are shared through the `agent_*` namespace rather than carrying Codex product naming into LCA Token.

The generic route does not trust Codex-shaped text. It trusts only the authenticated API control plane plus the declared Responses tool registry. The legacy Codex route continues to derive workspace/sandbox authority from verified native Codex wire metadata.

### Curl examples for every Codex compatibility endpoint

These routes preserve Codex's own Bearer credential rather than using the profile `lcat_...` API key. When testing them manually, set `CODEX_BEARER_TOKEN` to the Bearer credential supplied by Codex for the compatibility request:

```bash
export CODEX_BEARER_TOKEN='REDACTED'
```

`GET /v1/models`:

```bash
curl -sS http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer $CODEX_BEARER_TOKEN"
```

`POST /v1/responses`:

```bash
curl -sS http://127.0.0.1:8317/v1/responses \
  -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"lca-token",
    "stream":false,
    "input":"Say exactly: LCA Token Codex route works"
  }'
```

`POST /v1/responses/compact`:

```bash
curl -sS http://127.0.0.1:8317/v1/responses/compact \
  -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"lca-token",
    "input":[{
      "type":"message",
      "role":"user",
      "content":[{"type":"input_text","text":"Summarize this context"}]
    }]
  }'
```

`POST /v1/alpha/search`:

```bash
curl -sS http://127.0.0.1:8317/v1/alpha/search \
  -H "Authorization: Bearer $CODEX_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"OpenAI Codex"}'
```

## Connector and tunnel

The tunnel is outbound; LCA Token does not open a public inbound connector port. After tunnel setup, attach the configured tunnel to the matching ChatGPT connector from a GUI-capable ChatGPT session:

```bash
make connector-status
make connector-setup
```

Browser confirmation clicks are not the security authority. LCA Token enables mechanical ChatGPT per-call **Allow once** confirmation by default, but only after the turn broker has already constrained the invocation to the authenticated registry. This does not grant filesystem or tool authority outside the harness registry.

## Server deployment notes

- The built-in HTTP listener is intentionally loopback-only and has no TLS termination.
- Do not bind it directly to the public Internet. If a remote harness must reach it, use a separately administered authenticated/TLS transport such as a private network, SSH tunnel, or hardened reverse proxy while preserving the LCA API key.
- Keep `~/.lca-token` or `LCA_TOKEN_HOME` private to the service account.
- Treat `browser/storage-state.json`, `secrets/api-token`, and the tunnel runtime key as credentials.
- A compromised process running as the same service account is inside the local trust boundary.
- Xvfb removes the physical desktop/monitor dependency on Linux; it does not make browser automation a supported OpenAI API contract.

## Development boundaries

The migration direction is:

```text
src/core/                  neutral turn + tool abstractions
src/browser/chatgpt/       target location for browser-only runtime code
src/transports/            target location for Responses / connector transports
src/harness/codex/         target location for Codex compatibility
```

The repository has not completed that physical move yet. Current browser/broker code still lives under `src/adapters/lca-codex`; generic tool-environment abstractions live under `src/core/agent.ts` and enter the adapter through an agent-neutral turn environment.

See [Architecture](docs/architecture.md) and [Security model](docs/security-model.md) for the exact trust and tool-flow contracts.

## Disclaimer

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with accounts, workspaces, tools, and data you are authorized to access, and do not use it to evade usage limits or access controls.
