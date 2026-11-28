import { checkSupport, createKernel, MemoryFs, resetDataDisk } from '../vendor/unkernel/web.mjs';
import {
  normalizeWorkspacePath,
  parseGitStatusPorcelain,
  parseUnittestVerboseOutput,
} from './workspace-core.js';

const WORKSPACE_DIR = '/home/user/pyfml';
const SEED_MOUNT_PATH = '/mnt/pyfml-seed';
const BARE_REPO_DIR = '/srv/git/pyfml.git';
const REMOTE_URL = 'https://thegit.pymi.vn/pyfml/pyfml.git';

const BOOTSTRAP_PY = String.raw`
import os
import pwd
import shutil
import subprocess
import tempfile

SEED_DIR = "/mnt/pyfml-seed"
BARE_DIR = "/srv/git/pyfml.git"
HOME_DIR = "/home/user"
WORK_DIR = "/home/user/pyfml"
REMOTE_URL = "https://thegit.pymi.vn/pyfml/pyfml.git"

pw = pwd.getpwnam("user")
uid, gid = pw.pw_uid, pw.pw_gid

def chown_tree(path):
    os.chown(path, uid, gid)
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in dirs:
            p = os.path.join(root, name)
            if not os.path.islink(p):
                os.chown(p, uid, gid)
        for name in files:
            p = os.path.join(root, name)
            if not os.path.islink(p):
                os.chown(p, uid, gid)

os.makedirs(HOME_DIR, exist_ok=True)
os.chown(HOME_DIR, uid, gid)

# Configure system git so guide.rst's remote URL transparently routes locally
subprocess.run(["git", "config", "--system", f"url.{BARE_DIR}.insteadOf", REMOTE_URL], check=True)
subprocess.run(["git", "config", "--system", "init.defaultBranch", "master"], check=True)
subprocess.run(["git", "config", "--system", "safe.directory", "*"], check=True)

if not os.path.exists(os.path.join(BARE_DIR, "HEAD")):
    os.makedirs(BARE_DIR, exist_ok=True)
    subprocess.run(["git", "init", "--bare", BARE_DIR], check=True)
    subprocess.run(["git", "-C", BARE_DIR, "symbolic-ref", "HEAD", "refs/heads/master"], check=True)

    with tempfile.TemporaryDirectory() as tmp:
        stage = os.path.join(tmp, "pyfml")
        os.makedirs(stage, exist_ok=True)
        for root, dirs, files in os.walk(SEED_DIR):
            rel_root = os.path.relpath(root, SEED_DIR)
            if rel_root == ".meta" or rel_root.startswith(".meta" + os.sep):
                continue
            dirs[:] = [d for d in dirs if not (rel_root == "." and d == ".meta")]
            dest_dir = stage if rel_root == "." else os.path.join(stage, rel_root)
            os.makedirs(dest_dir, exist_ok=True)
            for fname in files:
                shutil.copy2(os.path.join(root, fname), os.path.join(dest_dir, fname))

        subprocess.run(["git", "init"], cwd=stage, check=True)
        subprocess.run(["git", "checkout", "-B", "master"], cwd=stage, check=True)
        subprocess.run(["git", "config", "user.name", "PyMi Seed"], cwd=stage, check=True)
        subprocess.run(["git", "config", "user.email", "seed@pymi.vn"], cwd=stage, check=True)
        subprocess.run(["git", "add", "-A"], cwd=stage, check=True)
        subprocess.run(["git", "commit", "-m", "Initial pyfml workspace"], cwd=stage, check=True)
        subprocess.run(["git", "push", BARE_DIR, "master"], cwd=stage, check=True)

    hook_src = os.path.join(SEED_DIR, ".meta", "post-receive")
    if os.path.exists(hook_src):
        hooks_dir = os.path.join(BARE_DIR, "hooks")
        os.makedirs(hooks_dir, exist_ok=True)
        hook_dst = os.path.join(hooks_dir, "post-receive")
        shutil.copy2(hook_src, hook_dst)
        os.chmod(hook_dst, 0o755)

    chown_tree(BARE_DIR)

if not os.path.exists(os.path.join(WORK_DIR, ".git")):
    if os.path.exists(WORK_DIR):
        shutil.rmtree(WORK_DIR)
    subprocess.run(["git", "clone", BARE_DIR, WORK_DIR], check=True)
    subprocess.run(["git", "-C", WORK_DIR, "remote", "set-url", "origin", REMOTE_URL], check=True)
    chown_tree(WORK_DIR)

bash_profile_path = os.path.join(HOME_DIR, ".bash_profile")
if not os.path.exists(bash_profile_path):
    with open(bash_profile_path, "w", encoding="utf-8") as f:
        f.write("if [ -f ~/.bashrc ]; then . ~/.bashrc; fi\n")
    os.chown(bash_profile_path, uid, gid)

bashrc_path = os.path.join(HOME_DIR, ".bashrc")
if not os.path.exists(bashrc_path):
    with open(bashrc_path, "w", encoding="utf-8") as f:
        f.write(
            'export TERM=xterm-256color\n'
            'export PS1="\\[\\033[01;32m\\]user@pymi\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ "\n'
            "alias ll='ls -la'\n"
            'case $- in\n'
            '  *i*)\n'
            '    echo ""\n'
            '    echo "BaiTapPyMi (Python 3 + Git)"\n'
            '    echo "Type: cd pyfml   (repo ready at ~/pyfml; see guide.rst for instructions)"\n'
            '    echo ""\n'
            '    ;;\n'
            'esac\n'
        )
    os.chown(bashrc_path, uid, gid)
`;

