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

// Strict `registry://` reference grammar for the agent asset registry (#246).
//
//   registry://<kind>/<namespace>/<name>@<constraint>
//     kind       = [a-z][a-z0-9_]*            snake_case: mcp_server, cedar_policy_module
//     namespace  = [a-z][a-z0-9-]*
//     name       = [a-z0-9][a-z0-9._-]*
//     constraint = [^~]?MAJOR.MINOR.PATCH[-prerelease]   exact / caret / tilde only
//
// The `@<constraint>` pin is MANDATORY (fail-closed: no implicit "latest").
// This grammar is mirrored byte-for-byte by `parse_ref` in
// agent/src/registry/ref.py and exercised by the contracts/registry-resolution/
// parity corpus. Keep the two in lockstep.

/** MVP asset kinds the registry loads end-to-end or stages. */
export const REGISTRY_KINDS = [
  'mcp_server',
  'cedar_policy_module',
  'skill',
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/** Reserved kinds accepted by the grammar but rejected at publish (no loader yet). */
export const RESERVED_KINDS = ['plugin', 'subagent', 'prompt_fragment', 'capability'] as const;

export type ConstraintOp = 'exact' | 'caret' | 'tilde';

export interface ParsedConstraint {
  readonly op: ConstraintOp;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease tag without the leading `-`, or undefined. */
  readonly prerelease?: string;
  /** The constraint exactly as written (e.g. `^1.4.1`). */
  readonly raw: string;
}

export interface ParsedRef {
  readonly kind: string;
  readonly namespace: string;
  readonly name: string;
  readonly constraint: ParsedConstraint;
}

export type RefErrorReason = 'INVALID_REGISTRY_REF' | 'INVALID_CONSTRAINT';

export type ParseResult =
  | { readonly ok: true; readonly ref: ParsedRef }
  | { readonly ok: false; readonly reason: RefErrorReason; readonly message: string };

// Structural split — validates the scheme + 3 path segments and captures the
// (mandatory) constraint. Segment character classes are validated separately so
// we can distinguish a bad ref shape from a bad constraint.
const REF_SHAPE =
  /^registry:\/\/([a-z][a-z0-9_]*)\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)@(.+)$/;

// exact / caret / tilde over MAJOR.MINOR.PATCH with an optional prerelease.
// Rejects `*`, `latest`, `>=`, `<=`, x-ranges, and bare prerelease modifiers.
const CONSTRAINT =
  /^([\^~]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

const OP_BY_PREFIX: Record<string, ConstraintOp> = { '': 'exact', '^': 'caret', '~': 'tilde' };

/** Parse + validate a constraint string in isolation (exported for the resolver). */
export function parseConstraint(raw: string): ParsedConstraint | null {
  const m = CONSTRAINT.exec(raw);
  if (!m) return null;
  const major = Number(m[2]);
  const minor = Number(m[3]);
  const patch = Number(m[4]);
  // Reject components beyond MAX_SAFE_INTEGER: `Number()` rounds them, so TS
  // would silently compare a different value than Python's arbitrary-precision
  // int — a cross-language parity break in version selection (#246 review).
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return {
    op: OP_BY_PREFIX[m[1]],
    major,
    minor,
    patch,
    prerelease: m[5],
    raw,
  };
}

/**
 * Parse a strict `registry://kind/namespace/name@constraint` reference.
 * A ref with no `@constraint`, or a floating constraint (`*`, `latest`, `>=`…),
 * is rejected — pins are mandatory.
 */
export function parseRef(ref: string): ParseResult {
  const shape = REF_SHAPE.exec(ref);
  if (!shape) {
    return {
      ok: false,
      reason: 'INVALID_REGISTRY_REF',
      message: `not a valid registry ref (expected registry://kind/namespace/name@constraint): ${ref}`,
    };
  }
  const [, kind, namespace, name, rawConstraint] = shape;
  const constraint = parseConstraint(rawConstraint);
  if (!constraint) {
    return {
      ok: false,
      reason: 'INVALID_CONSTRAINT',
      message: `unsupported version constraint '${rawConstraint}' (use exact, ^, or ~)`,
    };
  }
  return { ok: true, ref: { kind, namespace, name, constraint } };
}
