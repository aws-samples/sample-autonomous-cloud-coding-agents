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
const GITHUB = 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents';
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
  [`${CONTENT}/index.md`]: '---\ntitle: Home\n---\n\nHand-written home page.\n',
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

/** The lines of a generated page that start with a link or an image. */
const links = (root, target) =>
  page(root, target)
    .split('\n')
    .filter((line) => /^!?\[/.test(line));

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
    'index.md',
    'start/Start.mdx',
  ]);
  assert.equal(page(root, 'guide/Introduction.md'), '---\ntitle: "Guide introduction"\n---\n\nIntro text.');
  assert.equal(page(root, 'guide/First-section.md'), '---\ntitle: "First section"\n---\n\nFirst text.');
  assert.equal(page(root, 'elsewhere/Moved-section.md'), '---\ntitle: "Moved section"\n---\n\nMoved text.');
});

test('every ## section is published; an introduction that is only the H1 is not', () => {
  const root = repo({
    'docs/guides/GUIDE.md': '# Guide\n\n## Overview\n\nOverview text.\n\n## Prerequisites\n\n- One bullet\n\n## Empty\n',
    'docs/design/API.md': '# API\n\n[guide](../guides/GUIDE.md) [title](../guides/GUIDE.md#guide)\n',
  });
  sync(root, PLAN);

  assert.deepEqual(
    pages(root).filter((target) => target.startsWith('guide/')),
    ['guide/Contributing.md', 'guide/Empty.md', 'guide/Overview.md', 'guide/Prerequisites.md'],
  );
  assert.equal(page(root, 'guide/Prerequisites.md'), '---\ntitle: "Prerequisites"\n---\n\n- One bullet');
  // Without an introduction page, links to the guide land on its first section.
  assert.deepEqual(links(root, 'architecture/Api.md'), [`[guide](${BASE}/guide/overview) [title](${BASE}/guide/overview)`]);
});

test('a ## line inside a code fence does not start a page', () => {
  const section = [
    'Before the fences.',
    '',
    '```markdown',
    '## Not a section',
    '```',
    '',
    '~~~~',
    '```',
    '## Still not a section',
    '~~~~',
    '',
    'After the fences.',
  ].join('\n');
  const root = repo({ 'docs/guides/GUIDE.md': `# Guide\n\n## First\n\n${section}\n\n## Second\n\nText.\n` });
  sync(root, PLAN);

  assert.deepEqual(
    pages(root).filter((target) => target.startsWith('guide/')),
    ['guide/Contributing.md', 'guide/First.md', 'guide/Second.md'],
  );
  assert.equal(page(root, 'guide/First.md'), `---\ntitle: "First"\n---\n\n${section}`);
});

test('two sources for one page fail instead of overwriting each other', () => {
  assert.throws(
    () => sync(repo({ 'docs/guides/GUIDE.md': '# Guide\n\n## Setup\n\nOne.\n\n## Setup!\n\nTwo.\n' }), PLAN),
    /docs\/guides\/GUIDE\.md \("Setup!"\) and docs\/guides\/GUIDE\.md \("Setup"\) both generate docs\/src\/content\/docs\/guide\/Setup\.md/,
  );
  assert.throws(
    () => sync(repo({ 'docs/guides/GUIDE.md': '# Guide\n\n## Contributing\n\nText.\n' }), PLAN),
    /CONTRIBUTING\.md \("Contributing"\) and docs\/guides\/GUIDE\.md \("Contributing"\) both generate/,
  );
  assert.throws(
    () => sync(repo(), [...PLAN, { file: 'docs/design/API.md', to: 'index.md' }]),
    /docs\/design\/API\.md \("API"\) and a hand-authored page both generate docs\/src\/content\/docs\/index\.md/,
  );
});

