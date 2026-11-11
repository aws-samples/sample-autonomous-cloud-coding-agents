/**
 * Tests for `markdown-lint.mjs`, the structural Markdown lint.
 *
 * Every test builds a throwaway git repository in a temp dir and runs the real `lint()`
 * against it, with the real configuration and the installed markdownlint-cli2. Nothing
 * reads or changes this repository's files.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { lint } from './markdown-lint.mjs';

const CLEAN = '# Doc\n\n## Part\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![diagram](d.png)\n';
/** Twelve clean files: eleven sources and the hand-written home page. */
const SOURCES = {
  ...Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`docs/guides/doc${n}.md`, CLEAN])),
  'docs/src/content/docs/index.md': '---\ntitle: Home\n---\n\n## What\n',
};

// A git hook exports GIT_DIR and GIT_INDEX_FILE: without them git can only see the temp dir.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** Lints a repository that tracks `tracked` and also holds `untracked`. */
async function run(tracked = SOURCES, untracked = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-lint-'));
  roots.push(root);
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
  };
  write(tracked);
  execFileSync('git', ['init', '--quiet'], { cwd: root, env });
  execFileSync('git', ['add', '--all'], { cwd: root, env });
  write(untracked);
  const lines = [];
  const status = await lint(root, { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) });
  return { status, output: lines.join('\n') };
}

test('clean sources pass, and the number of files linted is printed', async () => {
  assert.deepEqual(await run(), { status: 0, output: 'markdown-lint: 12 Markdown files, no structural errors' });
});

test('each structural rule fails with the file, the line and the rule', async () => {
  const { status, output } = await run({
    ...SOURCES,
    'docs/guides/table.md': '# T\n\n| a | b |\n|---|---|\n| `x|y` | 2 |\n',
    'docs/guides/alt.md': '# T\n\n![](d.png)\n',
    'docs/guides/h1.mdx': '---\ntitle: T\n---\n\n# T again\n',
    'docs/guides/repeat.md': '# T\n\n## Same\n\n## Same\n',
    'docs/guides/skip.md': '# T\n\n### Too deep\n',
    'docs/src/content/docs/index.md': '---\ntitle: Home\n---\n\n# Home again\n',
    // A generated mirror is not linted: its source is.
    'docs/src/content/docs/using/Mirror.md': '# One\n\n# Two\n',
  });
  assert.equal(status, 1);
  assert.deepEqual(
    output
      .split('\n')
      .filter((line) => / error MD\d+\//.test(line))
      .map((line) => line.replace(/ error (MD\d+)\/.*/, ' $1')),
    [
      'docs/guides/alt.md:3:1 MD045',
      'docs/guides/h1.mdx:5 MD025',
      'docs/guides/repeat.md:5 MD024',
      'docs/guides/skip.md:3 MD001',
      'docs/guides/table.md:5:9 MD056',
      'docs/src/content/docs/index.md:5 MD025',
    ],
  );
  assert.match(output, /docs\/AGENTS\.md, "When the Markdown lint fails"/);
});

test('a markdownlint-disable comment does not switch a rule off', async () => {
  const { status, output } = await run({
    ...SOURCES,
    'docs/guides/quiet.md': '<!-- markdownlint-disable -->\n<!-- markdownlint-disable-file MD045 -->\n# T\n\n![](d.png)\n',
  });
  assert.equal(status, 1);
  assert.match(output, /^docs\/guides\/quiet\.md:5:1 error MD045\//m);
});

test('a second markdownlint configuration fails the lint, tracked or not', async () => {
  const broken = { ...SOURCES, 'docs/guides/alt.md': '# T\n\n![](d.png)\n' };
  const nested = await run({ ...broken, 'docs/guides/.markdownlint.json': '{ "MD045": false }\n' });
  assert.equal(nested.status, 1);
  assert.match(nested.output, /configuration found outside docs\/\.markdownlint-cli2\.jsonc:\n {2}docs\/guides\/\.markdownlint\.json\n/);

  const untracked = await run(broken, { '.markdownlint-cli2.yaml': 'ignores: ["**"]\n' });
  assert.equal(untracked.status, 1);
  assert.match(untracked.output, /configuration found outside docs\/\.markdownlint-cli2\.jsonc:\n {2}\.markdownlint-cli2\.yaml\n/);
});

test('a file list that is almost empty fails instead of passing', async () => {
  const { status, output } = await run({ 'README.md': CLEAN });
  assert.equal(status, 1);
  assert.match(output, /expected ≥10 Markdown files but found 1/);
});
