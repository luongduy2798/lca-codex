.DEFAULT_GOAL := dev

.PHONY: check-bun install dev app build test test-safe typecheck verify package smoke release release-patch release-minor release-major help

BUN ?= bun
BUN_VERSION ?= 1.3.14
BUN_PATH := $(shell command -v $(BUN) 2>/dev/null)
BUN_ACTUAL_VERSION := $(shell $(BUN) --version 2>/dev/null)

check-bun:
	@if [ -z "$(BUN_PATH)" ]; then \
		echo "Error: Bun $(BUN_VERSION) is required but was not found."; \
		echo "Install it with:"; \
		echo '  curl -fsSL https://bun.com/install | bash -s "bun-v$(BUN_VERSION)"'; \
		exit 1; \
	fi
	@if [ "$(BUN_ACTUAL_VERSION)" != "$(BUN_VERSION)" ]; then \
		echo "Error: Bun $(BUN_VERSION) is required, but $(BUN_ACTUAL_VERSION) is installed."; \
		echo "Install the required version with:"; \
		echo '  curl -fsSL https://bun.com/install | bash -s "bun-v$(BUN_VERSION)"'; \
		exit 1; \
	fi

install: check-bun
	$(BUN) install
	$(BUN) install --cwd launcher

dev: check-bun
	$(BUN) run app

app: dev

build: check-bun
	$(BUN) run app:package

test: check-bun
	$(BUN) run test
	$(BUN) run launcher:test

test-safe: check-bun
	@set -e; \
	root="$$(mktemp -d "$${TMPDIR:-/tmp}/lca-codex-test.XXXXXX")"; \
	trap 'rm -rf "$$root"' EXIT; \
	mkdir -p "$$root/home" "$$root/lca" "$$root/codex"; \
	echo "Running tests with isolated HOME=$$root/home"; \
	HOME="$$root/home" LCA_CODEX_HOME="$$root/lca" CODEX_HOME="$$root/codex" $(BUN) run test; \
	HOME="$$root/home" LCA_CODEX_HOME="$$root/lca" CODEX_HOME="$$root/codex" $(BUN) run launcher:test

typecheck: check-bun
	$(BUN) run typecheck
	$(BUN) run launcher:typecheck

verify: check-bun
	$(BUN) run verify

package: build

smoke: check-bun
	$(BUN) run app:smoke

release: check-bun
	$(BUN) run scripts/release.ts current

release-patch: check-bun
	$(BUN) run scripts/release.ts patch

release-minor: check-bun
	$(BUN) run scripts/release.ts minor

release-major: check-bun
	$(BUN) run scripts/release.ts major

help:
	@printf '%s\n' \
		'make dev       Run the Electron app in development mode' \
		'make install   Install root and launcher dependencies' \
		'make build     Build the packaged Electron app' \
		'make test      Run core and launcher tests' \
		'make test-safe Run tests with HOME/runtime state isolated from the live launcher' \
		'make typecheck Run core and launcher typechecks' \
		'make verify    Run the full repository verification' \
		'make package   Alias for make build' \
		'make smoke     Smoke-test the packaged Electron app' \
		'make release   Verify and release the current version without bumping it' \
		'make release-patch Bump x.y.Z, verify, commit, tag, and trigger GitHub Release' \
		'make release-minor Bump x.Y.0, verify, commit, tag, and trigger GitHub Release' \
		'make release-major Bump X.0.0, verify, commit, tag, and trigger GitHub Release'
