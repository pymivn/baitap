import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkspacePath,
  buildFileTree,
  parseGitStatusPorcelain,
  mapExerciseToTestTarget,
  parseUnittestVerboseOutput,
} from '../../js/workspace-core.js';

describe('workspace-core: normalizeWorkspacePath', () => {
  it('accepts and normalizes valid relative paths', () => {
    assert.deepEqual(normalizeWorkspacePath('exercises/ex3_0.py'), {
      ok: true,
      path: 'exercises/ex3_0.py',
    });
    assert.deepEqual(normalizeWorkspacePath('guide.rst'), {
      ok: true,
      path: 'guide.rst',
    });
    assert.deepEqual(normalizeWorkspacePath('./exercises//ex3_0.py'), {
      ok: true,
      path: 'exercises/ex3_0.py',
    });
  });

  it('rejects traversal, absolute paths, backslashes, null/control chars, .git/, and empty paths', () => {
    const invalid = [
      '',
      '   ',
      '.',
      './',
      null,
      123,
      '/etc/passwd',
      '../secret.py',
      'exercises/../../etc/passwd',
      'exercises\\ex3_0.py',
      'exercises/ex3_0.py\0.txt',
      'exercises/ex3_0\n.py',
      '.git',
      '.git/config',
      '.git/hooks/post-receive',
    ];
    for (const bad of invalid) {
      const res = normalizeWorkspacePath(bad);
      assert.equal(res.ok, false, `Expected rejection for: ${String(bad)}`);
      assert.equal(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    }
  });
});

describe('workspace-core: buildFileTree', () => {
  it('builds nested tree with directories first and natural numeric sorting', () => {
    const tree = buildFileTree([
      'guide.rst',
      'exercises/ex3_10.py',
      'exercises/ex3_2.py',
      'exercises/ex3_0.py',
      'exercises/ex35_1.py',
      'tests/test_ex3.py',
      'exercises/ex3_2.py', // duplicate
      '../escape.py', // unsafe - should be ignored
      '.git/HEAD', // protected - should be ignored
    ]);

    assert.deepEqual(
      tree.map((n) => `${n.type}:${n.name}`),
      ['dir:exercises', 'dir:tests', 'file:guide.rst']
    );

    const exDir = tree[0];
    assert.equal(exDir.path, 'exercises');
    assert.deepEqual(
      exDir.children.map((n) => n.name),
      ['ex3_0.py', 'ex3_2.py', 'ex3_10.py', 'ex35_1.py']
    );
    assert.equal(exDir.children[0].path, 'exercises/ex3_0.py');
    assert.equal(exDir.children[0].type, 'file');
  });
});

describe('workspace-core: parseGitStatusPorcelain', () => {
  it('parses branch, ahead/behind, and file status codes', () => {
    const raw = [
      '## pymi_1704HN_hungnv_bai3...origin/pymi_1704HN_hungnv_bai3 [ahead 2, behind 1]',
      ' M exercises/ex3_0.py',
      'A  exercises/ex3_1.py',
      ' D exercises/old.py',
      'R  exercises/a.py -> exercises/b.py',
      '?? notes.txt',
    ].join('\n');

    assert.deepEqual(parseGitStatusPorcelain(raw), {
      branch: 'pymi_1704HN_hungnv_bai3',
      ahead: 2,
      behind: 1,
      files: {
        'exercises/ex3_0.py': 'M',
        'exercises/ex3_1.py': 'A',
        'exercises/old.py': 'D',
        'exercises/b.py': 'R',
        'notes.txt': '??',
      },
    });
  });

  it('handles initial commit, simple branch, and detached HEAD', () => {
    assert.deepEqual(parseGitStatusPorcelain('## No commits yet on master\n?? guide.rst\n'), {
      branch: 'master',
      ahead: 0,
      behind: 0,
      files: { 'guide.rst': '??' },
    });

    assert.deepEqual(parseGitStatusPorcelain('## main\n'), {
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: {},
    });

    assert.equal(parseGitStatusPorcelain('## HEAD (no branch)\n').branch, 'HEAD');
  });
});

describe('workspace-core: mapExerciseToTestTarget', () => {
  it('maps valid exercise paths to unittest targets', () => {
    assert.deepEqual(mapExerciseToTestTarget('exercises/ex3_0.py'), {
      module: 'tests.test_ex3',
      testClass: 'TestExercise3',
      testMethod: 'test_ex3_0',
      target: 'tests.test_ex3.TestExercise3.test_ex3_0',
    });

    assert.deepEqual(mapExerciseToTestTarget('exercises/ex35_1.py'), {
      module: 'tests.test_ex35',
      testClass: 'TestExercise35',
      testMethod: 'test_ex35_1',
      target: 'tests.test_ex35.TestExercise35.test_ex35_1',
    });

    assert.deepEqual(mapExerciseToTestTarget('./exercises/ex4_9.py'), {
      module: 'tests.test_ex4',
      testClass: 'TestExercise4',
      testMethod: 'test_ex4_9',
      target: 'tests.test_ex4.TestExercise4.test_ex4_9',
    });
  });

  it('returns null for non-exercise or unsafe paths', () => {
    assert.equal(mapExerciseToTestTarget('guide.rst'), null);
    assert.equal(mapExerciseToTestTarget('tests/test_ex3.py'), null);
    assert.equal(mapExerciseToTestTarget('exercises/README.md'), null);
    assert.equal(mapExerciseToTestTarget('../exercises/ex3_0.py'), null);
  });
});

describe('workspace-core: parseUnittestVerboseOutput', () => {
  it('parses passing verbose unittest output', () => {
    const out = [
      'test_ex3_0 (tests.test_ex3.TestExercise3.test_ex3_0) ... ok',
      'test_ex3_1 (tests.test_ex3.TestExercise3.test_ex3_1) ... ok',
      '',
      '----------------------------------------------------------------------',
      'Ran 2 tests in 0.002s',
      '',
      'OK',
    ].join('\n');

    assert.deepEqual(parseUnittestVerboseOutput(out), {
      status: 'PASS',
      passed: 2,
      failed: 0,
      errors: 0,
      skipped: 0,
      methods: [
        { method: 'test_ex3_0', status: 'PASS', message: '' },
        { method: 'test_ex3_1', status: 'PASS', message: '' },
      ],
    });
  });

  it('parses FAIL, ERROR, skipped, docstrings, and attaches tracebacks', () => {
    const out = [
      'test_ex4_1 (tests.test_ex4.TestExercise4)',
      'Verify exercise 4.1 ... ok',
      'test_ex4_2 (tests.test_ex4.TestExercise4) ... FAIL',
      "test_ex4_3 (tests.test_ex4.TestExercise4) ... skipped 'todo'",
      'test_ex4_9 (tests.test_ex4.TestExercise4) ... ERROR',
      '',
      '======================================================================',
      'FAIL: test_ex4_2 (tests.test_ex4.TestExercise4)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "tests/test_ex4.py", line 25, in test_ex4_2',
      '    self.assertEqual(ex4_2.solve(1), 2)',
      'AssertionError: 0 != 2',
      '',
      '======================================================================',
      'ERROR: test_ex4_9 (tests.test_ex4.TestExercise4)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "exercises/ex4_9.py", line 12, in solve',
      '    raise NotImplementedError("Học viên chưa làm bài này")',
      'NotImplementedError: Học viên chưa làm bài này',
      '',
      '----------------------------------------------------------------------',
      'Ran 4 tests in 0.004s',
      '',
      'FAILED (failures=1, errors=1, skipped=1)',
    ].join('\n');

    const res = parseUnittestVerboseOutput(out);
    assert.equal(res.status, 'ERROR');
    assert.equal(res.passed, 1);
    assert.equal(res.failed, 1);
    assert.equal(res.errors, 1);
    assert.equal(res.skipped, 1);
    assert.equal(res.methods.length, 4);
    assert.deepEqual(res.methods[0], { method: 'test_ex4_1', status: 'PASS', message: '' });
    assert.equal(res.methods[1].method, 'test_ex4_2');
    assert.equal(res.methods[1].status, 'FAIL');
    assert.match(res.methods[1].message, /AssertionError: 0 != 2/);
    assert.equal(res.methods[2].status, 'SKIP');
    assert.match(res.methods[2].message, /todo/);
    assert.equal(res.methods[3].method, 'test_ex4_9');
    assert.equal(res.methods[3].status, 'ERROR');
    assert.match(res.methods[3].message, /NotImplementedError: Học viên chưa làm bài này/);
  });

  it('returns FAIL when only failures occur (no errors)', () => {
    const out = [
      'test_ex3_0 (tests.test_ex3.TestExercise3.test_ex3_0) ... FAIL',
      '',
      '======================================================================',
      'FAIL: test_ex3_0 (tests.test_ex3.TestExercise3.test_ex3_0)',
      '----------------------------------------------------------------------',
      'AssertionError: False is not true',
      '',
      '----------------------------------------------------------------------',
      'Ran 1 test in 0.001s',
      '',
      'FAILED (failures=1)',
    ].join('\n');

    const res = parseUnittestVerboseOutput(out);
    assert.equal(res.status, 'FAIL');
    assert.equal(res.failed, 1);
    assert.equal(res.errors, 0);
  });
});
