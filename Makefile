.PHONY: check-bun install setup setup-browser dev start app launcher serve doctor package smoke

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

setup:
	$(BUN) run setup --full

setup-browser:
	$(BUN) run setup --browser-only

dev:
	$(BUN) run launcher:dev

start: app

app:
	$(BUN) run app

launcher:
	$(BUN) run launcher

serve:
	$(BUN) run start

doctor:
	$(BUN) run doctor

package:
	$(BUN) run app:package

smoke:
	$(BUN) run app:smoke
