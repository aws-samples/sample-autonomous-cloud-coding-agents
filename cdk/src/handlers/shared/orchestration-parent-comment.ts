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

import { KNOWN_EPIC_COMMANDS } from './orchestration-comment-trigger';
import { isIntegrationNode } from './orchestration-integration-node';
import { DEFAULT_LABEL_FILTER } from './trigger-label';

export interface ParentCommentNode {
  readonly sub_issue_id: string;
  /**
   * The human-facing id a commenter would type (``ENG-42``). Read through
   * {@link nodeDisplayId} rather than directly: persisted rows carry it under
   * either this neutral name or the older surface-specific one depending on when
   * they were written.
   */
  readonly display_id?: string;
  /** Legacy name for {@link display_id}, still present on rows written earlier. */
  readonly linear_identifier?: string;
  readonly title?: string;
  /**
   * Sub-issue description. NOT used for act-routing, but it IS scored for the
   * "did you mean …?" SUGGESTION.
   */
  readonly description?: string;
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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

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
 *  1. Linear identifier token (``ENG-42``) — exact, case-insensitive. If
 *     present it wins outright (a single identifier → single match, even if a
 *     keyword also matched another node).
 *  2. Significant title keyword — a non-noise word from a node's title that
 *     appears in the instruction (``footer`` → "Add a site-wide footer"). All
 *     nodes whose title contributes a matched keyword are collected.
 *
 * The synthetic integration node is excluded from title-keyword matching and
 * matches only on the words "integration"/"combined".
 *
 * Returns ``reason: null`` only when exactly one node matched.
 */
/**
 * The word that explicitly targets the synthetic integration node from a parent
 * comment.
 */
export const INTEGRATION_KEYWORD = 'integration';
const INTEGRATION_KEYWORD_ALT = 'combined';

export function parseParentNodeReference(
  instruction: string,
  nodes: readonly ParentCommentNode[],
): ParentNodeMatch {
  const text = normalize(instruction);
  if (!text) return { matches: [], reason: 'none' };
  const tokens = new Set(text.split(' '));

  const byIdentifier = nodes.filter((n) => {
    const id = nodeDisplayId(n);
    return id !== undefined && tokens.has(id.toLowerCase());
  });
  if (byIdentifier.length === 1) return { matches: byIdentifier, reason: null };
  if (byIdentifier.length > 1) return { matches: byIdentifier, reason: 'ambiguous' };

  const byKeyword = nodes.filter((n) => {
    if (isIntegrationNode(n.sub_issue_id)) {
      return tokens.has(INTEGRATION_KEYWORD) || tokens.has(INTEGRATION_KEYWORD_ALT);
    }
    if (!n.title) return false;
    const significant = normalize(n.title)
      .split(' ')
      .filter((w) => w.length > 2 && !TITLE_NOISE.has(w));
    return significant.some((w) => tokens.has(w));
  });

  if (byKeyword.length === 1) return { matches: byKeyword, reason: null };
  if (byKeyword.length > 1) return { matches: byKeyword, reason: 'ambiguous' };
  return { matches: [], reason: 'none' };
}

function significantWords(s: string | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    normalize(s).split(' ').filter((w) => w.length > 2 && !TITLE_NOISE.has(w)),
  );
}

/**
 * Best-effort "did you mean …?" suggestion for the disambiguation reply, used
 * ONLY when {@link parseParentNodeReference} found no confident match. We never
 * ACT on this (no silent iteration of a guess).
 *
 * Scores each real node by overlap with BOTH its title (weighted
 * heavily) and its description (weighted lightly). Returns the single best
 * scorer, or null when nothing overlaps at all. The synthetic integration node
 * is never suggested.
 */
