/**
 * Tests for `sync-starlight.mjs`, the generator of the Starlight mirrors.
 *
 * Every test builds a throwaway repository in a temp dir and runs the real `sync()` against
 * it with a small plan, then reads the generated tree. Nothing touches the real mirrors.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { sync } from './sync-starlight.mjs';

const BASE = '/sample-autonomous-cloud-coding-agents';
const CONTENT = 'docs/src/content/docs';

const PLAN = [
  {
    split: 'docs/guides/GUIDE.md',
    to: 'guide',
    introTitle: 'Guide introduction',
    moved: { 'Moved-section.md': 'elsewhere' },
  },
  { file: 'docs/guides/START.mdx', to: 'start/Start.mdx' },
  { file: 'CONTRIBUTING.md', to: 'guide/Contributing.md' },
  { dir: 'docs/design', to: 'architecture' },
  { dir: 'docs/decisions', to: 'decisions' },
];

/** The smallest repository that satisfies PLAN; tests override the files they care about. */
const SOURCES = {
  'docs/guides/GUIDE.md': '# Guide\n\nIntro text.\n\n## First\n\nFirst text.\n',
  'docs/guides/START.mdx': '---\ntitle: Start\n---\n\n# Start\n\nStart text.\n',
  'CONTRIBUTING.md': '# Contributing\n\nContributing text.\n',
  'docs/design/API.md': '# API\n\n## Errors\n\nError text.\n',
  'docs/decisions/README.md': '# Decisions\n\n## Lifecycle\n\nLifecycle text.\n',
  'docs/decisions/ADR-001-first.md': '# ADR-001: First\n\nDecision text.\n',
};

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function repo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-starlight-'));
  roots.push(root);
  for (const [file, text] of Object.entries({ ...SOURCES, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const page = (root, target) => fs.readFileSync(path.join(root, CONTENT, target), 'utf8');

function pages(root) {
  return fs
    .readdirSync(path.join(root, CONTENT), { recursive: true })
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

test('splits a guide into one page per ## section', () => {
  const root = repo({
    'docs/guides/GUIDE.md': [
      '# Guide',
      '',
      'Intro text.',
      '',
      '## First section',
      '',
      'First text.',
      '',
      '## Moved section',
      '',
      'Moved text.',
      '',
    ].join('\n'),
  });
  sync(root, PLAN);

  assert.deepEqual(pages(root), [
    'architecture/Api.md',
    'decisions/Adr-001-first.md',
    'decisions/Readme.md',
    'elsewhere/Moved-section.md',
    'guide/Contributing.md',
    'guide/First-section.md',
    'guide/Introduction.md',
    'start/Start.mdx',
  ]);
  assert.equal(page(root, 'guide/Introduction.md'), '---\ntitle: Guide introduction\n---\n\n# Guide\n\nIntro text.');
  assert.equal(page(root, 'guide/First-section.md'), '---\ntitle: First section\n---\n\nFirst text.');
  assert.equal(page(root, 'elsewhere/Moved-section.md'), '---\ntitle: Moved section\n---\n\nMoved text.');
});

test('mirrors files under a title taken from the file name; a source keeps its own frontmatter', () => {
  const root = repo();
  sync(root, PLAN);

  assert.equal(page(root, 'decisions/Adr-001-first.md'), '---\ntitle: Adr 001 first\n---\n\n# ADR-001: First\n\nDecision text.\n');
  assert.equal(page(root, 'start/Start.mdx'), SOURCES['docs/guides/START.mdx']);
});

test('links between design documents become site routes', () => {
  const root = repo({
    'docs/design/API.md': '# API\n\n[other](./OTHER_DOC.md#errors) [external](https://example.com/a.md) [anchor](#errors)\n',
    'docs/design/OTHER_DOC.md': '# Other\n\n## Errors\n',
  });
  sync(root, PLAN);

  assert.match(
    page(root, 'architecture/Api.md'),
    new RegExp(`\\[other\\]\\(${BASE}/architecture/other-doc#errors\\) \\[external\\]\\(https://example.com/a.md\\) \\[anchor\\]\\(#errors\\)`),
  );
});
