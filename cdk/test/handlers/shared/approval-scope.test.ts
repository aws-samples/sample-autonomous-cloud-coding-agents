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

import {
  isDegeneratePattern,
  parseApprovalScope,
  VALID_APPROVAL_SCOPE_PREFIXES,
  VALID_TOOL_GROUPS,
  VALID_TOOL_TYPES,
} from '../../../src/handlers/shared/approval-scope';

describe('parseApprovalScope — literal scopes', () => {
  test.each(['this_call', 'all_session', 'tool_type_session', 'tool_group_session'])(
    'accepts %s',
    (input) => {
      const r = parseApprovalScope(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.scope).toBe(input);
    },
  );

  test('trims surrounding whitespace', () => {
    const r = parseApprovalScope('  this_call  ');
    expect(r.ok).toBe(true);
  });

  test('rejects empty string', () => {
    const r = parseApprovalScope('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/non-empty/);
  });
});

describe('parseApprovalScope — prefixed scopes', () => {
  test('accepts tool_type:Read', () => {
    const r = parseApprovalScope('tool_type:Read');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toBe('tool_type:Read');
  });

  test('rejects unknown tool_type', () => {
    const r = parseApprovalScope('tool_type:Ugh');
    expect(r.ok).toBe(false);
  });

  test('accepts tool_group:file_write', () => {
    const r = parseApprovalScope('tool_group:file_write');
    expect(r.ok).toBe(true);
  });

  test('rejects unknown tool_group', () => {
    const r = parseApprovalScope('tool_group:unknown_group');
    expect(r.ok).toBe(false);
  });

  test('accepts bash_pattern:git status*', () => {
    const r = parseApprovalScope('bash_pattern:git status*');
    expect(r.ok).toBe(true);
  });

  test('accepts write_path:docs/**', () => {
    const r = parseApprovalScope('write_path:docs/**');
    expect(r.ok).toBe(true);
  });

  test('accepts rule:force_push_any', () => {
    const r = parseApprovalScope('rule:force_push_any');
    expect(r.ok).toBe(true);
  });

  test('rejects missing prefix', () => {
    const r = parseApprovalScope('bare_value');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/missing prefix/);
  });

  test('rejects prefix with empty value', () => {
    const r = parseApprovalScope('tool_type:');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/missing value/);
  });

  test('rejects unknown prefix', () => {
    const r = parseApprovalScope('weird_prefix:foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/unknown prefix/);
  });

  test('rejects over-long scope (> 128 chars)', () => {
    const r = parseApprovalScope('bash_pattern:' + 'a'.repeat(130));
    expect(r.ok).toBe(false);
  });

  test('exports known tool_type set', () => {
    expect(VALID_TOOL_TYPES).toContain('Bash');
    expect(VALID_TOOL_TYPES).toContain('Read');
  });

  test('exports known tool_group set', () => {
    expect(VALID_TOOL_GROUPS).toContain('file_write');
  });

  test('exports prefix list for error messages', () => {
    expect(VALID_APPROVAL_SCOPE_PREFIXES).toContain('rule:');
  });
});

describe('isDegeneratePattern', () => {
  test('star alone is degenerate', () => {
    expect(isDegeneratePattern('*')).toBe(true);
  });

  test('double-star alone is degenerate', () => {
    expect(isDegeneratePattern('**')).toBe(true);
  });

  test('question mark star is degenerate', () => {
    expect(isDegeneratePattern('?*')).toBe(true);
  });

  test('3+ literal chars with one wildcard is not degenerate', () => {
    expect(isDegeneratePattern('docs/**')).toBe(false);
    expect(isDegeneratePattern('git status*')).toBe(false);
  });

  test('wildcard ratio > 50% is degenerate', () => {
    // 3 wildcards in 5 chars (60%) → degenerate.
    expect(isDegeneratePattern('a**?b')).toBe(true);
    // 2 wildcards in 5 chars (40%) → not degenerate.
    expect(isDegeneratePattern('a*b*c')).toBe(false);
  });

  test('whitespace-only wildcards degenerate', () => {
    expect(isDegeneratePattern(' * ')).toBe(true);
  });

  test('short literal is degenerate (length ≤ 2)', () => {
    expect(isDegeneratePattern('ab')).toBe(true);
  });

  test('all wildcards with no literals is degenerate', () => {
    expect(isDegeneratePattern('***')).toBe(true);
    expect(isDegeneratePattern('???*')).toBe(true);
  });
});
