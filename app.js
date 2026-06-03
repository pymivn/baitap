// PyTUI State Management
const STATE = {
  files: {
    'main.py': `# Interactive Python TUI Demo\n# Press F5 or the Run button to execute.\n\nprint("=========================================")\nprint("Welcome to PyTUI browser-based IDE!")\nprint("=========================================")\n\nname = input("Enter your username: ")\nprint(f"Initializing profile for: {name}")\n\nfor i in range(1, 4):\n    print(f" -> Loading module {i}/3...")\n\nprint("Ready! Let's do some math.")\ntry:\n    val1 = int(input("Enter number A: "))\n    val2 = int(input("Enter number B: "))\n    print(f"Result: {val1} + {val2} = {val1 + val2}")\nexcept ValueError:\n    print("Error: Invalid number inputs.")\n\nprint("Goodbye!")\n`,
    'utils.py': `def greet(name):\n    return f"Hello, {name} from utils.py!"\n\ndef fibonacci(n):\n    if n <= 0:\n        return []\n    elif n == 1:\n        return [0]\n    sequence = [0, 1]\n    while len(sequence) < n:\n        sequence.append(sequence[-1] + sequence[-2])\n    return sequence\n`,
    'data.txt': `Welcome to the virtual filesystem.\nYou can read this file using standard python read commands:\n\nwith open('data.txt') as f:\n    print(f.read())\n`
  },
  activeFile: 'main.py',
  isRunning: false,
  isWaitingForInput: false,
  crtEffect: false
};

// UI Elements
const els = {
  status: document.getElementById('status-indicator'),
  fileList: document.getElementById('file-list'),
  activeFilename: document.getElementById('active-filename'),
  btnNewFile: document.getElementById('btn-new-file'),
  btnRun: document.getElementById('btn-run'),
  btnStop: document.getElementById('btn-stop'),
  btnClearTerminal: document.getElementById('btn-clear-terminal'),
  codeEditor: document.getElementById('code-editor'),
  lineNumbers: document.getElementById('editor-line-numbers'),
  terminalOutput: document.getElementById('terminal-output'),
  terminalInputRow: document.getElementById('terminal-input-row'),
  terminalInput: document.getElementById('terminal-input'),
  crtToggle: document.getElementById('crt-toggle'),
  loadingOverlay: document.getElementById('loading-overlay'),
  bootProgress: document.getElementById('boot-progress'),
  loadingDetails: document.getElementById('loading-details'),
  dialogNewFile: document.getElementById('dialog-new-file'),
  dialogError: document.getElementById('dialog-error'),
  newFilenameInput: document.getElementById('new-filename-input'),
  btnDialogCancel: document.getElementById('btn-dialog-cancel'),
  btnDialogCreate: document.getElementById('btn-dialog-create')
};

// Shared memory for synchronous inputs
let sharedBuffer;
let sharedStatus;
let pyodideWorker;

// Initialize Web Worker and Shared Memory
function initWorker() {
  let statusBuffer = null;

  if (typeof SharedArrayBuffer === 'undefined') {
    appendTerminalLine('System Warning: SharedArrayBuffer is not supported by your browser or local server configuration. Interactive input() will be unavailable.', 'stderr-line');
    els.loadingDetails.innerText = 'SharedArrayBuffer not supported. Set COOP/COEP headers.';
    sharedBuffer = null;
    sharedStatus = null;
  } else {
    // Create buffers
    // sharedBuffer: 4096 bytes for keyboard inputs
    // statusBuffer: 2 x 32-bit integers
    //   Index 0: Status flag (0 = waiting, 1 = ready)
    //   Index 1: Length of typed input
    sharedBuffer = new SharedArrayBuffer(4096);
    statusBuffer = new SharedArrayBuffer(8);
    sharedStatus = new Int32Array(statusBuffer);
    
    // Set initial status to 0
    Atomics.store(sharedStatus, 0, 0);
  }

  // Load web worker
  pyodideWorker = new Worker('pyodide.worker.js');

  // Launch initial handshake
  pyodideWorker.postMessage({
    type: 'init',
    buffer: sharedBuffer,
    statusBuffer: statusBuffer
  });

  // Handle messages back from worker
  pyodideWorker.onmessage = handleWorkerMessage;
}

