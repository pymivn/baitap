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

    const { code, activeFile, files, isTest, testSuite, testMethod } = data;

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
        // Build a custom unittest runner that collects per-method results as JSON
        const methodFilter = testMethod ? `"${testMethod.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'None';
        
        const runnerCode = `
import unittest
import json
import sys
import io

# Invalidate cached exercise modules so Python re-imports from the updated VFS.
for _cached_mod in list(sys.modules.keys()):
    if _cached_mod.startswith('ex') and len(_cached_mod) > 2 and _cached_mod[2:3].isdigit():
        del sys.modules[_cached_mod]

# Monkey-patch assertion methods to auto-wrap each in a subTest,
# so every assertion reports as a separate test case in the results.
_case_counter = [0]
_in_subtest = [False]

def _wrap_assert(orig):
    def _wrapper(self, *args, **kwargs):
        if _in_subtest[0] or getattr(self, '_subtest', None) is not None:
            return orig(self, *args, **kwargs)
        _case_counter[0] += 1
        _in_subtest[0] = True
        try:
            with self.subTest(case=_case_counter[0]):
                return orig(self, *args, **kwargs)
        finally:
            _in_subtest[0] = False
    return _wrapper

for _m in ['assertEqual', 'assertNotEqual', 'assertTrue', 'assertFalse',
           'assertIn', 'assertNotIn', 'assertIs', 'assertIsNot',
           'assertIsNone', 'assertIsNotNone', 'assertIsInstance',
           'assertGreater', 'assertGreaterEqual', 'assertLess', 'assertLessEqual',
           'assertAlmostEqual', 'assertNotAlmostEqual', 'assertRegex',
           'assertRaises', 'assertRaisesRegex']:
    if hasattr(unittest.TestCase, _m):
        setattr(unittest.TestCase, _m, _wrap_assert(getattr(unittest.TestCase, _m)))

# Capture stdout/stderr during test execution
_old_stdout = sys.stdout
_old_stderr = sys.stderr
_test_stdout = io.StringIO()
_test_stderr = io.StringIO()
sys.stdout = _test_stdout
sys.stderr = _test_stderr

${testSuite}

# Discover and run tests with optional method filter
loader = unittest.TestLoader()
suite = unittest.TestSuite()
_test_method_filter = ${methodFilter}

for _name, _obj in list(globals().items()):
    if isinstance(_obj, type) and issubclass(_obj, unittest.TestCase) and _obj is not unittest.TestCase and _name != 'TestExercise':
        if _test_method_filter:
            try:
                suite.addTest(_obj(_test_method_filter))
            except ValueError:
                pass
        else:
            suite.addTests(loader.loadTestsFromTestCase(_obj))

class _JSONResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.results = []
        self._sub_count = 0
    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        self._sub_count += 1
        if err is None:
            self.results.append({"method": str(subtest), "status": "PASS", "message": ""})
        else:
            self.results.append({"method": str(subtest), "status": "FAIL", "message": str(err[1])})
    def addSuccess(self, test):
        super().addSuccess(test)
        if self._sub_count == 0:
            self.results.append({"method": str(test), "status": "PASS", "message": ""})
        self._sub_count = 0
    def addFailure(self, test, err):
        super().addFailure(test, err)
        if self._sub_count == 0:
            self.results.append({"method": str(test), "status": "FAIL", "message": str(err[1])})
        self._sub_count = 0
    def addError(self, test, err):
        super().addError(test, err)
        self.results.append({"method": str(test), "status": "ERROR", "message": str(err[1])})
        self._sub_count = 0
    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.results.append({"method": str(test), "status": "SKIP", "message": reason})
        self._sub_count = 0

_result = _JSONResult()
suite.run(_result)

sys.stdout = _old_stdout
sys.stderr = _old_stderr

json.dumps({"total": _result.testsRun, "results": _result.results, "wasSuccessful": _result.wasSuccessful()})
`;

        try {
          const jsonStr = await pyodide.runPythonAsync(runnerCode, { filename: 'test_runner.py' });
          const parsed = JSON.parse(jsonStr);
          postMessage({
            type: 'test_result',
            status: parsed.wasSuccessful ? 'PASS' : 'FAIL',
            message: JSON.stringify(parsed.results)
          });
        } catch (err) {
          postMessage({ type: 'test_result', status: 'ERROR', message: err.message });
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
