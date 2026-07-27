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

import { parseConstraint } from '../../../src/handlers/shared/registry/ref';
import {
  compareVersions,
  parseVersion,
  satisfies,
  selectHighest,
} from '../../../src/handlers/shared/registry/resolver';

const C = (s: string) => parseConstraint(s)!;
const V = (s: string) => parseVersion(s)!;

describe('registry resolver — parseVersion', () => {
  test('parses core + prerelease', () => {
    expect(parseVersion('1.4.1')).toMatchObject({ major: 1, minor: 4, patch: 1, prerelease: [] });
    expect(parseVersion('2.0.0-rc.1')).toMatchObject({ major: 2, minor: 0, patch: 0, prerelease: ['rc', '1'] });
  });
  test('rejects non-semver + leading zeros', () => {
    expect(parseVersion('1.4')).toBeNull();
    expect(parseVersion('01.0.0')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('registry resolver — compareVersions', () => {
  test('orders by core then prerelease', () => {
    expect(compareVersions(V('1.0.0'), V('2.0.0'))).toBeLessThan(0);
    expect(compareVersions(V('1.2.0'), V('1.1.9'))).toBeGreaterThan(0);
    expect(compareVersions(V('1.0.0'), V('1.0.0'))).toBe(0);
  });
  test('prerelease ranks below its release', () => {
    expect(compareVersions(V('1.4.1-rc.1'), V('1.4.1'))).toBeLessThan(0);
    expect(compareVersions(V('1.4.1-rc.1'), V('1.4.1-rc.2'))).toBeLessThan(0);
    expect(compareVersions(V('1.4.1-rc.2'), V('1.4.1-rc.10'))).toBeLessThan(0);
  });
});

describe('registry resolver — satisfies', () => {
  test('exact matches only the exact version incl. prerelease', () => {
    expect(satisfies(V('1.4.1'), C('1.4.1'))).toBe(true);
    expect(satisfies(V('1.4.2'), C('1.4.1'))).toBe(false);
    expect(satisfies(V('1.4.1'), C('1.4.1-rc.1'))).toBe(false);
    expect(satisfies(V('1.4.1-rc.1'), C('1.4.1-rc.1'))).toBe(true);
  });
  test('caret stays within the major', () => {
    expect(satisfies(V('1.9.9'), C('^1.4.1'))).toBe(true);
    expect(satisfies(V('1.4.0'), C('^1.4.1'))).toBe(false);
    expect(satisfies(V('2.0.0'), C('^1.4.1'))).toBe(false);
  });
  test('caret ^0.x stays within the minor', () => {
    expect(satisfies(V('0.2.9'), C('^0.2.0'))).toBe(true);
    expect(satisfies(V('0.3.0'), C('^0.2.0'))).toBe(false);
  });
  test('tilde stays within the minor', () => {
    expect(satisfies(V('1.4.9'), C('~1.4.1'))).toBe(true);
    expect(satisfies(V('1.5.0'), C('~1.4.1'))).toBe(false);
  });
  test('prereleases excluded from range matches', () => {
    expect(satisfies(V('1.5.0-rc.1'), C('^1.4.1'))).toBe(false);
  });
});

describe('registry resolver — selectHighest', () => {
  test('picks the highest in-range version', () => {
    expect(selectHighest(['1.4.1', '1.5.0', '1.9.9', '2.0.0'], C('^1.4.1'))).toBe('1.9.9');
    expect(selectHighest(['1.4.1', '1.4.9', '1.5.0'], C('~1.4.1'))).toBe('1.4.9');
  });
  test('returns null when nothing matches', () => {
    expect(selectHighest(['2.0.0', '3.0.0'], C('^1.0.0'))).toBeNull();
    expect(selectHighest([], C('1.0.0'))).toBeNull();
  });
  test('skips unparseable candidate strings', () => {
    expect(selectHighest(['garbage', '1.0.0', 'also-bad'], C('^1.0.0'))).toBe('1.0.0');
  });
});
