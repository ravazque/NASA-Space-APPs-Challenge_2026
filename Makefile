PORT     ?= 8000
HUB_PORT ?= 8090
SIM      ?= storm_eva
PY       := app/.venv/bin/python
PKGS     := rasterio numpy pillow

JAVA_HOME    ?= $(firstword $(wildcard /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21 /usr/lib/jvm/temurin-21-jdk-amd64) /opt/homebrew/opt/openjdk@21)
ANDROID_HOME ?= /opt/homebrew/share/android-commandlinetools
APK          := android/app/build/outputs/apk/debug/app-debug.apk

.PHONY: help up serve hub sim test e2e data tiles android-sync apk clean deps hub-deps android-sdk

help: ## List the commands
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-13s %s\n", $$1, $$2}'

up: hub-deps test hub ## Install, test and start the hub (app + LAN sync + QR)

serve: ## Serve the app on :8000 without sync (solo mode)
	@echo "→ ARIADNE on http://localhost:$(PORT)  (solo mode · ?lang=es for Spanish)"
	@python3 -m http.server -d app/web $(PORT)

hub: hub-deps ## Start the LAN hub on :8090: app, sync, QR to join
	node app/hub/server.mjs --port $(HUB_PORT)

sim: hub-deps ## Hub + simulated crew, rover and dust storm (SIM=storm_eva)
	node app/hub/server.mjs --port $(HUB_PORT) --sim $(SIM) --data app/hub/data-sim --reset

test: ## Node unit tests: engine, Mars24, environment, sync, locks, log, profiles, i18n
	@command -v node >/dev/null || { echo "! node is not installed (Node 20+ needed)"; exit 1; }
	@[ -d app/hub/node_modules ] || echo "- hub tests skipped: run 'make hub-deps' first"
	node --test $(wildcard app/web/*.test.mjs) $$([ -d app/hub/node_modules ] && ls app/hub/*.test.mjs 2>/dev/null)

e2e: hub-deps node_modules ## Playwright: two browser contexts through a test hub on :8091
	npx playwright install chromium
	npx playwright test

data: deps ## Rebuild data from NASA sources (needs network): grid, MEDA sols, terrain
	cd app/pipeline && ../.venv/bin/python fetch_data.py && ../.venv/bin/python fetch_pov.py \
	&& ../.venv/bin/python fetch_meda.py && ../.venv/bin/python build_grid.py \
	&& ../.venv/bin/python fetch_meda_sols.py && ../.venv/bin/python build_terrain.py
	@$(MAKE) --no-print-directory test

tiles: deps ## Download Mars Trek HiRISE tiles z13-z17 for the area (WebP)
	cd app/pipeline && ../.venv/bin/python fetch_tiles.py

android-sync: node_modules ## Copy app/web into the Android project
	npx cap sync android

apk: android-sdk android-sync ## Build the debug APK locally (JDK 21 + Android SDK)
	@[ -x "$(JAVA_HOME)/bin/java" ] || { echo "! JDK 21 not found: brew install openjdk@21 (or set JAVA_HOME)"; exit 1; }
	@[ -d "$(ANDROID_HOME)/platforms/android-35" ] || { echo "! Android SDK missing: brew install --cask android-commandlinetools, then make android-sdk"; exit 1; }
	cd android && JAVA_HOME="$(JAVA_HOME)" ANDROID_HOME="$(ANDROID_HOME)" ./gradlew assembleDebug
	@echo "✓ $(APK)  ·  install: adb install -r $(APK)"

clean: ## Remove local envs, node_modules and build outputs (keeps data and tiles)
	rm -rf app/.venv app/pipeline/__pycache__ node_modules app/hub/node_modules android/app/build test-results playwright-report

deps: $(PY)

$(PY):
	@if command -v uv >/dev/null; then uv venv -q app/.venv && uv pip install -q --python $(PY) $(PKGS); \
	else python3 -m venv app/.venv && $(PY) -m pip install -q $(PKGS); fi
	@echo "✓ dependencies in app/.venv"

hub-deps:
	@[ ! -f app/hub/package.json ] || [ -d app/hub/node_modules ] || npm ci --prefix app/hub

node_modules: package-lock.json
	npm ci
	@touch node_modules

android-sdk:
	@SDKM="$(ANDROID_HOME)/cmdline-tools/latest/bin/sdkmanager"; \
	if [ -d "$(ANDROID_HOME)/platforms/android-35" ]; then :; \
	elif [ -x "$$SDKM" ] && [ -x "$(JAVA_HOME)/bin/java" ]; then \
	  export JAVA_HOME="$(JAVA_HOME)"; yes | "$$SDKM" --licenses >/dev/null 2>&1; \
	  "$$SDKM" "platform-tools" "platforms;android-35" "build-tools;35.0.0"; \
	else echo "! sdkmanager not found in $(ANDROID_HOME): brew install --cask android-commandlinetools"; fi
