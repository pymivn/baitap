import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseRstGuide } from '../../js/guide-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = resolve(__dirname, '../../guide.rst');

describe('guide-core: parseRstGuide headings, paragraphs, and lists', () => {
  it('parses headings with =, -, ^, ~ underlines and assigns levels and unique ids', () => {
    const rst = [
      'PyMi Exercises',
      '==============',
      '',
      'Intro paragraph.',
      '',
      'Hướng dẫn làm bài tập',
      '---------------------',
      '',
      'Bước 1',
      '^^^^^^',
      '',
      'Chi tiết',
      '~~~~~~~~',
      '',
      '- Mục 1',
      '- Mục 2',
      '  dòng tiếp theo',
      '',
      'Bước 1',
      '^^^^^^',
      'Lặp lại.',
    ].join('\n');

    const sections = parseRstGuide(rst);
    assert.equal(sections.length, 5);
    assert.deepEqual(
      sections.map((s) => ({ title: s.title, level: s.level })),
      [
        { title: 'PyMi Exercises', level: 1 },
        { title: 'Hướng dẫn làm bài tập', level: 2 },
        { title: 'Bước 1', level: 3 },
        { title: 'Chi tiết', level: 4 },
        { title: 'Bước 1', level: 3 },
      ]
    );
    assert.equal(sections[0].id, 'pymi-exercises');
    assert.equal(sections[2].id, 'buoc-1');
    assert.notEqual(sections[2].id, sections[4].id);

    assert.deepEqual(sections[0].blocks, [
      { type: 'paragraph', text: 'Intro paragraph.', urls: [] },
    ]);
    assert.deepEqual(sections[3].blocks, [
      {
        type: 'list',
        items: ['Mục 1', 'Mục 2 dòng tiếp theo'],
        urls: [],
      },
    ]);
  });
});

describe('guide-core: literal code blocks and command extraction', () => {
  it('extracts runnable commands while ignoring $ prompts, # comments, and output lines', () => {
    const rst = [
      'Lấy code về máy',
      '^^^^^^^^^^^^^^^^',
      '',
      'Chạy lệnh sau::',
      '',
      '  $ git clone https://thegit.pymi.vn/pyfml/pyfml.git pyfml',
      '',
      '  Cloning into \'pyfml\'...',
      '  $ ls pyfml/',
      '  01_lecture.rst          gittree.png',
      '  # trong pyfml',
      '  $ cd pyfml',
      '  $ python3 ex3_0.py',
      '  $ python ../vendor/pep8.py ex3_0.py',
      '  $ pwd',
      '  $ cat guide.rst',
      '  $ nano ex3_0.py',
      '  $ vi ex3_0.py',
      '  $ mkdir tmpdir',
      '  $ rm tmpdir',
      '  * master',
    ].join('\n');

    const sections = parseRstGuide(rst);
    assert.equal(sections.length, 1);
    const blocks = sections[0].blocks;
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks[0].text, 'Chạy lệnh sau:');

    const codeBlock = blocks[1];
    assert.equal(codeBlock.type, 'code');
    assert.ok(codeBlock.raw.includes("Cloning into 'pyfml'..."));
    assert.deepEqual(codeBlock.commands, [
      'git clone https://thegit.pymi.vn/pyfml/pyfml.git pyfml',
      'ls pyfml/',
      'cd pyfml',
      'python3 ex3_0.py',
      'python ../vendor/pep8.py ex3_0.py',
      'pwd',
      'cat guide.rst',
      'nano ex3_0.py',
      'vi ex3_0.py',
      'mkdir tmpdir',
      'rm tmpdir',
    ]);
  });

  it('ignores RST directives such as .. image:: and .. toctree::', () => {
    const rst = [
      'Video',
      '^^^^^',
      '',
      '.. image:: https://asciinema.org/a/123.svg',
      '   :width: 400',
      '   :target: https://asciinema.org/a/123',
      '',
      'Text after image.',
      '',
      '.. toctree::',
      '   :maxdepth: 2',
      '',
      '   exercises/*',
    ].join('\n');

    const sections = parseRstGuide(rst);
    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].blocks, [
      { type: 'paragraph', text: 'Text after image.', urls: [] },
    ]);
  });
});

describe('guide-core: inline URL extraction & XSS safety', () => {
  it('extracts bare, markdown, and RST links as plain data without HTML injection', () => {
    const rst = [
      'Links',
      '-----',
      '',
      'See https://docs.python.org/3/tutorial/interpreter.html#invoking-the-interpreter) and',
      '[Terminal](http://www.familug.org/2012/03/ccgu-cli-can-ban.html#more) and',
      '`đây <https://gitlab.com/pyfml/prepare#setup>`_ <script>alert(1)</script>.',
      '',
      '- https://faq.pymi.vn/',
    ].join('\n');

    const sections = parseRstGuide(rst);
    const para = sections[0].blocks[0];
    assert.equal(para.type, 'paragraph');
    assert.deepEqual(para.urls, [
      {
        label: 'https://docs.python.org/3/tutorial/interpreter.html#invoking-the-interpreter',
        url: 'https://docs.python.org/3/tutorial/interpreter.html#invoking-the-interpreter',
      },
      {
        label: 'Terminal',
        url: 'http://www.familug.org/2012/03/ccgu-cli-can-ban.html#more',
      },
      {
        label: 'đây',
        url: 'https://gitlab.com/pyfml/prepare#setup',
      },
    ]);

    const list = sections[0].blocks[1];
    assert.equal(list.type, 'list');
    assert.deepEqual(list.urls, [
      { label: 'https://faq.pymi.vn/', url: 'https://faq.pymi.vn/' },
    ]);
  });
});

describe('guide-core: real guide.rst parsing', () => {
  it('parses the repository guide.rst cleanly', () => {
    const rstText = readFileSync(GUIDE_PATH, 'utf8');
    const sections = parseRstGuide(rstText);

    assert.ok(sections.length >= 15);
    assert.equal(sections[0].title, 'PyMi Exercises');
    assert.equal(sections[0].level, 1);

    const allCommands = sections.flatMap((s) =>
      s.blocks.filter((b) => b.type === 'code').flatMap((b) => b.commands ?? [])
    );
    assert.ok(allCommands.includes('ls pyfml/'));
    assert.ok(allCommands.includes('cd pyfml'));
    assert.ok(allCommands.includes('cd exercises'));
    assert.ok(allCommands.includes('python3 ../vendor/pep8.py ex3_0.py'));
    assert.ok(allCommands.includes('python3 -m unittest tests.test_ex3 -vvv'));
    assert.ok(!allCommands.some((c) => c.startsWith('Cloning')));
    assert.ok(!allCommands.some((c) => c.startsWith('* master')));
    assert.ok(!allCommands.some((c) => c.includes('gittree.png')));
  });
});
