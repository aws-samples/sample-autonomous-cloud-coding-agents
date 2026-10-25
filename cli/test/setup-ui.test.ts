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
  componentForPath,
  DeployProgress,
  displayPath,
  formatDuration,
  parseDeployEvent,
  Step,
  stripAnsi,
  Style,
  summarizeDiff,
} from '../src/setup-ui';

const STACK = 'backgroundagent-dev';
const plain = () => {
  const out: string[] = [];
  return { out, screen: { tty: false, write: (text: string) => { out.push(text); } } };
};

describe('componentForPath', () => {
  test.each([
    ['backgroundagent-dev/SlackIntegration/EventsFn/Resource', 'Slack'],
    ['TaskApi/Api', 'Task API & sign-in'],
    ['AgentVpc/Vpc/PublicSubnet1/Subnet', 'Networking'],
    ['AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource', 'AWS Agent Registry'],
    ['AgentPluginsBlueprint/RepoConfigCR', 'Repository onboarding'],
    ['Custom::S3AutoDeleteObjectsCustomResourceProvider/Role', 'Platform helpers'],
  ])('%s → %s', (constructPath, component) => {
    expect(componentForPath(constructPath, [STACK])).toBe(component);
  });

  test('attributes everything in the split network stack to Networking', () => {
    expect(componentForPath(`${STACK}-network/AgentVpc/Vpc`, [STACK, `${STACK}-network`])).toBe('Networking');
  });
});

test('displayPath drops the stack prefix and the L1 suffix', () => {
  expect(displayPath(`${STACK}/SlackIntegration/EventsFn/Resource`, [STACK])).toBe('SlackIntegration/EventsFn');
});

describe('summarizeDiff', () => {
  test('counts root-stack changes by kind and component, ignoring nested stack sections', () => {
    const diff = [
      `Stack ${STACK}`,
      'IAM Statement Changes',
      '│ + │ arn:aws:... │ Allow │',
      'Resources',
      '[+] AWS::DynamoDB::Table TaskTable/Table T1',
      '[+] AWS::IAM::Role TaskApi/CreateTaskFn/ServiceRole R1',
      '[~] AWS::Lambda::Function TaskApi/CreateTaskFn F1',
      '[-] AWS::SecretsManager::Secret SlackIntegration/SigningSecret S1 destroy',
      `Stack ${STACK}/AgentRegistryStack`,
      '[+] AWS::Lambda::Function Provider/Fn P1',
    ].join('\n');
    const summary = summarizeDiff(diff, [STACK]);
    expect(summary).toMatchObject({ create: 2, update: 1, remove: 1, iamResources: 1 });
    expect([...summary.perComponent]).toEqual([['Task data & storage', 1], ['Task API & sign-in', 2], ['Slack', 1]]);
  });
});

describe('parseDeployEvent', () => {
  test('reads progress, status, path, logical id and reason', () => {
    const line = `${STACK} | 12/317 | 1:23:45 PM | CREATE_FAILED        | AWS::Lambda::Function | ${STACK}/TaskApi/CreateTaskFn/Resource (TaskApiCreateTaskFn1) Resource handler returned message: "boom"`;
    expect(parseDeployEvent(line)).toEqual({
      stack: STACK,
      done: 12,
      total: 317,
      status: 'CREATE_FAILED',
      type: 'AWS::Lambda::Function',
      constructPath: `${STACK}/TaskApi/CreateTaskFn/Resource`,
      logicalId: 'TaskApiCreateTaskFn1',
      reason: 'Resource handler returned message: "boom"',
    });
  });

  test('accepts events without a logical id or progress and ignores other output', () => {
    expect(parseDeployEvent(`${STACK} | 1:00:00 PM | UPDATE_COMPLETE | AWS::CloudFormation::Stack | ${STACK}`))
      .toMatchObject({ status: 'UPDATE_COMPLETE', logicalId: STACK });
    expect(parseDeployEvent('✨  Synthesis time: 12.3s')).toBeUndefined();
  });
});

describe('DeployProgress', () => {
  const event = (n: number, status: string, constructPath: string, id: string, reason = '') =>
    `${STACK} | ${n}/4 | 1:00:00 PM | ${status} | AWS::Lambda::Function | ${STACK}/${constructPath}/Resource (${id}) ${reason}`;

  test('ticks components off as their resources complete and reports the root cause of a failure', () => {
    const { out, screen } = plain();
    const progress = new DeployProgress(screen, new Style(false), [STACK], new Map([['Slack', 2], ['Task API & sign-in', 1]]));
    progress.handleLine('Building assets');
    progress.handleLine(event(1, 'CREATE_COMPLETE', 'TaskApi/Api', 'A1'));
    progress.handleLine(event(2, 'CREATE_COMPLETE', 'SlackIntegration/EventsFn', 'S1'));
    progress.handleLine(event(3, 'CREATE_FAILED', 'SlackIntegration/Table', 'S2', 'Table limit exceeded'));
    progress.handleLine(event(4, 'CREATE_FAILED', 'TaskApi/Deploy', 'A2', 'Resource creation cancelled'));
    const result = progress.finish(false);
    const text = out.join('');
    expect(text).toContain('✓ Task API & sign-in');
    expect(text).toContain('✗ Slack');
    expect(result.failures).toEqual([{ component: 'Slack', resource: 'SlackIntegration/Table', status: 'CREATE_FAILED', reason: 'Table limit exceeded' }]);
  });

  test('ignores events from other stacks and the stack itself', () => {
    const { out, screen } = plain();
    const progress = new DeployProgress(screen, new Style(false), [STACK], new Map([['Slack', 1]]));
    progress.handleLine('other-stack | 1/1 | 1:00:00 PM | CREATE_COMPLETE | AWS::Lambda::Function | other-stack/SlackIntegration/Fn (X)');
    progress.handleLine(`${STACK} | 1/1 | 1:00:00 PM | CREATE_IN_PROGRESS | AWS::CloudFormation::Stack | ${STACK}`);
    progress.finish(true);
    expect(out.join('')).toContain('✓ Slack');
    expect(out.join('')).toContain('100%');
  });

  test('redraws in place on a terminal', () => {
    const out: string[] = [];
    const progress = new DeployProgress({ tty: true, write: text => { out.push(text); } }, new Style(true), [STACK], new Map([['Slack', 1]]));
    progress.handleLine(event(1, 'CREATE_COMPLETE', 'SlackIntegration/EventsFn', 'S1'));
    progress.finish(true);
    // Every repaint after the first moves the cursor back over the previous block.
    expect(out.slice(1).every(chunk => chunk.startsWith('\u001b['))).toBe(true);
    expect(stripAnsi(out[out.length - 1])).toContain('✓ Slack');
  });
});

test('Step resolves to a check mark or a cross with detail', () => {
  const { out, screen } = plain();
  new Step(screen, new Style(false), 'Checking').succeed('3 to create');
  new Step(screen, new Style(false), 'Diffing').fail('broken');
  expect(out.join('')).toContain('✓ Checking  3 to create');
  expect(out.join('')).toContain('✗ Diffing  broken');
});

test('formatDuration', () => {
  expect(formatDuration(42_000)).toBe('42s');
  expect(formatDuration(872_000)).toBe('14m 32s');
});

test('Style emits colour only when enabled', () => {
  expect(new Style(false).green('ok')).toBe('ok');
  expect(stripAnsi(new Style(true).green('ok'))).toBe('ok');
  expect(new Style(true).green('ok')).not.toBe('ok');
});