export function suggestClosestNode(
  instruction: string,
  nodes: readonly ParentCommentNode[],
): ParentCommentNode | null {
  const tokens = new Set(normalize(instruction).split(' ').filter(Boolean));
  if (tokens.size === 0) return null;
  const TITLE_WEIGHT = 10;
  const DESC_WEIGHT = 1;
  let best: ParentCommentNode | null = null;
  let bestScore = 0;
  for (const n of nodes) {
    if (isIntegrationNode(n.sub_issue_id)) continue;
    const titleHits = [...significantWords(n.title)].filter((w) => tokens.has(w)).length;
    const descHits = [...significantWords(n.description)].filter((w) => tokens.has(w)).length;
    const score = titleHits * TITLE_WEIGHT + descHits * DESC_WEIGHT;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Heuristic: does the instruction look like a request for NEW work (add a thing
 * that isn't one of the existing sub-issues) rather than a change to an existing
 * one?
 *
 * Conservative — only fires when the instruction opens with an additive verb
 * (add / create / build / introduce / include / also add …). A change verb
 * ("change the footer", "make it bigger") is NOT new work.
 */
const NEW_WORK_VERBS = new Set(['add', 'create', 'build', 'introduce', 'include', 'implement']);
const NEW_WORK_LEAD_SCAN = 5;
export function looksLikeNewWork(instruction: string): boolean {
  const words = normalize(instruction).split(' ').filter(Boolean);
  const FILLER = new Set(['also', 'can', 'you', 'please', 'could', 'would', 'lets', 'let', 'us', 'we', 'i', 'd', 'like', 'to', 'now', 'maybe']);
  for (const w of words.slice(0, NEW_WORK_LEAD_SCAN)) {
    if (NEW_WORK_VERBS.has(w)) return true;
    if (!FILLER.has(w)) break;
  }
  return false;
}

/**
 * The node's human-facing id under either the neutral or the legacy attribute
 * name — the neutral name wins where a row carries both.
 */
export function nodeDisplayId(n: ParentCommentNode): string | undefined {
  return n.display_id ?? n.linear_identifier;
}

function integrationHint(nodes: readonly ParentCommentNode[]): string[] {
  const node = nodes.find((n) => isIntegrationNode(n.sub_issue_id));
  if (!node) return [];
  return [
    `- Integration — combined result; target with \`@bgagent ${INTEGRATION_KEYWORD}: <request>\``,
  ];
}

function nodeLabel(n: ParentCommentNode): string {
  const id = nodeDisplayId(n);
  if (id) return n.title ? `${id} — ${n.title}` : id;
  return n.title ?? n.sub_issue_id;
}

/**
 * Render the "which sub-issue?" threaded reply posted on the parent epic when
 * {@link parseParentNodeReference} can't pin exactly one node: it (a) surfaces a
 * best-effort "did you mean <X>?" suggestion when one overlaps, (b) lists the
 * real sub-issues + how to target one, and (c) points at the "create a
 * sub-issue for NEW work" path.
 *
 * @param suggestion best-effort closest node (from {@link suggestClosestNode}), or null
 * @param newWork    when the instruction looks like a request for NEW
 *                   work (see {@link looksLikeNewWork}), lead with the
 *                   create-a-sub-issue path instead of the generic "couldn't
 *                   tell".
 */
export function renderParentDisambiguationReply(
  reason: 'none' | 'ambiguous',
  nodes: readonly ParentCommentNode[],
  suggestion?: ParentCommentNode | null,
  newWork = false,
  /**
   * Whether the epic currently has failed/skipped children.
   * When true, the reply surfaces the ``retry`` command.
   */
  hasFailures = false,
  /** The label this project triggers on (set per project). */
  triggerLabel = DEFAULT_LABEL_FILTER,
): string {
  const real = nodes.filter((n) => !isIntegrationNode(n.sub_issue_id));
  const newWorkPath = 'create a new sub-issue under this epic, then remove and re-apply the '
    + `\`${triggerLabel}\` label on this epic — I'll fold it into the orchestration.`;
  const commandsFooter = hasFailures
    ? [
      '',
      `**Commands:** ${KNOWN_EPIC_COMMANDS.map((c) => `\`@bgagent ${c}\``).join(', ')} `
        + 're-runs the failed/skipped sub-issues and keeps the ones that succeeded.',
    ]
    : [];

  if (newWork && reason === 'none') {
    return [
      '👋 That looks like **new work** rather than a change to one of the '
        + 'existing sub-issues.',
      '',
      `To have me build it, ${newWorkPath} (If you actually `
        + 'meant one of the existing sub-issues, name it — e.g. '
        + '`@bgagent ENG-123: <what to change>`.)',
      '',
      'The current sub-issues are:',
      '',
      ...real.map((n) => `- ${nodeLabel(n)}`),
      ...integrationHint(nodes),
      ...commandsFooter,
    ].join('\n');
  }

  const lead = reason === 'ambiguous'
    ? "That could apply to more than one sub-issue, so I didn't want to guess."
    : "I couldn't tell which sub-issue that's about.";
  const out: string[] = [`👋 ${lead}`, ''];
  if (suggestion) {
    out.push(
      `Did you mean **${nodeLabel(suggestion)}**? If so, reply ` +
        `\`@bgagent ${nodeDisplayId(suggestion) ?? 'that one'}: <what to change>\`.`,
      '',
    );
  }
  out.push(
    (suggestion ? 'Otherwise, comment' : 'Comment')
      + ' on the specific sub-issue, or name it here — e.g. '
      + '`@bgagent ENG-123: <what to change>`. The sub-issues are:',
    '',
    ...real.map((n) => `- ${nodeLabel(n)}`),
    ...integrationHint(nodes),
    '',
    `If it's **new work** (not a change to one of these), ${newWorkPath}`,
    ...commandsFooter,
  );
  return out.join('\n');
}
