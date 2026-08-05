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

/** Every line that pulls an image from a registry: `FROM …` and `COPY --from=<registry ref>`. */
function externalImageRefs(): string[] {
  const refs: string[] = [];
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/.exec(line);
    // A `COPY --from=<stage>` names an earlier build stage, not a registry: no
    // slash, no colon, no digest. Only registry refs are pins we control.
    const copy = /^COPY\s+--from=(\S*[/:@]\S*)/.exec(line);
    const ref = from?.[1] ?? copy?.[1];
    // `FROM <stage> AS …` also re-uses a local stage name; same exclusion.
    if (ref && /[/:@]/.test(ref)) refs.push(ref);
  }
  return refs;
}

describe('agent image base pins', () => {
  test('every external image is pinned by DIGEST, not by tag', () => {
    // A tag is a moving pointer. When one moves, the layer that copies from it
    // changes and so does every layer built after it — here that is a ~400 MB apt
    // install, a node install and a dependency sync. The image is then rebuilt and
    // re-pushed in full for a commit that touched only a doc, which is slow
    // everywhere and painful on a modest uplink.
    //
    // The more serious half: two builds of the same commit can produce different
    // images. `mise:latest` was the worst case — a tag with no version at all,
    // republished at upstream's convenience.
    const unpinned = externalImageRefs().filter((r) => !r.includes('@sha256:'));
    expect(unpinned).toEqual([]);
  });

  test('a pinned ref keeps its human-readable tag alongside the digest', () => {
    // `image@sha256:…` alone is valid but opaque. Keeping `image:tag@sha256:…`
    // documents what the digest is meant to BE, so a reviewer can tell an
    // intentional version bump from a digest refresh of the same version.
    for (const ref of externalImageRefs()) {
      expect(ref).toMatch(/^[^@]+:[^@:]+@sha256:[a-f0-9]{64}$/);
    }
  });

  test('finds the refs it claims to check, so passing cannot mean "found nothing"', () => {
    // Guards the parser: a regex that silently matched nothing would make both
    // assertions above vacuously true.
    const refs = externalImageRefs();
    expect(refs.length).toBeGreaterThanOrEqual(4);
    expect(refs.some((r) => r.includes('mise'))).toBe(true);
    expect(refs.some((r) => r.includes('golang'))).toBe(true);
    expect(refs.some((r) => r.includes('python'))).toBe(true);
    expect(refs.some((r) => r.includes('astral-sh/uv'))).toBe(true);
  });

  test('build-stage references are not mistaken for registry images', () => {
    // `COPY --from=mise` and `COPY --from=gh-builder` name local stages, which
    // cannot and must not be digest-pinned. If the parser counted those, the pin
    // assertion would fail for an unfixable reason.
    const refs = externalImageRefs();
    expect(refs).not.toContain('mise');
    expect(refs).not.toContain('gh-builder');
  });
});
