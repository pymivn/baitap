.PHONY: build build-pyfml test serve audit

PYTHON ?= python3

build:
	$(PYTHON) scripts/build_vm.py

build-pyfml:
	$(PYTHON) scripts/build_vm.py --pyfml-only

test:
	$(PYTHON) -m unittest discover -s tests -v
	@if ls tests/js/*.test.mjs >/dev/null 2>&1; then \
		node --test tests/js/*.test.mjs; \
	fi
	@if ls tests/e2e/*.test.mjs >/dev/null 2>&1; then \
		if [ -f distros/pymi-alpine.erofs ] && [ -f vendor/unkernel/node.mjs ]; then \
			NP_RUNTIME=proot nix-portable nix --extra-experimental-features "nix-command flakes" shell nixpkgs#nodejs_24 -c node --test tests/e2e/*.test.mjs; \
		fi; \
	fi

serve:
	$(PYTHON) server.py

audit:
	$(PYTHON) -m py_compile server.py scripts/*.py tests/*.py
	@$(PYTHON) -c 'import pathlib, re, sys; roots = [pathlib.Path("server.py"), *sorted(pathlib.Path("scripts").glob("*.py")), *(sorted(pathlib.Path("js").glob("*.js")) if pathlib.Path("js").exists() else [])]; secret_re = re.compile(r"(AIzaSy[0-9A-Za-z_-]{10,}|ghp_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"); texts = {p: p.read_text(encoding="utf-8", errors="replace") for p in roots}; errors = [f"Potential secret in {p}" for p, t in texts.items() if secret_re.search(t)] + [f"Unsafe shell=True in {p}" for p, t in texts.items() if p.suffix == ".py" and "shell=True" in t] + [f"Unsafe DOM sink in {p}" for p, t in texts.items() if p.suffix == ".js" and any(s in t for s in ("innerHTML", "outerHTML", "document.write"))]; core = pathlib.Path("scripts/vm_builder_core.py").read_text(encoding="utf-8"); pins = re.findall(r"\"([0-9a-f]{64})\"", core); errors += (["Missing pinned SHA-256 digests in scripts/vm_builder_core.py"] if len(pins) < 2 else []); sys.exit("\n".join(errors)) if errors else print(f"[audit] Passed static hygiene, secret scan, and {len(pins)} SHA-256 pin checks ({len(roots)} files).")'
