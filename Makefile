PORT ?= 8000
PY   := app/.venv/bin/python
PKGS := rasterio numpy pillow

.PHONY: up deps test serve data clean

up: deps test serve

deps: $(PY)

$(PY):
	@if command -v uv >/dev/null; then uv venv -q app/.venv && uv pip install -q --python $(PY) $(PKGS); \
	else python3 -m venv app/.venv && $(PY) -m pip install -q $(PKGS); fi
	@echo "✓ dependencias en app/.venv"

test:
	@if command -v node >/dev/null; then node app/web/pathfind.test.mjs; \
	else echo "! node no está instalado: se omiten los tests del motor (necesita Node 20+)"; fi

serve:
	@echo "→ ARIADNE en http://localhost:$(PORT)  (Ctrl+C para parar · ?lang=en para inglés)"
	@python3 -m http.server -d app/web $(PORT)

data: deps
	cd app/pipeline && ../.venv/bin/python fetch_data.py && ../.venv/bin/python fetch_pov.py \
	&& ../.venv/bin/python fetch_meda.py && ../.venv/bin/python build_grid.py
	@$(MAKE) --no-print-directory test

clean:
	rm -rf app/.venv app/pipeline/__pycache__
