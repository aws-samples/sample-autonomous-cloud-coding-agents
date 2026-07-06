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
  parseDecompositionMode,
  triggerLabelVariants,
  hasHelpLabel,
  looksMultiPart,
  DEFAULT_LABEL_FILTER,
} from '../../../src/handlers/shared/orchestration-decomposition-mode';

describe('parseDecompositionMode — bare base label (today\'s behaviour)', () => {
  test('base label + no sub-issues → single task', () => {
    const d = parseDecompositionMode(['bgagent'], false);
    expect(d.mode).toBe('single');
    expect(d.matchedLabel).toBe('bgagent');
    expect(d.suffixSuppressed).toBe(false);
  });

  test('base label + existing sub-issues → Mode A (run the graph)', () => {
    const d = parseDecompositionMode(['bgagent'], true);
    expect(d.mode).toBe('mode_a');
    expect(d.suffixSuppressed).toBe(false);
  });

  test('no trigger label at all → none (ignore)', () => {
    const d = parseDecompositionMode(['bug', 'P1'], false);
    expect(d.mode).toBe('none');
    expect(d.matchedLabel).toBe('');
  });
});

describe('parseDecompositionMode — decompose suffix on an UNDECOMPOSED issue', () => {
  test('bgagent:decompose + no sub-issues → decompose (approval-gated)', () => {
    const d = parseDecompositionMode(['bgagent:decompose'], false);
    expect(d.mode).toBe('decompose');
    expect(d.matchedLabel).toBe('bgagent:decompose');
    expect(d.suffixSuppressed).toBe(false);
  });

  test('bgagent:auto + no sub-issues → auto (no gate)', () => {
    const d = parseDecompositionMode(['bgagent:auto'], false);
    expect(d.mode).toBe('auto');
    expect(d.matchedLabel).toBe('bgagent:auto');
  });
});

describe('parseDecompositionMode — suffix suppressed on an EXISTING graph', () => {
  // The core #299 rule: you cannot decompose what is already decomposed. The
  // suffix is a no-op and we run the existing graph (Mode A), but we flag it so
  // the processor can tell the user why their :decompose didn't decompose.
  test('bgagent:decompose + existing sub-issues → mode_a, suffixSuppressed', () => {
    const d = parseDecompositionMode(['bgagent:decompose'], true);
    expect(d.mode).toBe('mode_a');
    expect(d.suffixSuppressed).toBe(true);
    expect(d.matchedLabel).toBe('bgagent:decompose');
  });

  test('bgagent:auto + existing sub-issues → mode_a, suffixSuppressed', () => {
    const d = parseDecompositionMode(['bgagent:auto'], true);
    expect(d.mode).toBe('mode_a');
    expect(d.suffixSuppressed).toBe(true);
  });
});

describe('parseDecompositionMode — spend-safe precedence on ambiguous label sets', () => {
  // Multiple trigger variants on one issue is user error, but must be
  // deterministic AND must never silently auto-run. decompose > auto > base.
  test('decompose + auto both present → decompose wins (approval gate)', () => {
    const d = parseDecompositionMode(['bgagent:auto', 'bgagent:decompose'], false);
    expect(d.mode).toBe('decompose');
  });

  test('auto + base both present → auto wins over bare base', () => {
    const d = parseDecompositionMode(['bgagent', 'bgagent:auto'], false);
    expect(d.mode).toBe('auto');
  });

  test('all three present, undecomposed → decompose (safest)', () => {
    const d = parseDecompositionMode(['bgagent', 'bgagent:auto', 'bgagent:decompose'], false);
    expect(d.mode).toBe('decompose');
  });

  test('all three present, already a graph → mode_a (suffix suppressed)', () => {
    const d = parseDecompositionMode(['bgagent', 'bgagent:auto', 'bgagent:decompose'], true);
    expect(d.mode).toBe('mode_a');
    expect(d.suffixSuppressed).toBe(true);
  });
});

describe('parseDecompositionMode — case-insensitive + whitespace tolerant', () => {
  test('matches regardless of case', () => {
    expect(parseDecompositionMode(['BgAgent:Decompose'], false).mode).toBe('decompose');
    expect(parseDecompositionMode(['  BGAGENT  '], false).mode).toBe('single');
  });

  test('ignores null/undefined/empty label entries', () => {
    const d = parseDecompositionMode([null, undefined, '', 'bgagent:auto'], false);
    expect(d.mode).toBe('auto');
  });
});

