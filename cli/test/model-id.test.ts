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

import { BEDROCK_GEO_PREFIXES, assertModelIdUsable, geoPrefixOf } from '../src/model-id';

const STACK = 'Abca';
const check = (modelId: string | undefined, deployedGeo: string | null) =>
  () => assertModelIdUsable({ modelId, deployedGeo, stackName: STACK });

describe('assertModelIdUsable', () => {
  it('accepts a profile matching the deployed geography', () => {
    expect(check('global.anthropic.claude-opus-5', 'global')).not.toThrow();
    expect(check('us.anthropic.claude-opus-5', 'us')).not.toThrow();
  });

  it('accepts no --model at all (the common case)', () => {
    expect(check(undefined, 'global')).not.toThrow();
  });

  it('rejects a bare foundation-model id, and names the profile form to use', () => {
    // Bedrock refuses bare ids for on-demand invocation of Claude 4.x+, so this is
    // wrong regardless of what is granted. The error has to carry the fix: the
    // operator is one prefix away from a working value.
    expect(check('anthropic.claude-opus-5', 'global'))
      .toThrow(/bare foundation-model id/);
    expect(check('anthropic.claude-opus-5', 'global'))
      .toThrow(/global\.anthropic\.claude-opus-5/);
  });

  it('rejects a geography the stack does not grant, and names both sides', () => {
    // The IAM grant is scoped to `<geo>.` profile ARNs resolved at synth, so a
    // mismatched geography is granted nothing. Today that surfaces only as an
    // AccessDenied at turn 0 with no mention of the model.
    const t = check('us.anthropic.claude-opus-5', 'global');
    expect(t).toThrow(/'us' inference profile/);
    expect(t).toThrow(/grants 'global' profiles/);
    // Both remedies: fix the model, or redeploy the stack for that geography.
    expect(t).toThrow(/global\.anthropic\.claude-opus-5/);
    expect(t).toThrow(/bedrockGeoRegion=us/);
  });

  it('strips the right prefix length for a hyphenated geography', () => {
    // `us-gov` must be recognized as `us-gov`, not as `us` leaving a stray `-gov.`
    // in the suggested replacement.
    expect(check('us-gov.anthropic.claude-opus-5', 'global'))
      .toThrow(/global\.anthropic\.claude-opus-5/);
  });

  it('skips the geography check when the stack does not export one', () => {
    // An older stack has no BedrockGeoRegion output. Guessing a geography and
    // rejecting on it would block a legitimate onboard.
    expect(check('us.anthropic.claude-opus-5', null)).not.toThrow();
    expect(check('global.anthropic.claude-opus-5', null)).not.toThrow();
  });

  it('still rejects a bare id with no exported geography', () => {
    // The bare-id rule holds for every geography, so it must not be skipped along
    // with the geography comparison.
    expect(check('anthropic.claude-opus-5', null)).toThrow(/bare foundation-model id/);
  });
});

describe('geoPrefixOf', () => {
  it('recognizes every geography the CDK models', () => {
    for (const geo of BEDROCK_GEO_PREFIXES) {
      expect(geoPrefixOf(`${geo}.anthropic.claude-opus-5`)).toBe(geo);
    }
  });

  it('matches us-gov as us-gov regardless of list order', () => {
    // Independent of ordering: the match requires `<geo>` followed by a literal `.`,
    // so `us.` cannot match `us-gov.…`. Asserted because the list is written
    // longest-first and a future tidy-up must not be read as load-bearing.
    expect(geoPrefixOf('us-gov.anthropic.claude-opus-5')).toBe('us-gov');
    expect(geoPrefixOf('us.anthropic.claude-opus-5')).toBe('us');
  });

  it('returns undefined for a bare id, and for a name that merely starts with a geo word', () => {
    expect(geoPrefixOf('anthropic.claude-opus-5')).toBeUndefined();
    // Keyed on the `<geo>.` separator, so a hypothetical vendor named `august` or
    // `european` is not collateral damage.
    expect(geoPrefixOf('august-labs.model-1')).toBeUndefined();
    expect(geoPrefixOf('european.model-1')).toBeUndefined();
  });
});
