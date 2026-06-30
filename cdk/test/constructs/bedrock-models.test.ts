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

import { App, Stack } from 'aws-cdk-lib';
import {
  BEDROCK_MODELS_CONTEXT_KEY,
  DEFAULT_BEDROCK_MODEL_IDS,
  resolveBedrockModelIds,
} from '../../src/constructs/bedrock-models';

function nodeWithContext(context?: Record<string, unknown>) {
  const app = new App({ context });
  return new Stack(app, 'TestStack').node;
}

describe('resolveBedrockModelIds', () => {
  it('returns the default set when no context override is present', () => {
    const ids = resolveBedrockModelIds(nodeWithContext());
    expect(ids).toEqual(DEFAULT_BEDROCK_MODEL_IDS);
  });

  it('returns the context override when provided', () => {
    const override = ['anthropic.claude-opus-4-8', 'anthropic.claude-sonnet-4-6'];
    const ids = resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: override }));
    expect(ids).toEqual(override);
  });

  it('throws on a non-array override (typo guard)', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: 'anthropic.claude-opus-4-8' })),
    ).toThrow(/must be a non-empty array/);
  });

  it('throws on an empty-array override', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: [] })),
    ).toThrow(/must be a non-empty array/);
  });

  it('throws on a non-string / empty entry', () => {
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['anthropic.claude-sonnet-4-6', ''] })),
    ).toThrow(/non-empty strings/);
  });

  it('throws on a region-prefixed (us./eu./apac.) inference-profile ID', () => {
    // Guards the us.us.… double-prefix footgun: both grant sites derive the
    // inference-profile ARN by prefixing `us.`, so the context wants the bare id.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us.anthropic.claude-opus-4-8'] })),
    ).toThrow(/bare foundation-model IDs/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['eu.anthropic.claude-sonnet-4-6'] })),
    ).toThrow(/bare foundation-model IDs/);
  });
});
