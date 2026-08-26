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
 * Semver RESOLUTION-ranking parity corpus runner (TypeScript side) (#246).
 *
 * Loads ``contracts/registry-resolution/resolution-cases.json`` and asserts
 * ``selectHighest`` picks the golden winner for each (candidates, constraint).
 * The companion runner ``agent/tests/test_registry_resolution_ranking_corpus.py``
 * runs the same file against the Python ``select_highest``. Ranking happens in
 * BOTH languages (TS handler for the API, Python for the orchestrator's direct
 * port), so a drift in caret/tilde/prerelease semantics would silently resolve
 * different versions on the two paths — this corpus fails CI before that ships.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseConstraint } from '../../../src/handlers/shared/registry/ref';
import { selectHighest } from '../../../src/handlers/shared/registry/resolver';

const CASES_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'registry-resolution',
  'resolution-cases.json',
);

interface Case {
  name: string;
  constraint: string;
  candidates: string[];
  winner: string | null;
}

const corpus = JSON.parse(fs.readFileSync(CASES_FILE, 'utf-8')) as { cases: Case[] };

describe('registry semver resolution-ranking parity corpus (TS selectHighest)', () => {
  test('corpus is present and non-empty', () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  for (const c of corpus.cases) {
    test(c.name, () => {
      const constraint = parseConstraint(c.constraint);
      expect(constraint).not.toBeNull();
      const winner = selectHighest(c.candidates, constraint!);
      expect(winner).toBe(c.winner);
    });
  }
});
