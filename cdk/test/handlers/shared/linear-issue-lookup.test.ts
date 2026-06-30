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

// `findLinearIssueByIdentifier` is covered by PR #275's broader test
// suite (mocks the registry scan + GraphQL); this file only locks in
// `extractLinearIdentifier` since it's a pure function and the g-flag
// regex's `lastIndex` reset behavior is easy to regress across releases.

import { extractLinearIdentifier } from '../../../src/handlers/shared/linear-issue-lookup';

describe('extractLinearIdentifier', () => {
  test('returns null for null / undefined / empty input', () => {
    expect(extractLinearIdentifier(null)).toBeNull();
    expect(extractLinearIdentifier(undefined)).toBeNull();
    expect(extractLinearIdentifier('')).toBeNull();
  });

  test('extracts a Linear identifier from PR title shape', () => {
    expect(extractLinearIdentifier('feat(linear): ABCA-42 do the thing'))
      .toBe('ABCA-42');
  });

  test('extracts a Linear identifier from PR body shape', () => {
    expect(extractLinearIdentifier('Closes ABCA-42\n\nSummary…')).toBe('ABCA-42');
  });

  test('returns the FIRST identifier when multiple are present', () => {
    expect(extractLinearIdentifier('ABCA-42 supersedes PLAT-9')).toBe('ABCA-42');
  });

  test('does not match lowercase team key prefixes', () => {
    expect(extractLinearIdentifier('see issue abca-42 for details')).toBeNull();
  });

  test('does not match identifiers without a dash', () => {
    expect(extractLinearIdentifier('ABCA42')).toBeNull();
  });

  test('does not match identifiers with too long a number tail', () => {
    // Bound is 1-8 digits in the regex; 9+ shouldn't be admitted.
    expect(extractLinearIdentifier('ABCA-1234567890')).toBeNull();
  });

  // The regex is g-flagged at module scope.
  // scope, which means `RegExp.prototype.exec` carries `lastIndex`
  // across calls. The implementation explicitly resets it; this test
  // pins the behavior so nobody removes the reset thinking it's dead.
  test('back-to-back calls do not skip due to leftover g-flag lastIndex', () => {
    // Run the same call twice — without the explicit reset, the second
    // call would start scanning from where the first call left off and
    // miss the leading identifier.
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
    expect(extractLinearIdentifier('ABCA-1 then ABCA-2')).toBe('ABCA-1');
  });

  test('back-to-back calls with different inputs each return their own first match', () => {
    expect(extractLinearIdentifier('first ABCA-1')).toBe('ABCA-1');
    expect(extractLinearIdentifier('second PLAT-9')).toBe('PLAT-9');
    expect(extractLinearIdentifier('third PLAT-9 ABCA-1')).toBe('PLAT-9');
    expect(extractLinearIdentifier(null)).toBeNull();
    expect(extractLinearIdentifier('fourth ABCA-1')).toBe('ABCA-1');
  });
});