// Track mock progress bar during loading
let progressInterval;
function startLoadingProgress() {
  let progress = 15;
  progressInterval = setInterval(() => {
    progress += Math.floor(Math.random() * 8) + 2;
    if (progress > 92) {
      clearInterval(progressInterval);
    } else {
      els.bootProgress.style.width = progress + '%';
      updateLoadingDetails(progress);
    }
  }, 350);
}

function updateLoadingDetails(prog) {
  if (prog < 40) {
    els.loadingDetails.innerText = 'Fetching WebAssembly artifacts...';
  } else if (prog < 70) {
    els.loadingDetails.innerText = 'Instantiating python WASM core...';
  } else {
    els.loadingDetails.innerText = 'Pre-loading standard packages...';
  }
}

// Handle responses from Pyodide worker
function handleWorkerMessage(e) {
  const { type, content } = e.data;

  switch (type) {
    case 'ready':
      clearInterval(progressInterval);
      els.bootProgress.style.width = '100%';
      els.loadingDetails.innerText = 'Pyodide Initialized!';
      setTimeout(() => {
        els.loadingOverlay.classList.add('hidden');
        els.status.innerText = 'READY';
        els.status.className = 'status-ready';
        els.btnRun.removeAttribute('disabled');
        clearTerminal();
        appendTerminalLine('PyTUI Shell loaded successfully.', 'system-line');
        appendTerminalLine('Write Python script in the Editor and click "Run (F5)" to execute.', 'system-line');
        appendTerminalLine('Type code directly at the terminal prompt below for instant evaluation.', 'system-line');
        showReplPrompt();
      }, 500);
      break;

    case 'stdout':
      appendTerminalLine(content, 'stdout-line');
      break;

    case 'stderr':
      appendTerminalLine(content, 'stderr-line');
      break;

    case 'error':
      clearInterval(progressInterval);
      els.loadingOverlay.classList.add('hidden');
      appendTerminalLine(content, 'stderr-line');
      setRunningState(false);
      break;

    case 'success':
      appendTerminalLine('\n[Process finished successfully]', 'system-line');
      setRunningState(false);
      break;

    case 'stdin_request':
      setWaitingForInputState(true);
      break;
      
    default:
      console.warn('Unhandled worker action:', type, content);
  }
}

// Sync Editor state to file list on left
function updateFileList() {
  els.fileList.innerHTML = '';
  Object.keys(STATE.files).forEach(filename => {
    const li = document.createElement('li');
    li.className = `file-item ${filename === STATE.activeFile ? 'active' : ''}`;
    li.role = 'treeitem';
    li.setAttribute('aria-selected', filename === STATE.activeFile);
    
    const label = document.createElement('span');
    label.className = 'file-label';
    label.textContent = ` ${filename}`;
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'file-delete-btn';
    deleteBtn.innerText = '×';
    deleteBtn.title = 'Delete File';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteFile(filename);
    };

    li.appendChild(label);
    if (filename !== 'main.py') {
      li.appendChild(deleteBtn);
    }
    
    li.onclick = () => selectFile(filename);
    els.fileList.appendChild(li);
  });
}

function selectFile(filename) {
  // Save current code
  STATE.files[STATE.activeFile] = els.codeEditor.value;
  
  STATE.activeFile = filename;
  els.activeFilename.innerText = filename;
  els.codeEditor.value = STATE.files[filename];
  updateLineNumbers();
  updateFileList();
}

function deleteFile(filename) {
  if (filename === 'main.py') return;
  
  if (confirm(`Are you sure you want to delete '${filename}'?`)) {
    delete STATE.files[filename];
    if (STATE.activeFile === filename) {
      selectFile('main.py');
    } else {
      updateFileList();
    }
  }
}

// Dialog file creator
els.btnNewFile.onclick = () => {
  els.newFilenameInput.value = '';
  els.dialogError.classList.add('hidden');
  els.dialogNewFile.classList.remove('hidden');
  els.newFilenameInput.focus();
};

