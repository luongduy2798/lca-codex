.PHONY: install setup setup-browser dev start app launcher serve doctor package smoke

BUN ?= bun

install:
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
