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
 * Validator for `ApprovalScope` strings (design §6.4, §7.3).
 *
 * Shared between `approve-task`, `create-task`, and (Chunk 6) the CLI
 * so the same rules apply on both ends of the wire. Enforces:
 *
 *   - The scope string is a known literal (`this_call`, `all_session`,
 *     `tool_type_session`, `tool_group_session`) OR has a known
 *     prefix (`tool_type:`, `tool_group:`, `bash_pattern:`,
 *     `write_path:`, `rule:`).
 *   - Value after the prefix is non-empty (§7.3 step 3).
 *   - Total length ≤ `INITIAL_APPROVALS_MAX_ENTRY_LENGTH` — keeps DDB
 *     rows small and avoids the Cedar `like`-expansion explosion.
 *   - Tool-type and tool-group values are from the known sets.
 *
 * Degenerate pattern detection (§7.4) is applied at submit time in
 * `create-task` rather than here, because degenerate-ness depends on
 * the `initial_approvals` context — `bash_pattern:*` is degenerate
 * when the user supplied it for broad permission, but NOT when the
 * pattern happens to be a single-char rule the allowlist is asked to
 * match. Keeping the check scoped to submit time avoids double-enforcement
 * confusion.
 */
import { INITIAL_APPROVALS_MAX_ENTRY_LENGTH, type ApprovalScope } from './types';

/** Known no-payload scopes. */
const LITERAL_SCOPES = new Set<string>([
  'this_call',
  'all_session',
  'tool_type_session',
  'tool_group_session',
]);

/** Known scope prefixes. Exposed for error messages. */
export const VALID_APPROVAL_SCOPE_PREFIXES: readonly string[] = [
  'tool_type:',
  'tool_group:',
  'bash_pattern:',
  'write_path:',
  'rule:',
];

/**
 * Canonical set of tool names acceptable after `tool_type:`. Mirror of
 * the agent-side `ApprovalAllowlist._tool_types` set; out-of-band
 * tool names are rejected at submit time so the user sees a loud
 * error instead of a silently-never-matching scope.
 */
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

/** Canonical tool groups. Mirror of `TOOL_GROUPS` in `agent/src/policy.py`. */
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
  // `bash_pattern:`, `write_path:`, `rule:` — value format is free;
  // rule existence check happens at submit time against the blueprint.
  return { ok: true, scope: `${prefix}${value}` as ApprovalScope };
}

/**
 * Degenerate-pattern detection per §7.4.
 *
 * A pattern is degenerate if it is:
 * - ≤ 2 chars total, OR
 * - consists only of `*`, `?`, whitespace, OR
 * - wildcard-to-literal ratio exceeds 50%.
 *
 * Used by `create-task` on `bash_pattern:` / `write_path:` scopes at
 * submit time; runtime allowlist evaluation does not re-check.
 */
export function isDegeneratePattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length <= 2) return true;
  if (/^[\s*?]+$/.test(trimmed)) return true;
  const wildcardChars = (trimmed.match(/[*?]/g) ?? []).length;
  const literalChars = trimmed.length - wildcardChars;
  if (literalChars === 0) return true;
  return wildcardChars / trimmed.length > 0.5;
}
