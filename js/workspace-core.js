/**
 * Pure workspace path validation, file tree, git status, and unittest output utilities.
 * Zero DOM, window, document, or I/O dependencies.
 */

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const NATURAL_CHUNK_RE = /(\d+|\D+)/g;

function naturalCompare(a, b) {
  const partsA = a.match(NATURAL_CHUNK_RE) ?? [a];
  const partsB = b.match(NATURAL_CHUNK_RE) ?? [b];
  const len = Math.min(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    const isNumA = /^\d+$/.test(pa);
    const isNumB = /^\d+$/.test(pb);

    if (isNumA && isNumB) {
      const diff = Number(pa) - Number(pb);
      if (diff !== 0) return diff;
      if (pa.length !== pb.length) return pa.length - pb.length;
      continue;
    }

    const lowerA = pa.toLowerCase();
    const lowerB = pb.toLowerCase();
    if (lowerA < lowerB) return -1;
    if (lowerA > lowerB) return 1;
    if (pa < pb) return -1;
    if (pa > pb) return 1;
  }

  return partsA.length - partsB.length;
}

export function normalizeWorkspacePath(rawPath) {
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'Path must be a string' };
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Path cannot be empty' };
  }
  if (CONTROL_CHARS_RE.test(rawPath)) {
    return { ok: false, error: 'Path contains invalid control characters' };
  }
  if (rawPath.includes('\\')) {
    return { ok: false, error: 'Backslashes are not allowed in workspace paths' };
  }
  if (trimmed.startsWith('/')) {
    return { ok: false, error: 'Absolute paths are not allowed' };
  }

  const rawSegments = trimmed.split('/');
  const cleanSegments = [];
  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      return { ok: false, error: 'Path traversal (..) is not allowed' };
    }
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) {
    return { ok: false, error: 'Path cannot be empty' };
  }
  if (cleanSegments[0] === '.git') {
    return { ok: false, error: 'Direct access to .git/ is not allowed' };
  }

  return { ok: true, path: cleanSegments.join('/') };
}

function sortTreeNodes(nodes) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1;
    }
    return naturalCompare(a.name, b.name);
  });
  for (const node of nodes) {
    if (node.type === 'dir') {
      sortTreeNodes(node.children);
    }
  }
  return nodes;
}

export function buildFileTree(paths) {
  if (!Array.isArray(paths)) return [];

  const rootChildren = [];
  const dirMap = new Map();
  const seenFiles = new Set();

  for (const rawPath of paths) {
    const norm = normalizeWorkspacePath(rawPath);
    if (!norm.ok) continue;
    if (seenFiles.has(norm.path)) continue;
    seenFiles.add(norm.path);

    const segments = norm.path.split('/');
    let currentList = rootChildren;
    let currentPrefix = '';

    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      currentPrefix = currentPrefix ? `${currentPrefix}/${name}` : name;
      const isFile = i === segments.length - 1;

      if (isFile) {
        currentList.push({
          name,
          path: currentPrefix,
          type: 'file',
        });
      } else {
        let dirNode = dirMap.get(currentPrefix);
        if (!dirNode) {
          dirNode = {
            name,
            path: currentPrefix,
            type: 'dir',
            children: [],
          };
          dirMap.set(currentPrefix, dirNode);
          currentList.push(dirNode);
        }
        currentList = dirNode.children;
      }
    }
  }

  return sortTreeNodes(rootChildren);
}

function parseBranchHeader(header) {
  let branch = '';
  let ahead = 0;
  let behind = 0;

  const rest = header.slice(3).trim();
  if (rest.startsWith('No commits yet on ')) {
    branch = rest.slice('No commits yet on '.length).trim();
  } else if (rest.startsWith('Initial commit on ')) {
    branch = rest.slice('Initial commit on '.length).trim();
  } else if (rest.startsWith('HEAD (')) {
    branch = 'HEAD';
  } else {
    const bracketMatch = rest.match(/\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
      const info = bracketMatch[1];
      const aheadMatch = info.match(/ahead\s+(\d+)/);
      const behindMatch = info.match(/behind\s+(\d+)/);
      if (aheadMatch) ahead = Number.parseInt(aheadMatch[1], 10);
      if (behindMatch) behind = Number.parseInt(behindMatch[1], 10);
    }
    const branchPart = rest.replace(/\s*\[[^\]]+\]\s*$/, '');
    const dotsIdx = branchPart.indexOf('...');
    branch = dotsIdx !== -1 ? branchPart.slice(0, dotsIdx) : branchPart;
  }

  return { branch, ahead, behind };
}

function unquoteGitPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

export function parseGitStatusPorcelain(output) {
  const result = {
    branch: '',
    ahead: 0,
    behind: 0,
    files: {},
  };
  if (typeof output !== 'string' || !output.trim()) {
    return result;
  }

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const parsed = parseBranchHeader(line);
      result.branch = parsed.branch;
      result.ahead = parsed.ahead;
      result.behind = parsed.behind;
      continue;
    }

    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let filePath = line.slice(3);
    const arrowIdx = filePath.indexOf(' -> ');
    if (arrowIdx !== -1) {
      filePath = filePath.slice(arrowIdx + 4);
    }
    filePath = unquoteGitPath(filePath);
    const norm = normalizeWorkspacePath(filePath);
    if (!norm.ok) continue;

    const code = xy === '??' ? '??' : xy.trim() || '?';
    result.files[norm.path] = code;
  }

  return result;
}

const EXERCISE_PATH_RE = /^exercises\/ex(\d+)_(\d+)\.py$/;

