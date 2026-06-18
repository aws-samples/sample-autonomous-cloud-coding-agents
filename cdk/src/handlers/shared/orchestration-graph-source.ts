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
 * Trigger-agnostic orchestration graph source (#247 / #299 seam).
 *
 * The #247 executor (validate → seed → reconcile → release → stack →
 * rollup → parent lifecycle) is source-agnostic: once a DAG of
 * ``{ id, depends_on, title? }`` nodes exists it doesn't care where the
 * graph came from. What VARIES per trigger is only how the graph is
 * *produced*. This module is that seam.
 *
 * "Sub-issues" is just one way to express a DAG. Three adapter tiers:
 *
 *  1. NATIVE graph — the tool already has the structure; the adapter
 *     READS it. Linear: parent → children + ``blocks`` relations
 *     ({@link linearGraphSource}, wrapping ``fetchSubIssueGraph``). A Jira
 *     adapter would map epic → stories + issue links the same way.
 *
 *  2. DECLARATIVE graph — the trigger has no native sub-issues, so the
 *     caller SUPPLIES the DAG. {@link declarativeGraphSource} takes a
 *     ready-made node list. This is the slot for:
 *       - CLI / API: a request body carrying tasks + ``depends_on`` edges.
 *       - #299 Mode B: a planner agent decomposes ONE task into a phased
 *         DAG and hands the nodes here — reusing the ENTIRE verified
 *         executor instead of reimplementing gating/stacking/rollup.
 *
 *  3. DELEGATE / single — a structureless trigger (e.g. a plain Slack
 *     message) either stays single-task or references a native epic by id
 *     (tier 1). No adapter needed here.
 *
 * A source is a zero-arg async thunk so the caller binds whatever inputs
 * it needs (token + issue id for Linear; a node list for declarative)
 * before handing ``discoverOrchestration`` a uniform interface.
 */

import { fetchSubIssueGraph, type FetchSubIssueGraphOptions, type SubIssueNode } from './linear-subissue-fetch';

/**
 * Channel-neutral graph result. Mirrors ``FetchSubIssueGraphResult`` but
 * without Linear's ``parentIssueId`` — the discovery composer already
 * holds the parent id separately.
 *  - ``ok``           — a non-empty DAG to validate + seed.
 *  - ``no_children``  — no graph; caller falls through to a single task.
 *  - ``error``        — transient failure; caller surfaces retryable, does
 *    NOT silently degrade to a single task (that would drop the structure).
 */
export type OrchestrationGraphResult =
  | { readonly kind: 'ok'; readonly children: readonly SubIssueNode[] }
  | { readonly kind: 'no_children' }
  | { readonly kind: 'error'; readonly message: string };

/** A bound, zero-arg producer of an orchestration DAG. */
export type OrchestrationGraphSource = () => Promise<OrchestrationGraphResult>;

/**
 * Tier 1 — Linear native graph. Reads the parent issue's sub-issues +
 * blocking relations via the existing ``fetchSubIssueGraph`` and maps the
 * result to the channel-neutral shape.
 */
export function linearGraphSource(
  accessToken: string,
  parentIssueId: string,
  fetchOptions?: FetchSubIssueGraphOptions,
): OrchestrationGraphSource {
  return async () => {
    const fetched = await fetchSubIssueGraph(accessToken, parentIssueId, fetchOptions);
    if (fetched.kind === 'error') return { kind: 'error', message: fetched.message };
    if (fetched.kind === 'no_children') return { kind: 'no_children' };
    return { kind: 'ok', children: fetched.children };
  };
}

/**
 * Tier 2 — declarative graph. The caller already has the node list (a
 * CLI/API request, or a #299 planner's decomposition output). An empty
 * list means "no graph" → single task. Never errors (the nodes are
 * in-memory); DAG validity (cycles/dangling/dupes) is still enforced
 * downstream by ``validateDag`` in the discovery composer.
 */
export function declarativeGraphSource(children: readonly SubIssueNode[]): OrchestrationGraphSource {
  return async () => {
    if (children.length === 0) return { kind: 'no_children' };
    return { kind: 'ok', children };
  };
}
