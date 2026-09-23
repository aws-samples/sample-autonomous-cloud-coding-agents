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

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

const env = { account: '123456789012', region: 'us-east-1' };
const imageContext = {
  microvm_base_image_arn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
  microvm_base_image_version: '1',
  microvm_artifact_sha256: 'a'.repeat(64),
};

test.each([{}, imageContext])('rejects an omitted layout before synthesizing MicroVM resources: %j', context => {
  const app = new App({ context: { compute_type: 'lambda-microvm', ...context } });
  expect(() => new AgentStack(app, 'ImplicitLayout', { env }))
    .toThrow('microvm_nested_stack must be explicitly selected');
});

describe.each([
  ...[true, 'true', false, 'false'].map((value, index) => ({
    name: `ExplicitLayout${index}`,
    context: { compute_type: 'lambda-microvm', microvm_nested_stack: value },
  })),
  { name: 'Agentcore', context: { compute_type: 'agentcore' } },
  { name: 'Ecs', context: { compute_type: 'ecs' } },
  ...['agentcore', 'ecs'].map(compute => ({
    name: `${compute}WithUnusedPrefix`,
    context: { compute_type: compute, microvm_resource_name_prefix: 'retained-config' },
  })),
])('MicroVM layout selection: $name', ({ name, context }) => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(new AgentStack(new App({ context }), name, { env }));
  });
  test('accepts explicit MicroVM layouts and leaves other backends unaffected', () => {
    expect(template.toJSON().Resources).toBeDefined();
  });
});

describe('MicroVM resource prefix validation', () => {
  test.each([false, 'false'])('explains an explicitly disabled nested layout (%s)', value => {
    const app = new App({
      context: {
        compute_type: 'lambda-microvm',
        microvm_nested_stack: value,
        microvm_resource_name_prefix: 'migration',
      },
    });
    expect(() => new AgentStack(app, 'FlatPrefix', { env }))
      .toThrow('microvm_resource_name_prefix cannot be used with microvm_nested_stack=false');
  });

  test.each([42, true, null])('identifies non-string prefix %s in nested mode', value => {
    const app = new App({
      context: {
        compute_type: 'lambda-microvm',
        microvm_nested_stack: true,
        microvm_resource_name_prefix: value,
      },
    });
    expect(() => new AgentStack(app, 'InvalidPrefix', { env }))
      .toThrow('microvm_resource_name_prefix must be a string');
  });

  test('accepts a valid prefix with an explicit nested layout', () => {
    const app = new App({
      context: {
        compute_type: 'lambda-microvm',
        microvm_nested_stack: true,
        microvm_resource_name_prefix: 'migration',
      },
    });
    expect(() => new AgentStack(app, 'DefaultNestedPrefix', { env })).not.toThrow();
  });
});
