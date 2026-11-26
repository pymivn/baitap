import { createTerminalState, encodeKeyEvent, encodePaste } from './vt100-core.js';

const DEFAULT_FG = '#d8dee9';
const DEFAULT_BG = '#090a0d';

function cellStyleKey(cell, isCursor) {
  return [
    cell.fg ?? '',
    cell.bg ?? '',
    cell.bold ? '1' : '0',
    cell.dim ? '1' : '0',
    cell.italic ? '1' : '0',
    cell.underline ? '1' : '0',
    cell.inverse ? '1' : '0',
    isCursor ? '1' : '0',
  ].join('|');
}

function buildRunSpan(text, cell, isCursor) {
  const span = document.createElement('span');
  const classes = [];

  if (cell.bold) classes.push('vt-bold');
  if (cell.dim) classes.push('vt-dim');
  if (cell.italic) classes.push('vt-italic');
  if (cell.underline) classes.push('vt-underline');
  if (isCursor) classes.push('vt-cursor');

  if (classes.length > 0) {
    span.className = classes.join(' ');
  }

  let fg = cell.fg;
  let bg = cell.bg;
  if (cell.inverse) {
    const tmpFg = fg ?? DEFAULT_FG;
    const tmpBg = bg ?? DEFAULT_BG;
    fg = tmpBg;
    bg = tmpFg;
  }

  if (fg && !isCursor) {
    span.style.color = fg;
  }
  if (bg && !isCursor) {
    span.style.backgroundColor = bg;
  }

  span.textContent = text;
  return span;
}

function renderRowElement(rowCells, rowIdx, cursorCol, isCursorRow, rowHeightPx) {
  const rowEl = document.createElement('div');
  rowEl.className = 'vt-row';
  if (rowHeightPx > 0) {
    rowEl.style.height = `${rowHeightPx}px`;
    rowEl.style.lineHeight = `${rowHeightPx}px`;
  }

  if (!rowCells || rowCells.length === 0) {
    rowEl.textContent = ' ';
    return rowEl;
  }

  let runText = '';
  let runCell = rowCells[0];
  let runCursor = isCursorRow && cursorCol === 0;
  let runKey = cellStyleKey(runCell, runCursor);

  for (let c = 0; c < rowCells.length; c++) {
    const cell = rowCells[c];
    const isCursor = isCursorRow && c === cursorCol;
    const key = cellStyleKey(cell, isCursor);

    if (key === runKey) {
      runText += cell.ch;
    } else {
      rowEl.appendChild(buildRunSpan(runText, runCell, runCursor));
      runText = cell.ch;
      runCell = cell;
      runCursor = isCursor;
      runKey = key;
    }
  }

  if (runText.length > 0) {
    rowEl.appendChild(buildRunSpan(runText, runCell, runCursor));
  }

  return rowEl;
}

/**
 * Create an imperative VT100 terminal view bound to a DOM container and optional touch key bar.
 */
