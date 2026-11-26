# BaiTapPyMi Architecture & Knowledge Base

This document details the architecture, security boundaries, filesystem layout, and build/test workflows for the browser-based **BaiTapPyMi Linux VM** TUI workspace.

---

## 1. Browser Linux VM Architecture (`unkernel`)

BaiTapPyMi runs a real **Linux 7.x kernel** compiled to WebAssembly (`vendor/unkernel/unkernel.wasm`) with unmodified `aarch64` Alpine Linux user-space binaries (`python3`, `git`, `bash`, `nano`, `diffutils`, `less`, `ncurses`) inside a Web Worker (`worker: true`), requiring **WebAssembly JSPI** (Chrome/Edge 137+, Firefox 153+, Safari 27+) and **Cross-Origin Isolation (COOP/COEP)**.

```mermaid
graph TD
    subgraph Browser Main Thread
        UI[js/app.js — TUI Orchestrator]
        TV[js/vt100-view.js — DOM Terminal View]
        VT[js/vt100-core.js — Pure VT100/ANSI Core]
        WSC[js/workspace-core.js — Pure Path/Tree/Git/Test Core]
        GC[js/guide-core.js — Pure RST Parser]
        VMS[js/vm-shell.js — Unkernel Bridge]
    end

    subgraph Unkernel Web Worker
        K[vendor/unkernel/unkernel.wasm — Linux 7.x + kwemu]
        RFS[distros/pymi-alpine.erofs — Read-Only RootFS via HTTP Range]
        IDB[IndexedDB kwdata — Persistent OverlayFS]
        SEED[9p MemoryFs /mnt/pyfml-seed]
        BARE[/srv/git/pyfml.git + post-receive hook]
        WORK[/home/user/pyfml]
        PTY[/bin/bash -l PTY]
    end

    UI --> TV & VMS & WSC & GC
    TV --> VT
    VMS <-->|PTY streams| PTY
    VMS <-->|exec argv + stdin| WORK
    VMS -->|9p mount| SEED
    K --> RFS & IDB & SEED
    WORK <-->|git pull/push| BARE
```

### Browser Compatibility
If WebAssembly JSPI (or required Cross-Origin Isolation) is unavailable in the user's browser, `js/app.js` displays a compatibility modal (`#unsupported-overlay`) listing the detected issues and supported browser versions (**Chrome / Edge 137+**, **Firefox 153+**, or **Safari 27+**), along with a `Retry` button (`#btn-retry-boot`).

---

## 2. Functional Core, Imperative Shell Design

All client-side logic is split between zero-dependency pure cores and thin imperative shells:

- **Pure Cores**:
  - `js/vt100-core.js`: Deterministic VT100/ANSI escape parser, SGR 16/256/truecolor attributes, alternate screen buffer (`?1049h`/`?1049l`), application cursor keys (`?1h`/`?1l`), scrollback ring buffer, `encodeKeyEvent()`, and `encodePaste()`.
  - `js/workspace-core.js`: Path traversal guard (`normalizeWorkspacePath()`), directory tree builder (`buildFileTree()`), `git status --porcelain=v1 -b` parser (`parseGitStatusPorcelain()`), exercise-to-unittest mapper (`mapExerciseToTestTarget()`), and `unittest -vvv` output parser (`parseUnittestVerboseOutput()`).
  - `js/guide-core.js`: reStructuredText parser (`parseRstGuide()`) extracting sections, paragraphs, lists, links, and runnable code-block commands from `guide.rst`.
- **Imperative Shells**:
  - `js/vt100-view.js`: `requestAnimationFrame`-batched DOM grid renderer, `ResizeObserver` cell sizing, blinking cursor, wheel scrollback, `Ctrl+C` copy-if-selected / SIGINT pass-through, paste handling, and mobile touch key bar (`ESC`, `TAB`, `CTRL`, arrows).
  - `js/vm-shell.js`: Loads `pyfml.json` into a read-only 9p `MemoryFs` at `/mnt/pyfml-seed`, boots `createKernel({ worker: true, ... })` with `distros/pymi-alpine.erofs` and persistent IndexedDB `data` disk (`template: 'bundled'`), bootstraps the local git remote and workspace, and spawns `/bin/bash -l` PTY.
  - `js/app.js`: Coordinates the File Explorer tree, Code Editor (with 500ms debounced auto-save and `Ctrl+S`), `Run (F5)`, `PEP8`, `Test (F6)`, interactive `guide.rst` drawer, `Reset VM` (`resetDataDisk()`), and focus-safe global shortcuts (never hijacking keys when focus is inside `#terminal-container`).

