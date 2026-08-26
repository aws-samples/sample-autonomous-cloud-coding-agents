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

import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import {
  BEDROCK_INFERENCE_PROFILE_REGION_CONTEXT_KEY,
  BEDROCK_MODELS_CONTEXT_KEY,
  DEFAULT_BEDROCK_INFERENCE_PROFILE_REGION,
  DEFAULT_BEDROCK_MODEL_IDS,
  resolveBedrockInferenceProfileRegion,
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

  it('throws on a prefixed inference-profile ID', () => {
    // Guards double-prefix footguns such as us.us.… and global.global.…:
    // both grant sites derive the configured profile prefix, so the model
    // context must contain only the bare foundation-model id.
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['us.anthropic.claude-opus-4-8'] })),
    ).toThrow(/bare foundation-model IDs/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['eu.anthropic.claude-sonnet-4-6'] })),
    ).toThrow(/bare foundation-model IDs/);
    expect(() =>
      resolveBedrockModelIds(nodeWithContext({ [BEDROCK_MODELS_CONTEXT_KEY]: ['global.anthropic.claude-opus-4-6-v1'] })),
    ).toThrow(/bare foundation-model IDs/);
  });
});

describe('resolveBedrockInferenceProfileRegion', () => {
  it('defaults to the US profile geography', () => {
    expect(resolveBedrockInferenceProfileRegion(nodeWithContext()))
      .toBe(DEFAULT_BEDROCK_INFERENCE_PROFILE_REGION);
  });

  it('accepts the global profile geography', () => {
    expect(resolveBedrockInferenceProfileRegion(nodeWithContext({
      [BEDROCK_INFERENCE_PROFILE_REGION_CONTEXT_KEY]: 'global',
    }))).toBe('global');
  });

  it('rejects an unsupported profile geography', () => {
    expect(() => resolveBedrockInferenceProfileRegion(nodeWithContext({
      [BEDROCK_INFERENCE_PROFILE_REGION_CONTEXT_KEY]: 'moon',
    }))).toThrow(/must be one of/);
  });
});

/**
 * Drift guard: the agent picks a fallback model when a repo pins none, and the
 * IAM grant that lets it invoke that model is derived from
 * DEFAULT_BEDROCK_MODEL_IDS. If the two disagree, every task on the stack fails
 * at turn 0 with AccessDenied — and nothing else in the suite notices, because
 * the agent-side default and the CDK-side grant live in different languages.
 */
describe('DEFAULT_BEDROCK_MODEL_IDS covers the agent runtime default', () => {
  it('grants the fallback model the agent falls back to', () => {
    const configPy = fs.readFileSync(
      path.resolve(__dirname, '../../../agent/src/config.py'), 'utf8',
    );
    // The fallback is the second argument to the ANTHROPIC_MODEL env lookup.
    const match = configPy.match(/"ANTHROPIC_MODEL",\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const agentDefault = match![1];

    // The agent names the US inference profile (`us.anthropic.…`); the grant list
    // holds bare foundation-model IDs and both grant sites add the `us.` prefix.
    expect(agentDefault).toMatch(/^us\./);
    const bare = agentDefault.replace(/^us\./, '');
    expect(DEFAULT_BEDROCK_MODEL_IDS).toContain(bare);
  });
});