export function createTerminalView(containerEl, keyBarEl, { onData, onResize, onTitle } = {}) {
  if (!containerEl) {
    throw new Error('createTerminalView requires a container element');
  }

  const vtCore = createTerminalState({ cols: 80, rows: 24, maxScrollback: 2000 });

  containerEl.replaceChildren();
  containerEl.classList.add('vt-container');
  containerEl.tabIndex = -1;

  const screenEl = document.createElement('div');
  screenEl.className = 'vt-screen';
  screenEl.setAttribute('role', 'region');
  screenEl.setAttribute('aria-label', 'Linux Terminal');

  const measureEl = document.createElement('span');
  measureEl.className = 'vt-measure';
  measureEl.setAttribute('aria-hidden', 'true');
  measureEl.textContent = 'WWWWWWWWWW';

  const inputSinkEl = document.createElement('textarea');
  inputSinkEl.className = 'vt-input-sink';
  inputSinkEl.setAttribute('aria-label', 'Terminal keyboard input');
  inputSinkEl.setAttribute('autocapitalize', 'off');
  inputSinkEl.setAttribute('autocomplete', 'off');
  inputSinkEl.setAttribute('autocorrect', 'off');
  inputSinkEl.spellcheck = false;

  const scrollBtnEl = document.createElement('button');
  scrollBtnEl.type = 'button';
  scrollBtnEl.className = 'vt-scroll-bottom hidden';
  scrollBtnEl.textContent = '↓ Jump to bottom';

  containerEl.appendChild(measureEl);
  containerEl.appendChild(inputSinkEl);
  containerEl.appendChild(screenEl);
  containerEl.appendChild(scrollBtnEl);

  let scrollOffset = 0;
  let lastTitle = '';
  let cellWidth = 8.4;
  let cellHeight = 19.2;
  let renderPending = false;
  let destroyed = false;
  let isComposing = false;
  let ctrlSticky = false;
  let pointerDownPos = null;
  let ctrlBtnEl = null;

  function setCtrlSticky(next) {
    ctrlSticky = Boolean(next);
    if (ctrlBtnEl) {
      ctrlBtnEl.classList.toggle('active', ctrlSticky);
      ctrlBtnEl.setAttribute('aria-pressed', ctrlSticky ? 'true' : 'false');
    }
  }

  function getSelectedTerminalText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const text = sel.toString();
    if (!text) return '';
    const anchorInside = sel.anchorNode && screenEl.contains(sel.anchorNode);
    const focusInside = sel.focusNode && screenEl.contains(sel.focusNode);
    return anchorInside || focusInside ? text : '';
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function jumpToBottom() {
    if (scrollOffset !== 0) {
      scrollOffset = 0;
      scheduleRender();
    }
  }

  function measureCell() {
    const rect = measureEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      cellWidth = rect.width / 10;
      cellHeight = rect.height;
    }
  }

  function fit() {
    if (destroyed) return { cols: vtCore.cols, rows: vtCore.rows };
    measureCell();
    const style = window.getComputedStyle(containerEl);
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);

    const availW = Math.max(0, containerEl.clientWidth - padX);
    const availH = Math.max(0, containerEl.clientHeight - padY);
    if (availW <= 0 || availH <= 0) {
      return { cols: vtCore.cols, rows: vtCore.rows };
    }

    const cols = Math.max(20, Math.floor(availW / cellWidth));
    const rows = Math.max(6, Math.floor(availH / cellHeight));
    if (cols !== vtCore.cols || rows !== vtCore.rows) {
      vtCore.resize(cols, rows);
      onResize?.(cols, rows);
      scheduleRender();
    }
    return { cols: vtCore.cols, rows: vtCore.rows };
  }

  function renderNow() {
    renderPending = false;
    if (destroyed) return;

    const snap = vtCore.getSnapshot();
    if (snap.title !== lastTitle) {
      lastTitle = snap.title;
      onTitle?.(snap.title);
    }

    const maxOffset = snap.isAltScreen ? 0 : snap.scrollback.length;
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (snap.isAltScreen) scrollOffset = 0;

    const isFocused = containerEl.contains(document.activeElement);
    screenEl.classList.toggle('vt-focused', isFocused);
    scrollBtnEl.classList.toggle('hidden', scrollOffset === 0);

    const combined = scrollOffset > 0 ? snap.scrollback.concat(snap.lines) : snap.lines;
    const startIdx = scrollOffset > 0 ? Math.max(0, combined.length - snap.rows - scrollOffset) : 0;
    const isLiveView = scrollOffset === 0;
    const roundedRowHeight = Math.round(cellHeight);

    const frag = document.createDocumentFragment();
    for (let r = 0; r < snap.rows; r++) {
      const rowCells = combined[startIdx + r];
      const isCursorRow = isLiveView && snap.cursorVisible && r === snap.cursorRow;
      frag.appendChild(renderRowElement(rowCells, r, snap.cursorCol, isCursorRow, roundedRowHeight));
    }

    screenEl.replaceChildren(frag);
  }

  function scheduleRender() {
    if (destroyed || renderPending) return;
    renderPending = true;
    window.requestAnimationFrame(renderNow);
  }

  function sendSeq(seq) {
    if (!seq) return;
    jumpToBottom();
    onData?.(seq);
  }

  // Event listeners
  function onFocusIn() {
    screenEl.classList.add('vt-focused');
    scheduleRender();
  }

  function onFocusOut() {
    window.setTimeout(() => {
      if (destroyed) return;
      if (!containerEl.contains(document.activeElement)) {
        screenEl.classList.remove('vt-focused');
        scheduleRender();
      }
    }, 0);
  }

  function onMouseDown(e) {
    pointerDownPos = { x: e.clientX, y: e.clientY };
  }

  function onClick(e) {
    if (e.target === scrollBtnEl) return;
    const moved = pointerDownPos
      ? Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 4
      : false;
    pointerDownPos = null;
    if (moved || getSelectedTerminalText()) {
      return;
    }
    inputSinkEl.focus({ preventScroll: true });
  }

  function onScrollBottomClick(e) {
    e.stopPropagation();
    jumpToBottom();
    inputSinkEl.focus({ preventScroll: true });
  }

  function onWheel(e) {
    if (vtCore.isAltScreen || vtCore.scrollback.length === 0) return;
    e.preventDefault();
    const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 32));
    if (e.deltaY < 0) {
      scrollOffset = Math.min(vtCore.scrollback.length, scrollOffset + lines);
    } else if (e.deltaY > 0) {
      scrollOffset = Math.max(0, scrollOffset - lines);
    }
    scheduleRender();
  }

  function onKeyDown(e) {
    if (e.isComposing || e.key === 'Process') return;

    const lowerKey = typeof e.key === 'string' ? e.key.toLowerCase() : '';

    // Ctrl+Shift+C: always copy terminal selection
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && lowerKey === 'c') {
      const sel = getSelectedTerminalText();
      if (sel) copyText(sel);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Ctrl+C / Cmd+C: copy if terminal text is selected; otherwise Ctrl+C sends SIGINT
    if (!e.shiftKey && !e.altKey && lowerKey === 'c' && (e.ctrlKey !== e.metaKey)) {
      const sel = getSelectedTerminalText();
      if (sel) {
        copyText(sel);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.metaKey) {
        return;
      }
    }

    // Ctrl+Shift+V or Cmd+V: let browser paste event fire cleanly
    if (
      (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && lowerKey === 'v') ||
      (e.metaKey && !e.ctrlKey && !e.altKey && lowerKey === 'v')
    ) {
      e.stopPropagation();
      return;
    }

    const useCtrl = e.ctrlKey || (ctrlSticky && !['Control', 'Shift', 'Alt', 'Meta'].includes(e.key));
    const effectiveEv = {
      key: e.key,
      ctrlKey: useCtrl,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    };

    const seq = encodeKeyEvent(effectiveEv, { appCursorKeys: vtCore.appCursorKeys });
    if (seq !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (ctrlSticky) setCtrlSticky(false);
      sendSeq(seq);
    }
  }

  function onCompositionStart() {
    isComposing = true;
  }

  function onCompositionEnd() {
    isComposing = false;
    const text = inputSinkEl.value;
    inputSinkEl.value = '';
    if (text) {
      sendSeq(text);
    }
  }

  function onInput() {
    if (isComposing) return;
    const text = inputSinkEl.value;
    if (text) {
      inputSinkEl.value = '';
      if (ctrlSticky && text.length === 1) {
        const seq = encodeKeyEvent({ key: text, ctrlKey: true }, { appCursorKeys: vtCore.appCursorKeys });
        setCtrlSticky(false);
        if (seq !== null) {
          sendSeq(seq);
          return;
        }
      }
      sendSeq(text);
    }
  }

  function onPaste(e) {
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    inputSinkEl.value = '';
    if (text) {
      sendSeq(encodePaste(text, vtCore.bracketedPaste));
    }
  }

  containerEl.addEventListener('focusin', onFocusIn);
  containerEl.addEventListener('focusout', onFocusOut);
  containerEl.addEventListener('mousedown', onMouseDown);
  containerEl.addEventListener('click', onClick);
  containerEl.addEventListener('wheel', onWheel, { passive: false });
  scrollBtnEl.addEventListener('click', onScrollBottomClick);

  inputSinkEl.addEventListener('keydown', onKeyDown);
  inputSinkEl.addEventListener('compositionstart', onCompositionStart);
  inputSinkEl.addEventListener('compositionend', onCompositionEnd);
  inputSinkEl.addEventListener('input', onInput);
  inputSinkEl.addEventListener('paste', onPaste);

  // Touch / Quick Key Bar
  const keyBarCleanups = [];
  if (keyBarEl) {
    keyBarEl.replaceChildren();
    const keySpecs = [
      { label: 'ESC', key: 'Escape', title: 'Escape' },
      { label: 'TAB', key: 'Tab', title: 'Tab completion' },
      { label: 'CTRL', key: 'Control', sticky: true, title: 'Sticky Ctrl modifier' },
      { label: '↑', key: 'ArrowUp', title: 'Up Arrow' },
      { label: '↓', key: 'ArrowDown', title: 'Down Arrow' },
      { label: '←', key: 'ArrowLeft', title: 'Left Arrow' },
      { label: '→', key: 'ArrowRight', title: 'Right Arrow' },
    ];

    for (const spec of keySpecs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vt-keybar-btn';
      btn.textContent = spec.label;
      btn.title = spec.title;
      if (spec.sticky) {
        ctrlBtnEl = btn;
        btn.setAttribute('aria-pressed', 'false');
      }

      const activateKey = () => {
        if (spec.sticky) {
          setCtrlSticky(!ctrlSticky);
        } else {
          const seq = encodeKeyEvent(
            { key: spec.key, ctrlKey: ctrlSticky },
            { appCursorKeys: vtCore.appCursorKeys },
          );
          if (ctrlSticky) setCtrlSticky(false);
          if (seq !== null) sendSeq(seq);
        }
        inputSinkEl.focus({ preventScroll: true });
      };

      let pointerHandled = false;
      let keyHandled = false;
      let flagResetTimer = null;

      const scheduleFlagReset = () => {
        if (flagResetTimer !== null) {
          window.clearTimeout(flagResetTimer);
        }
        flagResetTimer = window.setTimeout(() => {
          pointerHandled = false;
          keyHandled = false;
          flagResetTimer = null;
        }, 400);
      };

      const onBtnPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        pointerHandled = true;
        scheduleFlagReset();
        activateKey();
      };

      const onBtnKeyDown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        keyHandled = true;
        scheduleFlagReset();
        activateKey();
      };

      const onBtnClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pointerHandled || keyHandled) {
          pointerHandled = false;
          keyHandled = false;
          if (flagResetTimer !== null) {
            window.clearTimeout(flagResetTimer);
            flagResetTimer = null;
          }
          return;
        }
        activateKey();
      };

      btn.addEventListener('pointerdown', onBtnPointerDown);
      btn.addEventListener('keydown', onBtnKeyDown);
      btn.addEventListener('click', onBtnClick);
      keyBarEl.appendChild(btn);
      keyBarCleanups.push(() => {
        if (flagResetTimer !== null) {
          window.clearTimeout(flagResetTimer);
          flagResetTimer = null;
        }
        btn.removeEventListener('pointerdown', onBtnPointerDown);
        btn.removeEventListener('keydown', onBtnKeyDown);
        btn.removeEventListener('click', onBtnClick);
      });
    }
  }

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(containerEl);
  }

  let fontsDisposed = false;
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!fontsDisposed && !destroyed) fit();
    });
  }

  fit();
  renderNow();

  return {
    write(bytesOrStr) {
      if (destroyed) return;
      vtCore.write(bytesOrStr);
      scheduleRender();
    },
    focus() {
      if (destroyed) return;
      inputSinkEl.focus({ preventScroll: true });
    },
    fit,
    clear() {
      if (destroyed) return;
      scrollOffset = 0;
      vtCore.write('\x1b[3J\x1b[2J\x1b[H');
      scheduleRender();
    },
    getColsRows() {
      return { cols: vtCore.cols, rows: vtCore.rows };
    },
    destroy() {
      destroyed = true;
      fontsDisposed = true;
      if (resizeObserver) resizeObserver.disconnect();
      containerEl.removeEventListener('focusin', onFocusIn);
      containerEl.removeEventListener('focusout', onFocusOut);
      containerEl.removeEventListener('mousedown', onMouseDown);
      containerEl.removeEventListener('click', onClick);
      containerEl.removeEventListener('wheel', onWheel);
      scrollBtnEl.removeEventListener('click', onScrollBottomClick);
      inputSinkEl.removeEventListener('keydown', onKeyDown);
      inputSinkEl.removeEventListener('compositionstart', onCompositionStart);
      inputSinkEl.removeEventListener('compositionend', onCompositionEnd);
      inputSinkEl.removeEventListener('input', onInput);
      inputSinkEl.removeEventListener('paste', onPaste);
      for (const cleanup of keyBarCleanups) cleanup();
      containerEl.replaceChildren();
    },
  };
}
