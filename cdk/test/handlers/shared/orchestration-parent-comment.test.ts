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
  type ParentCommentNode,
  parseParentNodeReference,
  renderParentDisambiguationReply,
  suggestClosestNode,
  looksLikeNewWork,
} from '../../../src/handlers/shared/orchestration-parent-comment';

const NODES: ParentCommentNode[] = [
  { sub_issue_id: 'uuid-305', linear_identifier: 'ABCA-305', title: 'Add a site-wide footer', child_task_id: 't1' },
  { sub_issue_id: 'uuid-306', linear_identifier: 'ABCA-306', title: 'Add a newsletter signup section', child_task_id: 't2' },
  { sub_issue_id: 'orch_x__integration', title: 'Integration — combine sub-issue results', child_task_id: 't3' },
];

describe('parseParentNodeReference (#247 UX.18 — parent comment → sub-issue)', () => {
  test('the live case: "for the footer change it to ..." → ABCA-305 only', () => {
    const r = parseParentNodeReference('for the footer can you change it to "unforgettable memories await you"', NODES);
    expect(r.reason).toBeNull();
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].linear_identifier).toBe('ABCA-305');
  });

  test('keyword "newsletter" → ABCA-306 only', () => {
    const r = parseParentNodeReference('tweak the newsletter copy please', NODES);
    expect(r.reason).toBeNull();
    expect(r.matches[0].linear_identifier).toBe('ABCA-306');
  });

  test('Linear identifier wins outright (even alongside a keyword for another node)', () => {
    const r = parseParentNodeReference('ABCA-306 also mention the footer somewhere', NODES);
    expect(r.reason).toBeNull();
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].linear_identifier).toBe('ABCA-306');
  });

  test('identifier is case-insensitive', () => {
    const r = parseParentNodeReference('abca-305: bump the year', NODES);
    expect(r.matches[0].linear_identifier).toBe('ABCA-305');
  });

  test('no node referenced → reason "none"', () => {
    const r = parseParentNodeReference('looks great, thanks!', NODES);
    expect(r.reason).toBe('none');
    expect(r.matches).toHaveLength(0);
  });

  test('a keyword common to two titles → ambiguous (not a silent pick)', () => {
    const nodes: ParentCommentNode[] = [
      { sub_issue_id: 'a', linear_identifier: 'ABCA-1', title: 'Add a pricing banner' },
      { sub_issue_id: 'b', linear_identifier: 'ABCA-2', title: 'Add a pricing table' },
    ];
    const r = parseParentNodeReference('update the pricing wording', nodes);
    expect(r.reason).toBe('ambiguous');
    expect(r.matches).toHaveLength(2);
  });

  test('two identifiers named → ambiguous', () => {
    const r = parseParentNodeReference('ABCA-305 and ABCA-306 both need the new tagline', NODES);
    expect(r.reason).toBe('ambiguous');
    expect(r.matches).toHaveLength(2);
  });

  test('noise-only overlap does NOT match (e.g. "add", "page", "section")', () => {
    // "add a section" shares only noise words with the titles → no match.
    const r = parseParentNodeReference('please add a section somewhere', NODES);
    expect(r.reason).toBe('none');
    expect(r.matches).toHaveLength(0);
  });

  test('integration node only matches on an explicit "integration"/"combined" mention', () => {
    const r1 = parseParentNodeReference('check the integration result', NODES);
    expect(r1.reason).toBeNull();
    expect(r1.matches[0].sub_issue_id).toBe('orch_x__integration');
    // A generic word from its title ("results") must NOT pull it in.
    const r2 = parseParentNodeReference('the results look off', NODES);
    expect(r2.matches.some((m) => m.sub_issue_id === 'orch_x__integration')).toBe(false);
  });

  test('empty / whitespace instruction → none', () => {
    expect(parseParentNodeReference('', NODES).reason).toBe('none');
    expect(parseParentNodeReference('   ', NODES).reason).toBe('none');
  });
});

describe('suggestClosestNode', () => {
  test('returns the single best title-overlap node', () => {
    // "footers" won't exact-match (plural) but "footer" stem won't either;
    // use a word that overlaps a significant title word.
    const s = suggestClosestNode('the newsletter box looks cramped', NODES);
    expect(s?.linear_identifier).toBe('ABCA-306');
  });

  test('returns null when nothing overlaps', () => {
    expect(suggestClosestNode('ship it', NODES)).toBeNull();
  });

  test('never suggests the integration node', () => {
    const s = suggestClosestNode('the combined integration result', NODES);
    expect(s).toBeNull(); // integration excluded from suggestions
  });
});

