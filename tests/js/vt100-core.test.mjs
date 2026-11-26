import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalState,
  encodeKeyEvent,
  encodePaste,
} from '../../js/vt100-core.js';

describe('vt100-core: createTerminalState & basic output', () => {
  it('initializes with default dimensions and clean state', () => {
    const term = createTerminalState();
    const snap = term.getSnapshot();
    assert.equal(snap.cols, 80);
    assert.equal(snap.rows, 24);
    assert.equal(snap.cursorRow, 0);
    assert.equal(snap.cursorCol, 0);
    assert.equal(snap.cursorVisible, true);
    assert.equal(snap.title, '');
    assert.equal(snap.isAltScreen, false);
    assert.equal(snap.appCursorKeys, false);
    assert.equal(snap.bracketedPaste, false);
    assert.equal(snap.lines.length, 24);
    assert.equal(snap.lines[0].length, 80);
    assert.deepEqual(snap.lines[0][0], {
      ch: ' ',
      fg: null,
      bg: null,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
    });
    assert.equal(snap.scrollback.length, 0);
  });

  it('writes printable text and returns trimmed getPlainText()', () => {
    const term = createTerminalState({ cols: 20, rows: 5 });
    term.write('Hello, PyMi!\r\nLine 2');
    assert.equal(term.getPlainText(), 'Hello, PyMi!\nLine 2\n\n\n');
    const snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 1);
    assert.equal(snap.cursorCol, 6);
  });

  it('decodes Uint8Array UTF-8 chunks split mid-codepoint', () => {
    const term = createTerminalState({ cols: 30, rows: 3 });
    const bytes = new TextEncoder().encode('Học viên PyMi 🚀');
    // Split inside multi-byte UTF-8 sequence
    term.write(bytes.slice(0, 3));
    term.write(bytes.slice(3, 10));
    term.write(bytes.slice(10));
    assert.equal(term.getPlainText().split('\n')[0], 'Học viên PyMi 🚀');
  });

  it('handles control characters: \\r, \\n, \\b, \\t, \\x07, \\x0e, \\x0f', () => {
    const term = createTerminalState({ cols: 24, rows: 4 });
    term.write('AB\tCD\bE\x07\x0e\x0f');
    // 'AB' at 0,1 -> tab to col 8 -> 'CD' at 8,9 -> \b to 9 -> 'E' at 9
    assert.equal(term.getPlainText().split('\n')[0], 'AB      CE');
    term.write('\rX');
    assert.equal(term.getPlainText().split('\n')[0], 'XB      CE');
    term.write('\nY');
    const lines = term.getPlainText().split('\n');
    assert.equal(lines[1], ' Y');
  });

  it('wraps lines cleanly with deferred wrap at right margin', () => {
    const term = createTerminalState({ cols: 5, rows: 3 });
    term.write('12345');
    // Deferred wrap: cursor stays at col 4, row 0 until next char
    let snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 0);
    assert.equal(snap.cursorCol, 4);
    term.write('6');
    snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 1);
    assert.equal(snap.cursorCol, 1);
    assert.equal(term.getPlainText(), '12345\n6\n');
  });
});

