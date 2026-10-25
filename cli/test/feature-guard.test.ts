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

import { Command } from 'commander';
import { makeGithubCommand } from '../src/commands/github';
import { makeJiraCommand } from '../src/commands/jira';
import { makeLinearCommand } from '../src/commands/linear';
import { makeSlackCommand } from '../src/commands/slack';
import { requireDeployedFeature } from '../src/feature-guard';
import { getStackOutput } from '../src/stack-outputs';

jest.mock('../src/stack-outputs', () => ({ getStackOutput: jest.fn() }));
jest.mock('../src/config', () => ({ tryLoadConfig: () => null }));
const mockGetStackOutput = getStackOutput as jest.MockedFunction<typeof getStackOutput>;

function program(action: jest.Mock): Command {
  const parent = new Command('slack');
  parent.addCommand(new Command('setup')
    .option('--region <region>')
    .option('--stack-name <name>', 'stack', 'backgroundagent-dev')
    .action(action));
  parent.addCommand(new Command('link').argument('<code>').action(action));
  return requireDeployedFeature(parent, 'slack');
}

beforeEach(() => {
  mockGetStackOutput.mockReset();
  process.exitCode = undefined;
});
afterEach(() => { process.exitCode = undefined; });

test('blocks a subcommand when DeploymentFeatures omits the feature', async () => {
  mockGetStackOutput.mockResolvedValue('jira');
  const action = jest.fn();
  await expect(program(action).parseAsync(['node', 'slack', 'setup', '--region', 'us-east-1'], { from: 'node' }))
    .rejects.toThrow(/Slack is not deployed in stack 'backgroundagent-dev'. Run `bgagent setup`/);
  expect(action).not.toHaveBeenCalled();
  expect(mockGetStackOutput).toHaveBeenCalledWith('us-east-1', 'backgroundagent-dev', 'DeploymentFeatures');
});

test('lets the subcommand run when the feature is deployed', async () => {
  mockGetStackOutput.mockResolvedValue('slack,jira');
  const action = jest.fn();
  await program(action).parseAsync(['node', 'slack', 'setup', '--region', 'us-east-1'], { from: 'node' });
  expect(action).toHaveBeenCalled();
});

test.each([
  ['the stack predates the output', async () => null],
  ['the stack cannot be read', async () => { throw new Error('AccessDenied'); }],
])('defers to the command when %s', async (_label, impl) => {
  mockGetStackOutput.mockImplementation(impl);
  const action = jest.fn();
  await program(action).parseAsync(['node', 'slack', 'setup', '--region', 'us-east-1'], { from: 'node' });
  expect(action).toHaveBeenCalled();
});

test('skips the stack lookup for subcommands without --stack-name', async () => {
  const action = jest.fn();
  await program(action).parseAsync(['node', 'slack', 'link', 'ABC123'], { from: 'node' });
  expect(action).toHaveBeenCalled();
  expect(mockGetStackOutput).not.toHaveBeenCalled();
});

describe('guards on the real integration commands', () => {
  test.each([
    ['slack', () => makeSlackCommand(), ['setup'], /Slack is not deployed/],
    ['linear', () => makeLinearCommand(), ['setup', 'acme'], /Linear is not deployed/],
    ['jira', () => makeJiraCommand(), ['setup'], /Jira is not deployed/],
    ['github', () => makeGithubCommand(), ['webhook-info'], /Deploy-preview screenshots is not deployed/],
    ['github', () => makeGithubCommand(), ['set-webhook-secret'], /Deploy-preview screenshots is not deployed/],
  ])('%s %s fails fast when the stack omits the feature', async (_name, make, args, error) => {
    mockGetStackOutput.mockResolvedValue('none');
    await expect(make().parseAsync(['node', 'x', ...args, '--region', 'us-east-1'], { from: 'node' })).rejects.toThrow(error);
  });

  test('github set-token stays core and unguarded', () => {
    const setToken = makeGithubCommand().commands.find(command => command.name() === 'set-token')!;
    const hooks = (setToken as unknown as { _lifeCycleHooks: Record<string, unknown[] | undefined> })._lifeCycleHooks;
    expect(hooks.preAction ?? []).toHaveLength(0);
  });
});
