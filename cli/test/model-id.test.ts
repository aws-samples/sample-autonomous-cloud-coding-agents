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
    expect(check('anthropic.claude-opus-5', 'global'))
      .toThrow(/bare foundation-model id/);
    expect(check('anthropic.claude-opus-5', 'global'))
      .toThrow(/global\.anthropic\.claude-opus-5/);
  });

  it('rejects a geography the stack does not grant, and names both sides', () => {
    const t = check('us.anthropic.claude-opus-5', 'global');
    expect(t).toThrow(/'us' inference profile/);
    expect(t).toThrow(/grants 'global' profiles/);
    expect(t).toThrow(/global\.anthropic\.claude-opus-5/);
    expect(t).toThrow(/bedrockGeoRegion=us/);
  });

  it('strips the right prefix length for a hyphenated geography', () => {
    expect(check('us-gov.anthropic.claude-opus-5', 'global'))
      .toThrow(/global\.anthropic\.claude-opus-5/);
  });

  it('skips the geography check when the stack does not export one', () => {
    expect(check('us.anthropic.claude-opus-5', null)).not.toThrow();
    expect(check('global.anthropic.claude-opus-5', null)).not.toThrow();
  });

  it('still rejects a bare id with no exported geography', () => {
    expect(check('anthropic.claude-opus-5', null)).toThrow(/bare foundation-model id/);
  });

  it('rejects a model the stack does not grant, and lists what it does', () => {
    const t = check('global.anthropic.example-ungranted-model', 'global', GRANTED);
    expect(t).toThrow(/is not granted by stack/);
    expect(t).toThrow(/anthropic\.claude-opus-5/);
    expect(check('global.not-a-bedrock-model', 'global', GRANTED)).toThrow(/not granted/);
  });

  it('accepts a granted model', () => {
    expect(check('global.anthropic.claude-opus-5', 'global', GRANTED)).not.toThrow();
  });

  it('skips the grant check when the stack does not export the set', () => {
    expect(check('global.anthropic.whatever', 'global')).not.toThrow();
    expect(check('global.anthropic.whatever', 'global', [])).not.toThrow();
  });

  it('does not prescribe a geography it was not told', () => {
    const t = check('anthropic.claude-opus-5', null);
    expect(t).toThrow(/prefixed with the deployment's geography/);
    expect(t).not.toThrow(/Use the inference-profile form: 'us\./);
  });
});

it('rejects a geography prefix with no model after it', () => {
  const t = check('global.', 'global');
  expect(t).toThrow(/geography prefix with no model after it/);
  expect(t).toThrow(/global\.<model-id>/);
});

it('rejects a doubled geography prefix, and names the single-prefix form', () => {
  const t = check('global.us.anthropic.claude-opus-5', 'global');
  expect(t).toThrow(/two geography prefixes/);
  expect(t).toThrow(/'global\.' then/);
  expect(t).toThrow(/global\.anthropic\.claude-opus-5/);
});

it('trims before validating, so a trailing space cannot reach the RepoTable', () => {
  expect(check('  global.anthropic.claude-opus-5  ', 'global', GRANTED)).not.toThrow();
  expect(check('  anthropic.claude-opus-5  ', 'global')).toThrow(/bare foundation-model id/);
  expect(check('   ', 'global')).not.toThrow();
});

it('treats an all-whitespace deployedGeo as unknown, not as a match', () => {
  expect(check('us.anthropic.claude-opus-5', '   ')).not.toThrow();
});

describe('geoPrefixOf', () => {
  it('recognizes every geography in its own list', () => {
    for (const geo of BEDROCK_GEO_PREFIXES) {
      expect(geoPrefixOf(`${geo}.anthropic.claude-opus-5`)).toBe(geo);
    }
  });

  it('stays in sync with the CDK geography list', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../cdk/src/handlers/shared/bedrock-model-constants.ts'),
      'utf8',
    );
    const decl = src.slice(src.indexOf('export const BEDROCK_GEO_REGIONS'));
    const assign = decl.slice(decl.indexOf('='));
    const literal = assign.slice(assign.indexOf('['), assign.indexOf(']') + 1);
    const cdkGeos = [...literal.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(cdkGeos.length).toBeGreaterThan(0);
    expect([...BEDROCK_GEO_PREFIXES].sort()).toEqual([...cdkGeos].sort());
  });

  it('matches us-gov as us-gov regardless of list order', () => {
    expect(geoPrefixOf('us-gov.anthropic.claude-opus-5')).toBe('us-gov');
    expect(geoPrefixOf('us.anthropic.claude-opus-5')).toBe('us');
  });

  it('returns undefined for a bare id, and for a name that merely starts with a geo word', () => {
    expect(geoPrefixOf('anthropic.claude-opus-5')).toBeUndefined();
    expect(geoPrefixOf('august-labs.model-1')).toBeUndefined();
    expect(geoPrefixOf('european.model-1')).toBeUndefined();
  });
});
