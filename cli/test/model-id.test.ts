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
const check = (
  modelId: string | undefined,
  deployedGeo: string | null,
  grantedBareIds?: readonly string[],
) => () => assertModelIdUsable({ modelId, deployedGeo, stackName: STACK, grantedBareIds });

const GRANTED = ['anthropic.claude-opus-5', 'anthropic.claude-sonnet-4-6'];

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

  it('rejects a model the stack does not grant, and lists what it does', () => {
    // The gap the first version of this guard left open: well-formed, right geography,
    // granted nothing. It reached turn 0 as an AccessDenied naming no model.
    const t = check('global.anthropic.example-ungranted-model', 'global', GRANTED);
    expect(t).toThrow(/is not granted by stack/);
    expect(t).toThrow(/anthropic\.claude-opus-5/);
    expect(check('global.not-a-bedrock-model', 'global', GRANTED)).toThrow(/not granted/);
  });

  it('accepts a granted model', () => {
    expect(check('global.anthropic.claude-opus-5', 'global', GRANTED)).not.toThrow();
  });

  it('skips the grant check when the stack does not export the set', () => {
    // An older stack has no BedrockModelIds output. Blocking every --model there
    // would be worse than the gap this closes.
    expect(check('global.anthropic.whatever', 'global')).not.toThrow();
    expect(check('global.anthropic.whatever', 'global', [])).not.toThrow();
  });

  it('does not prescribe a geography it was not told', () => {
    // Suggesting `us.` on a stack deployed as `global` trades one turn-0 failure for
    // another. With no exported geography the message must offer examples, not a value.
    const t = check('anthropic.claude-opus-5', null);
    expect(t).toThrow(/prefixed with the deployment's geography/);
    expect(t).not.toThrow(/Use the inference-profile form: 'us\./);
  });
});

// Verified live at the terminal against a deployed stack, but never pinned here —
// so a refactor could have dropped any of these three and the suite would not have
// noticed. Each is a value that reaches the RepoTable and then fails at turn 0.
it('rejects a geography prefix with no model after it', () => {
  // `'global.'` passed every check on a stack exporting no granted set — i.e. every
  // stack deployed before that output existed — and landed in the RepoTable as-is.
  const t = check('global.', 'global');
  expect(t).toThrow(/geography prefix with no model after it/);
  // The message must show the shape, not just complain.
  expect(t).toThrow(/global\.<model-id>/);
});

it('rejects a doubled geography prefix, and names the single-prefix form', () => {
  // Caught here rather than left to the grant check, which is SKIPPED on a stack
  // that exports no granted set — so without this the value would sail through.
  const t = check('global.us.anthropic.claude-opus-5', 'global');
  expect(t).toThrow(/two geography prefixes/);
  expect(t).toThrow(/'global\.' then/);
  expect(t).toThrow(/global\.anthropic\.claude-opus-5/);
});

it('trims before validating, so a trailing space cannot reach the RepoTable', () => {
  // A trailing space survived every check and was written verbatim, where it never
  // matches a real profile id. Asserted in both directions: the padded valid value
  // is ACCEPTED, and a padded bare id is still rejected (trimming must not become a
  // way to bypass the other rules).
  expect(check('  global.anthropic.claude-opus-5  ', 'global', GRANTED)).not.toThrow();
  expect(check('  anthropic.claude-opus-5  ', 'global')).toThrow(/bare foundation-model id/);
  // And an all-whitespace value is treated as absent, not as an empty model id.
  expect(check('   ', 'global')).not.toThrow();
});

it('treats an all-whitespace deployedGeo as unknown, not as a match', () => {
  // `getStackOutput` returns null for a missing output, so a blank string means the
  // stack exported an empty value. Treating it as "matches anything" would skip the
  // geography check on exactly the stack whose geography is unclear.
  expect(check('us.anthropic.claude-opus-5', '   ')).not.toThrow();
});

describe('geoPrefixOf', () => {
  it('recognizes every geography in its own list', () => {
    for (const geo of BEDROCK_GEO_PREFIXES) {
      expect(geoPrefixOf(`${geo}.anthropic.claude-opus-5`)).toBe(geo);
    }
  });

  /**
   * The forcing function this list previously lacked.
   *
   * `BEDROCK_GEO_PREFIXES` is a hand-written mirror of the CDK's geography list (the CLI
   * is a separate package and does not depend on CDK). The loop above cannot detect
   * drift, because it iterates the very list it validates — so when the alpha enum gains
   * a geography, the CDK literal is forced to update by its own parity test while this
   * one silently lags. On a `-c bedrockGeoRegion=<new>` deploy that lag makes
   * `assertModelIdUsable` reject a correctly-formed granted model as "a bare
   * foundation-model id", and stops `platform-doctor` stripping the prefix at all.
   *
   * Read as TEXT rather than imported, because importing the CDK module here is what the
   * package boundary exists to prevent — the same technique
   * `cdk/test/contracts/model-default-docs-parity.test.ts` uses to pin `agent/src/models.py`.
   */
  it('stays in sync with the CDK geography list', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../cdk/src/handlers/shared/bedrock-model-constants.ts'),
      'utf8',
    );
    // Anchor on the declaration, and skip past the type annotation: `readonly string[]`
    // contains an empty `[]` that a naive first-bracket search matches instead.
    const decl = src.slice(src.indexOf('export const BEDROCK_GEO_REGIONS'));
    const assign = decl.slice(decl.indexOf('='));
    const literal = assign.slice(assign.indexOf('['), assign.indexOf(']') + 1);
    const cdkGeos = [...literal.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(cdkGeos.length).toBeGreaterThan(0);
    expect([...BEDROCK_GEO_PREFIXES].sort()).toEqual([...cdkGeos].sort());
  });

  it('matches us-gov as us-gov regardless of list order', () => {
    // Independent of ordering: the match requires `<geo>` followed by a literal `.`,
    // so `us.` cannot match `us-gov.…`. The list is NOT sorted by length (`apac`
    // follows `us`), which is why this is asserted behaviourally.
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
