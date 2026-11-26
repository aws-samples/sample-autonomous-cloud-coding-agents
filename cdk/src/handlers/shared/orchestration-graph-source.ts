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
  fetchJiraSubIssueGraph,
  type FetchJiraSubIssueGraphOptions,
} from './jira-subissue-fetch';
import { fetchSubIssueGraph, type FetchSubIssueGraphOptions, type SubIssueNode } from './linear-subissue-fetch';

/**
 * Channel-neutral graph result.
 *  - ``ok``           — a non-empty DAG to validate + seed.
 *  - ``no_children``  — no graph; caller falls through to a single task.
 *  - ``error``        — transient failure; caller surfaces retryable, does
 *    NOT silently degrade to a single task (that would drop the structure).
 */
export type OrchestrationGraphResult =
  | { readonly kind: 'ok'; readonly children: readonly SubIssueNode[] }
  | { readonly kind: 'no_children' }
  | { readonly kind: 'error'; readonly message: string };

export type OrchestrationGraphSource = () => Promise<OrchestrationGraphResult>;

/** Linear native graph: the parent issue's sub-issues + blocking relations. */
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

/** Jira authored subtasks plus standard blocker links. */
export function jiraGraphSource(
  accessToken: string,
  cloudId: string,
  parentIssueKey: string,
  fetchOptions?: FetchJiraSubIssueGraphOptions,
): OrchestrationGraphSource {
  return async () => {
    const fetched = await fetchJiraSubIssueGraph(
      accessToken,
      cloudId,
      parentIssueKey,
      fetchOptions,
    );
    if (fetched.kind === 'error') return { kind: 'error', message: fetched.message };
    if (fetched.kind === 'no_children') return { kind: 'no_children' };
    return { kind: 'ok', children: fetched.children };
  };
}

/**
 * Declarative graph. The caller already has the node list (e.g. a
 * CLI/API request that carries its own edges). An empty list means "no graph" →
 * single task. Never errors; DAG validity (cycles/dangling/dupes) is not
 * checked here.
 */
export function declarativeGraphSource(children: readonly SubIssueNode[]): OrchestrationGraphSource {
  return async () => {
    if (children.length === 0) return { kind: 'no_children' };
    return { kind: 'ok', children };
  };
}
