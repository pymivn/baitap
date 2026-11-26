import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const UNKERNEL_NODE_MJS = resolve(REPO_ROOT, 'vendor/unkernel/node.mjs');
const DISTRO_EROFS = resolve(REPO_ROOT, 'distros/pymi-alpine.erofs');
const PYFML_JSON_PATH = resolve(REPO_ROOT, 'pyfml.json');

const STUDENT_BRANCH = 'pymi_2611HN_student_bai3';
const REMOTE_URL = 'https://thegit.pymi.vn/pyfml/pyfml.git';
const USER_HOME = '/home/user';
const WORK_REPO_DIR = '/home/user/pyfml';

const BOOTSTRAP_SCRIPT = String.raw`
set -eu
mkdir -p /srv/git
rm -rf /srv/git/pyfml.git /tmp/pyfml-seed-work
git init --bare --initial-branch=master /srv/git/pyfml.git >/dev/null

python3 - <<'PYEOF'
import json
import os
import pathlib

with open('/mnt/pyfml-seed/pyfml.json', 'r', encoding='utf-8') as fh:
    data = json.load(fh)

work_dir = pathlib.Path('/tmp/pyfml-seed-work')
for rel_path, content in data['files'].items():
    dest = work_dir / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding='utf-8')

hook_path = pathlib.Path('/srv/git/pyfml.git/hooks/post-receive')
hook_path.parent.mkdir(parents=True, exist_ok=True)
hook_path.write_text(data['postReceiveHook'], encoding='utf-8')
os.chmod(hook_path, 0o755)
PYEOF

cd /tmp/pyfml-seed-work
git init -b master >/dev/null
git config user.email "seed@pymi.vn"
git config user.name "PyMi Seed"
git add -A
git commit -m "Initial PyMi exercises" >/dev/null
git push /srv/git/pyfml.git master >/dev/null 2>&1
cd /
rm -rf /tmp/pyfml-seed-work

chown -R user:user /srv/git/pyfml.git
git config --system url."/srv/git/pyfml.git".insteadOf "https://thegit.pymi.vn/pyfml/pyfml.git"
`;

/**
 * Execute a command inside the unkernel guest with a generous timeout.
 */
async function execGuest(vm, file, args = [], opts = {}) {
  return vm.exec(file, args, {
    timeout: 60000,
    signal: AbortSignal.timeout(60000),
    ...opts,
  });
}