describe('parseDecompositionMode — custom project label filter', () => {
  test('honours a non-default base label', () => {
    expect(parseDecompositionMode(['ship'], false, 'ship').mode).toBe('single');
    expect(parseDecompositionMode(['ship:decompose'], false, 'ship').mode).toBe('decompose');
    expect(parseDecompositionMode(['ship:auto'], false, 'ship').mode).toBe('auto');
  });

  test('a custom-filter project ignores the default bgagent label', () => {
    // Project filters on 'ship'; a stray 'bgagent' label must NOT trigger.
    const d = parseDecompositionMode(['bgagent'], false, 'ship');
    expect(d.mode).toBe('none');
  });

  test('empty/whitespace filter degrades to the default base', () => {
    expect(parseDecompositionMode(['bgagent'], false, '   ').mode).toBe('single');
    expect(parseDecompositionMode(['bgagent'], false, '').mode).toBe('single');
  });
});

describe('triggerLabelVariants', () => {
  test('default filter → base + two suffixes', () => {
    expect(triggerLabelVariants()).toEqual(['bgagent', 'bgagent:decompose', 'bgagent:auto']);
  });

  test('custom filter, lower-cased', () => {
    expect(triggerLabelVariants('Ship')).toEqual(['ship', 'ship:decompose', 'ship:auto']);
  });

  test('DEFAULT_LABEL_FILTER constant is the bare base', () => {
    expect(triggerLabelVariants(DEFAULT_LABEL_FILTER)[0]).toBe('bgagent');
  });

  test(':help is NOT a trigger variant (it must never dispatch a task)', () => {
    expect(triggerLabelVariants()).not.toContain('bgagent:help');
  });
});

describe('hasHelpLabel', () => {
  test('detects the base:help label, case-insensitive', () => {
    expect(hasHelpLabel(['bgagent:help'])).toBe(true);
    expect(hasHelpLabel(['BGAgent:Help'])).toBe(true);
    expect(hasHelpLabel(['something', 'bgagent:help', 'other'])).toBe(true);
  });

  test('respects a custom label filter', () => {
    expect(hasHelpLabel(['ship:help'], 'ship')).toBe(true);
    expect(hasHelpLabel(['bgagent:help'], 'ship')).toBe(false);
  });

  test('is false for trigger/other labels (no false positive)', () => {
    expect(hasHelpLabel(['bgagent'])).toBe(false);
    expect(hasHelpLabel(['bgagent:decompose'])).toBe(false);
    expect(hasHelpLabel(['helpful', 'bghelp'])).toBe(false);
    expect(hasHelpLabel([undefined, null, ''])).toBe(false);
  });
});

describe('looksMultiPart (pre-spend hint heuristic — conservative)', () => {
  test('numbered list of ≥3 items → multi-part', () => {
    const desc = [
      'Add an account settings area with a few parts:',
      '1. A profile page showing name and avatar.',
      '2. A light/dark toggle that persists.',
      '3. A notifications list backed by an API route.',
    ].join('\n');
    expect(looksMultiPart(desc)).toBe(true);
  });

  test('bulleted list of ≥3 items → multi-part', () => {
    const desc = 'We need several things here to round out the dashboard view:\n- charts\n- filters\n- export';
    expect(looksMultiPart(desc)).toBe(true);
  });

  test('several additive conjunctions in prose → multi-part', () => {
    const desc = 'Build the login form; and also add a signup page as well as a password reset flow that emails the user.';
    expect(looksMultiPart(desc)).toBe(true);
  });

  test('a single cohesive ask → NOT multi-part (no false positive)', () => {
    expect(looksMultiPart('Fix the off-by-one bug in the pagination helper so the last page renders.')).toBe(false);
  });

  test('short / empty descriptions → NOT multi-part', () => {
    expect(looksMultiPart('make it faster')).toBe(false);
    expect(looksMultiPart('')).toBe(false);
    expect(looksMultiPart(undefined)).toBe(false);
    expect(looksMultiPart(null)).toBe(false);
  });

  test('only two list items → NOT multi-part (threshold is 3)', () => {
    const desc = 'A couple of tweaks to the header component that we should get to soon:\n- bigger logo\n- new link';
    expect(looksMultiPart(desc)).toBe(false);
  });
});
