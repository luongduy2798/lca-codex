.DEFAULT_GOAL := run

.PHONY: check-bun install run tui setup cli \
	auth-status auth-login auth-import auth-export auth-logout \
	status doctor doctor-json start stop restart \
	service-status service-install service-start service-restart service-stop service-cancel-turns \
	tunnel-status tunnel-start tunnel-restart tunnel-stop tunnel-key-import \
	connector-status connector-setup \
	api-key-status api-key-create api-key-rotate api-key-revoke api-key-path \
	api-token-status api-token-create api-token-rotate api-token-revoke api-token-path \
	profile-show profile-list profile-create profile-use config-path browser-check serve \
	open-tunnels open-runtime-keys open-connectors uninstall \
	test test-safe typecheck verify help

BUN ?= bun
BUN_VERSION ?= 1.3.14
BUN_PATH := $(shell command -v $(BUN) 2>/dev/null)
BUN_ACTUAL_VERSION := $(shell $(BUN) --version 2>/dev/null)
CLI = $(BUN) run src/cli.ts $(if $(strip $(LCA_HOME)),--home "$(LCA_HOME)") $(if $(strip $(PROFILE)),--profile "$(PROFILE)")

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

run: check-bun
	$(CLI)

tui: check-bun
	$(CLI) tui

setup: check-bun
	$(CLI) setup $(ARGS)

cli: check-bun
	$(CLI) $(ARGS)

auth-status: check-bun
	$(CLI) auth status

auth-login: check-bun
	$(CLI) auth login

auth-import: check-bun
	@if [ -z "$(strip $(FILE))" ]; then echo 'Usage: make auth-import FILE=/path/to/storage-state.json'; exit 2; fi
	$(CLI) auth import "$(FILE)"

auth-export: check-bun
	$(CLI) auth export $(if $(strip $(FILE)),"$(FILE)")

auth-logout: check-bun
	$(CLI) auth logout

status: check-bun
	$(CLI) status

doctor: check-bun
	$(CLI) doctor

doctor-json: check-bun
	$(CLI) doctor --json

start: check-bun
	$(CLI) start

stop: check-bun
	$(CLI) stop

restart: check-bun
	$(CLI) restart

service-status: check-bun
	$(CLI) service status

service-install: check-bun
	$(CLI) service install

service-start: start

service-restart: restart

service-stop: stop

service-cancel-turns: check-bun
	$(CLI) service cancel-turns

tunnel-status: check-bun
	$(CLI) tunnel status

tunnel-start: start

tunnel-restart: restart

tunnel-stop: stop

tunnel-key-import: check-bun
	$(CLI) tunnel key-import

connector-status: check-bun
	$(CLI) connector status

connector-setup: check-bun
	$(CLI) connector setup

api-key-status: check-bun
	$(CLI) api key status

api-key-create: check-bun
	$(CLI) api key create

api-key-rotate: check-bun
	$(CLI) api key rotate

api-key-revoke: check-bun
	$(CLI) api key revoke

api-key-path: check-bun
	$(CLI) api key path

# Backward-compatible aliases for scripts using the old naming.
api-token-status: api-key-status
api-token-create: api-key-create
api-token-rotate: api-key-rotate
api-token-revoke: api-key-revoke
api-token-path: api-key-path

profile-show: check-bun
	$(CLI) profile show

profile-list: check-bun
	$(CLI) profile list

profile-create: check-bun
	@if [ -z "$(strip $(NAME))" ]; then echo 'Usage: make profile-create NAME=work'; exit 2; fi
	$(CLI) profile create "$(NAME)"

profile-use: check-bun
	@if [ -z "$(strip $(NAME))" ]; then echo 'Usage: make profile-use NAME=work'; exit 2; fi
	$(CLI) profile use "$(NAME)"

config-path: check-bun
	$(CLI) config path

browser-check: check-bun
	$(CLI) browser check

serve: check-bun
	$(CLI) serve

open-tunnels: check-bun
	$(CLI) open tunnels

open-runtime-keys: check-bun
	$(CLI) open runtime-keys

open-connectors: check-bun
	$(CLI) open connectors

uninstall: check-bun
	$(CLI) uninstall $(ARGS)

test: check-bun
	$(BUN) run test

test-safe: check-bun
	@set -e; \
	root="$$(mktemp -d "$${TMPDIR:-/tmp}/lca-token-test.XXXXXX")"; \
	trap 'rm -rf "$$root"' EXIT; \
	mkdir -p "$$root/home" "$$root/lca" "$$root/codex"; \
	echo "Running tests with isolated HOME=$$root/home"; \
	HOME="$$root/home" LCA_TOKEN_HOME="$$root/lca" LCA_TOKEN_PROFILE="test" CODEX_HOME="$$root/codex" $(BUN) run test

typecheck: check-bun
	$(BUN) run typecheck

verify: check-bun
	$(BUN) run verify

help:
	@printf '%s\n' \
		'LCA Token user commands' \
		'' \
		'  make                         Open the Control Center TUI' \
		'  make run | make tui          Open the same TUI/profile state' \
		'  make setup [ARGS="..."]      Open Setup Wizard; ARGS enables CLI setup options' \
		'  make status                   Show quick runtime/auth/tunnel status and API endpoints' \
		'  make doctor                   Run full diagnostic checks' \
		'  make doctor-json              Run doctor checks as JSON' \
		'' \
		'Authentication' \
		'  make auth-status' \
		'  make auth-login                 Open an isolated Chrome profile and sign in to ChatGPT' \
		'  make auth-import FILE=/path/to/storage-state.json' \
		'  make auth-export [FILE=/path/to/storage-state.json]' \
		'  make auth-logout' \
		'' \
		'Runtime stack' \
		'  make start | make stop | make restart   Manage daemon + tunnel/MCP together' \
		'  make service-status | make service-install | make service-cancel-turns' \
		'' \
		'Tunnel / connector' \
		'  make tunnel-status' \
		'  make tunnel-key-import        Prompt for the runtime key without echoing it' \
		'  make connector-status | make connector-setup' \
		'  make open-tunnels | make open-runtime-keys | make open-connectors' \
		'' \
		'API key' \
		'  make api-key-status | make api-key-create | make api-key-rotate' \
		'  make api-key-revoke | make api-key-path' \
		'' \
		'Profiles / config' \
		'  make profile-show | make profile-list' \
		'  make profile-create NAME=work | make profile-use NAME=work' \
		'  make config-path | make browser-check | make serve' \
		'  make uninstall [ARGS="--keep-data"]' \
		'' \
		'Global target options' \
		'  PROFILE=work                  Run a target against one profile without switching active profile' \
		'  LCA_HOME=/path                Override ~/.lca-token for one target' \
		'  make cli ARGS="..."           Escape hatch for any source CLI subcommand' \
		'' \
		'Development / verification' \
		'  make install                  Install runtime dependencies' \
		'  make test                     Run core tests' \
		'  make test-safe                Run tests with HOME/runtime state isolated from live runtimes' \
		'  make typecheck                Run the core TypeScript typecheck' \
		'  make verify                   Run the full source verification'