els.btnDialogCancel.onclick = () => {
  els.dialogNewFile.classList.add('hidden');
};

els.btnDialogCreate.onclick = createNewFile;
els.newFilenameInput.onkeydown = (e) => {
  if (e.key === 'Enter') createNewFile();
  if (e.key === 'Escape') els.dialogNewFile.classList.add('hidden');
};

function createNewFile() {
  const filename = els.newFilenameInput.value.trim();
  
  if (!filename) {
    showDialogError('Filename cannot be empty.');
    return;
  }
  
  if (STATE.files[filename]) {
    showDialogError('A file with this name already exists.');
    return;
  }
  
  if (!/^[a-zA-Z0-9_\-\.]+\.py$/.test(filename) && !/^[a-zA-Z0-9_\-\.]+\.txt$/.test(filename)) {
    showDialogError('Filename must end with .py or .txt and contain no spaces.');
    return;
  }

  STATE.files[filename] = `# Content for ${filename}\n`;
  els.dialogNewFile.classList.add('hidden');
  selectFile(filename);
}

function showDialogError(msg) {
  els.dialogError.innerText = msg;
  els.dialogError.classList.remove('hidden');
}

// Line Numbers synchronization
function updateLineNumbers() {
  const lines = els.codeEditor.value.split('\n');
  const count = lines.length;
  let numbersHTML = '';
  for (let i = 1; i <= count; i++) {
    numbersHTML += `${i}<br>`;
  }
  els.lineNumbers.innerHTML = numbersHTML;
}

els.codeEditor.oninput = () => {
  STATE.files[STATE.activeFile] = els.codeEditor.value;
  updateLineNumbers();
};

// Scroll line numbers with editor
els.codeEditor.onscroll = () => {
  els.lineNumbers.scrollTop = els.codeEditor.scrollTop;
};

// Keyboard tab interception in Editor
els.codeEditor.onkeydown = (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = els.codeEditor.selectionStart;
    const end = els.codeEditor.selectionEnd;
    const value = els.codeEditor.value;
    els.codeEditor.value = value.substring(0, start) + "    " + value.substring(end);
    els.codeEditor.selectionStart = els.codeEditor.selectionEnd = start + 4;
    STATE.files[STATE.activeFile] = els.codeEditor.value;
    updateLineNumbers();
  }
};

// Terminal outputs manager
function appendTerminalLine(text, className = '') {
  const line = document.createElement('div');
  line.className = `terminal-line ${className}`;
  line.textContent = text;
  els.terminalOutput.appendChild(line);
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
}

function clearTerminal() {
  els.terminalOutput.innerHTML = '';
}

els.btnClearTerminal.onclick = clearTerminal;

// Execution state controllers
function setRunningState(running) {
  STATE.isRunning = running;
  if (running) {
    els.status.innerText = 'RUNNING';
    els.status.className = 'status-running';
    els.btnRun.setAttribute('disabled', 'true');
    els.btnStop.removeAttribute('disabled');
    hideReplPrompt();
  } else {
    els.status.innerText = 'READY';
    els.status.className = 'status-ready';
    els.btnRun.removeAttribute('disabled');
    els.btnStop.setAttribute('disabled', 'true');
    setWaitingForInputState(false);
    showReplPrompt();
  }
}

function setWaitingForInputState(waiting) {
  STATE.isWaitingForInput = waiting;
  if (waiting) {
    els.status.innerText = 'WAITING FOR INPUT';
    els.status.className = 'status-waiting';
    
    // Enable input prompt in terminal
    els.terminalInputRow.classList.remove('hidden');
    document.getElementById('terminal-prompt').innerText = '?';
    document.getElementById('terminal-prompt').style.color = 'var(--warning-color)';
    els.terminalInput.value = '';
    els.terminalInput.focus();
    els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
  } else {
    els.terminalInputRow.classList.add('hidden');
  }
}

