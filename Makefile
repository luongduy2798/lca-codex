.DEFAULT_GOAL := dev

.PHONY: check-bun install dev app test typecheck verify package smoke help

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

test: check-bun
	$(BUN) run test
	$(BUN) run launcher:test

typecheck: check-bun
	$(BUN) run typecheck
	$(BUN) run launcher:typecheck

verify: check-bun
	$(BUN) run verify

package: check-bun
	$(BUN) run app:package

smoke: check-bun
	$(BUN) run app:smoke

help:
	@printf '%s\n' \
		'make dev       Run the Electron app in development mode' \
		'make install   Install root and launcher dependencies' \
		'make test      Run core and launcher tests' \
		'make typecheck Run core and launcher typechecks' \
		'make verify    Run the full repository verification' \
		'make package   Build the packaged Electron app' \
		'make smoke     Smoke-test the packaged Electron app'