describe('renderParentDisambiguationReply', () => {
  test('lists the REAL sub-issues (not the integration node) + how to target one + new-work path', () => {
    const body = renderParentDisambiguationReply('none', NODES);
    expect(body).toContain('ABCA-305 — Add a site-wide footer');
    expect(body).toContain('ABCA-306 — Add a newsletter signup section');
    expect(body).not.toContain('Integration — combine'); // synthetic node hidden
    expect(body).toContain('@bgagent ABCA-123:'); // the how-to hint
    expect(body.toLowerCase()).toContain('new work'); // the create-a-sub-issue path
    expect(body).toContain('`abca` label');
  });

  test('surfaces a "did you mean" suggestion when provided', () => {
    const body = renderParentDisambiguationReply('none', NODES, NODES[0]);
    expect(body).toContain('Did you mean **ABCA-305 — Add a site-wide footer**?');
    expect(body).toContain('@bgagent ABCA-305:');
  });

  test('ambiguous vs none give different lead copy', () => {
    expect(renderParentDisambiguationReply('ambiguous', NODES)).toContain('more than one');
    expect(renderParentDisambiguationReply('none', NODES)).toContain("couldn't tell");
  });

  test('#247 UX-2: new-work flag leads with the create-a-sub-issue path', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, true);
    expect(body).toContain('new work');
    expect(body).toContain('create a new sub-issue');
    // Leads with the new-work framing, not the generic "couldn't tell".
    expect(body).not.toContain("couldn't tell");
    // Still lists the existing sub-issues for context.
    expect(body).toContain('ABCA-305');
    expect(body).toContain('ABCA-306');
  });

  // PM-P0-1 (2026-07-24): when the epic has failures, EVERY can't-act reply
  // surfaces the `retry` command — so an unrecognised comment always shows what
  // the user CAN type (no intent-guessing). Consistent with re-labelling.
  test('hasFailures=true appends a Commands footer surfacing `@bgagent retry` + the re-label equivalent', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, false, true);
    expect(body).toContain('Commands:');
    expect(body).toContain('`@bgagent retry`');
    expect(body).toContain('re-apply'); // names the equivalent re-label path
  });

  test('hasFailures=false omits the Commands footer (nothing to retry)', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, false, false);
    expect(body).not.toContain('Commands:');
    expect(body).not.toContain('@bgagent retry');
  });

  test('the retry footer also rides on the new-work path when there are failures', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, true, true);
    expect(body).toContain('create a new sub-issue');
    expect(body).toContain('`@bgagent retry`');
  });
});

describe('#247 UX-2: suggestClosestNode scores descriptions (not just titles)', () => {
  // The header node's TITLE has no "blue"/"color"/"yellow"; only its
  // DESCRIPTION does. The "header color to yellow instead of blue" class of
  // comment should still surface it as a did-you-mean, the gap that produced a
  // generic "couldn't tell" in the live UX stress test.
  const DESC_NODES: ParentCommentNode[] = [
    {
      sub_issue_id: 'uuid-h',
      linear_identifier: 'ABCA-401',
      title: 'Add a top bar with the site title',
      description: 'Solid blue (#2563EB) background with white title text.',
      child_task_id: 't1',
    },
    {
      sub_issue_id: 'uuid-f',
      linear_identifier: 'ABCA-402',
      title: 'Add a footer with a copyright line',
      description: 'Dark background, centered copyright.',
      child_task_id: 't2',
    },
  ];

  test('description word ("blue") surfaces the right node when titles miss', () => {
    const s = suggestClosestNode('change the color to yellow instead of blue', DESC_NODES);
    expect(s?.linear_identifier).toBe('ABCA-401');
  });

  test('a title hit outranks a description-only hit', () => {
    // "footer" is a significant TITLE word of 402; "blue" is only a DESC word of
    // 401. Title weight must win.
    const s = suggestClosestNode('the footer, but more blue', DESC_NODES);
    expect(s?.linear_identifier).toBe('ABCA-402');
  });

  test('still returns null when nothing overlaps title or description', () => {
    expect(suggestClosestNode('ship it when ready', DESC_NODES)).toBeNull();
  });
});

describe('#247 UX-2: looksLikeNewWork', () => {
  test('leading additive verbs are new work', () => {
    expect(looksLikeNewWork('add a testimonials section with 3 cards')).toBe(true);
    expect(looksLikeNewWork('also add a pricing table')).toBe(true);
    expect(looksLikeNewWork('can you create a contact form')).toBe(true);
    expect(looksLikeNewWork('please build a dark mode toggle')).toBe(true);
  });

  test('change/edit verbs are NOT new work', () => {
    expect(looksLikeNewWork('change the footer text to bigger')).toBe(false);
    expect(looksLikeNewWork('make the colors pop more')).toBe(false);
    expect(looksLikeNewWork('the footer should be centered')).toBe(false);
    expect(looksLikeNewWork('ABCA-305: update the copyright')).toBe(false);
  });

  test('empty / noise instruction is not new work', () => {
    expect(looksLikeNewWork('')).toBe(false);
    expect(looksLikeNewWork('looks good, thanks')).toBe(false);
  });
});
