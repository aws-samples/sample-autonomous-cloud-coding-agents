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
});