describe('vt100-core: split escape sequences & CSI cursor/erase', () => {
  it('handles CSI sequences split across multiple write() calls', () => {
    const term = createTerminalState({ cols: 20, rows: 5 });
    term.write('hello\x1b');
    term.write('[2;');
    term.write('4H');
    term.write('X');
    const snap = term.getSnapshot();
    assert.equal(snap.lines[1][3].ch, 'X');
  });

  it('handles cursor movement A, B, C, D, E, F, G, d, H, f', () => {
    const term = createTerminalState({ cols: 10, rows: 6 });
    term.write('\x1b[3;5H'); // row 2, col 4
    let snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 2);
    assert.equal(snap.cursorCol, 4);

    term.write('\x1b[2A'); // row 0
    assert.equal(term.getSnapshot().cursorRow, 0);
    term.write('\x1b[3B'); // row 3
    assert.equal(term.getSnapshot().cursorRow, 3);
    term.write('\x1b[2C'); // col 6
    assert.equal(term.getSnapshot().cursorCol, 6);
    term.write('\x1b[4D'); // col 2
    assert.equal(term.getSnapshot().cursorCol, 2);

    term.write('\x1b[1E'); // next line col 0 -> row 4, col 0
    snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 4);
    assert.equal(snap.cursorCol, 0);

    term.write('\x1b[5G'); // col 4
    assert.equal(term.getSnapshot().cursorCol, 4);

    term.write('\x1b[2F'); // prev 2 lines col 0 -> row 2, col 0
    snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 2);
    assert.equal(snap.cursorCol, 0);

    term.write('\x1b[6d'); // row 5
    assert.equal(term.getSnapshot().cursorRow, 5);
    term.write('\x1b[2;3f'); // row 1, col 2
    snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 1);
    assert.equal(snap.cursorCol, 2);
  });

  it('handles J (0,1,2,3), K (0,1,2), and X erase sequences', () => {
    const term = createTerminalState({ cols: 6, rows: 3 });
    term.write('AAAAAA\r\nBBBBBB\r\nCCCCCC');
    // Cursor at row 2, col 6 (deferred wrap at 2,5)
    term.write('\x1b[2;3H'); // row 1, col 2 ('B')
    term.write('\x1b[K'); // erase to EOL
    assert.equal(term.getPlainText().split('\n')[1], 'BB');

    term.write('\x1b[1;4H'); // row 0, col 3
    term.write('\x1b[1K'); // erase from SOL to col 3 inclusive
    assert.equal(term.getPlainText().split('\n')[0], '    AA');

    term.write('\x1b[3;2H'); // row 2, col 1
    term.write('\x1b[2X'); // erase 2 chars
    assert.equal(term.getPlainText().split('\n')[2], 'C  CCC');

    term.write('\x1b[2;3H\x1b[0J'); // erase from (1,2) to end
    assert.equal(term.getPlainText(), '    AA\nBB\n');

    term.write('\x1b[2;2H\x1b[1J'); // erase from start to (1,1)
    assert.equal(term.getPlainText(), '\n\n');

    term.write('111111\r\n222222\r\n333333\r\n444444');
    assert.ok(term.getSnapshot().scrollback.length >= 1);
    term.write('\x1b[3J'); // clear scrollback
    assert.equal(term.getSnapshot().scrollback.length, 0);
    term.write('\x1b[2J'); // clear screen
    assert.equal(term.getPlainText(), '\n\n');
  });

  it('handles L, M, @, P, S, T, DECSTBM (r), and ESC M', () => {
    const term = createTerminalState({ cols: 6, rows: 4 });
    term.write('111111\r\n222222\r\n333333\r\n444444');
    // Set scroll region rows 2..3 (1-based)
    term.write('\x1b[2;3r');
    // Cursor is at (0,0) after DECSTBM
    term.write('\x1b[2;1H');
    term.write('\x1b[1L'); // insert line at row 1 inside [1..2]
    assert.equal(term.getPlainText(), '111111\n\n222222\n444444');

    term.write('\x1b[2;1H\x1b[1M'); // delete line at row 1
    assert.equal(term.getPlainText(), '111111\n222222\n\n444444');

    term.write('\x1b[1;2H\x1b[2@'); // insert 2 spaces at row 0 col 1
    assert.equal(term.getPlainText().split('\n')[0], '1  111');

    term.write('\x1b[1;2H\x1b[1P'); // delete 1 char at row 0 col 1
    assert.equal(term.getPlainText().split('\n')[0], '1 111');

    // Reset scroll region and test S, T, ESC M
    term.write('\x1b[r');
    term.write('\x1b[1;1H\x1bM'); // Reverse index at top row scrolls down
    assert.equal(term.getPlainText().split('\n')[0], '');
    assert.equal(term.getPlainText().split('\n')[1], '1 111');

    term.write('\x1b[1S'); // Scroll up 1
    assert.equal(term.getPlainText().split('\n')[0], '1 111');
    term.write('\x1b[1T'); // Scroll down 1
    assert.equal(term.getPlainText().split('\n')[1], '1 111');
  });

  it('saves and restores cursor with CSI s/u and ESC 7/8', () => {
    const term = createTerminalState({ cols: 20, rows: 5 });
    term.write('\x1b[2;5H\x1b[s\x1b[4;10H\x1b[u');
    let snap = term.getSnapshot();
    assert.equal(snap.cursorRow, 1);
    assert.equal(snap.cursorCol, 4);

    term.write('\x1b[3;8H\x1b[1m\x1b7\x1b[0m\x1b[1;1H\x1b8A');
    snap = term.getSnapshot();
    assert.equal(snap.lines[2][7].ch, 'A');
    assert.equal(snap.lines[2][7].bold, true);
  });
});

