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

import type { SubIssueNode } from './linear-subissue-fetch';

/**
 * Suffix marking a synthetic, platform-injected node (not a real Linear
 * sub-issue).
 */
export const INTEGRATION_NODE_SUFFIX = '__integration';

/**
 * True if ``subIssueId`` is a platform-synthesized integration node rather
 * than a real Linear sub-issue.
 */
export function isIntegrationNode(subIssueId: string): boolean {
  return subIssueId.endsWith(INTEGRATION_NODE_SUFFIX);
}

/** Node ids that no other node depends on — the DAG's leaves. */
export function computeLeaves(nodes: readonly SubIssueNode[]): readonly string[] {
  const hasSuccessor = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.depends_on) hasSuccessor.add(dep);
  }
  return nodes.map((n) => n.id).filter((id) => !hasSuccessor.has(id));
}

/**
 * Given a validated DAG, return the node list to seed: unchanged when there
 * is 0–1 leaf, or with a synthetic integration node appended (depending on
 * all leaves) when there is more than one leaf.
 *
 * ``orchestrationId`` namespaces the synthetic node's id
 * (``<orchestrationId>__integration``). The node carries no
 * ``identifier`` (there is no Linear issue) and a fixed ``title``.
 */
export function withIntegrationNode(
  nodes: readonly SubIssueNode[],
  orchestrationId: string,
): { readonly nodes: readonly SubIssueNode[]; readonly added: boolean } {
  const leaves = computeLeaves(nodes);
  if (leaves.length <= 1) {
    return { nodes, added: false };
  }
  const integration: SubIssueNode = {
    id: `${orchestrationId}${INTEGRATION_NODE_SUFFIX}`,
    depends_on: leaves,
    title: 'Integration — combine sub-issue results',
  };
  return { nodes: [...nodes, integration], added: true };
}
