// Web Worker for Pyodide execution
importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.js");

let pyodide = null;
let sharedBuffer = null;
let sharedStatus = null;

// Synchronous Stdin callback that blocks the worker thread
function synchronousStdin() {
  if (!sharedBuffer || !sharedStatus) {
    return ""; // Fallback if buffers aren't initialized
  }

  // Send request for input to the UI thread
  postMessage({ type: 'stdin_request' });

  // Block the worker thread until sharedStatus[0] is not 0
  // Atomics.wait(Int32Array, index, expectedValueValue)
  // This blocks the thread as long as sharedStatus[0] === 0
  Atomics.wait(sharedStatus, 0, 0);

  // Read string length from sharedStatus[1]
  const byteLength = Atomics.load(sharedStatus, 1);
  
  // Extract bytes and decode to UTF-8 string
  const decoder = new TextDecoder("utf-8");
  const inputBytes = sharedBuffer.slice(0, byteLength);
  const result = decoder.decode(inputBytes);

  // Reset status flag back to 0 (waiting)
  Atomics.store(sharedStatus, 0, 0);

  return result;
}

self.onmessage = async function(e) {
  const { type, data } = e.data;

  if (type === 'init') {
    if (e.data.buffer && e.data.statusBuffer) {
      sharedBuffer = new Uint8Array(e.data.buffer);
      sharedStatus = new Int32Array(e.data.statusBuffer);
    } else {
      sharedBuffer = null;
      sharedStatus = null;
    }

    try {
      pyodide = await loadPyodide({
        stdout: (text) => {
          postMessage({ type: 'stdout', content: text });
        },
        stderr: (text) => {
          postMessage({ type: 'stderr', content: text });
        },
        stdin: synchronousStdin
      });

      // Load micropip for package management if needed
      await pyodide.loadPackage("micropip");

      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', content: 'Failed to boot Pyodide: ' + err.message });
    }
  } 
  
  else if (type === 'run') {
    if (!pyodide) {
      postMessage({ type: 'error', content: 'Pyodide engine is not initialized.' });
      return;
    }

    const { code, activeFile, files, isTest, testSuite } = data;

    // 1. Clean up deleted files from Pyodide VFS
    try {
      const cwd = pyodide.FS.cwd();
      const fsItems = pyodide.FS.readdir(cwd);
      for (const item of fsItems) {
        if (item === '.' || item === '..') continue;
        if (item.endsWith('.py') || item.endsWith('.txt')) {
          if (!files.hasOwnProperty(item)) {
            try {
              pyodide.FS.unlink(cwd + '/' + item);
            } catch (err) {
              console.warn('Failed to delete file from Pyodide FS:', item, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn('VFS cleanup error:', err.message);
    }

    // 2. Synchronize the virtual filesystem in Pyodide
    try {
      for (const [filename, content] of Object.entries(files)) {
        // Sanitize path inputs to prevent virtual container path traversal
        if (filename.includes('..') || filename.startsWith('/')) {
          console.warn("Skipping unsafe virtual filename path traversal attempt:", filename);
          continue;
        }

        const parts = filename.split('/');
        let currentPath = '';
        
        // Handle subdirectory creation
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath += (currentPath ? '/' : '') + parts[i];
          try {
            pyodide.FS.mkdir(currentPath);
          } catch (err) {
            // Directory might already exist, which is fine
          }
        }
        
        pyodide.FS.writeFile(filename, content, { encoding: 'utf8' });
      }
    } catch (err) {
      postMessage({ type: 'error', content: 'Virtual FS Sync Error: ' + err.message });
      return;
    }

    // 3. Execute Pyodide run
    try {
      const isRepl = activeFile === 'repl';
      
      if (isTest && testSuite) {
        // Run student code first
        await pyodide.runPythonAsync(code, { filename: activeFile || 'main.py' });
        
        // Run test suite assertions
        try {
          await pyodide.runPythonAsync(testSuite, { filename: 'test_suite.py' });
          postMessage({ type: 'test_result', status: 'PASS', message: 'All test cases passed successfully!' });
        } catch (testErr) {
          postMessage({ type: 'test_result', status: 'FAIL', message: testErr.message });
        }
      } else {
        const result = await pyodide.runPythonAsync(code, { filename: activeFile || 'main.py' });
        if (isRepl && result !== undefined) {
          postMessage({ type: 'stdout', content: String(result) });
        }
        postMessage({ type: 'success' });
      }
    } catch (err) {
      if (isTest && testSuite) {
        postMessage({ type: 'test_result', status: 'ERROR', message: 'Syntax/Runtime Error in solution file:\n' + err.message });
      } else {
        postMessage({ type: 'error', content: err.message });
      }
    }
  }
};