test('mirrors and images without a source are pruned; hand-authored pages are kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const root = repo({
    'docs/guides/GUIDE.md': '# Guide\n\n## Old name\n\nText.\n',
    'docs/design/EXTRA.md': '# Extra\n',
    'docs/imgs/old.png': 'png',
    'docs/imgs/kept.png': 'png',
    [`${CONTENT}/stray/Hand-made.md`]: '---\ntitle: Stray\n---\n',
  });
  sync(root, PLAN);
  assert.ok(pages(root).includes('guide/Old-name.md') && pages(root).includes('architecture/Extra.md'));
  // The first sync removed the stray page, and said so.
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments[0].split(': ')[1]),
    [`removed ${CONTENT}/stray/Hand-made.md`],
  );

  // Rename a heading, delete a source file and an image, then sync again.
  fs.writeFileSync(path.join(root, 'docs/guides/GUIDE.md'), '# Guide\n\n## New name\n\nText.\n');
  fs.rmSync(path.join(root, 'docs/design/EXTRA.md'));
  fs.rmSync(path.join(root, 'docs/imgs/old.png'));
  sync(root, PLAN);

  assert.deepEqual(pages(root), [
    'architecture/Api.md',
    'decisions/Adr-001-first.md',
    'decisions/Readme.md',
    'guide/Contributing.md',
    'guide/New-name.md',
    'index.md',
    'start/Start.mdx',
  ]);
  assert.equal(page(root, 'index.md'), SOURCES[`${CONTENT}/index.md`]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs/public/imgs')), ['kept.png']);
  assert.deepEqual(
    warn.mock.calls
      .slice(1)
      .map((call) => call.arguments[0].split(': ')[1])
      .sort(),
    [
      'removed docs/public/imgs/old.png',
      `removed ${CONTENT}/architecture/Extra.md`,
      `removed ${CONTENT}/guide/Old-name.md`,
    ],
  );
});

test('a missing source fails the sync and leaves the mirrors untouched', () => {
  const root = repo();
  sync(root, PLAN);
  const before = pages(root).map((target) => page(root, target));

  fs.rmSync(path.join(root, 'CONTRIBUTING.md'));
  fs.writeFileSync(path.join(root, 'docs/design/API.md'), '# Changed\n');
  assert.throws(() => sync(root, PLAN), /missing source CONTRIBUTING\.md\. .*update PLAN in docs\/scripts\/sync-starlight\.mjs/);
  assert.deepEqual(
    pages(root).map((target) => page(root, target)),
    before,
  );

  assert.throws(() => sync(repo(), [{ split: 'docs/guides/GONE.md', to: 'guide' }]), /missing source docs\/guides\/GONE\.md/);
  assert.throws(() => sync(repo(), [{ dir: 'docs/gone', to: 'gone' }]), /no Markdown source in docs\/gone/);
  assert.throws(
    () => sync(repo({ 'docs/guides/GUIDE.md': '# Only a title\n' }), PLAN),
    /docs\/guides\/GUIDE\.md has no content to publish/,
  );
});