function showReplPrompt() {
  if (STATE.isRunning) return;
  els.terminalInputRow.classList.remove('hidden');
  document.getElementById('terminal-prompt').innerText = '>>>';
  document.getElementById('terminal-prompt').style.color = 'var(--primary-color)';
  els.terminalInput.value = '';
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
}

function hideReplPrompt() {
  if (!STATE.isWaitingForInput) {
    els.terminalInputRow.classList.add('hidden');
  }
}

// Trigger Code Run
function runActiveScript() {
  if (STATE.isRunning) return;
  
  // Save current script state
  STATE.files[STATE.activeFile] = els.codeEditor.value;

  setRunningState(true);
  appendTerminalLine(`\n$ python ${STATE.activeFile}`, 'prompt-line');

  // Trigger web worker code run
  pyodideWorker.postMessage({
    type: 'run',
    data: {
      code: STATE.files[STATE.activeFile],
      activeFile: STATE.activeFile,
      files: STATE.files
    }
  });
}

els.btnRun.onclick = runActiveScript;

// Stop Execution (Restarts worker thread since Web Worker thread cannot be safely interrupted sync)
els.btnStop.onclick = () => {
  if (!STATE.isRunning) return;
  
  appendTerminalLine('\n[Execution interrupted by user]', 'stderr-line');
  
  // Terminate running worker
  pyodideWorker.terminate();
  
  // Reboot worker
  setRunningState(false);
  els.status.innerText = 'REBOOTING...';
  els.status.className = 'status-loading';
  els.btnRun.setAttribute('disabled', 'true');
  els.btnStop.setAttribute('disabled', 'true');
  
  initWorker();
};

// Terminal Keyboard Input Submit handler
els.terminalInput.onkeydown = (e) => {
  if (e.key === 'Enter') {
    const value = els.terminalInput.value;
    
    if (STATE.isWaitingForInput) {
      // 1. User is replying to custom Python input()
      appendTerminalLine(value, 'input-line');
      
      // Convert text to bytes
      const encoder = new TextEncoder();
      const inputBytes = encoder.encode(value + '\n'); // Include newline matching standard input() behavior
      
      // Write into SharedBuffer
      const maxBytes = Math.min(inputBytes.length, 4096);
      const view = new Uint8Array(sharedBuffer);
      for (let i = 0; i < maxBytes; i++) {
        view[i] = inputBytes[i];
      }
      
      // Set parameters and notify
      Atomics.store(sharedStatus, 1, maxBytes); // Index 1: length
      Atomics.store(sharedStatus, 0, 1);        // Index 0: state (1 = ready)
      Atomics.notify(sharedStatus, 0, 1);       // Wake up worker thread
      
      setWaitingForInputState(false);
    } 
    
    else {
      // 2. Interactive REPL Mode
      if (!value.trim()) return;
      
      appendTerminalLine('>>> ' + value, 'prompt-line');
      
      if (value.trim().toLowerCase() === 'clear') {
        clearTerminal();
        showReplPrompt();
        return;
      }
      
      // Run single statement in pyodide
      setRunningState(true);
      
      pyodideWorker.postMessage({
        type: 'run',
        data: {
          code: value,
          activeFile: 'repl',
          files: STATE.files
        }
      });
    }
  }
};

// Global Hotkeys
window.onkeydown = (e) => {
  // F5 -> Run Script
  if (e.key === 'F5') {
    e.preventDefault();
    runActiveScript();
  }
  
  // Ctrl + L -> Clear Terminal
  if (e.ctrlKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    clearTerminal();
    showReplPrompt();
  }
  
  // Ctrl + N -> New File
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    els.btnNewFile.click();
  }

  // Ctrl + D -> Delete active file
  if (e.ctrlKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    deleteFile(STATE.activeFile);
  }
};

// CRT effect toggle listener
els.crtToggle.onchange = (e) => {
  STATE.crtEffect = e.target.checked;
  if (STATE.crtEffect) {
    document.body.className = 'crt-on';
  } else {
    document.body.className = 'crt-off';
  }
};

// Bootstrap app on windows load
window.onload = () => {
  updateFileList();
  updateLineNumbers();
  startLoadingProgress();
  initWorker();
};
