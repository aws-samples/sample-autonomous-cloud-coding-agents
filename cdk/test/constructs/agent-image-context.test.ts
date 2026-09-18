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

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, AssetStaging, IgnoreStrategy, Stack } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';

const checkout = path.resolve(__dirname, '../../..');
const patterns = readFileSync(path.join(checkout, '.dockerignore'), 'utf8').split('\n');
const ignore = IgnoreStrategy.docker(checkout, patterns);
const dockerfile = readFileSync(path.join(checkout, 'agent/Dockerfile'), 'utf8');
const runtimeFiles = [
  'agent/Dockerfile', 'agent/pyproject.toml', 'agent/uv.lock',
  'agent/src/server.py', 'agent/src/prompts/developer.md',
  'agent/policies/hard_deny.cedar', 'agent/workflows/schema/workflow.schema.json',
  'contracts/constants.json', 'agent/prepare-commit-msg.sh', 'agent/managed-settings.json',
];
const noiseFiles = [
  'cdk/src/stacks/agent.ts', 'cdk/test-reports/junit.xml', 'cdk/.jest-cache/results.json',
  'cdk/tsconfig.tsbuildinfo', 'docs/design/temporary-plan.md', 'agent/tests/test_server.py',
  'agent/.venv/lib/site.py', 'agent/src/__pycache__/server.pyc', 'agent/.coverage.worker',
  'node_modules/package/index.js', '.git/config', '.env', 'future-package/output.js',
];

test('all versioned local COPY inputs remain in the Docker context', () => {
  const inputs = dockerfile.split('\n').filter(line => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1));
  expect(inputs).toContain('contracts/');
  expect(inputs).toContain('agent/src/');
  expect(inputs).toContain('agent/managed-settings.json');
  for (const input of inputs) {
    // Fail clearly if a new Dockerfile syntax needs corresponding coverage.
    expect(input).toMatch(/^(agent|contracts)\/[\w./-]*$/);
    const files = execFileSync('git', ['ls-files', '-z', '--', input], { cwd: checkout, encoding: 'utf8' })
      .split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(ignore.ignores(path.join(checkout, file))).toBe(false);
  }
});

test.each(noiseFiles)('excludes unrelated or generated input %s', file => {
  expect(ignore.ignores(path.join(checkout, file))).toBe(true);
});

describe('CDK Docker asset identity', () => {
  let temporary: string;
  let context: string;
  let sequence = 0;
  const write = (file: string, contents: string) => {
    const target = path.join(context, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const fingerprint = (platform: Platform) => {
    AssetStaging.clearAssetHashCache();
    const app = new App({ outdir: path.join(temporary, `assembly-${sequence++}`) });
    const stack = new Stack(app, 'Image');
    return new DockerImageAsset(stack, 'Agent', {
      directory: context, file: 'agent/Dockerfile', platform,
    }).assetHash;
  };
  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), 'agent-image-context-'));
    context = path.join(temporary, 'context');
    write('.dockerignore', patterns.join('\n'));
    for (const file of runtimeFiles) write(file, `runtime input: ${file}\n`);
  });
  afterEach(() => { rmSync(temporary, { recursive: true, force: true }); });

  test.each([Platform.LINUX_ARM64, Platform.LINUX_AMD64])('ignores artifact churn for %s', platform => {
    const original = fingerprint(platform);
    for (const file of noiseFiles) write(file, 'generated during build/test\n');
    expect(fingerprint(platform)).toBe(original);
    for (const file of noiseFiles) write(file, 'rewritten after another test run\n');
    expect(fingerprint(platform)).toBe(original);
    write('agent/src/server.py', 'changed runtime implementation\n');
    expect(fingerprint(platform)).not.toBe(original);
  });

  test.each(runtimeFiles)('invalidates the image when runtime input %s changes', file => {
    const original = fingerprint(Platform.LINUX_ARM64);
    write(file, 'different runtime input\n');
    expect(fingerprint(Platform.LINUX_ARM64)).not.toBe(original);
  });
});
