import { parseRstGuide } from './guide-core.js';
import { createVmShell, checkVmSupport } from './vm-shell.js';
import { createTerminalView } from './vt100-view.js';
import {
  buildFileTree,
  mapExerciseToTestTarget,
  normalizeWorkspacePath,
} from './workspace-core.js';

const WORKSPACE_DIR = '/home/user/pyfml';
const AUTOSAVE_DELAY_MS = 500;
const INLINE_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`<]+?)\s+<(https?:\/\/[^>\s]+)>`_|(https?:\/\/[^\s<>`\]")]+)/g;

const els = {
  headerBrand: document.getElementById('header-brand'),
  status: document.getElementById('status-indicator'),
  gitBranchBadge: document.getElementById('git-branch-badge'),
  btnToggleGuide: document.getElementById('btn-toggle-guide'),
  btnResetVm: document.getElementById('btn-reset-vm'),
  crtToggle: document.getElementById('crt-toggle'),

  panelExplorer: document.getElementById('panel-explorer'),
  btnToggleExplorer: document.getElementById('btn-toggle-explorer'),
  btnRefreshFiles: document.getElementById('btn-refresh-files'),
  btnNewFile: document.getElementById('btn-new-file'),
  fileList: document.getElementById('file-list'),

  activeFilename: document.getElementById('active-filename'),
  saveIndicator: document.getElementById('save-indicator'),
  btnSave: document.getElementById('btn-save'),
  btnRun: document.getElementById('btn-run'),
  btnPep8: document.getElementById('btn-pep8'),
  btnTest: document.getElementById('btn-test'),
  btnStop: document.getElementById('btn-stop'),
  codeEditor: document.getElementById('code-editor'),
  lineNumbers: document.getElementById('editor-line-numbers'),

  terminalTitle: document.getElementById('terminal-title'),
  btnClearTerminal: document.getElementById('btn-clear-terminal'),
  terminalContainer: document.getElementById('terminal-container'),
  terminalKeybar: document.getElementById('terminal-keybar'),
  terminalOutput: document.getElementById('terminal-output'),
  terminalInputRow: document.getElementById('terminal-input-row'),

  guideDrawer: document.getElementById('guide-drawer'),
  btnCloseGuide: document.getElementById('btn-close-guide'),
  guideContent: document.getElementById('guide-content'),
  footerModeLabel: document.getElementById('footer-mode-label'),

  loadingOverlay: document.getElementById('loading-overlay'),
  loadingTitle: document.getElementById('loading-title'),
  loadingSub: document.getElementById('loading-sub'),
  bootProgress: document.getElementById('boot-progress'),
  loadingDetails: document.getElementById('loading-details'),

  unsupportedOverlay: document.getElementById('unsupported-overlay'),
  unsupportedProblems: document.getElementById('unsupported-problems'),
  btnLaunchPyodide: document.getElementById('btn-launch-pyodide'),

  dialogNewFile: document.getElementById('dialog-new-file'),
  newFilenameInput: document.getElementById('new-filename-input'),
  dialogError: document.getElementById('dialog-error'),
  btnDialogCancel: document.getElementById('btn-dialog-cancel'),
  btnDialogCreate: document.getElementById('btn-dialog-create'),

  dialogResetConfirm: document.getElementById('dialog-reset-confirm'),
  btnResetCancel: document.getElementById('btn-reset-cancel'),
  btnResetConfirm: document.getElementById('btn-reset-confirm'),

  dialogTestResults: document.getElementById('dialog-test-results'),
  testTargetFilename: document.getElementById('test-target-filename'),
  testRunningSpinner: document.getElementById('test-running-spinner'),
  testResultsContainer: document.getElementById('test-results-container'),
  testOutcomeTitle: document.getElementById('test-outcome-title'),
  testSummaryBar: document.getElementById('test-summary-bar'),
  testMethodsList: document.getElementById('test-methods-list'),
  testOutcomeDetails: document.getElementById('test-outcome-details'),
  btnCloseTestDialog: document.getElementById('btn-close-test-dialog'),
};

function isLegacyPyodideMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'pyodide';
}

function activateLegacyPyodideMode() {
  if (els.headerBrand) els.headerBrand.textContent = 'BaiTapPyMi (Legacy Pyodide)';
  if (els.status) {
    els.status.textContent = 'LOADING PYODIDE...';
    els.status.className = 'status-loading';
  }
  if (els.activeFilename) els.activeFilename.textContent = 'main.py';
  if (els.terminalTitle) els.terminalTitle.textContent = '💻 Terminal Console (Pyodide)';
  if (els.footerModeLabel) els.footerModeLabel.textContent = 'Legacy Pyodide Fallback Mode';
  if (els.loadingTitle) els.loadingTitle.textContent = 'BOOTING PYTHON WASM';
  if (els.loadingSub) els.loadingSub.textContent = 'Loading Pyodide core & standard libraries...';
  if (els.loadingDetails) els.loadingDetails.textContent = 'Initializing Web Worker...';

  els.terminalContainer?.classList.add('hidden');
  els.terminalKeybar?.classList.add('hidden');
  els.terminalOutput?.classList.remove('hidden');

  els.btnSave?.classList.add('hidden');
  els.btnPep8?.classList.add('hidden');
  els.btnRefreshFiles?.classList.add('hidden');
  els.btnToggleGuide?.classList.add('hidden');
  els.btnResetVm?.classList.add('hidden');
  els.gitBranchBadge?.classList.add('hidden');
  els.saveIndicator?.classList.add('hidden');
  els.btnStop?.classList.remove('hidden');

  const script = document.createElement('script');
  script.src = 'app.js';
  script.onload = () => {
    if (document.readyState === 'complete' && typeof window.onload === 'function') {
      window.onload(new Event('load'));
    }
    if (typeof window.selectFile === 'function') {
      window.selectFile('main.py');
    }
  };
  document.body.appendChild(script);
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function isSafeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanBareUrlMatch(rawUrl) {
  let url = rawUrl;
  while (/[.,;:!?]$/.test(url)) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes > opens) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return url;
}

function appendRichTextWithLinks(parentEl, text) {
  INLINE_LINK_RE.lastIndex = 0;
  let lastIdx = 0;
  let match;

  while ((match = INLINE_LINK_RE.exec(text)) !== null) {
    let label;
    let url;
    let consumeEnd = match.index + match[0].length;

    if (match[1] !== undefined) {
      label = match[1].trim();
      url = match[2];
    } else if (match[3] !== undefined) {
      label = match[3].trim();
      url = match[4];
    } else {
      url = cleanBareUrlMatch(match[5]);
      label = url;
      consumeEnd = match.index + url.length;
      INLINE_LINK_RE.lastIndex = consumeEnd;
    }

    if (match.index > lastIdx) {
      parentEl.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }

    if (isSafeHttpUrl(url)) {
      const link = document.createElement('a');
      link.className = 'guide-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = label || url;
      parentEl.appendChild(link);
    } else {
      parentEl.appendChild(document.createTextNode(text.slice(match.index, consumeEnd)));
    }

    lastIdx = consumeEnd;
  }

  if (lastIdx < text.length) {
    parentEl.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function mapGitBadgeClass(code) {
  if (code === '??') return 'git-badge-u';
  if (code.includes('A')) return 'git-badge-a';
  if (code.includes('D')) return 'git-badge-d';
  return 'git-badge-m';
}

function resolveTestTarget(relPath) {
  const mapped = mapExerciseToTestTarget(relPath);
  if (mapped) {
    return mapped.target;
  }
  const testMatch = relPath.match(/^tests\/(test_[a-zA-Z0-9_]+)\.py$/);
  if (testMatch) {
    return `tests.${testMatch[1]}`;
  }
  return null;
}

function initLinuxVmWorkspace() {
  const state = {
    vm: null,
    terminalView: null,
    files: [],
    gitStatus: { branch: '', ahead: 0, behind: 0, files: {} },
    activeFile: '',
    dirty: false,
    saving: false,
    saveTimer: null,
    editVersion: 0,
    selectSeq: 0,
    saveChain: Promise.resolve(),
    expandedDirs: new Set(['exercises']),
    explorerCollapsed: false,
    guideLoaded: false,
    bootReady: false,
  };

  function setStatus(label, cssClass) {
    if (!els.status) return;
    els.status.textContent = label;
    els.status.className = cssClass;
  }

  function setSaveBadge(mode) {
    if (!els.saveIndicator) return;
    els.saveIndicator.classList.remove('unsaved', 'saving');
    if (mode === 'unsaved') {
      els.saveIndicator.textContent = 'UNSAVED';
      els.saveIndicator.classList.add('unsaved');
    } else if (mode === 'saving') {
      els.saveIndicator.textContent = 'SAVING...';
      els.saveIndicator.classList.add('saving');
    } else {
      els.saveIndicator.textContent = 'SAVED';
    }
  }

  function updateLineNumbers() {
    if (!els.codeEditor || !els.lineNumbers) return;
    const count = els.codeEditor.value.split('\n').length;
    const lines = new Array(count);
    for (let i = 0; i < count; i++) {
      lines[i] = String(i + 1);
    }
    els.lineNumbers.textContent = lines.join('\n');
  }

  function updateBranchBadge() {
    if (!els.gitBranchBadge) return;
    const { branch, ahead, behind } = state.gitStatus;
    if (!branch) {
      els.gitBranchBadge.classList.add('hidden');
      return;
    }
    let text = `⎇ ${branch}`;
    if (ahead > 0) text += ` ↑${ahead}`;
    if (behind > 0) text += ` ↓${behind}`;
    els.gitBranchBadge.textContent = text;
    els.gitBranchBadge.classList.remove('hidden');
  }

  function updateActionButtons() {
    const ready = state.bootReady;
    if (els.btnRefreshFiles) els.btnRefreshFiles.disabled = !ready;
    if (els.btnSave) els.btnSave.disabled = !ready || !state.activeFile;
    if (els.btnRun) els.btnRun.disabled = !ready || !state.activeFile;
    if (els.btnPep8) els.btnPep8.disabled = !ready || !state.activeFile.endsWith('.py');

    if (els.btnTest) {
      const target = state.activeFile ? resolveTestTarget(state.activeFile) : null;
      els.btnTest.disabled = !ready || !target;
      els.btnTest.title = target
        ? `Run unittest: ${target} (F6)`
        : 'Select an exercise file (exercises/ex*.py) or test file to run tests';
    }
  }

  function renderFileTree() {
    if (!els.fileList) return;
    const tree = buildFileTree(state.files);
    const frag = document.createDocumentFragment();

    function appendNodes(nodes, depth) {
      for (const node of nodes) {
        if (node.type === 'dir') {
          const isOpen = state.expandedDirs.has(node.path);
          const li = document.createElement('li');
          li.className = 'tree-dir-item';
          li.setAttribute('role', 'treeitem');
          li.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          li.style.paddingLeft = `${10 + depth * 14}px`;

          const chevron = document.createElement('span');
          chevron.className = 'tree-chevron';
          chevron.textContent = isOpen ? '▾' : '▸';

          const label = document.createElement('span');
          label.className = 'file-label';
          label.textContent = `📁 ${node.name}`;

          li.appendChild(chevron);
          li.appendChild(label);
          li.addEventListener('click', () => {
            if (state.expandedDirs.has(node.path)) {
              state.expandedDirs.delete(node.path);
            } else {
              state.expandedDirs.add(node.path);
            }
            renderFileTree();
          });
          frag.appendChild(li);

          if (isOpen && node.children.length > 0) {
            appendNodes(node.children, depth + 1);
          }
        } else {
          const li = document.createElement('li');
          const isActive = node.path === state.activeFile;
          li.className = `file-item${isActive ? ' active' : ''}`;
          li.setAttribute('role', 'treeitem');
          li.setAttribute('aria-selected', isActive ? 'true' : 'false');
          li.style.paddingLeft = `${10 + depth * 14}px`;

          const label = document.createElement('span');
          label.className = 'file-label';
          const icon = node.name.endsWith('.py') ? '🐍' : '📄';
          label.textContent = `${icon} ${node.name}`;
          label.title = node.path;

          const meta = document.createElement('span');
          meta.className = 'file-meta';

          const gitCode = state.gitStatus.files[node.path];
          if (gitCode) {
            const badge = document.createElement('span');
            badge.className = `git-badge ${mapGitBadgeClass(gitCode)}`;
            badge.textContent = gitCode;
            badge.title = `Git status: ${gitCode}`;
            meta.appendChild(badge);
          }

          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'file-delete-btn';
          deleteBtn.textContent = '×';
          deleteBtn.title = `Delete ${node.path}`;
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void deleteFile(node.path);
          });
          meta.appendChild(deleteBtn);

          li.appendChild(label);
          li.appendChild(meta);
          li.addEventListener('click', () => {
            void selectFile(node.path);
          });
          frag.appendChild(li);
        }
      }
    }

    appendNodes(tree, 0);
    els.fileList.replaceChildren(frag);
  }

  async function refreshGitStatus() {
    if (!state.vm) return;
    try {
      state.gitStatus = await state.vm.getGitStatus();
      updateBranchBadge();
      renderFileTree();
    } catch (err) {
      console.warn('Failed to refresh git status:', err);
    }
  }

  async function refreshWorkspace() {
    if (!state.vm) return;
    const [files, gitStatus] = await Promise.all([
      state.vm.listWorkspaceFiles(),
      state.vm.getGitStatus(),
    ]);
    state.files = files;
    state.gitStatus = gitStatus;
    updateBranchBadge();
    renderFileTree();
  }

  async function saveActiveFile() {
    if (!state.vm || !state.activeFile) return;
    if (state.saveTimer !== null) {
      window.clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    if (!state.dirty) {
      await state.saveChain;
      return;
    }

    const targetPath = state.activeFile;
    const content = els.codeEditor?.value ?? '';
    const savedVersion = state.editVersion;

    const runSave = async () => {
      state.saving = true;
      if (state.activeFile === targetPath) {
        setSaveBadge('saving');
      }

      try {
        await state.vm.writeWorkspaceFile(targetPath, content);
        if (state.activeFile === targetPath && state.editVersion === savedVersion) {
          state.dirty = false;
          setSaveBadge('saved');
        }
        await refreshGitStatus();
      } catch (err) {
        if (state.activeFile === targetPath) {
          setSaveBadge('unsaved');
        }
        console.error('Failed to save file:', err);
      } finally {
        state.saving = false;
      }
    };

    const nextSave = state.saveChain.then(runSave, runSave);
    state.saveChain = nextSave.catch(() => {});
    await nextSave;
  }

  function scheduleAutoSave() {
    state.editVersion += 1;
    state.dirty = true;
    setSaveBadge('unsaved');
    if (state.saveTimer !== null) {
      window.clearTimeout(state.saveTimer);
    }
    state.saveTimer = window.setTimeout(() => {
      state.saveTimer = null;
      void saveActiveFile();
    }, AUTOSAVE_DELAY_MS);
  }

  async function selectFile(relPath) {
    if (!state.vm) return;
    const norm = normalizeWorkspacePath(relPath);
    if (!norm.ok) return;

    const seq = ++state.selectSeq;

    if (state.dirty && state.activeFile && state.activeFile !== norm.path) {
      await saveActiveFile();
      if (seq !== state.selectSeq) return;
    }

    try {
      const content = await state.vm.readWorkspaceFile(norm.path);
      if (seq !== state.selectSeq) return;

      state.activeFile = norm.path;
      state.dirty = false;
      state.editVersion += 1;
      setSaveBadge('saved');
      if (els.activeFilename) els.activeFilename.textContent = norm.path;
      if (els.codeEditor) els.codeEditor.value = content;
      updateLineNumbers();

      // Ensure parent directories are expanded
      const parts = norm.path.split('/');
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        state.expandedDirs.add(prefix);
      }

      renderFileTree();
      updateActionButtons();
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }

  async function deleteFile(relPath) {
    if (!state.vm) return;
    const norm = normalizeWorkspacePath(relPath);
    if (!norm.ok) return;

    if (!window.confirm(`Delete '${norm.path}' from /home/user/pyfml?`)) {
      return;
    }

    if (norm.path === state.activeFile) {
      if (state.saveTimer !== null) {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = null;
      }
      state.dirty = false;
      state.editVersion += 1;
      state.selectSeq += 1;
    }

    try {
      await state.saveChain;
      await state.vm.deleteWorkspaceFile(norm.path);
      if (state.activeFile === norm.path) {
        state.activeFile = '';
        state.dirty = false;
        setSaveBadge('saved');
        if (els.activeFilename) els.activeFilename.textContent = '(none)';
        if (els.codeEditor) els.codeEditor.value = '';
        updateLineNumbers();
      }
      await refreshWorkspace();
      if (!state.activeFile && state.files.length > 0) {
        await selectFile(state.files[0]);
      } else {
        updateActionButtons();
      }
    } catch (err) {
      window.alert(`Could not delete file: ${err?.message ?? String(err)}`);
    }
  }

  async function createNewFile() {
    if (!state.vm || !els.newFilenameInput) return;
    const raw = els.newFilenameInput.value;
    const norm = normalizeWorkspacePath(raw);
    if (!norm.ok) {
      showNewFileError(norm.error);
      return;
    }
    if (state.files.includes(norm.path)) {
      showNewFileError('A file with this path already exists.');
      return;
    }

    try {
      const initialContent = norm.path.endsWith('.py') ? `#!/usr/bin/env python3\n` : '';
      await state.vm.writeWorkspaceFile(norm.path, initialContent);
      els.dialogNewFile?.classList.add('hidden');
      await refreshWorkspace();
      await selectFile(norm.path);
    } catch (err) {
      showNewFileError(err?.message ?? String(err));
    }
  }

  function showNewFileError(msg) {
    if (!els.dialogError) return;
    els.dialogError.textContent = msg;
    els.dialogError.classList.remove('hidden');
  }

  async function runActiveFile() {
    if (!state.vm || !state.activeFile) return;
    await saveActiveFile();
    const absPath = `${WORKSPACE_DIR}/${state.activeFile}`;
    const cmd = state.activeFile.endsWith('.py')
      ? `python3 ${shellSingleQuote(absPath)}`
      : `cat ${shellSingleQuote(absPath)}`;
    await state.vm.sendCommandToTerminal(cmd);
    state.terminalView?.focus();
    window.setTimeout(() => void refreshGitStatus(), 400);
  }

  async function runPep8OnActiveFile() {
    if (!state.vm || !state.activeFile || !state.activeFile.endsWith('.py')) return;
    await saveActiveFile();
    const absFile = `${WORKSPACE_DIR}/${state.activeFile}`;
    const pep8Script = `${WORKSPACE_DIR}/vendor/pep8.py`;
    const cmd = `python3 ${shellSingleQuote(pep8Script)} ${shellSingleQuote(absFile)} && echo '[PEP8] OK'`;
    await state.vm.sendCommandToTerminal(cmd);
    state.terminalView?.focus();
  }

  async function runDiagnosticTests() {
    if (!state.vm || !state.activeFile) return;
    const target = resolveTestTarget(state.activeFile);
    if (!target) return;

    await saveActiveFile();

    if (els.testTargetFilename) {
      els.testTargetFilename.textContent = `${state.activeFile} (${target})`;
    }
    els.dialogTestResults?.classList.remove('hidden');
    els.testRunningSpinner?.classList.remove('hidden');
    els.testResultsContainer?.classList.add('hidden');

    try {
      const res = await state.vm.runUnittest(target);
      renderTestResults(res.parsed, res.output, res.exitCode);
    } catch (err) {
      renderTestResults(
        { status: 'ERROR', passed: 0, failed: 0, errors: 1, skipped: 0, methods: [] },
        err?.message ?? String(err),
        1,
      );
    } finally {
      await refreshGitStatus();
    }
  }

  function renderTestResults(parsed, rawOutput, exitCode) {
    els.testRunningSpinner?.classList.add('hidden');
    els.testResultsContainer?.classList.remove('hidden');

    const status = parsed?.status || (exitCode === 0 ? 'PASS' : 'ERROR');
    if (els.testOutcomeTitle) {
      els.testOutcomeTitle.className = 'test-outcome-title';
      if (status === 'PASS') {
        els.testOutcomeTitle.classList.add('pass');
        els.testOutcomeTitle.textContent = 'ALL TESTS PASSED ✅';
      } else if (status === 'FAIL') {
        els.testOutcomeTitle.classList.add('fail');
        els.testOutcomeTitle.textContent = 'SOME TESTS FAILED ❌';
      } else {
        els.testOutcomeTitle.classList.add('error');
        els.testOutcomeTitle.textContent = 'TEST ERROR ⚠️';
      }
    }

    const methods = Array.isArray(parsed?.methods) ? parsed.methods : [];
    if (els.testSummaryBar && els.testMethodsList) {
      if (methods.length > 0) {
        const total = methods.length;
        const parts = [`${parsed.passed}/${total} passed`];
        if (parsed.failed > 0) parts.push(`${parsed.failed} failed`);
        if (parsed.errors > 0) parts.push(`${parsed.errors} errors`);
        if (parsed.skipped > 0) parts.push(`${parsed.skipped} skipped`);
        els.testSummaryBar.textContent = parts.join(' · ');
        els.testSummaryBar.classList.remove('hidden');

        const icons = { PASS: '✅', FAIL: '❌', ERROR: '⚠️', SKIP: '⏭️' };
        const frag = document.createDocumentFragment();
        for (const m of methods) {
          const row = document.createElement('div');
          row.className = `test-method-row test-${m.status.toLowerCase()}`;

          const label = document.createElement('span');
          label.textContent = `${icons[m.status] || '❓'} ${m.method}`;
          row.appendChild(label);

          if (m.message && m.status !== 'PASS') {
            const detail = document.createElement('div');
            detail.className = 'test-method-detail';
            detail.textContent = m.message;
            row.appendChild(detail);
          }
          frag.appendChild(row);
        }
        els.testMethodsList.replaceChildren(frag);
        els.testMethodsList.classList.remove('hidden');
      } else {
        els.testSummaryBar.classList.add('hidden');
        els.testMethodsList.replaceChildren();
        els.testMethodsList.classList.add('hidden');
      }
    }

    if (els.testOutcomeDetails) {
      els.testOutcomeDetails.textContent = rawOutput || 'No unittest output captured.';
    }
  }

  function renderGuide(rstText) {
    if (!els.guideContent) return;
    const sections = parseRstGuide(rstText);
    const frag = document.createDocumentFragment();

    for (const sec of sections) {
      const secEl = document.createElement('section');
      secEl.className = 'guide-section';
      secEl.id = `guide-${sec.id}`;

      const tag = `h${Math.min(4, Math.max(1, sec.level))}`;
      const heading = document.createElement(tag);
      heading.className = `guide-${tag}`;
      heading.textContent = sec.title;
      secEl.appendChild(heading);

      for (const block of sec.blocks) {
        if (block.type === 'paragraph') {
          const p = document.createElement('p');
          p.className = 'guide-p';
          appendRichTextWithLinks(p, block.text);
          secEl.appendChild(p);
        } else if (block.type === 'list') {
          const ul = document.createElement('ul');
          ul.className = 'guide-list';
          for (const item of block.items) {
            const li = document.createElement('li');
            appendRichTextWithLinks(li, item);
            ul.appendChild(li);
          }
          secEl.appendChild(ul);
        } else if (block.type === 'code') {
          const wrapper = document.createElement('div');
          wrapper.className = 'guide-code-block';

          const pre = document.createElement('pre');
          pre.className = 'guide-code-pre';
          const code = document.createElement('code');
          code.textContent = block.raw;
          pre.appendChild(code);
          wrapper.appendChild(pre);

          secEl.appendChild(wrapper);
        }
      }

      frag.appendChild(secEl);
    }

    els.guideContent.replaceChildren(frag);
    state.guideLoaded = true;
  }

  function toggleExplorer() {
    if (!els.panelExplorer || !els.btnToggleExplorer) return;
    state.explorerCollapsed = !state.explorerCollapsed;
    if (state.explorerCollapsed) {
      els.panelExplorer.classList.add('explorer-collapsed');
      els.panelExplorer.classList.remove('explorer-expanded-override');
      els.btnToggleExplorer.textContent = '📁';
    } else {
      els.panelExplorer.classList.remove('explorer-collapsed');
      els.panelExplorer.classList.add('explorer-expanded-override');
      els.btnToggleExplorer.textContent = '◀';
    }
    window.setTimeout(() => state.terminalView?.fit(), 220);
  }

  function toggleGuideDrawer(forceOpen) {
    if (!els.guideDrawer) return;
    const willOpen = typeof forceOpen === 'boolean'
      ? forceOpen
      : els.guideDrawer.classList.contains('hidden');
    els.guideDrawer.classList.toggle('hidden', !willOpen);
    window.setTimeout(() => state.terminalView?.fit(), 50);
  }

  function updateProgress(p) {
    if (!p || !els.bootProgress || !els.loadingDetails) return;
    if (p.stage === 'download') {
      if (p.total > 0) {
        const pct = Math.min(75, Math.max(12, Math.round((p.loaded / p.total) * 65) + 10));
        els.bootProgress.style.width = `${pct}%`;
        const mbLoaded = (p.loaded / 1048576).toFixed(1);
        const mbTotal = (p.total / 1048576).toFixed(1);
        els.loadingDetails.textContent = `Downloading ${p.what || 'asset'}: ${mbLoaded} / ${mbTotal} MiB`;
      } else {
        els.loadingDetails.textContent = `Downloading ${p.what || 'asset'}...`;
      }
    } else if (p.stage === 'compile') {
      els.bootProgress.style.width = '55%';
      els.loadingDetails.textContent = 'Compiling Linux kernel WebAssembly...';
    } else if (p.stage === 'compiled') {
      els.bootProgress.style.width = '72%';
      els.loadingDetails.textContent = 'Kernel compiled. Starting Alpine Linux...';
    } else if (p.stage === 'memory') {
      els.bootProgress.style.width = '80%';
      els.loadingDetails.textContent = 'Allocating guest RAM...';
    } else if (p.stage === 'instantiate') {
      els.bootProgress.style.width = '86%';
      els.loadingDetails.textContent = 'Instantiating Linux kernel...';
    } else if (p.stage === 'start') {
      els.bootProgress.style.width = '92%';
      els.loadingDetails.textContent = 'Mounting rootfs & seeding git repository...';
    }
  }

  function showUnsupportedBanner(problems) {
    els.loadingOverlay?.classList.add('hidden');
    setStatus('UNSUPPORTED', 'status-waiting');
    if (els.unsupportedProblems) {
      const frag = document.createDocumentFragment();
      for (const prob of problems) {
        const li = document.createElement('li');
        li.textContent = prob;
        frag.appendChild(li);
      }
      els.unsupportedProblems.replaceChildren(frag);
    }
    els.unsupportedOverlay?.classList.remove('hidden');
  }

  // Wire UI events
  els.crtToggle?.addEventListener('change', (e) => {
    document.body.className = e.target.checked ? 'crt-on' : 'crt-off';
  });

  els.btnToggleExplorer?.addEventListener('click', toggleExplorer);
  els.btnToggleGuide?.addEventListener('click', () => toggleGuideDrawer());
  els.btnCloseGuide?.addEventListener('click', () => toggleGuideDrawer(false));

  els.btnRefreshFiles?.addEventListener('click', () => {
    void refreshWorkspace();
  });

  els.btnNewFile?.addEventListener('click', () => {
    if (!state.bootReady || !els.newFilenameInput) return;
    els.newFilenameInput.value = '';
    els.dialogError?.classList.add('hidden');
    els.dialogNewFile?.classList.remove('hidden');
    els.newFilenameInput.focus();
  });

  els.btnDialogCancel?.addEventListener('click', () => {
    els.dialogNewFile?.classList.add('hidden');
  });
  els.btnDialogCreate?.addEventListener('click', () => {
    void createNewFile();
  });
  els.newFilenameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void createNewFile();
    if (e.key === 'Escape') els.dialogNewFile?.classList.add('hidden');
  });

  els.btnResetVm?.addEventListener('click', () => {
    els.dialogResetConfirm?.classList.remove('hidden');
  });
  els.btnResetCancel?.addEventListener('click', () => {
    els.dialogResetConfirm?.classList.add('hidden');
  });
  els.btnResetConfirm?.addEventListener('click', () => {
    els.dialogResetConfirm?.classList.add('hidden');
    setStatus('RESETTING VM...', 'status-loading');
    if (state.vm) {
      void state.vm.resetVm();
    }
  });

  els.btnLaunchPyodide?.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', 'pyodide');
    window.location.href = url.toString();
  });

  els.btnSave?.addEventListener('click', () => {
    void saveActiveFile();
  });
  els.btnRun?.addEventListener('click', () => {
    void runActiveFile();
  });
  els.btnPep8?.addEventListener('click', () => {
    void runPep8OnActiveFile();
  });
  els.btnTest?.addEventListener('click', () => {
    void runDiagnosticTests();
  });
  els.btnCloseTestDialog?.addEventListener('click', () => {
    els.dialogTestResults?.classList.add('hidden');
  });

  els.btnClearTerminal?.addEventListener('click', () => {
    state.terminalView?.clear();
    if (state.vm) {
      void state.vm.writePty('\x0c');
    }
    state.terminalView?.focus();
  });

  // Editor handlers
  els.codeEditor?.addEventListener('input', () => {
    updateLineNumbers();
    if (state.bootReady && state.activeFile) {
      scheduleAutoSave();
    }
  });

  els.codeEditor?.addEventListener('scroll', () => {
    if (els.lineNumbers && els.codeEditor) {
      els.lineNumbers.scrollTop = els.codeEditor.scrollTop;
    }
  });

  els.codeEditor?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const editor = els.codeEditor;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = `${editor.value.slice(0, start)}    ${editor.value.slice(end)}`;
      editor.selectionStart = editor.selectionEnd = start + 4;
      updateLineNumbers();
      if (state.bootReady && state.activeFile) {
        scheduleAutoSave();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveActiveFile();
    }
  });

  // Global hotkeys — NEVER hijack terminal shortcuts when terminal is focused!
  window.addEventListener('keydown', (e) => {
    if (els.terminalContainer && els.terminalContainer.contains(document.activeElement)) {
      return;
    }

    if (e.key === 'Escape') {
      els.dialogTestResults?.classList.add('hidden');
      els.dialogNewFile?.classList.add('hidden');
      els.dialogResetConfirm?.classList.add('hidden');
      return;
    }

    if (e.key === 'F5') {
      e.preventDefault();
      void runActiveFile();
      return;
    }

    if (e.key === 'F6') {
      e.preventDefault();
      void runDiagnosticTests();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveActiveFile();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleExplorer();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      els.btnNewFile?.click();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      els.btnClearTerminal?.click();
    }
  });

  // Sync explorer auto-collapse media query on small landscape screens
  const landscapeMq = window.matchMedia('screen and (max-height: 450px) and (orientation: landscape)');
  if (landscapeMq.matches) {
    state.explorerCollapsed = true;
    if (els.btnToggleExplorer) els.btnToggleExplorer.textContent = '📁';
  }
  landscapeMq.addEventListener('change', (e) => {
    if (e.matches && !state.explorerCollapsed) {
      state.explorerCollapsed = true;
      if (els.btnToggleExplorer) els.btnToggleExplorer.textContent = '📁';
      els.panelExplorer?.classList.remove('explorer-expanded-override');
    }
  });

  // Initialize VT100 terminal view immediately
  state.terminalView = createTerminalView(els.terminalContainer, els.terminalKeybar, {
    onData: (seq) => {
      if (state.vm) {
        void state.vm.writePty(seq);
      }
    },
    onResize: (cols, rows) => {
      if (state.vm) {
        state.vm.resizePty(cols, rows);
      }
    },
    onTitle: (title) => {
      if (els.terminalTitle) {
        els.terminalTitle.textContent = title ? `💻 ${title}` : '💻 Linux Terminal (bash)';
      }
    },
  });

  updateLineNumbers();

  // Boot sequence
  (async () => {
    const support = await checkVmSupport();
    if (!support.ok) {
      showUnsupportedBanner(support.problems);
      return;
    }

    try {
      const { cols, rows } = state.terminalView.getColsRows();
      const vm = await createVmShell({
        distroUrl: './distros/pymi-alpine.erofs',
        pyfmlUrl: './pyfml.json',
        cols,
        rows,
        onProgress: updateProgress,
        onStatus: (_st, detail) => {
          if (detail && els.loadingDetails) {
            els.loadingDetails.textContent = detail;
          }
        },
        onConsoleLog: (chunk) => {
          if (chunk) console.debug('[vm]', chunk);
        },
      });

      state.vm = vm;
      state.bootReady = true;

      vm.attachTerminal((bytes) => {
        state.terminalView?.write(bytes);
      });
      const currentSize = state.terminalView.getColsRows();
      vm.resizePty(currentSize.cols, currentSize.rows);

      if (els.bootProgress) els.bootProgress.style.width = '96%';
      if (els.loadingDetails) els.loadingDetails.textContent = 'Loading workspace & guide...';

      try {
        await refreshWorkspace();
        const defaultFile = state.files.includes('exercises/ex3_0.py')
          ? 'exercises/ex3_0.py'
          : state.files[0] || '';
        if (defaultFile) {
          await selectFile(defaultFile);
        } else {
          updateActionButtons();
        }

        let guideText = vm.guideFallbackText;
        if (state.files.includes('guide.rst')) {
          try {
            guideText = await vm.readWorkspaceFile('guide.rst');
          } catch {
            // Keep fallback guide.rst from pyfml.json
          }
        }
        renderGuide(guideText);
      } catch (loadErr) {
        console.warn('Initial workspace/guide load issue:', loadErr);
        updateActionButtons();
        if (!state.guideLoaded && vm.guideFallbackText) {
          try {
            renderGuide(vm.guideFallbackText);
          } catch {
            // Non-fatal
          }
        }
      }

      if (els.bootProgress) els.bootProgress.style.width = '100%';
      els.loadingOverlay?.classList.add('hidden');
      setStatus('LINUX READY', 'status-ready');
      state.terminalView.focus();
    } catch (err) {
      console.error('Linux VM boot error:', err);
      setStatus('BOOT ERROR', 'status-waiting');
      if (els.loadingDetails) {
        els.loadingDetails.textContent = `Boot failed: ${err?.message ?? String(err)}`;
      }
      showUnsupportedBanner([`Linux VM failed to boot: ${err?.message ?? String(err)}`]);
    }
  })();
}

if (isLegacyPyodideMode()) {
  activateLegacyPyodideMode();
} else {
  initLinuxVmWorkspace();
}
