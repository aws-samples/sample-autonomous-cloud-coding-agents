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
  /**
   * Sub-issue description. NOT used for act-routing (too low-precision to
   * auto-iterate on — a long description shares words with many comments), but
   * #247 UX-2 scores it for the "did you mean …?" SUGGESTION so a comment like
   * "change the header color to yellow instead of blue" surfaces the header
   * node (whose description mentions blue) for a one-tap confirm, rather than a
   * generic "couldn't tell". Optional — matching degrades gracefully when absent.
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

/** Significant (non-noise, length>2) words of a string, as a Set. */
function significantWords(s: string | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    normalize(s).split(' ').filter((w) => w.length > 2 && !TITLE_NOISE.has(w)),
  );
}

/**
 * Best-effort "did you mean …?" suggestion for the disambiguation reply, used
 * ONLY when {@link parseParentNodeReference} found no confident match. We never
 * ACT on this (no silent iteration of a guess) — it's a hint in the reply so
 * the human can confirm with one tap.
 *
 * #247 UX-2: scores each real node by overlap with BOTH its title (weighted
 * heavily) and its description (weighted lightly). The description tier is what
 * lets "change the header color to yellow instead of blue" surface the header
 * node — whose title is "...header bar..." (title hit) and/or whose description
 * mentions the blue it changes. Title overlap dominates so a description-only
 * coincidence can't outrank a real title match. Returns the single best scorer,
 * or null when nothing overlaps at all. The synthetic integration node is never
 * suggested.
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
 * one? #247 UX-2: when true and nothing matched, the disambiguation reply leads
 * with the "create a sub-issue" path instead of the generic "couldn't tell".
 *
 * Conservative — only fires when the instruction opens with an additive verb
 * (add / create / build / introduce / include / also add …). A change verb
 * ("change the footer", "make it bigger") is NOT new work.
 */
const NEW_WORK_VERBS = new Set(['add', 'create', 'build', 'introduce', 'include', 'implement']);
/** How many leading words to scan for an additive verb past politeness filler. */
const NEW_WORK_LEAD_SCAN = 5;
export function looksLikeNewWork(instruction: string): boolean {
  const words = normalize(instruction).split(' ').filter(Boolean);
  // Scan the first few words for a leading additive verb ("also add ...",
  // "can you add ...", "please create ..."), skipping politeness/filler.
  const FILLER = new Set(['also', 'can', 'you', 'please', 'could', 'would', 'lets', 'let', 'us', 'we', 'i', 'd', 'like', 'to', 'now', 'maybe']);
  for (const w of words.slice(0, NEW_WORK_LEAD_SCAN)) {
    if (NEW_WORK_VERBS.has(w)) return true;
    if (!FILLER.has(w)) break; // first non-filler word isn't an additive verb → not new work
  }
  return false;
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
 * @param newWork    #247 UX-2: when the instruction looks like a request for NEW
 *                   work (see {@link looksLikeNewWork}), lead with the
 *                   create-a-sub-issue path instead of the generic "couldn't
 *                   tell" — the comment isn't about an existing sub-issue at all.
 */
export function renderParentDisambiguationReply(
  reason: 'none' | 'ambiguous',
  nodes: readonly ParentCommentNode[],
  suggestion?: ParentCommentNode | null,
  newWork = false,
): string {
  const real = nodes.filter((n) => !isIntegrationNode(n.sub_issue_id));

  // #247 UX-2: new-work path leads with the create-a-sub-issue ask (the comment
  // is adding something, not changing an existing sub-issue), then lists the
  // existing ones for context. Never auto-creates.
  if (newWork && reason === 'none') {
    return [
      '👋 That looks like **new work** rather than a change to one of the '
        + 'existing sub-issues.',
      '',
      'To have me build it, create a new sub-issue under this epic and add the '
        + '`abca` label — I\'ll fold it into the orchestration. (If you actually '
        + 'meant one of the existing sub-issues, name it — e.g. '
        + '`@bgagent ABCA-123: <what to change>`.)',
      '',
      'The current sub-issues are:',
      '',
      ...real.map((n) => `- ${nodeLabel(n)}`),
    ].join('\n');
  }

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