describe('E2E Linux VM: complete guide.rst student workflow', () => {
  let vm;

  before(async () => {
    const { createKernel, MemoryFs } = await import(
      pathToFileURL(UNKERNEL_NODE_MJS).href
    );
    const pyfmlRaw = readFileSync(PYFML_JSON_PATH);
    const seedFs = new MemoryFs({
      'pyfml.json': new Uint8Array(pyfmlRaw),
    });

    vm = await createKernel({
      distro: DISTRO_EROFS,
      mounts: {
        '/mnt/pyfml-seed': seedFs,
      },
    });

    const bootRes = await execGuest(vm, '/bin/sh', ['-c', BOOTSTRAP_SCRIPT], {
      user: 'root',
    });
    assert.equal(
      bootRes.exitCode,
      0,
      `Bootstrap failed:\nstdout: ${bootRes.stdout}\nstderr: ${bootRes.stderr}`,
    );
  });

  after(async () => {
    if (vm) {
      await vm.stop();
    }
  });

  it('1. verifies installed VM tooling (python3, python, git, bash, nano, whoami)', async () => {
    const checks = [
      { file: 'python3', args: ['--version'], expect: 'Python 3.' },
      { file: 'python', args: ['--version'], expect: 'Python 3.' },
      { file: 'git', args: ['--version'], expect: 'git version' },
      { file: 'bash', args: ['--version'], expect: 'GNU bash' },
      { file: 'nano', args: ['--version'], expect: 'GNU nano' },
      { file: 'whoami', args: [], expect: 'user' },
    ];

    for (const chk of checks) {
      const res = await execGuest(vm, chk.file, chk.args, { user: 'user' });
      const combined = `${res.stdout}${res.stderr}`.trim();
      assert.equal(
        res.exitCode,
        0,
        `${chk.file} exited ${res.exitCode}: ${combined}`,
      );
      assert.ok(
        combined.includes(chk.expect),
        `Expected "${chk.expect}" in ${chk.file} output, got: ${combined}`,
      );
    }
  });

  it('2. clones pyfml repo via https://thegit.pymi.vn/pyfml/pyfml.git insteadOf rewrite', async () => {
    const cloneRes = await execGuest(
      vm,
      'git',
      ['clone', REMOTE_URL, 'pyfml'],
      { user: 'user', cwd: USER_HOME },
    );
    assert.equal(
      cloneRes.exitCode,
      0,
      `git clone failed:\n${cloneRes.stdout}\n${cloneRes.stderr}`,
    );

    const lsRes = await execGuest(vm, 'ls', ['pyfml/'], {
      user: 'user',
      cwd: USER_HOME,
    });
    assert.equal(lsRes.exitCode, 0);
    const entries = lsRes.stdout.trim().split(/\s+/);
    for (const expected of ['exercises', 'tests', 'vendor', 'guide.rst', 'setup.py']) {
      assert.ok(
        entries.includes(expected),
        `Expected ${expected} in ls pyfml/, got: ${lsRes.stdout}`,
      );
    }
  });

  it('3. configures git identity, checks master branch, pulls origin, and creates feature branch', async () => {
    const emailRes = await execGuest(
      vm,
      'git',
      ['config', 'user.email', 'student@pymi.vn'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(emailRes.exitCode, 0, emailRes.stderr);

    const nameRes = await execGuest(
      vm,
      'git',
      ['config', 'user.name', 'PyMi Student'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(nameRes.exitCode, 0, nameRes.stderr);

    const branchRes = await execGuest(vm, 'git', ['branch'], {
      user: 'user',
      cwd: WORK_REPO_DIR,
    });
    assert.equal(branchRes.exitCode, 0, branchRes.stderr);
    assert.ok(
      branchRes.stdout.includes('* master'),
      `Expected "* master" in git branch output, got: ${branchRes.stdout}`,
    );

    const pullRes = await execGuest(vm, 'git', ['pull', 'origin', 'master'], {
      user: 'user',
      cwd: WORK_REPO_DIR,
    });
    assert.equal(
      pullRes.exitCode,
      0,
      `git pull failed:\n${pullRes.stdout}\n${pullRes.stderr}`,
    );

    const checkoutRes = await execGuest(
      vm,
      'git',
      ['checkout', '-b', STUDENT_BRANCH],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      checkoutRes.exitCode,
      0,
      `git checkout -b failed:\n${checkoutRes.stdout}\n${checkoutRes.stderr}`,
    );
  });

  it('4. runs unsolved exercises/ex3_0.py and observes NotImplementedError', async () => {
    const res = await execGuest(
      vm,
      'bash',
      ['-c', 'cd exercises && python3 ex3_0.py'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.notEqual(res.exitCode, 0, 'Unsolved ex3_0.py should exit non-zero');
    assert.ok(
      res.stderr.includes('NotImplementedError'),
      `Expected NotImplementedError in stderr, got: ${res.stderr}`,
    );
  });

  it('5. solves ex3_0.py, verifies python3 ex3_0.py, vendor/pep8.py (pass & catch E501), unittest, and setup.py test', async () => {
    const solveScript = String.raw`
with open('/home/user/pyfml/exercises/ex3_0.py', 'r', encoding='utf-8') as fh:
    src = fh.read()

old = """    # Xoá dòng raise và Viết code vào đây set các giá trị phù hợp
    raise NotImplementedError("Học viên chưa làm bài này")

    # Uncomment - xóa dấu # ở dòng sau để có kết quả đúng
    # result = input_data ** 2"""
new = "    result = input_data ** 2"
assert old in src, "Expected placeholder block in ex3_0.py"
solved = src.replace(old, new, 1)

with open('/home/user/pyfml/exercises/ex3_0.py', 'w', encoding='utf-8') as fh:
    fh.write(solved)
`;

    const editRes = await execGuest(vm, 'python3', ['-c', solveScript], {
      user: 'user',
      cwd: WORK_REPO_DIR,
    });
    assert.equal(editRes.exitCode, 0, editRes.stderr);

    const runSolved = await execGuest(
      vm,
      'bash',
      ['-c', 'cd exercises && python3 ex3_0.py'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(runSolved.exitCode, 0, runSolved.stderr);
    assert.equal(runSolved.stdout.trim(), '25');

    const pep8Pass = await execGuest(
      vm,
      'bash',
      ['-c', 'cd exercises && python3 ../vendor/pep8.py ex3_0.py'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      pep8Pass.exitCode,
      0,
      `pep8.py failed:\nstdout: ${pep8Pass.stdout}\nstderr: ${pep8Pass.stderr}`,
    );
    assert.equal(pep8Pass.stdout, '');
    assert.equal(pep8Pass.stderr, '');

    // Verify vendor/pep8.py catches a 90-char line violation (E501) on a temporary file
    const pep8FailCmd = [
      'python3 -c "open(\'/tmp/bad_pep8.py\', \'w\').write(\'x = \\"\' + \'a\' * 82 + \'\\"\\n\')"',
      'python3 vendor/pep8.py /tmp/bad_pep8.py',
    ].join(' && ');
    const pep8Fail = await execGuest(vm, 'bash', ['-c', pep8FailCmd], {
      user: 'user',
      cwd: WORK_REPO_DIR,
    });
    assert.equal(pep8Fail.exitCode, 1, 'pep8.py should exit 1 on E501');
    assert.ok(
      pep8Fail.stdout.includes('E501'),
      `Expected E501 in pep8.py output, got: ${pep8Fail.stdout}`,
    );
    await execGuest(vm, 'rm', ['-f', '/tmp/bad_pep8.py'], { user: 'user' });

    const unittestRes = await execGuest(
      vm,
      'bash',
      [
        '-c',
        'cd exercises && cd .. && python3 -m unittest tests.test_ex3.TestExercise3.test_ex3_0 -vvv',
      ],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      unittestRes.exitCode,
      0,
      `unittest failed:\n${unittestRes.stdout}\n${unittestRes.stderr}`,
    );
    const unittestOut = `${unittestRes.stdout}${unittestRes.stderr}`;
    assert.ok(unittestOut.includes('test_ex3_0'), unittestOut);
    assert.ok(unittestOut.includes('ok'), unittestOut);

    const setupTestRes = await execGuest(
      vm,
      'python3',
      ['setup.py', 'test', '--test-suite', 'tests.test_ex3.TestExercise3.test_ex3_0'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      setupTestRes.exitCode,
      0,
      `setup.py test failed:\n${setupTestRes.stdout}\n${setupTestRes.stderr}`,
    );
    const setupOut = `${setupTestRes.stdout}${setupTestRes.stderr}`;
    assert.ok(setupOut.includes('ok'), setupOut);
  });

  it('6. runs interactive python3 -m pdb exercises/ex3_0.py with n, l, exit', async () => {
    const pdbRes = await execGuest(
      vm,
      'python3',
      ['-m', 'pdb', 'exercises/ex3_0.py'],
      {
        user: 'user',
        cwd: WORK_REPO_DIR,
        input: 'n\nl\nexit\n',
      },
    );
    assert.equal(
      pdbRes.exitCode,
      0,
      `pdb exited ${pdbRes.exitCode}:\nstdout: ${pdbRes.stdout}\nstderr: ${pdbRes.stderr}`,
    );
    assert.ok(
      pdbRes.stdout.includes('(Pdb)'),
      `Expected (Pdb) prompt in stdout, got: ${pdbRes.stdout}`,
    );
    assert.ok(
      pdbRes.stdout.includes('def squared(input_data):'),
      `Expected source lines in pdb l output, got: ${pdbRes.stdout}`,
    );
  });

  it('7. stages, commits, and pushes branch to /srv/git/pyfml.git triggering MR URL + Local CI', async () => {
    const statusRes = await execGuest(vm, 'git', ['status'], {
      user: 'user',
      cwd: WORK_REPO_DIR,
    });
    assert.equal(statusRes.exitCode, 0, statusRes.stderr);
    assert.ok(
      statusRes.stdout.includes('exercises/ex3_0.py'),
      `Expected exercises/ex3_0.py in git status, got: ${statusRes.stdout}`,
    );

    const addRes = await execGuest(
      vm,
      'git',
      ['add', 'exercises/ex3_0.py'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(addRes.exitCode, 0, addRes.stderr);

    const commitRes = await execGuest(
      vm,
      'git',
      ['commit', '-sm', 'Solve ex3_0'],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      commitRes.exitCode,
      0,
      `git commit failed:\n${commitRes.stdout}\n${commitRes.stderr}`,
    );

    const pushRes = await execGuest(
      vm,
      'git',
      ['push', 'origin', STUDENT_BRANCH],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(
      pushRes.exitCode,
      0,
      `git push failed:\n${pushRes.stdout}\n${pushRes.stderr}`,
    );

    const pushOut = `${pushRes.stdout}\n${pushRes.stderr}`;
    const expectedMrUrl = `https://thegit.pymi.vn/pyfml/pyfml/merge_requests/new?merge_request%5Bsource_branch%5D=${STUDENT_BRANCH}`;
    assert.ok(
      pushOut.includes(expectedMrUrl),
      `Expected MR URL "${expectedMrUrl}" in push output:\n${pushOut}`,
    );
    assert.ok(
      pushOut.includes('[BaiTapPyMi Local CI]'),
      `Expected [BaiTapPyMi Local CI] in push output:\n${pushOut}`,
    );
    assert.ok(
      pushOut.includes('[BaiTapPyMi Local CI] PASSED'),
      `Expected [BaiTapPyMi Local CI] PASSED in push output:\n${pushOut}`,
    );
  });

  it('8. verifies real Linux filesystem operations (tempfile.mkstemp + os.unlink)', async () => {
    const res = await execGuest(
      vm,
      'python3',
      [
        '-c',
        "import tempfile, os; fd, p = tempfile.mkstemp(); os.close(fd); os.unlink(p); print('OK')",
      ],
      { user: 'user', cwd: WORK_REPO_DIR },
    );
    assert.equal(res.exitCode, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'OK');
  });
});