describe('vt100-core: SGR colors & attributes', () => {
  it('applies bold, dim, italic, underline, inverse, and reset codes', () => {
    const term = createTerminalState({ cols: 20, rows: 2 });
    term.write('\x1b[1;2;3;4;7mA\x1b[22;23;24;27mB\x1b[0mC');
    const row = term.getSnapshot().lines[0];
    assert.equal(row[0].bold, true);
    assert.equal(row[0].dim, true);
    assert.equal(row[0].italic, true);
    assert.equal(row[0].underline, true);
    assert.equal(row[0].inverse, true);

    assert.equal(row[1].bold, false);
    assert.equal(row[1].dim, false);
    assert.equal(row[1].italic, false);
    assert.equal(row[1].underline, false);
    assert.equal(row[1].inverse, false);
  });

  it('applies 16-color, 256-color, and 24-bit truecolor SGR', () => {
    const term = createTerminalState({ cols: 20, rows: 2 });
    term.write('\x1b[31;42mA\x1b[91;104mB\x1b[39;49mC');
    term.write('\x1b[38;5;196;48;5;232mD');
    term.write('\x1b[38;2;12;34;56;48;2;200;210;220mE');

    const row = term.getSnapshot().lines[0];
    assert.ok(row[0].fg && row[0].bg);
    assert.ok(row[1].fg && row[1].bg);
    assert.notEqual(row[0].fg, row[1].fg);
    assert.equal(row[2].fg, null);
    assert.equal(row[2].bg, null);
    assert.equal(row[3].fg, '#ff0000');
    assert.equal(row[3].bg, '#080808');
    assert.equal(row[4].fg, '#0c2238');
    assert.equal(row[4].bg, '#c8d2dc');
  });
});

describe('vt100-core: DEC private modes, alt screen, OSC, charset, resize, scrollback', () => {
  it('handles ?25h/l, ?1h/l, ?2004h/l', () => {
    const term = createTerminalState();
    term.write('\x1b[?25l\x1b[?1h\x1b[?2004h');
    let snap = term.getSnapshot();
    assert.equal(snap.cursorVisible, false);
    assert.equal(snap.appCursorKeys, true);
    assert.equal(snap.bracketedPaste, true);

    term.write('\x1b[?25h\x1b[?1l\x1b[?2004l');
    snap = term.getSnapshot();
    assert.equal(snap.cursorVisible, true);
    assert.equal(snap.appCursorKeys, false);
    assert.equal(snap.bracketedPaste, false);
  });

  it('switches cleanly to and from alternate screen (?1049h/?1049l and ?47h/?47l)', () => {
    const term = createTerminalState({ cols: 15, rows: 3 });
    term.write('bash$ nano\r\n');
    term.write('\x1b[?1049h');
    let snap = term.getSnapshot();
    assert.equal(snap.isAltScreen, true);
    assert.equal(snap.cursorRow, 0);
    assert.equal(snap.cursorCol, 0);
    assert.equal(term.getPlainText(), '\n\n');

    term.write('GNU nano');
    assert.equal(term.getPlainText().split('\n')[0], 'GNU nano');

    term.write('\x1b[?1049l');
    snap = term.getSnapshot();
    assert.equal(snap.isAltScreen, false);
    assert.equal(snap.cursorRow, 1);
    assert.equal(snap.cursorCol, 0);
    assert.equal(term.getPlainText(), 'bash$ nano\n\n');

    // Also test ?47h / ?47l
    term.write('\x1b[?47hvi mode\x1b[?47l');
    assert.equal(term.getSnapshot().isAltScreen, false);
    assert.equal(term.getPlainText(), 'bash$ nano\n\n');
  });

  it('extracts OSC window titles without leaking escape bytes', () => {
    const term = createTerminalState({ cols: 20, rows: 2 });
    term.write('\x1b]0;user@pymi: ~/pyfml\x07$ ');
    assert.equal(term.getSnapshot().title, 'user@pymi: ~/pyfml');
    assert.equal(term.getPlainText(), '$\n');

    term.write('\x1b]2;python3\x1b\\ok');
    assert.equal(term.getSnapshot().title, 'python3');
    assert.equal(term.getPlainText(), '$ ok\n');

    // Split OSC ST (\x1b\\) across chunks
    term.write('\x1b]0;split-title\x1b');
    term.write('\\');
    assert.equal(term.getSnapshot().title, 'split-title');
  });

  it('handles resize while on alt screen and restores primary cleanly', () => {
    const term = createTerminalState({ cols: 10, rows: 4 });
    term.write('prompt$ ');
    term.write('\x1b[?1049h');
    term.resize(6, 2);
    term.write('\x1b[?1049l');
    const snap = term.getSnapshot();
    assert.equal(snap.isAltScreen, false);
    assert.equal(snap.cols, 6);
    assert.equal(snap.rows, 2);
    assert.equal(snap.lines.length, 2);
    assert.equal(snap.lines[0].length, 6);
    assert.equal(term.getPlainText(), 'prompt\n');
  });

  it('consumes charset designation ESC ( B without printing B', () => {
    const term = createTerminalState({ cols: 20, rows: 2 });
    term.write('\x1b(Bhello');
    assert.equal(term.getPlainText(), 'hello\n');
  });

  it('caps scrollback at maxScrollback', () => {
    const term = createTerminalState({ cols: 10, rows: 2, maxScrollback: 3 });
    for (let i = 1; i <= 7; i++) {
      term.write(`line${i}\r\n`);
    }
    const snap = term.getSnapshot();
    assert.equal(snap.scrollback.length, 3);
    const sbText = snap.scrollback.map((l) => l.map((c) => c.ch).join('').trim());
    assert.deepEqual(sbText, ['line4', 'line5', 'line6']);
  });

  it('resizes grid cleanly and clamps cursor', () => {
    const term = createTerminalState({ cols: 10, rows: 4 });
    term.write('\x1b[4;9HX');
    term.resize(5, 2);
    const snap = term.getSnapshot();
    assert.equal(snap.cols, 5);
    assert.equal(snap.rows, 2);
    assert.ok(snap.cursorRow <= 1);
    assert.ok(snap.cursorCol <= 4);
    assert.equal(snap.lines.length, 2);
    assert.equal(snap.lines[0].length, 5);
  });
});

