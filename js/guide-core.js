/**
 * Pure reStructuredText parser tailored for guide.rst.
 * Zero DOM, window, document, or I/O dependencies.
 */

const HEADING_LEVELS = Object.freeze({
  '=': 1,
  '-': 2,
  '^': 3,
  '~': 4,
});

const HEADING_UNDERLINE_RE = /^([=\-^~])\1{2,}\s*$/;
const DIRECTIVE_RE = /^\.\.\s+[A-Za-z0-9_-]+::/;
const LIST_ITEM_RE = /^-\s+(.*)$/;
const INDENTED_RE = /^[ \t]+\S/;
const RUNNABLE_CMD_RE = /^(cd|ls|pwd|git|python3?|cat|nano|vi|mkdir|rm)(?:\s|$)/;
const INLINE_URL_RE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`<]+?)\s+<(https?:\/\/[^>\s]+)>`_|(https?:\/\/[^\s<>`\]")]+)/g;

function slugify(title, usedIds) {
  const base = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  let idx = 2;
  while (usedIds.has(`${base}-${idx}`)) {
    idx++;
  }
  const unique = `${base}-${idx}`;
  usedIds.add(unique);
  return unique;
}

function cleanBareUrl(rawUrl) {
  let url = rawUrl;
  while (/[.,;:!?]$/.test(url)) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes > opens) {
      url = url.slice(0, -1);
    } else {
      break;
    }
  }
  return url;
}

function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  INLINE_URL_RE.lastIndex = 0;

  let match;
  while ((match = INLINE_URL_RE.exec(text)) !== null) {
    let label;
    let url;
    if (match[1] !== undefined) {
      label = match[1].trim();
      url = match[2];
    } else if (match[3] !== undefined) {
      label = match[3].trim();
      url = match[4];
    } else {
      url = cleanBareUrl(match[5]);
      label = url;
    }

    const key = `${label}\0${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      urls.push({ label, url });
    }
  }

  return urls;
}

function extractCommands(rawCode) {
  const commands = [];
  const lines = rawCode.split(/\r?\n/);

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('$ ')) {
      trimmed = trimmed.slice(2).trim();
    } else if (trimmed === '$') {
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) continue;
    if (RUNNABLE_CMD_RE.test(trimmed)) {
      commands.push(trimmed);
    }
  }

  return commands;
}

function dedentBlock(lines) {
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  return lines
    .map((line) => (line.trim() ? line.slice(minIndent) : ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function isHeadingAt(lines, idx) {
  const titleLine = lines[idx];
  const underLine = lines[idx + 1];
  if (!titleLine || !underLine) return false;
  if (/^[ \t]/.test(titleLine)) return false;
  if (DIRECTIVE_RE.test(titleLine) || LIST_ITEM_RE.test(titleLine)) return false;
  return HEADING_UNDERLINE_RE.test(underLine);
}

function consumeIndentedBlock(lines, startIdx) {
  let i = startIdx;
  while (i < lines.length && !lines[i].trim()) {
    i++;
  }
  const blockLines = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let lookahead = i + 1;
      while (lookahead < lines.length && !lines[lookahead].trim()) {
        lookahead++;
      }
      if (lookahead < lines.length && INDENTED_RE.test(lines[lookahead])) {
        blockLines.push('');
        i++;
        continue;
      }
      break;
    }
    if (INDENTED_RE.test(line)) {
      blockLines.push(line);
      i++;
    } else {
      break;
    }
  }
  return { blockLines, nextIdx: i };
}

export function parseRstGuide(rstText) {
  if (typeof rstText !== 'string' || !rstText.trim()) {
    return [];
  }

  const lines = rstText.split(/\r?\n/);
  const sections = [];
  const usedIds = new Set();
  let currentSection = null;

  function ensureSection() {
    if (!currentSection) {
      currentSection = {
        id: slugify('guide', usedIds),
        title: 'Guide',
        level: 1,
        blocks: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (isHeadingAt(lines, i)) {
      const title = line.trim();
      const underlineChar = lines[i + 1].trim()[0];
      const level = HEADING_LEVELS[underlineChar] ?? 2;
      currentSection = {
        id: slugify(title, usedIds),
        title,
        level,
        blocks: [],
      };
      sections.push(currentSection);
      i += 2;
      continue;
    }

    if (DIRECTIVE_RE.test(line)) {
      const { nextIdx } = consumeIndentedBlock(lines, i + 1);
      i = nextIdx;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const listMatch = lines[i].match(LIST_ITEM_RE);
        if (!listMatch) break;
        const parts = [listMatch[1].trim()];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() &&
          INDENTED_RE.test(lines[i]) &&
          !LIST_ITEM_RE.test(lines[i])
        ) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push(parts.join(' '));
      }
      const urls = extractUrls(items.join('\n'));
      ensureSection().blocks.push({ type: 'list', items, urls });
      continue;
    }

    // Paragraph (may end with :: to introduce a literal code block)
    const paraLines = [];
    let startsLiteralBlock = false;
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (isHeadingAt(lines, i)) break;
      if (DIRECTIVE_RE.test(cur) || LIST_ITEM_RE.test(cur)) break;

      if (cur.trimEnd().endsWith('::')) {
        startsLiteralBlock = true;
        const stripped = cur.trimEnd();
        if (stripped === '::') {
          i++;
          break;
        }
        if (stripped.endsWith(' ::')) {
          paraLines.push(stripped.slice(0, -3).trimEnd());
        } else {
          paraLines.push(stripped.slice(0, -1));
        }
        i++;
        break;
      }

      paraLines.push(cur.trim());
      i++;
    }

    if (paraLines.length > 0) {
      const text = paraLines.join(' ');
      ensureSection().blocks.push({
        type: 'paragraph',
        text,
        urls: extractUrls(text),
      });
    }

    if (startsLiteralBlock) {
      const { blockLines, nextIdx } = consumeIndentedBlock(lines, i);
      i = nextIdx;
      if (blockLines.length > 0) {
        const raw = dedentBlock(blockLines);
        const commands = extractCommands(raw);
        ensureSection().blocks.push({
          type: 'code',
          raw,
          commands,
        });
      }
    }
  }

  return sections;
}
