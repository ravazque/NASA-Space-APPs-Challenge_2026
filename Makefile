.DEFAULT_GOAL := help

PORT     ?= 8000
HUB_PORT ?= 8090
SIM      ?= storm_eva
PY       := app/.venv/bin/python
PKGS     := rasterio numpy pillow
HUB_NM   := app/hub/node_modules
HUB      := node app/hub/server.mjs --port $(HUB_PORT) $(if $(TOKEN),--token $(TOKEN))
TEST     := node --test app/web/*.test.mjs app/hub/*.test.mjs

JDK          ?= $(firstword $(wildcard /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/temurin-21-jdk-amd64 /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21) /usr/lib/jvm/java-21-openjdk)
ANDROID_HOME ?= $(firstword $(wildcard $(HOME)/Android/Sdk /opt/android-sdk /opt/homebrew/share/android-commandlinetools) $(HOME)/Android/Sdk)
APK          := android/app/build/outputs/apk/debug/app-debug.apk

.PHONY: help up serve hub sim test data tiles android-sync apk clean fclean android-sdk

help: ## List the commands
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-13s %s\n", $$1, $$2}'

up: $(HUB_NM) ## Install, test and start the hub (app + LAN sync + QR)
	$(TEST)
	$(HUB)

serve: ## Serve the app on :8000 without sync (solo mode, needs only Python)
	@echo "→ ARIADNE on http://localhost:$(PORT)  (solo mode · ?lang=es for Spanish)"
	@python3 -m http.server -d app/web $(PORT)

hub: $(HUB_NM) ## Start the LAN hub on :8090: app, sync, QR (TOKEN=secret protects the Base role)
	$(HUB)

sim: $(HUB_NM) ## Hub + simulated crew, rover and dust storm (SIM=storm_eva)
	$(HUB) --sim $(SIM) --data app/hub/data-sim --reset

test: $(HUB_NM) ## Node tests: unit + LAN e2e on a free port (~15 s)
	$(TEST)

data: $(PY) $(HUB_NM) ## Rebuild data from NASA sources (needs network), then test
	cd app/pipeline && for s in fetch_data fetch_pov fetch_meda build_grid fetch_meda_sols build_terrain; do \
	  ../.venv/bin/python $$s.py || exit 1; done
	$(TEST)

tiles: $(PY) ## Download Mars Trek HiRISE tiles z13-z17 for the area (WebP)
	cd app/pipeline && ../.venv/bin/python fetch_tiles.py

android-sync: node_modules ## Copy app/web into the Android project
	npx cap sync android

apk: android-sdk android-sync ## Build the debug APK (installs SDK pieces and npm deps if missing)
	cd android && JAVA_HOME="$(JDK)" ANDROID_HOME="$(ANDROID_HOME)" ./gradlew assembleDebug
	@echo "✓ $(APK)  ·  install: adb install -r $(APK)"

clean: ## Remove local envs, node_modules and build outputs (keeps data and tiles)
	rm -rf app/.venv app/pipeline/__pycache__ node_modules $(HUB_NM) android/app/build test-results playwright-report

fclean: clean ## clean + downloads, tiles, hub logs and Gradle cache (then: make data tiles)
	rm -rf app/data/raw app/data/cache app/web/tiles app/hub/data app/hub/data-sim android/.gradle \
	  "$${ARIADNE_CACHE:-$${TMPDIR:-/tmp}/ariadne_meda_cache}"

$(PY):
	@if command -v uv >/dev/null; then uv venv -q app/.venv && uv pip install -q --python $(PY) $(PKGS); \
	else python3 -m venv app/.venv && $(PY) -m pip install -q $(PKGS); fi
	@echo "✓ dependencies in app/.venv"

$(HUB_NM): app/hub/package-lock.json
	@command -v npm >/dev/null || { echo "! Node 20+ is not installed"; exit 1; }
	npm ci --prefix app/hub
	@touch $@

node_modules: package-lock.json
	@command -v npm >/dev/null || { echo "! Node 20+ is not installed"; exit 1; }
	npm ci
	@touch $@

android-sdk:
	@[ -x "$(JDK)/bin/java" ] || { echo "! JDK 21 not found at $(JDK): install it or pass JDK=..."; exit 1; }
	@[ -d "$(ANDROID_HOME)/platforms/android-35" ] && exit 0; \
	SDKM="$(ANDROID_HOME)/cmdline-tools/latest/bin/sdkmanager"; \
	[ -x "$$SDKM" ] || { echo "! sdkmanager not found in $(ANDROID_HOME): install Android cmdline-tools or pass ANDROID_HOME=..."; exit 1; }; \
	export JAVA_HOME="$(JDK)"; yes | "$$SDKM" --licenses >/dev/null 2>&1; \
	"$$SDKM" "platform-tools" "platforms;android-35" "build-tools;35.0.0"