const LIST_FILES_PY = String.raw`
import json
import os

base = os.path.realpath("/home/user/pyfml")
out = []
if os.path.isdir(base):
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in (".git", "__pycache__"))
        for fname in sorted(files):
            if fname.endswith(".pyc"):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            out.append(rel)
print(json.dumps(sorted(out)))
`;

const READ_FILE_PY = String.raw`
import os
import sys

base = os.path.realpath("/home/user/pyfml")
rel = sys.argv[1]
target = os.path.realpath(os.path.join(base, rel))
if not (target.startswith(base + os.sep)):
    raise SystemExit("Invalid path")
with open(target, "r", encoding="utf-8", errors="replace") as f:
    sys.stdout.write(f.read())
`;

const WRITE_FILE_PY = String.raw`
import os
import sys

base = os.path.realpath("/home/user/pyfml")
rel = sys.argv[1]
target = os.path.realpath(os.path.join(base, rel))
if not (target.startswith(base + os.sep)):
    raise SystemExit("Invalid path")
parent = os.path.dirname(target)
os.makedirs(parent, exist_ok=True)
data = sys.stdin.buffer.read()
with open(target, "wb") as f:
    f.write(data)
`;

const DELETE_FILE_PY = String.raw`
import os
import sys

base = os.path.realpath("/home/user/pyfml")
rel = sys.argv[1]
target = os.path.realpath(os.path.join(base, rel))
if not (target.startswith(base + os.sep)):
    raise SystemExit("Invalid path")
if os.path.isfile(target) or os.path.islink(target):
    os.unlink(target)
`;

const textEncoder = new TextEncoder();

/**
 * Check whether the current browser supports WebAssembly JSPI and Unkernel requirements.
 */
export async function checkVmSupport() {
  try {
    const res = await checkSupport();
    return {
      ok: Boolean(res?.ok),
      problems: Array.isArray(res?.problems) ? res.problems : [],
    };
  } catch (err) {
    return {
      ok: false,
      problems: [err?.message ?? String(err)],
    };
  }
}

function populateSeedFs(pyfmlData) {
  const fs = new MemoryFs();
  const files = pyfmlData?.files ?? {};
  for (const [relPath, content] of Object.entries(files)) {
    const norm = normalizeWorkspacePath(relPath);
    if (!norm.ok) continue;
    fs.writeFile(`/${norm.path}`, String(content ?? ''));
  }
  if (typeof pyfmlData?.postReceiveHook === 'string') {
    fs.writeFile('/.meta/post-receive', pyfmlData.postReceiveHook);
  }
  return fs;
}

