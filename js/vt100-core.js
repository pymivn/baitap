/**
 * Pure VT100/ANSI terminal emulator state machine and keyboard encoder.
 * Zero DOM, window, document, or I/O dependencies.
 */

const ANSI_16_PALETTE = Object.freeze([
  '#000000', '#cc0000', '#4e9a06', '#c4a000',
  '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f',
  '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
]);

const CUBE_LEVELS = Object.freeze([0, 95, 135, 175, 215, 255]);

function toHexByte(value) {
  const clamped = Math.max(0, Math.min(255, value | 0));
  return clamped.toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function color256ToHex(index) {
  const n = Math.max(0, Math.min(255, index | 0));
  if (n < 16) return ANSI_16_PALETTE[n];
  if (n < 232) {
    const idx = n - 16;
    const r = CUBE_LEVELS[Math.floor(idx / 36)];
    const g = CUBE_LEVELS[Math.floor((idx % 36) / 6)];
    const b = CUBE_LEVELS[idx % 6];
    return rgbToHex(r, g, b);
  }
  const gray = 8 + (n - 232) * 10;
  return rgbToHex(gray, gray, gray);
}

function defaultSgr() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function makeCell(ch = ' ', sgr = null) {
  if (!sgr) {
    return {
      ch,
      fg: null,
      bg: null,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
    };
  }
  return {
    ch,
    fg: sgr.fg,
    bg: sgr.bg,
    bold: sgr.bold,
    dim: sgr.dim,
    italic: sgr.italic,
    underline: sgr.underline,
    inverse: sgr.inverse,
  };
}

function makeBlankCell(bg = null) {
  return {
    ch: ' ',
    fg: null,
    bg,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function makeBlankLine(cols, bg = null) {
  const line = new Array(cols);
  for (let i = 0; i < cols; i++) {
    line[i] = makeBlankCell(bg);
  }
  return line;
}

function makeGrid(cols, rows) {
  const grid = new Array(rows);
  for (let r = 0; r < rows; r++) {
    grid[r] = makeBlankLine(cols);
  }
  return grid;
}

function cloneLine(line) {
  return line.map((cell) => ({ ...cell }));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const STATE = Object.freeze({
  GROUND: 0,
  ESC: 1,
  CSI: 2,
  OSC: 3,
  OSC_ESC: 4,
  CHARSET: 5,
  STR_SKIP: 6,
  STR_SKIP_ESC: 7,
});

export class VT100Core {
  constructor({ cols = 80, rows = 24, maxScrollback = 2000 } = {}) {
    this.cols = Math.max(1, cols | 0);
    this.rows = Math.max(1, rows | 0);
    this.maxScrollback = Math.max(0, maxScrollback | 0);

    this._decoder = new TextDecoder('utf-8', { fatal: false });
    this._resetAll();
  }

  _resetAll() {
    this.lines = makeGrid(this.cols, this.rows);
    this.scrollback = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.wrapNext = false;
    this.cursorVisible = true;
    this.title = '';
    this.isAltScreen = false;
    this.appCursorKeys = false;
    this.bracketedPaste = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.sgr = defaultSgr();
    this._savedCursor = null;
    this._primaryState = null;

    this._state = STATE.GROUND;
    this._csiPrefix = '';
    this._csiParams = '';
    this._oscBuffer = '';
  }

  write(input) {
    let text = '';
    if (typeof input === 'string') {
      text = input;
    } else if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
      const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      text = this._decoder.decode(view, { stream: true });
    } else if (input instanceof ArrayBuffer) {
      text = this._decoder.decode(new Uint8Array(input), { stream: true });
    } else {
      return;
    }

    for (const ch of text) {
      this._processChar(ch);
    }
  }

  _processChar(ch) {
    const code = ch.codePointAt(0);

    switch (this._state) {
      case STATE.GROUND:
        this._handleGround(ch, code);
        break;
      case STATE.ESC:
        this._handleEsc(ch, code);
        break;
      case STATE.CSI:
        this._handleCsi(ch, code);
        break;
      case STATE.OSC:
        this._handleOsc(ch, code);
        break;
      case STATE.OSC_ESC:
        if (ch === '\\') {
          this._commitOsc();
          this._state = STATE.GROUND;
        } else {
          this._oscBuffer += '\x1b' + ch;
          this._state = STATE.OSC;
        }
        break;
      case STATE.CHARSET:
        this._state = STATE.GROUND;
        break;
      case STATE.STR_SKIP:
        if (code === 0x07) {
          this._state = STATE.GROUND;
        } else if (code === 0x1b) {
          this._state = STATE.STR_SKIP_ESC;
        }
        break;
      case STATE.STR_SKIP_ESC:
        this._state = ch === '\\' ? STATE.GROUND : STATE.STR_SKIP;
        break;
    }
  }

  _handleGround(ch, code) {
    if (code === 0x1b) {
      this._state = STATE.ESC;
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      this._executeC0(code);
      return;
    }
    this._putPrintable(ch);
  }

  _executeC0(code) {
    switch (code) {
      case 0x07: // BEL
      case 0x0e: // SO
      case 0x0f: // SI
        break;
      case 0x08: // BS
        if (this.cursorCol > 0) this.cursorCol--;
        this.wrapNext = false;
        break;
      case 0x09: // HT
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        this.wrapNext = false;
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this._lineFeed();
        break;
      case 0x0d: // CR
        this.cursorCol = 0;
        this.wrapNext = false;
        break;
      default:
        break;
    }
  }

  _putPrintable(ch) {
    if (this.wrapNext) {
      this.cursorCol = 0;
      this._lineFeed();
      this.wrapNext = false;
    }
    this.lines[this.cursorRow][this.cursorCol] = makeCell(ch, this.sgr);
    if (this.cursorCol >= this.cols - 1) {
      this.wrapNext = true;
    } else {
      this.cursorCol++;
    }
  }

  _lineFeed() {
    this.wrapNext = false;
    if (this.cursorRow === this.scrollBottom) {
      this._scrollUpRegion(this.scrollTop, this.scrollBottom, 1);
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    }
  }

  _reverseIndex() {
    this.wrapNext = false;
    if (this.cursorRow === this.scrollTop) {
      this._scrollDownRegion(this.scrollTop, this.scrollBottom, 1);
    } else if (this.cursorRow > 0) {
      this.cursorRow--;
    }
  }

  _pushScrollback(line) {
    if (this.isAltScreen || this.maxScrollback <= 0) return;
    this.scrollback.push(line);
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback.shift();
    }
  }

  _scrollUpRegion(top, bottom, count) {
    const n = Math.min(count, bottom - top + 1);
    const bg = this.sgr.bg;
    for (let i = 0; i < n; i++) {
      const removed = this.lines[top];
      if (top === 0) this._pushScrollback(removed);
      for (let r = top; r < bottom; r++) {
        this.lines[r] = this.lines[r + 1];
      }
      this.lines[bottom] = makeBlankLine(this.cols, bg);
    }
  }

  _scrollDownRegion(top, bottom, count) {
    const n = Math.min(count, bottom - top + 1);
    const bg = this.sgr.bg;
    for (let i = 0; i < n; i++) {
      for (let r = bottom; r > top; r--) {
        this.lines[r] = this.lines[r - 1];
      }
      this.lines[top] = makeBlankLine(this.cols, bg);
    }
  }

  _handleEsc(ch, code) {
    if (code === 0x1b) return;
    if (ch === '[') {
      this._csiPrefix = '';
      this._csiParams = '';
      this._state = STATE.CSI;
      return;
    }
    if (ch === ']') {
      this._oscBuffer = '';
      this._state = STATE.OSC;
      return;
    }
    if (ch === '(' || ch === ')' || ch === '*' || ch === '+') {
      this._state = STATE.CHARSET;
      return;
    }
    if (ch === 'P' || ch === '_' || ch === '^') {
      this._state = STATE.STR_SKIP;
      return;
    }

    this._state = STATE.GROUND;
    switch (ch) {
      case '7':
        this._saveCursor();
        break;
      case '8':
        this._restoreCursor();
        break;
      case 'D':
        this._lineFeed();
        break;
      case 'E':
        this.cursorCol = 0;
        this._lineFeed();
        break;
      case 'M':
        this._reverseIndex();
        break;
      case 'c':
        this._resetAll();
        break;
      default:
        break;
    }
  }

  _handleCsi(ch, code) {
    if (code === 0x1b) {
      this._state = STATE.ESC;
      return;
    }
    if (code === 0x18 || code === 0x1a) {
      this._state = STATE.GROUND;
      return;
    }
    if (code < 0x20) {
      this._executeC0(code);
      return;
    }
    if (this._csiParams.length === 0 && (ch === '?' || ch === '>' || ch === '<' || ch === '=')) {
      this._csiPrefix = ch;
      return;
    }
    if ((ch >= '0' && ch <= '9') || ch === ';' || ch === ':' || (code >= 0x20 && code <= 0x2f)) {
      this._csiParams += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      this._state = STATE.GROUND;
      this._dispatchCsi(ch, this._csiPrefix, this._csiParams);
    }
  }

  _parseParams(rawParams) {
    if (!rawParams) return [];
    return rawParams.split(';').map((part) => {
      if (part === '') return null;
      const val = Number.parseInt(part, 10);
      return Number.isNaN(val) ? null : val;
    });
  }

  _param(params, idx, fallback) {
    if (idx >= params.length || params[idx] === null || params[idx] === 0) {
      return fallback;
    }
    return params[idx];
  }

  _paramZeroAllowed(params, idx, fallback) {
    if (idx >= params.length || params[idx] === null) {
      return fallback;
    }
    return params[idx];
  }

  _dispatchCsi(finalChar, prefix, rawParams) {
    if (prefix === '?') {
      const params = this._parseParams(rawParams);
      if (finalChar === 'h' || finalChar === 'l') {
        this._setDecPrivateModes(params, finalChar === 'h');
      }
      return;
    }
    if (prefix !== '') return;

    if (finalChar === 'm') {
      this._applySgr(rawParams);
      return;
    }

    const params = this._parseParams(rawParams);
    switch (finalChar) {
      case 'A': {
        const n = this._param(params, 0, 1);
        const minRow = this.cursorRow >= this.scrollTop ? this.scrollTop : 0;
        this.cursorRow = Math.max(minRow, this.cursorRow - n);
        this.wrapNext = false;
        break;
      }
      case 'B': {
        const n = this._param(params, 0, 1);
        const maxRow = this.cursorRow <= this.scrollBottom ? this.scrollBottom : this.rows - 1;
        this.cursorRow = Math.min(maxRow, this.cursorRow + n);
        this.wrapNext = false;
        break;
      }
      case 'C': {
        const n = this._param(params, 0, 1);
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n);
        this.wrapNext = false;
        break;
      }
      case 'D': {
        const n = this._param(params, 0, 1);
        this.cursorCol = Math.max(0, this.cursorCol - n);
        this.wrapNext = false;
        break;
      }
      case 'E': {
        const n = this._param(params, 0, 1);
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n);
        this.cursorCol = 0;
        this.wrapNext = false;
        break;
      }
      case 'F': {
        const n = this._param(params, 0, 1);
        this.cursorRow = Math.max(0, this.cursorRow - n);
        this.cursorCol = 0;
        this.wrapNext = false;
        break;
      }
      case 'G': {
        const col = this._param(params, 0, 1) - 1;
        this.cursorCol = clamp(col, 0, this.cols - 1);
        this.wrapNext = false;
        break;
      }
      case 'd': {
        const row = this._param(params, 0, 1) - 1;
        this.cursorRow = clamp(row, 0, this.rows - 1);
        this.wrapNext = false;
        break;
      }
      case 'H':
      case 'f': {
        const row = this._param(params, 0, 1) - 1;
        const col = this._param(params, 1, 1) - 1;
        this.cursorRow = clamp(row, 0, this.rows - 1);
        this.cursorCol = clamp(col, 0, this.cols - 1);
        this.wrapNext = false;
        break;
      }
      case 'J':
        this._eraseInDisplay(this._paramZeroAllowed(params, 0, 0));
        break;
      case 'K':
        this._eraseInLine(this._paramZeroAllowed(params, 0, 0));
        break;
      case 'X': {
        const n = this._param(params, 0, 1);
        const end = Math.min(this.cols, this.cursorCol + n);
        for (let c = this.cursorCol; c < end; c++) {
          this.lines[this.cursorRow][c] = makeBlankCell(this.sgr.bg);
        }
        this.wrapNext = false;
        break;
      }
      case 'L': {
        const n = this._param(params, 0, 1);
        if (this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom) {
          this._scrollDownRegion(this.cursorRow, this.scrollBottom, n);
        }
        this.wrapNext = false;
        break;
      }
      case 'M': {
        const n = this._param(params, 0, 1);
        if (this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom) {
          this._scrollUpRegion(this.cursorRow, this.scrollBottom, n);
        }
        this.wrapNext = false;
        break;
      }
      case '@': {
        const n = Math.min(this._param(params, 0, 1), this.cols - this.cursorCol);
        const row = this.lines[this.cursorRow];
        for (let c = this.cols - 1; c >= this.cursorCol + n; c--) {
          row[c] = row[c - n];
        }
        for (let c = this.cursorCol; c < this.cursorCol + n; c++) {
          row[c] = makeBlankCell(this.sgr.bg);
        }
        this.wrapNext = false;
        break;
      }
      case 'P': {
        const n = Math.min(this._param(params, 0, 1), this.cols - this.cursorCol);
        const row = this.lines[this.cursorRow];
        for (let c = this.cursorCol; c < this.cols - n; c++) {
          row[c] = row[c + n];
        }
        for (let c = this.cols - n; c < this.cols; c++) {
          row[c] = makeBlankCell(this.sgr.bg);
        }
        this.wrapNext = false;
        break;
      }
      case 'S':
        this._scrollUpRegion(this.scrollTop, this.scrollBottom, this._param(params, 0, 1));
        break;
      case 'T':
        this._scrollDownRegion(this.scrollTop, this.scrollBottom, this._param(params, 0, 1));
        break;
      case 'r': {
        const top = this._param(params, 0, 1) - 1;
        const bottom = this._param(params, 1, this.rows) - 1;
        if (top >= 0 && bottom < this.rows && top < bottom) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
        } else {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.wrapNext = false;
        break;
      }
      case 's':
        this._saveCursor();
        break;
      case 'u':
        this._restoreCursor();
        break;
      default:
        break;
    }
  }

  _eraseInDisplay(mode) {
    const bg = this.sgr.bg;
    if (mode === 0) {
      this._eraseInLine(0);
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        this.lines[r] = makeBlankLine(this.cols, bg);
      }
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) {
        this.lines[r] = makeBlankLine(this.cols, bg);
      }
      this._eraseInLine(1);
    } else if (mode === 2) {
      for (let r = 0; r < this.rows; r++) {
        this.lines[r] = makeBlankLine(this.cols, bg);
      }
    } else if (mode === 3) {
      this.scrollback = [];
    }
    this.wrapNext = false;
  }

  _eraseInLine(mode) {
    const bg = this.sgr.bg;
    const row = this.lines[this.cursorRow];
    if (mode === 0) {
      for (let c = this.cursorCol; c < this.cols; c++) {
        row[c] = makeBlankCell(bg);
      }
    } else if (mode === 1) {
      for (let c = 0; c <= this.cursorCol; c++) {
        row[c] = makeBlankCell(bg);
      }
    } else if (mode === 2) {
      this.lines[this.cursorRow] = makeBlankLine(this.cols, bg);
    }
    this.wrapNext = false;
  }

  _saveCursor() {
    this._savedCursor = {
      row: this.cursorRow,
      col: this.cursorCol,
      wrapNext: this.wrapNext,
      sgr: { ...this.sgr },
    };
  }

  _restoreCursor() {
    if (!this._savedCursor) return;
    this.cursorRow = clamp(this._savedCursor.row, 0, this.rows - 1);
    this.cursorCol = clamp(this._savedCursor.col, 0, this.cols - 1);
    this.wrapNext = this._savedCursor.wrapNext;
    this.sgr = { ...this._savedCursor.sgr };
  }

  _setDecPrivateModes(params, enable) {
    for (const mode of params) {
      if (mode === null) continue;
      switch (mode) {
        case 1:
          this.appCursorKeys = enable;
          break;
        case 25:
          this.cursorVisible = enable;
          break;
        case 2004:
          this.bracketedPaste = enable;
          break;
        case 47:
        case 1047:
        case 1049:
          if (enable) {
            this._enterAltScreen(mode === 1049);
          } else {
            this._leaveAltScreen(mode === 1049);
          }
          break;
        case 1048:
          if (enable) this._saveCursor();
          else this._restoreCursor();
          break;
        default:
          break;
      }
    }
  }

  _enterAltScreen(saveCursor) {
    if (this.isAltScreen) return;
    this._primaryState = {
      lines: this.lines,
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
      wrapNext: this.wrapNext,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
      sgr: { ...this.sgr },
      savedCursor: this._savedCursor ? { ...this._savedCursor, sgr: { ...this._savedCursor.sgr } } : null,
    };
    this.isAltScreen = true;
    this.lines = makeGrid(this.cols, this.rows);
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    if (saveCursor) {
      this.cursorRow = 0;
      this.cursorCol = 0;
      this.wrapNext = false;
    }
  }

  _leaveAltScreen(restoreCursor) {
    if (!this.isAltScreen || !this._primaryState) return;
    const prev = this._primaryState;
    this.isAltScreen = false;
    this.lines = prev.lines;
    this.scrollTop = prev.scrollTop;
    this.scrollBottom = prev.scrollBottom;
    this.sgr = { ...prev.sgr };
    this._savedCursor = prev.savedCursor;
    if (restoreCursor) {
      this.cursorRow = prev.cursorRow;
      this.cursorCol = prev.cursorCol;
      this.wrapNext = prev.wrapNext;
    } else {
      this.wrapNext = false;
    }
    this._primaryState = null;
    if (this.lines.length !== this.rows || (this.lines[0] && this.lines[0].length !== this.cols)) {
      this._resizeGrid(this.lines, this.cols, this.rows);
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
      this.wrapNext = false;
    }
    this.cursorRow = clamp(this.cursorRow, 0, this.rows - 1);
    this.cursorCol = clamp(this.cursorCol, 0, this.cols - 1);
  }

  _applySgr(rawParams) {
    if (!rawParams) {
      this.sgr = defaultSgr();
      return;
    }
    // Support colon sub-parameters (e.g. 38:2:r:g:b) alongside standard semicolons
    const tokens = rawParams.split(';').map((s) => (s === '' ? 0 : Number.parseInt(s, 10)));
    const rawParts = rawParams.split(';');

    for (let i = 0; i < tokens.length; i++) {
      const part = rawParts[i];
      if (part.includes(':')) {
        const sub = part.split(':').map((x) => Number.parseInt(x || '0', 10));
        if ((sub[0] === 38 || sub[0] === 48) && sub[1] === 5 && sub.length >= 3) {
          const hex = color256ToHex(sub[2]);
          if (sub[0] === 38) this.sgr.fg = hex;
          else this.sgr.bg = hex;
        } else if ((sub[0] === 38 || sub[0] === 48) && sub[1] === 2) {
          const offset = sub.length >= 6 ? 3 : 2;
          if (sub.length >= offset + 3) {
            const hex = rgbToHex(sub[offset], sub[offset + 1], sub[offset + 2]);
            if (sub[0] === 38) this.sgr.fg = hex;
            else this.sgr.bg = hex;
          }
        }
        continue;
      }

      const code = Number.isNaN(tokens[i]) ? 0 : tokens[i];
      if (code === 0) {
        this.sgr = defaultSgr();
      } else if (code === 1) {
        this.sgr.bold = true;
      } else if (code === 2) {
        this.sgr.dim = true;
      } else if (code === 3) {
        this.sgr.italic = true;
      } else if (code === 4) {
        this.sgr.underline = true;
      } else if (code === 7) {
        this.sgr.inverse = true;
      } else if (code === 22) {
        this.sgr.bold = false;
        this.sgr.dim = false;
      } else if (code === 23) {
        this.sgr.italic = false;
      } else if (code === 24) {
        this.sgr.underline = false;
      } else if (code === 27) {
        this.sgr.inverse = false;
      } else if (code >= 30 && code <= 37) {
        this.sgr.fg = ANSI_16_PALETTE[code - 30];
      } else if (code === 39) {
        this.sgr.fg = null;
      } else if (code >= 40 && code <= 47) {
        this.sgr.bg = ANSI_16_PALETTE[code - 40];
      } else if (code === 49) {
        this.sgr.bg = null;
      } else if (code >= 90 && code <= 97) {
        this.sgr.fg = ANSI_16_PALETTE[8 + (code - 90)];
      } else if (code >= 100 && code <= 107) {
        this.sgr.bg = ANSI_16_PALETTE[8 + (code - 100)];
      } else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = tokens[i + 1];
        if (mode === 5 && i + 2 < tokens.length) {
          const hex = color256ToHex(tokens[i + 2]);
          if (isFg) this.sgr.fg = hex;
          else this.sgr.bg = hex;
          i += 2;
        } else if (mode === 2 && i + 4 < tokens.length) {
          const hex = rgbToHex(tokens[i + 2], tokens[i + 3], tokens[i + 4]);
          if (isFg) this.sgr.fg = hex;
          else this.sgr.bg = hex;
          i += 4;
        }
      }
    }
  }

  _handleOsc(ch, code) {
    if (code === 0x07) {
      this._commitOsc();
      this._state = STATE.GROUND;
    } else if (code === 0x1b) {
      this._state = STATE.OSC_ESC;
    } else {
      this._oscBuffer += ch;
    }
  }

  _commitOsc() {
    const sep = this._oscBuffer.indexOf(';');
    if (sep !== -1) {
      const oscCode = this._oscBuffer.slice(0, sep);
      if (oscCode === '0' || oscCode === '2') {
        this.title = this._oscBuffer.slice(sep + 1);
      }
    }
    this._oscBuffer = '';
  }

  _resizeGrid(grid, newCols, newRows) {
    for (let r = 0; r < grid.length; r++) {
      const line = grid[r];
      if (line.length > newCols) {
        grid[r] = line.slice(0, newCols);
      } else if (line.length < newCols) {
        const extra = makeBlankLine(newCols - line.length);
        grid[r] = line.concat(extra);
      }
    }
    if (grid.length > newRows) {
      grid.length = newRows;
    } else {
      while (grid.length < newRows) {
        grid.push(makeBlankLine(newCols));
      }
    }
  }

  resize(cols, rows) {
    const newCols = Math.max(1, cols | 0);
    const newRows = Math.max(1, rows | 0);
    if (newCols === this.cols && newRows === this.rows) return;

    if (!this.isAltScreen && newRows < this.rows && this.cursorRow >= newRows) {
      const shift = Math.min(this.cursorRow - newRows + 1, this.lines.length - newRows);
      for (let i = 0; i < shift; i++) {
        this._pushScrollback(this.lines.shift());
      }
      this.cursorRow -= shift;
    }

    this._resizeGrid(this.lines, newCols, newRows);
    this.cols = newCols;
    this.rows = newRows;
    this.scrollTop = 0;
    this.scrollBottom = newRows - 1;
    this.cursorRow = clamp(this.cursorRow, 0, newRows - 1);
    this.cursorCol = clamp(this.cursorCol, 0, newCols - 1);
    this.wrapNext = false;
  }

  getSnapshot() {
    return {
      cols: this.cols,
      rows: this.rows,
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
      cursorVisible: this.cursorVisible,
      title: this.title,
      isAltScreen: this.isAltScreen,
      appCursorKeys: this.appCursorKeys,
      bracketedPaste: this.bracketedPaste,
      lines: this.lines.map(cloneLine),
      scrollback: this.scrollback.map(cloneLine),
    };
  }

  getPlainText() {
    return this.lines
      .map((line) => line.map((c) => c.ch).join('').replace(/\s+$/, ''))
      .join('\n');
  }
}

