/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../scripts/check-mise-version-sync.ts');
const version = '2025.4.9';
const digest = `sha256:${'a'.repeat(64)}`;
const workflow = `jobs:
  reuse:
    uses: ./.github/workflows/reusable.yml
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: jdx/mise-action@v5
        with:
          version: "${version}" # mise release
      - uses: example/unrelated-action@v2
        with:
          version: 2.0.0
`;

describe('check-mise-version-sync', () => {
  let root: string;

  function writeDockerfile(image: string) {
    writeFileSync(join(root, '.devcontainer/Dockerfile'), `FROM ${image} AS mise\nFROM debian:bookworm\n`);
  }

  function writeWorkflow(name: string, contents: string) {
    writeFileSync(join(root, '.github/workflows', name), contents);
  }

  function run() {
    return spawnSync(process.execPath, ['--experimental-strip-types', script], { cwd: root, encoding: 'utf8' });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abca-mise-sync-'));
    mkdirSync(join(root, '.devcontainer'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeDockerfile(`jdxcode/mise:${version}@${digest}`);
    writeWorkflow('build.yml', workflow);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('accepts matching releases alongside unrelated action versions and reusable jobs', () => {
    expect(run().status).toBe(0);
  });

  test('flags a differing mise version in another step of a newly added .yaml workflow', () => {
    writeWorkflow('extra.yaml', `${workflow}      - uses: jdx/mise-action@v5\n        with: { version: "2025.5.1" }\n`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('extra.yaml');
    expect(result.stderr).toContain('2025.5.1');
  });

  test('flags a Dockerfile release bump when the workflow still uses the previous release', () => {
    writeDockerfile(`jdxcode/mise:2025.5.1@${digest}`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(version);
    expect(result.stderr).toContain('2025.5.1');
  });

  test('rejects a mise step missing its own version even when the following action sets one', () => {
    writeWorkflow('build.yml', workflow.replace(`version: "${version}"`, 'cache: true'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('build.yml');
  });

  test('fails when no workflow installs mise', () => {
    writeWorkflow('build.yml', workflow.replace('jdx/mise-action@v5', 'example/other@v5'));
    expect(run().status).toBe(1);
  });

  test('a second pinned stage cannot hide a floating mise image', () => {
    writeDockerfile('jdxcode/mise:latest');
    appendFileSync(join(root, '.devcontainer/Dockerfile'), `FROM jdxcode/mise:${version}@${digest} AS other\n`);
    expect(run().status).toBe(1);
  });

  test.each([`jdxcode/mise:${version}`, `jdxcode/mise:latest@${digest}`])(
    'rejects a Docker image without an exact release and digest: %s',
    (image) => {
      writeDockerfile(image);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Dockerfile');
    },
  );
});