function validateNormalizedPath(rawPath) {
  const norm = normalizeWorkspacePath(rawPath);
  if (!norm.ok) {
    throw new Error(norm.error || 'Invalid workspace path');
  }
  return norm.path;
}

/**
 * Boot and manage the Unkernel Linux VM, bash PTY, and workspace bridge.
 */
export async function createVmShell({
  distroUrl = './distros/pymi-alpine.erofs',
  pyfmlUrl = './pyfml.json',
  cols = 80,
  rows = 24,
  onProgress,
  onStatus,
  onConsoleLog,
} = {}) {
  const emitStatus = (status, detail = '') => {
    onStatus?.(status, detail);
  };

  emitStatus('loading', 'Fetching pyfml repository bundle...');
  const pyfmlRes = await fetch(pyfmlUrl, { cache: 'no-cache' });
  if (!pyfmlRes.ok) {
    throw new Error(`Failed to load ${pyfmlUrl}: HTTP ${pyfmlRes.status}`);
  }
  const pyfmlData = await pyfmlRes.json();
  const seedFs = populateSeedFs(pyfmlData);

  const absDistroUrl = new URL(distroUrl, window.location.href).href;
  const consoleDecoder = new TextDecoder('utf-8', { fatal: false });

  emitStatus('loading', 'Booting Linux kernel in WebAssembly...');
  const kernel = await createKernel({
    worker: true,
    distro: absDistroUrl,
    disks: [{ kind: 'data', template: 'bundled' }],
    mounts: {
      [SEED_MOUNT_PATH]: { fs: seedFs, readOnly: true },
    },
    consoleSize: { cols, rows },
    onProgress: (p) => {
      onProgress?.(p);
    },
    onOutput: (bytes) => {
      if (onConsoleLog && bytes && bytes.length) {
        onConsoleLog(consoleDecoder.decode(bytes, { stream: true }));
      }
    },
    onDiskError: (_idx, err) => {
      onConsoleLog?.(`[disk error] ${err?.message ?? String(err)}\n`);
    },
    log: (msg) => {
      onConsoleLog?.(`${msg}\n`);
    },
  });

  emitStatus('loading', 'Initializing git repository & workspace...');
  const bootRes = await kernel.exec('/usr/bin/python3', ['-c', BOOTSTRAP_PY], {
    user: 'root',
    timeout: 120000,
  });
  if (bootRes.exitCode !== 0) {
    throw new Error(
      `Workspace bootstrap failed (exit ${bootRes.exitCode}): ${bootRes.stderr || bootRes.stdout}`,
    );
  }

  emitStatus('loading', 'Starting interactive bash session...');
  const ptySession = await kernel.spawn('/bin/bash', ['-l'], {
    cols,
    rows,
    user: 'user',
    cwd: '/home/user',
    env: {
      TERM: 'xterm-256color',
      HOME: '/home/user',
      USER: 'user',
    },
  });

  let ptyOutputHandler = null;
  const pendingPtyChunks = [];
  let closed = false;

  // Pump PTY output asynchronously; buffer early bytes until a view attaches
  (async () => {
    const reader = ptySession.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ptyOutputHandler) {
          ptyOutputHandler(value);
        } else {
          pendingPtyChunks.push(value);
        }
      }
    } catch (err) {
      onConsoleLog?.(`[pty] stream ended: ${err?.message ?? String(err)}\n`);
    }
  })();

  async function execChecked(program, args, opts = {}) {
    const { allowNonZero = false, ...execOpts } = opts;
    const res = await kernel.exec(program, args, execOpts);
    if (!allowNonZero && res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || '').trim();
      throw new Error(detail || `${program} exited with code ${res.exitCode}`);
    }
    return res;
  }

  emitStatus('ready', 'Linux VM ready');

  return {
    get kernel() {
      return kernel;
    },

    get guideFallbackText() {
      return typeof pyfmlData?.files?.['guide.rst'] === 'string'
        ? pyfmlData.files['guide.rst']
        : '';
    },

    attachTerminal(onOutput) {
      ptyOutputHandler = onOutput;
      while (pendingPtyChunks.length > 0) {
        const chunk = pendingPtyChunks.shift();
        ptyOutputHandler?.(chunk);
      }
    },

    writePty(data) {
      if (closed || !data) return Promise.resolve();
      return ptySession.write(data).catch(() => {});
    },

    resizePty(nextCols, nextRows) {
      if (closed) return;
      if (nextCols > 0 && nextRows > 0) {
        ptySession.resize(nextCols, nextRows);
      }
    },

    sendCommandToTerminal(cmd) {
      if (closed || typeof cmd !== 'string') return Promise.resolve();
      return ptySession.write(`${cmd}\n`).catch(() => {});
    },

    async listWorkspaceFiles() {
      const res = await execChecked('/usr/bin/python3', ['-c', LIST_FILES_PY], {
        user: 'user',
        cwd: WORKSPACE_DIR,
        timeout: 30000,
      });
      const parsed = JSON.parse(res.stdout || '[]');
      if (!Array.isArray(parsed)) return [];
      const clean = [];
      for (const item of parsed) {
        const norm = normalizeWorkspacePath(item);
        if (norm.ok) clean.push(norm.path);
      }
      return clean;
    },

    async readWorkspaceFile(relPath) {
      const safePath = validateNormalizedPath(relPath);
      const res = await execChecked('/usr/bin/python3', ['-c', READ_FILE_PY, safePath], {
        user: 'user',
        cwd: WORKSPACE_DIR,
        timeout: 30000,
      });
      return res.stdout ?? '';
    },

    async writeWorkspaceFile(relPath, content) {
      const safePath = validateNormalizedPath(relPath);
      const bytes = textEncoder.encode(String(content ?? ''));
      await execChecked('/usr/bin/python3', ['-c', WRITE_FILE_PY, safePath], {
        input: bytes,
        user: 'user',
        cwd: WORKSPACE_DIR,
        timeout: 30000,
      });
    },

    async deleteWorkspaceFile(relPath) {
      const safePath = validateNormalizedPath(relPath);
      await execChecked('/usr/bin/python3', ['-c', DELETE_FILE_PY, safePath], {
        user: 'user',
        cwd: WORKSPACE_DIR,
        timeout: 30000,
      });
    },

    async getGitStatus() {
      const res = await execChecked(
        '/usr/bin/git',
        ['-C', WORKSPACE_DIR, 'status', '--porcelain=v1', '-b'],
        { user: 'user', allowNonZero: true, timeout: 30000 },
      );
      if (res.exitCode !== 0) {
        return { branch: '', ahead: 0, behind: 0, files: {} };
      }
      return parseGitStatusPorcelain(res.stdout ?? '');
    },

    async runUnittest(target) {
      if (typeof target !== 'string' || !/^[a-zA-Z0-9_.]+$/.test(target)) {
        throw new Error(`Invalid unittest target: ${String(target)}`);
      }
      const res = await execChecked(
        '/usr/bin/python3',
        ['-m', 'unittest', target, '-vvv'],
        { user: 'user', cwd: WORKSPACE_DIR, allowNonZero: true, timeout: 60000 },
      );
      const stdout = res.stdout ?? '';
      const stderr = res.stderr ?? '';
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      const parsed = parseUnittestVerboseOutput(stderr || stdout);
      return {
        exitCode: res.exitCode ?? 1,
        output: combined,
        parsed,
      };
    },

    async runPep8(relPath) {
      const safePath = validateNormalizedPath(relPath);
      const res = await execChecked(
        '/usr/bin/python3',
        ['vendor/pep8.py', safePath],
        { user: 'user', cwd: WORKSPACE_DIR, allowNonZero: true, timeout: 30000 },
      );
      const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
      return {
        exitCode: res.exitCode ?? 1,
        output,
      };
    },

    async syncDisk() {
      if (typeof kernel.sync === 'function') {
        await kernel.sync();
      }
    },

    async resetVm() {
      closed = true;
      try {
        await ptySession.close();
      } catch {}
      try {
        await kernel.stop();
      } catch {}
      await resetDataDisk();
      window.location.reload();
    },

    async stop() {
      closed = true;
      try {
        await ptySession.close();
      } catch {}
      try {
        await kernel.stop();
      } catch {}
    },
  };
}