export function createTerminalState(options = {}) {
  return new VT100Core(options);
}

const MODIFIER_ONLY_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'OS', 'Super', 'Hyper', 'AltGraph',
]);

const SPECIAL_KEY_SEQUENCES = Object.freeze({
  Enter: '\r',
  Backspace: '\x7f',
  Escape: '\x1b',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
});

const CURSOR_KEY_LETTERS = Object.freeze({
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
});

const CTRL_SYMBOL_MAP = Object.freeze({
  '@': '\x00',
  ' ': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '?': '\x7f',
});

export function encodeKeyEvent(ev, options = {}) {
  if (!ev || typeof ev.key !== 'string') return null;
  const {
    key,
    ctrlKey = false,
    altKey = false,
    metaKey = false,
    shiftKey = false,
  } = ev;
  const { appCursorKeys = false } = options;

  if (MODIFIER_ONLY_KEYS.has(key)) return null;
  if (metaKey) return null;

  if (key === 'Tab') {
    return shiftKey ? '\x1b[Z' : '\t';
  }

  if (key in CURSOR_KEY_LETTERS) {
    const letter = CURSOR_KEY_LETTERS[key];
    const mod = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
    if (mod > 1) {
      return `\x1b[1;${mod}${letter}`;
    }
    return appCursorKeys ? `\x1bO${letter}` : `\x1b[${letter}`;
  }

  if (key in SPECIAL_KEY_SEQUENCES) {
    const seq = SPECIAL_KEY_SEQUENCES[key];
    return altKey ? `\x1b${seq}` : seq;
  }

  if (ctrlKey) {
    let ctrlSeq = null;
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (upper >= 'A' && upper <= 'Z') {
        ctrlSeq = String.fromCharCode(upper.charCodeAt(0) - 64);
      } else if (key in CTRL_SYMBOL_MAP) {
        ctrlSeq = CTRL_SYMBOL_MAP[key];
      }
    }
    if (ctrlSeq === null) return null;
    return altKey ? `\x1b${ctrlSeq}` : ctrlSeq;
  }

  if ([...key].length === 1) {
    return altKey ? `\x1b${key}` : key;
  }

  return null;
}

export function encodePaste(text, bracketedPaste = false) {
  const normalized = String(text ?? '').replace(/\r\n|\n/g, '\r');
  if (bracketedPaste) {
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return normalized;
}
