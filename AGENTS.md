# AGENTS.md

These instructions apply to the entire repository.

For architecture or security-sensitive changes, read:

- `docs/architecture.md`
- `docs/security-model.md`

Keep this file focused on operational rules and invariants. Do not duplicate
large sections of the architecture documentation here.

## Runtime safety

This repository may be used while an LCA Token daemon is actively serving the
current Codex task. Treat the live runtime as user state.

### Tests

**Always run repository tests with:**

```bash
make test-safe
```

Do not run test suites directly with commands such as:

```bash
make test
bun test
bun run test
```

`make test-safe` isolates `HOME`, `LCA_TOKEN_HOME`, `LCA_TOKEN_PROFILE`, and
`CODEX_HOME` so tests cannot accidentally operate on live runtime state.

Do not bypass this rule just to run a smaller or faster subset of tests.

`make typecheck` is safe for type checking.

Use `bun run verify` only when full repository verification is actually
required; its test stages isolate runtime state internally.

### Live processes

Do not stop, restart, replace, or kill a running Responses daemon, managed
browser, tunnel, or Codex integration unless the user explicitly requests that
lifecycle operation.

Do not use broad process commands such as `pkill`, `killall`, or unrelated
`launchctl bootout` operations to make a test pass.

If the current Codex turn depends on the live runtime, restarting that runtime
can terminate the turn itself. Inspect process ownership and runtime state
before lifecycle debugging.

## Browser and connector invariants

ChatGPT Web is an unstable browser UI. DOM replacement or temporary DOM absence
is not by itself proof that a running turn disconnected.

Browser/UI drift must fail explicitly. Do not silently:

- switch model;
- switch transport;
- fall back to another provider;
- fabricate completion;
- retry in a way that can duplicate already-emitted final-answer text.

Once final-answer bytes have been emitted into the Codex Responses stream, they
are append-only and must never require retraction.

For connector/tool turns, visible ChatGPT Markdown may remain mutable while
tool execution is active.

Preserve retry and completion invariants documented in `docs/architecture.md`.

## Validation expectations

For normal code changes, run at minimum:

```bash
make test-safe
git diff --check
```

Run `make typecheck` when TypeScript/type boundaries are affected.

Changes involving browser automation, connector streaming, completion
detection, runtime lifecycle, or tool bridging should include regression tests
for the reproduced failure.

For browser/runtime bugs, unit tests are necessary but may not be sufficient.
When practical, validate against a restarted runtime and a real connector turn.

Do not report a bug as fixed until the evidence covers the failure mode being
discussed. Clearly distinguish:

- unit/regression tests passing;
- isolated browser/runtime probes passing;
- restarted-runtime validation;
- real end-to-end connector validation.

When debugging browser failures, preserve and inspect trace-specific diagnostics
under the LCA Codex diagnostics directory instead of deleting evidence
prematurely.

## Git and worktree safety

Before making changes, inspect:

```bash
git status --short
git branch --show-current
```

Preserve existing user changes and unrelated dirty files. Keep patches scoped
to the requested task.

Do not use destructive commands such as:

```bash
git reset --hard
git clean -fd
git checkout -- .
git restore .
```

unless the user explicitly requests that destructive operation.

Do not revert unrelated changes just to obtain a clean worktree.

## Dependencies and tooling

The repository pins Bun exactly. Use the version declared in `package.json` and
enforced by the Makefile and CI.

Do not substitute npm, pnpm, or yarn for Bun unless the project configuration is
intentionally being changed.

Prefer repository commands from the Makefile/package scripts over ad-hoc
equivalents because they encode project-specific safety behavior.

Generated/runtime directories such as these should not be committed:

- `node_modules/`
- generated `dist/` output

Respect `.gitignore` and verify generated artifacts before staging.

## Versioning

The root `package.json` version is the project version.

Update `CHANGELOG.md` for notable behavior changes when the changelog exists on
the branch. Do not bump versions unless the task calls for it.

## Release safety

The repository does not have an automated package/release workflow. Publishing
or tagging remains an explicit external side effect.

A request to prepare code, bump a version, update a changelog, or create a
release branch is **not** permission to publish a release.

Never merge to `main`, create a release tag, or push a release merely because
the branch appears ready.

## Security invariants

Preserve the security boundaries documented in `docs/security-model.md`.

In particular:

- runtime HTTP/control listeners remain loopback-only;
- never put API keys, tunnel credentials, browser state, bearer tokens, or
  other secrets into logs, command-line arguments, generated profiles, tests,
  or Git;
- preserve turn-scoped capability boundaries;
- do not weaken approval behavior to make automation easier;
- do not retry or switch modes to evade product usage limits;
- fail closed when required runtime/connector identity cannot be verified.

## Repository layout

- Core bridge/runtime code: `src/`
- ChatGPT/Codex browser adapter: `src/adapters/lca-codex/`
- Core tests: `tests/`
- Architecture and security contracts: `docs/`
