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

import { describe, expect, it } from 'vitest';
import { isCutOff, parseToolInput, previewField } from '../../../src/core/util/tool-input';

/** What the agent stores: the repr cut to 200 characters, plus "...". */
const cut = (repr: string) => `${repr.slice(0, 200)}...`;

describe('parseToolInput', () => {
  it('reads every argument, decoding Python escapes', () => {
    const input = parseToolInput(`{'command': "cat > a.sh <<'EOF'\\necho \\"hi\\"\\tok\\\\nEOF", 'timeout': 120000, 'run_in_background': False}`);
    expect(input).toEqual({
      fields: { command: `cat > a.sh <<'EOF'\necho "hi"\tok\\nEOF`, timeout: '120000', run_in_background: 'False' },
      cutOff: false,
      cutOffField: null,
    });
  });

  it('keeps the part of a value the agent cut, and says which one', () => {
    const repr = `{'command': '${'x'.repeat(250)}', 'description': 'never reached'}`;
    const input = parseToolInput(cut(repr));
    expect(input.cutOff).toBe(true);
    expect(input.cutOffField).toBe('command');
    expect(input.fields.command).toBe('x'.repeat(200 - "{'command': '".length));
    expect(input.fields.description).toBeUndefined();
  });

  it('decodes \\x and \\u escapes and keeps unknown ones as written', () => {
    expect(parseToolInput(`{'a': 'caf\\xe9 \\u2713 \\q'}`).fields.a).toBe('café ✓ \\q');
  });

  it('reads list and dict values whole', () => {
    expect(parseToolInput(`{'paths': ['a, b', 'c'], 'opts': {'x': 1}, 'n': 2}`).fields)
      .toEqual({ paths: "['a, b', 'c']", opts: "{'x': 1}", n: '2' });
  });

  it('gives no fields for anything that is not a dict, without throwing', () => {
    expect(parseToolInput(null)).toEqual({ fields: {}, cutOff: false, cutOffField: null });
    expect(parseToolInput('plain text').fields).toEqual({});
    expect(parseToolInput(`{'broken`).fields).toEqual({});
    expect(parseToolInput(`{'a' 'b'}`).fields).toEqual({});
  });

  it('only treats long previews ending in "..." as cut', () => {
    expect(isCutOff('wait...')).toBe(false);
    expect(isCutOff(cut('y'.repeat(300)))).toBe(true);
  });
});

describe('previewField', () => {
  const repr = cut(`{'command': 'ls -a && find . -name CODEOWNERS', 'description': '${'d'.repeat(300)}'}`);

  it('leaves out a value the cut landed in, unless a partial value is wanted', () => {
    expect(previewField(repr, 'command')).toBe('ls -a && find . -name CODEOWNERS');
    expect(previewField(repr, 'description')).toBeNull();
    expect(previewField(repr, 'description', { partial: true })).toMatch(/^d+$/);
  });

  it('treats a missing or blank argument as absent', () => {
    expect(previewField(`{'command': ' '}`, 'command')).toBeNull();
    expect(previewField(`{'command': 'ls'}`, 'description')).toBeNull();
  });
});