export function mapExerciseToTestTarget(relPath) {
  const norm = normalizeWorkspacePath(relPath);
  if (!norm.ok) return null;

  const match = norm.path.match(EXERCISE_PATH_RE);
  if (!match) return null;

  const lesson = match[1];
  const exerciseNum = match[2];
  const module = `tests.test_ex${lesson}`;
  const testClass = `TestExercise${lesson}`;
  const testMethod = `test_ex${lesson}_${exerciseNum}`;

  return {
    module,
    testClass,
    testMethod,
    target: `${module}.${testClass}.${testMethod}`,
  };
}

const TEST_LINE_RE = /^(test_[A-Za-z0-9_]+)\s+\([^)]+\)\s+\.\.\.\s+(ok|FAIL|ERROR|skipped(?:\s+.*)?|expected failure|unexpected success)\s*$/;
const DOCSTRING_HEADER_RE = /^(test_[A-Za-z0-9_]+)\s+\([^)]+\)\s*$/;
const DOCSTRING_STATUS_RE = /^.*\.\.\.\s+(ok|FAIL|ERROR|skipped(?:\s+.*)?|expected failure|unexpected success)\s*$/;
const DETAIL_HEADER_RE = /^(FAIL|ERROR):\s+([A-Za-z0-9_.]+)\s+\([^)]+\)\s*$/;
const SEPARATOR_EQ_RE = /^={20,}$/;
const SEPARATOR_DASH_RE = /^-{20,}$/;
const RAN_RE = /^Ran\s+\d+\s+tests?\s+in\s+/;

function mapStatusToken(rawStatus) {
  if (rawStatus === 'ok' || rawStatus === 'expected failure') return 'PASS';
  if (rawStatus === 'FAIL' || rawStatus === 'unexpected success') return 'FAIL';
  if (rawStatus === 'ERROR') return 'ERROR';
  if (rawStatus.startsWith('skipped')) return 'SKIP';
  return 'ERROR';
}

function extractSkipMessage(rawStatus) {
  const match = rawStatus.match(/^skipped\s+['"]?(.*?)['"]?$/);
  return match ? match[1] : '';
}

export function parseUnittestVerboseOutput(output) {
  const result = {
    status: 'PASS',
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    methods: [],
  };
  if (typeof output !== 'string' || !output.trim()) {
    return result;
  }

  const lines = output.split(/\r?\n/);
  const detailMessages = new Map();
  let pendingDocstringMethod = null;
  let inDetailSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SEPARATOR_EQ_RE.test(line)) {
      pendingDocstringMethod = null;
      inDetailSection = true;
      const headerLine = lines[i + 1] ?? '';
      const headerMatch = headerLine.match(DETAIL_HEADER_RE);
      if (headerMatch && SEPARATOR_DASH_RE.test(lines[i + 2] ?? '')) {
        const methodName = headerMatch[2].split('.').pop();
        const bodyLines = [];
        let j = i + 3;
        while (j < lines.length) {
          if (SEPARATOR_EQ_RE.test(lines[j])) break;
          if (SEPARATOR_DASH_RE.test(lines[j]) && RAN_RE.test(lines[j + 1] ?? '')) break;
          bodyLines.push(lines[j]);
          j++;
        }
        detailMessages.set(methodName, bodyLines.join('\n').trim());
        i = j - 1;
      }
      continue;
    }

    if (inDetailSection) continue;

    const singleMatch = line.match(TEST_LINE_RE);
    if (singleMatch) {
      pendingDocstringMethod = null;
      const method = singleMatch[1];
      const rawStatus = singleMatch[2];
      const status = mapStatusToken(rawStatus);
      const message = status === 'SKIP' ? extractSkipMessage(rawStatus) : '';
      result.methods.push({ method, status, message });
      continue;
    }

    if (pendingDocstringMethod) {
      const docMatch = line.match(DOCSTRING_STATUS_RE);
      if (docMatch) {
        const rawStatus = docMatch[1];
        const status = mapStatusToken(rawStatus);
        const message = status === 'SKIP' ? extractSkipMessage(rawStatus) : '';
        result.methods.push({ method: pendingDocstringMethod, status, message });
        pendingDocstringMethod = null;
        continue;
      }
      pendingDocstringMethod = null;
    }

    const docHeader = line.match(DOCSTRING_HEADER_RE);
    if (docHeader) {
      pendingDocstringMethod = docHeader[1];
    }
  }

  for (const entry of result.methods) {
    if (detailMessages.has(entry.method)) {
      entry.message = detailMessages.get(entry.method);
    }
    if (entry.status === 'PASS') result.passed++;
    else if (entry.status === 'FAIL') result.failed++;
    else if (entry.status === 'ERROR') result.errors++;
    else if (entry.status === 'SKIP') result.skipped++;
  }

  // Handle module-level loader/import errors where no individual test_* line ran
  for (const [method, msg] of detailMessages.entries()) {
    const exists = result.methods.some((m) => m.method === method);
    if (!exists) {
      result.errors++;
      result.methods.push({ method, status: 'ERROR', message: msg });
    }
  }

  const failedSummary = output.match(/FAILED\s*\(([^)]+)\)/);
  if (failedSummary) {
    const errMatch = failedSummary[1].match(/errors=(\d+)/);
    const failMatch = failedSummary[1].match(/failures=(\d+)/);
    if (errMatch && result.errors === 0) result.errors = Number.parseInt(errMatch[1], 10);
    if (failMatch && result.failed === 0) result.failed = Number.parseInt(failMatch[1], 10);
  }

  if (result.errors > 0) {
    result.status = 'ERROR';
  } else if (result.failed > 0) {
    result.status = 'FAIL';
  } else {
    result.status = 'PASS';
  }

  return result;
}
