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

import { INITIAL_APPROVALS_MAX_ENTRY_LENGTH, type ApprovalScope } from './types';

const LITERAL_SCOPES = new Set<string>([
  'this_call',
  'all_session',
  'tool_type_session',
  'tool_group_session',
]);

export const VALID_APPROVAL_SCOPE_PREFIXES: readonly string[] = [
  'tool_type:',
  'tool_group:',
  'bash_pattern:',
  'write_path:',
  'rule:',
];

export const VALID_TOOL_TYPES: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'Task',
];

export const VALID_TOOL_GROUPS: readonly string[] = ['file_write'];

type ParseResult =
  | { ok: true; scope: ApprovalScope }
  | { ok: false; message: string };

/**
 * Validate and return `scope` when it is a well-formed `ApprovalScope`.
 * @param scope - the raw string.
 * @returns a parse result with the typed scope on success.
 */
export function parseApprovalScope(scope: string): ParseResult {
  if (typeof scope !== 'string') {
    return { ok: false, message: 'must be a string' };
  }
  const trimmed = scope.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'must be non-empty' };
  }
  if (trimmed.length > INITIAL_APPROVALS_MAX_ENTRY_LENGTH) {
    return {
      ok: false,
      message: `exceeds ${INITIAL_APPROVALS_MAX_ENTRY_LENGTH}-char cap`,
    };
  }

  if (LITERAL_SCOPES.has(trimmed)) {
    return { ok: true, scope: trimmed as ApprovalScope };
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx < 0) {
    return { ok: false, message: 'missing prefix' };
  }
  const prefix = trimmed.slice(0, colonIdx + 1);
  const value = trimmed.slice(colonIdx + 1).trim();
  if (value.length === 0) {
    return { ok: false, message: `prefix ${prefix} missing value` };
  }
  if (!VALID_APPROVAL_SCOPE_PREFIXES.includes(prefix)) {
    return { ok: false, message: `unknown prefix ${prefix}` };
  }
  if (prefix === 'tool_type:' && !VALID_TOOL_TYPES.includes(value)) {
    return {
      ok: false,
      message: `unknown tool_type ${value}; valid: ${VALID_TOOL_TYPES.join(', ')}`,
    };
  }
  if (prefix === 'tool_group:' && !VALID_TOOL_GROUPS.includes(value)) {
    return {
      ok: false,
      message: `unknown tool_group ${value}; valid: ${VALID_TOOL_GROUPS.join(', ')}`,
    };
  }
  return { ok: true, scope: `${prefix}${value}` as ApprovalScope };
}

const DEGENERATE_WILDCARD_RATIO_THRESHOLD = 0.5;

/**
 * True when a pattern is degenerate: at most 2 chars, only `*`, `?` and
 * whitespace, or more than 50% wildcards.
 */
export function isDegeneratePattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length <= 2) return true;
  if (/^[\s*?]+$/.test(trimmed)) return true;
  const wildcardChars = (trimmed.match(/[*?]/g) ?? []).length;
  const literalChars = trimmed.length - wildcardChars;
  if (literalChars === 0) return true;
  return wildcardChars / trimmed.length > DEGENERATE_WILDCARD_RATIO_THRESHOLD;
}
