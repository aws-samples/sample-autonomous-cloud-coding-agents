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
  nodeDisplayId,
  parseParentNodeReference,
  renderParentDisambiguationReply,
  suggestClosestNode,
  looksLikeNewWork,
  INTEGRATION_KEYWORD,
} from '../../../src/handlers/shared/orchestration-parent-comment';

const NODES: ParentCommentNode[] = [
  { sub_issue_id: 'uuid-305', linear_identifier: 'ABCA-305', title: 'Add a site-wide footer', child_task_id: 't1' },
  { sub_issue_id: 'uuid-306', linear_identifier: 'ABCA-306', title: 'Add a newsletter signup section', child_task_id: 't2' },
  { sub_issue_id: 'orch_x__integration', title: 'Integration — combine sub-issue results', child_task_id: 't3' },
];

describe('parseParentNodeReference — routing a parent-epic comment to one sub-issue', () => {
  test('a title keyword inside a natural sentence ("for the footer …") routes to that one sub-issue', () => {
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

  test('a node written under the NEUTRAL id name routes identically', () => {
    const neutral: ParentCommentNode[] = [
      { sub_issue_id: 'uuid-307', display_id: 'ABCA-307', title: 'Add a hero image', child_task_id: 't4' },
    ];
    const r = parseParentNodeReference('ABCA-307: make it wider', neutral);
    expect(r.reason).toBeNull();
    expect(r.matches).toHaveLength(1);
    expect(nodeDisplayId(r.matches[0])).toBe('ABCA-307');
  });

  test('nodeDisplayId is what USER-FACING text must use, under either naming', () => {
    expect(nodeDisplayId({ sub_issue_id: 'u1', display_id: 'ABCA-957' })).toBe('ABCA-957');
    expect(nodeDisplayId({ sub_issue_id: 'u1', linear_identifier: 'ABCA-957' })).toBe('ABCA-957');
    expect(nodeDisplayId({ sub_issue_id: 'u1' })).toBeUndefined();
  });

  test('a MIXED epic disambiguates across both namings', () => {
    const mixed: ParentCommentNode[] = [
      { sub_issue_id: 'a', linear_identifier: 'ABCA-1', title: 'Add a pricing banner' },
      { sub_issue_id: 'b', display_id: 'ABCA-2', title: 'Add a newsletter block' },
    ];
    expect(nodeDisplayId(parseParentNodeReference('ABCA-2: reword it', mixed).matches[0])).toBe('ABCA-2');
    expect(nodeDisplayId(parseParentNodeReference('ABCA-1: reword it', mixed).matches[0])).toBe('ABCA-1');
  });

  test('the neutral name wins when a row carries both', () => {
    const both: ParentCommentNode[] = [
      { sub_issue_id: 'a', display_id: 'ABCA-9', linear_identifier: 'ABCA-9', title: 'A node' },
    ];
    expect(nodeDisplayId(both[0])).toBe('ABCA-9');
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
    const r = parseParentNodeReference('please add a section somewhere', NODES);
    expect(r.reason).toBe('none');
    expect(r.matches).toHaveLength(0);
  });

  test('integration node only matches on an explicit "integration"/"combined" mention', () => {
    const r1 = parseParentNodeReference('check the integration result', NODES);
    expect(r1.reason).toBeNull();
    expect(r1.matches[0].sub_issue_id).toBe('orch_x__integration');
    const r2 = parseParentNodeReference('the results look off', NODES);
    expect(r2.matches.some((m) => m.sub_issue_id === 'orch_x__integration')).toBe(false);
  });

  test('"combined" targets the integration node too — it is what the panel calls it', () => {
    const r = parseParentNodeReference('the combined result is broken', NODES);
    expect(r.reason).toBeNull();
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].sub_issue_id).toBe('orch_x__integration');
  });

  test('the keyword the reply ADVERTISES is the keyword the parser ACCEPTS', () => {
    const advertised = renderParentDisambiguationReply('none', NODES);
    expect(advertised).toContain(`@bgagent ${INTEGRATION_KEYWORD}:`);
    const routed = parseParentNodeReference(`${INTEGRATION_KEYWORD} the dates are wrong`, NODES);
    expect(routed.matches[0]?.sub_issue_id).toBe('orch_x__integration');
  });

  test('empty / whitespace instruction → none', () => {
    expect(parseParentNodeReference('', NODES).reason).toBe('none');
    expect(parseParentNodeReference('   ', NODES).reason).toBe('none');
  });
});