---

## 3. Local Git Remote & `guide.rst` Parity

On first boot (or after `Reset VM`), `js/vm-shell.js` runs an idempotent Python bootstrap inside the VM:
1. Configures system git:
   - `git config --system url."/srv/git/pyfml.git".insteadOf "https://thegit.pymi.vn/pyfml/pyfml.git"`
   - `git config --system init.defaultBranch master`
   - `git config --system safe.directory '*'`
2. Creates bare repository `/srv/git/pyfml.git` (owned by `user:users`), seeds its `master` branch from `/mnt/pyfml-seed`, and installs an executable `hooks/post-receive` script (from `pyfml.json`'s `postReceiveHook`).
3. Clones `/srv/git/pyfml.git` to `/home/user/pyfml` and sets `origin` to `https://thegit.pymi.vn/pyfml/pyfml.git`.

Because of `insteadOf`, `git remote -v`, `git pull origin master`, `git checkout -b ...`, and `git push origin <branch>` all work offline in the browser, and pushing triggers the `post-receive` hook printing the Merge Request URL and running `vendor/pep8.py` checks on changed `exercises/*.py` files.

---

## 4. Security Boundaries

- **No `innerHTML` / `outerHTML` / `document.write`**: All UI rendering (terminal cells, file tree, git status, unittest results, `guide.rst` drawer) uses DOM creation APIs and `textContent`.
- **URL Validation**: Only `http://` and `https://` URLs are turned into `<a target="_blank" rel="noopener noreferrer">` links in the `guide.rst` drawer.
- **No Unquoted Shell Interpolation**: `js/vm-shell.js` passes relative paths as discrete `argv` elements to `kernel.exec('/usr/bin/python3', ['-c', script, safePath], ...)` and file contents via binary `stdin` (`{ input: Uint8Array }`), while verifying paths on both host (`normalizeWorkspacePath`) and guest (`os.path.realpath`).
- **Same-Origin Hosting**: All JS, Wasm, JSON, and EROFS assets are served same-origin with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: same-origin`.

---

## 5. Hosting, Build, Test & Audit Commands

### Local Development Server (`server.py`)
`server.py` serves static assets on `127.0.0.1` (`PORT` env var, default `8000`) with:
- RFC 7233 HTTP `Range` (`206 Partial Content` / `416 Range Not Satisfiable`) via `scripts/http_range_core.py` for lazy reads of `distros/pymi-alpine.erofs`.
- `Accept-Ranges: bytes` and MIME types for `.mjs`, `.wasm`, `.erofs`, `.json`.
- COOP/COEP/CORP headers and `Cache-Control: no-store, no-cache, must-revalidate`.

### Static Hosting (`coi-serviceworker.js`)
For static hosts like GitHub Pages (`.github/workflows/deploy.yml`), `coi-serviceworker.js` injects COOP/COEP headers via a Service Worker, skips intercepting same-origin `.wasm` requests to preserve browser Wasm code caching, and returns `Response.error()` on failed fetches.

### Makefile Targets
- `make build` — Downloads/verifies pinned `unkernel` + Alpine packages and builds `distros/pymi-alpine.erofs` (`zstd` compressed) and `pyfml.json` via `scripts/build_vm.py`.
- `make build-pyfml` — Rebuilds `pyfml.json` only from `workspace.json`, `tests.json`, and `guide.rst`.
- `make serve` — Starts `python3 server.py`.
- `make test` — Runs Python unit tests (`tests/test_*.py`), Node JS core unit tests (`tests/js/*.test.mjs`), and VM E2E tests (`tests/e2e/*.test.mjs` if present).
- `make audit` — Compiles Python sources, scans for hardcoded secret patterns, checks for unsafe `shell=True` in Python, checks `js/*.js` for unsafe DOM sinks, and verifies pinned SHA-256 digests in `scripts/vm_builder_core.py`.
