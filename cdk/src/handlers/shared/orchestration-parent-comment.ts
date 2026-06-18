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
 * Pure logic for routing an ``@bgagent`` comment left on the PARENT epic to the
 * sub-issue it's about (#247 UX.18).
 *
 * Background: the maturing epic panel lives on the parent epic, so a reviewer's
 * natural instinct is to comment there ("@bgagent for the footer, change X").
 * But the parent epic has no PR of its own — only its sub-issues do — so the
 * comment-trigger path can't iterate "the parent". Previously such a comment
 * fell through to the standalone path, found no task for the parent issue, and
 * was SILENTLY DROPPED (live-caught on ABCA-304). This module decides, from the
 * instruction text + the orchestration's sub-issue rows, WHICH sub-issue the
 * comment targets so the processor can iterate that sub-issue's PR.
 *
 * Pure (no I/O) so the matching is unit-tested in isolation; the processor does
 * the Linear/DDB work (resolve PR, spawn the iteration task, ack).
 */

import { isIntegrationNode } from './orchestration-integration-node';

/** Minimal view of a sub-issue row this matcher needs. */
export interface ParentCommentNode {
  readonly sub_issue_id: string;
  readonly linear_identifier?: string;
  readonly title?: string;
  /** Only a STARTED child (has a task) can be iterated; the matcher reports it but the caller gates on a PR. */
  readonly child_task_id?: string;
}

export interface ParentNodeMatch {
  /** Sub-issues the instruction plausibly targets (excludes the synthetic integration node unless named). */
  readonly matches: readonly ParentCommentNode[];
  /**
   * Why the caller can't act on exactly one node:
   *  - 'none'      — no node referenced (generic comment like "@bgagent looks good")
   *  - 'ambiguous' — the text matched more than one node
   *  - null        — exactly one match (caller iterates it)
   */
  readonly reason: 'none' | 'ambiguous' | null;
}

/** Lowercase, collapse whitespace, strip punctuation that breaks word matching. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Title "noise" words that carry no routing signal — matching on them would
 * make every comment hit every node. We only match a node by its title when a
 * SIGNIFICANT (non-noise) word from the title appears in the instruction.
 */
const TITLE_NOISE = new Set([
  'add', 'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'with', 'new',
  'page', 'section', 'site', 'wide', 'site-wide', 'update', 'change', 'fix',
  'create', 'make', 'support', 'feature', 'this', 'that', 'can', 'you', 'please',
]);

/**
 * Decide which sub-issue(s) an ``@bgagent`` instruction left on the parent epic
 * is about.
 *
 * Matching, in priority order:
 *  1. Linear identifier token (``ABCA-305``) — exact, case-insensitive. The
 *     unambiguous way to target a node; if present it wins outright (a single
 *     identifier → single match, even if a keyword also matched another node).
 *  2. Significant title keyword — a non-noise word from a node's title that
 *     appears in the instruction (``footer`` → "Add a site-wide footer"). All
 *     nodes whose title contributes a matched keyword are collected.
 *
 * The synthetic integration node is excluded from keyword matching (its title
 * "Integration — combine sub-issue results" is generic) but CAN be targeted by
 * the words "integration"/"combined" or its (nonexistent) identifier — callers
 * rarely iterate it, so it only matches on an explicit "integration" mention.
 *
 * Returns ``reason: null`` only when exactly one node matched.
 */
