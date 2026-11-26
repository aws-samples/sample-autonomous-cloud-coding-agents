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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dockerfile = readFileSync(
  join(__dirname, '..', '..', '..', 'agent', 'Dockerfile'), 'utf-8',
);

function externalImageRefs(): string[] {
  const refs: string[] = [];
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/.exec(line);
    const copy = /^COPY\s+--from=(\S*[/:@]\S*)/.exec(line);
    const ref = from?.[1] ?? copy?.[1];
    if (ref && /[/:@]/.test(ref)) refs.push(ref);
  }
  return refs;
}

describe('agent image base pins', () => {
  test('every external image is pinned by DIGEST, not by tag', () => {
    const unpinned = externalImageRefs().filter((r) => !r.includes('@sha256:'));
    expect(unpinned).toEqual([]);
  });

  test('a pinned ref keeps its human-readable tag alongside the digest', () => {
    for (const ref of externalImageRefs()) {
      expect(ref).toMatch(/^[^@]+:[^@:]+@sha256:[a-f0-9]{64}$/);
    }
  });

  test('finds the refs it claims to check, so passing cannot mean "found nothing"', () => {
    const refs = externalImageRefs();
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some((r) => r.includes('mise'))).toBe(true);
    expect(refs.some((r) => r.includes('python'))).toBe(true);
    expect(refs.some((r) => r.includes('astral-sh/uv'))).toBe(true);
  });

  test('build-stage references are not mistaken for registry images', () => {
    const refs = externalImageRefs();
    expect(refs).not.toContain('mise');
  });

  test('installs gh from its release, checked against a pinned SHA-256 per architecture (#1077)', () => {
    for (const arch of ['AMD64', 'ARM64']) {
      expect(dockerfile).toMatch(new RegExp(`^ARG GH_SHA256_${arch}=[a-f0-9]{64}$`, 'm'));
    }
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).not.toMatch(/go install/);
  });
});
