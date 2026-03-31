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

import { computePromptVersion } from '../../../src/handlers/shared/prompt-version';

describe('computePromptVersion', () => {
  test('returns a 12-character hex string', () => {
    const version = computePromptVersion('Hello world');
    expect(version).toHaveLength(12);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });

  test('is deterministic — same input produces same output', () => {
    const template = 'You are a coding agent. Work autonomously.';
    const v1 = computePromptVersion(template);
    const v2 = computePromptVersion(template);
    expect(v1).toBe(v2);
  });

  test('different templates produce different versions', () => {
    const v1 = computePromptVersion('Template A');
    const v2 = computePromptVersion('Template B');
    expect(v1).not.toBe(v2);
  });

  test('includes overrides in the hash', () => {
    const template = 'Base template';
    const v1 = computePromptVersion(template);
    const v2 = computePromptVersion(template, { extra: 'instructions' });
    expect(v1).not.toBe(v2);
  });

  test('override key order does not affect the hash', () => {
    const template = 'Base template';
    const v1 = computePromptVersion(template, { a: '1', b: '2' });
    const v2 = computePromptVersion(template, { b: '2', a: '1' });
    expect(v1).toBe(v2);
  });

  test('empty overrides produce same hash as no overrides', () => {
    const template = 'Base template';
    const v1 = computePromptVersion(template);
    const v2 = computePromptVersion(template, {});
    expect(v1).toBe(v2);
  });
});