export function parseParentNodeReference(
  instruction: string,
  nodes: readonly ParentCommentNode[],
): ParentNodeMatch {
  const text = normalize(instruction);
  if (!text) return { matches: [], reason: 'none' };
  const tokens = new Set(text.split(' '));

  // 1) Identifier match wins outright.
  const byIdentifier = nodes.filter(
    (n) => n.linear_identifier && tokens.has(n.linear_identifier.toLowerCase()),
  );
  if (byIdentifier.length === 1) return { matches: byIdentifier, reason: null };
  if (byIdentifier.length > 1) return { matches: byIdentifier, reason: 'ambiguous' };

  // 2) Significant-title-keyword match.
  const byKeyword = nodes.filter((n) => {
    if (!n.title) return false;
    const explicitIntegration = isIntegrationNode(n.sub_issue_id)
      && (tokens.has('integration') || tokens.has('combined'));
    if (isIntegrationNode(n.sub_issue_id) && !explicitIntegration) return false;
    const significant = normalize(n.title)
      .split(' ')
      .filter((w) => w.length > 2 && !TITLE_NOISE.has(w));
    return significant.some((w) => tokens.has(w));
  });

  if (byKeyword.length === 1) return { matches: byKeyword, reason: null };
  if (byKeyword.length > 1) return { matches: byKeyword, reason: 'ambiguous' };
  return { matches: [], reason: 'none' };
}

/**
 * Best-effort "did you mean …?" suggestion for the disambiguation reply, used
 * ONLY when {@link parseParentNodeReference} found no confident match. We never
 * ACT on this (no silent iteration of a guess) — it's a hint in the reply so
 * the human can confirm with one tap. Scores each real node by how many of its
 * significant title words appear in the instruction; returns the single best
 * scorer, or null when nothing overlaps at all. The synthetic integration node
 * is never suggested.
 */
export function suggestClosestNode(
  instruction: string,
  nodes: readonly ParentCommentNode[],
): ParentCommentNode | null {
  const tokens = new Set(normalize(instruction).split(' ').filter(Boolean));
  if (tokens.size === 0) return null;
  let best: ParentCommentNode | null = null;
  let bestScore = 0;
  for (const n of nodes) {
    if (isIntegrationNode(n.sub_issue_id) || !n.title) continue;
    const significant = normalize(n.title)
      .split(' ')
      .filter((w) => w.length > 2 && !TITLE_NOISE.has(w));
    const score = significant.filter((w) => tokens.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return bestScore > 0 ? best : null;
}

function nodeLabel(n: ParentCommentNode): string {
  if (n.linear_identifier) return n.title ? `${n.linear_identifier} — ${n.title}` : n.linear_identifier;
  return n.title ?? n.sub_issue_id;
}

/**
 * Render the "which sub-issue?" threaded reply posted on the parent epic when
 * {@link parseParentNodeReference} can't pin exactly one node. NEVER auto-acts
 * and NEVER auto-creates an issue (user's call, #247 UX.18): it (a) surfaces a
 * best-effort "did you mean <X>?" suggestion when one overlaps, (b) lists the
 * real sub-issues + how to target one, and (c) points at the "create a
 * sub-issue for NEW work" path. So a parent comment is never silently dropped,
 * but new work only ever begins when the human explicitly creates a sub-issue.
 * Pure (string only).
 *
 * @param suggestion best-effort closest node (from {@link suggestClosestNode}), or null
 */
export function renderParentDisambiguationReply(
  reason: 'none' | 'ambiguous',
  nodes: readonly ParentCommentNode[],
  suggestion?: ParentCommentNode | null,
): string {
  const real = nodes.filter((n) => !isIntegrationNode(n.sub_issue_id));
  const lead = reason === 'ambiguous'
    ? "That could apply to more than one sub-issue, so I didn't want to guess."
    : "I couldn't tell which sub-issue that's about.";
  const out: string[] = [`👋 ${lead}`, ''];
  if (suggestion) {
    out.push(
      `Did you mean **${nodeLabel(suggestion)}**? If so, reply ` +
        `\`@bgagent ${suggestion.linear_identifier ?? 'that one'}: <what to change>\`.`,
      '',
    );
  }
  out.push(
    'Otherwise, comment on the specific sub-issue, or name it here — e.g. ' +
      '`@bgagent ABCA-123: <what to change>`. The sub-issues are:',
    '',
    ...real.map((n) => `- ${nodeLabel(n)}`),
    '',
    "If it's **new work** (not a change to one of these), create a new sub-issue " +
      'under this epic and add the `abca` label — I\'ll fold it into the orchestration.',
  );
  return out.join('\n');
}