describe('suggestClosestNode', () => {
  test('returns the single best title-overlap node', () => {
    const s = suggestClosestNode('the newsletter box looks cramped', NODES);
    expect(s?.linear_identifier).toBe('ABCA-306');
  });

  test('returns null when nothing overlaps', () => {
    expect(suggestClosestNode('ship it', NODES)).toBeNull();
  });

  test('never suggests the integration node', () => {
    const s = suggestClosestNode('the combined integration result', NODES);
    expect(s).toBeNull();
  });
});

describe('renderParentDisambiguationReply', () => {
  test('lists the real sub-issues + how to target one + the new-work path', () => {
    const body = renderParentDisambiguationReply('none', NODES);
    expect(body).toContain('ABCA-305 — Add a site-wide footer');
    expect(body).toContain('ABCA-306 — Add a newsletter signup section');
    expect(body).toContain('@bgagent ENG-123:');
    expect(body.toLowerCase()).toContain('new work');
  });

  test.each([
    ['which-sub-issue', false],
    ['new-work', true],
  ])('the %s reply names the trigger label of the project, to re-apply on the epic', (_reply, newWork) => {
    const body = renderParentDisambiguationReply('none', NODES, null, newWork, false, 'ship-it');
    expect(body).toContain('create a new sub-issue under this epic, then remove and re-apply the `ship-it` label on this epic');
    expect(body).not.toContain('abca');
  });

  test('names the platform default label for an epic that has none stored', () => {
    expect(renderParentDisambiguationReply('none', NODES)).toContain('re-apply the `bgagent` label on this epic');
  });

  test('offers the integration node as an EXPLICIT target, with the exact phrasing', () => {
    const body = renderParentDisambiguationReply('none', NODES);
    expect(body).toContain('- Integration — combined result; target with `@bgagent integration: <request>`');
  });

  test('does NOT mention integration when the epic has no integration node', () => {
    const realOnly = NODES.filter((n) => !n.sub_issue_id.endsWith('__integration'));
    const body = renderParentDisambiguationReply('none', realOnly);
    expect(body).not.toMatch(/integration/i);
  });

  test('surfaces a "did you mean" suggestion when provided', () => {
    const body = renderParentDisambiguationReply('none', NODES, NODES[0]);
    expect(body).toContain('Did you mean **ABCA-305 — Add a site-wide footer**?');
    expect(body).toContain('@bgagent ABCA-305:');
  });

  test('"Otherwise" appears ONLY when there is something to contrast with', () => {
    const withSuggestion = renderParentDisambiguationReply('none', NODES, NODES[0]);
    expect(withSuggestion).toContain('Otherwise, comment on the specific sub-issue');

    const without = renderParentDisambiguationReply('none', NODES);
    expect(without).toContain('Comment on the specific sub-issue');
    expect(without).not.toContain('Otherwise');
  });

  test('the commands footer does NOT bill a label re-apply as the same as retry', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, false, true);
    expect(body).toContain('`@bgagent retry`');
    expect(body).toContain('keeps the ones that succeeded');
    expect(body).not.toContain('same as removing');
  });

  test('ambiguous vs none give different lead copy', () => {
    expect(renderParentDisambiguationReply('ambiguous', NODES)).toContain('more than one');
    expect(renderParentDisambiguationReply('none', NODES)).toContain("couldn't tell");
  });

  test('the new-work flag leads with the create-a-sub-issue path', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, true);
    expect(body).toContain('new work');
    expect(body).toContain('create a new sub-issue');
    expect(body).not.toContain("couldn't tell");
    expect(body).toContain('ABCA-305');
    expect(body).toContain('ABCA-306');
  });

  test('hasFailures=true appends a Commands footer surfacing `@bgagent retry`', () => {
    const body = renderParentDisambiguationReply('none', NODES, null, false, true);
    expect(body).toContain('Commands:');
    expect(body).toContain('`@bgagent retry`');
    expect(body).toContain('keeps the ones that succeeded');
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

describe('suggestClosestNode scores descriptions (not just titles)', () => {
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
    const s = suggestClosestNode('the footer, but more blue', DESC_NODES);
    expect(s?.linear_identifier).toBe('ABCA-402');
  });

  test('still returns null when nothing overlaps title or description', () => {
    expect(suggestClosestNode('ship it when ready', DESC_NODES)).toBeNull();
  });
});

describe('looksLikeNewWork', () => {
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
