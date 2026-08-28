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

/**
 * Grammar parity corpus runner (TypeScript side) for registry:// refs (#246).
 *
 * Loads ``contracts/registry-resolution/cases.json`` and asserts ``parseRef``
 * agrees with each golden verdict. The companion runner
 * ``agent/tests/test_registry_resolution_corpus.py`` runs the same file against
 * the Python ``parse_ref``; if either side disagrees, CI fails before deploy.
 * Mirrors the cedar-parity dual-runner pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseRef } from '../../../src/handlers/shared/registry/ref';

const CASES_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'registry-resolution',
  'cases.json',
);

interface ExpectedOk {
  ok: true;
  kind: string;
  namespace: string;
  name: string;
  op: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}
interface ExpectedErr {
  ok: false;
  reason: string;
}
interface Case {
  name: string;
  ref: string;
  expected: ExpectedOk | ExpectedErr;
}

const corpus = JSON.parse(fs.readFileSync(CASES_FILE, 'utf-8')) as { cases: Case[] };

describe('registry:// grammar parity corpus (TS parseRef)', () => {
  test('corpus is present and non-empty', () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    test(c.name, () => {
      const result = parseRef(c.ref);
      if (!c.expected.ok) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe(c.expected.reason);
        }
        return;
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ref.kind).toBe(c.expected.kind);
        expect(result.ref.namespace).toBe(c.expected.namespace);
        expect(result.ref.name).toBe(c.expected.name);
        expect(result.ref.constraint.op).toBe(c.expected.op);
        expect(result.ref.constraint.major).toBe(c.expected.major);
        expect(result.ref.constraint.minor).toBe(c.expected.minor);
        expect(result.ref.constraint.patch).toBe(c.expected.patch);
        expect(result.ref.constraint.prerelease ?? null).toBe(c.expected.prerelease);
      }
    });
  }
});
