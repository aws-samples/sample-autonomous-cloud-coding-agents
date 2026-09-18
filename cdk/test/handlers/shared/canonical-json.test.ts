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

import { canonicalJson } from '../../../src/handlers/shared/canonical-json';

test('preserves the existing receipt byte format across nested key insertion orders', () => {
  const expected = '{"a":[{"b":2,"z":1},3],"z":null}';
  expect(canonicalJson({ z: null, a: [{ z: 1, b: 2 }, 3] })).toBe(expected);
  expect(canonicalJson({ a: [{ b: 2, z: 1 }, 3], z: null })).toBe(expected);
});

test('keeps array order and distinct primitive values significant', () => {
  expect(canonicalJson([1, '1', false, null])).toBe('[1,"1",false,null]');
  expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
});