test('the source H1 becomes the quoted title and the only H1 of the page', () => {
  const root = repo({
    'docs/decisions/ADR-001-first.md': '# ADR-001: A "quoted" title: with colons\n\nDecision text.\n\n## Context\n',
    'docs/design/API.md': 'No heading at all.\n',
    'docs/guides/START.mdx':
      "---\ntitle: Start\n---\n\nimport { Tabs } from '@astrojs/starlight/components';\n\n# Start\n\nStart text.\n",
  });
  sync(root, PLAN);

  assert.equal(
    page(root, 'decisions/Adr-001-first.md'),
    '---\ntitle: "ADR-001: A \\"quoted\\" title: with colons"\n---\n\nDecision text.\n\n## Context\n',
  );
  // No H1 in the source: the file name is the fallback.
  assert.equal(page(root, 'architecture/Api.md'), '---\ntitle: "Api"\n---\n\nNo heading at all.\n');
  // A source with its own frontmatter keeps it; its H1 would be a second one.
  assert.equal(
    page(root, 'start/Start.mdx'),
    "---\ntitle: Start\n---\n\nimport { Tabs } from '@astrojs/starlight/components';\n\nStart text.\n",
  );
  for (const target of pages(root)) {
    assert.doesNotMatch(page(root, target), /^# /m, `${target} has an H1 in its body`);
  }
});

test('links to mirrored files become site routes (#920)', () => {
  const root = repo({
    'CONTRIBUTING.md': [
      '# Contributing',
      '',
      '[mdx](./docs/guides/START.mdx)',
      '[adr](./docs/decisions/ADR-001-first.md)',
      '[readme](./docs/decisions/README.md#lifecycle)',
      '[directory](./docs/decisions/)',
      '[design](./docs/design/API.md#errors "with a title")',
      '[home](./docs/src/content/docs/index.md)',
      '[external](https://example.com/a.md) [absolute](/elsewhere/a.md) [mail](mailto:a@example.com)',
      '',
    ].join('\n'),
    'docs/design/API.md': '# API\n\n[adr](../decisions/ADR-001-first.md) [same file](#errors) [unknown](#nowhere)\n\n## Errors\n',
  });
  sync(root, PLAN);

  assert.deepEqual(links(root, 'guide/Contributing.md'), [
    `[mdx](${BASE}/start/start)`,
    `[adr](${BASE}/decisions/adr-001-first)`,
    `[readme](${BASE}/decisions/readme#lifecycle)`,
    `[directory](${BASE}/decisions/readme)`,
    `[design](${BASE}/architecture/api#errors "with a title")`,
    `[home](${BASE}/)`,
    '[external](https://example.com/a.md) [absolute](/elsewhere/a.md) [mail](mailto:a@example.com)',
  ]);
  assert.deepEqual(links(root, 'architecture/Api.md'), [
    `[adr](${BASE}/decisions/adr-001-first) [same file](#errors) [unknown](#nowhere)`,
  ]);
});

test('links to files that are not published point at GitHub; images are served from /imgs', () => {
  const root = repo({
    'AGENTS.md': '# Agents\n',
    'agent/README.md': '# Agent\n\n## Setup\n',
    'contracts/parity/case.json': '{}\n',
    'docs/imgs/nested/arch.png': 'png',
    'docs/design/API.md': [
      '# API',
      '',
      '[agents](../../AGENTS.md) [setup](../../agent/README.md#setup) [fixtures](../../contracts/parity/)',
      '![architecture](../imgs/nested/arch.png)',
      '[dangling](./GONE.md) [outside](../../../elsewhere.md)',
      '',
    ].join('\n'),
  });
  sync(root, PLAN);

  assert.deepEqual(links(root, 'architecture/Api.md'), [
    `[agents](${GITHUB}/blob/main/AGENTS.md) [setup](${GITHUB}/blob/main/agent/README.md#setup) [fixtures](${GITHUB}/tree/main/contracts/parity)`,
    `![architecture](${BASE}/imgs/nested/arch.png)`,
    // Left as written: the link checks report a target that does not exist.
    '[dangling](./GONE.md) [outside](../../../elsewhere.md)',
  ]);
  assert.equal(fs.readFileSync(path.join(root, 'docs/public/imgs/nested/arch.png'), 'utf8'), 'png');
});

test('an image that is not a file in docs/imgs fails the sync and leaves the mirrors untouched', () => {
  const root = repo({ 'docs/diagrams/flow.svg': '<svg/>' });
  sync(root, PLAN);
  const before = pages(root).map((target) => page(root, target));

  // The guide is written before the design document that shows the image.
  fs.writeFileSync(path.join(root, 'docs/guides/GUIDE.md'), '# Guide\n\nChanged.\n\n## First\n\nChanged.\n');
  fs.writeFileSync(path.join(root, 'docs/design/API.md'), '# API\n\n![flow](../diagrams/flow.svg)\n');
  assert.throws(
    () => sync(root, PLAN),
    /docs\/design\/API\.md shows the image \.\.\/diagrams\/flow\.svg, which is not a file in docs\/imgs\/.* Correct the path, or move the image there\./,
  );
  assert.deepEqual(
    pages(root).map((target) => page(root, target)),
    before,
  );

  fs.writeFileSync(path.join(root, 'docs/design/API.md'), '# API\n\n![gone](../imgs/gone.png)\n');
  assert.throws(() => sync(root, PLAN), /docs\/design\/API\.md shows the image \.\.\/imgs\/gone\.png, which is not a file in docs\/imgs\//);

  // A link to the same file is not an image: it goes to GitHub.
  fs.writeFileSync(path.join(root, 'docs/design/API.md'), '# API\n\n[flow](../diagrams/flow.svg)\n');
  sync(root, PLAN);
  assert.deepEqual(links(root, 'architecture/Api.md'), [`[flow](${GITHUB}/blob/main/docs/diagrams/flow.svg)`]);
});

test('anchors into a split guide land on the page that holds the heading (#765)', () => {
  const root = repo({
    'docs/guides/GUIDE.md': [
      '# Guide',
      '',
      '[second](#second) [deep](#deep-heading) [the title](#guide)',
      '',
      '## First',
      '',
      '[deep](#deep-heading) [local](#local-heading) [myself](#first)',
      '',
      '### Local heading',
      '',
      '### Examples',
      '',
      '## Second',
      '',
      '### Deep heading',
      '',
      '### Examples',
      '',
      '### GitHub PAT — minimal `permissions` (v2)',
      '',
      '## Moved section',
      '',
      'Text.',
      '',
    ].join('\n'),
    'docs/design/API.md': [
      '# API',
      '',
      '[guide](../guides/GUIDE.md) [h2](../guides/GUIDE.md#second) [h3](../guides/GUIDE.md#deep-heading)',
      '[first examples](../guides/GUIDE.md#examples) [second examples](../guides/GUIDE.md#examples-1)',
      '[punctuation](../guides/GUIDE.md#github-pat--minimal-permissions-v2) [moved](../guides/GUIDE.md#moved-section)',
      '[unknown](../guides/GUIDE.md#no-such-heading)',
      '',
    ].join('\n'),
  });
  sync(root, PLAN);

  assert.deepEqual(links(root, 'architecture/Api.md'), [
    `[guide](${BASE}/guide/introduction) [h2](${BASE}/guide/second) [h3](${BASE}/guide/second#deep-heading)`,
    // GitHub numbers the second "Examples" of the file; on the site each page has its own.
    `[first examples](${BASE}/guide/first#examples) [second examples](${BASE}/guide/second#examples)`,
    `[punctuation](${BASE}/guide/second#github-pat--minimal-permissions-v2) [moved](${BASE}/elsewhere/moved-section)`,
    // An anchor the guide does not have is passed through, so that the site link check reports it.
    `[unknown](${BASE}/guide/introduction#no-such-heading)`,
  ]);
  assert.deepEqual(links(root, 'guide/Introduction.md'), [
    `[second](${BASE}/guide/second) [deep](${BASE}/guide/second#deep-heading) [the title](#_top)`,
  ]);
  // On the page that holds the heading the anchor stays local; the section heading is the page title.
  assert.deepEqual(links(root, 'guide/First.md'), [
    `[deep](${BASE}/guide/second#deep-heading) [local](#local-heading) [myself](#_top)`,
  ]);
});

test('links inside code are left alone', () => {
  const root = repo({
    'docs/design/API.md': [
      '# API',
      '',
      '[rewritten](./OTHER.md) but not `[code](./OTHER.md)` or ``[more `code`](./OTHER.md)``',
      '',
      '```markdown',
      '[fenced](./OTHER.md)',
      '```',
      '',
      '~~~~',
      '```',
      '[still fenced](./OTHER.md)',
      '~~~~',
      '',
      '[after the fences](./OTHER.md)',
      '',
    ].join('\n'),
    'docs/design/OTHER.md': '# Other\n',
  });
  sync(root, PLAN);

  assert.deepEqual(links(root, 'architecture/Api.md'), [
    `[rewritten](${BASE}/architecture/other) but not \`[code](./OTHER.md)\` or \`\`[more \`code\`](./OTHER.md)\`\``,
    '[fenced](./OTHER.md)',
    '[still fenced](./OTHER.md)',
    `[after the fences](${BASE}/architecture/other)`,
  ]);
});
