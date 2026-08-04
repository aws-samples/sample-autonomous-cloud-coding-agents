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
 * Trigger-label helpers.
 *
 * A project's ``label_filter`` (default ``bgagent``) names the Linear label that
 * starts a task. Kept pure — no I/O, no Linear or AWS types — so the label
 * decision is unit-testable on its own; the webhook processor does the I/O of
 * resolving the filter from the project mapping.
 */

/** Normalise a label name for comparison: trim + lower-case. */
function norm(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase();
}

/** The base trigger label when a project doesn't override ``label_filter``. */
export const DEFAULT_LABEL_FILTER = 'bgagent';

/**
 * Suffix (after ``:``) that requests the one-time explainer of what the trigger
 * labels do, and creates NO task.
 */
export const HELP_SUFFIX = 'help';

/** True when the ``<base>:help`` explainer label is present (any case). */
export function hasHelpLabel(
  labelNames: readonly (string | undefined | null)[],
  labelFilter: string = DEFAULT_LABEL_FILTER,
): boolean {
  const base = norm(labelFilter) || DEFAULT_LABEL_FILTER;
  const help = `${base}:${HELP_SUFFIX}`;
  return labelNames.some((n) => norm(n) === help);
}