describe('vt100-core: encodeKeyEvent & encodePaste', () => {
  it('encodes special keys and cursor modes', () => {
    assert.equal(encodeKeyEvent({ key: 'Enter' }), '\r');
    assert.equal(encodeKeyEvent({ key: 'Backspace' }), '\x7f');
    assert.equal(encodeKeyEvent({ key: 'Tab' }), '\t');
    assert.equal(encodeKeyEvent({ key: 'Tab', shiftKey: true }), '\x1b[Z');
    assert.equal(encodeKeyEvent({ key: 'Escape' }), '\x1b');
    assert.equal(encodeKeyEvent({ key: 'ArrowUp' }), '\x1b[A');
    assert.equal(encodeKeyEvent({ key: 'ArrowUp', ctrlKey: true }), '\x1b[1;5A');
    assert.equal(encodeKeyEvent({ key: 'ArrowUp' }, { appCursorKeys: true }), '\x1bOA');
    assert.equal(encodeKeyEvent({ key: 'ArrowDown' }, { appCursorKeys: true }), '\x1bOB');
    assert.equal(encodeKeyEvent({ key: 'ArrowRight' }, { appCursorKeys: true }), '\x1bOC');
    assert.equal(encodeKeyEvent({ key: 'ArrowLeft' }, { appCursorKeys: true }), '\x1bOD');
    assert.equal(encodeKeyEvent({ key: 'Home' }), '\x1b[H');
    assert.equal(encodeKeyEvent({ key: 'End' }), '\x1b[F');
    assert.equal(encodeKeyEvent({ key: 'Insert' }), '\x1b[2~');
    assert.equal(encodeKeyEvent({ key: 'Delete' }), '\x1b[3~');
    assert.equal(encodeKeyEvent({ key: 'PageUp' }), '\x1b[5~');
    assert.equal(encodeKeyEvent({ key: 'PageDown' }), '\x1b[6~');
    assert.equal(encodeKeyEvent({ key: 'F1' }), '\x1bOP');
    assert.equal(encodeKeyEvent({ key: 'F5' }), '\x1b[15~');
    assert.equal(encodeKeyEvent({ key: 'F12' }), '\x1b[24~');
  });

  it('encodes Ctrl, Alt, printable, and modifier-only keys', () => {
    assert.equal(encodeKeyEvent({ key: 'c', ctrlKey: true }), '\x03');
    assert.equal(encodeKeyEvent({ key: 'C', ctrlKey: true }), '\x03');
    assert.equal(encodeKeyEvent({ key: 'd', ctrlKey: true }), '\x04');
    assert.equal(encodeKeyEvent({ key: 'l', ctrlKey: true }), '\x0c');
    assert.equal(encodeKeyEvent({ key: 'z', ctrlKey: true }), '\x1a');
    assert.equal(encodeKeyEvent({ key: '[', ctrlKey: true }), '\x1b');
    assert.equal(encodeKeyEvent({ key: '\\', ctrlKey: true }), '\x1c');
    assert.equal(encodeKeyEvent({ key: ']', ctrlKey: true }), '\x1d');
    assert.equal(encodeKeyEvent({ key: 'b', altKey: true }), '\x1bb');
    assert.equal(encodeKeyEvent({ key: 'a' }), 'a');
    assert.equal(encodeKeyEvent({ key: 'ệ' }), 'ệ');
    assert.equal(encodeKeyEvent({ key: 'Shift', shiftKey: true }), null);
    assert.equal(encodeKeyEvent({ key: 'Control', ctrlKey: true }), null);
    assert.equal(encodeKeyEvent({ key: 'Alt', altKey: true }), null);
    assert.equal(encodeKeyEvent({ key: 'Meta', metaKey: true }), null);
    assert.equal(encodeKeyEvent({ key: 'c', metaKey: true }), null);
  });

  it('encodes paste text with newline normalization and optional bracketed paste', () => {
    assert.equal(encodePaste('line1\r\nline2\nline3', false), 'line1\rline2\rline3');
    assert.equal(
      encodePaste('a\r\nb', true),
      '\x1b[200~a\rb\x1b[201~'
    );
  });
});
